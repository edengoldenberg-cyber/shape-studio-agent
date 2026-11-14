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
            if (activePane === 'today' || activePane === 'overview') loadToday();
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
    if (pane === 'today' || pane === 'overview') loadToday();
    if (pane === 'conversations') loadConversations();
    if (pane === 'upcoming')   loadUpcoming();
    if (pane === 'members')    {} // load on demand
    if (pane === 'tasks')      loadTasks();
    if (pane === 'automation') loadAutomation();
    if (pane === 'audit')      loadAudit();
  });
});

// ── Global refresh ────────────────────────────────────────────────────────────
$id('tw-refresh')?.addEventListener('click', () => {
  const active = document.querySelector('.tw-tab.active')?.dataset.pane ?? 'today';
  if (active === 'today' || active === 'overview') loadToday();
  else if (active === 'conversations') loadConversations();
  else if (active === 'upcoming')   loadUpcoming();
  else if (active === 'members')    loadMembers();
  else if (active === 'tasks')      loadTasks();
  else if (active === 'automation') loadAutomation();
  else if (active === 'audit')      loadAudit();
});

// ════════════════════════════════════════════════════════════════════════════
//  TODAY'S WORK
// ════════════════════════════════════════════════════════════════════════════

// loadOverview is kept as an alias so existing code doesn't break
async function loadOverview() { return loadToday(); }

