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
    const [board, sc, today, sys] = await Promise.all([
      api('/api/tomer/board'), api('/api/crm/stage-counts'), api('/api/crm/today'), api('/api/system/status'),
    ]);
    if (!board.ok || !board.data) { root.innerHTML = '<div class="empty-state">לא ניתן לטעון את לוח הבקרה.</div>'; return; }
    const b = board.data, items = new Map((b.items || []).map(x => [x.key, x]));
    const needsOwner = (b.today?.needsOwner || []).map(k => items.get(k)).filter(Boolean);
    const counts = b.counts || {};
    const stage = (sc.data?.counts) || {};
    const crmActive = Object.values(stage).reduce((a, v) => a + v, 0);
    const tc = today.data?.counts || {};
    const srcErr = b.sourceError ? `<span class="mc-pill warn" title="${esc(b.sourceError)}">מקור נתונים חלקי</span>` : '';

    const tiles = [
      { k: 'needsOwner', v: counts.needsOwner ?? needsOwner.length, l: 'דורש אותך', c: 'var(--hot,#e53e3e)', go: goBoard },
      { k: 'overdue', v: counts.overdue ?? 0, l: 'באיחור', c: 'var(--hot,#e53e3e)', go: goBoard },
      { k: 'stuck', v: counts.stuck ?? 0, l: 'תקועות', c: 'var(--warm,#dd8800)', go: goBoard },
      { k: 'crm', v: crmActive, l: 'לידים פעילים', c: 'var(--primary,#6b46c1)', go: goCrm },
      { k: 'calls', v: tc.scheduledCalls ?? 0, l: 'שיחות היום', c: 'var(--primary,#6b46c1)', go: goCrm },
    ];

    const STAGE_HE = { new: 'חדש', needs: 'בירור', arranging_call: 'תיאום', call_scheduled: 'שיחה', trial_scheduled: 'ניסיון', trial_attended: 'הגיע', registered: 'נרשם', lost: 'לא נסגר' };
    const stageBar = Object.entries(STAGE_HE).filter(([k]) => (stage[k] ?? 0) > 0).map(([k, he]) => `<div class="mc-stage">${esc(he)}: <b>${stage[k]}</b></div>`).join('') || '<span class="mc-note">אין לידים פעילים</span>';

    const rows = needsOwner.slice(0, 12).map(x => `<div class="mc-row">
      <span class="t"><b>${esc(x.agent === 'barak' ? 'ברק' : 'תומר')}</b> · ${esc(x.kind || '')}: ${esc(x.title || '')}${x.who ? ' — ' + esc(x.who) : ''}</span>
      <span class="mc-pill ${x.overdue ? 'bad' : 'warn'}">${esc(x.boardLabel || '')}${x.waiting ? ' · ' + esc(x.waiting) : ''}</span>
      <span style="display:flex;gap:6px"><button class="mc-btn" data-done="${esc(x.key)}">בוצע</button><button class="mc-btn sec" data-snooze="${esc(x.key)}">דחה</button></span>
    </div>`).join('') || '<div class="mc-note">אין משימות שדורשות אותך כרגע 🎉</div>';

    const sysRows = (sys.data?.rows || sys.data?.statuses || []);
    const bad = sysRows.filter(r => r.state && !['live', 'ok', 'on', 'green', 'info'].includes(r.state));
    const health = !sysRows.length ? '<span class="mc-note">—</span>'
      : bad.length ? bad.slice(0, 6).map(r => `<div class="mc-row"><span class="t">${esc(r.label || r.id || '')}</span><span class="mc-pill warn">${esc(r.detail || r.state)}</span></div>`).join('')
        : '<span class="mc-pill ok">כל המערכות תקינות</span>';

    root.innerHTML = `
      <div class="mc-note">בקרה ומשימות — מעל לוח המשימות האחד (ברק ותומר) ומחובר ל-CRM המכירות. ${srcErr}</div>
      <div class="mc-tiles">${tiles.map(t => `<div class="mc-tile" data-go="${t.k}" style="--c:${t.c}"><div class="v">${t.v}</div><div class="l">${t.l}</div></div>`).join('')}</div>

      <div class="mc-sec"><h3>משימות שדורשות אותך <button class="mc-btn sec" id="mc-board">הלוח המלא ←</button></h3>${rows}</div>

      <div class="mc-sec"><h3>משפך מכירות (CRM) <button class="mc-btn sec" id="mc-crm">פתח CRM ←</button></h3>
        <div class="mc-stages">${stageBar}</div>
        <div class="mc-note">שיחות היום: ${tc.scheduledCalls ?? 0} · ממתינים לצוות: ${tc.waitingStaff ?? 0} · ללא מענה: ${tc.unanswered ?? 0}</div>
      </div>

      <div class="mc-sec"><h3>מצב מערכת</h3>${health}</div>`;

    root.querySelectorAll('[data-go]').forEach(t => t.addEventListener('click', () => { const k = t.dataset.go; (k === 'crm' || k === 'calls') ? goCrm() : goBoard(); }));
    $('#mc-board', root)?.addEventListener('click', goBoard);
    $('#mc-crm', root)?.addEventListener('click', goCrm);
    root.querySelectorAll('[data-done]').forEach(b2 => b2.addEventListener('click', async () => { await act(b2.dataset.done, 'done'); loadControl(); }));
    root.querySelectorAll('[data-snooze]').forEach(b2 => b2.addEventListener('click', async () => { const d = prompt('דחה עד תאריך (YYYY-MM-DD):', new Date(Date.now() + 86400000).toISOString().slice(0, 10)); if (d) { await act(b2.dataset.snooze, 'snooze', { until: new Date(d + 'T08:00:00+02:00').toISOString() }); loadControl(); } }));
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
