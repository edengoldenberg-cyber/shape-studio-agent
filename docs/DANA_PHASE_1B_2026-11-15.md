# Dana phase 1B — bounded creative selection, alignment workflow, one review section

Status on 2026-11-15, branch `dana-phase-1a`. **Not deployed. Publishing off. Notifications mocked. No Railway change.**
Builds on `docs/DANA_PHASE_1A_2026-11-15.md`.

## What changed

| Area | Change | Where |
|---|---|---|
| Claude adapter | Enabled on the local worker (owner-approved). No tools, explicit model id, timeout, spending cap, validated JSON, one corrective retry | `dana-worker/dana_pipeline/judgement.py`, `worker.config.json` (local, not committed) |
| CLAUDE.md | Scoped exception to section I for the Dana worker's technical steps only | `C:\Users\owner\CLAUDE.md` (outside this repo) |
| Skills → Dana | Versioned instruction bundle built by trusted code from `ig-repurpose`, `ig-reel`, `ig-caption` + owner rules; verified by hash at run time | `dana-worker/instructions/` |
| Selection rules | Used material excluded; cards must be the segment's exact words; words dropped mid-segment and prices/percentages in the caption are blockers | `judgement.py`, `run.py` |
| Alignment | Card timing from the final audio: Whisper interval + Silero VAD onset + envelope, with an uncertainty | `dana_pipeline/align.py` |
| Locked sync check | Unchanged. Each failure gets a separate adjudication with evidence | `checks.py → adjudicate_sync` |
| Text vs acoustic | Homophone spelling and transcription variance are TEXT items; low-confidence words are ACOUSTIC items; neither is a timing failure | `checks.py → text_check`, `captions.py → align_cards` |
| Review | One `review_items` list with excerpts; one confirmation in the panel | `services/dana_studio.js → confirmReview`, `public/dana-studio.js` |
| Revision | Free-text change request is processed automatically by the adapter into a new version | `dana_studio.js → requestChanges` |
| Routine fixes | Cards that do not fit the safe zone are split (same words, same order); pixel check handles identical cards and bright footage | `run.py`, `checks.py` |
| Auto-start | Prepared, NOT installed: scheduled task scripts + `STOP` file kill switch | `dana-worker/autostart/` |

## The adapter-selected package (in `C:\Users\owner\dana-work\preview-data`)

Source: `MVI_0548.MP4` (owner-approved source), with the three previously used ranges excluded
(225.24–251.28, 286.07–305.2, 637.08–649.68). Adapter: `claude-sonnet-5-5`.

**Version 1** — segment **122.40–149.32 s** (26.92 s), 31 cards.
- Selection note (model): a trainee explains what differs here from other places she trained — personal attention that makes her come back, even on a tired day; a complete statement by one speaker.
- Cover quote: "יחס אישי". Caption: a one-line draft naming the studio and town (verified facts only), no CTA (none approved).
- Highlight: selective.

**Version 2** — produced automatically from the note
"הקפשן ארוך מדי - לקצר למשפט אחד. בנוסף, להשאיר הדגשה צהובה רק על כרטיס אחד, ולבחור לקאבר ציטוט אחר מתוך הקטע."
- Revision note (model): caption shortened to one sentence; highlight kept on one card; cover changed to "לרצות להישאר ולחזור"; segment and cards unchanged.
- v1 had a TEST approval (actor `E2E-TEST (automated, not the owner)`); the change request invalidated it. v2 has no approval and waits for the owner.

### Checks on version 2

Pass: clip boundary, width, safe zone, sync lead, pixels on screen, output file, loudness (−14 LUFS), source unchanged.
Warn: alignment uncertainty above 80 ms on 2 cards; reading comfort (short cards after splitting).
Locked failures kept as failures: `sync_not_found` (#19, #24), `sync_tail` (#25), `energy_gate` ("זה", prob 0.25).

**One review section, 7 items:**

| Kind | Item |
|---|---|
| timing | #24 — locked NOT_FOUND, adjudicated suspected false positive (VAD and envelope agree) |
| text | start of clip — the second transcription hears "אז" before the first caption |
| text | #19 "ושעה" / heard "והשעה" |
| text | #23 "איך שהוא" / heard "איכשהו" |
| text | #25 "מאפשר" (said twice in the source transcript; heard once) |
| text | #29 "האמונים" / heard "האימונים" |
| acoustic | #6 "זה" — low confidence |

Human-only: listening, framing, meaning. Publication consent: not recorded → publication blocked.

## Measured

| | v1 | v2 |
|---|---|---|
| Claude calls | 1 | 1 |
| Model used | claude-sonnet-5-5 | claude-sonnet-5-5 |
| Call time | 23.3 s | 12.4 s |
| Tokens in (new + cache write + cache read) / out | 4 + 5,933 + 43,665 / 3,339 | 2 + 18,664 + 4,283 / 1,745 |
| Cost reported by the CLI | $0.061 | $0.093 |
| Edit time (worker) | 106.9 s | 76 s |
| Wall time to package | 114 s | 79 s |

Authentication/billing as observed: no `ANTHROPIC_API_KEY` in the environment, CLI reports `apiKeySource: null`, `provider: firstParty`, `costBasis: list`. The calls ran under the logged-in Claude account. The dollar figure is the CLI's list-price calculation, not an invoice; whether it draws on plan usage or billed credit is an account matter this code cannot see. `--max-budget-usd` (1.0) stops a run; it does not define a charge. No call approached the cap.

Calls made during development that produced no package (also list-price figures): one probe ($0.005); **four requests refused by the model's safety layer** (three Sonnet, one Opus test; "reasoning_extraction") — the request asked the model to output its reasoning; it now asks for short editorial notes; several test runs while fixing the issues below. Not totalled precisely; on the order of $1–1.5 list price.

## Evidence

- `npx jest --runInBand`: 404 / 404. `node tests/run_mjs_tests.mjs`: PASS=373 FAIL=0.
- `python -m unittest discover -s dana-worker/tests`: 37 passed.
- Run log: `C:\Users\owner\dana-work\e2e-select.log`. Per job: `C:\Users\owner\dana-work\jobs\<job>\` (prompt, system prompt, raw model response, checks.json with adjudications).
- Earlier attempts in this phase exposed and fixed: text variance between two transcriptions breaking alignment; two cards with identical words confusing the pixel check; a fixed pixel-error limit failing on bright footage; a card too wide for the safe zone; a 1 ms tail rounding error.

## What is autonomous now / what is not

Autonomous (after upload): transcription, segment choice by meaning, caption cards, cover quote, caption draft, cut, audio, PNG captions, alignment, all checks, cover, package; processing a free-text change request into a new version; retries and recovery.

Not autonomous: the owner's single review and approval; listening/framing/meaning; consent; brand settings (voice, offer, CTA, account); resolving a real mismatch between captions and audio (needs a re-edit or the owner's confirmation); starting the worker (auto-start prepared, not installed); publishing (off).

Open quality notes:
- One transcript is used for selection. Speaker identity is not checked: the model is told to pick one speaker's continuous statement, and the owner's "meaning" review is the control.
- Two transcriptions of the same audio disagree on a few words per clip; each disagreement is shown, not resolved.
- The model sometimes returns a different segment length for the same source across runs (40.5 s and 26.9 s here).
- A model safety refusal fails the job after 3 attempts; there is no fallback model.
