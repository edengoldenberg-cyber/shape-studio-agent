'use strict';

/**
 * member_actions.js — the action layer between Tomer and Arbox.
 *
 * The AI never calls Arbox. Only the operations in OPS exist, each with validated
 * arguments, an approval rule and a READ-BACK verification. An action is reported as
 * completed only after Arbox itself shows the result.
 *
 * Action states (case.action.state):
 *   awaiting_approval   staff must approve or reject (default for every membership change)
 *   approved            approved, not started (e.g. held because a human owns the conversation)
 *   awaiting_manual     approved, but Arbox API writes are disabled / unverified — staff
 *                       perform the change in Arbox and press "בוצע ב-Arbox"
 *   executing           a request was (or is being) sent to Arbox — recorded on disk BEFORE sending
 *   verified            Arbox shows the result                           ← only this means "done"
 *   failed              Arbox refused the request; nothing was applied
 *   uncertain           the request may or may not have been applied (timeout / crash /
 *                       accepted but not visible). Never retried automatically.
 *   not_verified        staff reported it done but Arbox does not show it
 *   rejected            staff rejected the request
 *
 * Durability: every transition is persisted (service_case_store throws on a failed
 * write). A request is sent only after its 'executing' record is on disk, so after a
 * crash the action is found in 'executing' and reconciled by reading Arbox — it is never
 * blindly repeated.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const OPS = {
  membership_hold: {
    label: 'הקפאת מנוי',
    requiresApproval: true,
    validate(a) {
      if (!a?.userId) return 'member not identified in Arbox';
      if (!a.membershipUserId) return 'membership not identified';
      if (!ISO_DATE.test(a.from ?? '') || !ISO_DATE.test(a.to ?? '')) return 'start and end dates are required';
      if (a.to < a.from) return 'end date is before start date';
      return null;
    },
    async verify(gateway, a) {
      const r = await gateway.getHoldStatus(a.userId, { from: a.from, to: a.to, membershipUserId: a.membershipUserId });
      return { ok: r.onHold, evidence: { source: r.source, matchedBy: r.matchedBy, rowFields: r.rowFields, totalRows: r.totalRows } };
    },
  },
  membership_cancel: {
    label: 'ביטול מנוי',
    requiresApproval: true,
    validate(a) {
      if (!a?.userId) return 'member not identified in Arbox';
      if (!a.membershipUserId) return 'membership not identified';
      return null;
    },
    async verify(gateway, a) {
      gateway.clearCache(`memberships:${a.userId}`);
      const r = await gateway.getMemberships(a.userId);
      const m = r.memberships.find(x => String(x.membershipUserId) === String(a.membershipUserId));
      const ok = !!m && (m.cancelled === true || m.active === false);
      return { ok, evidence: { source: r.source, membershipFound: !!m, cancelled: m?.cancelled ?? null, active: m?.active ?? null, endDate: m?.endDate ?? null } };
    },
  },
};

function createActionEngine({ cases, gateway, logger, isHumanOwned = () => false, onOutcome = async () => {} }) {
  const _locks = new Map();   // phone → promise chain (one action step at a time per member)
  function withLock(phone, fn) {
    const prev = _locks.get(phone) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    _locks.set(phone, next.finally(() => { if (_locks.get(phone) === next) _locks.delete(phone); }));
    return next;
  }
  const now = () => new Date().toISOString();

  /** Attach a proposed action to a case. Arguments may be incomplete at this point. */
  function propose(caseId, { op, args }) {
    if (!OPS[op]) throw new Error(`unknown operation: ${op}`);
    return cases.update(caseId, {}, { type: 'action_proposed', by: 'tomer', detail: op }, {
      actionPatch: {
        id: cases.newActionId(), op, args: args ?? {}, requiresApproval: OPS[op].requiresApproval,
        state: 'awaiting_approval', approval: null, attempts: [], verification: null, executor: null, heldForTakeover: false,
      },
    });
  }

  function setArgs(caseId, patch) {
    const c = cases.get(caseId);
    if (!c?.action || !['awaiting_approval', 'approved', 'awaiting_manual'].includes(c.action.state)) return c;
    return cases.update(caseId, {}, { type: 'action_args_updated', by: 'tomer', detail: Object.keys(patch).join(',') }, { actionPatch: { args: { ...c.action.args, ...patch } } });
  }

  /**
   * Staff decision. Approval starts execution when the API write is executable and no
   * human owns the conversation; otherwise the action waits (awaiting_manual / approved).
   * Repeating the same decision is a no-op; a decided action cannot be re-decided.
   */
  async function decide(caseId, { decision, by = 'staff', note = null }) {
    const c0 = cases.get(caseId);
    if (!c0?.action) return { ok: false, error: 'no_action' };
    return withLock(c0.phone, async () => {
      const c = cases.get(caseId);
      const a = c.action;
      if (a.approval?.decision === decision) return { ok: true, unchanged: true, case: c };
      if (a.state !== 'awaiting_approval') return { ok: false, error: 'not_awaiting_approval', state: a.state };
      if (decision === 'rejected') {
        const u = cases.update(caseId, { status: 'rejected', owner: by, nextAction: null }, { type: 'action_rejected', by, detail: note },
          { actionPatch: { state: 'rejected', approval: { decision, by, at: now(), note } } });
        await onOutcome(u, 'rejected');
        return { ok: true, case: cases.get(caseId) };
      }
      if (decision !== 'approved') return { ok: false, error: 'bad_decision' };
      const invalid = OPS[a.op].validate(a.args);
      if (invalid) return { ok: false, error: 'invalid_args', detail: invalid };
      const executable = gateway.writesEnabled(a.op);
      const held = executable && isHumanOwned(c.phone);
      const state = !executable ? 'awaiting_manual' : 'approved';
      cases.update(caseId, { status: 'in_progress', owner: by,
        nextAction: !executable ? 'לבצע את הפעולה ב-Arbox וללחוץ "בוצע ב-Arbox"' : held ? 'השיחה בטיפול אנושי — הפעולה ממתינה ללחיצה על "בצע עכשיו"' : 'מתבצע' },
        { type: 'action_approved', by, detail: note }, { actionPatch: { state, approval: { decision, by, at: now(), note }, heldForTakeover: held } });
      if (executable && !held) return _execute(caseId, { by });
      return { ok: true, case: cases.get(caseId) };
    });
  }

  /** Explicit staff instruction to run an approved action now (also during takeover). */
  async function executeNow(caseId, { by = 'staff' } = {}) {
    const c0 = cases.get(caseId);
    if (!c0?.action) return { ok: false, error: 'no_action' };
    return withLock(c0.phone, async () => {
      const c = cases.get(caseId);
      if (c.action.state !== 'approved') return { ok: false, error: 'not_approved', state: c.action.state };
      if (!gateway.writesEnabled(c.action.op)) return { ok: false, error: 'writes_disabled' };
      return _execute(caseId, { by });
    });
  }

  async function _verify(caseId, { tries = 1, delayMs = 0 } = {}) {
    const c = cases.get(caseId);
    let last = { ok: false, evidence: null }, error = null;
    for (let i = 0; i < tries; i++) {
      try { last = await OPS[c.action.op].verify(gateway, c.action.args); error = null; }
      catch (err) { error = err.message; }
      if (last.ok) break;
      if (i < tries - 1 && delayMs) await new Promise(r => setTimeout(r, delayMs));
    }
    return { ...last, error, at: now() };
  }

  async function _execute(caseId, { by }) {
    let c = cases.get(caseId);
    const a = c.action;
    // 0. Already applied? (e.g. staff did it in Arbox meanwhile) — never send a duplicate.
    const pre = await _verify(caseId);
    if (pre.ok) {
      c = cases.update(caseId, { nextAction: 'לעדכן את החבר/ה ולסגור' }, { type: 'action_verified', by: 'system', detail: 'already applied in Arbox' },
        { actionPatch: { state: 'verified', verification: pre, executor: 'found_applied', heldForTakeover: false } });
      await onOutcome(c, 'verified');
      return { ok: true, case: cases.get(caseId) };
    }
    // 1. Record the attempt durably BEFORE the request leaves. If this write fails, nothing is sent.
    const attempt = { id: cases.newActionId(), at: now(), by, state: 'submitted' };
    cases.update(caseId, { nextAction: 'מתבצע מול Arbox' }, { type: 'action_executing', by, detail: a.op },
      { actionPatch: { state: 'executing', executor: 'api', attempts: [...(a.attempts ?? []), attempt], heldForTakeover: false } });
    // 2. Send.
    let outcome, detail = null;
    try { await gateway.executeWrite(a.op, a.args); outcome = 'accepted'; }
    catch (err) {
      detail = err.detail ?? err.message;
      outcome = err.kind === 'write_disabled' ? 'not_sent' : err.kind === 'rejected' ? 'rejected' : err.kind === 'bad_args' ? 'not_sent' : 'unknown';
    }
    const finishAttempt = st => { const cur = cases.get(caseId).action.attempts; return cur.map(x => x.id === attempt.id ? { ...x, state: st, detail, finishedAt: now() } : x); };
    if (outcome === 'not_sent') {
      c = cases.update(caseId, { nextAction: 'לבצע את הפעולה ב-Arbox וללחוץ "בוצע ב-Arbox"' }, { type: 'action_not_sent', by: 'system', detail },
        { actionPatch: { state: 'awaiting_manual', attempts: finishAttempt('not_sent') } });
      return { ok: true, case: c };
    }
    if (outcome === 'rejected') {
      c = cases.update(caseId, { status: 'awaiting_staff', nextAction: 'Arbox דחה את הבקשה — לבדוק ולטפל ידנית' }, { type: 'action_failed', by: 'system', detail },
        { actionPatch: { state: 'failed', attempts: finishAttempt('rejected') } });
      await onOutcome(c, 'failed');
      return { ok: true, case: cases.get(caseId) };
    }
    // 3. accepted OR unknown (timeout / 5xx after submission): the truth is whatever Arbox shows now.
    const ver = await _verify(caseId, { tries: 3, delayMs: Number(process.env.ARBOX_VERIFY_DELAY_MS ?? 1500) });
    if (ver.ok) {
      c = cases.update(caseId, { nextAction: 'לעדכן את החבר/ה ולסגור' }, { type: 'action_verified', by: 'system', detail: outcome === 'unknown' ? 'request outcome was unknown; Arbox shows it applied' : null },
        { actionPatch: { state: 'verified', verification: ver, attempts: finishAttempt(outcome === 'unknown' ? 'unknown_then_verified' : 'accepted') } });
      await onOutcome(c, 'verified');
    } else {
      c = cases.update(caseId, { status: 'awaiting_staff', nextAction: 'תוצאה לא ודאית — לבדוק ב-Arbox לפני כל ניסיון נוסף' },
        { type: 'action_uncertain', by: 'system', detail: outcome === 'unknown' ? `request outcome unknown (${detail})` : 'accepted by Arbox but not visible in a read-back' },
        { actionPatch: { state: 'uncertain', verification: ver, attempts: finishAttempt(outcome === 'unknown' ? 'unknown' : 'accepted_unverified') } });
      await onOutcome(c, 'uncertain');
    }
    return { ok: true, case: cases.get(caseId) };
  }

  /** Staff performed the change in Arbox themselves. Completion is still decided by a read-back. */
  async function markExecutedManually(caseId, { by = 'staff' } = {}) {
    const c0 = cases.get(caseId);
    if (!c0?.action) return { ok: false, error: 'no_action' };
    return withLock(c0.phone, async () => {
      const c = cases.get(caseId);
      if (c.action.state === 'verified') return { ok: true, unchanged: true, case: c };
      if (!['awaiting_manual', 'approved', 'uncertain', 'not_verified', 'failed'].includes(c.action.state)) return { ok: false, error: 'bad_state', state: c.action.state };
      const ver = await _verify(caseId, { tries: 2, delayMs: Number(process.env.ARBOX_VERIFY_DELAY_MS ?? 1500) });
      if (ver.ok) {
        const u = cases.update(caseId, { nextAction: 'לעדכן את החבר/ה ולסגור' }, { type: 'action_verified', by, detail: 'performed by staff in Arbox; confirmed by read-back' },
          { actionPatch: { state: 'verified', verification: ver, executor: 'staff_manual', heldForTakeover: false } });
        await onOutcome(u, 'verified');
      } else {
        cases.update(caseId, { status: 'awaiting_staff', nextAction: 'Arbox עדיין לא מציג את השינוי — לבדוק ולנסות "בדוק שוב"' },
          { type: 'action_not_verified', by, detail: ver.error ?? 'read-back does not show the change' },
          { actionPatch: { state: 'not_verified', verification: ver, executor: 'staff_manual' } });
      }
      return { ok: true, verified: ver.ok, case: cases.get(caseId) };
    });
  }

  /** Re-read Arbox for an action whose outcome is unknown or unconfirmed. Never sends anything. */
  async function recheck(caseId, { by = 'staff' } = {}) {
    const c0 = cases.get(caseId);
    if (!c0?.action) return { ok: false, error: 'no_action' };
    return withLock(c0.phone, async () => {
      const c = cases.get(caseId);
      if (!['uncertain', 'not_verified', 'executing'].includes(c.action.state)) return { ok: false, error: 'bad_state', state: c.action.state };
      const ver = await _verify(caseId);
      if (ver.ok) {
        const u = cases.update(caseId, { nextAction: 'לעדכן את החבר/ה ולסגור' }, { type: 'action_verified', by, detail: 'confirmed by a later read-back' },
          { actionPatch: { state: 'verified', verification: ver } });
        await onOutcome(u, 'verified');
      } else {
        cases.update(caseId, {}, { type: 'action_recheck', by, detail: ver.error ?? 'still not visible in Arbox' }, { actionPatch: { verification: ver, state: c.action.state === 'executing' ? 'uncertain' : c.action.state } });
      }
      return { ok: true, verified: ver.ok, case: cases.get(caseId) };
    });
  }

  /**
   * After a restart: an action left in 'executing' had a request in flight when the
   * process died. Read Arbox; mark verified if it shows the result, otherwise 'uncertain'
   * for staff. Nothing is ever re-sent here.
   */
  async function reconcileOnStartup() {
    const stuck = cases.list({ open: true, limit: 1000 }).filter(c => c.action?.state === 'executing');
    const out = [];
    for (const c of stuck) {
      const ver = await _verify(c.id);
      if (ver.ok) {
        const u = cases.update(c.id, { nextAction: 'לעדכן את החבר/ה ולסגור' }, { type: 'action_verified', by: 'system', detail: 'found applied after restart' }, { actionPatch: { state: 'verified', verification: ver } });
        await onOutcome(u, 'verified');
      } else {
        const u = cases.update(c.id, { status: 'awaiting_staff', nextAction: 'המערכת הופסקה באמצע פעולה — לבדוק ב-Arbox לפני כל ניסיון נוסף' },
          { type: 'action_uncertain', by: 'system', detail: 'process restarted while the request was in flight' }, { actionPatch: { state: 'uncertain', verification: ver } });
        await onOutcome(u, 'uncertain');
      }
      out.push({ caseId: c.id, verified: ver.ok });
      logger.warn('[member-actions] reconciled in-flight action after restart', { caseId: c.id, verified: ver.ok });
    }
    return out;
  }

  return { propose, setArgs, decide, executeNow, markExecutedManually, recheck, reconcileOnStartup, OPS };
}

module.exports = { createActionEngine, OPS };
