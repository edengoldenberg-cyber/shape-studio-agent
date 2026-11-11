/* ════════════════════════════════════════════════════════════════════════════
   Tomer Workspace — member-service panel JS
   Tabs: Overview · Members · Eden Tasks · Automation · Audit
   RTL, Hebrew labels, real API calls, no fake data.
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

// Auto-refresh overview every 60 seconds when the Tomer tab is active
let _tomerAutoRefresh = null;
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'tomer') {
        if (!_tomerAutoRefresh) {
          _tomerAutoRefresh = setInterval(() => {
            const activePane = document.querySelector('.tw-tab.active')?.dataset?.pane;
            if (activePane === 'overview') loadOverview();
          }, 60_000);
        }
      } else {
        clearInterval(_tomerAutoRefresh);
        _tomerAutoRefresh = null;
      }
    });
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '—')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;');
}
function $id(id) { return document.getElementById(id); }
function setTxt(id, val) { const el=$id(id); if(el) el.textContent = val ?? '—'; }
function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('he-IL',{timeZone:'Asia/Jerusalem',dateStyle:'short',timeStyle:'short'}); }
  catch { return iso.slice(0,16); }
}
function maskPhone(p) {
  const s = String(p ?? '');
  if (s.length <= 4) return '****';
  return s.slice(0, 3) + '•••' + s.slice(-3);
}
function statusHe(s) {
  return { open:'פתוח', eden_assigned:'לעדן', in_progress:'בטיפול', resolved:'נפתר', cancelled:'בוטל' }[s] ?? s ?? '—';
}
function priorityHe(p) {
  return { high:'גבוה 🔴', normal:'רגיל 🟡', low:'נמוך 🟢' }[p] ?? p ?? '—';
}
function typeHe(t) {
  return {
    freeze_request:     '❄️ הקפאה',
    cancel_request:     '🚫 ביטול מנוי',
    complaint:          '⚠️ תלונה',
    unsupported_action: '🔧 אין תמיכה',
    billing_question:   '💳 חיוב',
    other:              '📋 כללי',
  }[t] ?? t ?? '—';
}
async function api(url, opts = {}) {
  const r = await fetch(url, opts);
  return r.json();
}
function toast(msg, ok = true) {
  const t = document.createElement('div');
  t.className = 'toast ' + (ok ? '' : 'toast-err');
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ── Modal dialog system (replaces browser alert/confirm/prompt) ───────────────
// Usage: confirmModal('Are you sure?', () => doIt())
//        promptModal('Enter note:', 'optional', val => save(val))
//        infoModal('Task details', htmlContent)

function _buildModal(titleTxt, bodyHtml, buttons) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('dir', 'rtl');
  overlay.innerHTML = `
    <div class="modal-box" role="dialog" aria-modal="true">
      <div class="modal-header">
        <span class="modal-title">${esc(titleTxt)}</span>
        <button class="modal-close" aria-label="סגור">✕</button>
      </div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-footer">${buttons}</div>
    </div>`;
  overlay.querySelector('.modal-close').onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  overlay.querySelector('.modal-box').focus?.();
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); }
  });
  return overlay;
}

function confirmModal(message, onYes, onNo) {
  const m = _buildModal('אישור',
    `<p class="modal-msg">${esc(message)}</p>`,
    `<button class="btn btn-danger" id="mc-yes">אישור</button>
     <button class="btn btn-secondary" id="mc-no">ביטול</button>`);
  m.querySelector('#mc-yes').onclick = () => { m.remove(); onYes?.(); };
  m.querySelector('#mc-no').onclick  = () => { m.remove(); onNo?.(); };
}

function promptModal(title, placeholder, onConfirm) {
  const m = _buildModal(title,
    `<input type="text" id="mp-input" class="field-input" placeholder="${esc(placeholder)}" style="width:100%" />`,
    `<button class="btn btn-primary" id="mp-ok">אישור</button>
     <button class="btn btn-secondary" id="mp-cancel">ביטול</button>`);
  const inp = m.querySelector('#mp-input');
  inp.focus();
  const submit = () => { const v = inp.value; m.remove(); onConfirm?.(v); };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
  m.querySelector('#mp-ok').onclick     = submit;
  m.querySelector('#mp-cancel').onclick = () => m.remove();
}

function infoModal(title, bodyHtml) {
  _buildModal(title, bodyHtml, `<button class="btn btn-secondary" onclick="this.closest('.modal-overlay').remove()">סגור</button>`);
}

// ── Tab switching ─────────────────────────────────────────────────────────────
document.querySelectorAll('.tw-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tw-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tw-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const pane = btn.dataset.pane;
    const paneEl = $id('twp-' + pane);
    if (paneEl) paneEl.classList.add('active');
    if (pane === 'overview')   loadOverview();
    if (pane === 'members')    {} // load on demand
    if (pane === 'tasks')      loadTasks();
    if (pane === 'automation') loadAutomation();
    if (pane === 'audit')      loadAudit();
  });
});

// ── Global refresh + run checks ───────────────────────────────────────────────
$id('tw-refresh')?.addEventListener('click', () => {
  const active = document.querySelector('.tw-tab.active')?.dataset.pane ?? 'overview';
  if (active === 'overview')   loadOverview();
  if (active === 'members')    loadMembers();
  if (active === 'tasks')      loadTasks();
  if (active === 'automation') loadAutomation();
  if (active === 'audit')      loadAudit();
});

$id('btn-tomer-checks')?.addEventListener('click', async () => {
  const btn = $id('btn-tomer-checks');
  const res = $id('tomer-checks-result');
  btn.disabled = true;
  if (res) { res.style.display = 'block'; res.textContent = 'מריץ...'; }
  try {
    const data = await api('/api/tomer/run-checks', { method: 'POST' });
    if (res) res.textContent = JSON.stringify(data, null, 2);
    toast('בדיקות הושלמו ✓');
  } catch (e) {
    if (res) res.textContent = 'שגיאה: ' + e.message;
    toast('שגיאה בהרצת בדיקות', false);
  } finally { btn.disabled = false; }
});

// ════════════════════════════════════════════════════════════════════════════
//  OVERVIEW
// ════════════════════════════════════════════════════════════════════════════

async function loadOverview() {
  try {
    const data = await api('/api/tomer/overview');
    if (!data.ok) return;
    const s = data.service ?? {};

    setTxt('twk-open',   s.openTasks    ?? 0);
    setTxt('twk-high',   s.highPriorityTasks ?? 0);
    setTxt('twk-unclass',s.unclassified ?? 0);
    setTxt('twk-failed', s.failedActions ?? 0);
    setTxt('twk-arbox',  data.arboxHealth ? '✅ OK' : '⚠️ Error');

    // Badge on Tasks tab
    const badge = $id('tw-badge-tasks');
    if (badge) badge.textContent = s.openTasks > 0 ? String(s.openTasks) : '';

    // Open tasks list
    _renderOpenTasksList(data.openTasks ?? []);
    // Recent audit
    _renderRecentAudit(data.recentAudit ?? []);
    // Unclassified
    await _loadAndRenderUnclassified();
  } catch (e) { console.error('loadOverview', e); }
}

function _renderOpenTasksList(tasks) {
  const el = $id('tw-open-tasks-list');
  const emp = $id('tw-tasks-empty');
  if (!el) return;
  if (!tasks.length) {
    el.innerHTML = '';
    if (emp) emp.style.display = '';
    return;
  }
  if (emp) emp.style.display = 'none';
  el.innerHTML = tasks.slice(0, 8).map(t => `
    <div class="tw-list-row tw-task-row" data-task-id="${esc(t.id)}">
      <span class="tw-task-type">${typeHe(t.type)}</span>
      <span class="tw-task-who">${esc(t.memberName ?? maskPhone(t.phone))}</span>
      <span class="tw-task-summary">${esc(t.summary?.slice(0,60))}</span>
      <span class="tw-task-pri ${t.priority === 'high' ? 'tw-pri-high' : ''}">${priorityHe(t.priority)}</span>
      <span class="tw-task-time">${fmtDate(t.createdAt)}</span>
      <div class="tw-task-actions">
        <button class="btn-xs" onclick="openTaskActions('${esc(t.id)}')">פעולות</button>
      </div>
    </div>`).join('');
}

function _renderRecentAudit(entries) {
  const el = $id('tw-recent-audit');
  if (!el) return;
  el.innerHTML = entries.slice(0, 8).map(e => `
    <div class="tw-list-row">
      <span class="tw-audit-event ${e.sendState === 'failed' ? 'tw-failed' : ''}">${esc(e.event)}</span>
      <span class="tw-audit-who">${esc(e.memberName ?? maskPhone(e.phone))}</span>
      <span class="tw-audit-preview">${esc((e.requestPreview ?? '').slice(0, 50))}</span>
      <span class="tw-audit-time">${fmtDate(e.ts)}</span>
    </div>`).join('') || '<div class="tw-empty">אין פעילות אחרונה</div>';
}

async function _loadAndRenderUnclassified() {
  const el  = $id('tw-unclassified-list');
  const emp = $id('tw-unclass-empty');
  const cnt = $id('tw-unclass-count');
  if (!el) return;
  try {
    const data = await api('/api/tomer/unclassified');
    const contacts = data.contacts ?? [];
    if (cnt) cnt.textContent = contacts.length > 0 ? `(${contacts.length})` : '';
    if (!contacts.length) {
      el.innerHTML = '';
      if (emp) emp.style.display = '';
      return;
    }
    if (emp) emp.style.display = 'none';
    el.innerHTML = contacts.slice(0, 10).map(c => `
      <div class="tw-list-row">
        <span class="tw-uc-phone">${maskPhone(c.phone)}</span>
        <span class="tw-uc-msg">${esc((c.firstMessage ?? '').slice(0, 60))}</span>
        <span class="tw-uc-time">${fmtDate(c.firstSeenAt)}</span>
        <div class="tw-uc-actions">
          <button class="btn-xs" onclick="routeUnclassified('${esc(c.phone)}','barak')">→ ברק</button>
          <button class="btn-xs btn-xs-sec" onclick="routeUnclassified('${esc(c.phone)}','ignore')">התעלם</button>
        </div>
      </div>`).join('');
  } catch (e) { console.error('loadUnclassified', e); }
}

window.routeUnclassified = async function(phone, routeTo) {
  try {
    await api(`/api/tomer/unclassified/${encodeURIComponent(phone)}/route`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ routeTo }),
    });
    toast(routeTo === 'barak' ? 'הועבר לברק ✓' : 'הוסתר ✓');
    _loadAndRenderUnclassified();
  } catch (e) { toast('שגיאה: ' + e.message, false); }
};

// ════════════════════════════════════════════════════════════════════════════
//  MEMBERS (Arbox)
// ════════════════════════════════════════════════════════════════════════════

$id('tw-members-load')?.addEventListener('click', loadMembers);
$id('tw-member-search')?.addEventListener('input', filterMembers);
$id('tw-member-status')?.addEventListener('change', filterMembers);

let _allMembers = [];

async function loadMembers() {
  const btn = $id('tw-members-load');
  if (btn) btn.disabled = true;
  const tbody = $id('tw-members-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="empty-state">טוען...</td></tr>';
  try {
    const data = await api('/api/arbox/detailed-members');
    _allMembers = [
      ...(data.active ?? []).map(m => ({ ...m, _statusKey: 'active' })),
      ...(data.expiringSoon ?? []).map(m => ({ ...m, _statusKey: 'expiring' })),
      ...(data.expired ?? []).map(m => ({ ...m, _statusKey: 'expired' })),
    ];
    await renderMembers(_allMembers);
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="empty-state">שגיאה: ${esc(e.message)}</td></tr>`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function filterMembers() {
  const q   = ($id('tw-member-search')?.value ?? '').trim().toLowerCase();
  const st  = $id('tw-member-status')?.value ?? '';
  const filtered = _allMembers.filter(m => {
    const name  = `${m.first_name ?? ''} ${m.last_name ?? ''}`.toLowerCase();
    const phone = String(m.phone ?? '').toLowerCase();
    const matchQ = !q || name.includes(q) || phone.includes(q);
    const matchS = !st || m._statusKey === st;
    return matchQ && matchS;
  });
  renderMembers(filtered).catch(() => {});
}

async function renderMembers(members) {
  const tbody = $id('tw-members-tbody');
  if (!tbody) return;
  if (!members.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">אין תוצאות</td></tr>';
    return;
  }
  const statusHebrew = { active: '<span class="badge-active">פעיל</span>',
    expiring: '<span class="badge-warm">עומד לפוג</span>',
    expired:  '<span class="badge-crisis">פג</span>' };
  // Load lead-store data once for enrichment (non-blocking — degrade gracefully)
  const leadMap = {}; // phone → { status, openTaskCount, lastContact }
  try {
    const ld = await api('/api/leads');
    if (Array.isArray(ld)) {
      ld.forEach(l => {
        leadMap[l.phone] = {
          status: l.status,
          openTasks: 0,  // enriched below if tasks API available
          lastContact: l.meta?.lastContactAt ?? null,
        };
      });
    }
  } catch { /* non-fatal */ }
  try {
    const td = await api('/api/tomer/tasks?status=open');
    (td.tasks ?? []).forEach(t => {
      if (t.phone && leadMap[t.phone]) leadMap[t.phone].openTasks = (leadMap[t.phone].openTasks ?? 0) + 1;
    });
  } catch { /* non-fatal */ }

  tbody.innerHTML = members.slice(0, 100).map(m => {
    const name    = `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim() || '—';
    const endDate = m.membership_end_date?.slice(0, 10) ?? '—';
    const badge   = statusHebrew[m._statusKey] ?? m._statusKey ?? '';
    const ld      = leadMap[m.phone] ?? {};
    const ownerHtml = ld.status === 'human_owns'
      ? '<span class="badge-crisis">👤 ידני</span>'
      : ld.status === 'opted_out'
        ? '<span class="badge-status-cancelled">🔇</span>'
        : '<span class="badge-active">🤖</span>';
    const openTaskHtml = ld.openTasks > 0
      ? `<span class="badge-crisis">${ld.openTasks}</span>`
      : '<span class="tw-muted">—</span>';
    return `<tr>
      <td>${esc(name)}</td>
      <td>${maskPhone(m.phone)}</td>
      <td>${badge}</td>
      <td>${esc(endDate)}</td>
      <td>${ownerHtml}</td>
      <td>${openTaskHtml}</td>
      <td><button class="btn-xs" onclick="openMemberDrawer('${esc(m.phone)}','${esc(name)}')">פרופיל</button></td>
    </tr>`;
  }).join('');
}

// ════════════════════════════════════════════════════════════════════════════
//  EDEN TASKS
// ════════════════════════════════════════════════════════════════════════════

let _taskStatusFilter = 'open';

document.querySelectorAll('[data-tf]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-tf]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    _taskStatusFilter = btn.dataset.tf;
    loadTasks();
  });
});

async function loadTasks() {
  const tbody = $id('tw-tasks-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" class="empty-state">טוען...</td></tr>';
  try {
    const url = '/api/tomer/tasks' + (_taskStatusFilter ? `?status=${_taskStatusFilter}` : '');
    const data = await api(url);
    const tasks = data.tasks ?? [];

    // Update badge
    const badge = $id('tw-badge-tasks');
    if (badge && data.openCount != null) badge.textContent = data.openCount > 0 ? String(data.openCount) : '';

    if (!tasks.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">אין משימות</td></tr>';
      return;
    }
    tbody.innerHTML = tasks.map(t => `
      <tr class="task-row-${t.priority}">
        <td>${esc(t.memberName ?? maskPhone(t.phone))}</td>
        <td>${typeHe(t.type)}</td>
        <td title="${esc(t.detail ?? '')}">${esc((t.summary ?? '').slice(0, 60))}</td>
        <td class="${t.priority === 'high' ? 'tw-pri-high' : ''}">${priorityHe(t.priority)}</td>
        <td><span class="badge-status-${t.status}">${statusHe(t.status)}</span></td>
        <td>${fmtDate(t.createdAt)}</td>
        <td>
          ${t.status !== 'resolved' ? `<button class="btn-xs" onclick="resolveTask('${esc(t.id)}')">פתור</button>` : ''}
          ${t.status === 'open' ? `<button class="btn-xs btn-xs-sec" onclick="assignTask('${esc(t.id)}')">הקצה</button>` : ''}
          <button class="btn-xs btn-xs-sec" onclick="viewTaskDetail('${esc(t.id)}')">פרטים</button>
        </td>
      </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">שגיאה: ${esc(e.message)}</td></tr>`;
  }
}

