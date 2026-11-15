# Dana phase 1C — connected workflow: plan → edit → review → revise → approval → MOCK publication → MOCK metrics

Status on 2026-11-15, branch `dana-phase-1a`. Builds on `DANA_PHASE_1A` and `DANA_PHASE_1B`.
**Nothing is deployed. No Railway change. No real notification, publication or other external write.
Autostart is not installed. Tomer, Barak and Arbox were not touched.**

The full system is NOT operational: every external part (Instagram, real notifications, production
deployment) is still unconnected and unverified.

## Capability matrix

| Capability | State | Evidence |
|---|---|---|
| Upload, hashing, duplicate detection, durable jobs, leases, recovery | **Operational locally** | phase 1A tests; e2e step 1 |
| Dana's plan (objective, message, source range, exact words, brief, verified facts, missing info) | **Operational locally** (real model call) | `editorial/plan.json`, e2e step 2 |
| Editing through the canonical pipeline (GPU transcription, PNG captions, checks) | **Operational locally** | e2e step 3 |
| Dana's review of the result (two transcriptions, timed cards, check records, 5 frames + cover) | **Operational locally** (real model call, images) | e2e step 4 |
| Automatic revision loop, verified by re-measurement, max 3 cycles + budget | **Operational locally** | e2e step 5; 1 revision, both injected defects fixed |
| ig-caption / ig-human measuring scripts on the caption | **Operational locally** | review stage, pinned by hash |
| Mandatory checks, locked sync gate, one owner review list, fail-closed completeness check | **Operational locally** | `checks.assert_nothing_hidden`, tests |
| Mobile approval page (video with Range, cover, caption, CTA, account, Israel-time schedule, issues, history) | **Operational locally** | screenshots; not exercised on the production host |
| Approval bound to the exact package; any change invalidates it | **Operational locally** | e2e steps 8–9; tests |
| "Ready for review" notification, once per version | **Mock-verified** (recorded, never sent) | e2e step 7 |
| Calendar, proposed time, global pause, cancel | **Mock-verified** | `tests/dana_publication.test.js` |
| Publication lifecycle, restart recovery, timeout → uncertain → reconciliation, expired credentials | **Mock-verified** against a local stand-in API | e2e steps 10–11; tests |
| Publication verification (media id, permalink, caption match) | **Mock-verified** | e2e step 11 |
| Metrics collection attached to the right publication | **Mock-verified** (synthetic numbers) | e2e step 12 |
| Real Instagram publishing, insights | **Blocked** — no account access verified, no real adapter written | — |
| Real WhatsApp notification with an authenticated link | **Blocked** — needs deployment (public URL) and separate approval | — |
| Production deployment, worker ↔ production | **Blocked** — not approved | — |
| Windows worker auto-start | **Prepared, not installed** | `dana-worker/autostart/` |
| Stories, carousels, community replies, DMs, profile audit, competitor research, weekly content planning | **Deferred** | `docs/DANA_SKILLS_MATRIX.md` |

Skills: see `docs/DANA_SKILLS_MATRIX.md` (4 of 13 active in the Reel workflow, 9 deferred).

## The demonstration (disposable test project, `C:\Users\owner\dana-work\e2e-full`)

Source: `MVI_0548.MP4` with the four previously used ranges excluded. Run log: `C:\Users\owner\dana-work\e2e-full.log`.

1. Upload → project and job on disk.
2. Plan: objective, message, range 150.88–166.20 s, brief, verified facts (studio name, town), missing info listed.
3. Worker draft: 18 cards.
4. Review of the output: 5 frames at 0.4 / 4.0 / 7.7 / 11.3 / 14.9 s + cover, both transcriptions, timed cards, check records.
5. **Labelled test injection** (a price in the caption, a non-quotation cover): detected in cycle 0 by the checks and by the reviewer; the editor corrected both; cycle 1 re-measured both as fixed. 10 findings went to the editor in cycle 0, none in cycle 1.
6. Editorial status `ready_for_owner_review` after 1 revision. Package status stays `review_required`: the locked `sync_lead` check failed on card 16 (drift +1500 ms, adjudicated as a suspected false positive) and is an open owner item. Four advisory reading-time findings remain (cards shorter than 0.5 s).
7. One mock notification recorded (`mode: mock`, not sent).
8. Publication blocked before approval and consent. Approval by `TEST ACTOR (automated, not the owner)` after a labelled test confirmation of the review item.
9. Caption edited → approval removed, fingerprint changed, publication refused.
10. Labelled TEST consent, re-approval, scheduling for 2026-11-16 12:00 Asia/Jerusalem (proposed default), mode `mock`.
11. Container created → **server process restarted** → state and container id survived → publish request timed out after the mock had created the post → state `uncertain` → further ticks sent nothing → reconciliation found the single post. 1 container, 1 post, 1 publish call.
12. Mock metrics at 48 h and 168 h attached to that media id, labelled MOCK.

