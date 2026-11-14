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

## Not part of the isolated run

| File | Why | How to run |
|---|---|---|
| `barak_pipeline.test.js`, `video_endpoint.test.js` | live-server Jest suites: talk to whatever listens on `localhost:3000` | start a server yourself, then `npx jest --testPathIgnorePatterns /node_modules/ -- tests/<file>` |
| `barak_burst.test.mjs`, `barak_conversation.test.mjs` | live-server harnesses | `TEST_BASE_URL=http://localhost:PORT node tests/run_mjs_tests.mjs --filter barak_` |
| `barak_local.test.mjs` | asserts on real model output | `LIVE_OPENAI=1 OPENAI_API_KEY=… node tests/run_mjs_tests.mjs --filter barak_local` |
| `callback_demo.mjs`, `panel_demo_local.js`, `panel_check_local.js` | demo scripts, not tests | run directly |

## Known non-test warning

`tomer_service.test.mjs` prints `PASSED: 53 FAILED: 0` and then Node on Windows aborts
inside `process.exit()` (`UV_HANDLE_CLOSING` assertion in libuv). The runner reports this
as a warning after a clean summary, not as a failure and not silently.