window.resolveTask = function(taskId) {
  promptModal('הערת סגירה (אופציונלי)', 'סיבה / הערה...', async (note) => {
    try {
      await api(`/api/tomer/tasks/${encodeURIComponent(taskId)}/resolve`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolutionNote: note ?? '', resolvedBy: 'Eden' }),
      });
      toast('משימה נסגרה ✓');
      loadTasks(); loadOverview();
    } catch (e) { toast('שגיאה: ' + e.message, false); }
  });
};

window.assignTask = async function(taskId) {
  try {
    await api(`/api/tomer/tasks/${encodeURIComponent(taskId)}/assign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignedTo: 'Eden' }),
    });
    toast('הוקצה לעדן ✓');
    loadTasks();
  } catch (e) { toast('שגיאה: ' + e.message, false); }
};

window.openTaskActions = window.assignTask;

window.viewTaskDetail = async function(taskId) {
  try {
    const data = await api(`/api/tomer/tasks`);
    const task = data.tasks?.find(t => t.id === taskId);
    if (!task) { toast('פרטי משימה לא נמצאו', false); return; }
    const rows = [
      ['חבר/ה', task.memberName ?? maskPhone(task.phone)],
      ['טלפון', maskPhone(task.phone)],
      ['סוג', typeHe(task.type)],
      ['עדיפות', priorityHe(task.priority)],
      ['סטטוס', statusHe(task.status)],
      ['נוצר', fmtDate(task.createdAt)],
      task.requestedDates && ['תאריכים מבוקשים', task.requestedDates],
      task.memberMessage && ['הודעת חבר/ה', task.memberMessage],
      task.detail && ['פרטים', task.detail],
      task.resolutionNote && ['הערת סגירה', task.resolutionNote],
    ].filter(Boolean);
    const html = `<table class="detail-table">${rows.map(([k, v]) =>
      `<tr><th>${esc(k)}</th><td>${esc(String(v ?? '—'))}</td></tr>`
    ).join('')}</table>`;
    infoModal(`משימה: ${typeHe(task.type)} — ${esc(task.memberName ?? maskPhone(task.phone))}`, html);
  } catch (e) { toast('שגיאה: ' + e.message, false); }
};

// ════════════════════════════════════════════════════════════════════════════
//  AUTOMATION (Retention workflows)
// ════════════════════════════════════════════════════════════════════════════

$id('tw-workflows-load')?.addEventListener('click', loadAutomation);

async function loadAutomation() {
  const el = $id('tw-workflows');
  if (!el) return;
  el.innerHTML = '<div class="tw-spin">טוען...</div>';
  try {
    const data = await api('/api/tomer/retention/config');
    const cfg  = data.config ?? {};

    const labels = {
      birthday:    '🎂 ברכת יום הולדת',
      onboarding1: '🌱 צ׳ק-אין שבוע 1',
      onboarding2: '🌱 צ׳ק-אין שבוע 2',
      attendance:  '🏋️ היעדרות ממושכת',
    };
    const descs = {
      birthday:    'ברכה ביום ההולדת לפי תאריך Arbox',
      onboarding1: 'הודעה 7 ימים אחרי membership_start_date',
      onboarding2: 'הודעה 14 ימים אחרי membership_start_date',
      attendance:  'פנייה אחרי 14+ ימים ללא נוכחות מקומית',
    };

    el.innerHTML = Object.entries(cfg).map(([id, wf]) => `
      <div class="tw-workflow-card">
        <div class="tw-wf-header">
          <span class="tw-wf-label">${esc(labels[id] ?? id)}</span>
          <label class="tw-toggle">
            <input type="checkbox" class="tw-wf-toggle" data-wf="${esc(id)}" ${wf.enabled ? 'checked' : ''}/>
            <span class="tw-toggle-track"></span>
          </label>
        </div>
        <div class="tw-wf-desc">${esc(descs[id] ?? '')}</div>
        <div class="tw-wf-status ${wf.enabled ? 'tw-wf-on' : 'tw-wf-off'}">${wf.enabled ? 'פעיל' : 'מושבת'}</div>
        <div class="tw-wf-actions">
          <button class="btn-xs" onclick="previewWorkflow('${esc(id)}')">👁️ תצוגה מקדימה</button>
          <button class="btn-xs btn-xs-sec" onclick="runWorkflowNow('${esc(id)}')">▶ הרץ עכשיו</button>
        </div>
      </div>`).join('');

    // Wire toggles
    el.querySelectorAll('.tw-wf-toggle').forEach(cb => {
      cb.addEventListener('change', async () => {
        const wfId   = cb.dataset.wf;
        const enabled = cb.checked;
        try {
          await api('/api/tomer/retention/toggle', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workflowId: wfId, enabled }),
          });
          toast(`${labels[wfId] ?? wfId} ${enabled ? 'הופעל' : 'הושבת'}`);
          loadAutomation();
        } catch (e) { toast('שגיאה: ' + e.message, false); cb.checked = !enabled; }
      });
    });
  } catch (e) {
    el.innerHTML = `<div class="tw-empty">שגיאה: ${esc(e.message)}</div>`;
  }
}

window.previewWorkflow = async function(wfId) {
  try {
    const data = await api(`/api/tomer/retention/preview/${encodeURIComponent(wfId)}`);
    const eligible = data.eligible ?? [];
    const msgPreview = data.messagePreview ? `<div class="wf-preview-msg">${esc(data.messagePreview)}</div>` : '';
    if (!eligible.length) {
      infoModal(`תצוגה מקדימה: ${esc(data.workflow ?? wfId)}`,
        `${msgPreview}<p class="modal-msg">אין חברים זכאים כרגע.</p>`);
      return;
    }
    const list = eligible.slice(0, 15).map(m =>
      `<li>${esc(m.name || maskPhone(m.phone))}</li>`).join('');
    const more = eligible.length > 15 ? `<li>...ועוד ${eligible.length - 15}</li>` : '';
    infoModal(`תצוגה מקדימה: ${esc(data.workflow ?? wfId)}`,
      `${msgPreview}<p><strong>${eligible.length} חברים זכאים:</strong></p><ul>${list}${more}</ul>
       <p class="modal-note">⚠️ זוהי תצוגה מקדימה — לא נשלחו הודעות.</p>`);
  } catch (e) { toast('שגיאה: ' + e.message, false); }
};

window.runWorkflowNow = function(wfId) {
  confirmModal(`הרץ "${wfId}" עכשיו?\nישלח הודעות WhatsApp לכל החברים הזכאים.`, async () => {
    try {
      const data = await api(`/api/tomer/retention/run/${encodeURIComponent(wfId)}`, { method: 'POST' });
      toast(`הושלם: נשלחו ${data.sent ?? 0}, דולגו ${data.skipped ?? 0}`);
      loadAutomation();
    } catch (e) { toast('שגיאה: ' + e.message, false); }
  });
};

// ════════════════════════════════════════════════════════════════════════════
//  AUDIT
// ════════════════════════════════════════════════════════════════════════════

$id('tw-audit-load')?.addEventListener('click', loadAudit);

async function loadAudit() {
  const tbody = $id('tw-audit-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" class="empty-state">טוען...</td></tr>';
  const phone = $id('tw-audit-phone')?.value.trim();
  try {
    const url = '/api/tomer/audit' + (phone ? `?phone=${encodeURIComponent(phone)}` : '');
    const data = await api(url);
    const entries = data.entries ?? [];
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">אין נתונים</td></tr>';
      return;
    }
    tbody.innerHTML = entries.map(e => `
      <tr class="${e.sendState === 'failed' ? 'tw-row-failed' : ''}">
        <td style="white-space:nowrap">${fmtDate(e.ts)}</td>
        <td>${esc(e.memberName ?? maskPhone(e.phone))}</td>
        <td><span class="tw-event-${e.event?.split('_')[0]}">${esc(e.event ?? '—')}</span></td>
        <td title="${esc(e.requestPreview)}">${esc((e.requestPreview ?? '').slice(0, 40))}</td>
        <td title="${esc(e.tomerAction)}">${esc((e.tomerAction ?? '').slice(0, 40))}</td>
        <td title="${esc(e.replyPreview)}">${esc((e.replyPreview ?? '').slice(0, 40))}</td>
        <td>${esc(e.arboxStatus ?? '—')}</td>
      </tr>`).join('');
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">שגיאה: ${esc(e.message)}</td></tr>`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  MEMBER DETAIL DRAWER
// ════════════════════════════════════════════════════════════════════════════

$id('tw-drawer-close')?.addEventListener('click', closeDrawer);
$id('tw-drawer-overlay')?.addEventListener('click', closeDrawer);

function closeDrawer() {
  const d = $id('tw-drawer');
  if (d) { d.style.display = 'none'; }
}

window.openMemberDrawer = async function(phone, name) {
  const drawer = $id('tw-drawer');
  const body   = $id('tw-drawer-body');
  const title  = $id('tw-drawer-name');
  if (!drawer || !body) return;
  if (title) title.textContent = name || maskPhone(phone);
  body.innerHTML = '<div class="tw-spin">טוען...</div>';
  drawer.style.display = '';

  try {
    const data = await api(`/api/tomer/member/${encodeURIComponent(phone)}`);
    const m    = data.arbox;
    const lead = data.lead ?? {};
    const tasks = data.tasks ?? [];
    const audit = data.audit ?? [];
    const inboxThreads = data.inboxThreads ?? [];
    const history = data.history ?? []; // Tomer AI conv history

    // Owner badge
    const ownerBadge = lead.status === 'human_owns'
      ? `<span class="badge-crisis">👤 בטיפול אנושי${lead.meta?.humanOwnsBy ? ' — ' + esc(lead.meta.humanOwnsBy) : ''}</span>`
      : lead.status === 'opted_out'
        ? `<span class="badge-status-cancelled">🔇 הסרה</span>`
        : `<span class="badge-active">🤖 בוט פעיל</span>`;

    // Subscription details
    const memberSection = m ? `
      <div class="tw-ds-row-grid">
        <span><b>שם:</b> ${esc(`${m.first_name??''} ${m.last_name??''}`.trim())}</span>
        <span><b>סטטוס:</b> ${m.active ? '✅ פעיל' : '❌ לא פעיל'}</span>
        ${m.membership_end_date ? `<span><b>תוקף:</b> ${esc(m.membership_end_date.slice(0,10))}</span>` : ''}
        ${m.membership_start_date ? `<span><b>הצטרף:</b> ${esc(m.membership_start_date.slice(0,10))}</span>` : ''}
        ${m.birthday ? `<span><b>יום הולדת:</b> ${esc(m.birthday.slice(0,10))}</span>` : ''}
        <span><b>SMS:</b> ${m.allow_sms ? '✅' : '❌'} &nbsp; <b>דוא"ל:</b> ${m.allow_email ? '✅' : '❌'}</span>
      </div>` : '<div class="tw-empty">אין נתוני Arbox</div>';

    // Conversation thread (inbound messages)
    const threadHtml = inboxThreads.length
      ? inboxThreads.slice(-8).map(msg => {
          const isBot  = msg.route && msg.route !== 'human_owns_hold' && msg.barakReply;
          const dir    = 'rtl';
          return `<div class="conv-msg ${isBot ? 'conv-bot' : 'conv-user'}" dir="${dir}">
            <div class="conv-text">${esc(msg.text ?? '[media]')}</div>
            ${isBot && msg.barakReply ? `<div class="conv-reply">↳ ${esc(msg.barakReply.slice(0,120))}</div>` : ''}
            <div class="conv-ts">${fmtDate(msg.receivedAt ?? msg.timestamp)}</div>
          </div>`;
        }).join('')
      : '<div class="tw-empty">אין שיחה מוקלטת</div>';

    // Open tasks summary
    const openTaskCount = tasks.filter(t => t.status === 'open' || t.status === 'eden_assigned').length;

    body.innerHTML = `
      <div class="tw-drawer-status-bar">
        ${ownerBadge}
        ${openTaskCount ? `<span class="badge-crisis">📋 ${openTaskCount} משימות פתוחות</span>` : ''}
        ${lead.lastContactAt ? `<span class="tw-last-contact">פנייה אחרונה: ${fmtDate(lead.lastContactAt)}</span>` : ''}
      </div>

      <div class="tw-drawer-section">
        <div class="tw-ds-title">פרופיל Arbox</div>
        ${memberSection}
      </div>

      <div class="tw-drawer-section">
        <div class="tw-ds-title">שיחה אחרונה (${inboxThreads.length} הודעות)</div>
        <div class="conv-thread">${threadHtml}</div>
      </div>

      <div class="tw-drawer-section">
        <div class="tw-ds-title">משימות שירות (${tasks.length})</div>
        ${tasks.length ? tasks.map(t => `
          <div class="tw-ds-task-row">
            <span class="tw-task-type">${typeHe(t.type)}</span>
            <span class="${t.priority==='high'?'tw-pri-high':''}">${priorityHe(t.priority)}</span>
            <span><span class="badge-status-${t.status}">${statusHe(t.status)}</span></span>
            <span class="tw-ts">${fmtDate(t.createdAt)}</span>
            ${t.status !== 'resolved' ? `<button class="btn-xs" onclick="resolveTask('${esc(t.id)}');openMemberDrawer('${esc(phone)}','${esc(name)}')">פתור</button>` : ''}
          </div>
          ${t.memberMessage ? `<div class="tw-task-msg">"${esc(t.memberMessage.slice(0,100))}"</div>` : ''}
        `).join('') : '<div class="tw-empty">אין משימות</div>'}
      </div>

      <div class="tw-drawer-section">
        <div class="tw-ds-title">פעילות אחרונה (${audit.length})</div>
        ${audit.length ? audit.slice(0,8).map(e => `
          <div class="tw-ds-row-audit ${e.sendState==='failed'?'tw-row-failed':''}">
            <span class="tw-ts">${fmtDate(e.ts)}</span>
            <span class="tw-audit-event">${esc(e.event ?? '—')}</span>
            <span>${esc((e.requestPreview??'').slice(0,50))}</span>
            ${e.sendState && e.sendState !== 'sent' ? `<span class="badge-crisis">${esc(e.sendState)}</span>` : ''}
          </div>`).join('') : '<div class="tw-empty">אין פעילות</div>'}
      </div>

      <div class="tw-drawer-section">
        <div class="tw-ds-title">פעולות</div>
        <div class="tw-drawer-actions">
          ${lead.status === 'human_owns'
            ? `<button class="btn btn-primary" onclick="releaseBotOwnership('${esc(phone)}','${esc(name)}')">🤖 שחרר לבוט</button>`
            : `<button class="btn btn-secondary" onclick="takeHumanOwnership('${esc(phone)}','${esc(name)}')">👤 טול בעלות ידנית</button>`}
          <button class="btn btn-secondary" onclick="createManualTask('${esc(phone)}','${esc(name)}')">📋 צור משימה ידנית</button>
          <button class="btn btn-secondary" onclick="clearMemberHistory('${esc(phone)}')">🗑️ נקה היסטוריית AI</button>
        </div>
      </div>`;
  } catch (e) {
    body.innerHTML = `<div class="tw-empty">שגיאה: ${esc(e.message)}</div>`;
  }
};

window.clearMemberHistory = function(phone) {
  confirmModal('נקה היסטוריית שיחת תומר עם חבר/ה זה?\nהפעולה לא ניתנת לביטול.', async () => {
    try {
      await api(`/api/tomer/member/${encodeURIComponent(phone)}/history`, { method: 'DELETE' });
      toast('היסטוריה נוקתה ✓');
      closeDrawer();
    } catch (e) { toast('שגיאה: ' + e.message, false); }
  });
};

window.takeHumanOwnership = function(phone, name) {
  confirmModal(`קח בעלות ידנית על השיחה עם ${name || maskPhone(phone)}?\nהבוט יושתק עד לשחרור.`, async () => {
    try {
      await api(`/api/leads/${encodeURIComponent(phone)}/takeover`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'manual_panel', staffName: 'Eden' }),
      });
      toast('בעלות נלקחה — בוט מושתק ✓');
      openMemberDrawer(phone, name);
    } catch (e) { toast('שגיאה: ' + e.message, false); }
  });
};