All 12 steps passed in the final run (171 s wall time).

### What the verification pass found and fixed

- A first complete run passed its 12 steps but hid a defect: a **confirmed** locked sync failure (card 23, drift +4280 ms) was folded into a text item of the same card, and a genuine reviewer content finding was dropped by an over-broad "already measured" filter. The item never disappeared and approval was never possible without it, but it was under-represented. Fixed: folding is limited to pure spelling variance with a small locked drift; the filter no longer matches on screen-time wording; `assert_nothing_hidden` now refuses to produce a package when any failed check, failed card, suspicious word, text difference or blocking issue is missing from the owner's list.
- The planner's caption named the trainee (her first name is heard in the recording). Added a rule and criterion A14: no private person is named in caption or cover.
- A second run failed at the plan stage: the chosen out point fell inside the stamp of a word with no gap after it, and the validator rejected it twice. The boundary rule now ends the segment in the pause before such a word, or exactly where the previous word ends.
- An earlier loop test used all 3 cycles on a sync failure the text editor cannot change; restated automatic checks are no longer forwarded to the editor.

## Measured (final run)

| Call | Role | Time | Output tokens | Images | Cost reported by the CLI |
|---|---|---|---|---|---|
| plan_a1 | planner | 20.2 s | 2,607 | 0 | $0.030 |
| review0 | reviewer | 13.1 s | 1,670 | 6 | $0.041 |
| edit1_a1 | editor | 26.0 s | 3,949 | 0 | $0.123 |
| review1 | reviewer | 16.7 s | 2,348 | 6 | $0.054 |
| **Total** | | 76 s | | | **$0.248** |

Model: `claude-sonnet-5-5`. Upload → package: 162 s (two full renders of a 15 s clip). Whole demonstration: 171 s.
Budget caps: 3 cycles, $2.00, 1500 s per job; $1.00 per call.

Billing: the figures are the CLI's list-price calculation (`costBasis: list`). No API key is in the environment and the CLI reports `apiKeySource: null`, so the calls ran under the logged-in Claude account. Whether that draws on plan usage or billed credit is not visible to this code, and the caps stop a run rather than define a charge.

Other runs in this phase (same basis): first loop test $0.758 (3 revisions, before the filter); first complete run $0.575 (2 revisions); one run that failed at the plan stage (two planner calls, not totalled).

## Tests

- `python -m unittest discover -s dana-worker/tests`: 49 passed.
- `npx jest --runInBand`: 417 / 417 (Dana: 32 studio + 12 publication).
- `node tests/run_mjs_tests.mjs`: PASS=373 FAIL=0 on a clean run. One earlier run under load showed 2 failures in `routing_webhook.test.mjs` ("3e: late bot send", a timing-dependent Barak test); it passed on the immediate rerun and its code was not changed.

## Not exercised

- The name rule (A14) was added after the first complete run and held in the final run's caption; no test forces a name into the caption.
- The approval page was rendered in headless Chrome at phone width; it was not opened on a phone through the production host.
- Model safety refusals: none occurred in this phase's final wording; there is still no fallback model.
- The reviewer sees 5 frames; it cannot judge motion, audio quality or what was actually said.

## Remaining requirements for real operation

1. **Instagram**: account type and Page link, Meta app mode, chosen login flow; then verify the publishing and insights contract against the official documentation and the live API for that account, and write the real adapter (the mock mirrors a hypothesis). The existing lead-ads token is not evidence of publishing access and was not used.
2. **Publishing credentials** for that adapter, stored only on the server; a renewal procedure.
3. **Deployment approval**: a deploy window, `DANA_WORKER_TOKEN` on the server and on the editing computer, the worker's `server_url`, upload size limit / storage on the server.
4. **Notification approval**: `DANA_NOTIFY_REAL` + `DANA_NOTIFY_PHONE`, after the review page is reachable at an authenticated public URL.
5. **Worker auto-start approval** (`dana-worker/autostart/install.ps1`).
6. **Consent** for every person in footage that is to be published.
7. **Brand settings**: Instagram account, approved CTA / offer, audience, voice examples.
8. A new owner-supplied clip as the editorial acceptance test.