async function loadToday() {
  const listEl = $id('tw-action-list');
  if (listEl) listEl.innerHTML = '<div class="tw-empty">טוען...</div>';

  try {
    const [todayData, overviewData] = await Promise.all([
      api('/api/tomer/today'),
      api('/api/tomer/overview').catch(() => ({ ok: false })),
    ]);

    // ── KPIs — service cases. A number that could not be read is shown as "—", never 0.
    if (!todayData || todayData.ok !== true || !todayData.cases) {
      ['twk-high', 'twk-await', 'twk-open', 'twk-member', 'twk-failed'].forEach(id => setTxt(id, '—'));
      setTxt('twk-arbox', '—');
      if (listEl) listEl.innerHTML = '<div class="tw-state-error" data-state="error" role="alert">לא ניתן לטעון את נתוני היום' + (todayData?.error ? ' (' + esc(todayData.error) + ')' : '') + '. לחצו 🔄 לניסיון נוסף.</div>';
      return;
    }
    const c  = todayData.counts ?? {};
    const cc = todayData.cases;
    setTxt('twk-high',   cc.high);
    setTxt('twk-await',  cc.awaiting_staff);
    setTxt('twk-open',   cc.in_progress);
    setTxt('twk-member', cc.awaiting_member);
    setTxt('twk-failed', cc.notifFailed + cc.notifUncertain + cc.notifPending);
    setTxt('twk-arbox',  overviewData && overviewData.ok === true ? (overviewData.arboxHealth ? '✅ זמין' : '⚠️ לא זמין') : '—');

    // Badges: Today = cases that need staff now; Cases = all open; Tasks = legacy task queue
    const badgeToday = $id('tw-badge-today');
    const total = cc.awaiting_staff + cc.unread;
    if (badgeToday) badgeToday.textContent = total > 0 ? String(total) : '';
    const badgeCases = $id('tw-badge-cases');
    if (badgeCases) badgeCases.textContent = cc.open > 0 ? String(cc.open) : '';
    const badgeTasks = $id('tw-badge-tasks');
    if (badgeTasks) badgeTasks.textContent = c.openTasks > 0 ? String(c.openTasks) : '';

    // ── Unified action list ────────────────────────────────────────────────────
    const items = [];

    // 0. Service cases that need attention: urgent, new member message, alert not confirmed
    (todayData.urgentCases ?? []).forEach(k => items.push({
      urgency: k.priority === 'high' ? 12 : 9,
      icon: k.priority === 'high' ? '🔴' : (k.unreadMember ? '💬' : '⚠️'),
      title: 'פנייה' + (k.unreadMember ? ' — הודעה חדשה מהחבר/ה' : '') + (['failed', 'uncertain', 'pending'].includes(k.notification?.state) ? ' — ההתראה למנהל לא אושרה' : ''),
      who: k.memberName ?? 'חבר/ה',
      detail: (k.summary ?? '').slice(0, 80),
      time: k.updatedAt,
      type: 'service_case',
      actions: `<button class="btn-xs" onclick="openTomerCase('${esc(k.id)}')">פתח פנייה</button>`,
    }));

    // 1. High-priority Eden tasks
    (todayData.openTasks ?? [])
      .filter(t => t.priority === 'high')
      .forEach(t => items.push({
        urgency: 10,
        icon: '🔴',
        title: typeHe(t.type),
        who: t.memberName ?? maskPhone(t.phone ?? ''),
        detail: (t.summary ?? t.detail ?? '').slice(0, 80),
        time: t.createdAt,
        type: 'eden_task',
        id: t.id,
        actions: `<button class="btn-xs" onclick="resolveTask('${esc(t.id)}')">פתור</button>
                  <button class="btn-xs btn-xs-sec" onclick="viewTaskDetail('${esc(t.id)}')">פרטים</button>`,
      }));

    // 2. Awaiting reply (aging conversations)
    (todayData.awaitingReply ?? [])
      .forEach(c => items.push({
        urgency: c.ageMin > 240 ? 8 : 5,
        icon: '💬',
        title: `ממתין/ה למענה — ${c.ageMin} דקות`,
        who: c.name ?? c.phone,
        detail: (c.lastText ?? '').slice(0, 80),
        time: c.receivedAt,
        type: 'awaiting_reply',
        phone: c.phone,
        owner: c.owner,
        actions: c.owner === 'human'
          ? `<span class="badge-status-eden_assigned">👤 בטיפול ידני</span>`
          : c.owner === 'attribution_review'
            ? `<span class="badge-warm" style="margin-left:4px">⚠️ ייחוס בבדיקה</span>
               <button class="btn-xs" onclick="takeHumanOwnership('${esc(c.phone)}','${esc(c.name??'')}')">אשר ידני</button>`
            : `<button class="btn-xs" onclick="takeHumanOwnership('${esc(c.phone)}','${esc(c.name??'')}')">👤 קח בעלות</button>`,
      }));

    // 3. Normal-priority Eden tasks
    (todayData.openTasks ?? [])
      .filter(t => t.priority !== 'high')
      .forEach(t => items.push({
        urgency: 3,
        icon: '📋',
        title: typeHe(t.type),
        who: t.memberName ?? maskPhone(t.phone ?? ''),
        detail: (t.summary ?? '').slice(0, 80),
        time: t.createdAt,
        type: 'eden_task',
        id: t.id,
        actions: `<button class="btn-xs" onclick="resolveTask('${esc(t.id)}')">פתור</button>
                  <button class="btn-xs btn-xs-sec" onclick="viewTaskDetail('${esc(t.id)}')">פרטים</button>`,
      }));

    // 4. Failed sends
    (todayData.failedSends ?? [])
      .forEach(f => items.push({
        urgency: 4,
        icon: '⚠️',
        title: 'שליחה נכשלה',
        who: f.memberName ?? maskPhone(f.phone ?? ''),
        detail: (f.tomerAction ?? f.requestPreview ?? '').slice(0, 80),
        time: f.ts,
        type: 'failed_send',
        actions: '',
      }));

    // Sort by urgency desc, then time asc
    items.sort((a, b) => b.urgency - a.urgency || new Date(a.time) - new Date(b.time));

    if (!items.length) {
      if (listEl) listEl.innerHTML = '<div class="tw-empty tw-all-clear">✅ אין פעולות נדרשות כרגע — הכל תקין</div>';
    } else if (listEl) {
      listEl.innerHTML = items.map(item => `
        <div class="tw-action-item tw-action-${item.type}">
          <span class="tw-action-icon">${item.icon}</span>
          <div class="tw-action-body">
            <div class="tw-action-title">${esc(item.title)}</div>
            <div class="tw-action-who">${esc(item.who)}</div>
            ${item.detail ? `<div class="tw-action-detail">${esc(item.detail)}</div>` : ''}
          </div>
          <div class="tw-action-meta">
            <div class="tw-ts">${fmtDate(item.time)}</div>
            <div class="tw-action-btns">${item.actions}</div>
          </div>
        </div>`).join('');
    }

    // ── Upcoming mini-view ─────────────────────────────────────────────────────
    const upMini = $id('tw-upcoming-mini');
    const nextRun = $id('tw-next-run');
    const workflows = todayData.upcomingWorkflows ?? [];
    if (nextRun && workflows.length > 0) nextRun.textContent = workflows[0]?.nextRun ?? '—';
    else if (nextRun) nextRun.textContent = '—';

    if (upMini) {
      if (!workflows.length) {
        upMini.innerHTML = '<div class="tw-empty">כל הווקפלואים מושבתים</div>';
      } else {
        upMini.innerHTML = workflows.map(wf => {
          const count = wf.eligibleCount;
          const countLabel = count === null ? '(טוען...)' : count === 0 ? 'אין זכאים' : `${count} חבר/ה`;
          const dot = count > 0 ? 'dot-active' : 'dot-idle';
          return `<div class="tw-upcoming-mini-row">
            <span class="tw-dot ${dot}"></span>
            <span class="tw-wf-label">${esc(wf.workflow ?? wf.id)}</span>
            <span class="tw-ts">${esc(countLabel)}</span>
            <span class="tw-ts">${esc(wf.nextRun ?? '—')}</span>
          </div>`;
        }).join('');
      }
    }

    // ── Unclassified ───────────────────────────────────────────────────────────
    _loadAndRenderUnclassified();

    // Update refresh timestamp
    const lastEl = $id('tw-last-refresh');
    if (lastEl) lastEl.textContent = `עודכן: ${new Date().toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })}`;

  } catch (e) {
    console.error('loadToday', e);
    if (listEl) listEl.innerHTML = `<div class="tw-empty">שגיאה: ${esc(e.message)}</div>`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  UPCOMING MESSAGES
// ════════════════════════════════════════════════════════════════════════════

async function loadUpcoming() {
  const el = $id('tw-upcoming-workflows');
  if (!el) return;
  el.innerHTML = '<div class="tw-empty">טוען...</div>';
  try {
    const [data, mqData] = await Promise.all([
      api('/api/tomer/upcoming'),
      api('/api/tomer/message-queue?limit=20').catch(() => ({ entries: [] })),
    ]);
    const workflows = data.workflows ?? [];
    const mqEntries = mqData.entries ?? [];

    // ── Message queue section ────────────────────────────────────────────────
    let mqHtml = '';
    if (mqEntries.length) {
      const statusBadge = s =>
        s === 'queued'            ? '<span class="badge-warm">⏳ ממתין</span>'
        : s === 'provider_accepted' ? '<span class="badge-active">✅ ספק אישר</span>'
        : s === 'failed'            ? '<span class="badge-crisis">❌ נכשל</span>'
        : `<span>${esc(s)}</span>`;
      const rows = mqEntries.map(e => `
        <tr>
          <td style="white-space:nowrap">${fmtDate(e.queuedAt)}</td>
          <td>${esc(e.memberName ?? '—')}</td>
          <td>${esc(e.workflowId ?? '—')}</td>
          <td title="${esc(e.message)}">${esc((e.message ?? '').slice(0, 60))}</td>
          <td>${statusBadge(e.status)}</td>
        </tr>`).join('');
      mqHtml = `
        <div class="tw-card" style="margin-bottom:16px">
          <div class="tw-card-title">📬 תור הודעות — 20 אחרונות</div>
          <div class="table-wrapper">
            <table class="leads-table">
              <thead><tr><th>זמן</th><th>חבר/ה</th><th>ווקפלו</th><th>הודעה</th><th>סטטוס</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>
        </div>`;
    }

    const LABELS = {
      birthday:    '🎂 ברכת יום הולדת',
      onboarding1: '🌱 צ׳ק-אין שבוע 1',
      onboarding2: '🌱 צ׳ק-אין שבוע 2',
      attendance:  '🏋️ היעדרות',
      feedback:    '💬 פידבק חבר/ה',
    };

    const workflowsHtml = workflows.map(wf => {
      const label = LABELS[wf.id] ?? wf.id;
      const stateTag = {
        disabled:      `<span class="badge-status-cancelled">⏸ מושבת</span>`,
        eligible:      `<span class="badge-active">✅ ${wf.totalEligible} זכאים</span>`,
        no_eligible:   `<span class="tw-muted">אין זכאים לריצה הבאה</span>`,
        preview_error: `<span class="badge-crisis">שגיאה בתצוגה מקדימה</span>`,
      }[wf.state] ?? `<span>${esc(wf.state)}</span>`;

      const eligibleList = wf.eligible?.length
        ? `<div class="tw-upcoming-eligible">
             <b>זכאים:</b> ${wf.eligible.map(m => esc(m.name || m.phone)).join(' · ')}
             ${wf.totalEligible > wf.eligible.length ? ` + עוד ${wf.totalEligible - wf.eligible.length}` : ''}
           </div>`
        : '';

      const msgPreview = wf.messageTemplate
        ? `<div class="wf-preview-msg" title="תבנית הודעה — לא נשלח עד הרצה">${esc(wf.messageTemplate)}</div>`
        : '';

      const emptyReason = wf.state === 'disabled'
        ? '<p class="tw-wf-empty-reason">הפעל בלשונית "אוטומציה" אחרי בדיקת קהל, טקסט ושעות שקטות.</p>'
        : wf.state === 'no_eligible'
          ? '<p class="tw-wf-empty-reason">אין חברים העומדים בקריטריון ביום זה.</p>'
          : '';

      return `
        <div class="tw-upcoming-card ${wf.state === 'disabled' ? 'tw-upcoming-disabled' : ''}">
          <div class="tw-upcoming-header">
            <span class="tw-wf-label">${esc(label)}</span>
            ${stateTag}
          </div>
          ${wf.state !== 'disabled' ? `<div class="tw-upcoming-next">ריצה הבאה: <b>${esc(wf.nextRun ?? '—')}</b></div>` : ''}
          ${msgPreview}
          ${eligibleList}
          ${emptyReason}
          <div class="tw-wf-actions">
            ${wf.state !== 'disabled'
              ? `<button class="btn-xs" onclick="previewWorkflow('${esc(wf.id)}')">👁️ תצוגה מקדימה</button>
                 <button class="btn-xs btn-xs-sec" onclick="runWorkflowNow('${esc(wf.id)}')">▶ הרץ עכשיו</button>`
              : `<button class="btn-xs btn-xs-sec" onclick="document.querySelector('[data-pane=automation]').click()">הגדר בלשונית אוטומציה →</button>`}
          </div>
        </div>`;
    }).join('') || '<div class="tw-empty">אין ווקפלואים מוגדרים</div>';

    el.innerHTML = mqHtml + workflowsHtml;

  } catch (e) {
    el.innerHTML = `<div class="tw-empty">שגיאה: ${esc(e.message)}</div>`;
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  CONVERSATIONS TAB
// ════════════════════════════════════════════════════════════════════════════

async function loadConversations() {
  const el = $id('tw-conv-list');
  if (!el) return;
  el.innerHTML = '<div class="tw-empty">טוען...</div>';
  try {
    const data  = await api('/api/tomer/conversations');
    const convs = data.conversations ?? [];
    // Update badge
    const badge = $id('tw-badge-conv');
    const unresolved = convs.filter(c => c.owner !== 'opted_out').length;
    if (badge) badge.textContent = unresolved > 0 ? String(unresolved) : '';

    if (!convs.length) {
      el.innerHTML = '<div class="tw-empty tw-all-clear">✅ אין שיחות ממתינות</div>';
      return;
    }
    el.innerHTML = convs.map(c => {
      const escalateTag = c.escalate ? '<span class="badge-crisis" style="margin-left:4px">⚠️ 2h+</span>' : '';
      const ownerTag = c.owner === 'human'              ? '<span class="badge-crisis">👤 ידני</span>'
        : c.owner === 'attribution_review'              ? '<span class="badge-warm">⚠️ ייחוס</span>'
        : c.owner === 'opted_out'                       ? '<span class="badge-status-cancelled">🔇</span>'
        : '';
      const caseBtn = c.caseId ? `<button class="btn-xs" onclick="openTomerCase('${esc(c.caseId)}')">פתח פנייה</button>` : '';
      const threadHtml = (c.messages ?? []).map(m =>
        `<div class="conv-msg ${m.direction === 'out' ? 'conv-bot' : 'conv-user'}" dir="rtl">
           <div class="conv-text">${esc(m.text)}</div>
           <div class="conv-ts">${fmtDate(m.timestamp)}</div>
         </div>`
      ).join('');
      // Note: c.phone is already masked from the server. For ownership actions we need the real phone.
      // The takeHumanOwnership/releaseBotOwnership functions accept a masked phone here because
      // the conversations endpoint returns masked phones — this is a display-only tab.
      return `<div class="tw-conv-card">
        <div class="tw-conv-header">
          <span class="tw-conv-name">${esc(c.name ?? c.phone)}</span>
          ${escalateTag} ${ownerTag} ${caseBtn}
          <span class="tw-ts" style="margin-right:auto">${esc(c.ageMin)} דקות</span>
        </div>
        <div class="tw-conv-last">${esc((c.lastText ?? '').slice(0, 100))}</div>
        <div class="conv-thread tw-conv-thread">${threadHtml}</div>
      </div>`;
    }).join('');
  } catch (e) {
    el.innerHTML = `<div class="tw-empty">שגיאה: ${esc(e.message)}</div>`;
  }
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
    // Use the enriched endpoint which does the phone join server-side.
    // /api/tomer/members-enriched returns ownership + open task count per member,
    // with phones already masked — no client-side join needed.
    const data = await api('/api/tomer/members-enriched');
    _allMembers = data.members ?? [];
    renderMembersEnriched(_allMembers);
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

function filterMembers() {
  const q   = ($id('tw-member-search')?.value ?? '').trim().toLowerCase();
  const st  = $id('tw-member-status')?.value ?? '';
  const filtered = _allMembers.filter(m => {
    const name  = (m.name ?? '').toLowerCase();
    const phone = String(m.phone ?? '').toLowerCase();
    const matchQ = !q || name.includes(q) || phone.includes(q);
    const matchS = !st || m.statusKey === st;
    return matchQ && matchS;
  });
  renderMembersEnriched(filtered);
}

function renderMembersEnriched(members) {
  const tbody = $id('tw-members-tbody');
  if (!tbody) return;
  if (!members.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">אין תוצאות</td></tr>';
    return;
  }
  const statusHebrew = {
    active:   '<span class="badge-active">פעיל</span>',
    expiring: '<span class="badge-warm">עומד לפוג</span>',
    expired:  '<span class="badge-crisis">פג</span>',
  };
  tbody.innerHTML = members.slice(0, 100).map(m => {
    const name    = m.name ?? '—';
    const endDate = m.memberEnd ?? '—';
    const badge   = statusHebrew[m.statusKey] ?? '';
    const ownerHtml = m.owner === 'human'
      ? '<span class="badge-crisis">👤 ידני</span>'
      : m.owner === 'attribution_review'
        ? '<span class="badge-warm" title="ייחוס בבדיקה — לחץ לנהוג ידנית">⚠️ בחינה</span>'
        : m.owner === 'opted_out'
          ? '<span class="badge-status-cancelled">🔇</span>'
          : m.leadStatus
            ? '<span class="badge-active">🤖</span>'
            : '<span class="tw-muted">—</span>';
    const openTaskHtml = (m.openTasks ?? 0) > 0
      ? `<span class="badge-crisis">${m.openTasks}</span>`
      : '<span class="tw-muted">—</span>';
    // phone is already masked from the server; arboxId used as drawer key
    const drawerKey = String(m.arboxId ?? '');
    return `<tr>
      <td>${esc(name)}</td>
      <td>${esc(m.phone ?? '—')}</td>
      <td>${badge}</td>
      <td>${esc(endDate)}</td>
      <td>${ownerHtml}</td>
      <td>${openTaskHtml}</td>
      <td><button class="btn-xs" onclick="openMemberByArboxId('${esc(drawerKey)}','${esc(name)}')">פרופיל</button></td>
    </tr>`;
  }).join('');
}

// openMemberByArboxId — opens the member drawer using the stable Arbox member ID.
// Calls /api/tomer/member/id/:arboxId which resolves the real phone server-side,
// then delegates to openMemberDrawer with the resolved phone for all action buttons.
window.openMemberByArboxId = async function(arboxId, name) {
  const drawer = $id('tw-drawer');
  const body   = $id('tw-drawer-body');
  const title  = $id('tw-drawer-name');
  if (!drawer || !body) return;
  if (title) title.textContent = name || arboxId;
  body.innerHTML = '<div class="tw-spin">טוען...</div>';
  drawer.style.display = '';
  try {
    const data = await api(`/api/tomer/member/id/${encodeURIComponent(arboxId)}`);
    if (!data.ok) throw new Error(data.error ?? 'member not found');
    const resolvedPhone = data.phone ?? arboxId;
    // openMemberDrawer re-fetches via /api/tomer/member/:phone with the real phone
    closeDrawer();
    openMemberDrawer(resolvedPhone, name);
  } catch (e) {
    body.innerHTML = `<div class="tw-empty">שגיאה: ${esc(e.message)}</div>`;
  }
};

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
    const [data, histData] = await Promise.all([
      api('/api/tomer/retention/config'),
      api('/api/tomer/retention/history').catch(() => ({ summary: {} })),
    ]);
    const cfg     = data.config ?? {};
    const history = histData.summary ?? {};

    const labels = {
      birthday:    '🎂 ברכת יום הולדת',
      onboarding1: '🌱 צ׳ק-אין שבוע 1',
      onboarding2: '🌱 צ׳ק-אין שבוע 2',
      attendance:  '🏋️ היעדרות ממושכת',
      feedback:    '💬 פידבק חבר/ה',
    };
    const descs = {
      birthday:    'ברכה ביום ההולדת לפי תאריך Arbox',
      onboarding1: 'הודעה 7 ימים אחרי membership_start_date',
      onboarding2: 'הודעה 14 ימים אחרי membership_start_date',
      attendance:  'פנייה אחרי 14+ ימים ללא נוכחות מקומית',
      feedback:    'הודעה 30 ימים אחרי membership_start_date — בקשת פידבק',
    };

    el.innerHTML = Object.entries(cfg).map(([id, wf]) => {
      const h = history[id] ?? {};
      const histHtml = h.lastRun
        ? `<div class="tw-wf-hist">הרצה אחרונה: ${fmtDate(h.lastRun)} · ${h.count} שליחות מאז הפעלה</div>`
        : `<div class="tw-wf-hist tw-muted">טרם הורץ</div>`;
      return `
      <div class="tw-workflow-card">
        <div class="tw-wf-header">
          <span class="tw-wf-label">${esc(labels[id] ?? id)}</span>
          <label class="tw-toggle">
            <input type="checkbox" class="tw-wf-toggle" data-wf="${esc(id)}" ${wf.enabled ? 'checked' : ''}/>
            <span class="tw-toggle-track"></span>
          </label>
        </div>
        <div class="tw-wf-desc">${esc(descs[id] ?? '')}</div>
        <div class="tw-wf-status ${wf.enabled ? 'tw-wf-on' : 'tw-wf-off'}">${wf.enabled ? '✅ פעיל' : '⏸ מושבת'}</div>
        ${histHtml}
        <div class="tw-wf-actions">
          <button class="btn-xs" onclick="previewWorkflow('${esc(id)}')">👁️ תצוגה מקדימה</button>
          <button class="btn-xs btn-xs-sec" onclick="runWorkflowNow('${esc(id)}')">▶ הרץ עכשיו</button>
        </div>
      </div>`;
    }).join('');

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
    tbody.innerHTML = entries.map(e => {
      const sendStateHtml = !e.sendState ? '—'
        : e.sendState === 'failed'            ? '<span class="badge-crisis">❌ נכשל</span>'
        : e.sendState === 'provider_accepted' ? '<span class="badge-active">✅ ספק אישר</span>'
        : e.sendState === 'sent'              ? '<span class="badge-active">✅ ספק אישר</span>'
        : e.sendState === 'skipped_stale'     ? '<span class="tw-muted">⏭ דולג</span>'
        : `<span>${esc(e.sendState)}</span>`;
      return `
      <tr class="${e.sendState === 'failed' ? 'tw-row-failed' : ''}">
        <td style="white-space:nowrap">${fmtDate(e.ts)}</td>
        <td>${esc(e.memberName ?? maskPhone(e.phone))}</td>
        <td><span class="tw-event-${e.event?.split('_')[0]}">${esc(e.event ?? '—')}</span></td>
        <td title="${esc(e.requestPreview)}">${esc((e.requestPreview ?? '').slice(0, 40))}</td>
        <td title="${esc(e.tomerAction)}">${esc((e.tomerAction ?? '').slice(0, 40))}</td>
        <td title="${esc(e.replyPreview)}">${esc((e.replyPreview ?? '').slice(0, 40))}</td>
        <td>${sendStateHtml}</td>
      </tr>`;
    }).join('');
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
    const arboxClasses = data.arboxClasses ?? [];

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
        <div class="tw-ds-title">לוח שיעורים — הסטודיו (5 ימים הבאים)</div>
        ${arboxClasses.length
          ? arboxClasses.map(c => {
              const d = new Date(c.date + 'T' + (c.start_time ?? '00:00'));
              const dayName = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'][d.getDay()] ?? c.date;
              return `<div class="tw-sched-row">
                <span class="tw-sched-day">${esc(dayName)}</span>
                <span class="tw-sched-time">${esc(c.start_time ?? '—')}</span>
                <span class="tw-sched-name">${esc(c.session_name ?? 'שיעור')}</span>
                <span class="tw-sched-staff">${esc(c.staff_member?.name ?? '—')}</span>
                ${c.registration_link ? `<a href="${esc(c.registration_link)}" target="_blank" class="btn-xs">הרשמה</a>` : '<span class="tw-muted">ללא לינק</span>'}
              </div>`;
            }).join('')
          : '<div class="tw-empty">לוח שיעורים לא זמין</div>'}
        <div class="tw-arbox-limits" style="font-size:11px;color:var(--muted);margin-top:8px;line-height:1.5">
          <b>מה לא זמין ב-API:</b> הקפאת מנוי, ביטול, רישום לשיעור ספציפי, היסטוריית נוכחות אישית.
          לפעולות אלו: יש לבצע ב<a href="https://app.arboxapp.com" target="_blank" style="color:var(--accent)">ממשק Arbox</a> או ליצור משימה לעדן.
        </div>
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

// ── Auto-load Today's Work when Tomer tab is active ──────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  if (btn.dataset.tab === 'tomer') {
    btn.addEventListener('click', () => setTimeout(loadToday, 50));
  }
});

// Initial load if Tomer tab is active on page load
if (document.querySelector('.tab-btn[data-tab="tomer"].active')) {
  loadToday();
}

// ════════════════════════════════════════════════════════════════════════════
//  SERVICE CASES (פניות) — list with counters + one complete case view
//
//  Three things are always shown apart:
//    • what the MEMBER asked / did          (conversation, request)
//    • what STAFF reported                  (resolution: outcome + note)
//    • what ARBOX shows, read by the system (Arbox data + read-only check)
//  The panel has no button that changes anything in Arbox.
// ════════════════════════════════════════════════════════════════════════════
const CASE_STATUS_HE = { awaiting_staff: 'פתוח — ממתין לצוות', in_progress: 'בטיפול', awaiting_member: 'ממתין לחבר/ה', resolved: 'נסגר', rejected: 'נסגר (נדחה)', cancelled: 'נסגר (בוטל)' };
const CASE_OPEN = ['awaiting_staff', 'in_progress', 'awaiting_member'];
const NOTIF_HE = {
  pending:   'התראה למנהל: טרם נשלחה',
  accepted:  'התראה למנהל: התקבלה אצל ספק הוואטסאפ',
  failed:    'התראה למנהל: נכשלה — לא נשלחה',
  uncertain: 'התראה למנהל: לא ודאי אם נשלחה',
  not_required: 'התראה למנהל: לא נדרשת',
};
const WHO_HE = { member: 'חבר/ה', tomer: 'תומר (אוטומטי)', staff: 'צוות', bot: 'בוט', system: 'מערכת', unknown: 'נשלח מהמספר של הסטודיו (מקור לא מזוהה)' };
const OWNER_CONV_HE = { human: '👤 הצוות עונה — תומר מושתק', tomer: '🤖 תומר עונה אוטומטית', opted_out: '🔇 ביקש/ה לא לקבל הודעות', attribution_review: '⚠️ ייחוס הודעה בבדיקה — תומר מושתק' };
const EVENT_HE = {
  opened: 'הפנייה נפתחה', member_followup: 'הודעה נוספת מהחבר/ה', request_details_added: 'נוספו פרטים לבקשה',
  staff_notified: 'התראה למנהל התקבלה אצל הספק', staff_notification_failed: 'התראה למנהל נכשלה', staff_notification_uncertain: 'התראה למנהל — תוצאה לא ודאית',
  assigned: 'שויכה', status_changed: 'סטטוס שונה', staff_reply: 'הצוות השיב לחבר/ה', staff_reply_failed: 'תשובת צוות לא נשלחה', staff_reply_uncertain: 'תשובת צוות — לא ודאי אם נשלחה',
  human_takeover: 'הצוות לקח את השיחה', human_release: 'השיחה שוחררה לתומר', arbox_checked: 'נקרא מ-Arbox', resolved: 'נסגרה', reopened: 'נפתחה מחדש',
};
const CASE_ERR_HE = {
  not_found: 'הפנייה לא נמצאה', case_closed: 'הפנייה סגורה — יש לפתוח אותה מחדש', owner_required: 'יש לכתוב שם', bad_status: 'סטטוס לא חוקי',
  text_required: 'יש לכתוב הודעה', recipient_not_allowed: 'המספר הזה לא מורשה במצב הבדיקה — לא נשלח', member_opted_out: 'החבר/ה ביקש/ה לא לקבל הודעות — לא נשלח', send_failed: 'ההודעה לא נשלחה',
  send_uncertain: 'לא ברור אם ההודעה נשלחה — בדקו בוואטסאפ לפני שליחה חוזרת', note_required: 'יש לכתוב הערת סיכום', outcome_required: 'יש לבחור מה נעשה',
  not_required: 'לפנייה הזו לא נדרשת התראה', uncertain_needs_confirm: 'ייתכן שההתראה כבר הגיעה — נדרש אישור לשליחה חוזרת', notification_in_flight: 'התראה נשלחת כרגע',
  notify_failed: 'ההתראה למנהל נכשלה שוב', notify_uncertain: 'לא ודאי אם ההתראה נשלחה', operation_failed: 'הפעולה נכשלה בשרת', csrf_token_invalid: 'פג תוקף החיבור — רעננו את הדף',
  unauthorized: 'נדרשת כניסה מחדש', network: 'אין חיבור לשרת',
};
const MEMBERSHIP_CATS = ['membership_cancel', 'membership_freeze'];

let _caseFilter = 'open';           // open | awaiting_staff | in_progress | awaiting_member | resolved
let _caseLabels = {}, _caseOutcomes = {};
let _openCaseId = null;
const staffName = () => { try { return (localStorage.getItem('tw_staff_name') || '').trim(); } catch { return ''; } };
const dmyHe = iso => String(iso || '').split('-').reverse().join('.');

/** fetch → { status, ok, ...json }. Network failures and non-JSON answers become errors, never empty data. */
async function caseApi(url, { method = 'GET', body } = {}) {
  let r;
  try { r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined }); }
  catch { return { status: 0, ok: false, error: 'network' }; }
  let j = null;
  try { j = await r.json(); } catch { /* not json */ }
  if (!j) return { status: r.status, ok: false, error: r.status === 401 ? 'unauthorized' : 'operation_failed' };
  return { ...j, status: r.status, ok: r.ok && j.ok !== false };
}
const caseErr = r => CASE_ERR_HE[r.error] || 'הפעולה נכשלה';

