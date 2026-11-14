# Tomer audit checkpoint — 2026-11-14

Audit only. Nothing was changed in production, deployed, reset or sent to members.
Code revision audited: branch `barak-callback-completion` @ `2629cfb` (production runs `d7a7d6c`,
deployment `c4dd1980`; the Tomer code paths are identical in both).

Evidence labels: **[CODE]** code review · **[PROBE]** isolated run of the real pipeline with
synthetic members and HTTP-mocked Arbox / Green API / OpenAI (`scripts/audit/tomer_probe.cjs`) ·
**[PROD-RO]** read-only production API inspection, anonymized · **[UI-RO]** production panel
loaded read-only in headless Chrome · **[TESTS]** existing automated tests read and run.
No real-world receipt was tested in this phase.

## 1. What "Tomer" actually is

"Tomer" in the inbox is a ROUTE label (`route: 'tomer'`), not one agent. Four different things
answer a member:

| Responder | Where | When |
|---|---|---|
| Deterministic shared templates | `server.js → buildSchedulingReply()` (shared with Barak) | `detectSchedulingIntent()` ≠ `general`: cancellation, fixed_booking, booking, schedule_query, specialist_query, subscription_query, representative |
| Tomer AI | `agents/tomer_agent.js → handleInboundMember()` (gpt-4o, `prompts/tomer_prompt.md`) | intent = `general` AND `classifyMessage()` ∉ {silence, chitchat} |
| Payment acknowledgement | `server.js` payment block (`isPaymentMessage`) | PAYMENT_RE match OR any image without caption — runs before routing |
| Media holding reply | `server.js` Tomer branch | any non-text message (voice, location, document) |

Other parts: `utils/tomer_store.js` (tasks, per-member AI history, audit ring of 500, message
queue), `workers/retention_worker.js` (5 workflows, all disabled, config in memory),
`workers/scheduler.js → runTomerScan` (logs only, sends nothing), `utils/automation_store.js`
(rules are display-only, never executed), `public/tomer-panel.js` (7 tabs), endpoints
`/api/tomer/*`.

Flow: `/api/green-api/webhook` → burst accumulator (1.5 s, per-phone lock) → `processInboundWAMessage`
→ in-memory dedup → reaction bypass → `phone_registry` gate → staff bypass → 4-tier identity
(`member_cache` → `known_members.json` → `barakAgent.lookupClient` → Tier-4 hold) → intent regex →
members-only legacy callback block → spam → payment → ownership gate (`human_owns` / `opted_out`
on the lead_store record) → route → send → inbox / lead events / tomer audit.

All automated outbound is stored in the inbox with `agentId: 'barak'`; imported history is
`green-api`. The inbox cannot tell Tomer, a template, Barak or a staff phone message apart.

## 2. Findings (priority order)

