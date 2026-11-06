'use strict';

/**
 * In-memory store for automation rules and worker states.
 * Rules are trigger→action pairs evaluated by the scheduler workers.
 * Workers hold their enabled/disabled state here so the UI can toggle them live.
 */

const DEFAULT_RULES = [
  {
    id: 'rule-001',
    name: "ריאנגייג'מנט ליד רדום — נגיעה 1",
    trigger: { type: 'lead_silent', days: 3, scoreMax: 7 },
    action:  { type: 'send_whatsapp', template: 'lead_touch1', agent: 'tomer' },
    enabled: true, executionCount: 0, lastRun: null,
  },
  {
    id: 'rule-002',
    name: "ריאנגייג'מנט ליד רדום — נגיעה 2",
    trigger: { type: 'lead_silent', days: 7, scoreMax: 7 },
    action:  { type: 'send_whatsapp', template: 'lead_touch2', agent: 'tomer' },
    enabled: true, executionCount: 0, lastRun: null,
  },
  {
    id: 'rule-003',
    name: "ריאנגייג'מנט ליד רדום — נגיעה 3",
    trigger: { type: 'lead_silent', days: 14, scoreMax: 7 },
    action:  { type: 'send_whatsapp', template: 'lead_touch3', agent: 'tomer' },
    enabled: true, executionCount: 0, lastRun: null,
  },
  {
    id: 'rule-004',
    name: 'פולו-אפ הצעת היכרות לא מומשת',
    trigger: { type: 'intro_not_redeemed', days: 2 },
    action:  { type: 'send_whatsapp', template: 'intro_followup', agent: 'tomer' },
    enabled: true, executionCount: 0, lastRun: null,
  },
  {
    id: 'rule-005',
    name: 'ליד חם — התראה על הצעת היכרות חסרה',
    trigger: { type: 'lead_score_hot', scoreMin: 8, introNotSent: true },
    action:  { type: 'alert_owner', message: 'ליד חם ללא הצעת היכרות — לטפל עכשיו', agent: 'barak' },
    enabled: true, executionCount: 0, lastRun: null,
  },
  {
    id: 'rule-006',
    name: 'חברת סטודיו לא הגיעה 14+ ימים',
    trigger: { type: 'member_inactive', days: 14 },
    action:  { type: 'send_whatsapp', template: 'member_inactive', agent: 'tomer' },
    enabled: true, executionCount: 0, lastRun: null,
  },
  {
    id: 'rule-007',
    name: 'סנכרון Arbox אוטומטי — לידים ≥6',
    trigger: { type: 'lead_unsynced', scoreMin: 6 },
    action:  { type: 'arbox_sync', agent: 'barak' },
    enabled: false, executionCount: 0, lastRun: null,
  },
  {
    id: 'rule-008',
    name: 'ליד מ-Meta — נקלט ומועבר לברק',
    trigger: { type: 'meta_lead_webhook' },
    action:  { type: 'barak_ingest', agent: 'barak' },
    enabled: true, executionCount: 0, lastRun: null,
  },
];

const DEFAULT_WORKERS = [
  {
    id: 'tomer-retention',
    name:     'תומר — לולאת שימור',
    nameEn:   'Tomer Retention Loop',
    schedule: 'כל 4 שעות',
    agent:    'tomer',
    enabled:  true,
    lastRun:  null,
    runCount: 0,
  },
  {
    id: 'barak-ingestion',
    name:     'ברק — בדיקת CRM',
    nameEn:   'Barak CRM Ingestion',
    schedule: 'כל שעה',
    agent:    'barak',
    enabled:  true,
    lastRun:  null,
    runCount: 0,
  },
  {
    id: 'maya-briefing',
    name:     'מאיה — סיכום יומי',
    nameEn:   'Maya Daily Briefing',
    schedule: 'יומי 08:00',
    agent:    'maya',
    enabled:  true,
    lastRun:  null,
    runCount: 0,
  },
];

class AutomationStore {
  constructor() {
    this._rules   = new Map(DEFAULT_RULES.map(r => [r.id, { ...r }]));
    this._workers = new Map(DEFAULT_WORKERS.map(w => [w.id, { ...w }]));
    this._execLog = [];
  }

  // ── Rules ─────────────────────────────────────────────────────────────────

  getAllRules() { return Array.from(this._rules.values()); }
  getRule(id)   { return this._rules.get(id) ?? null; }

  toggleRule(id, enabled) {
    const rule = this._rules.get(id);
    if (!rule) return null;
    rule.enabled = typeof enabled === 'boolean' ? enabled : !rule.enabled;
    this._log(id, rule.name, { action: 'toggle', enabled: rule.enabled });
    return rule;
  }

  recordExecution(id, result = {}) {
    const rule = this._rules.get(id);
    if (!rule) return;
    rule.executionCount++;
    rule.lastRun = new Date();
    this._log(id, rule.name, result);
  }

  // ── Workers ───────────────────────────────────────────────────────────────

  getAllWorkers()          { return Array.from(this._workers.values()); }
  getWorker(id)            { return this._workers.get(id) ?? null; }
  isWorkerEnabled(id)      { return this._workers.get(id)?.enabled ?? true; }

  toggleWorker(id, enabled) {
    const w = this._workers.get(id);
    if (!w) return null;
    w.enabled = typeof enabled === 'boolean' ? enabled : !w.enabled;
    this._log(id, w.name, { action: 'worker_toggle', enabled: w.enabled });
    return w;
  }

  touchWorker(id) {
    const w = this._workers.get(id);
    if (!w) return;
    w.lastRun = new Date();
    w.runCount = (w.runCount ?? 0) + 1;
  }

  // ── Execution log ──────────────────────────────────────────────────────────

  _log(id, name, result = {}) {
    this._execLog.push({ ts: new Date(), id, name, result });
    if (this._execLog.length > 300) this._execLog.shift();
  }

  getExecLog(limit = 60) {
    return this._execLog.slice(-limit).reverse();
  }
}

module.exports = new AutomationStore();