function notifChip(n) {
  if (!n || n.state === 'not_required' || n.state === 'accepted') return '';
  const cls = n.state === 'failed' ? 'tw-chip-bad' : 'tw-chip-warn';
  return '<span class="tw-chip ' + cls + '" data-notif="' + esc(n.state) + '">' + esc({ failed: 'התראה נכשלה', uncertain: 'התראה לא ודאית', pending: 'התראה טרם נשלחה' }[n.state] || n.state) + '</span>';
}

function renderCaseCard(c) {
  const open = CASE_OPEN.includes(c.status);
  const last = [...(c.context || [])].reverse().find(x => x.from === 'member');
  const owner = !c.owner || c.owner === 'tomer' ? 'לא שויכה' : c.owner;
  return '<button type="button" class="tw-case-card" data-case="' + esc(c.id) + '" data-status="' + esc(c.status) + '">'
    + '<span class="tw-case-head">'
    + (c.priority === 'high' && open ? '<span class="tw-chip tw-chip-bad">דחוף</span>' : '')
    + '<strong>' + esc(_caseLabels[c.category] || c.category) + '</strong><span>· ' + esc(c.memberName || 'חבר/ה') + '</span>'
    + (c.unreadMember && open ? '<span class="tw-chip tw-chip-info" data-unread="1">הודעה חדשה מהחבר/ה</span>' : '')
    + notifChip(c.notification)
    + '<span class="tw-case-status" data-status-chip="' + esc(c.status) + '">' + esc(CASE_STATUS_HE[c.status] || c.status) + '</span></span>'
    + (last ? '<span class="tw-case-text">"' + esc(String(last.text).slice(0, 160)) + '"</span>' : '')
    + '<span class="tw-case-meta">אחראי/ת: ' + esc(owner) + ' · עודכן ' + esc(fmtDate(c.updatedAt))
    + (open ? ' · ' + esc(c.conversationOwner === 'human' ? 'הצוות עונה' : c.conversationOwner === 'opted_out' ? 'ללא הודעות' : 'תומר עונה') : '')
    + (c.resolution ? ' · ' + esc(_caseOutcomes[c.resolution.outcome] || 'נסגר') : '') + '</span>'
    + '</button>';
}

