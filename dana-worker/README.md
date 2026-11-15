# Dana local editing worker

Runs on the Windows editing computer. The server coordinates; this worker edits.
It polls the server **outbound** (no port is opened here), takes one job at a time,
runs the canonical pipeline and uploads verified artifacts.

```
dana-worker/
  worker.py                 poll → download source → run pipeline → upload artifacts
  dana_pipeline/            the ONE versioned pipeline (PIPELINE_VERSION in __init__.py)
    core.py                 states, exit codes, validated configuration, media helpers
    judgement.py            segment / caption grouping / cover / caption draft (3 adapters)
    align.py                reference onset of each card from the final audio (Whisper + VAD + envelope)
    captions.py             match cards to the transcript, timing, PNG render, composite
    checks.py               structured checks (sync gate, width, safe zone, pixels, loudness…)
    run.py                  orchestrator
  instructions/             versioned instruction bundle built from the installed ig-* skills
  autostart/                optional Windows auto-start (not installed)
  vendor/                   byte-exact backup of the customized caption renderer
  fixtures/                 scripted decisions used for the controlled dry run
  tests/                    unit tests (no GPU / Chrome / network)
```

It never copies scripts into a project folder and never touches
`Desktop\גלם עריכות` or any source footage (the source hash is checked before and after).

## Setup

1. `copy worker.config.example.json worker.config.json` and adjust paths. Every path the
   pipeline uses comes from this one file; it is validated at start.
2. Set the worker token in the environment variable named by `token_env`
   (default `DANA_WORKER_TOKEN`). The same value must be set on the server.
3. Run: `python -X utf8 worker.py --config worker.config.json`

Local preview without the production server: `node scripts/dana_studio_preview.cjs`
(see the script header), or a full local run: `node scripts/dana_e2e_local.cjs dryrun <source>`.

## States and exit codes

| exit | state | meaning |
|---|---|---|
| 0 | `success` | package ready, every automated check passed |
| 2 | `review_required` | package ready; a check failed or an item needs the owner |
| 3 | `waiting` | cannot continue without something external (e.g. decisions) |
| 1 | `failure` | no package; `result.json` has `code`, `message`, `retryable` |

`result.json` and the exit code must agree; the worker treats a mismatch as a failure.
A failed check stays a failed check. It is resolved only by a re-edit that passes or by an
explicit owner exception recorded on the server — never by an explanation.

## The caption renderer

The cards are drawn by the locally customized `caption_layer.py` of the `ai-video-editor`
skill (PNG path only; the `.webm` layer is never produced). Its sha256 is pinned in the
configuration. If the skill is updated and the file changes, the worker refuses to start
instead of rendering with an unknown renderer. Restore it from `vendor/`, or re-pin on purpose.

## Judgement adapters

| adapter | what decides | default |
|---|---|---|
| `heuristic` | deterministic rules; exact quotation; always flagged as "not a content judgement" | yes |
| `scripted` | decisions supplied as data (operator or fixture) | per job |
| `claude` | non-interactive Claude, **no tools**, guided by the instruction bundle | per job, only when enabled |

All three produce the same JSON and pass through the same validator: plain text only, cards
must be the words of the segment in order, highlight words must be inside their card, the out
point never cuts a word, used material cannot be selected again, a caption may differ from the
audio only between listed homophones, and a price or percentage in the caption is a blocker.
Words dropped in the middle of a segment are a blocker (no misleading combinations).

### The Claude adapter (approved by the owner 2026-11-15)

Enabled by `"judgement": {"claude": {"enabled": true, "model": "claude-…", "timeout_s": …, "max_budget_usd": …}}`
and `paths.claude_exe` in `worker.config.json`; the configuration is refused without an explicit
model id, a timeout and a spending cap. The command is built in `judgement.claude_command()`:

```
claude.exe -p --output-format json --model <explicit id>
           --tools ""                  no tool of any kind (no Bash, Read, Write, Edit, Web, MCP)
           --strict-mcp-config         no MCP servers
           --disable-slash-commands    no skills / commands
           --no-session-persistence    nothing saved
           --setting-sources ""        user/project settings and CLAUDE.md are not loaded
           --system-prompt-file <job>/claude_system_prompt.txt
           --json-schema <DECISIONS_SCHEMA>
           --max-budget-usd <cap>      + a process timeout; run in an empty working folder
```