P0 — fix before anything else
1. **False confirmations with no action behind them.** `buildSchedulingReply`: `cancellation` →
   "בקשת הביטול התקבלה ✅ אנחנו מעדכנים את הלוח"; `fixed_booking` → "אחד מהצוות ייצור איתך קשר תוך
   שעה"; media → "הצוות שלנו יחזור אליך בהקדם"; schedule → "רוצה מקום? ענה/י עם שם השיעור".
   No Arbox action exists, no task, no staff alert. Trigger regex includes `לא יכול|לבטל|ביטלתי`.
   [PROBE #1,#2,#3,#8,#19] [PROD-RO: 2 wrong cancellation/fixed-booking templates, 4 media replies]
2. **Membership cancellation never reaches Tomer's escalation.** "רוצה לבטל את המנוי" → intent
   `cancellation` → class-cancel template; `CANCEL_RE` → Eden task + alert in `tomer_agent.js` is
   unreachable for it. [PROBE #29]. `tests/tomer_service.test.mjs` passes on the wrong template
   (assertion `/נחזור/` matches it).
3. **Real requests silently dropped.** `classifyMessage`: any text ≤ 50 chars without an
   `ACTIONABLE_RE` word → `chitchat` → no reply, no task, no alert. [PROD-RO: refund request,
   "תתקשר אלי כשתוכל", "צריכה לדבר איתך בהקדם", app problem, reschedule request, billing "אשמח להסבר"]
   [PROBE #7,#13,#14,#16,#20]
4. **No authentication on the dashboard or any API.** No auth middleware in `server.js`. Anyone
   with the URL can read member conversations and phones, send WhatsApp from the studio number
   (`/api/tomer/send-whatsapp`, `/api/tomer/action`, `/api/whatsapp/threads/:phone/send`,
   `/api/whatsapp/simulate`), edit staff/knowledge, take over / release, `POST /api/store/reset`.
   [CODE] [PROD-RO: every read in this audit was unauthenticated]
5. **Phone-side staff takeover does not pause Tomer for most members.** `_applyStaffTakeover`
   returns early when the record is `converted_member` (`server.js:2729`); `releaseOwnership`
   restores members to `converted_member`. So: former leads (record reclassified on first member
   message) are never paused by a phone reply, and any member is un-pausable from the phone after
   the first release. Dashboard send has the same hole. [PROBE F2, F3] — matches incident 3.

P1
6. **Member context is empty for ~95 % of members.** `arbox.getMemberByPhone` compares the raw
   Arbox phone (`05…` for 130/165, `+972…` for 8) with `972…`; reads only page 1 of active users;
   `clientMatch.arboxId` is null on the cache path. Model receives "אין נתוני Arbox עבור מספר זה".
   [PROBE CTX05 vs +972] [PROD-RO phone formats]. Entries remaining / bookings / freezes are not in
   the API at all.
7. **AI invents availability and uses markdown.** "יש מקום פנוי לשני האימונים… [להרשמה](http…)"
   — no occupancy data exists. [PROD-RO 13.11]. Tomer has no output post-processor.
8. **Schedule answers broken since 12.11** (`6587061`): `barakAgent.checkSchedule` does
   `new Date(msgTimestamp * 1000)` on a Date → year 58835 → "אין שיעורים ב…" for every day-specific
   question, members and leads. [CODE] [PROBE #4,#5,#15]. Not yet seen in a production thread.
9. **Any captionless image = "קיבלנו את אישור התשלום ✅"**. [PROBE #18] [PROD-RO ×2]
10. **`subscription_query` goes through the ADMIN chat function** (`tomerAgent.chat`): one shared
    `_adminHistory` for all members and the panel, no member context, and on model failure the member
    receives "שגיאה טכנית." [CODE] [PROBE #9,#28]
11. **Member "representative" flow** (legacy block): creates a `callback_pending` appointment and a
    lead record `callback_requested` for a member, asks the member for their name, never notifies the
    manager (name capture is lead-only), surfaces in Barak's callback panel. [PROBE #21,#22]
12. **Escalation is thin:** only `complaint` and `cancel_request` alert the manager; `freeze_request`
    creates a silent task (production task open and unassigned since 12.11, and it is actually a
    billing dispute); no SLA, reminder, acknowledgement or member follow-up.
13. **No opt-out for members**; dashboard sends ignore `opted_out` / `human_owns` and bypass quiet
    hours (`/api/tomer/action`). [PROBE #26, G]
14. **Durability:** `tomer_store._write` swallows write errors; dedup `_seenInbound` and the
    unclassified list are memory-only; retention toggles reset on restart; AI history is debounced 2 s.
15. **Panel signal quality:** 27/28 conversations carry the ⚠️ escalate badge; "ממתינים למענה" shows 0;
    member table cannot join conversations/ownership (same phone-format mismatch). [PROD-RO] [UI-RO]

## 3. Known incidents

| Incident | Responsible handler | Trigger | Existing fix | Coverage |
|---|---|---|---|---|
| "ביטלתי היום" → payment ack (12.11) | payment block, not Tomer | `PAYMENT_RE` `ביט` inside `ביטלתי` | look-arounds on `ביט` (d7dda53) — works | `member_incident.test.js` A — but on a NON-member identity. On the member path the message now gets the false "בקשת הביטול התקבלה ✅" [PROBE #1] — untested |
| "לא הצלחתי להגיע ולא לבטל" → reschedule | shared reschedule block | `INTENT_PATTERNS.reschedule` had `לא הצלחתי` | pattern removed — works | test C asserts only "not the reschedule template", non-member identity. Member path now → cancellation template [PROBE #2] |
| Bot reply after a manual staff message | Tomer AI / templates | outgoing webhook was off (fixed), plus finding 5 | webhook enabled; live takeover verified for a lead | no test for `converted_member` members; reproduced in [PROBE F2/F3] |

## 4. Recommended first phase ("Truthful Tomer + service cases")

1. One member-intent classifier replacing `detectSchedulingIntent` + `classifyMessage` for members;
   every non-social message ends in exactly one of: verified answer / service case + staff alert.
2. Remove every unbacked promise template; truthful wording + self-service link.
3. `service_case` lifecycle (extend `service_tasks.json`): type, owner, status, next action, due,
   member-facing promise, alert state; member callback moves here (out of Barak's appointment store).
4. Ownership stored per phone independent of lead status; phone + dashboard takeover for every member.
5. Arbox member lookup by normalized phone over all pages with a short cache; fix `checkSchedule` anchor.
6. Output guard for Tomer (no availability/booking/payment claims, no markdown).
7. Authentication on dashboard + API.
8. Correct `agentId` / handler / trigger on every outbound record.
9. Real-flow tests for all of the above on a MEMBER identity (pattern: `tests/callback_lifecycle.test.js`).

## 5. How to continue

- Re-run the probe: `node scripts/audit/tomer_probe.cjs` (isolated; ~40 s).
- Barak's live callback test was still in progress when this was written (reminder due 17:30 on
  14.11); quiet-hours commit `2629cfb` is local only; do not deploy Tomer work on top without
  finishing that handoff.
- Open questions for the owner are listed at the end of the session report.