function renderCounters(counts) {
  const set = (k, v) => { const el = document.querySelector('#tw-case-counters [data-count="' + k + '"]'); if (el) el.textContent = v; };
  for (const k of ['open', 'awaiting_staff', 'in_progress', 'awaiting_member', 'resolved']) set(k, counts ? String(counts[k]) : '—');
  const b = $id('tw-badge-cases'); if (b) b.textContent = counts && counts.open ? String(counts.open) : '';
}

async function loadCases() {
  const list = $id('tw-cases-list');
  if (!list) return;
  if (!list.querySelector('.tw-case-card')) list.innerHTML = '<div class="tw-empty" data-state="loading">טוען פניות…</div>';
  const q = _caseFilter === 'open' ? 'open=1' : _caseFilter === 'resolved' ? 'open=0' : 'status=' + _caseFilter;
  const d = await caseApi('/api/tomer/cases?' + q);
  const alertEl = $id('tw-cases-alert');
  if (!d.ok) {
    // An unknown count is shown as unknown — never as zero.
    renderCounters(null);
    if (alertEl) alertEl.hidden = true;
    list.innerHTML = '<div class="tw-state-error" data-state="error" role="alert">לא ניתן לטעון את הפניות (' + esc(caseErr(d)) + '). <button type="button" class="btn btn-secondary" id="tw-cases-retry">נסו שוב</button></div>';
    return;
  }
  _caseLabels = d.categories || {}; _caseOutcomes = d.outcomes || {};
  renderCounters(d.counts);
  if (alertEl) {
    const msgs = [];
    const nf = (d.counts.notifFailed || 0) + (d.counts.notifUncertain || 0) + (d.counts.notifPending || 0);
    if (nf) msgs.push('ב-' + nf + ' פניות פתוחות ההתראה למנהל לא אושרה כנשלחה — הן מסומנות ברשימה.');
    if (!d.managerConfigured) msgs.push('לא הוגדר מספר מנהל להתראות (TOMER_MANAGER_PHONE או בעל/ת הסטודיו ברשימת הצוות) — התראות לא יישלחו.');
    if (d.testMode && d.testMode.mode === 'test_only') msgs.push('מצב בדיקה: תומר החדש פעיל רק עבור ' + (d.testMode.allowlist.length ? d.testMode.allowlist.join(', ') : 'אף מספר') + '. חברים אחרים לא מטופלים על ידו ולא מקבלים ממנו הודעות. תוכניות יזומות נעולות.');
    if (!d.serviceEnabled) msgs.push('שירות תומר כבוי (TOMER_SERVICE_ENABLED=false) — הודעות חברים לא נפתחות כפניות.');
    else if (!d.autoReply) msgs.push('מענה אוטומטי בוואטסאפ כבוי — תומר רושם פניות אך לא שולח תשובות לחברים.');
    alertEl.hidden = !msgs.length;
    alertEl.innerHTML = msgs.map(m => '<div>' + esc(m) + '</div>').join('');
  }
  const EMPTY = { open: 'אין פניות פתוחות', awaiting_staff: 'אין פניות שממתינות לצוות', in_progress: 'אין פניות בטיפול', awaiting_member: 'אין פניות שממתינות לחבר/ה', resolved: 'אין פניות סגורות' };
  list.innerHTML = d.cases.length ? d.cases.map(renderCaseCard).join('') : '<div class="tw-empty" data-state="empty">' + EMPTY[_caseFilter] + '</div>';
}

