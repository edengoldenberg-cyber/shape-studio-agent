# Dana phase 1A — raw upload → automated edit → mobile review package

Status on 2026-11-15. Branch `dana-phase-1a` (from `tomer-member-service` @ `8a81337`).
**Not deployed. No Railway variable changed. No publishing, no real notification, no Arbox call, no member message.**

## What exists

| Part | Where |
|---|---|
| Canonical pipeline (one clip → one vertical reel, PNG captions, no music) | `dana-worker/dana_pipeline/` (version 1.0.0) |
| Local worker (outbound polling, verified transfers, one job at a time) | `dana-worker/worker.py` |
| Customized caption renderer backup, pinned by sha256 | `dana-worker/vendor/` + `worker.config.*.json` |
| Durable projects / jobs / leases / recovery / review package | `services/dana_studio.js` |
| Worker API (scoped token) and panel API | `routes/dana_studio_routes.js` |
| Publication seam + mocked lifecycle (no provider) | `services/dana_publisher.js` |
| Package-ready notification, mocked by default | `services/dana_notify.js` |
| Brand settings with explicit missing states | `utils/dana_brand.js`, `prompts/dana_prompt.md` |
| Mobile review page | `public/dana-studio.html`, `public/dana-studio.js` |
| Local preview / end-to-end runner | `scripts/dana_studio_preview.cjs`, `scripts/dana_e2e_local.cjs` |

`server.js` change: two router mounts and one startup reconciliation call. No Tomer/Barak file was edited.
Historical projects in `Desktop\גלם עריכות` and the skill folder were not modified.

## How to preview

```
node scripts/dana_studio_preview.cjs                       # http://127.0.0.1:3100/dana-studio.html
set DASHBOARD_PASSWORD=...  &&  node scripts/dana_studio_preview.cjs --lan    # phone on the same Wi-Fi, login enforced
```
The preview loads only Dana's routes: no `.env`, no Barak/Tomer, no WhatsApp/Arbox/OpenAI.
Default data: `C:\Users\owner\dana-work\preview-data` — it holds the dry-run package below.

To edit new uploads, run the worker next to it (token = contents of `<data>\worker.token`):
```
set DANA_WORKER_TOKEN=<token>  &&  python -X utf8 dana-worker\worker.py --config dana-worker\worker.config.json
```
(`server_url` in the config must point at the preview port.)

## Evidence

| Check | Result |
|---|---|
| `npx jest --runInBand` (all suites) | 402 passed / 402 (373 existing + 29 Dana) |
| `node tests/run_mjs_tests.mjs` (Barak/Tomer harnesses) | PASS=373 FAIL=0 |
| `python -m unittest discover -s dana-worker/tests` | 20 passed |
| Local dry run, real worker + GPU, owner-approved project 6 clip, scripted decisions | package produced, `review_required` |
| Duplicate upload (same 915 MB file) | HTTP 200 `duplicate=true`, same project, one stored copy |
| Worker offline → started → killed mid-render → restarted | job re-leased as attempt 2 and completed |
| Unreadable source | `failed`, `source_unreadable`, 1 attempt, no artifacts |
| Unauthorized worker / unset token / dashboard token | 401 / 503 / 401 (Jest) |
| Corrupt transfer | 422, nothing stored, package cannot complete (Jest) |
| Server restart during a job; restart with a dead lease | job survives / is requeued (Jest) |
| Approval invalidation (caption, CTA, account, schedule) | approval dropped each time (Jest) |
| Source hash before/after | unchanged (`74f43741220f…`) |
| Video delivery | HTTP 206 Range from the panel route |

### Dry-run package (project 6 clip, 225.24–251.28 s, 27 cards)

Automated checks: 9 pass, 3 fail, 3 need a person.

- **Fail `sync_lead`** — cards #21 (−120 ms) and #24 (−500 ms).
- **Fail `sync_not_found`** — card #26.
- **Fail `energy_gate`** — "אם" (prob 0.745), "או" (prob 0.581).
- **Blocker `caption_differs_from_asr`** — caption shows "אם", ASR heard "עם".
- Pass: clip boundary, width, safe zone (working preset, not measured on a phone), tail ≥ 0, pixels (27 cards continuous, no double card), reading comfort, output file (h264 yuv420p 1080x1920 25 fps 26.04 s, 8.8 Mb/s), loudness (−14.0 LUFS, −1.45 dBTP), source unchanged.
- Human only: listening, framing, meaning.

These are the same cards the pilot flagged (#24, #26). All three sit right after a pause, where Whisper stamps the first word early; the pipeline places the card at the measured audio onset. The gate is the locked one and was not relaxed: the package is `review_required`, and approval is blocked until each item has a recorded owner exception or a re-edit passes. **Open owner decision:** which reference is authoritative after a pause (Whisper stamp or measured onset). Until decided, expect 2–4 exceptions per testimonial of this kind.

### Measured runtime (this machine, RTX 3060 Ti)

| Step | Seconds |
|---|---|
| Upload 915 MB to the local server (hash + store) | 3.6 |
| Transcription large-v3 of the 654 s source (first time; cached by source hash afterwards) | 131 |
| Edit with cached transcript (cut, audio, 27 cards, 2 composites, 2 verifications, checks, cover) | 77–82 |
| Upload → package, cached transcript | 89 |
| Cold total (measured in the first standalone run) | 203 |

Cost: no paid API was called (local GPU, heuristic/scripted judgement). The Claude adapter was never run, so its cost is **not measured**; its budget cap is a configuration value (`max_budget_usd`, default 0.5), not an estimate of real cost.

## Known gaps

- Sync gate vs. onset timing after pauses (above).
- A free-text change request needs judgement; with the Claude adapter off it is recorded and waits for an operator (no blind re-render). Style changes and operator decisions re-render.
- The heuristic adapter is rules only (densest speech run, ≤3 words per card, no highlight). It is not a content judgement.
- Horizontal sources are centre-cropped and flagged; no face-aware reframing.
- Safe-zone numbers are not measured against the Instagram app.
- Upload from a phone to production was not exercised (nothing is deployed). Large camera files depend on the server's disk; default limit 2048 MB (`DANA_UPLOAD_MAX_MB`).
- The worker is started by hand; no Windows service / auto-start yet.
- No retention policy for sources and old versions.
- Mosseri analysis (existing Dana feature) is unchanged apart from the prompt/brand cleanup.

## Next phase — external setup needed

1. Owner: Instagram account type and Page link; Meta app mode; chosen login flow. Then verify the publishing contract against the live API for that account/app/version (audit claims are hypotheses).
2. Owner: decision on the Claude adapter scope (see `dana-worker/README.md`) and the scoped CLAUDE.md wording.
3. Owner: brand settings (voice examples, audiences, current offer, CTA, class list, Instagram account).
4. Deployment plan: `DANA_WORKER_TOKEN` on Railway + worker `server_url`; deploy window that does not disturb the Tomer acceptance test; separate authorization for a real package-ready WhatsApp (`DANA_NOTIFY_REAL`, `DANA_NOTIFY_PHONE`).
5. Consent record for the interviewee before any publication of the project 6 clip.

## Environment variables introduced (all optional; none set anywhere)

`DANA_WORKER_TOKEN` (worker API closed when unset) · `DANA_PUBLISHING_ENABLED` (off) · `DANA_NOTIFY_REAL`, `DANA_NOTIFY_PHONE` (mock when unset) · `DANA_UPLOAD_MAX_MB` · `DANA_LEASE_SECONDS` · `DANA_WORKER_ALIVE_SECONDS` · `DANA_RETRY_DELAY_SECONDS`