window.releaseBotOwnership = function(phone, name) {
  confirmModal(`שחרר את ${name || maskPhone(phone)} לטיפול הבוט?\nהבקשה תיבדק מחדש.`, async () => {
    try {
      await api(`/api/leads/${encodeURIComponent(phone)}/release`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      });
      toast('שוחרר לבוט ✓');
      openMemberDrawer(phone, name);
    } catch (e) { toast('שגיאה: ' + e.message, false); }
  });
};

window.createManualTask = function(phone, name) {
  const typeOptions = [
    ['freeze_request','הקפאת מנוי'],['cancel_request','ביטול מנוי'],
    ['complaint','תלונה'],['billing_question','שאלת חיוב'],['other','כללי'],
  ].map(([v,l]) => `<option value="${v}">${l}</option>`).join('');
  const m = _buildModal(`משימה חדשה — ${name || maskPhone(phone)}`,
    `<select id="mt-type" class="field-input" style="width:100%;margin-bottom:8px">${typeOptions}</select>
     <textarea id="mt-detail" class="field-input" rows="3" placeholder="תיאור הבקשה..." style="width:100%;resize:vertical"></textarea>`,
    `<button class="btn btn-primary" id="mt-ok">צור משימה</button>
     <button class="btn btn-secondary" id="mt-cancel">ביטול</button>`);
  m.querySelector('#mt-cancel').onclick = () => m.remove();
  m.querySelector('#mt-ok').onclick = async () => {
    const type   = m.querySelector('#mt-type').value;
    const detail = m.querySelector('#mt-detail').value.trim();
    if (!detail) { toast('נדרש תיאור', false); return; }
    m.remove();
    try {
      await api('/api/tomer/tasks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, action: type, detail }),
      });
      toast('משימה נוצרה ✓');
      openMemberDrawer(phone, name);
      loadOverview();
    } catch (e) { toast('שגיאה: ' + e.message, false); }
  };
};

// ════════════════════════════════════════════════════════════════════════════
//  FLOATING CHAT
// ════════════════════════════════════════════════════════════════════════════

$id('tw-chat-toggle')?.addEventListener('click', () => {
  const p = $id('tw-chat-panel');
  if (p) p.style.display = p.style.display === 'none' ? '' : 'none';
});
$id('tw-chat-close')?.addEventListener('click', () => {
  const p = $id('tw-chat-panel');
  if (p) p.style.display = 'none';
});

// Delegate to existing initMiniChat helper (defined in app.js)
if (typeof initMiniChat === 'function') {
  initMiniChat('tomer-chat-input', 'tomer-send', 'tomer-chat-msgs', '/api/tomer/chat');
}

// ── Auto-load overview when Tomer tab is active ───────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  if (btn.dataset.tab === 'tomer') {
    btn.addEventListener('click', () => setTimeout(loadOverview, 50));
  }
});

// Initial load if Tomer tab is active on page load
if (document.querySelector('.tab-btn[data-tab="tomer"].active')) {
  loadOverview();
}
