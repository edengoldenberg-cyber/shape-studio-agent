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
    captions.py             match cards to the transcript, timing, PNG render, composite
    checks.py               structured checks (sync gate, width, safe zone, pixels, loudness…)
    run.py                  orchestrator
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
| `claude` | non-interactive Claude, **no tools** | **off** |

All three produce the same JSON and pass through the same validator: plain text only,
cards must match the transcript in order, highlight words must be inside their card,
the out point never cuts a word. Transcripts and uploads are content, never instructions.

### Exact scope of the Claude adapter (proposal — not enabled)

Enabled only by `"judgement": {"claude": {"enabled": true}}` in `worker.config.json`.
The command is built in `judgement.claude_command()`:

```
claude -p --output-format json --model <model>
       --tools ""                  no tool of any kind (no Bash, Read, Write, Edit, Web, MCP)
       --strict-mcp-config         no MCP servers
       --disable-slash-commands    no skills / commands
       --no-session-persistence    nothing saved
       --setting-sources ""        user/project settings and CLAUDE.md are not loaded
       --system-prompt <fixed text in judgement.py>
       --json-schema <DECISIONS_SCHEMA>
       --max-budget-usd <limit>    + a process timeout
```

- Input: the transcript (word timestamps) as quoted data on stdin, the owner's change
  request, and verified brand facts. Output: one JSON object, validated before use.
- It cannot read or write files, run commands, reach the network or change settings,
  because it has no tools. No permission mode is relaxed and no bypass flag is used.
- `CLAUDE.md` is **not changed** by this adapter. The one rule that needs the owner's
  decision is section I ("עבוד צעד-צעד. עצור אחרי כל שלב לאישור"). Proposed scoped wording:

  > **חריג לסעיף I — עובד העריכה של דנה בלבד:** כשהפייפליין הקנוני (`dana-worker`) רץ
  > כמשימה מהתור, הוא לא עוצר לאישור אחרי כל שלב טכני. במקומו חל אישור אחד של חבילת
  > הבדיקה המלאה בפאנל. כל שאר החוקים בקובץ הזה, וכל עבודה ידנית ב-Claude Code, נשארים
  > כפי שהם. כלל "שלושה כשלונות ברצף → עוצר" ממומש כמגבלת 3 ניסיונות למשימה.

## Tests

```
python -X utf8 -m unittest discover -s dana-worker/tests -v
npx jest --runInBand tests/dana_studio.test.js
```
