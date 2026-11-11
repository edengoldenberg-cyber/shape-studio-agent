/* ════════════════════════════════════════════════════════════════════════════
   Tomer Workspace — member-service panel JS
   Tabs: Overview · Members · Eden Tasks · Automation · Audit
   RTL, Hebrew labels, real API calls, no fake data.
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

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
    renderMembers(_allMembers);
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
  renderMembers(filtered);
}

function renderMembers(members) {
  const tbody = $id('tw-members-tbody');
  if (!tbody) return;
  if (!members.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">אין תוצאות</td></tr>';
    return;
  }
  const statusHebrew = { active: '<span class="badge-active">פעיל</span>',
    expiring: '<span class="badge-warm">עומד לפוג</span>',
    expired:  '<span class="badge-crisis">פג</span>' };
  tbody.innerHTML = members.slice(0, 100).map(m => {
    const name    = `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim() || '—';
    const endDate = m.membership_end_date?.slice(0, 10) ?? '—';
    const badge   = statusHebrew[m._statusKey] ?? m._statusKey ?? '';
    return `<tr>
      <td>${esc(name)}</td>
      <td>${maskPhone(m.phone)}</td>
      <td>${badge}</td>
      <td>${esc(endDate)}</td>
      <td>—</td>
      <td>—</td>
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

window.resolveTask = async function(taskId) {
  const note = prompt('הערת סגירה (אופציונלי):') ?? '';
  try {
    await api(`/api/tomer/tasks/${encodeURIComponent(taskId)}/resolve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolutionNote: note, resolvedBy: 'Eden' }),
    });
    toast('משימה נסגרה ✓');
    loadTasks(); loadOverview();
  } catch (e) { toast('שגיאה: ' + e.message, false); }
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
    const data = await api(`/api/tomer/tasks?`);
    const task = data.tasks?.find(t => t.id === taskId);
    if (!task) return;
    alert(JSON.stringify(task, null, 2).slice(0, 800));
  } catch { /* ignore */ }
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
    if (!eligible.length) {
      toast('אין חברים זכאים כרגע');
      return;
    }
    const names = eligible.map(m => m.name || `***${m.phone}`).slice(0, 10).join('\n');
    alert(`${data.workflow}: ${eligible.length} חברים זכאים:\n${names}`);
  } catch (e) { toast('שגיאה: ' + e.message, false); }
};

window.runWorkflowNow = async function(wfId) {
  if (!confirm(`הרץ "${wfId}" עכשיו? (ישלח הודעות WhatsApp לחברים זכאים)`)) return;
  try {
    const data = await api(`/api/tomer/retention/run/${encodeURIComponent(wfId)}`, { method: 'POST' });
    toast(`הושלם: נשלחו ${data.sent ?? 0}, דולגו ${data.skipped ?? 0}`);
  } catch (e) { toast('שגיאה: ' + e.message, false); }
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
    const tasks = data.tasks ?? [];
    const audit = data.audit ?? [];

    body.innerHTML = `
      <div class="tw-drawer-section">
        <div class="tw-ds-title">פרופיל Arbox</div>
        ${m ? `
          <div class="tw-ds-row"><b>שם:</b> ${esc(`${m.first_name??''} ${m.last_name??''}`.trim())}</div>
          <div class="tw-ds-row"><b>סטטוס:</b> ${m.active ? '✅ פעיל' : '❌ לא פעיל'}</div>
          ${m.membership_end_date ? `<div class="tw-ds-row"><b>תוקף:</b> ${esc(m.membership_end_date.slice(0,10))}</div>` : ''}
          ${m.membership_start_date ? `<div class="tw-ds-row"><b>הצטרף:</b> ${esc(m.membership_start_date.slice(0,10))}</div>` : ''}
          ${m.birthday ? `<div class="tw-ds-row"><b>יום הולדת:</b> ${esc(m.birthday.slice(0,10))}</div>` : ''}
          <div class="tw-ds-row"><b>SMS:</b> ${m.allow_sms ? 'מורשה' : 'לא מורשה'} &nbsp; <b>דוא"ל:</b> ${m.allow_email ? 'מורשה' : 'לא מורשה'}</div>
        ` : '<div class="tw-empty">אין נתוני Arbox</div>'}
      </div>

      <div class="tw-drawer-section">
        <div class="tw-ds-title">משימות שירות (${tasks.length})</div>
        ${tasks.length ? tasks.map(t => `
          <div class="tw-ds-row">
            <span>${typeHe(t.type)}</span>
            <span class="${t.priority==='high'?'tw-pri-high':''}">${priorityHe(t.priority)}</span>
            <span>${statusHe(t.status)}</span>
            <span>${fmtDate(t.createdAt)}</span>
          </div>`).join('') : '<div class="tw-empty">אין משימות</div>'}
      </div>

      <div class="tw-drawer-section">
        <div class="tw-ds-title">פעילות אחרונה</div>
        ${audit.length ? audit.slice(0,6).map(e => `
          <div class="tw-ds-row">
            <span class="tw-audit-event">${esc(e.event)}</span>
            <span>${esc((e.requestPreview??'').slice(0,40))}</span>
            <span>${fmtDate(e.ts)}</span>
          </div>`).join('') : '<div class="tw-empty">אין פעילות</div>'}
      </div>

      <div class="tw-drawer-section">
        <div class="tw-ds-title">פעולות</div>
        <div class="tw-drawer-actions">
          <button class="btn btn-secondary" onclick="clearMemberHistory('${esc(phone)}')">🗑️ נקה היסטוריית שיחה</button>
        </div>
      </div>`;
  } catch (e) {
    body.innerHTML = `<div class="tw-empty">שגיאה: ${esc(e.message)}</div>`;
  }
};

window.clearMemberHistory = async function(phone) {
  if (!confirm('נקה היסטוריית שיחת תומר עם חבר/ה זה?')) return;
  try {
    await api(`/api/tomer/member/${encodeURIComponent(phone)}/history`, { method: 'DELETE' });
    toast('היסטוריה נוקתה ✓');
    closeDrawer();
  } catch (e) { toast('שגיאה: ' + e.message, false); }
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