// ── One case ────────────────────────────────────────────────────────────────
function closeCase({ keepHash = false } = {}) {
  const d = $id('tw-case-drawer'); if (d) d.hidden = true;
  _openCaseId = null;
  if (!keepHash && /^#tomer\/case\//.test(location.hash)) history.replaceState(null, '', '#tomer');
}

function renderConversation(conv) {
  if (!conv) return '<div class="tw-empty">השיחה לא נטענה</div>';
  if (!conv.messages.length) return '<div class="tw-empty" data-state="empty">אין הודעות רשומות בלוח הבקרה לשיחה הזו</div>';
  const more = conv.total > conv.messages.length ? '<div class="tw-case-meta">מוצגות ' + conv.messages.length + ' ההודעות האחרונות מתוך ' + conv.total + '</div>' : '';
  return more + '<div class="tw-cd-thread">' + conv.messages.map(m =>
    '<div class="tw-cd-msg tw-cd-' + esc(m.who) + '" data-who="' + esc(m.who) + '">'
    + '<div class="tw-cd-who">' + esc(WHO_HE[m.who] || m.who) + (m.who === 'staff' && m.by ? ' — ' + esc(m.by) : '') + ' · ' + esc(fmtDate(m.timestamp)) + '</div>'
    + '<div class="tw-cd-text">' + esc(m.text || (m.mediaType ? '[' + m.mediaType + ']' : '')) + '</div></div>').join('') + '</div>';
}

function renderCaseDetail(c, conv) {
  const open = CASE_OPEN.includes(c.status);
  const membership = MEMBERSHIP_CATS.includes(c.category);
  const n = c.notification || {};
  const f = c.facts;
  const row = (k, v) => '<div class="tw-cd-row"><span class="tw-cd-k">' + k + '</span><span class="tw-cd-v">' + v + '</span></div>';
  const owner = !c.owner || c.owner === 'tomer' ? 'לא שויכה' : esc(c.owner);

  // Notification to the manager
  let notif = '<div class="tw-cd-notif" data-notif="' + esc(n.state || 'not_required') + '">' + esc(NOTIF_HE[n.state] || '—')
    + (n.at ? ' · ' + esc(fmtDate(n.at)) : '') + (n.attempts ? ' · ניסיונות: ' + esc(n.attempts) : '') + '</div>';
  if (n.state === 'accepted') notif += '<div class="tw-case-meta">"התקבלה אצל הספק" אינו אישור שההודעה נקראה.</div>';
  if (n.lastError && n.state !== 'accepted') notif += '<div class="tw-case-meta">פירוט: <span dir="ltr">' + esc(n.lastError) + '</span></div>';
  if (n.state === 'failed' || (n.state === 'pending' && !n.inFlightSince)) notif += '<button type="button" class="btn btn-secondary" data-act="retry-notification">שלח התראה למנהל</button>';
  if (n.state === 'uncertain') notif += '<div class="tw-case-meta">ייתכן שההתראה הגיעה. שליחה חוזרת עלולה ליצור התראה כפולה.</div><button type="button" class="btn btn-secondary" data-act="retry-notification-force">שלח שוב בכל זאת</button>';

  // Arbox (read-only)
  let arbox;
  if (!f) arbox = '<div class="tw-cd-arbox" data-arbox="none">אין נתוני Arbox לפנייה הזו (החבר/ה לא זוהה/תה ב-Arbox בעת פתיחת הפנייה).</div>';
  else if (f.error) arbox = '<div class="tw-cd-arbox tw-state-error" data-arbox="unavailable">Arbox לא היה זמין — אין נתונים. ' + esc(f.summary || '') + '</div>';
  else arbox = '<div class="tw-cd-arbox" data-arbox="ok">' + esc(f.summary || '—') + '</div>';
  if (f && (f.source || f.fetchedAt)) arbox += '<div class="tw-case-meta">מקור: <span dir="ltr">' + esc(f.source || 'Arbox') + '</span> · נקרא ב-' + esc(fmtDate(f.fetchedAt)) + (f.stale ? ' · נתון ישן (Arbox לא ענה בקריאה האחרונה)' : '') + '</div>';
  const ck = c.arboxCheck;
  if (membership) {
    arbox += '<div class="tw-cd-check" data-verified="' + esc(ck ? String(ck.verified) : 'unchecked') + '"><strong>מה Arbox מציג (קריאה בלבד): </strong>'
      + (ck ? esc(ck.summary) + ' · נבדק ב-' + esc(fmtDate(ck.at)) : 'עדיין לא נבדק') + '</div>';
  }
  arbox += '<button type="button" class="btn btn-secondary" data-act="refresh-arbox">קרא שוב מ-Arbox</button>';

  // Request + what staff reported
  let request = '';
  if (membership) {
    request = '<div class="tw-cd-section"><div class="tw-ds-title">הבקשה</div>'
      + row('סוג', esc(_caseLabels[c.category] || c.category))
      + (c.category === 'membership_freeze' ? row('תאריכים מבוקשים', c.request && c.request.from ? esc(dmyHe(c.request.from) + ' – ' + dmyHe(c.request.to)) : 'לא נמסרו') : '')
      + '<div class="tw-cd-note">המערכת לא מבטלת ולא מקפיאה מנויים. את השינוי מבצע הצוות ב-Arbox, ומדווח כאן בסגירת הפנייה.</div></div>';
  }
  let resolution = '';
  if (c.resolution) {
    resolution = '<div class="tw-cd-section tw-cd-resolution"><div class="tw-ds-title">סיכום</div>'
      + '<div data-staff-report="' + esc(c.resolution.outcome) + '"><strong>דיווח הצוות: </strong>' + esc(_caseOutcomes[c.resolution.outcome] || c.resolution.outcome) + ' — ' + esc(c.resolution.note || '') + ' (' + esc(c.resolution.by) + ', ' + esc(fmtDate(c.resolution.at)) + ')</div>'
      + (membership ? '<div data-arbox-verified="' + esc(ck ? String(ck.verified) : 'unchecked') + '"><strong>אימות מול Arbox: </strong>'
        + (ck ? (ck.verified === true ? 'אומת ✓ — ' : ck.verified === false ? 'לא אומת — ' : 'לא ניתן לבדוק — ') + esc(ck.summary) : 'לא נבדק') + '</div>' : '')
      + '</div>';
  }

  // Actions
  let actions = '';
  if (open) {
    const outs = membership ? ['done_in_arbox', 'declined', 'withdrawn', 'other'] : ['handled', 'no_action', 'other'];
    actions = '<div class="tw-cd-section"><div class="tw-ds-title">טיפול</div>'
      + '<div class="tw-cd-form"><label for="tw-cd-owner">אחראי/ת</label><div class="tw-cd-inline"><input id="tw-cd-owner" class="field-input" type="text" maxlength="40" value="' + esc(!c.owner || c.owner === 'tomer' ? staffName() : c.owner) + '" placeholder="שם איש/אשת הצוות">'
      + '<button type="button" class="btn btn-secondary" data-act="assign">שייך</button></div></div>'
      + '<div class="tw-cd-form"><label for="tw-cd-status">סטטוס</label><div class="tw-cd-inline"><select id="tw-cd-status" class="field-input">'
      + CASE_OPEN.map(s => '<option value="' + s + '"' + (s === c.status ? ' selected' : '') + '>' + esc(CASE_STATUS_HE[s]) + '</option>').join('') + '</select>'
      + '<button type="button" class="btn btn-secondary" data-act="status">עדכן סטטוס</button></div></div>'
      + '<div class="tw-cd-form"><label for="tw-cd-reply">הודעה לחבר/ה בשם הצוות</label>'
      + (c.conversationOwner === 'opted_out' ? '<div class="tw-cd-note">החבר/ה ביקש/ה לא לקבל הודעות — אי אפשר לשלוח מכאן.</div>'
        : '<textarea id="tw-cd-reply" class="field-input" rows="3" placeholder="ההודעה נשלחת מהוואטסאפ של הסטודיו ונרשמת כהודעת צוות"></textarea>'
        + '<label class="tw-cd-check-label"><input type="checkbox" id="tw-cd-await"> אחרי השליחה: ממתין לתשובת החבר/ה</label>'
        + '<div class="tw-cd-note">שליחה מעבירה את השיחה לצוות — תומר מפסיק לענות לחבר/ה עד שתשחררו את השיחה.</div>'
        + '<button type="button" class="btn btn-primary" data-act="reply">שלח לחבר/ה</button>') + '</div>'
      + '<div class="tw-cd-form"><label for="tw-cd-outcome">סגירת הפנייה — מה נעשה</label><select id="tw-cd-outcome" class="field-input">'
      + (membership ? '<option value="">בחרו…</option>' : '') + outs.map(o => '<option value="' + o + '">' + esc(_caseOutcomes[o] || o) + '</option>').join('') + '</select>'
      + '<textarea id="tw-cd-note" class="field-input" rows="2" placeholder="הערת סיכום (חובה)"></textarea>'
      + '<button type="button" class="btn btn-primary" data-act="resolve">סגור פנייה</button></div></div>';
  } else {
    actions = '<div class="tw-cd-section"><button type="button" class="btn btn-secondary" data-act="reopen">פתח מחדש</button></div>';
  }

  const convOwner = conv ? conv.owner : c.conversationOwner;
  const convBtns = convOwner === 'human' ? '<button type="button" class="btn btn-secondary" data-act="release">שחרר את השיחה לתומר</button>'
    : convOwner === 'tomer' ? '<button type="button" class="btn btn-secondary" data-act="takeover">קח את השיחה (השתק את תומר)</button>' : '';

  return '<div class="tw-cd-top">'
    + (c.priority === 'high' ? '<span class="tw-chip tw-chip-bad">דחוף</span>' : '<span class="tw-chip">עדיפות רגילה</span>')
    + '<span class="tw-case-status" id="tw-cd-status-chip" data-status-chip="' + esc(c.status) + '">' + esc(CASE_STATUS_HE[c.status] || c.status) + '</span>'
    + (c.unreadMember ? '<span class="tw-chip tw-chip-info">הודעה חדשה מהחבר/ה</span>' : '') + '</div>'
    + '<div id="tw-cd-msg" class="tw-cd-flash" role="status" aria-live="polite"></div>'
    + '<div class="tw-cd-section">'
    + row('חבר/ה', esc(c.memberName || 'שם לא ידוע') + (c.memberUserId ? ' · מזהה Arbox ' + esc(c.memberUserId) : ' · לא זוהה/תה ב-Arbox'))
    + row('טלפון', '<span dir="ltr">' + esc(c.phone) + '</span> · <a href="https://wa.me/' + esc(c.phone) + '" target="_blank" rel="noopener">פתח בוואטסאפ</a>')
    + row('אחראי/ת', '<span id="tw-cd-owner-val">' + owner + '</span>')
    + row('נפתחה', esc(fmtDate(c.createdAt))) + row('עודכנה', esc(fmtDate(c.updatedAt)))
    + (open && c.nextAction ? row('הצעד הבא', esc(c.nextAction)) : '')
    + row('מזהה', '<span dir="ltr">' + esc(c.id) + '</span>') + '</div>'
    + request + resolution
    + '<div class="tw-cd-section"><div class="tw-ds-title">התראה למנהל</div>' + notif + '</div>'
    + '<div class="tw-cd-section"><div class="tw-ds-title">נתוני Arbox</div>' + arbox + '</div>'
    + '<div class="tw-cd-section"><div class="tw-ds-title">השיחה עם החבר/ה</div>'
    + '<div class="tw-cd-owner" id="tw-cd-conv-owner" data-owner="' + esc(convOwner) + '">' + esc(OWNER_CONV_HE[convOwner] || convOwner)
    + (conv && conv.ownedBy ? ' (' + esc(conv.ownedBy) + ')' : '') + '</div>' + convBtns + renderConversation(conv) + '</div>'
    + actions
    + '<details class="tw-cd-section"><summary>היסטוריית הפנייה (' + (c.events || []).length + ')</summary><div class="tw-cd-events">'
    + (c.events || []).slice().reverse().map(e => '<div class="tw-case-meta" data-event="' + esc(e.type) + '">' + esc(fmtDate(e.at)) + ' · ' + esc(EVENT_HE[e.type] || e.type) + ' · ' + esc(e.by === 'tomer' ? 'תומר' : e.by === 'system' ? 'מערכת' : e.by === 'member' ? 'חבר/ה' : e.by || '') + (e.detail ? ' · ' + esc(e.detail) : '') + '</div>').join('')
    + '</div></details>';
}

async function openCase(id, { flash = null } = {}) {
  const drawer = $id('tw-case-drawer'), body = $id('tw-case-body'), title = $id('tw-case-title');
  if (!drawer || !body) return;
  const same = _openCaseId === id;
  _openCaseId = id;
  drawer.hidden = false;
  if (!same) { body.innerHTML = '<div class="tw-empty" data-state="loading">טוען פנייה…</div>'; if (title) title.textContent = 'פנייה'; }
  if (location.hash !== '#tomer/case/' + id) history.replaceState(null, '', '#tomer/case/' + id);
  const d = await caseApi('/api/tomer/cases/' + encodeURIComponent(id));
  if (_openCaseId !== id) return;                       // another case was opened meanwhile
  if (!d.ok) {
    body.innerHTML = '<div class="tw-state-error" data-state="error" role="alert">' + (d.status === 404 ? 'הפנייה לא נמצאה (ייתכן שהקישור שגוי).' : 'לא ניתן לטעון את הפנייה (' + esc(caseErr(d)) + ').')
      + (d.status === 404 ? '' : ' <button type="button" class="btn btn-secondary" data-act="reload">נסו שוב</button>') + '</div>';
    return;
  }
  _caseLabels = { ..._caseLabels, ...(d.categories || {}) }; _caseOutcomes = d.outcomes || _caseOutcomes;
  if (title) title.textContent = (_caseLabels[d.case.category] || 'פנייה') + ' — ' + (d.case.memberName || 'חבר/ה');
  body.innerHTML = renderCaseDetail(d.case, d.conversation);
  if (flash) caseFlash(flash.text, flash.ok);
}
function caseFlash(text, ok = true) {
  const el = $id('tw-cd-msg'); if (!el) return;
  el.textContent = text; el.dataset.kind = ok ? 'ok' : 'error';
}

async function caseAct(act, btn) {
  const id = _openCaseId; if (!id) return;
  const by = staffName() || undefined;
  const val = sel => { const e = $id(sel); return e ? e.value : ''; };
  let op = act, body = { by };
  if (act === 'reload') return openCase(id);
  if (act === 'assign') {
    const to = val('tw-cd-owner').trim();
    if (!to) return caseFlash(CASE_ERR_HE.owner_required, false);
    try { if (!staffName()) localStorage.setItem('tw_staff_name', to); } catch { /* private mode */ }
    body = { to, by: staffName() || to };
  } else if (act === 'status') { body.status = val('tw-cd-status'); }
  else if (act === 'reply') {
    body.text = val('tw-cd-reply'); body.awaitMember = !!($id('tw-cd-await') && $id('tw-cd-await').checked);
    if (!body.text.trim()) return caseFlash(CASE_ERR_HE.text_required, false);
  } else if (act === 'resolve') {
    body.outcome = val('tw-cd-outcome') || undefined; body.note = val('tw-cd-note');
    if (!body.outcome) return caseFlash(CASE_ERR_HE.outcome_required, false);
    if (body.note.trim().length < 2) return caseFlash(CASE_ERR_HE.note_required, false);
  } else if (act === 'retry-notification-force') { op = 'retry-notification'; body.force = true; }
  const OK = { assign: 'הפנייה שויכה', status: 'הסטטוס עודכן', reply: 'ההודעה התקבלה אצל ספק הוואטסאפ ונרשמה כהודעת צוות', resolve: 'הפנייה נסגרה', reopen: 'הפנייה נפתחה מחדש',
    'retry-notification': 'ההתראה למנהל התקבלה אצל ספק הוואטסאפ', 'refresh-arbox': 'הנתונים נקראו מ-Arbox', takeover: 'השיחה אצל הצוות — תומר מושתק', release: 'השיחה שוחררה — תומר חוזר לענות' };
  if (btn) { btn.disabled = true; btn.dataset.busy = '1'; }
  caseFlash('מבצע…');
  const r = await caseApi('/api/tomer/cases/' + encodeURIComponent(id) + '/' + op, { method: 'POST', body });
  if (btn) { btn.disabled = false; delete btn.dataset.busy; }
  let text = r.ok ? (r.unchanged ? 'לא נדרש שינוי — זה כבר המצב' : OK[op]) : caseErr(r);
  let ok = r.ok;
  if (r.ok && op === 'refresh-arbox' && r.arboxAvailable === false) { text = 'Arbox לא זמין כרגע — אין נתונים עדכניים'; ok = false; }
  if (r.ok && r.warning === 'sent_not_recorded') { text = 'ההודעה נשלחה, אך לא נרשמה בפנייה (שגיאת שמירה)'; ok = false; }
  toast(text, ok);
  await Promise.all([openCase(id, { flash: { text, ok } }), loadCases()]);
}

$id('tw-cases-list')?.addEventListener('click', e => {
  if (e.target.closest('#tw-cases-retry')) return loadCases();
  const card = e.target.closest('.tw-case-card');
  if (card) openCase(card.dataset.case);
});
$id('tw-case-body')?.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (b && !b.disabled) caseAct(b.dataset.act, b);
});
$id('tw-case-close')?.addEventListener('click', () => closeCase());
$id('tw-case-overlay')?.addEventListener('click', () => closeCase());
document.addEventListener('keydown', e => { if (e.key === 'Escape' && _openCaseId && !document.querySelector('.modal-overlay')) closeCase(); });
document.querySelectorAll('#tw-case-counters .tw-counter').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#tw-case-counters .tw-counter').forEach(x => { x.classList.remove('active'); x.setAttribute('aria-pressed', 'false'); });
  b.classList.add('active'); b.setAttribute('aria-pressed', 'true'); _caseFilter = b.dataset.cf;
  const l = $id('tw-cases-list'); if (l) l.innerHTML = '';
  loadCases();
}));
document.querySelector('.tw-tab[data-pane="cases"]')?.addEventListener('click', loadCases);
$id('tw-refresh')?.addEventListener('click', () => { if (document.querySelector('.tw-tab.active')?.dataset.pane === 'cases') { loadCases(); if (_openCaseId) openCase(_openCaseId); } });
document.querySelector('.tab-btn[data-tab="tomer"]')?.addEventListener('click', loadCases);
$id('tw-staff-name')?.addEventListener('change', e => { try { localStorage.setItem('tw_staff_name', e.target.value.trim().slice(0, 40)); } catch { /* private mode */ } });
{ const el = $id('tw-staff-name'); if (el) el.value = staffName(); }

// Open a case from anywhere in the workspace (Today list, conversations).
window.openTomerCase = function (id) {
  document.querySelector('.tw-tab[data-pane="cases"]')?.click();
  openCase(id);
};

