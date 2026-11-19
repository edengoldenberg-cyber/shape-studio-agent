/* ════════════════════════════════════════════════════════════════════════════
   Maya — team-management & control dashboard (Maya tab).
   A control + tasks view and a reminders screen, composed over the stores that
   already exist (owner_tasks ONE board, CRM, system status) — no new mechanism,
   no second reminder. window.MAYA = { loadControl, loadReminders }.
   ════════════════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = async (url, opts) => { const r = await fetch(url, opts); let d = null; try { d = await r.json(); } catch {} return { status: r.status, ok: r.ok, data: d }; };
  const fmt = s => { if (!s) return '—'; try { return new Date(s).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; } };
  let CTRL = { board: null, today: null, sys: null, bucket: null, agent: '', assignee: '', q: '' };

  function injectStyle() {
    if ($('#maya-style')) return;
    document.head.appendChild(document.createElement('style')).id = 'maya-style';
    $('#maya-style').textContent = `
      #tab-maya .mc-tiles{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px}
      #tab-maya .mc-tile{flex:1 1 140px;min-width:140px;background:var(--panel,#fff);border:1px solid var(--border,#eee);border-right:4px solid var(--c,var(--primary,#6b46c1));border-radius:12px;padding:12px;cursor:pointer}
      #tab-maya .mc-tile .v{font-size:26px;font-weight:700}#tab-maya .mc-tile .l{font-size:13px;color:var(--muted,#888)}
      #tab-maya .mc-sec{background:var(--panel,#fff);border:1px solid var(--border,#eee);border-radius:12px;padding:12px 14px;margin-bottom:14px}
      #tab-maya .mc-sec h3{margin:0 0 10px;font-size:15px;display:flex;justify-content:space-between;align-items:center;gap:8px}
      #tab-maya .mc-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 0;border-bottom:1px dashed var(--border,#eee);font-size:14px}
      #tab-maya .mc-row .t{flex:1 1 180px}
      #tab-maya .mc-pill{border-radius:10px;padding:1px 8px;font-size:11px;background:var(--bg2,#f3f3f7)}
      #tab-maya .mc-pill.bad{background:#fde8e8;color:#c0392b}#tab-maya .mc-pill.warn{background:#fef3e0;color:#b9770e}#tab-maya .mc-pill.ok{background:#e6f6ec;color:#1e8449}
      #tab-maya .mc-btn{border:0;border-radius:9px;padding:7px 11px;font-size:13px;cursor:pointer;background:var(--primary,#6b46c1);color:#fff}
      #tab-maya .mc-btn.sec{background:var(--bg2,#eee);color:inherit;border:1px solid var(--border,#ddd)}
      #tab-maya .mc-bar{display:flex;gap:2px;border-radius:8px;overflow:hidden;margin:8px 0}
      #tab-maya .mc-bar span{padding:6px 4px;font-size:11px;color:#fff;text-align:center;min-width:28px}
      #tab-maya .mc-stages{display:flex;flex-wrap:wrap;gap:6px}
      #tab-maya .mc-stage{border:1px solid var(--border,#ddd);border-radius:10px;padding:6px 10px;font-size:13px}
      #tab-maya .mc-note{font-size:12px;color:var(--muted,#888);margin:4px 0}
      #tab-maya .mc-field{display:flex;flex-direction:column;gap:4px;font-size:13px}
      #tab-maya .mc-field input,#tab-maya .mc-field select{border:1px solid var(--border,#ddd);border-radius:8px;padding:8px;background:var(--bg2,#fafafa);color:inherit;min-height:40px}
      #tab-maya .mc-day{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
      #tab-maya .mc-chip{background:var(--bg2,#f3f3f7);border-radius:10px;padding:4px 10px;font-size:13px}
      #tab-maya .mc-filters{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
      #tab-maya .mc-filters select{border:1px solid var(--border,#ddd);border-radius:8px;padding:7px;background:var(--panel,#fff);color:inherit;min-height:40px}
      #tab-maya .mc-item{background:var(--panel,#fff);border:1px solid var(--border,#eee);border-radius:10px;padding:10px;margin-bottom:8px}
      #tab-maya .mc-item-h{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13px;color:var(--muted,#777);margin-bottom:2px}
      #tab-maya .mc-item-a{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
      #tab-maya .mc-mini{border:1px solid var(--border,#ddd);background:var(--bg2,#fafafa);color:inherit;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;min-height:36px}
      #tab-maya .mc-hist{margin-top:6px;border-top:1px dashed var(--border,#eee);padding-top:6px}
      #tab-maya .mc-wk{display:flex;flex-wrap:wrap;gap:6px}
      #tab-maya .mc-wk label{display:inline-flex;align-items:center;gap:4px;font-size:13px;border:1px solid var(--border,#ddd);border-radius:8px;padding:4px 8px}
      @media(max-width:560px){#tab-maya .mc-tile{flex:1 1 calc(50% - 10px)}}`;
  }

  function goCrm() { document.querySelector('.tab-btn[data-tab="barak"]')?.click(); setTimeout(() => document.querySelector('.barak-sv-btn[data-bview="crm"]')?.click(), 300); }
  function goBoard() { document.querySelector('.tab-btn[data-tab="tomer"]')?.click(); setTimeout(() => document.querySelector('.tw-tab[data-pane="tasks"]')?.click(), 300); }

  // ── control & tasks ───────────────────────────────────────────────────────────────────
  async function loadControl() {
    injectStyle();
    const root = $('#maya-control-root'); if (!root) return;
    const [board, today, sys] = await Promise.all([api('/api/tomer/board'), api('/api/crm/today'), api('/api/system/status')]);
    if (!board.ok || !board.data) { root.innerHTML = '<div class="empty-state">לא ניתן לטעון את לוח הבקרה.</div>'; return; }
    CTRL.board = board.data; CTRL.today = today.data; CTRL.sys = sys.data;
    renderControl();
  }

  // Which bucket a board item belongs to. The owner_tasks board already computed each item's state,
  // overdue flag, assignee, next action and source — Maya only groups and shows them (no parallel logic).
  const BUCKETS = [
    { id: 'needs_action', he: 'דורש פעולה', c: 'var(--hot,#e53e3e)', match: x => x.board === 'waiting_owner' || x.board === 'blocked' },
    { id: 'in_progress', he: 'בטיפול', c: 'var(--primary,#6b46c1)', match: x => x.board === 'in_progress' || x.board === 'todo' },
    { id: 'waiting_client', he: 'ממתין ללקוח', c: 'var(--warm,#dd8800)', match: x => x.board === 'waiting_member' },
    { id: 'planned', he: 'מתוכנן', c: 'var(--muted,#888)', match: x => x.board === 'planned' },
    { id: 'overdue', he: 'באיחור', c: 'var(--hot,#e53e3e)', match: x => x.overdue === true },
    { id: 'stuck', he: 'תקוע/נכשל', c: 'var(--warm,#dd8800)', match: x => x.board === 'blocked' || x.board === 'waiting_external' },
    { id: 'done', he: 'הושלם', c: 'var(--green,#1e8449)', closed: true, match: x => x.state === 'done' },
    { id: 'cancelled', he: 'בוטל', c: 'var(--muted,#888)', closed: true, match: x => x.state === 'cancelled' },
  ];
  const agentHe = a => a === 'barak' ? 'ברק' : a === 'tomer' ? 'תומר' : a === 'dana' ? 'דנה' : (a || '');

  function renderControl() {
    const root = $('#maya-control-root'); if (!root) return;
    const b = CTRL.board, open = b.items || [], closed = b.recentDone || [];
    const srcErr = b.sourceError ? `<span class="mc-pill warn" title="${esc(b.sourceError)}">מקור חלקי: חלק מהמשימות אולי לא נקראו</span>` : '';
    const srcBad = Object.entries(b.sources || {}).filter(([, v]) => v && v.ok === false);
    const srcNote = srcBad.length ? `<div class="mc-note">⚠️ מקורות שלא נבדקו: ${srcBad.map(([k, v]) => esc(k) + (v.error ? ' (' + esc(v.error) + ')' : '')).join(', ')} — המשימות שלהם אינן ידועות, לא אפס.</div>` : '';
    const t = CTRL.today?.counts || {};
    // day summaries
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const inToday = open.filter(x => x.createdAt && new Date(x.createdAt) >= dayStart).length;
    const doneToday = closed.filter(x => x.closedAt && new Date(x.closedAt) >= dayStart).length;
    const count = bk => (bk.closed ? closed : open).filter(bk.match).length;

    const sysRows = (CTRL.sys?.rows) || [];
    const badSys = sysRows.filter(r => r.state && !['live', 'ok', 'on', 'green', 'info'].includes(r.state));
    const healthChip = sysRows.length ? (badSys.length ? `<span class="mc-chip" style="background:#fde8e8;color:#c0392b" title="${esc(badSys.map(r => (r.label || r.id) + ': ' + (r.detail || r.state)).join(' · '))}">מערכות בבעיה: ${badSys.length}</span>` : '<span class="mc-chip" style="background:#e6f6ec;color:#1e8449">מערכות תקינות</span>') : '';
    const filters = `<div class="mc-day"><span class="mc-chip">נכנס היום: <b>${inToday}</b></span><span class="mc-chip">טופל היום: <b>${doneToday}</b></span><span class="mc-chip">פתוח כעת: <b>${open.length}</b></span>${t.unanswered ? `<span class="mc-chip">ללא מענה (CRM): <b>${t.unanswered}</b></span>` : ''}${healthChip}</div>`;
    const tiles = `<div class="mc-tiles">${BUCKETS.map(bk => `<div class="mc-tile ${CTRL.bucket === bk.id ? 'on' : ''}" data-bucket="${bk.id}" style="--c:${bk.c}"><div class="v">${count(bk)}</div><div class="l">${bk.he}</div></div>`).join('')}</div>`;

    const staffSet = [...new Set(open.concat(closed).map(x => x.assignee).filter(Boolean))];
    const ctrlBar = `<div class="mc-filters">
      <select id="mc-agent"><option value="">כל הסוכנים</option><option value="barak" ${CTRL.agent === 'barak' ? 'selected' : ''}>ברק</option><option value="tomer" ${CTRL.agent === 'tomer' ? 'selected' : ''}>תומר</option><option value="dana" ${CTRL.agent === 'dana' ? 'selected' : ''}>דנה</option></select>
      <select id="mc-asg"><option value="">כל האחראים</option><option value="__none" ${CTRL.assignee === '__none' ? 'selected' : ''}>ללא אחראי</option>${staffSet.map(s => `<option value="${esc(s)}" ${CTRL.assignee === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>
      <input id="mc-q" placeholder="חיפוש" value="${esc(CTRL.q || '')}" style="flex:1;min-width:120px;border:1px solid var(--border,#ddd);border-radius:8px;padding:7px">
      <button class="mc-btn sec" id="mc-crm">CRM ←</button><button class="mc-btn sec" id="mc-board">הלוח ←</button>
    </div>`;

    // selected list
    const bk = BUCKETS.find(x => x.id === CTRL.bucket);
    let list = bk ? (bk.closed ? closed : open).filter(bk.match) : open;
    if (CTRL.agent) list = list.filter(x => x.agent === CTRL.agent);
    if (CTRL.assignee === '__none') list = list.filter(x => !x.assignee);
    else if (CTRL.assignee) list = list.filter(x => x.assignee === CTRL.assignee);
    if (CTRL.q) { const q = CTRL.q.toLowerCase(); list = list.filter(x => `${x.title || ''} ${x.who || ''} ${x.kind || ''}`.toLowerCase().includes(q)); }

    const card = x => {
      const closedItem = ['done', 'cancelled'].includes(x.state);
      const due = x.dueSetAt ? `${x.overdue ? '<span class="mc-pill bad">באיחור</span> ' : ''}עד ${fmt(x.dueSetAt)}` : `גיל ${esc(x.waiting || '—')} · <span class="mc-pill">ללא מועד</span>`;
      const acts = closedItem
        ? `<button class="mc-mini" data-act="reopen" data-key="${esc(x.key)}">פתח מחדש</button>`
        : `<button class="mc-mini" data-act="assign" data-key="${esc(x.key)}">שייך</button><button class="mc-mini" data-act="in_progress" data-key="${esc(x.key)}">בטיפול</button><button class="mc-mini" data-act="snooze" data-key="${esc(x.key)}">דחה</button><button class="mc-mini" data-act="done" data-key="${esc(x.key)}">בוצע</button><button class="mc-mini" data-act="cancel" data-key="${esc(x.key)}">בטל</button>`;
      return `<div class="mc-item">
        <div class="mc-item-h"><b>${esc(agentHe(x.agent))}</b> · ${esc(x.kind || '')}${x.who ? ' · ' + esc(x.who) : ''}
          <span class="mc-pill ${x.overdue ? 'bad' : closedItem ? 'ok' : 'warn'}">${esc(x.boardLabel || x.state || '')}</span></div>
        <div>${esc(x.title || '')}</div>
        <div class="mc-note">${x.reason ? 'מקור: ' + esc(x.reason) + ' · ' : ''}אחראי: ${x.assignee ? esc(x.assignee) : '<span class="mc-pill warn">ללא אחראי</span>'} · ${due}</div>
        ${x.next ? `<div class="mc-note">➡️ ${esc(x.next)}</div>` : ''}
        ${x.blocked ? `<div class="mc-note" style="color:var(--hot)">⚠️ ${esc(x.blocked)}</div>` : ''}
        <div class="mc-item-a">${acts}${x.link ? `<button class="mc-mini" data-src="${esc(x.link)}">פתח מקור ←</button>` : ''}<button class="mc-mini" data-hist="${esc(x.key)}">היסטוריה</button></div>
        <div class="mc-hist" id="h-${esc(x.key)}" hidden>${(x.trail || []).map(e => `<div class="mc-note">${e.at ? fmt(e.at) + ' · ' : ''}${esc(e.text || '')}</div>`).join('') || '<div class="mc-note">—</div>'}${closedItem && x.closedAt ? `<div class="mc-note">נסגר ${fmt(x.closedAt)}</div>` : ''}</div>
      </div>`;
    };

    root.innerHTML = `
      <div class="mc-note">בקרה ומשימות — לוח המשימות האחד של ברק, תומר ודנה. אותה משימה נספרת פעם אחת; משימה ללא אחראי מסומנת. ${srcErr}</div>
      ${srcNote}${filters}${tiles}${ctrlBar}
      <div class="mc-sec"><h3>${bk ? esc(bk.he) : 'כל הפתוחות'} — ${list.length} <span class="mc-note" id="mc-clear" style="cursor:pointer">${CTRL.bucket ? '· נקה סינון' : ''}</span></h3>
        ${list.length ? list.slice(0, 100).map(card).join('') : '<div class="mc-note">אין פריטים בקבוצה הזו 🎉</div>'}</div>`;

    const re = () => renderControl();
    $('#mc-agent', root).addEventListener('change', e => { CTRL.agent = e.target.value; re(); });
    $('#mc-asg', root).addEventListener('change', e => { CTRL.assignee = e.target.value; re(); });
    $('#mc-q', root).addEventListener('input', e => { CTRL.q = e.target.value; re(); });
    $('#mc-crm', root).addEventListener('click', goCrm);
    $('#mc-board', root).addEventListener('click', goBoard);
    $('#mc-clear', root)?.addEventListener('click', () => { CTRL.bucket = null; re(); });
    root.querySelectorAll('[data-bucket]').forEach(el => el.addEventListener('click', () => { CTRL.bucket = CTRL.bucket === el.dataset.bucket ? null : el.dataset.bucket; re(); }));
    root.querySelectorAll('[data-hist]').forEach(el => el.addEventListener('click', () => { const h = $('#h-' + CSS.escape(el.dataset.hist), root); if (h) h.hidden = !h.hidden; }));
    root.querySelectorAll('[data-src]').forEach(el => el.addEventListener('click', () => { const link = el.dataset.src; if (link.startsWith('#barak')) goCrm(); else if (link.startsWith('#tomer')) { location.hash = link; goBoard(); } }));
    root.querySelectorAll('[data-act]').forEach(el => el.addEventListener('click', async () => {
      const key = el.dataset.key, a = el.dataset.act, extra = {};
      if (a === 'assign') { const to = prompt('שם האחראי/ת:'); if (!to) return; extra.to = to; }
      if (a === 'snooze') { const d = prompt('דחה עד תאריך (YYYY-MM-DD):', new Date(Date.now() + 86400000).toISOString().slice(0, 10)); if (!d) return; extra.until = new Date(d + 'T08:00:00+02:00').toISOString(); }
      if (a === 'cancel') { const note = prompt('סיבת הביטול:'); if (note === null) return; extra.note = note; }
      el.disabled = true;
      await act(key, a, extra); await loadControl();
    }));
  }
  const act = (key, action, extra = {}) => api('/api/owner-tasks/act', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, action, by: 'עדן', ...extra }) });

  // ── reminders screen ──────────────────────────────────────────────────────────────────
  async function loadReminders() {
    injectStyle();
    const root = $('#maya-reminders-root'); if (!root) return;
    const board = await api('/api/tomer/board');
    const s = board.data?.settings || { enabled: false, times: [], weekdays: [0, 1, 2, 3, 4], minGapHours: 20 };
    const r = board.data?.reminders || {};
    const stateCls = r.state === 'on' ? 'ok' : r.state === 'failed' ? 'bad' : 'warn';
    const WD = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
    const wk = WD.map((d, i) => `<label><input type="checkbox" class="mc-wd" value="${i}" ${(s.weekdays || []).includes(i) ? 'checked' : ''}>${d}</label>`).join('');
    root.innerHTML = `
      <div class="mc-sec"><h3>מצב התזכורות <span class="mc-pill ${stateCls}">${r.state === 'on' ? 'פעיל' : r.state === 'off' ? 'כבוי' : r.state === 'failed' ? 'תקלה' : 'לא מוגדר'}</span></h3>
        <div class="mc-note">${esc(r.text || '')}</div>
        <div class="mc-row"><span class="t">תזכורת אחרונה</span><span>${fmt(r.lastAt)} ${r.lastState ? '· ' + esc(r.lastState) : ''}</span></div>
        <div class="mc-row"><span class="t">תזכורת הבאה</span><span>${r.nextAt ? esc(String(r.nextAt)) : '—'}</span></div>
        <div class="mc-note">✅ תזכורת מרוכזת אחת בכל שעה מוגדרת — אותה משימה לא תוזכר שוב בתוך חלון המרווח. אין סיכומים כפולים: זו תזכורת המנהל היחידה (דוח 20:00 כבוי; תדריך 08:00 נרשם ביומן בלבד). משימות ה-CRM מופיעות באותה תזכורת.</div>
      </div>
      <div class="mc-sec"><h3>הגדרות</h3>
        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end">
          <div class="mc-field"><label>שעות שליחה (מופרדות בפסיק)</label><input id="mr-times" value="${esc((s.times || []).join(', '))}" placeholder="09:00, 17:00"></div>
          <div class="mc-field"><label>מרווח בין תזכורות לאותה משימה (שעות)</label><input id="mr-gap" type="number" min="1" max="168" value="${s.minGapHours ?? 20}"></div>
        </div>
        <div class="mc-field" style="margin-top:10px"><label>ימים</label><div class="mc-wk">${wk}</div></div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="mc-btn" id="mr-save">💾 שמירה</button>
          <button class="mc-btn sec" id="mr-toggle">${s.enabled ? '⏸️ כבה תזכורות' : '▶️ הפעל תזכורות'}</button>
          <button class="mc-btn sec" id="mr-preview">👁️ תצוגה מקדימה</button>
        </div>
        <div id="mr-msg" class="mc-note"></div>
        <div id="mr-preview-box"></div>
      </div>`;
    const times = () => $('#mr-times', root).value.split(',').map(x => x.trim()).filter(Boolean);
    const weekdays = () => [...root.querySelectorAll('.mc-wd:checked')].map(c => Number(c.value));
    const save = async (enabledOverride) => {
      const body = { times: times(), minGapHours: Number($('#mr-gap', root).value) || 20, weekdays: weekdays(), by: 'עדן' };
      if (enabledOverride !== undefined) body.enabled = enabledOverride; else body.enabled = s.enabled;
      const res = await api('/api/owner-tasks/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const msg = $('#mr-msg', root);
      if (res.ok && res.data?.ok) { msg.textContent = 'נשמר ✓'; loadReminders(); } else msg.textContent = res.data?.error === 'times_required' ? 'כדי להפעיל צריך לפחות שעה אחת' : 'השמירה נכשלה';
    };
    $('#mr-save', root).addEventListener('click', () => save());
    $('#mr-toggle', root).addEventListener('click', () => save(!s.enabled));
    $('#mr-preview', root).addEventListener('click', async () => {
      const p = await api('/api/owner-tasks/preview');
      $('#mr-preview-box', root).innerHTML = p.data?.ok ? `<div class="mc-sec" style="margin-top:10px;white-space:pre-wrap;font-size:13px">${esc(p.data.text || 'אין משימות שממתינות לתזכורת כרגע.')}</div>` : '';
    });
  }

  // ── sub-nav ───────────────────────────────────────────────────────────────────────────
  function switchView(v) {
    document.querySelectorAll('#maya-subnav .barak-sv-btn').forEach(b => b.classList.toggle('active', b.dataset.mview === v));
    ['overview', 'control', 'reminders'].forEach(x => { const el = document.getElementById('maya-view-' + x); if (el) el.style.display = x === v ? '' : 'none'; });
    if (v === 'control') loadControl();
    if (v === 'reminders') loadReminders();
  }
  function init() {
    const nav = document.getElementById('maya-subnav'); if (!nav) return;
    nav.querySelectorAll('.barak-sv-btn').forEach(b => b.addEventListener('click', () => switchView(b.dataset.mview)));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
  window.MAYA = { loadControl, loadReminders };
})();