- Input (stdin): the word-timestamped transcript, excluded time ranges, verified brand facts,
  and — for a revision — the previous version and the owner's note. All of it is data.
- Output: one JSON object. It is validated, and the cards are matched against the transcript,
  before anything is rendered. A rejected answer gets ONE corrective retry, then the job fails.
- The model has no tool, so it cannot read or write files, run commands or reach the network.
  No permission mode is relaxed and no bypass flag is used.
- Every call is recorded in the package (`judgement_usage`): model actually used, tokens,
  elapsed time, the cost figure the CLI reports, and how the call was authenticated.
  **The cost figure is the CLI's list-price calculation (`cost_basis: list`), not an invoice.**
  On this machine no `ANTHROPIC_API_KEY` is set and the CLI reports `apiKeySource: null`, i.e.
  the calls run under the logged-in Claude account; what that consumes (plan usage vs. billed
  credit) is decided by the account, not by `--max-budget-usd`. The cap stops a run; it does not
  define a charge.
- The model's own safety layer can refuse a request. That happened here when the output was
  asked to contain the model's reasoning ("reason", "complete_thought", alternatives "why not").
  The request now asks for short editorial notes for the owner instead. A refusal is reported
  as `judgement_failed` and the job is retried within the normal 3-attempt limit.

### How the installed ig-* skills reach Dana

The adapter runs with skills disabled, so it cannot load a skill. Instead:

1. `instructions/build_bundle.py` (trusted code, run by a person) reads the installed
   `ig-repurpose`, `ig-reel` and `ig-caption` skill files and takes only the named sections
   that apply to choosing and captioning a segment.
2. It drops every line that mentions tools, scores, files, other skills, hashtags or example
   figures, and puts `instructions/local_rules.md` (the owner's rules: Hebrew, exact quotation,
   no scores, no invented voice, no unverified facts, no performance predictions) first.
3. The result, `instructions/bundle.md`, is reviewed and committed with a manifest (version,
   sha256 of each source skill file and of the bundle).
4. At run time the worker loads the committed bundle, verifies its hash and appends it to the
   system prompt. The model never sees the skill folder.

`python -X utf8 instructions/build_bundle.py --check` reports when an installed skill changed
since the bundle was built. Nothing is rebuilt automatically.

## Alignment and review

The reference is the final spoken words. Whisper tells WHICH word and the interval it was
spoken in; a word after a pause absorbs the pause into its stamp, so its start is unreliable.
`align.py` takes the onset from the Silero speech detector (shipped with faster-whisper) when
speech resumes inside the stamp, and reports the distance to an independent level-envelope
measurement as the uncertainty. Cards are timed from that reference.

- The locked sync check (`sync_lead`, `sync_not_found`, `sync_tail`, `energy_gate`) is unchanged
  and its result is never edited.
- `alignment_reference` is a separate check against the reference onset.
- For each locked failure, `adjudications` states — with the measurements — whether it is a
  suspected false positive (two methods agree within 80 ms, the onset lies inside the Whisper
  stamp, the card is within 120 ms of it) or confirmed.
- `caption_text` handles homophone spelling as a TEXT item; a low-confidence word is an
  ACOUSTIC item. They are not mixed with timing.
- Everything the owner must look at is one list, `review_items`, each with a playable excerpt.
  The panel resolves the whole list with one confirmation.

## Auto-start (optional, not installed)

`autostart/install.ps1` registers one Scheduled Task for the current user (at logon, not
elevated). `stop.ps1` stops it, `uninstall.ps1` removes it, and a file named `STOP` in
`work_root` makes the worker exit at its next poll and refuse to start. Preview what would be
registered with `install.ps1 -WhatIf`.

## Tests

```
python -X utf8 -m unittest discover -s dana-worker/tests -v
npx jest --runInBand tests/dana_studio.test.js
```
