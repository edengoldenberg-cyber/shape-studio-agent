# Tests

Two kinds of test files live here. Both run fully isolated: a fresh temporary `DATA_DIR`
per test file, dummy external credentials, and mocked transports. No test reads or writes
the repo's `data/` folder or production, and none can reach Green API, OpenAI, Arbox or Meta.

## Run everything (isolated)

```
npm run test:all
```

= `npm test` (Jest) followed by `npm run test:mjs` (standalone harnesses).

## 1. Jest suites — `tests/*.test.js`

```
npm test                                   # all isolated Jest suites
npx jest tests/callback_lifecycle.test.js  # one file
```

- `tests/jest_global_setup.js` runs before every file: sets `TEST_NO_BIND`, a fresh temp
  `DATA_DIR`, `KNOWN_MEMBERS_PATH`, `STAFF_CONFIG_PATH`, and dummy provider credentials.
- `jest.config.js` uses `forceExit` — `server.js` keeps timers alive, and without it every
  run stayed behind as an orphan process.
- `callback_lifecycle.test.js` is the end-to-end suite for Barak's lead → callback
  workflow. Only the outbound transports are mocked (WhatsApp send functions, OpenAI,
  Arbox HTTP client). It drives real inbound messages and panel endpoints, restarts the
  server module from disk between steps, injects storage failures, and runs the real
  reminder worker with a controlled clock.

## 2. Standalone harnesses — `tests/*.test.mjs`

These are **not** Jest suites. Each is a plain Node ESM script that starts its own HTTP
mock (Green API + Arbox) and its own app server — in-process or as a child process — and
prints `✓` / `✗` lines plus a final summary.

```
npm run test:mjs                                   # all isolated harnesses
node tests/run_mjs_tests.mjs --filter callback     # subset
node tests/run_mjs_tests.mjs --filter callback_full --verbose
```

Always run them through `tests/run_mjs_tests.mjs`. The runner gives each harness its own
temp `DATA_DIR` and dummy credentials, kills the harness's whole process tree when it
finishes or times out (only processes it started), and reports a crash or timeout as a
failure.

| File | Runner | What it starts |
|---|---|---|
| `callback_full`, `callback_time`, `integration_callback_aptstore`, `production_bugs` | spawned `server.js` | HTTP mock for Green API + Arbox; real `whatsapp.service` |
| `routing_webhook`, `startup_conversion`, `media_stale`, `tomer_service` | in-process server | HTTP mock on fixed local ports |
| `reminder_worker` | module-level | worker + store against a temp dir |

## Tomer (existing-member service) and dashboard auth

| File | What it proves |
|---|---|
| `tomer_member_flow.test.js` (Jest) | real inbound member flows through `server.js`: verified Arbox reads, staff-handled membership requests, one manager alert per case, notification failure / uncertainty / retry, restart (no replay), duplicate message ids across a restart, staff workflow on a case, takeover / release for members |
| `dashboard_auth.test.js` (Jest) | fail-closed, sessions (expiry, tampering, logout revocation across a restart), CSRF, login attempt limiting, public list |
| `tomer_panel_browser_check.mjs` | real headless Chrome: login, deep link to a case, assign, staff reply, takeover / release, resolve, counters, retry, error / empty states, server restart, logout. Run directly: `node tests/tomer_panel_browser_check.mjs` |

| `tomer_test_mode.test.js` (Jest) | the TEST-ONLY restriction: allowlist, routing override for the test phone, synthetic identity, Barak lead / appointment untouched |
| `member_care.test.js` (Jest) | proactive member care on a controlled clock: every program, baselines (no backlog), contact policy, reply continuity, guest entitlement, restart / duplicate workers / uncertain sends |
| `member_care_browser_check.mjs` | real headless Chrome on the "ליווי חברים" area: settings, previews with reasons, run, pauses, guest redemption, absence report, restart. Run directly |

Known time-of-day dependence: `integration_callback_aptstore.test.mjs` asks for a callback "today at 15:00" against the real
clock, so it fails when run after 15:00 Israel time (the request is correctly rejected as "in the past").

## Not part of the isolated run

| File | Why | How to run |
|---|---|---|
| `barak_pipeline.test.js`, `video_endpoint.test.js` | live-server Jest suites: talk to whatever listens on `localhost:3000` | start a server yourself, then `npx jest --testPathIgnorePatterns /node_modules/ -- tests/<file>` |
| `barak_burst.test.mjs`, `barak_conversation.test.mjs` | live-server harnesses | `TEST_BASE_URL=http://localhost:PORT node tests/run_mjs_tests.mjs --filter barak_` |
| `barak_local.test.mjs` | asserts on real model output | `LIVE_OPENAI=1 OPENAI_API_KEY=… node tests/run_mjs_tests.mjs --filter barak_local` |
| `callback_demo.mjs`, `panel_demo_local.js`, `panel_check_local.js` | demo scripts, not tests | run directly |

## Known non-test warning

`tomer_service.test.mjs` prints `PASSED: 55 FAILED: 0` and then Node on Windows aborts
inside `process.exit()` (`UV_HANDLE_CLOSING` assertion in libuv). The runner reports this
as a warning after a clean summary, not as a failure and not silently.
