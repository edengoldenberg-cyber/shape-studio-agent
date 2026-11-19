'use strict';

/**
 * services/maya_control.js — Maya's daily operational control check.
 *
 * A scheduled scan that DETECTS operational anomalies the task board does not already surface, over the
 * stores that already exist (no parallel database): unanswered inbound messages, callbacks whose time passed
 * with no recorded outcome, cases closed without an outcome, send failures / missing delivery reports, an
 * agent / integration that is down, and Dana work waiting for the team.
 *
 * Semantics the owner asked for:
 *   • Each anomaly has a STABLE key, so a re-run UPDATES it (lastSeen) and never creates a duplicate.
 *   • Each carries: evidence, first detected time, last checked time, responsible, next action, status.
 *   • A resolved anomaly is closed WITH a reason and kept for a while.
 *   • A source that could not be read is reported as NOT CHECKED — its anomalies are left as-is
 *     (unknown), never resolved and never counted as "all clear".
 *   • Nothing here sends a message or changes a customer.
 */

const fs = require('fs');
const path = require('path');

const UNANSWERED_MIN_MS = 2 * 60 * 60 * 1000;     // a lead/member message with no reply for 2h+
const CALLBACK_GRACE_MS = 30 * 60 * 1000;         // a callback is "overdue" 30 min past its time
const DELIVERY_STALE_H = 6;                        // accepted-but-never-confirmed after 6h = worth a look
const RESOLVED_KEEP_MS = 7 * 86400000;