// Live updates: another staff member (or an inbound member message) changed a case.
(function watchCases() {
  let t = null;
  const refresh = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (!document.querySelector('.tab-btn[data-tab="tomer"].active')) return;
      loadCases();
      // Never redraw the open case under someone who is typing in it.
      const typing = document.activeElement && $id('tw-case-body')?.contains(document.activeElement) && ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName);
      if (_openCaseId && !typing) openCase(_openCaseId);
    }, 400);
  };
  try {
    const es = new EventSource('/api/whatsapp/stream');
    es.onmessage = e => { try { if (JSON.parse(e.data).event === 'tomer_case') refresh(); } catch { /* not json */ } };
  } catch { /* the refresh button still works */ }
})();

// Deep link from the manager's WhatsApp alert: /#tomer/case/<id> (also after logging in).
function openCaseFromHash() {
  const m = /^#tomer\/case\/([A-Za-z0-9_-]+)$/.exec(location.hash || '');
  if (!m) return false;
  document.querySelector('.tab-btn[data-tab="tomer"]')?.click();
  document.querySelector('.tw-tab[data-pane="cases"]')?.click();
  openCase(m[1]);
  return true;
}
window.addEventListener('hashchange', openCaseFromHash);
if (document.readyState === 'complete') openCaseFromHash(); else window.addEventListener('load', () => setTimeout(openCaseFromHash, 0));

// ════════════════════════════════════════════════════════════════════════════
//  MEMBER CARE (ליווי חברים) — proactive programs, previews, pauses, guest sessions
//
//  A program sends only when ALL of these hold: the deployment switch is on, the
//  program is enabled here, its required settings exist, its Arbox data was read, and
//  the member passes the contact policy. The panel shows which of them is missing.
// ════════════════════════════════════════════════════════════════════════════
const EP_STATUS_HE = { pending: 'ממתין לשליחה', deferred: 'נדחה — ייבדק שוב', blocked: 'חסום', sending: 'בשליחה', sent: 'נשלח', failed: 'נכשל — לא נשלח', uncertain: 'לא ודאי אם נשלח', closed: 'נסגר', expired: 'פג — לא נשלח', cancelled: 'בוטל — כבר לא רלוונטי' };
const EP_OUTCOME_HE = { vacation: 'חופשה / היעדרות', injury: 'פציעה / מחלה', schedule: 'שעות לא מתאימות', data_corrected: 'הנתון תוקן', disputed: 'נתון במחלוקת — לבדיקה', feedback: 'משוב', stop: 'ביקש/ה להפסיק',
  renew_requested: 'מבקש/ת לחדש', declined: 'לא מעוניין/ת', guest_requested: 'בקשת אימון אורח', guest_none_left: 'אימוני האורח נוצלו', resolved: 'הוסדר', paid_claimed: 'דיווח/ה ששילם/ה', ok: 'הכול בסדר',
  returned: 'חזר/ה להתאמן', no_reply: 'ללא תגובה', replied: 'השיב/ה', engaged: 'פנה/תה בנושא אחר', thanked: 'תודה' };
const CARE_ERR_HE = { program_blocked: 'התוכנית חסומה — חסרה הגדרה נדרשת', bad_hour: 'השעה חייבת להיות בתוך שעות השליחה', bad_group_link: 'הקישור חייב להיות קישור הזמנה של וואטסאפ (https://chat.whatsapp.com/…)',
  unsafe_payment_text: 'הנוסח מבקש פרטי כרטיס — אסור', bad_policy: 'ערך לא תקין במדיניות', proactive_locked: 'המתג הראשי כבוי (TOMER_PROACTIVE_ENABLED) — לא נשלח דבר', already_running: 'ריצה אחרת מתבצעת כרגע',
  no_test_phone: 'אין מספר בדיקה פעיל (עקיפת הניתוב כבויה)', policy: 'מדיניות הקשר לא מאפשרת כרגע', bad_phone: 'מספר טלפון לא תקין', reason_required: 'יש לכתוב סיבה', bad_date: 'תאריך לא תקין',
  none_remaining: 'לא נותרו אימוני אורח', already_redeemed: 'כבר מומש', not_reserved: 'האימון אינו שמור', no_entitlement: 'אין זכאות', not_uncertain: 'ההודעה אינה במצב שדורש החלטה', network: 'אין חיבור לשרת', operation_failed: 'הפעולה נכשלה בשרת' };
const SRC_HE = { users: 'חברים', memberships: 'מנויים', types: 'סוגי מנוי', attendance: 'נוכחות (30 יום)', futureBookings: 'רישומים עתידיים', cancellations: 'ביטולי רישום', holds: 'הקפאות', transactions: 'עסקאות / חיובים' };
let _care = null, _epFilter = 'upcoming';
const careErr = r => CARE_ERR_HE[r.error] || (r.detail ? String(r.detail) : 'הפעולה נכשלה');
function careFlash(text, ok = true) { const el = $id('tc-flash'); if (el) { el.textContent = text; el.dataset.kind = ok ? 'ok' : 'error'; } toast(text, ok); }
const careBy = () => staffName() || undefined;

function renderCarePrograms(o) {
  const rows = o.programs.map(p => {
    const state = p.blocks.length ? 'blocked' : p.enabled ? 'on' : 'off';
    const chip = state === 'blocked' ? '<span class="tw-chip tw-chip-warn">חסום</span>' : state === 'on' ? '<span class="tw-chip tw-chip-info">מופעל</span>' : '<span class="tw-chip">כבוי</span>';
    const c = p.counts;
    return '<tr data-program="' + esc(p.id) + '" data-state="' + state + '">'
      + '<td><strong>' + esc(p.label) + '</strong>' + (p.blocks.length ? '<div class="tw-case-meta tc-blocks">' + p.blocks.map(b => esc(b.text)).join('<br>') + '</div>' : '')
      + (p.activatedAt ? '<div class="tw-case-meta">פועל על אירועים מ-' + esc(fmtDate(p.activatedAt)) + ' ואילך</div>' : '<div class="tw-case-meta">טרם הופעל — בהפעלה נקבע קו ההתחלה (בלי שליחה רטרואקטיבית)</div>') + '</td>'
      + '<td>' + chip + '</td>'
      + '<td><input type="number" class="field-input tc-hour" min="6" max="21" value="' + esc(p.hour) + '" aria-label="שעת ריצה"> <button type="button" class="btn-xs btn-xs-sec" data-care="hour">שמור</button></td>'
      + '<td class="tc-counts">נשלחו ' + c.sent + ' · ממתינות ' + c.awaitingSend + ' · חסומות ' + c.blocked + (c.failed ? ' · <strong>נכשלו ' + c.failed + '</strong>' : '') + (c.uncertain ? ' · <strong>לא ודאי ' + c.uncertain + '</strong>' : '') + '<div class="tw-case-meta">ריצה אחרונה: ' + esc(p.lastRun ? dmyHe(p.lastRun) : 'אף פעם') + '</div></td>'
      + '<td class="tc-actions">'
      + (p.enabled ? '<button type="button" class="btn-xs btn-xs-sec" data-care="disable">כבה</button>' : '<button type="button" class="btn-xs" data-care="enable"' + (p.blocks.length ? ' disabled title="חסרה הגדרה נדרשת"' : '') + '>הפעל</button>')
      + ' <button type="button" class="btn-xs btn-xs-sec" data-care="preview">מי זכאי/ת?</button>'
      + (p.enabled && o.proactiveOn ? ' <button type="button" class="btn-xs btn-xs-sec" data-care="run">הרץ עכשיו</button>' : '')
      + (o.testMode.routeOverridePhones.length && o.proactiveOn && !p.blocks.length ? ' <button type="button" class="btn-xs btn-xs-sec" data-care="test">שלח הודעת בדיקה למספר הבדיקה</button>' : '')
      + '</td></tr>';
  }).join('');
  return '<div class="table-wrapper"><table class="leads-table tc-table"><thead><tr><th>תוכנית</th><th>מצב</th><th>שעת ריצה</th><th>הודעות</th><th>פעולות</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function renderCareSettings(o) {
  const s = o.settings, p = s.policy;
  const num = (k, label, lo, hi) => '<label class="tc-num">' + label + '<input type="number" class="field-input" id="tc-p-' + k + '" min="' + lo + '" max="' + hi + '" value="' + esc(p[k]) + '"></label>';
  return '<div class="tw-cd-form"><label for="tc-group-link">קישור מאושר לקבוצת הוואטסאפ של הסטודיו (נדרש ל"ברוכים הבאים")</label>'
    + '<input type="url" id="tc-group-link" class="field-input" dir="ltr" placeholder="https://chat.whatsapp.com/…" value="' + esc(s.groupLink || '') + '"></div>'
    + '<div class="tw-cd-form"><label for="tc-payment-text">דרך מאושרת ובטוחה להסדרת תשלום שנכשל (משפט אחד שיופיע בהודעה)</label>'
    + '<textarea id="tc-payment-text" class="field-input" rows="2" placeholder="למשל: אפשר לעדכן אמצעי תשלום באפליקציית Arbox, או מול הצוות בסטודיו.">' + esc(s.paymentResolution || '') + '</textarea>'
    + '<label class="tw-cd-check-label"><input type="checkbox" id="tc-billing-ok"' + (s.billingDataConfirmed ? ' checked' : '') + '> אני מאשר/ת ש"FAIL" בדוח העסקאות של Arbox פירושו חיוב חודשי שנכשל, ושחיוב מוצלח מאוחר יותר סוגר אותו</label></div>'
    + '<div class="tw-ds-title" style="margin-top:14px">מדיניות קשר (ברירות מחדל מוצעות — לאישור)</div><div class="tc-policy">'
    + num('windowStart', 'שליחה משעה', 6, 12) + num('windowEnd', 'עד שעה', 13, 22) + num('fridayEnd', 'בשישי עד', 9, 16)
    + num('cooldownHours', 'מרווח בין הודעות יזומות (שעות)', 0, 720) + num('attendanceCooldownDays', 'מרווח בין הודעות נוכחות (ימים)', 0, 30)
    + num('recentConversationHours', 'לא לכתוב אם הייתה שיחה ב-X שעות', 0, 168) + num('replyWindowDays', 'תגובה נחשבת המשך שיחה עד (ימים)', 1, 14)
    + num('defaultPauseDays', 'השהיה כשאין תאריך חזרה (ימים)', 1, 90) + num('paymentGraceHours', 'המתנה אחרי חיוב שנכשל (שעות)', 0, 168)
    + '<label class="tc-num">יום הולדת בשבת<select id="tc-p-birthdaySaturday" class="field-input"><option value="friday"' + (p.birthdaySaturday === 'friday' ? ' selected' : '') + '>ברכה ביום שישי</option><option value="sunday"' + (p.birthdaySaturday === 'sunday' ? ' selected' : '') + '>ברכה ביום ראשון</option></select></label>'
    + '</div><div class="tw-case-meta">אין שליחה בשבת. סיכום יומי למנהל: כבוי (לא קיים עד אישור).</div>'
    + '<button type="button" class="btn btn-primary" id="tc-save" style="margin-top:10px">שמור הגדרות</button>'
    + '<div class="tw-ds-title" style="margin-top:16px">החלטות מדיניות שחסרות לאימוני האורח</div><ul class="tc-missing">' + o.missingPolicy.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>'
    + '<div class="tw-case-meta">עד שיוחלט — תומר רק רושם בקשה לצוות, ולא מבטיח תוקף, שיעור או רישום.</div>';
}

