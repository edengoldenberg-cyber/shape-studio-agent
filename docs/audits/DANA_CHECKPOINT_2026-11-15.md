# Dana — continuation checkpoint (2026-11-15)

Purpose: resume implementation without repeating discovery. Full report (Hebrew): `docs/audits/DANA_AUDIT_2026-11-15.md`.

## State when this was written

- Phase completed: READ-ONLY discovery + design. Nothing installed, modified, deployed, published or sent.
- Files written: this file and `DANA_AUDIT_2026-11-15.md` only. Both untracked, NOT committed.
- Repo: `C:\Users\owner\Desktop\shape-studio-agent`, branch `tomer-member-service` @ `8a81337` (this is what production runs; not merged to `main`). Dana files are identical on `main` and this branch except `public/app.js`, `public/index.html`.
- Never stage `data/`. Do not touch Tomer/Barak files. A Tomer live acceptance test is in progress on production.
- No owner decision has been given yet on any item in section H of the report. Implementation has NOT been approved.

## Not verified (do not assume)

- Production state of Dana (does video analysis work on Railway; `/data/videos` size; python on the image). `railway ssh` read was denied by the session's permission classifier — ask the owner before retrying.
- Whether the Instagram account is professional and linked to the Facebook Page; Meta app mode (dev/Live), business verification.
- Whether `META_PAGE_ACCESS_TOKEN` / Graph `v21.0` (`services/metaLeads.js:6`) still work.
- Make.com connections (needs auth). Zapier has only Google Sheets + Facebook Lead Ads.
- LUFS and safe-zone results of project 6 (text claims only, no saved tool output).
- Music track `Momentum_Shift_2026-09-12T134558.mp4`: source and licence undocumented.

## Verified facts (with evidence)

### Dana server side
- Code: `agents/dana_agent.js` (1863 lines), `services/video.service.js`, `prompts/dana_prompt.md`, routes `server.js:779-1170`, UI `public/index.html:143-260`, `public/app.js:190-600`.
- Model: OpenAI `gpt-4o` (`OPENAI_MODEL`), transcription `whisper-1` (cloud), frames via bundled ffmpeg (20 max).
- Chat history = one in-memory global array (`danaHistory`, last 30) — lost on restart, shared by all panel users.
- Video jobs: `DATA_DIR/videos/<id>/{video.ext,job.json,report.json}`; in-process `Map` + job.json; NO startup reconciliation (interrupted job stays `running`); no dedup; no retention.
- Upload limit 150 MB (multer), max duration 15 min, served back at `GET /api/dana/video/:id` (Range, behind panel auth).
- Local evidence (`data/videos`, 2026-11-09): same 51 MB file analysed 7×, readiness 56/56/61/63/63/66/100 → score is not stable. 30–50 s per analysis.
- Legacy `agents/content_agent.js` runs on cron `0 8 1,15 * *` (`server.js:1575`).
- No Instagram/Facebook publishing code, env vars, or insights/comments/DM code anywhere.
- Reusable: `middleware/auth.js` (sessions + CSRF), `utils/persist.js` atomic write, `utils/service_case_store.js` pattern, `services/whatsapp.service.js` (`sendText`, `sendFileByUrl`).
- Prompt conflicts with owner rules: invented brand-voice table, hardcoded audience "women 30–60", hardcoded "60 NIS for 2 workouts", "never use placeholder brackets"; `business_context.md` mandates a male agent voice.
- Tests: `tests/analyzeVideoFile_pipeline.test.js` (7, fully mocked), `mosseri_validation.test.js` (40), `video_endpoint.test.js` (6).

