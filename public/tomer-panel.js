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

    // ── KPIs ──────────────────────────────────────────────────────────────────
    const c = todayData.counts ?? {};
    setTxt('twk-high',   c.highPriority  ?? 0);
    setTxt('twk-await',  c.awaitingReply ?? 0);
    setTxt('twk-open',   c.openTasks     ?? 0);
    setTxt('twk-failed', c.failedSends   ?? 0);
    setTxt('twk-arbox',  overviewData.arboxHealth ? '✅ OK' : '⚠️ Error');

    // Badge on Today tab + Tasks tab
    const badgeToday = $id('tw-badge-today');
    const total = (c.highPriority ?? 0) + (c.awaitingReply ?? 0);
    if (badgeToday) badgeToday.textContent = total > 0 ? String(total) : '';
    const badgeTasks = $id('tw-badge-tasks');
    if (badgeTasks) badgeTasks.textContent = c.openTasks > 0 ? String(c.openTasks) : '';

    // ── Unified action list ────────────────────────────────────────────────────
    const items = [];

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
          ${escalateTag} ${ownerTag}
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
//  SERVICE CASES (פניות) — one card per member issue, with its Arbox action
// ════════════════════════════════════════════════════════════════════════════
const CASE_STATUS_HE = { awaiting_member: 'ממתין לחבר/ה', awaiting_staff: 'ממתין לצוות', in_progress: 'בטיפול', resolved: 'נסגר', rejected: 'נדחה', cancelled: 'בוטל' };
const ACTION_STATE_HE = {
  awaiting_approval: 'ממתין לאישור', approved: 'אושר — ממתין להפעלה', awaiting_manual: 'אושר — לביצוע ידני ב-Arbox',
  executing: 'מתבצע מול Arbox', verified: 'בוצע ואומת ב-Arbox ✓', failed: 'נכשל — Arbox דחה', uncertain: 'תוצאה לא ודאית — לבדוק ב-Arbox',
  not_verified: 'דווח כבוצע — Arbox לא מציג', rejected: 'נדחה על ידי הצוות',
};
const ACTION_OP_HE = { membership_hold: 'הקפאת מנוי', membership_cancel: 'ביטול מנוי' };
const NOTIF_HE = { accepted: 'התראה למנהל: נשלחה', failed: 'התראה למנהל: נכשלה', pending: 'התראה למנהל: ממתינה', not_required: '' };
let _casesOpen = '1';

async function casePost(id, op, body = {}) {
  const r = await fetch('/api/tomer/cases/' + encodeURIComponent(id) + '/' + op, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, ...j };
}

function renderCase(c, labels) {
  const a = c.action;
  const open = ['awaiting_member', 'awaiting_staff', 'in_progress'].includes(c.status);
  const last = [...(c.context || [])].reverse().find(x => x.from === 'member');
  const btn = (op, label, cls = 'btn-secondary') => '<button class="btn ' + cls + ' tw-case-btn" data-op="' + op + '" data-id="' + esc(c.id) + '">' + label + '</button>';
  const buttons = [];
  if (a && open) {
    if (a.state === 'awaiting_approval') { buttons.push(btn('approve', 'אשר', 'btn-primary')); buttons.push(btn('reject', 'דחה', 'btn-danger')); }
    if (a.state === 'approved') buttons.push(btn('execute-now', 'בצע עכשיו ב-Arbox', 'btn-primary'));
    if (['awaiting_manual', 'not_verified', 'failed', 'uncertain'].includes(a.state)) buttons.push(btn('mark-executed', 'בוצע ב-Arbox — אמת', 'btn-primary'));
    if (['uncertain', 'not_verified', 'executing'].includes(a.state)) buttons.push(btn('recheck', 'בדוק שוב ב-Arbox'));
  }
  if (open) { buttons.push(btn('assign', 'שייך אליי')); buttons.push(btn('reply', 'השב לחבר/ה')); buttons.push(btn('resolve', 'סגור פנייה')); }
  if (c.notification && c.notification.state === 'failed') buttons.push(btn('retry-notification', 'שלח שוב התראה למנהל'));
  const actionLine = a
    ? '<div class="tw-case-action" data-state="' + esc(a.state) + '">⚙️ ' + esc(ACTION_OP_HE[a.op] || a.op)
      + (a.args && a.args.from ? ' · ' + esc(a.args.from) + ' – ' + esc(a.args.to) : '')
      + ' · <strong>' + esc(ACTION_STATE_HE[a.state] || a.state) + '</strong>'
      + (a.heldForTakeover ? ' · השיחה בטיפול אנושי' : '') + '</div>'
    : '';
  const notice = c.memberNotice ? '<div class="tw-case-meta">עדכון לחבר/ה: ' + esc(c.memberNotice.state === 'withheld' ? 'לא נשלח (' + (c.memberNotice.reason === 'human_owns' ? 'שיחה בטיפול אנושי' : 'ביקש/ה לא לקבל הודעות') + ')' : 'נשלח') + '</div>' : '';
  return '<div class="tw-case-card" data-case="' + esc(c.id) + '" data-status="' + esc(c.status) + '">'
    + '<div class="tw-case-head">' + (c.priority === 'high' ? '<span class="tw-case-prio">דחוף</span> ' : '')
    + '<strong>' + esc(labels[c.category] || c.category) + '</strong> · ' + esc(c.memberName || 'חבר/ה') + ' · <span dir="ltr">' + esc(c.phone) + '</span>'
    + '<span class="tw-case-status">' + esc(CASE_STATUS_HE[c.status] || c.status) + '</span></div>'
    + (last ? '<div class="tw-case-text">"' + esc(last.text) + '"</div>' : '')
    + (c.facts && c.facts.summary ? '<div class="tw-case-meta">📊 Arbox: ' + esc(c.facts.summary) + '</div>' : '')
    + actionLine
    + (c.nextAction && open ? '<div class="tw-case-meta">➡️ ' + esc(c.nextAction) + '</div>' : '')
    + (c.resolution ? '<div class="tw-case-meta">נסגר: ' + esc(c.resolution.note || 'ללא הערה') + ' (' + esc(c.resolution.by) + ')</div>' : '')
    + notice
    + '<div class="tw-case-meta">' + esc(c.id) + ' · אחראי/ת: ' + esc(c.owner) + ' · ' + esc(fmtDate(c.updatedAt)) + (c.notification ? ' · ' + esc(NOTIF_HE[c.notification.state] || '') : '') + '</div>'
    + (buttons.length ? '<div class="tw-case-btns">' + buttons.join('') + '</div>' : '')
    + '</div>';
}