function renderCarePauses(o) {
  const rows = o.pauses.map(p => '<tr data-pause="' + esc(p.phone) + '"><td>' + esc(p.name || '') + ' <span dir="ltr">' + esc(p.phone) + '</span></td><td>' + esc(p.reason === 'vacation' ? 'חופשה' : p.reason === 'injury' ? 'פציעה / מחלה' : p.reason) + (p.note ? '<div class="tw-case-meta">' + esc(p.note) + '</div>' : '') + '</td>'
    + '<td>' + (p.until ? esc(dmyHe(p.until)) + (p.endKnown ? '' : ' <span class="tw-chip tw-chip-warn">ברירת מחדל — תאריך לא נמסר</span>') : 'ללא תאריך סיום') + '</td><td>' + esc(p.setBy === 'member' ? 'החבר/ה' : p.setBy || '') + '</td>'
    + '<td><button type="button" class="btn-xs btn-xs-sec" data-care="pause-remove">הסר</button></td></tr>').join('');
  return '<div class="tc-pause-form"><input type="tel" id="tc-pause-phone" class="field-input" dir="ltr" placeholder="טלפון" aria-label="טלפון"><input type="text" id="tc-pause-reason" class="field-input" placeholder="סיבה (חופשה, מילואים…)" aria-label="סיבה"><input type="date" id="tc-pause-until" class="field-input" aria-label="עד תאריך"><button type="button" class="btn btn-secondary" data-care="pause-add">הוסף השהיה</button></div>'
    + (rows ? '<div class="table-wrapper"><table class="leads-table"><thead><tr><th>חבר/ה</th><th>סיבה</th><th>עד</th><th>נקבע על ידי</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<div class="tw-empty" data-state="empty">אין השהיות פעילות</div>');
}

function renderCareEntitlements(o) {
  if (!o.entitlements.length) return '<div class="tw-empty" data-state="empty">עוד לא הונפקו אימוני אורח</div>';
  const ITEM = { reserved: 'שמור', redeemed: 'מומש', released: 'שוחרר' };
  return o.entitlements.map(e => '<div class="tc-ent" data-ent="' + esc(e.userId) + '"><div><strong>' + esc(e.name || e.userId) + '</strong> · הונפקו ' + e.total + ' ב-' + esc(fmtDate(e.issuedAt))
    + ' · <span data-ent-remaining="' + e.remaining + '">נותרו ' + e.remaining + '</span> · שמורים ' + e.reserved + ' · מומשו ' + e.redeemed + '</div>'
    + e.items.map(i => '<div class="tw-case-meta" data-item="' + esc(i.id) + '" data-item-status="' + esc(i.status) + '">' + esc(ITEM[i.status] || i.status) + (i.guestName ? ' — ' + esc(i.guestName) : '') + ' · ' + esc(fmtDate(i.at)) + ' · ' + esc(i.by || '')
      + (i.status === 'reserved' ? ' <button type="button" class="btn-xs" data-care="ent-redeem">סמן כמומש</button> <button type="button" class="btn-xs btn-xs-sec" data-care="ent-release">שחרר</button>' : '') + '</div>').join('')
    + (e.remaining > 0 ? '<div class="tc-pause-form"><input type="text" class="field-input tc-guest-name" placeholder="שם האורח/ת" aria-label="שם האורח/ת"><button type="button" class="btn-xs" data-care="ent-reserve">שמור אימון אורח</button></div>' : '<div class="tw-case-meta">לא נותרו אימונים לשמירה</div>')
    + '</div>').join('');
}

async function loadCare() {
  const box = $id('tc-programs'); if (!box) return;
  if (!_care) box.innerHTML = '<div class="tw-empty" data-state="loading">טוען…</div>';
  const o = await caseApi('/api/tomer/care/overview');
  const banner = $id('tc-banner');
  if (!o.ok) { box.innerHTML = '<div class="tw-state-error" data-state="error" role="alert">לא ניתן לטעון את ליווי החברים (' + esc(careErr(o)) + '). <button type="button" class="btn btn-secondary" data-care="reload">נסו שוב</button></div>'; if (banner) banner.hidden = true; return; }
  _care = o;
  const msgs = [];
  if (!o.proactiveOn) msgs.push('המתג הראשי כבוי (TOMER_PROACTIVE_ENABLED) — שום הודעה יזומה לא נשלחת, גם אם תוכנית מופעלת כאן.');
  if (o.testMode.mode === 'test_only') msgs.push('מצב בדיקה: הודעות יזומות יכולות להגיע רק אל ' + (o.testMode.allowlist.join(', ') || 'אף מספר') + '. חברים אחרים מופיעים בתצוגה המקדימה כ"חסום — מצב בדיקה".');
  if (!o.autoReply) msgs.push('מענה אוטומטי בוואטסאפ כבוי — הודעות לא יישלחו.');
  if (banner) { banner.hidden = !msgs.length; banner.innerHTML = msgs.map(m => '<div>' + esc(m) + '</div>').join(''); }
  box.innerHTML = renderCarePrograms(o);
  $id('tc-settings').innerHTML = renderCareSettings(o);
  $id('tc-pauses').innerHTML = renderCarePauses(o);
  $id('tc-entitlements').innerHTML = renderCareEntitlements(o);
  const on = o.programs.filter(p => p.enabled).length; const b = $id('tw-badge-care'); if (b) b.textContent = on ? String(on) : '';
  loadCareEpisodes();
}

async function loadCareEpisodes() {
  const el = $id('tc-episodes'); if (!el) return;
  const F = { upcoming: 'pending,deferred,blocked,sending', sent: 'sent,closed', problem: 'failed,uncertain', dropped: 'cancelled,expired' };
  const d = await caseApi('/api/tomer/care/episodes?status=' + F[_epFilter]);
  if (!d.ok) { el.innerHTML = '<div class="tw-state-error" data-state="error">לא ניתן לטעון את ההודעות (' + esc(careErr(d)) + ')</div>'; return; }
  const EMPTY = { upcoming: 'אין הודעות שממתינות לשליחה', sent: 'עוד לא נשלחו הודעות', problem: 'אין הודעות שנכשלו או שמצבן לא ודאי', dropped: 'אין הודעות שבוטלו' };
  if (!d.episodes.length) { el.innerHTML = '<div class="tw-empty" data-state="empty">' + EMPTY[_epFilter] + '</div>'; return; }
  el.innerHTML = '<div class="table-wrapper"><table class="leads-table"><thead><tr><th>עודכן</th><th>חבר/ה</th><th>תוכנית</th><th>מצב</th><th>תגובה / תוצאה</th><th></th></tr></thead><tbody>'
    + d.episodes.map(e => '<tr data-episode="' + esc(e.key) + '" data-ep-status="' + esc(e.status) + '"><td>' + esc(fmtDate(e.updatedAt)) + '</td><td>' + esc(e.name || '') + (e.synthetic ? ' <span class="tw-chip">בדיקה</span>' : '') + '</td><td>' + esc(e.label) + '</td>'
      + '<td>' + esc(EP_STATUS_HE[e.status] || e.status) + (e.reasonsText && e.reasonsText.length ? '<div class="tw-case-meta">' + e.reasonsText.map(esc).join(' · ') + '</div>' : '') + (e.send && e.send.error ? '<div class="tw-case-meta" dir="ltr">' + esc(e.send.error) + '</div>' : '') + '</td>'
      + '<td>' + esc(e.conversation && e.conversation.outcome ? (EP_OUTCOME_HE[e.conversation.outcome] || e.conversation.outcome) : (e.status === 'sent' ? 'ממתין לתגובה' : '—'))
      + (e.conversation && e.conversation.replies && e.conversation.replies.length ? '<div class="tw-case-meta">"' + esc(e.conversation.replies[e.conversation.replies.length - 1].text) + '"</div>' : '') + '</td>'
      + '<td>' + (e.caseId ? '<button type="button" class="btn-xs" onclick="openTomerCase(\'' + esc(e.caseId) + '\')">פתח פנייה</button> ' : '')
      + (e.status === 'uncertain' || e.status === 'failed' ? '<button type="button" class="btn-xs btn-xs-sec" data-care="ep-sent">ההודעה הגיעה</button> <button type="button" class="btn-xs btn-xs-sec" data-care="ep-retry">לא הגיעה — לשלוח בריצה הבאה</button>' : '')
      + (e.send && e.send.text ? '<details><summary>נוסח</summary><div class="tw-cd-text">' + esc(e.send.text) + '</div></details>' : '') + '</td></tr>').join('') + '</tbody></table></div>';
}

function renderCarePreview(p) {
  const src = Object.entries(p.sources).map(([k, v]) => '<span class="tw-chip ' + (v.ok ? (v.stale ? 'tw-chip-warn' : '') : 'tw-chip-bad') + '" data-src="' + esc(k) + '" data-src-ok="' + (v.ok ? '1' : '0') + '">' + esc(SRC_HE[k] || k) + ': ' + (v.ok ? (v.stale ? 'נתון ישן' : 'נקרא ' + esc(fmtDate(v.fetchedAt))) : 'לא זמין') + '</span>').join(' ');
  let h = '<div class="tc-src">' + src + '</div>';
  if (p.blocks.length) h += '<div class="tw-state-error" data-preview="config-blocked">התוכנית חסומה: ' + p.blocks.map(b => esc(b.text)).join(' · ') + '</div>';
  if (p.dataBlocked) return h + '<div class="tw-state-error" data-preview="data-blocked">לא ניתן לקבוע זכאות — נתוני Arbox חסרים: ' + p.dataBlocked.map(d => esc(SRC_HE[d.source] || d.source)).join(', ') + '. נתון חסר אינו נחשב היעדרות או כשל.</div>';
  h += '<div class="tw-case-meta">' + (p.activated ? 'קו התחלה: ' + esc(dmyHe(p.baseline)) : 'התוכנית טרם הופעלה — התצוגה מניחה הפעלה היום (' + esc(dmyHe(p.baseline)) + ')') + ' · חברים פעילים: ' + p.totalMembers + '</div>';
  h += '<div class="tw-ds-title" style="margin-top:10px">זכאים (' + p.included.length + ')</div>';
  h += p.included.length ? '<div class="table-wrapper"><table class="leads-table"><thead><tr><th>חבר/ה</th><th>החלטה</th><th>על סמך</th><th>ההודעה</th></tr></thead><tbody>'
    + p.included.map(x => '<tr data-inc="' + esc(x.userId) + '" data-decision="' + esc(x.decision) + '"><td>' + esc(x.name || x.userId) + '</td>'
      + '<td>' + (x.decision === 'send' ? '<span class="tw-chip tw-chip-info">תישלח</span>' : x.decision === 'defer' ? '<span class="tw-chip tw-chip-warn">תידחה</span>' : '<span class="tw-chip tw-chip-bad">חסומה</span>') + (x.reasons.length ? '<div class="tw-case-meta">' + x.reasons.map(r => esc(r.text)).join(' · ') + '</div>' : '') + '</td>'
      + '<td class="tw-case-meta" dir="ltr">' + esc(Object.entries(x.sourceDates || {}).map(([k, v]) => k + ': ' + v).join(' · ')) + '</td>'
      + '<td><details><summary>הצג</summary><div class="tw-cd-text">' + esc(x.message) + '</div></details></td></tr>').join('') + '</tbody></table></div>'
    : '<div class="tw-empty" data-state="empty">אין כרגע חברים זכאים</div>';
  h += '<div class="tw-ds-title" style="margin-top:10px">לא נכללים — לפי סיבה</div>' + (p.excludedCounts.length ? '<ul class="tc-missing">' + p.excludedCounts.map(c => '<li data-excl="' + esc(c.code) + '">' + esc(c.text) + ': ' + c.count + '</li>').join('') + '</ul>' : '<div class="tw-empty">—</div>');
  h += '<details><summary>רשימה מלאה של הלא-נכללים</summary>' + p.excluded.map(x => '<div class="tw-case-meta">' + esc(x.name || x.userId) + ' — ' + x.reasons.map(r => esc(r.text)).join(' · ') + '</div>').join('') + '</details>';
  return h;
}

