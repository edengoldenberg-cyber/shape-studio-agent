# Dana — deployment proposal and live acceptance sequence

Prepared 2026-11-15. **Nothing in this document has been executed.** Each external action needs the
owner's explicit approval at that step.

## 1. What would be deployed

| | |
|---|---|
| Commit | the head of `dana-phase-1a` at the time of approval (see the final report for the id) |
| Base | `8a81337` — identical to `origin/tomer-member-service`, the commit production runs (verified by `git merge-base`). No Tomer / Barak source file is changed |
| Target | the existing Railway service of this repository (the one Barak and Tomer run in). Confirm with `railway status` before deploying |
| Method | `railway up --detach` from the repository root, as for previous deployments |
| Not uploaded | `dana-worker/`, `data/`, `.env`, `.claude/` (`.railwayignore`) |

Files that differ from production: `server.js` (+10 lines: two router mounts, startup
reconciliation, scheduler start that is a no-op unless publishing is on), `public/index.html`
(+1 line: forwards `/#prj_…` to the review page), `agents/dana_agent.js` and
`prompts/dana_prompt.md` (Dana's existing chat/analysis: no invented voice, audience or offer),
`.gitignore`, `.railwayignore`, and new files (`routes/dana_studio_routes.js`,
`services/dana_*.js`, `utils/dana_brand.js`, `public/dana-studio.*`).

## 2. Effect on the shared Barak / Tomer service

- **One restart** of the service (the same as any deployment): in-flight HTTP requests are dropped;
  durable state is on the `/data` volume. Deploy at a time with no conversation in progress, and not
  during the Tomer acceptance test.
- After the restart the Barak / Tomer code paths are unchanged. Evidence: full Jest suite 436/436,
  standalone harnesses 373/0, Barak panel browser check 33/33 on this commit.
- New load in the shared process: receiving uploads to disk, hashing, serving video with Range. No
  editing, transcription or rendering happens on the server.
- With `DANA_WORKER_TOKEN` unset the worker API answers 503 and Dana studio cannot edit anything.

## 3. Environment variables (names only)

Set with `railway variable set NAME=… --skip-deploys`, typed by the owner in their own terminal or in
the Railway dashboard (Variables tab — works from a phone browser). **Never paste a value into chat.**

| Step | Variable | Purpose |
|---|---|---|
| A (deploy) | `DANA_WORKER_TOKEN` | shared secret between the server and the editing computer; any random 48+ characters |
| A | `DANA_UPLOAD_MAX_MB` | optional; proposed `1024` for the first run |
| D (notification) | `DANA_NOTIFY_PHONE`, `DANA_NOTIFY_REAL` | the manager number and the switch. `BACKEND_URL` or `RAILWAY_PUBLIC_DOMAIN` must already give the public address |
| G (publication) | `DANA_PUBLISHING_ENABLED`, `DANA_PUBLISHER_MODE`, `DANA_INSTAGRAM_LIVE`, `DANA_IG_LOGIN`, `DANA_IG_API_VERSION`, `DANA_IG_USER_ID`, `DANA_IG_ACCESS_TOKEN` | the real Instagram adapter; all required together |

Stay unset / disabled after step A: everything in rows D and G. Publishing and real notifications
are therefore off, and the scheduler does not start.

Already present and reused (not changed): `DASHBOARD_PASSWORD`, `SESSION_SECRET`, `DATA_DIR`,
Green API variables. The Meta lead variables (`META_PAGE_ACCESS_TOKEN`, …) are not read by Dana.

## 4. Storage, upload size, worker

- Files live under `/data/dana/` on the existing volume: uploaded originals (`sources/`, one copy per
  distinct file) and, per package version, about 30–40 MB (video, cover, JSON).
- **Unknown, to check before step C:** free space on the volume (`railway ssh "df -h /data"`), and
  whether the platform accepts a request body of the intended size. Start with a clip under 300 MB.
- No retention job exists: originals and old versions stay until removed by hand.
- Worker (editing computer): `dana-worker/worker.config.json` → `server_url` = the public https
  address; `DANA_WORKER_TOKEN` as a USER environment variable (same value as on the server);
  start with `python -X utf8 dana-worker\worker.py --config dana-worker\worker.config.json`.
  The Claude adapter is already enabled in that local file (model, timeout and cap explicit).

## 5. Rollback

1. Kill switches without a deploy: delete `DANA_WORKER_TOKEN` (worker API closes), set
   `DANA_PUBLISHING_ENABLED` to anything but `true`, delete `DANA_NOTIFY_REAL`, or pause all
   publications in the page. Stop the worker with Ctrl+C or the `STOP` file.
2. Code rollback: `git checkout 8a81337 && railway up --detach` (the commit production runs today),
   then return to the branch. Data under `/data/dana/` is left in place and ignored by the old code.
3. A publication that already went out cannot be rolled back by Dana; delete it in the Instagram app.

## 6. Windows auto-start (prepared, not installed)

- Preview: `powershell -ExecutionPolicy Bypass -File dana-worker\autostart\install.ps1 -WhatIf`
- Enable: the same without `-WhatIf` (one Scheduled Task for the current user, at logon, not elevated;
  needs the token in the user environment).
- Stop now: `…\stop.ps1` (add `-Hold` to keep it stopped). Remove: `…\uninstall.ps1`.
- Kill switch: an empty file named `STOP` in `C:\Users\owner\dana-work`.

## 7. Live acceptance sequence

Each step ends with a check; the next step starts only after it passes and the owner approves it.

**A. Deploy with publishing and notifications off** — *needs: deployment approval, `DANA_WORKER_TOKEN` set.*
Verify: `/api/version` shows the new deployment id; `/health` 200; `GET /api/dana/studio/status`
without a session → 401; with a session → `publishingEnabled: false`, `notifications: "mock"`;
`GET /api/dana/studio/publisher/status` → `enabled: false`; Barak and Tomer panels load; no send in
the startup logs.

**B. The review page on the owner's phone** — open `https://<public-domain>/dana-studio.html`, log in
with the dashboard password, see the empty project list and the "worker not connected" badge.

**C. Worker ↔ deployed queue, one upload** — start the worker; the badge turns to "connected";
upload one short clip from the phone; watch the stages; the package opens; the video plays and seeks
on the phone.

**D. One test notification** — *needs: explicit approval to send, `DANA_NOTIFY_PHONE` and
`DANA_NOTIFY_REAL` set.* First `GET /api/dana/studio/notify/status` must show `mode: real` and the
last four digits `8919`. Then exactly one `POST /api/dana/studio/notify/test` with the full number
typed again. Check the message arrives and the link opens the login page, then the studio.
Also confirm `TEST_MODE` on the server does not block the number (the outcome would read `blocked`).

**E. A NEW clip from the owner** — upload → plan → edit → Dana's review → automatic corrections →
package → one real "ready for review" notification.

**F. One free-text revision** — the owner approves, then writes a change request; verify a new
version appears, the approval of the previous one is gone, and a new notification arrives.

**G. One real Reel** — *needs: Instagram account facts, a token entered in Railway, consent
recorded, caption / cover / account / time approved in the page, and explicit approval to publish.*
Order: set the `DANA_IG_*` variables with `DANA_PUBLISHING_ENABLED` still off →
`GET /publisher/status?probe=1` (read-only: account username and quota) → compare with the approved
account → turn the switches on → the owner presses "schedule" in the page → the scheduler publishes
at the approved time.

**H. Verify and measure** — the page shows media id and permalink; open the permalink; the caption
matches; after 48 hours and 7 days the metrics appear with source `instagram`.
