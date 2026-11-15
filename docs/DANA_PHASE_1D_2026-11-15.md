# Dana phase 1D — real integration prepared, mobile operation path, truthful quality

Status on 2026-11-15, branch `dana-phase-1a`. Builds on phases 1A–1C.
**Not deployed. No Railway change. No real notification, no publication, no call to Meta.
Autostart not installed. Tomer, Barak and Arbox untouched.** The system is not live.

## Implemented and verified locally

| Item | Where | Verification |
|---|---|---|
| Real Instagram publisher + insights adapter, disabled by default | `services/dana_instagram.js` | 10 contract tests against a local fake of the documented endpoints; no real account |
| Instagram mode in the publication gate; destination-account check before anything is created; production scheduler (off under test / mock / disabled) | `services/dana_publisher.js` | same tests |
| Read-only connection probe (account username, quota) | `GET /api/dana/studio/publisher/status?probe=1` | fake only |
| Official contract, sources, open questions | `docs/DANA_INSTAGRAM_CONTRACT.md` | docs read 2026-11-15 |
| Real "ready for review" notification path: once per version, one recipient, authenticated link, deferred during quiet hours, only a provider message id counts as sent | `services/dana_notify.js` | 9 tests with the WhatsApp provider mocked |
| Notification configuration status and one explicit test endpoint | `GET /notify/status`, `POST /notify/test` | tests |
| Review page: blockers and editorial suggestions separated; Israel-time schedule; truthful cover note; real/mock labels | `public/dana-studio.js` | rendered in headless Chrome (phase 1C); not opened on a phone via production |
| Link through login lands on the package | `public/index.html` (+1 line) | Barak panel browser check 33/33 |
| Routine fix for flashing cards (join with a neighbour, undone when too wide) | `captions.merge_short` | unit tests + real run |
| Revision loop: stops on a repeated blocking request; a revision that raises the number of failed checks is rejected and the previous result restored | `run.py` | unit tests; observed in a real run before the guard existed |
| Out point inside a pause stamp decided by the measured level at the cut | `checks.check_boundary` | unit tests + real run |
| Deployment proposal, rollback, live acceptance sequence, autostart procedure | `docs/DANA_DEPLOY_PLAN.md` | — |

Tests on the final commit: Jest 436/436, standalone harnesses 373/0, Barak panel browser check 33/33,
pipeline unit tests 51/51.

## Quality — what the last real local run shows

Source `MVI_0548.MP4`, segment 150.88–166.32 s, 18 cards, 2 automatic revisions, $0.343 reported
(list price; logged-in account), 248 s.

- **One blocker stays open:** the locked `sync_lead` check fails on card 16 (drift −1500 ms). The
  separate adjudication calls it a suspected false positive (speech detector and level envelope agree),
  which is not proof of word alignment; it needs the owner's look at the excerpt.
- **Five short-caption suggestions stay open:** cards on screen 0.24–0.44 s or read faster than
  17 characters per second. The automatic join was tried on three of them and undone because the
  joined card did not fit the safe zone. Not relabelled, thresholds unchanged.
- An earlier run of the same source showed why the regression guard was added: after a reviewer note
  the editor moved the segment into a passage with a self-correction, producing four confirmed timing
  failures; the loop stopped truthfully with eight open items.

## Still requires live verification

Everything external: the deployment itself, the page on a real phone, the worker against the deployed
queue, an upload through the production host (size limit, storage), the WhatsApp notification, every
Instagram call (token header, Page vs User token, caption line breaks, quota, metrics), and real
metrics collection. See `docs/DANA_INSTAGRAM_CONTRACT.md` § "Not verified".

Not available from this computer: the production configuration (reading it was not permitted in this
session) and any Instagram account information (the local `.env` holds a placeholder token and a
different notify number; the lead-ads token was not used).

## Missing information and approvals

See the final report of this phase and `docs/DANA_DEPLOY_PLAN.md` § 7.