async function careAct(act, btn) {
  const row = btn.closest('[data-program]'), id = row ? row.dataset.program : null;
  const post = (url, body = {}) => caseApi(url, { method: 'POST', body: { ...body, by: careBy() } });
  let r, okText = 'נשמר';
  if (act === 'reload') return loadCare();
  btn.disabled = true;
  if (act === 'enable' || act === 'disable') { r = await post('/api/tomer/care/programs/' + id, { enabled: act === 'enable' }); okText = act === 'enable' ? 'התוכנית הופעלה — תפעל רק על אירועים מעכשיו' : 'התוכנית כובתה'; }
  else if (act === 'hour') { r = await post('/api/tomer/care/programs/' + id, { hour: Number(row.querySelector('.tc-hour').value) }); okText = 'שעת הריצה נשמרה'; }
  else if (act === 'preview') {
    const card = $id('tc-preview-card'); card.hidden = false; $id('tc-preview-title').textContent = 'תצוגה מקדימה'; $id('tc-preview').innerHTML = '<div class="tw-empty" data-state="loading">קורא נתונים מ-Arbox…</div>';
    r = await caseApi('/api/tomer/care/preview/' + id);
    btn.disabled = false;
    if (!r.ok) { $id('tc-preview').innerHTML = '<div class="tw-state-error" data-state="error">התצוגה המקדימה נכשלה (' + esc(careErr(r)) + ')</div>'; return; }
    $id('tc-preview-title').textContent = 'תצוגה מקדימה — ' + r.label + ' (שום דבר לא נשלח)'; $id('tc-preview-card').dataset.program = id;
    $id('tc-preview').innerHTML = renderCarePreview(r); card.scrollIntoView({ block: 'nearest' }); return;
  }
  else if (act === 'run') { r = await post('/api/tomer/care/run/' + id); if (r.ok) okText = 'הריצה הסתיימה: נשלחו ' + r.run.sent + ', נדחו ' + r.run.deferred + ', חסומות ' + r.run.blocked + (r.run.failed ? ', נכשלו ' + r.run.failed : '') + (r.run.uncertain ? ', לא ודאי ' + r.run.uncertain : '') + (r.run.dataBlocked.length ? ' · נתוני Arbox חסרים — לא בוצע' : ''); }
  else if (act === 'test') { r = await post('/api/tomer/care/test-send/' + id); okText = 'הודעת בדיקה נשלחה למספר הבדיקה'; }
  else if (act === 'pause-add') { r = await post('/api/tomer/care/pauses', { phone: $id('tc-pause-phone').value, reason: $id('tc-pause-reason').value, until: $id('tc-pause-until').value }); okText = 'ההשהיה נוספה'; }
  else if (act === 'pause-remove') { r = await post('/api/tomer/care/pauses/remove', { phone: btn.closest('[data-pause]').dataset.pause }); okText = 'ההשהיה הוסרה'; }
  else if (act.startsWith('ent-')) {
    const ent = btn.closest('[data-ent]').dataset.ent, item = btn.closest('[data-item]');
    if (act === 'ent-reserve') { r = await post('/api/tomer/care/entitlements/' + encodeURIComponent(ent) + '/reserve', { guestName: btn.closest('.tc-pause-form').querySelector('.tc-guest-name').value }); okText = 'אימון אורח נשמר'; }
    else { r = await post('/api/tomer/care/entitlements/' + encodeURIComponent(ent) + '/' + (act === 'ent-redeem' ? 'redeem' : 'release'), { itemId: item.dataset.item }); okText = act === 'ent-redeem' ? 'סומן כמומש' : 'השמירה שוחררה'; }
  }
  else if (act === 'ep-sent' || act === 'ep-retry') { r = await post('/api/tomer/care/episodes/resolve', { key: btn.closest('[data-episode]').dataset.episode, action: act === 'ep-sent' ? 'mark_sent' : 'mark_not_sent' }); okText = act === 'ep-sent' ? 'סומן כנשלח' : 'ייבדק ויישלח בריצה הבאה'; }
  btn.disabled = false;
  if (!r) return;
  careFlash(r.ok ? okText : careErr(r) + (r.blocks ? ': ' + r.blocks.map(b => b.text).join(' · ') : '') + (r.reasons ? ': ' + r.reasons.map(x => x.text).join(' · ') : ''), r.ok);
  await loadCare();
}

async function saveCareSettings(btn) {
  const policy = {};
  for (const k of ['windowStart', 'windowEnd', 'fridayEnd', 'cooldownHours', 'attendanceCooldownDays', 'recentConversationHours', 'replyWindowDays', 'defaultPauseDays', 'paymentGraceHours']) policy[k] = Number($id('tc-p-' + k).value);
  policy.birthdaySaturday = $id('tc-p-birthdaySaturday').value;
  btn.disabled = true;
  const r = await caseApi('/api/tomer/care/settings', { method: 'POST', body: { groupLink: $id('tc-group-link').value, paymentResolution: $id('tc-payment-text').value, billingDataConfirmed: $id('tc-billing-ok').checked, policy, by: careBy() } });
  btn.disabled = false;
  careFlash(r.ok ? 'ההגדרות נשמרו' : careErr(r), r.ok);
  if (r.ok) await loadCare();
}

async function loadAbsenceReport() {
  const el = $id('tc-absence'); el.innerHTML = '<div class="tw-empty" data-state="loading">קורא נתונים מ-Arbox…</div>';
  const d = await caseApi('/api/tomer/care/absence-report');
  if (!d.ok) { el.innerHTML = '<div class="tw-state-error" data-state="error">לא ניתן להפיק את הדוח — ' + (d.error === 'arbox_unavailable' ? 'Arbox לא זמין' : esc(careErr(d))) + '</div>'; return; }
  const attOk = d.sources.attendance && d.sources.attendance.ok;
  const rows = d.rows.filter(r => r.daysAbsent === null || r.daysAbsent >= 5);
  el.innerHTML = (attOk ? '' : '<div class="tw-state-error" data-absence="unknown">נתוני הנוכחות לא נקראו מ-Arbox — משך ההיעדרות אינו ידוע (לא מוצג כהיעדרות).</div>')
    + '<div class="tw-case-meta">מוצגים חברים פעילים עם 5+ ימים ללא כניסה מאומתת, או שנוכחותם אינה ידועה · ' + rows.length + ' מתוך ' + d.rows.length + '</div>'
    + (rows.length ? '<div class="table-wrapper"><table class="leads-table"><thead><tr><th>חבר/ה</th><th>מנוי</th><th>כניסה מאומתת אחרונה</th><th>ימים</th><th>רישום עתידי</th><th>פנייה אחרונה</th><th>תגובה</th><th>אחראי/ת</th><th>הצעד הבא</th></tr></thead><tbody>'
      + rows.map(r => '<tr data-abs="' + esc(r.userId) + '"><td>' + esc(r.name || r.userId) + '</td><td>' + esc(r.membership) + '</td><td>' + (r.lastAttendance ? esc(dmyHe(r.lastAttendance)) : r.neverAttended ? 'טרם הגיע/ה' : 'לא ידוע (30+ יום או אין נתון)') + '</td>'
        + '<td data-days="' + esc(r.daysAbsent === null ? 'unknown' : r.daysAbsent) + '">' + (r.daysAbsent === null ? '—' : r.daysAbsent) + '</td><td>' + (r.futureBooking ? esc(dmyHe(r.futureBooking.date)) + ' ' + esc(r.futureBooking.time) : '—') + '</td>'
        + '<td>' + (r.lastOutreach ? esc(r.lastOutreach.label) + '<div class="tw-case-meta">' + esc(fmtDate(r.lastOutreach.at)) + '</div>' : '—') + '</td><td>' + esc(r.response ? (EP_OUTCOME_HE[r.response] || r.response) : '—') + '</td><td>' + esc(r.owner) + '</td>'
        + '<td>' + esc(r.nextAction) + (r.caseId ? ' <button type="button" class="btn-xs" onclick="openTomerCase(\'' + esc(r.caseId) + '\')">פנייה</button>' : '') + '</td></tr>').join('') + '</tbody></table></div>'
      : '<div class="tw-empty" data-state="empty">אין חברים עם היעדרות של 5 ימים ומעלה</div>');
}

async function loadCareVisibility() {
  const el = $id('tc-visibility'); el.innerHTML = '<div class="tw-empty" data-state="loading">קורא נתונים מ-Arbox…</div>';
  const d = await caseApi('/api/tomer/care/visibility');
  if (!d.ok) { el.innerHTML = '<div class="tw-state-error" data-state="error">לא ניתן לטעון (' + esc(careErr(d)) + ')</div>'; return; }
  el.innerHTML = (d.attendanceKnown ? '' : '<div class="tw-state-error">נתוני הנוכחות לא זמינים — הרשימה הראשונה אינה ידועה.</div>')
    + '<div class="tw-ds-title">חברים חדשים שעוד לא הגיעו לאימון ראשון (' + d.newNotAttended.length + ')</div>'
    + (d.newNotAttended.length ? d.newNotAttended.map(m => '<div class="tw-case-meta" data-new="' + esc(m.userId) + '">' + esc(m.name || m.userId) + ' · מנוי מ-' + esc(dmyHe(m.membershipStart)) + ' (' + m.daysSinceStart + ' ימים)' + (m.futureBooking ? ' · רשום/ה ל-' + esc(dmyHe(m.futureBooking.date)) : ' · אין רישום עתידי') + '</div>').join('') : '<div class="tw-empty" data-state="empty">אין</div>')
    + '<div class="tw-ds-title" style="margin-top:10px">חזרו להתאמן אחרי היעדרות (' + d.returned.length + ')</div>'
    + (d.returned.length ? d.returned.map(m => '<div class="tw-case-meta" data-returned="' + esc(m.userId) + '">' + esc(m.name || m.userId) + ' · נעדר/ה מ-' + esc(dmyHe(m.absentSince)) + ' · חזר/ה ב-' + esc(dmyHe(m.returnedOn)) + '</div>').join('') : '<div class="tw-empty" data-state="empty">אין</div>')
    + '<div class="tw-case-meta">לשתי הרשימות אין הודעה יזומה — ממתין לאישור.</div>';
}

$id('twp-care')?.addEventListener('click', e => {
  const b = e.target.closest('[data-care]');
  if (b && !b.disabled) return careAct(b.dataset.care, b);
  if (e.target.closest('#tc-save')) return saveCareSettings(e.target.closest('#tc-save'));
  if (e.target.closest('#tc-absence-load')) return loadAbsenceReport();
  if (e.target.closest('#tc-visibility-load')) return loadCareVisibility();
  const f = e.target.closest('[data-ef]');
  if (f) { document.querySelectorAll('#twp-care [data-ef]').forEach(x => x.classList.remove('active')); f.classList.add('active'); _epFilter = f.dataset.ef; loadCareEpisodes(); }
});
document.querySelector('.tw-tab[data-pane="care"]')?.addEventListener('click', loadCare);
$id('tw-refresh')?.addEventListener('click', () => { if (document.querySelector('.tw-tab.active')?.dataset.pane === 'care') loadCare(); });