### Local editing (Windows machine)
- Root: `C:\Users\owner\Desktop\גלם עריכות`; rules: `C:\Users\owner\CLAUDE.md`.
- Env: Python 3.10.11 (`python3` = broken Store stub), ffmpeg 9.0.1, RTX 3060 Ti 8 GB, faster-whisper 1.2.1 + large-v3 cached, Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe`, `CHROME_PATH` set (User), Node 24.16, hyperframes 0.9.26 global, ~186 GB free. Missing: torch, uv/uvx, yt_dlp.
- No canonical pipeline: per-project script forks (P1 32, P2 26, P3 37, P6 5 scripts). Newest full set = `3\scripts\`. P6 adds `build_review.py`, `retime_from_final_audio.py`, `check_cards_in_motion.py`.
- `run_pipeline.py` (root) would copy P6's 5-script folder into project 7 → broken. Ignores child return code; "waiting for footage" exits 0.
- 8 `input()` stops across `3\scripts\run_pipeline.py` and `stage0.py`.
- BUG `3\scripts\run_pipeline.py:233`: `"FAIL: 0" in stdout and "TAIL FAIL: 0" in stdout` — first test is satisfied by the second string. Use the exit code of `verify_against_audio.py` instead.
- CORRECTION (owner, 2026-11-15): the project 6 review video WAS delivered to and played on the owner's phone (as a chat attachment). That proves mobile attachment delivery only — NOT Dana's server delivery path, caption synchronization, final creative approval or publication consent.
- Project 6 (pilot): hand-built, not via pipeline. `verify_final.txt`: 24 OK / 1 WARN / 2 FAIL (#24 −500 ms, #26 NOT_FOUND), TAIL FAIL 0. Output `C:\Users\owner\Desktop\סרטון סופי\6_2026-11-15_REVIEW_DRAFT.mp4`: h264 1080x1920 yuv420p 25 fps 26.04 s ~8.3 Mb/s (config says 32M). Not run: check_width, check_ghosting, check_clip_boundary. Open: listening check, "כן," opening, אם/עם, interviewee consent, phone-UI check.
- Yellow highlight contradiction: `3\03_ניתוח\style_profile.json` → `"highlight": "none"` + note "rejected on purpose"; P6 captions have 6 `hl` spans; `EDIT-HANDOFF.md` calls highlight the local style.
- `~/.claude/skills/ai-video-editor/scripts/caption_layer.py` locally modified 2026-09-13, NO backup of upstream. Only this script of the skill is used by the pipeline. `.webm` path unusable; PNG path works.
- Project 3 exported "final" predates its corrected plan (contains the segment attributed to the interviewer).

### ig-* skills
- 13 skills, all text drafting only; no Instagram actions. Patched scripts with `*.orig` beside them: beats.py, hookscore.py, detect.py, humanize.py, caption.py, swipe.py.
- Hebrew: counts measured; durations estimated (165 wpm uncalibrated); hook/human scores, verdicts, formula classification unsupported.
- `~/.claude/instagram/voice.md` absent. `business-context.md` has only name / type / location / language.
- Upstream text still contradicts local header in `ig-reel` (infer voice; score templates).
- `ig-carousel` has no renderer and no RTL/font guidance. Three different safe-zone definitions, none measured.

### Meta API (official docs read 2026-11-15)
- IG publish: container → poll `status_code` → `media_publish`; statuses EXPIRED/ERROR/FINISHED/IN_PROGRESS/PUBLISHED; container expires in 24 h; permalink via `GET /<media>?fields=permalink`.
- No native IG scheduling; FB Page has `scheduled_publish_time`.
- Instagram Login → public `video_url` required. Facebook Login → resumable upload (`rupload.facebook.com/ig-api-upload/...`), Audio API, paid-inclusive totals.
- Own-business app: no App Review for publishing. Comment webhooks / public DMs: docs conflict — test before relying.
- No idempotency key; repeated `media_publish` behaviour undocumented → never blind-retry.
- Reel insights: views, reach, likes, comments, saved, shares, avg/total watch time, skip rate. No follows/profile visits per Reel. ≤48 h lag; account data kept 90 days.
- Story stickers (link/poll/location) and the full music library are not available via API.
- DMs: user-initiated only, 24 h window, one private reply per comment within 7 days; identifiers = IGSID + username, no phone.
- Publish limit: docs say both 50 and 100 → read `content_publishing_limit` at runtime.

## Recommended architecture (decided in the report, pending owner approval)

Hybrid: Railway server = control plane (durable job/project store, approval page, scheduler, publisher, metrics); local Windows worker = editing only, polls server outbound. Judgement steps run in the worker via non-interactive Claude with the existing CLAUDE.md + skills. Meta tokens only on the server. Facebook Login path, reusing the existing Meta app, subject to verifying IG↔Page link.

## Next steps, in order (only after owner approval)

1. Get owner decisions (report section H): voice examples, current offers/prices/classes, yellow highlight, Meta login path, storage, same vs separate Railway service, non-interactive Claude in worker + CLAUDE.md rule I scope, consent policy, music source, machine hours.
2. Read-only checks with owner present: IG account type + Page link, Meta app mode, lead token / Graph version, production Dana state.
3. Back up `caption_layer.py`; consolidate one canonical non-interactive pipeline from `3\scripts` + P6's three scripts (exit codes, job state file, single paths config); fix the sync-gate bug.
4. Server: durable Dana job/project store with startup reconciliation + upload hashing/dedup (new modules only; flag `DANA_PUBLISHING_ENABLED`).
5. Local worker (pull jobs, run, upload artefacts + check outputs, heartbeat).
6. Mobile approval page with version fingerprint + history; WhatsApp notification with link.
7. Scheduler + Reel publisher state machine (approved → scheduled → processing → published/failed/uncertain), tested against a mocked API including timeout + restart.
8. Insights pull at 48 h and 7 d.
9. Controlled pilot: dry run → one real post → three more over two weeks → written summary with measured time and cost.

Acceptance criteria: report section G.

## Do not

- Do not install "AY Video Editor" or any replacement editor.
- Do not use Mosseri / hook / human scores as gates or performance predictions.
- Do not invent voice, prices, offers, audience; leave `{{placeholder}}`.
- Do not treat a chat/WhatsApp "yes" as publication approval.
- Do not use browser automation to work around unsupported API features.
- Do not deploy, change Railway variables, or run `railway config migrate`.

## UPDATE 2026-11-15 — phase 1A implemented

Branch `dana-phase-1a`. Status, evidence, preview commands and next steps: `docs/DANA_PHASE_1A_2026-11-15.md`. Not deployed; publishing and real notifications off.

## UPDATE 2026-11-15 — phase 1B (bounded Claude adapter, alignment, one review section)

See `docs/DANA_PHASE_1B_2026-11-15.md`. Claude adapter enabled only in the local worker.config.json (not committed). CLAUDE.md section I has the scoped Dana-worker exception. Auto-start prepared, not installed. Still not deployed; publishing off.

## UPDATE 2026-11-15 — phase 1C (connected workflow, dry-run publication)

See `docs/DANA_PHASE_1C_2026-11-15.md` (capability matrix, demonstration, remaining requirements) and `docs/DANA_SKILLS_MATRIX.md`.
Re-run the demonstration: `node scripts/dana_e2e_full.cjs <source.mp4> --exclude a-b,...` (real worker + model; MOCK publisher/notification/metrics).
Preview the last test project: `set DANA_PREVIEW_DATA=C:/Users/owner/dana-work/e2e-full` then `node scripts/dana_studio_preview.cjs`.
Still true: not deployed, publishing off by default (`DANA_PUBLISHING_ENABLED`, `DANA_PUBLISHER_MODE=mock` only), notifications mocked, autostart not installed, no real Instagram adapter exists.
Next: owner-supplied clip as editorial acceptance; then the account/credential/deployment approvals listed in the phase 1C doc.

## UPDATE 2026-11-15 — phase 1D (real Instagram adapter prepared, mobile path, deploy plan)

Read: docs/DANA_PHASE_1D_2026-11-15.md, docs/DANA_INSTAGRAM_CONTRACT.md, docs/DANA_DEPLOY_PLAN.md.
State: real Instagram adapter (services/dana_instagram.js) and real notification path exist behind disabled switches; contract-tested against local fakes only. Nothing deployed, nothing sent, no call to Meta.
Selected: Facebook Login for Business, graph.facebook.com, API v26.0 pinned, resumable upload, cover via thumb_offset.
Next actions are all owner-gated: deployment approval + DANA_WORKER_TOKEN; Instagram account facts; token entered in Railway (never in chat); notification approval; new source clip; consent.
Local facts: local .env has a placeholder Meta token and a notify number that is NOT 972547598919; production values were not readable from this session.

## Owner-stated account facts (2026-11-15)

- Instagram account intended for Dana: @pilates_barre_power, display name "Shape studio". Stated by the owner; NOT yet entered as a brand setting anywhere and NOT verified through the API.
- Account type (Business / Creator) and Facebook Page link: not verified yet — being checked with the owner from the phone, one step at a time.
- The price shown in the account bio is NOT approved for use in content or as an offer.
- This was account information only: no approval for deployment, notifications or publication.

- UPDATE (owner, from screenshots, 2026-11-15): account type shown = Professional (Business vs Creator not distinguished; both are eligible per the docs); linked Facebook Page = "Shape Studio". Still not verified through the API. Next: Meta app name / mode / permissions, step by step from the phone. No approval for deployment or publication.

## Live API evidence reported by the owner (2026-11-15) — discovery and linkage ONLY

Read-only call run by the owner (not by this session), Graph API v26.0:
GET me/accounts?fields=id,name,instagram_business_account{id,username}
→ Page "Shape Studio", Page ID 2015202785199287, Instagram username pilates_barre_power, Instagram account ID 17841401323322547.

This proves: the Page exists for that login, the Instagram professional account is linked to it, and v26.0 answers. It does NOT prove publishing or insights access, token type, or permissions.
Values for the adapter (not secrets): DANA_IG_LOGIN=facebook, DANA_IG_API_VERSION=v26.0, DANA_IG_USER_ID=17841401323322547. DANA_IG_ACCESS_TOKEN is entered by the owner in Railway only — never in chat, never the lead-ads token.
Next read-only checks (owner runs them): me/permissions; then the account read and content_publishing_limit with the token that will be stored.
Not authorized: deployment, real notification, media upload, publication.

- Owner-reported, read-only (2026-11-15): GET me/permissions → granted: pages_show_list, instagram_basic, instagram_manage_insights, instagram_content_publish, pages_read_engagement (all five required), plus business_management, leads_retrieval, public_profile. This shows the permissions are granted to that user token; it is still not proof that publishing or insights calls succeed.
- The Explorer token used for these checks appeared in screenshots → treated as exposed; it must NOT be stored for production. A fresh dedicated credential is to be created, and its type and expiry verified (debug tool), not assumed.
- Do not revoke or modify the lead integration; when re-authorising, do not uncheck leads_retrieval or any existing permission.
- Next read-only check: with the Page token, GET 17841401323322547?fields=id,username and GET 17841401323322547/content_publishing_limit?fields=quota_usage,config (decides Page vs User token).

- Owner-reported, read-only, with the Shape Studio PAGE token (2026-11-15): GET 17841401323322547?fields=id,username → id 17841401323322547, username pilates_barre_power; GET 17841401323322547/content_publishing_limit?fields=quota_usage,config → quota_usage 0, quota_total 100, quota_duration 86400. Evidence that a Page token can read the account and the publishing quota (live quota 100 per 24 h). NOT proof of successful publishing or insights.
- Decision: store a long-lived PAGE token derived from a FRESH long-lived user token (not the Explorer token that appeared in screenshots). Its type and expiry (including data_access_expires_at) are to be read in the Access Token Debugger before storing; "never expires" is not assumed.