async function loadCases() {
  const list = $id('tw-cases-list');
  if (!list) return;
  let d;
  try { d = await api('/api/tomer/cases?open=' + _casesOpen); } catch { d = null; }
  if (!d || !d.ok) { list.innerHTML = '<div class="tw-empty">שגיאה בטעינת הפניות</div>'; return; }
  const w = $id('tw-cases-writes');
  if (w) {
    const on = Object.values(d.arboxWrites || {}).some(x => x.executable);
    w.textContent = on ? 'פעולות מנוי מבוצעות מול Arbox אוטומטית לאחר אישור.' : 'כתיבה ל-Arbox כבויה: אחרי אישור, מבצעים את הפעולה ב-Arbox ולוחצים "בוצע ב-Arbox — אמת". החבר/ה מקבל/ת עדכון רק אחרי ש-Arbox מציג את השינוי.';
  }
  if (_casesOpen === '1') { const b = $id('tw-badge-cases'); if (b) b.textContent = d.cases.length ? String(d.cases.length) : ''; }
  list.innerHTML = d.cases.length ? d.cases.map(c => renderCase(c, d.categories || {})).join('') : '<div class="tw-empty">' + (_casesOpen === '1' ? 'אין פניות פתוחות' : 'אין פניות סגורות') + '</div>';
}

const CASE_ERR_HE = { invalid_args: 'חסרים פרטים לפעולה (למשל תאריכים או זיהוי מנוי)', not_awaiting_approval: 'הפעולה כבר הוכרעה', writes_disabled: 'כתיבה ל-Arbox כבויה', bad_state: 'הפעולה לא במצב מתאים', action_in_flight: 'פעולה מתבצעת כרגע — לא ניתן לסגור', text_required: 'נדרש טקסט', not_found: 'הפנייה לא נמצאה' };
async function runCaseOp(id, op, body) {
  const r = await casePost(id, op, body);
  if (r.ok === false || r.status >= 400) toast(CASE_ERR_HE[r.error] || 'הפעולה נכשלה', false);
  else if (op === 'mark-executed' || op === 'recheck') toast(r.verified ? 'אומת ב-Arbox ✓' : 'Arbox עדיין לא מציג את השינוי', !!r.verified);
  else toast('בוצע');
  await loadCases();
}
$id('tw-cases-list')?.addEventListener('click', e => {
  const b = e.target.closest('.tw-case-btn');
  if (!b) return;
  const id = b.dataset.id, op = b.dataset.op;
  if (op === 'reject')       return promptModal('דחיית הבקשה — הערה לחבר/ה (לא חובה)', 'סיבה', note => runCaseOp(id, op, { note: note || null }));
  if (op === 'resolve')      return promptModal('סגירת פנייה — הערת סיכום', 'מה נעשה', note => runCaseOp(id, op, { note: note || null }));
  if (op === 'reply')        return promptModal('הודעה לחבר/ה (נשלחת בשם הצוות; תומר מפסיק לענות בשיחה)', 'טקסט ההודעה', text => { if (text && text.trim()) runCaseOp(id, op, { text }); });
  if (op === 'approve')      return confirmModal('לאשר את הפעולה?', () => runCaseOp(id, op, {}));
  if (op === 'execute-now')  return confirmModal('לבצע עכשיו מול Arbox?', () => runCaseOp(id, op, {}));
  if (op === 'assign')       return runCaseOp(id, op, { to: 'צוות' });
  return runCaseOp(id, op, {});
});
document.querySelectorAll('#twp-cases .filter-btn').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('#twp-cases .filter-btn').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); _casesOpen = b.dataset.cf; loadCases();
}));
document.querySelector('.tw-tab[data-pane="cases"]')?.addEventListener('click', loadCases);
$id('tw-refresh')?.addEventListener('click', () => { if (document.querySelector('.tw-tab.active')?.dataset.pane === 'cases') loadCases(); });
document.querySelector('.tab-btn[data-tab="tomer"]')?.addEventListener('click', loadCases);
