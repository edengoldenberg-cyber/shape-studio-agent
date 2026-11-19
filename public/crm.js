/* ════════════════════════════════════════════════════════════════════════════
   Shape Studio — Sales CRM (Barak tab · "לידים")
   Self-contained. Mounts into #crm-root. window.CRM = { load, refreshIfVisible }.
   Reads/writes only the /api/crm/* endpoints (one data model, no parallel store).
   Hebrew + RTL. Works on desktop (table / stage board) and phone (compact list, no drag).
   ════════════════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (tag, attrs = {}, html) => { const e = document.createElement(tag); for (const [k, v] of Object.entries(attrs)) { if (k === 'class') e.className = v; else if (k === 'dataset') Object.assign(e.dataset, v); else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v); else if (v != null) e.setAttribute(k, v); } if (html != null) e.innerHTML = html; return e; };
  const api = async (url, opts) => { const r = await fetch(url, opts); let d = null; try { d = await r.json(); } catch {} return { status: r.status, ok: r.ok, data: d }; };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  // ── persisted view state (survives card open + refresh) ──────────────────────────────
  const SKEY = 'crm.state.v2';
  const defState = { q: '', stage: '', assignee: '', source: '', interest: '', owner: '', view: '', sort: 'recent', bin: 'active', mode: 'table' };
  let S = (() => { try { return { ...defState, ...(JSON.parse(localStorage.getItem(SKEY) || '{}')) }; } catch { return { ...defState }; } })();
  const saveS = () => { try { localStorage.setItem(SKEY, JSON.stringify(S)); } catch {} };

  let META = null, LAST = { rows: [], total: 0, byStage: {} }, SEL = new Set(), mounted = false, loading = false, lastError = null;

  const STAGE_CLS = { new: 'muted', needs: 'warm', arranging_call: 'warm', call_scheduled: 'hot', trial_scheduled: 'hot', trial_attended: 'green', registered: 'green', lost: 'muted' };
  const stageHe = id => (META?.stages.find(s => s.id === id)?.he) ?? id;
  const local05 = p => (p && String(p).startsWith('972') ? '0' + String(p).slice(3) : (p ?? '—'));
  const fmtDate = s => { if (!s) return '—'; try { return new Date(s).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return '—'; } };
  const fmtDay = s => { if (!s) return '—'; try { return new Date(s).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric' }); } catch { return '—'; } };
  const fromNow = s => { if (!s) return ''; const d = Date.now() - new Date(s).getTime(); const m = Math.round(d / 60000); if (m < 1) return 'עכשיו'; if (m < 60) return `לפני ${m} ד׳`; const h = Math.round(m / 60); if (h < 24) return `לפני ${h} ש׳`; return `לפני ${Math.round(h / 24)} י׳`; };

  // ── style (scoped, theme-friendly) ────────────────────────────────────────────────────
  function injectStyle() {
    if ($('#crm-style')) return;
    document.head.appendChild(el('style', { id: 'crm-style' }, `
      #crm-root{--crm-gap:10px}
      .crm-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px}
      .crm-search{flex:1 1 240px;min-width:180px;display:flex;align-items:center;gap:6px;background:var(--panel,#fff);border:2px solid var(--primary,#6b46c1);border-radius:12px;padding:8px 12px}
      .crm-search input{flex:1;border:0;background:transparent;font-size:16px;color:inherit;outline:none}
      .crm-chip{border:1px solid var(--border,#ddd);background:var(--panel,#fff);color:inherit;border-radius:20px;padding:6px 12px;font-size:13px;cursor:pointer;white-space:nowrap}
      .crm-chip.active{background:var(--primary,#6b46c1);color:#fff;border-color:var(--primary,#6b46c1)}
      .crm-views{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;-webkit-overflow-scrolling:touch}
      .crm-filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px}
      .crm-filters select{border:1px solid var(--border,#ddd);border-radius:8px;padding:6px 8px;background:var(--panel,#fff);color:inherit;font-size:13px}
      .crm-count{font-size:13px;color:var(--muted,#888);margin-inline-start:auto}
      .crm-btn{border:0;border-radius:10px;padding:8px 12px;font-size:14px;cursor:pointer;background:var(--primary,#6b46c1);color:#fff}
      .crm-btn.sec{background:var(--panel,#eee);color:inherit;border:1px solid var(--border,#ddd)}
      .crm-btn.danger{background:var(--hot,#e53e3e);color:#fff}
      .crm-list{display:flex;flex-direction:column;gap:8px}
      .crm-card{display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;align-items:center;background:var(--panel,#fff);border:1px solid var(--border,#eee);border-right:4px solid var(--c,#ccc);border-radius:12px;padding:10px 12px;cursor:pointer}
      .crm-card:hover{border-color:var(--primary,#6b46c1)}
      .crm-card .nm{font-weight:600;font-size:15px}
      .crm-card .sub{font-size:12px;color:var(--muted,#888);grid-column:2}
      .crm-card .meta{grid-column:1 / -1;display:flex;flex-wrap:wrap;gap:6px;font-size:12px;color:var(--muted,#777);margin-top:2px}
      .crm-pill{border-radius:10px;padding:1px 8px;font-size:11px;background:var(--bg2,#f3f3f7)}
      .crm-pill.hot{background:#fde8e8;color:#c0392b}.crm-pill.warm{background:#fef3e0;color:#b9770e}.crm-pill.green{background:#e6f6ec;color:#1e8449}.crm-pill.muted{background:#eee;color:#666}
      .crm-sel{width:20px;height:20px}
      .crm-empty{padding:28px 12px;text-align:center;color:var(--muted,#888)}
      .crm-empty.err{color:var(--hot,#e53e3e)}
      .crm-board{display:flex;gap:10px;overflow-x:auto;padding-bottom:8px}
      .crm-col{flex:0 0 240px;background:var(--bg2,#f6f6fa);border-radius:12px;padding:8px}
      .crm-col h4{margin:4px 6px 8px;font-size:13px;display:flex;justify-content:space-between}
      .crm-col .crm-card{grid-template-columns:1fr;cursor:pointer}
      .crm-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;z-index:1000;overflow:auto;padding:16px}
      .crm-modal{background:var(--panel,#fff);color:inherit;border-radius:16px;max-width:640px;width:100%;margin:24px auto;padding:16px 18px;box-shadow:0 12px 40px rgba(0,0,0,.3)}
      .crm-modal h3{margin:0 0 4px}
      .crm-modal .row{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0;align-items:center}
      .crm-modal label{font-size:12px;color:var(--muted,#888);display:block;margin-bottom:2px}
      .crm-modal input,.crm-modal select,.crm-modal textarea{width:100%;border:1px solid var(--border,#ddd);border-radius:8px;padding:8px;background:var(--bg2,#fafafa);color:inherit;font-size:14px;box-sizing:border-box}
      .crm-field{flex:1 1 160px}
      .crm-actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
      .crm-actions a,.crm-actions button{flex:1 1 auto;text-align:center;text-decoration:none}
      .crm-tl{max-height:260px;overflow:auto;border-top:1px solid var(--border,#eee);margin-top:8px;padding-top:8px}
      .crm-tl .it{display:flex;gap:8px;font-size:13px;padding:4px 0;border-bottom:1px dashed var(--border,#eee)}
      .crm-tl .it .t{color:var(--muted,#999);flex:0 0 auto;font-size:11px}
      .crm-sec{margin-top:12px;border-top:1px solid var(--border,#eee);padding-top:10px}
      .crm-sec h5{margin:0 0 6px;font-size:13px}
      .crm-ai{background:#eef3fb;border-radius:8px;padding:8px;font-size:12px}
      .crm-tag{display:inline-flex;align-items:center;gap:4px;background:var(--bg2,#eef);border-radius:12px;padding:2px 8px;font-size:12px}
      .crm-bulkbar{position:sticky;bottom:0;background:var(--panel,#fff);border:1px solid var(--border,#ddd);border-radius:12px;padding:8px 12px;display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
      .crm-note{font-size:12px;color:var(--muted,#888);margin:2px 0 10px}
      @media(max-width:560px){.crm-card{grid-template-columns:auto 1fr}.crm-card .act{grid-column:1 / -1;display:flex;gap:6px;margin-top:4px}.crm-count{width:100%;margin:4px 0}}
    `));
  }

  // ── root + initial chrome ─────────────────────────────────────────────────────────────
  function root() { return $('#crm-root'); }
  function ensureMount() {
    const r = root(); if (!r) return false;
    if (mounted) return true;
    injectStyle();
    r.innerHTML = `
      <div class="crm-note" id="crm-headnote"></div>
      <div class="crm-bar">
        <div class="crm-search"><span>🔎</span><input id="crm-q" type="search" placeholder="חיפוש: שם, טלפון (05/972/חלק ממספר) או תגית" autocomplete="off"></div>
        <button class="crm-btn" id="crm-add">➕ ליד חדש</button>
        <button class="crm-btn sec" id="crm-mode">🗂️ לוח שלבים</button>
      </div>
      <div class="crm-views" id="crm-views"></div>
      <div class="crm-filters" id="crm-filters"></div>
      <div id="crm-results"><div class="crm-empty">טוען…</div></div>
      <div id="crm-bulk"></div>`;
    $('#crm-q').value = S.q;
    $('#crm-q').addEventListener('input', debounce(e => { S.q = e.target.value; saveS(); refresh(); }, 300));
    $('#crm-add').addEventListener('click', openCreate);
    $('#crm-mode').addEventListener('click', () => { S.mode = S.mode === 'table' ? 'board' : 'table'; saveS(); renderResults(); $('#crm-mode').textContent = S.mode === 'table' ? '🗂️ לוח שלבים' : '📋 טבלה'; });
    $('#crm-mode').textContent = S.mode === 'table' ? '🗂️ לוח שלבים' : '📋 טבלה';
    mounted = true;
    return true;
  }

  function renderViews() {
    const box = $('#crm-views'); if (!box) return;
    const bins = [['active', 'פעילים'], ['archive', 'ארכיון'], ['trash', 'סל מחזור']];
    const chips = [];
    for (const [id, he] of bins) chips.push(`<button class="crm-chip ${S.bin === id ? 'active' : ''}" data-bin="${id}">${he}</button>`);
    chips.push('<span style="width:8px"></span>');
    chips.push(`<button class="crm-chip ${!S.view ? 'active' : ''}" data-view="">הכל</button>`);
    for (const v of (META?.savedViews ?? [])) chips.push(`<button class="crm-chip ${S.view === v.id ? 'active' : ''}" data-view="${v.id}">${esc(v.he)}</button>`);
    box.innerHTML = chips.join('');
    box.querySelectorAll('[data-bin]').forEach(b => b.addEventListener('click', () => { S.bin = b.dataset.bin; if (S.bin !== 'active') S.view = ''; saveS(); renderViews(); refresh(); }));
    box.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { S.view = b.dataset.view; saveS(); renderViews(); refresh(); }));
  }

  function opt(val, label, cur) { return `<option value="${esc(val)}" ${cur === val ? 'selected' : ''}>${esc(label)}</option>`; }
  function renderFilters() {
    const box = $('#crm-filters'); if (!box || !META) return;
    const stageOpts = ['<option value="">כל השלבים</option>'].concat(META.stages.map(s => opt(s.id, s.he, S.stage))).join('');
    const asgOpts = ['<option value="">כל האחראים</option>', opt('__none', 'ללא אחראי', S.assignee)].concat(META.staff.map(s => opt(s.id, s.name, S.assignee))).join('');
    const srcOpts = ['<option value="">כל המקורות</option>'].concat((META.sources ?? []).map(s => opt(s, s, S.source))).join('');
    const intOpts = ['<option value="">כל התחומים</option>'].concat((META.interests ?? []).map(s => opt(s, s, S.interest))).join('');
    const ownOpts = ['<option value="">כל הבעלויות</option>', opt('barak', 'ברק', S.owner), opt('staff', 'צוות (טיפול ידני)', S.owner), opt('opted_out', 'הסרה', S.owner), opt('member', 'מנוי', S.owner)].join('');
    const sortOpts = [['recent', 'פעילות אחרונה'], ['newest', 'חדש ביותר'], ['due', 'מועד טיפול'], ['priority', 'עדיפות'], ['stage', 'שלב']].map(([v, l]) => opt(v, l, S.sort)).join('');
    box.innerHTML = `
      <select id="f-stage">${stageOpts}</select>
      <select id="f-asg">${asgOpts}</select>
      <select id="f-src">${srcOpts}</select>
      <select id="f-int">${intOpts}</select>
      <select id="f-own">${ownOpts}</select>
      <select id="f-sort">${sortOpts}</select>
      <span class="crm-count" id="crm-count"></span>`;
    const bind = (id, key) => $(id).addEventListener('change', e => { S[key] = e.target.value; saveS(); refresh(); });
    bind('#f-stage', 'stage'); bind('#f-asg', 'assignee'); bind('#f-src', 'source'); bind('#f-int', 'interest'); bind('#f-own', 'owner'); bind('#f-sort', 'sort');
  }

  // ── data ──────────────────────────────────────────────────────────────────────────────
  function qs() {
    const p = new URLSearchParams();
    if (S.q) p.set('q', S.q);
    if (S.stage) p.set('stage', S.stage);
    if (S.assignee) p.set('assignee', S.assignee === '__none' ? '' : S.assignee);
    if (S.source) p.set('source', S.source);
    if (S.interest) p.set('interest', S.interest);
    if (S.owner) p.set('owner', S.owner);
    if (S.view) p.set('view', S.view);
    p.set('sort', S.sort);
    p.set('crmState', S.bin);
    return p.toString();
  }
  async function refresh() {
    if (!ensureMount()) return;
    loading = true; lastError = null;
    const res = await api('/api/crm/search?' + qs());
    loading = false;
    if (!res.ok || !res.data || res.data.ok === false) { lastError = res.data?.message || 'שגיאת טעינה'; renderResults(); return; }
    let rows = res.data.rows ?? [];
    if (S.assignee === '__none') rows = rows.filter(r => !r.assignee);   // "ללא אחראי" handled client-side (empty string filter is ambiguous)
    LAST = { rows, total: S.assignee === '__none' ? rows.length : (res.data.total ?? rows.length), byStage: res.data.byStage ?? {} };
    SEL = new Set([...SEL].filter(ph => rows.some(r => r.phone === ph)));
    renderResults(); renderBulk();
    const c = $('#crm-count'); if (c) c.textContent = `${LAST.total} רשומות`;
    try { const y = parseInt(sessionStorage.getItem('crm.scroll') || '0', 10); if (y) window.scrollTo(0, y); } catch {}
  }

  function card(r) {
    const c = STAGE_CLS[r.stage] || 'muted';
    const na = r.nextAction;
    const sub = [r.interest, r.source].filter(Boolean).join(' · ');
    const metaBits = [
      `<span class="crm-pill ${c}">${esc(stageHe(r.stage))}</span>`,
      r.owner === 'staff' ? '<span class="crm-pill warm">טיפול ידני</span>' : '',
      r.assignee ? `<span class="crm-pill">${esc(META?.staff.find(s => s.id === r.assignee)?.name ?? r.assignee)}</span>` : '',
      na ? `<span class="crm-pill" title="פעולה הבאה">➡️ ${esc(na.text)}${na.dueAt ? ' · ' + fmtDay(na.dueAt) : ''}</span>` : '<span class="crm-pill muted">ללא פעולה הבאה</span>',
      r.callbackAt ? `<span class="crm-pill hot">📞 ${fmtDate(r.callbackAt)}</span>` : '',
      r.openTasks ? `<span class="crm-pill">✔️ ${r.openTasks} משימות</span>` : '',
      (r.tags || []).map(t => `<span class="crm-tag">#${esc(t)}</span>`).join(''),
    ].filter(Boolean).join('');
    const checked = SEL.has(r.phone) ? 'checked' : '';
    return `<div class="crm-card" style="--c:var(--${c === 'muted' ? 'muted' : c === 'hot' ? 'hot' : c === 'warm' ? 'warm' : 'green'},#ccc)" data-phone="${esc(r.phone)}">
      <input type="checkbox" class="crm-sel" data-phone="${esc(r.phone)}" ${checked} onclick="event.stopPropagation()">
      <div><div class="nm">${esc(r.name || local05(r.phone))}</div><div class="sub">${esc(local05(r.phone))}${sub ? ' · ' + esc(sub) : ''}</div></div>
      <div class="t" style="font-size:12px;color:var(--muted,#999);text-align:left">${fromNow(r.lastActivity)}</div>
      <div class="meta">${metaBits}</div>
    </div>`;
  }

  function renderResults() {
    const box = $('#crm-results'); if (!box) return;
    if (loading) { box.innerHTML = '<div class="crm-empty">טוען…</div>'; return; }
    if (lastError) { box.innerHTML = `<div class="crm-empty err">⚠️ ${esc(lastError)} — נסו שוב בעוד רגע.</div>`; return; }
    const rows = LAST.rows;
    if (!rows.length) { box.innerHTML = `<div class="crm-empty">${S.q || S.stage || S.view ? 'אין תוצאות לחיפוש הזה' : (S.bin === 'trash' ? 'סל המחזור ריק' : S.bin === 'archive' ? 'אין רשומות בארכיון' : 'אין לידים פעילים')}</div>`; return; }
    if (S.mode === 'board' && S.bin === 'active') { renderBoard(box, rows); }
    else { box.innerHTML = `<div class="crm-list">${rows.map(card).join('')}</div>`; }
    box.querySelectorAll('.crm-card').forEach(c => c.addEventListener('click', () => openCard(c.dataset.phone)));
    box.querySelectorAll('.crm-sel').forEach(cb => cb.addEventListener('change', () => { if (cb.checked) SEL.add(cb.dataset.phone); else SEL.delete(cb.dataset.phone); renderBulk(); }));
  }
  function renderBoard(box, rows) {
    const byStage = {}; for (const r of rows) (byStage[r.stage] ??= []).push(r);
    box.innerHTML = `<div class="crm-board">${(META.stages).map(s => `
      <div class="crm-col"><h4><span>${esc(s.he)}</span><span class="crm-pill muted">${(byStage[s.id] || []).length}</span></h4>
      ${(byStage[s.id] || []).map(card).join('') || '<div class="crm-empty" style="padding:10px;font-size:12px">—</div>'}</div>`).join('')}</div>`;
  }

  function renderBulk() {
    const box = $('#crm-bulk'); if (!box) return;
    if (!SEL.size) { box.innerHTML = ''; return; }
    const inTrash = S.bin === 'trash';
    box.innerHTML = `<div class="crm-bulkbar"><b>${SEL.size} נבחרו</b>
      ${inTrash ? '<button class="crm-btn" data-b="restore">↩️ שחזר</button>' : '<button class="crm-btn sec" data-b="archive">🗄️ ארכיון</button><button class="crm-btn danger" data-b="trash">🗑️ לסל מחזור</button>'}
      <button class="crm-btn sec" data-b="clear">בטל בחירה</button></div>`;
    box.querySelectorAll('[data-b]').forEach(b => b.addEventListener('click', () => bulk(b.dataset.b)));
  }
  async function bulk(action) {
    if (action === 'clear') { SEL.clear(); renderResults(); renderBulk(); return; }
    const phones = [...SEL];
    if (action === 'trash' && !confirm(`להעביר ${phones.length} רשומות לסל המחזור?\nפעולות מכירה עתידיות (שיחות ומשימות) ייעצרו. ההיסטוריה תישמר וניתן לשחזר.`)) return;
    const r = await api('/api/crm/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, phones }) });
    if (r.ok) { SEL.clear(); refresh(); } else alert('הפעולה נכשלה');
  }

  // ── lead card modal ───────────────────────────────────────────────────────────────────
  function overlay(inner) {
    const ov = el('div', { class: 'crm-overlay' });
    ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
    const m = el('div', { class: 'crm-modal' }); m.innerHTML = inner; ov.appendChild(m);
    document.body.appendChild(ov); return { ov, m };
  }
  const waLink = p => `https://wa.me/${String(p).replace(/\D/g, '')}`;
  const telLink = p => `tel:+${String(p).replace(/\D/g, '')}`;

  async function openCard(phone) {
    try { sessionStorage.setItem('crm.scroll', String(window.scrollY)); } catch {}
    const res = await api('/api/crm/lead/' + encodeURIComponent(phone));
    if (!res.ok || !res.data?.ok) { alert('לא ניתן לטעון את הכרטיס'); return; }
    const c = res.data.card;
    const stageSel = META.stages.map(s => `<option value="${s.id}" ${c.stage === s.id ? 'selected' : ''}>${esc(s.he)}</option>`).join('');
    const asgSel = ['<option value="">— אחראי —</option>'].concat(META.staff.map(s => `<option value="${s.id}" ${c.assignee === s.id ? 'selected' : ''}>${esc(s.name)}</option>`)).join('');
    const tl = (c.timeline || []).slice(-60).reverse().map(it => {
      let txt = '';
      if (it.kind === 'message') txt = `${it.dir === 'in' ? '⬅️ ליד' : '➡️ ' + (it.agent || 'מערכת')}: ${esc((it.text || '').slice(0, 120))}`;
      else if (it.kind === 'callback') txt = `📞 שיחה — ${esc(it.status)}${it.scheduledAt ? ' · ' + fmtDate(it.scheduledAt) : ''}`;
      else if (it.kind === 'task') txt = `✔️ משימה (${esc(it.status)}): ${esc(it.summary || '')}`;
      else txt = `• ${esc(it.type || '')}`;
      return `<div class="it"><span class="t">${fmtDate(it.at)}</span><span>${txt}</span></div>`;
    }).join('') || '<div class="crm-empty" style="padding:10px">אין תיעוד עדיין</div>';

    const tasks = (c.tasks || []).map(t => `<div class="it"><span class="t">${fmtDay(t.createdAt)}</span><span>${esc(t.summary)} — <b>${esc(t.status)}</b>${t.dueAt ? ' · עד ' + fmtDay(t.dueAt) : ''}${t.outcome ? ' · ' + esc(t.outcome) : ''} ${(t.status === 'open' || t.status === 'eden_assigned') ? `<button class="crm-btn sec" style="padding:2px 8px;font-size:12px" data-done="${t.id}">סמן בוצע</button>` : ''}</span></div>`).join('') || '<div style="font-size:12px;color:var(--muted)">אין משימות</div>';

    const meaning = c.owner === 'member' ? 'כבר מנוי/ה — נרשם/ה' : c.optedOut ? 'ביקש/ה הסרה — אין פנייה יזומה' : c.humanOwns ? 'בטיפול ידני של הצוות' : (c.nextAction ? 'יש פעולה הבאה' : 'אין פעולה הבאה מוגדרת');
    const nextTxt = c.nextAction ? `${c.nextAction.text}${c.nextAction.dueAt ? ' · ' + fmtDate(c.nextAction.dueAt) : ''}` : '— טרם הוגדרה —';

    const { ov, m } = overlay(`
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div><h3>${esc(c.name || local05(c.phone))}</h3><div class="sub" style="color:var(--muted);font-size:13px">${esc(local05(c.phone))} · ${c.createdManually ? 'נוצר ידנית' : 'מ-WhatsApp'}${c.waName && c.waName !== c.name ? ' · שם ב-WhatsApp: ' + esc(c.waName) : ''}</div></div>
        <button class="crm-btn sec" id="cm-x">✕</button>
      </div>
      <div class="crm-actions">
        <a class="crm-btn" href="${telLink(c.phone)}">📞 חיוג</a>
        <a class="crm-btn sec" href="${waLink(c.phone)}" target="_blank" rel="noopener">💬 WhatsApp</a>
        <button class="crm-btn sec" id="cm-note">📝 הערה</button>
        <button class="crm-btn sec" id="cm-task">✔️ משימה</button>
      </div>
      <div class="crm-ai" style="background:var(--bg2,#f3f3f7)"><b>משמעות:</b> ${esc(meaning)} · <b>אחראי:</b> ${esc(META.staff.find(s => s.id === c.assignee)?.name || '—')} · <b>פעולה הבאה:</b> ${esc(nextTxt)}</div>

      <div class="row">
        <div class="crm-field"><label>שלב מכירה</label><select id="cm-stage">${stageSel}</select></div>
        <div class="crm-field"><label>אחראי</label><select id="cm-asg">${asgSel}</select></div>
      </div>
      <div class="row">
        <div class="crm-field"><label>תחום עניין</label><input id="cm-int" value="${esc(c.interest || '')}"></div>
        <div class="crm-field"><label>מקור</label><input id="cm-src" value="${esc(c.source || '')}"></div>
      </div>
      <div class="row">
        <div class="crm-field"><label>שם מאומת</label><input id="cm-cn" value="${esc(c.confirmedName || '')}" placeholder="נפרד משם ה-WhatsApp"></div>
        <div class="crm-field"><label>תגיות (מופרדות בפסיק)</label><input id="cm-tags" value="${esc((c.tags || []).join(', '))}"></div>
      </div>
      <div class="row"><div class="crm-field" style="flex:1 1 100%"><label>פעולה הבאה</label><input id="cm-na" value="${esc(c.nextAction?.text || '')}" placeholder="מה הצעד הבא?"></div>
        <div class="crm-field"><label>מועד</label><input id="cm-nad" type="date" value="${c.nextAction?.dueAt ? new Date(c.nextAction.dueAt).toISOString().slice(0, 10) : ''}"></div></div>
      <div class="row"><button class="crm-btn" id="cm-save">💾 שמירה</button>
        ${c.crmState === 'active' ? '<button class="crm-btn sec" id="cm-archive">🗄️ ארכיון</button><button class="crm-btn danger" id="cm-trash">🗑️ מחיקה</button>' : ''}
        ${c.crmState !== 'active' ? '<button class="crm-btn" id="cm-restore">↩️ שחזור</button>' : ''}
        ${c.crmState === 'trashed' ? '<button class="crm-btn danger" id="cm-perm">⛔ מחיקה לצמיתות</button>' : ''}
      </div>

      ${c.summary ? `<div class="crm-sec"><h5>סיכום (${esc(c.summary.source)}${c.summary.at ? ' · ' + fmtDate(c.summary.at) : ''})</h5><div class="crm-ai">${esc(c.summary.text || c.summary.goal || '—')}</div></div>` : ''}
      ${c.qualProfile ? `<div class="crm-sec"><h5>הערכת AI (לא עובדה)</h5><div class="crm-ai">${esc(c.qualProfile.qualificationReason || '')} · מוכנות: ${esc(c.qualProfile.readiness || '—')}</div></div>` : ''}

      <div class="crm-sec"><h5>משימות</h5><div id="cm-tasks">${tasks}</div></div>
      <div class="crm-sec"><h5>הערות</h5><div id="cm-notes">${(c.notes || []).slice().reverse().map(n => `<div class="it"><span class="t">${fmtDate(n.at)}</span><span>${esc(n.text)} <i style="color:var(--muted)">— ${esc(n.by || '')}</i></span></div>`).join('') || '<div style="font-size:12px;color:var(--muted)">אין הערות</div>'}</div></div>

      <div class="crm-sec"><h5>ציר זמן</h5><div class="crm-tl">${tl}</div></div>
    `);
    const close = () => { ov.remove(); refresh(); };
    $('#cm-x', m).addEventListener('click', close);

    $('#cm-save', m).addEventListener('click', async () => {
      const tags = $('#cm-tags', m).value.split(',').map(s => s.trim()).filter(Boolean);
      const nextText = $('#cm-na', m).value.trim();
      const nad = $('#cm-nad', m).value;
      await api('/api/crm/lead/' + encodeURIComponent(c.phone), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        interest: $('#cm-int', m).value.trim(), source: $('#cm-src', m).value.trim(), confirmedName: $('#cm-cn', m).value.trim(),
        assignee: $('#cm-asg', m).value || null, tags, nextAction: nextText ? { text: nextText, dueAt: nad ? new Date(nad + 'T08:00:00+02:00').toISOString() : null } : null,
      }) });
      const st = $('#cm-stage', m).value;
      if (st !== c.stage) await api('/api/crm/lead/' + encodeURIComponent(c.phone) + '/stage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: st }) });
      close();
    });
    $('#cm-note', m)?.addEventListener('click', async () => { const t = prompt('הערה:'); if (t && t.trim()) { await api('/api/crm/lead/' + encodeURIComponent(c.phone) + '/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: t.trim() }) }); openCard(c.phone); ov.remove(); } });
    $('#cm-task', m)?.addEventListener('click', async () => { const t = prompt('תיאור המשימה (לא נשלחת ללקוח):'); if (t && t.trim()) { await api('/api/crm/lead/' + encodeURIComponent(c.phone) + '/task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: t.trim() }) }); ov.remove(); openCard(c.phone); } });
    m.querySelectorAll('[data-done]').forEach(b => b.addEventListener('click', async () => { const out = prompt('תוצאת המשימה (לא חובה):', '') ?? ''; await api('/api/crm/task/' + encodeURIComponent(b.dataset.done), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'resolved', outcome: out }) }); ov.remove(); openCard(c.phone); }));
    $('#cm-archive', m)?.addEventListener('click', async () => { await api('/api/crm/lead/' + encodeURIComponent(c.phone) + '/archive', { method: 'POST' }); close(); });
    $('#cm-restore', m)?.addEventListener('click', async () => { await api('/api/crm/lead/' + encodeURIComponent(c.phone) + '/restore', { method: 'POST' }); close(); });
    $('#cm-trash', m)?.addEventListener('click', async () => {
      const imp = (await api('/api/crm/lead/' + encodeURIComponent(c.phone) + '/impact')).data ?? {};
      if (!confirm(`להעביר את "${c.name || local05(c.phone)}" לסל המחזור?\n\nייעצרו: ${imp.openCallbacks || 0} שיחות מתוכננות, ${imp.openSalesTasks || 0} משימות מכירה.\nההיסטוריה תישמר. משימות שירות של תומר ומנוי ב-Arbox לא ייפגעו.\nניתן לשחזר.`)) return;
      await api('/api/crm/lead/' + encodeURIComponent(c.phone), { method: 'DELETE' }); close();
    });
    $('#cm-perm', m)?.addEventListener('click', async () => {
      if (!confirm(`מחיקה לצמיתות של "${c.name || local05(c.phone)}".\n\nיימחק: רשומת המכירה וההיסטוריה שלה כאן.\nלא יימחק: מנוי או רשומת לקוח ב-Arbox, ומשימות שירות של תומר.\nפעולה זו אינה הפיכה. להמשיך?`)) return;
      if (prompt('להמשך, הקלידו: מחק') !== 'מחק') return;
      const r = await api('/api/crm/lead/' + encodeURIComponent(c.phone) + '/permanent', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminConfirmed: true }) });
      if (!r.ok) alert(r.data?.message || 'המחיקה נדחתה'); close();
    });
  }

  function openCreate() {
    const { ov, m } = overlay(`
      <h3>ליד חדש</h3>
      <div class="crm-note">יצירת ליד אינה שולחת לו הודעה. אם המספר כבר קיים — יוצע לפתוח את הרשומה הקיימת.</div>
      <div class="row"><div class="crm-field"><label>טלפון</label><input id="nc-phone" placeholder="05X-XXXXXXX" inputmode="tel"></div>
        <div class="crm-field"><label>שם</label><input id="nc-name"></div></div>
      <div class="row"><div class="crm-field"><label>תחום עניין</label><input id="nc-int"></div>
        <div class="crm-field"><label>מקור</label><input id="nc-src" placeholder="המלצה / פייסבוק / הגיע/ה"></div></div>
      <div class="row"><div class="crm-field"><label>תגיות</label><input id="nc-tags" placeholder="מופרדות בפסיק"></div></div>
      <div class="row"><button class="crm-btn" id="nc-save">➕ יצירה</button><button class="crm-btn sec" id="nc-x">ביטול</button></div>
      <div id="nc-msg" style="color:var(--hot);font-size:13px;margin-top:6px"></div>`);
    $('#nc-x', m).addEventListener('click', () => ov.remove());
    $('#nc-save', m).addEventListener('click', async () => {
      const phone = $('#nc-phone', m).value.trim();
      if (!phone) { $('#nc-msg', m).textContent = 'נדרש טלפון'; return; }
      const body = { phone, name: $('#nc-name', m).value.trim() || null, interest: $('#nc-int', m).value.trim() || null, source: $('#nc-src', m).value.trim() || null, tags: $('#nc-tags', m).value.split(',').map(s => s.trim()).filter(Boolean) };
      const r = await api('/api/crm/lead', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) { ov.remove(); refresh(); openCard(r.data.phone); }
      else if (r.data?.error === 'duplicate') { if (confirm('כבר קיימת רשומה למספר הזה. לפתוח אותה?')) { ov.remove(); openCard(r.data.existing.phone); } }
      else $('#nc-msg', m).textContent = r.data?.error === 'invalid_phone' ? 'מספר טלפון לא תקין' : 'היצירה נכשלה';
    });
  }

  // ── public ────────────────────────────────────────────────────────────────────────────
  async function load() {
    if (!root()) return;
    ensureMount();
    if (!META) { const r = await api('/api/crm/meta'); if (r.ok && r.data?.ok) META = r.data; }
    const note = $('#crm-headnote'); if (note) note.textContent = 'CRM מכירות — מחובר לברק, למשימות ול-Arbox. חיפוש חל על כל הרשומות. מחיקה מעבירה לסל מחזור (הפיך).';
    renderViews(); renderFilters(); refresh();
  }
  function refreshIfVisible() { const r = root(); if (r && r.offsetParent !== null && mounted) refresh(); }
  window.CRM = { load, refreshIfVisible };
})();