function createMayaControl({
  dataDir = (process.env.DATA_DIR ?? path.join(__dirname, '../data')).replace(/[/\\]$/, ''),
  logger = { info() {}, warn() {}, error() {} }, now = () => new Date(),
  getBoard = null, getAppointments = null, activeStatuses = new Set(['callback_pending', 'confirmed']),
  isSuperseded = () => false, getThreads = null, leadOf = () => null,
  deliverySummary = null, systemRows = null, danaList = null, casesList = null,
} = {}) {
  const FILE = path.join(dataDir, 'maya_control.json');
  const iso = d => (d instanceof Date ? d.toISOString() : d ?? null);
  let _state = null;
  function load() {
    if (_state) return _state;
    try { _state = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { _state = { anomalies: {}, runs: [] }; }
    _state.anomalies = _state.anomalies ?? {}; _state.runs = _state.runs ?? [];
    return _state;
  }
  function save() { try { fs.mkdirSync(dataDir, { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(_state), 'utf8'); fs.renameSync(tmp, FILE); } catch (e) { logger.warn('[maya-control] save failed', { error: e.message }); } }

  const tail = p => (p ? '…' + String(p).replace(/\D/g, '').slice(-4) : '—');
  const ageH = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.round((now().getTime() - t) / 3600000) : null; };

  // ── the scan: returns { found: Map(key→anomaly), sources: {name:{ok,error}} } ─────────
  function scan() {
    const t = now().getTime();
    const found = new Map();
    const sources = {};
    const add = (key, a) => found.set(key, { key, ...a });
    const src = (name, fn) => { try { fn(); sources[name] = { ok: true }; } catch (e) { sources[name] = { ok: false, error: String(e.message).slice(0, 140) }; logger.warn('[maya-control] source failed', { source: name, error: e.message }); } };

    // 1. unanswered inbound — last message is inbound, nothing sent after it, 2h+.
    src('messages', () => {
      if (!getThreads) throw new Error('inbox not wired');
      for (const th of getThreads({ limit: 400 })) {
        const msgs = th.messages ?? []; if (!msgs.length) continue;
        let lastIn = null, lastOut = null;
        for (const m of msgs) { const ts = Date.parse(m.timestamp); if (!Number.isFinite(ts)) continue; if (m.direction === 'in') lastIn = ts; else if (m.direction === 'out') lastOut = ts; }
        if (lastIn == null || (lastOut != null && lastOut >= lastIn)) continue;     // answered, or no inbound
        if (t - lastIn < UNANSWERED_MIN_MS) continue;
        const lead = leadOf(th.phone) ?? null, status = lead?.status ?? null;
        if (status === 'opted_out') continue;                                       // a silence they asked for is not an anomaly
        const staff = status === 'human_owns';                                      // valid manual handling, but still waiting for the team
        add('unanswered:' + th.phone, {
          type: 'unanswered_inbound', severity: t - lastIn > 24 * 3600000 ? 'high' : 'normal',
          title: `הודעה ללא מענה — ${th.name || tail(th.phone)}`,
          evidence: `הודעה אחרונה מהלקוח/ה לפני ${Math.round((t - lastIn) / 3600000)} שעות, ללא תשובה.${staff ? ' השיחה בטיפול ידני.' : ''}`,
          who: th.name || tail(th.phone), link: '#whatsapp',
          responsible: staff ? 'צוות' : (lead ? 'ברק/תומר' : 'צוות'),
          nextAction: staff ? 'הצוות לקח את השיחה — להשיב או לשחרר לתומר' : 'לבדוק מדוע לא נענתה ולהשיב',
        });
      }
    });

    // 2. callbacks past their time with no recorded outcome
    src('callbacks', () => {
      if (!getAppointments) throw new Error('appointments not wired');
      for (const a of getAppointments()) {
        if (!activeStatuses.has(a.status)) continue;
        const when = a.scheduledAt instanceof Date ? a.scheduledAt.getTime() : Date.parse(a.scheduledAt);
        if (!Number.isFinite(when) || when > t - CALLBACK_GRACE_MS) continue;
        if (isSuperseded(a)) continue;
        add('callback:' + a.id, {
          type: 'callback_overdue', severity: 'high',
          title: `שיחה חוזרת ללא תוצאה — ${a.leadName || tail(a.leadPhone)}`,
          evidence: `מועד השיחה ${iso(a.scheduledAt)?.slice(0, 16).replace('T', ' ')} עבר, והתוצאה לא תועדה.`,
          who: a.leadName || tail(a.leadPhone), link: '#barak',
          responsible: 'צוות', nextAction: 'להתקשר ולרשום תוצאה, או לעדכן מועד',
        });
      }
    });

    // 3. a case resolved without an outcome
    if (casesList) src('cases', () => {
      for (const c of casesList()) {
        if (c.status !== 'resolved') continue;
        if (c.resolution && c.resolution.outcome) continue;
        add('case_no_outcome:' + c.id, {
          type: 'case_closed_without_outcome', severity: 'normal',
          title: `פנייה נסגרה בלי תוצאה — ${c.memberName || ''}`.trim(),
          evidence: 'הפנייה סומנה כסגורה אך אין בה תיעוד של מה נעשה.',
          who: c.memberName || null, link: '#tomer/case/' + c.id,
          responsible: 'צוות', nextAction: 'לפתוח מחדש ולתעד תוצאה',
        });
      }
    });

    // 4. send failures / missing delivery reports (accepted ≠ delivered)
    if (deliverySummary) src('delivery', () => {
      const d = deliverySummary({ hours: 48 }) ?? {};
      if ((d.failed ?? 0) > 0) add('delivery:failed', {
        type: 'send_failure', severity: 'high', title: `${d.failed} הודעות עם כשל שליחה (48 שעות)`,
        evidence: `לפי יומן המסירה: ${d.failed} הודעות בסטטוס כשל. התפלגות: ${JSON.stringify(d.byStatus ?? {})}.`,
        who: null, link: '#health', responsible: 'צוות', nextAction: 'לבדוק את חיבור ה-WhatsApp ואת ההודעות שנכשלו',
      });
      if (d.oldestUnconfirmedAt && ageH(d.oldestUnconfirmedAt) >= DELIVERY_STALE_H && !d.anyStatusReported) add('delivery:no_report', {
        type: 'no_delivery_report', severity: 'normal', title: 'אין דיווחי מסירה מהספק',
        evidence: `הודעות התקבלו אצל הספק אך לא הגיע אף דיווח "נמסרה/נקראה" (הישנה מ-${ageH(d.oldestUnconfirmedAt)} שעות). ייתכן שדיווחי הסטטוס כבויים.`,
        who: null, link: '#health', responsible: 'צוות', nextAction: 'לוודא שדיווחי סטטוס מופעלים ב-GreenAPI (קבלה אצל הספק אינה מסירה)',
      });
    });

    // 5. an agent / integration / worker that is UNAVAILABLE. Only a genuine failure counts — the informational
    //    statuses the Health screen shows (off = deliberately off, blocked / limited / partial = a known config gap or
    //    partial feature) are NOT control anomalies and must not nag here.
    const DOWN = new Set(['fail', 'down', 'error', 'unavailable']);
    if (systemRows) src('system', () => {
      const rows = systemRows.__rows ?? [];                   // filled by the async wrapper before scan()
      for (const r of rows) {
        const down = DOWN.has(r.state), unknown = r.state === 'unknown';
        if (!down && !unknown) continue;
        add('integration:' + (r.id || r.label), {
          type: 'integration_down', severity: down ? 'high' : 'normal',
          title: `${r.label || r.id}: ${unknown ? 'לא נבדק' : 'לא זמין'}`,
          evidence: r.detail || r.state, who: null, link: '#health',
          responsible: 'מנהל', nextAction: r.action || (unknown ? 'המצב לא נקרא — לבדוק ידנית' : 'לבדוק את האינטגרציה/העובד'),
        });
      }
    });

    // 6. Dana work waiting for the team / blocked
    if (danaList) src('dana', () => {
      const projects = danaList() ?? [];
      const review = projects.filter(p => p.status === 'ready_for_review');
      const blocked = projects.filter(p => ['failed', 'blocked'].includes(p.status));
      if (review.length) add('dana:review', { type: 'dana_waiting', severity: 'normal', title: `${review.length} סרטונים של דנה ממתינים לאישור`, evidence: `${review.length} פרויקטים במצב "מוכן לבדיקה".`, who: null, link: '#dana', responsible: 'צוות', nextAction: 'לבדוק ולאשר/להעיר בסטודיו של דנה' });
      if (blocked.length) add('dana:blocked', { type: 'dana_blocked', severity: 'high', title: `${blocked.length} עבודות של דנה נחסמו/נכשלו`, evidence: `${blocked.length} פרויקטים במצב נכשל/חסום.`, who: null, link: '#dana', responsible: 'מנהל', nextAction: 'לבדוק את הכשל בסטודיו של דנה' });
    });

    return { found, sources };
  }

  // ── tick: merge the scan into the persisted store (dedup, detect-time, resolve) ────────
  async function tick() {
    // the system source is async; read its rows once and hang them on the fn for the sync scan
    if (systemRows) { try { systemRows.__rows = await systemRows(); } catch (e) { systemRows.__rows = undefined; systemRows.__err = e.message; } }
    const s = load(), nowIso = iso(now());
    let res;
    try { res = scan(); } catch (e) { logger.error('[maya-control] scan threw', { error: e.message }); return { ok: false, error: e.message }; }
    const { found, sources } = res;
    // the system source wrapper failed → mark it not checked
    if (systemRows && systemRows.__rows === undefined) sources.system = { ok: false, error: systemRows.__err || 'not read' };

    let opened = 0, updated = 0, resolved = 0;
    for (const [key, a] of found) {
      const ex = s.anomalies[key];
      if (ex && ex.status === 'open') { Object.assign(ex, a, { lastCheckedAt: nowIso, lastSeenAt: nowIso }); updated++; }
      else { s.anomalies[key] = { ...a, status: 'open', detectedAt: nowIso, lastCheckedAt: nowIso, lastSeenAt: nowIso, resolvedAt: null, resolveReason: null }; opened++; }
    }
    // resolve anomalies no longer found — but ONLY for sources that were actually checked this run
    const okSources = new Set(Object.entries(sources).filter(([, v]) => v.ok).map(([k]) => k));
    const SOURCE_OF = { unanswered_inbound: 'messages', callback_overdue: 'callbacks', case_closed_without_outcome: 'cases', send_failure: 'delivery', no_delivery_report: 'delivery', integration_down: 'system', dana_waiting: 'dana', dana_blocked: 'dana' };
    for (const [key, a] of Object.entries(s.anomalies)) {
      if (a.status !== 'open' || found.has(key)) continue;
      const srcName = SOURCE_OF[a.type];
      if (srcName && !okSources.has(srcName)) { a.lastCheckedAt = nowIso; continue; }   // source unavailable → leave as unknown
      a.status = 'resolved'; a.resolvedAt = nowIso; a.resolveReason = 'לא זוהתה עוד בבדיקה'; resolved++;
    }
    // drop long-resolved
    for (const [key, a] of Object.entries(s.anomalies)) if (a.status === 'resolved' && a.resolvedAt && now().getTime() - Date.parse(a.resolvedAt) > RESOLVED_KEEP_MS) delete s.anomalies[key];
    s.runs.push({ at: nowIso, found: found.size, opened, updated, resolved, sources });
    if (s.runs.length > 200) s.runs.splice(0, s.runs.length - 200);
    save();
    return { ok: true, opened, updated, resolved, open: Object.values(s.anomalies).filter(a => a.status === 'open').length, sources };
  }

  function list() {
    const s = load();
    const all = Object.values(s.anomalies);
    const open = all.filter(a => a.status === 'open').sort((a, b) => (a.severity === 'high' ? -1 : 0) - (b.severity === 'high' ? -1 : 0) || Date.parse(a.detectedAt) - Date.parse(b.detectedAt));
    const resolved = all.filter(a => a.status === 'resolved').sort((a, b) => Date.parse(b.resolvedAt) - Date.parse(a.resolvedAt)).slice(0, 30);
    const lastRun = s.runs.at(-1) ?? null;
    return { ok: true, generatedAt: iso(now()), open, resolved, counts: { open: open.length, high: open.filter(a => a.severity === 'high').length }, lastRun, runs: s.runs.slice(-20).reverse(), sources: lastRun?.sources ?? null };
  }

  return { scan, tick, list, _reset() { _state = null; } };
}

module.exports = { createMayaControl };
