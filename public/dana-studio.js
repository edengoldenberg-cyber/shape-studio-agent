'use strict';
/* Dana studio — the owner's page. Workflow: project → transcript → style & references → edit → Dana's review → watch & approve.
   Talks only to /api/dana/studio/*. Nothing here publishes. */
(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const API = '/api/dana/studio';
  const EMBED = new URLSearchParams(location.search).has('embed') && window.top !== window;
  if (EMBED) document.documentElement.classList.add('embed');
  const toLogin = () => { (EMBED ? window.top : window).location.href = '/login.html'; };
  const csrf = () => { const m = /(?:^|;\s*)ss_csrf=([^;]+)/.exec(document.cookie); return m ? decodeURIComponent(m[1]) : null; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = iso => iso ? new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Jerusalem' }) : '—';
  const isNum = x => typeof x === 'number' && isFinite(x);
  const tfmt = t => isNum(t) ? t.toFixed(1) + 's' : '—';
  const dur = s => !isNum(s) ? '—' : s < 60 ? Math.round(s) + ' שנ׳' : Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0') + ' דק׳';
  const mb = b => (b / 1048576).toFixed(b > 104857600 ? 0 : 1);

  // ── The screen keeps its state ─────────────────────────────────────────────
  // A status refresh must never close an open area, wipe a field being typed in, move the scroll or restart the player.
  // setHtml() therefore (a) does nothing when the markup is unchanged, and (b) when it did change, puts back which
  // <details> were open, what was typed into fields the owner touched, the focus and the scroll position.
  const boxKey = e => { const c = e.closest('[data-refid],[data-skid],[data-field],[id]'); return c ? (c.dataset.refid || c.dataset.skid || c.dataset.field || c.id) : ''; };
  const detKey = d => { const c = d.parentElement.closest('[data-refid],[data-skid],[id]') || document.body; return boxKey(d.parentElement) + '#' + [...c.querySelectorAll('details')].indexOf(d); };
  const inKey = i => boxKey(i) + '|' + (i.dataset.pk || i.dataset.brand || i.dataset.card || i.dataset.rule || i.dataset.kp || i.name || i.id || '');
  function setHtml(el, html) {
    if (!el || el.__html === html) return false;
    const open = new Set(), closed = new Set(), vals = new Map();
    el.querySelectorAll('details').forEach(d => (d.open ? open : closed).add(detKey(d)));
    el.querySelectorAll('[data-dirty]').forEach(i => vals.set(inKey(i), i.type === 'checkbox' || i.type === 'radio' ? i.checked : i.value));
    const act = document.activeElement, focus = act && el.contains(act) ? { key: inKey(act), start: act.selectionStart, end: act.selectionEnd } : null, y = window.scrollY;
    el.innerHTML = html; el.__html = html;
    el.querySelectorAll('details').forEach(d => { const k = detKey(d); if (open.has(k)) d.open = true; else if (closed.has(k)) d.open = false; });
    if (vals.size || focus) el.querySelectorAll('input, textarea, select').forEach(i => { const k = inKey(i);
      if (vals.has(k)) { if (i.type === 'checkbox' || i.type === 'radio') i.checked = vals.get(k); else i.value = vals.get(k); i.dataset.dirty = '1'; }
      if (focus && k === focus.key) { i.focus({ preventScroll: true }); try { i.setSelectionRange(focus.start, focus.end); } catch { /* not a text field */ } } });
    if (Math.abs(window.scrollY - y) > 2) window.scrollTo(0, y);
    return true;
  }
  document.addEventListener('input', e => { if (e.target && e.target.dataset && !e.target.dataset.nodirty) e.target.dataset.dirty = '1'; }, true);
  // remembered across refreshes and reloads of this tab: the home tab, and per project the step, the open category and the version on screen
  let ui = { home: 'projects', steps: {}, cat: {}, view: {} };
  try { ui = Object.assign(ui, JSON.parse(sessionStorage.getItem('dana_ui') || '{}')); } catch { /* private mode */ }
  const remember = () => { try { sessionStorage.setItem('dana_ui', JSON.stringify(ui)); } catch { /* */ } };
  let refreshFailing = false, playerKey = '';
  function refreshFailed(e) { refreshFailing = true; notice(`הרענון נכשל (${e.message}). מוצג המצב האחרון שנטען ב-${new Date().toLocaleTimeString('he-IL')}; מנסה שוב אוטומטית. שום דבר שהקלדת לא נמחק.`, 'warn'); }
  function refreshOk() { if (refreshFailing) { refreshFailing = false; notice(''); } }
  let verOpen = false;
  let me = '', status = null, current = null, timer = null, step = 'project', stepFor = '', draft = null, draftKey = '', listened = {}, selCat = null, cmpN = null, pvSource = null;
  try { me = localStorage.getItem('dana_reviewer') || ''; } catch { /* private mode */ }
  const newDraft = () => ({ style: {}, zooms: {}, adjustments: {}, note: '', scope: '', captions: {}, graphics: {} });

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {}; const t = csrf();
    if (method !== 'GET' && t) headers['X-CSRF-Token'] = t;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    if (r.status === 401) { toLogin(); throw new Error('נדרשת התחברות'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.message || j.error || ('HTTP ' + r.status)); e.data = j; throw e; }
    return j;
  }
  function notice(text, cls = 'info') { const n = $('#notice'); n.className = 'card ' + cls; n.textContent = text; n.classList.toggle('hidden', !text); if (text) n.scrollIntoView({ block: 'nearest' }); }
  function who() {
    if (me) return me;
    me = (prompt('השם שלך (נשמר בהיסטוריה ליד כל אישור ותיקון):') || '').trim();
    try { if (me) localStorage.setItem('dana_reviewer', me); } catch { /* */ }
    return me;
  }
  const STATUS = { editing: ['בעבודה', 'info'], ready_for_review: ['מוכן לצפייה', 'warn'], approved: ['אושר', 'ok'], rejected: ['נדחה', 'bad'], reviewed: ['הביקורת מוכנה', 'info'],
    failed: ['נכשל', 'bad'], waiting: ['ממתין', 'warn'], changes_requested: ['התבקשו שינויים', 'warn'] };
  const pill = st => { const [t, c] = STATUS[st] || [st, 'mute']; return `<span class="pill ${c}">${esc(t)}</span>`; };
  function workerPill(w) {
    const el = $('#worker'); if (!w) return;
    if (!w.online) { el.className = 'pill bad'; el.textContent = 'עובד העריכה לא מחובר'; el.title = w.lastSeen ? 'נראה לאחרונה ' + fmt(w.lastSeen) : 'עדיין לא התחבר'; }
    else if (w.state === 'busy') { el.className = 'pill info'; el.textContent = 'עובד: בעבודה'; el.title = ''; }
    else { el.className = 'pill ok'; el.textContent = 'עובד: מחובר ופנוי'; el.title = ''; }
  }

  // ═══ HOME ═════════════════════════════════════════════════════════════════
  function showHome(k) { if (!document.querySelector(`[data-pane="${k}"]`)) k = 'projects'; ui.home = k; remember();
    $$('#hometabs button').forEach(b => b.classList.toggle('on', b.dataset.home === k)); $$('[data-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== k)); }
  $('#hometabs').onclick = e => { const k = e.target.dataset.home; if (k) showHome(k); };

  async function loadHome() {
    const [{ projects, worker }, st] = await Promise.all([api('/projects'), api('/status')]);
    status = st; workerPill(worker); showBanner();
    refreshOk();
    setHtml($('#projects'), projects.length ? projects.map(p => { const pr = p.progress;
      return `<li><button class="proj" data-id="${esc(p.id)}">
      <div class="row"><b class="grow">${esc(p.title)}</b>${p.kind === 'review_only' ? '<span class="pill mute">הועלה לביקורת</span>' : `<span class="pill info">${esc(p.targetLabel || 'ריל')}</span>`}${p.groupId ? '<span class="pill mute">מאותו מקור</span>' : ''}${pill(p.status)}</div>
      <div class="small mute">${fmt(p.createdAt)} · גרסה ${p.currentVersion}${p.status === 'editing' && pr && pr.phase ? ` · ${esc(phaseLabel(pr.phase))}${isNum(pr.percent) ? ` · ${pr.percent}%${pr.percentBasis === 'estimated' ? ' (משוער)' : ''}` : ''}` : ''}</div>
      <div class="small">${esc(p.nextAction ? 'הפעולה הבאה: ' + p.nextAction.label : '')}</div></button></li>`; }).join('') : '<li class="mute">עדיין לא הועלה חומר.</li>');
    const accts = st.accounts || [];
    setHtml($('#upacct'), accts.map(a => `<option value="${esc(a.username)}">@${esc(a.username)} — מחובר, אומת ${esc(a.verifiedAt)}</option>`).join('') + '<option value="">בלי חשבון יעד כרגע</option>');
    setHtml($('#accounts'), accts.length ? accts.map(a => `<li><div class="row"><b class="grow" dir="ltr" style="text-align:right">@${esc(a.username)}</b><span class="pill ok">מחובר ✓ אומת ${esc(a.verifiedAt)}</span></div>
      <div class="small mute">${esc(a.platform)} · ${esc(a.how)}</div></li>`).join('') : '<li class="mute">אין חשבון מחובר.</li>');
    $('#profnow').textContent = st.defaultProfile ? `${st.defaultProfile.id} · גרסה ${st.defaultProfile.version} (${st.dataBanner ? 'אישור בדיקה סינתטי — לא אישור שלך' : 'אושר על ידך'})` : 'לא אושר פרופיל — העובד משתמש בפרופיל המובנה שלו, שאינו מאושר';
    if (!worker.online && projects.some(p => p.status === 'editing')) notice('עובד העריכה במחשב לא מחובר. העבודות ממתינות בתור וימשיכו כשהוא יחזור.', 'warn');
    renderAbout(worker);
    loadStorage().then(() => { $('#about').__html = null; renderAbout(worker); }).catch(() => {});
    loadBrand().catch(() => {}); loadRules().catch(() => {}); loadRefs().catch(() => {}); loadSkills().catch(() => {});
  }
  /** A preview of test material says so on every screen; an approval made there is synthetic, never the owner's. */
  function showBanner() { const b = $('#banner'), t = status && status.dataBanner; b.textContent = t || ''; b.classList.toggle('hidden', !t); }
  const approvedPill = () => status && status.dataBanner ? '<span class="pill bad">אישור בדיקה סינתטי — לא אישור שלך</span>' : '<span class="pill ok">אושר על ידך</span>';
  const phaseLabel = k => ((status && status.phases) || []).reduce((a, [key, l]) => key === k ? l : a, k);

  // ── Brand settings: edit, never invent ──
  async function loadBrand() {
    const { brand } = await api('/brand');
    setHtml($('#brand'), Object.entries(brand).map(([k, v]) => `<li data-field="${esc(k)}">
      <div class="row"><b class="grow">${esc(v.label)}</b><span class="pill ${v.status === 'set' ? 'ok' : 'warn'}">${v.status === 'set' ? 'הוגדר' : 'חסר'}</span></div>
      <textarea data-brand="${esc(k)}" style="min-height:44px" placeholder="לא הוגדר — דנה לא תמציא">${esc(v.value == null ? '' : typeof v.value === 'string' ? v.value : JSON.stringify(v.value))}</textarea>
      <div class="row"><span class="small mute grow">${v.source ? 'מקור: ' + esc(v.source) : ''}</span><button class="sm" data-brandsave="${esc(k)}">שמירה</button></div></li>`).join(''));
  }
  $('#brand').onclick = async e => {
    const k = e.target.dataset.brandsave; if (!k) return;
    const by = who(); if (!by) return;
    const val = $(`[data-brand="${k}"]`).value.trim().replace(k === 'instagram_account' ? /^@/ : /^$/, '');
    try { await api('/brand/' + k, { method: 'PUT', body: { value: val, by } }); delete $(`[data-brand="${k}"]`).dataset.dirty; await loadBrand(); notice(val ? 'ההגדרה נשמרה. היא תיכנס לעריכות הבאות.' : 'ההגדרה נמחקה ומסומנת כחסרה.', 'ok'); } catch (err) { notice(err.message, 'bad'); }
  };

  // ── Standing rules ──
  let rulesNow = [];
  async function loadRules() {
    const { rules } = await api('/rules'); rulesNow = rules.filter(r => r.status === 'active');
    setHtml($('#rules'), rulesNow.length ? rulesNow.map(r => { const src = r.source || {}; return `<li><div class="row"><span class="grow">${esc(r.text)}</span><span class="pill mute">גרסה ${esc(r.version ?? 1)}</span></div>
      <div class="small mute">מקור: ${src.project_title ? `פרויקט "${esc(src.project_title)}"${src.version_n ? ' · גרסה ' + esc(src.version_n) : ''}` : 'לא נרשם'} · ${esc(src.by ?? r.by ?? '')} · ${fmt(src.at ?? r.at)}</div>
      <div class="row" style="margin-top:6px"><button class="sm" data-ruleedit="${esc(r.id)}">עריכת הנוסח</button><button class="sm danger" data-rule="${esc(r.id)}">הסר כלל</button></div></li>`; }).join('')
      : '<li class="mute">אין כללים קבועים.</li>');
  }
  $('#rules').onclick = async e => {
    const eid = e.target.dataset.ruleedit, id = e.target.dataset.rule;
    try {
      if (eid) { const cur = rulesNow.find(r => r.id === eid); const text = prompt('נוסח חדש לכלל (נשמר כגרסה חדשה; הקודם נשאר בהיסטוריה):', cur.text);
        if (text == null || text.trim() === cur.text) return; const by = who(); if (!by) return;
        await api(`/rules/${eid}`, { method: 'POST', body: { text: text.trim(), by } }); await loadRules(); notice('הכלל עודכן לגרסה חדשה.', 'ok'); }
      else if (id) { if (!confirm('להסיר את הכלל? הוא לא יישלח יותר לעריכות הבאות (הרישום נשמר).')) return; const by = who(); if (!by) return;
        await api(`/rules/${id}/retire`, { method: 'POST', body: { by } }); await loadRules(); notice('הכלל הוסר.', 'ok'); }
    } catch (err) { notice(err.message, 'bad'); }
  };

  // ── Upload: the percentage is bytes sent / bytes total ──
  let upKind = 'edit', upXhr = null;
  $('#pickraw').onclick = () => { upKind = 'edit'; $('#file').click(); };
  $('#pickreview').onclick = () => { upKind = 'review_only'; $('#file').click(); };
  $('#upcancel').onclick = () => { if (upXhr) upXhr.abort(); };
  function sendFile(url, fd, onPct) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest(); x.open('POST', API + url);
      const t = csrf(); if (t) x.setRequestHeader('X-CSRF-Token', t);
      const t0 = Date.now();
      x.upload.onprogress = e => { if (e.lengthComputable) onPct(e.loaded, e.total, (Date.now() - t0) / 1000); };
      x.onerror = () => reject(new Error('ההעלאה נכשלה (בעיית רשת). הקובץ לא נשמר — אפשר לנסות שוב.'));
      x.onabort = () => reject(new Error('ההעלאה בוטלה. הקובץ לא נשמר.'));
      x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch { /* */ }
        if (x.status === 401) return toLogin();
        if (x.status >= 400) return reject(new Error(j.message || 'ההעלאה נכשלה'));
        resolve(j); };
      upXhr = x; x.send(fd);
    });
  }
  $('#file').onchange = async () => {
    const all = Array.from($('#file').files), f = all[0]; if (!f) return;
    const rest = upKind === 'edit' ? all.slice(1, 12) : [];
    const fd = new FormData(); fd.append('video', f, f.name);
    fd.append('options', JSON.stringify({ kind: upKind, ...(upKind === 'edit' ? { target: $('#uptarget').value, project_type: $('#uptype').value, ...(rest.length ? { more_files: true } : {}) } : {}), ...($('#upacct').value ? { account: $('#upacct').value } : {}) }));
    $('#upbox').classList.remove('hidden'); $('#pickraw').disabled = $('#pickreview').disabled = true;
    try {
      const j = await sendFile('/upload', fd, (sent, total, sec) => { const pct = 100 * sent / total;
        $('#upbar').style.width = pct.toFixed(1) + '%'; $('#uppct').textContent = pct.toFixed(pct < 100 ? 1 : 0) + '%';
        $('#upstate').textContent = `${mb(sent)} מתוך ${mb(total)}MB${sec > 1 ? ' · ' + (sent / 1048576 / sec).toFixed(1) + 'MB/שנ׳' : ''}${pct >= 100 ? ' · השרת מאמת את הקובץ…' : ''}`; });
      const prog = label => (sent, total, sec) => { const pct = 100 * sent / total; $('#upbar').style.width = pct.toFixed(1) + '%'; $('#uppct').textContent = pct.toFixed(pct < 100 ? 1 : 0) + '%';
        $('#upstate').textContent = `${label} · ${mb(sent)} מתוך ${mb(total)}MB${sec > 1 ? ' · ' + (sent / 1048576 / sec).toFixed(1) + 'MB/שנ׳' : ''}`; };
      if (rest.length && !j.duplicate) {                    // the other files go into the SAME project; the edit starts only when all of them are in
        const by = who() || 'הבעלים';
        for (let i = 0; i < rest.length; i++) { const f2 = new FormData(); f2.append('by', by); f2.append('video', rest[i], rest[i].name);
          await sendFile(`/projects/${j.project.id}/sources`, f2, prog(`קובץ ${i + 2} מתוך ${rest.length + 1}`)); }
        await api(`/projects/${j.project.id}/start`, { method: 'POST', body: { by } });
        notice(`${rest.length + 1} קובצי מקור התקבלו בפרויקט אחד. העריכה נכנסה לתור.`, 'ok'); return open(j.project.id);
      }
      notice(j.duplicate ? 'הקובץ הזה כבר הועלה בעבר — נפתח הפרויקט הקיים, בלי עותק נוסף ובלי עבודה כפולה.' : upKind === 'review_only' ? 'הסרטון התקבל והוגש לביקורת דנה.' : 'הקובץ התקבל. העריכה נכנסה לתור.', j.duplicate ? 'warn' : 'ok');
      open(j.project.id);
    } catch (err) { notice(err.message, 'bad'); }
    finally { $('#upbox').classList.add('hidden'); $('#upbar').style.width = 0; $('#pickraw').disabled = $('#pickreview').disabled = false; $('#file').value = ''; upXhr = null; }
  };

  // ═══ REFERENCES ═══════════════════════════════════════════════════════════
  const PERM = { unknown: 'הרשאה לא ידועה', own: 'חומר שלי', licensed: 'ברישיון', inspiration_only: 'להשראה בלבד' };
  const BASIS = { measured: ['נמדד', 'ok'], seen_in_stills: ['נראה בפריימים', 'info'], model_assessment: ['הערכת מודל', 'info'], hypothesis: ['השערה', 'warn'] };
  const ASPECT = { structure: 'מבנה ומסר', opening: 'פתיחה', pace: 'קצב', pauses: 'הפסקות', cuts: 'חיתוכים', transitions: 'מעברים', zooms: 'זומים ותנועות', captions: 'כתוביות',
    emphasis: 'הדגשות', motion_graphics: 'מואושן גרפיק וכותרות', color: 'צבע וגוני עור', sound: 'סאונד ומוזיקה', cover: 'קאבר' };
  const PARAM = { caption_size: 'גודל כתובית', caption_y_px: 'מיקום אנכי', caption_max_lines: 'מספר שורות', max_words_per_line: 'מילים בשורה', max_chars_per_line: 'תווים בשורה',
    backing: 'רקע מאחורי הטקסט', highlight_enabled: 'הדגשות צבע', min_on_screen_s: 'זמן מינימלי על המסך', max_chars_per_s: 'תווים לשנייה', zoom_scale_light: 'זום קל',
    zoom_scale_medium: 'זום בינוני', zoom_scale_strong: 'זום חזק', zoom_min_gap_s: 'מרווח בין זומים', zoom_min_hold_s: 'החזקת זום' };
  let refsNow = [], refTimer = null, refSel = new Set(), refFiles = [];
  const isVideo = r => r.file && /^(mp4|mov|m4v|webm|mkv)$/.test(r.file.ext);
  const rtimes = (r, list) => (list || []).filter(isNum).map(t => isVideo(r) ? `<button class="sm" data-refplay="${esc(r.id)}" data-t="${t}">▶ ${tfmt(t)}</button>` : `<span class="pill mute">${tfmt(t)}</span>`).join(' ');

  async function loadRefs() {
    const { references, worker } = await api('/references'); refsNow = references;
    const RS = { awaiting_analysis: [worker && worker.online ? 'ממתין לניתוח' : 'ממתין לעובד (לא מחובר)', 'warn'], analysing: ['בניתוח', 'info'], analysed: ['נותח — מחכה להחלטה שלך', 'info'],
      analysis_failed: ['הניתוח נכשל', 'bad'], link_only: ['קישור בלבד', 'mute'], approved: ['פרופיל אושר', 'ok'], rejected: ['ההצעה נדחתה', 'mute'] };
    renderSkillRefs();
    setHtml($('#refs'), references.length ? references.map(r => {
      const a = r.analysis, m = a && a.measured, pp = r.proposed_profile, st = RS[r.status] || [r.status, 'mute'], cov = a && a.coverage;
      return `<li data-refid="${esc(r.id)}"><div class="row">${a ? `<input type="checkbox" data-refsel="${esc(r.id)}" ${refSel.has(r.id) ? 'checked' : ''} aria-label="בחירה להשוואה">` : ''}<b class="grow">${esc(r.title)}</b><span class="pill ${st[1]}">${st[0]}</span></div>
      <div class="small mute">${r.file ? `${esc(r.file.name)} (${mb(r.file.bytes)}MB)` : r.source_url ? 'קישור' : ''} · ${esc(PERM[r.usage_permission] || r.usage_permission)}</div>
      ${r.owner_note ? `<label>מה אהבת בו</label><div class="quote">${esc(r.owner_note)}</div>` : '<div class="small warn">לא נכתב מה אהבת ברפרנס הזה.</div>'}
      ${r.status === 'link_only' ? '<div class="small warn">דנה לא מורידה קישורים. כדי לנתח צריך להעלות את קובץ הווידאו.</div>' : ''}
      ${r.status === 'analysis_failed' && r.analysisError ? `<div class="small bad">${esc(r.analysisError.message)}</div>` : ''}
      ${a ? `<details><summary>הניתוח של דנה</summary>
        ${a.summary ? `<div>${esc(a.summary)}</div>` : ''}
        <label>כיסוי ומגבלות</label><div class="small mute">${esc(a.basis_note || '')}</div>
        ${cov ? `<ul class="plain small"><li>פריימים שנדגמו למדידת פנים/זומים: ${esc(cov.face_frames)} (כל ${esc(cov.face_step_s)} שנ׳) · למדידת צבע: ${esc(cov.color_frames)} · פריימים שהמודל ראה: ${esc(cov.stills_seen_by_model ?? '—')}</li>
          <li>לא בוצע: ${esc((cov.not_done || []).join(' · '))}</li></ul>` : ''}
        ${m ? `<details><summary>מדידות</summary><ul class="plain">
          <li>אורך ${tfmt(m.duration_s)} · ${esc(m.cut_count ?? 0)} חיתוכים · שוט ממוצע ${tfmt(m.avg_shot_s)} · ${esc(m.words_per_s)} מילים/שנ׳</li>
          ${(m.cuts_s || []).length ? `<li>חיתוכים: ${rtimes(r, m.cuts_s.slice(0, 12))}</li>` : ''}
          ${(m.face_scale_changes || []).length ? `<li>שינויי גודל פנים (מועמדים לזום): ${m.face_scale_changes.slice(0, 8).map(x => `${rtimes(r, [x.t_s])} ×${esc(x.ratio)}`).join(' ')}</li>` : ''}
          ${m.pauses ? `<li>הפסקות: ${esc(m.pauses.count)} · הארוכה ${esc(m.pauses.longest_s)} שנ׳ ${rtimes(r, (m.pauses.examples || []).slice(0, 4).map(x => x.t_s))}</li>` : ''}
          ${m.picture ? `<li>צבע: בהירות חציונית ${esc(m.picture.luma_p50)} · רוויה ${esc(m.picture.saturation)}${m.picture.face ? ` · בהירות פנים ${esc(m.picture.face.luma)}` : ''} (${esc(m.picture.frames)} פריימים)</li>` : ''}
          ${m.sound ? `<li>סאונד: ${esc(m.sound.integrated_lufs)} LUFS · יחס דיבור/רעש ${esc(m.sound.snr_db)}dB <span class="mute">(עוצמות בלבד — לא האזנה)</span></li>` : ''}
          ${(m.notes || []).map(n => `<li class="mute">${esc(n)}</li>`).join('')}</ul></details>` : ''}
        ${(a.aspects || []).length ? `<ul class="plain">${a.aspects.map(x => { const b = BASIS[x.basis] || [x.basis || '—', 'mute']; return `<li><div class="row"><b>${esc(ASPECT[x.aspect] || x.aspect)}</b><span class="pill ${b[1]}">${esc(b[0])}</span></div>
          <div>${esc(x.observation || '')}</div>${x.rule ? `<div class="mute">כלל מעשי: ${esc(x.rule)}</div>` : ''}${(x.example_times_s || []).length ? `<div style="margin-top:4px">${rtimes(r, x.example_times_s)}</div>` : ''}</li>`; }).join('')}</ul>` : ''}
        ${(a.fits_us || []).length ? `<label>מה מתאים לתוכן שלנו</label><ul class="plain">${a.fits_us.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${(a.does_not_fit_us || []).length ? `<label>מה לא מתאים</label><ul class="plain">${a.does_not_fit_us.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${(a.do_not_imitate || []).length ? `<label>לא לחקות / לא להעתיק</label><ul class="plain">${a.do_not_imitate.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${(a.hypotheses || []).length ? `<label>השערות (לא נמדדו ולא נצפו)</label><ul class="plain">${a.hypotheses.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
        ${pp && pp.params ? `<label>הצעת פרופיל מהרפרנס הזה לבדו — ${r.profile ? `אושרה בגרסה ${esc(r.profile.version)}` : 'ממתינה להחלטה שלך'}</label>
          <div>${Object.entries(pp.params).map(([k, val]) => typeof val === 'boolean'
            ? `<label class="chk"><input type="checkbox" data-pk="${esc(k)}" data-pt="boolean" ${val ? 'checked' : ''}> ${esc(PARAM[k] || k)}</label>`
            : `<div class="row" style="margin:4px 0"><span class="grow">${esc(PARAM[k] || k)}</span><input type="text" data-pk="${esc(k)}" data-pt="${typeof val}" value="${esc(val)}" inputmode="decimal" dir="ltr" style="width:110px"></div>`).join('')}</div>
          <label class="chk"><input type="checkbox" data-refdefault> ברירת מחדל לפרויקטים הבאים</label>
          <div class="row" style="margin-top:6px"><button class="primary sm" data-refapprove="${esc(r.id)}">אשר כפרופיל</button><button class="sm danger" data-refreject="${esc(r.id)}">דחה</button></div>` : ''}</details>` : ''}
      <div class="row" style="margin-top:6px">${isVideo(r) ? `<button class="sm" data-refplay="${esc(r.id)}" data-t="0">▶ צפייה</button>` : ''}
        ${r.file && !['analysing', 'awaiting_analysis'].includes(r.status) ? `<button class="sm" data-refagain="${esc(r.id)}">נתח שוב</button>` : ''}${a ? `<button class="sm" data-refskill="${esc(r.id)}">צור סקיל מהניתוח</button>` : ''}<button class="sm danger" data-refdel="${esc(r.id)}">מחיקה</button></div></li>`; }).join('') : '<li class="mute">עדיין לא נוסף רפרנס.</li>');
    $('#refcompare').disabled = refSel.size < 2;
    clearTimeout(refTimer);
    if (references.some(r => ['awaiting_analysis', 'analysing'].includes(r.status)) && !$('#home').classList.contains('hidden')) refTimer = setTimeout(() => loadRefs().catch(() => {}), 6000);
  }
  $('#refs').onchange = e => { const id = e.target.dataset.refsel; if (!id) return; e.target.checked ? refSel.add(id) : refSel.delete(id); $('#refcompare').disabled = refSel.size < 2; };
  $('#refs').onclick = async e => {
    const t = e.target, d = t.dataset;
    try {
      if (d.refplay) { const v = $('#refvid'); if (v.dataset.ref !== d.refplay) { v.src = `${API}/references/${d.refplay}/file`; v.dataset.ref = d.refplay; }
        v.classList.remove('hidden'); const go = () => { try { v.currentTime = Number(d.t) || 0; } catch { /* */ } v.play().catch(() => {}); };
        if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true }); v.scrollIntoView({ block: 'nearest' }); return; }
      if (d.refapprove) { const li = t.closest('li'), ref = refsNow.find(r => r.id === d.refapprove), params = {};
        for (const inp of li.querySelectorAll('[data-pk]')) { const k = inp.dataset.pk, orig = ref.proposed_profile.params[k];
          const val = inp.dataset.pt === 'boolean' ? inp.checked : inp.dataset.pt === 'number' ? Number(inp.value) : inp.value;
          if (inp.dataset.pt === 'number' && !isFinite(val)) return notice(`ערך לא תקין בשדה ${PARAM[k] || k}`, 'warn');
          if (val !== orig) params[k] = val; }
        const make_default = !!li.querySelector('[data-refdefault]').checked; const by = who(); if (!by) return;
        if (!confirm(make_default ? 'לאשר את הפרופיל ולהפוך אותו לברירת המחדל של העריכות הבאות?' : 'לאשר את הפרופיל (בלי להפוך אותו לברירת מחדל)?')) return;
        await api(`/references/${d.refapprove}/approve-profile`, { method: 'POST', body: { by, make_default, ...(Object.keys(params).length ? { params } : {}) } });
        await loadHome(); return notice(make_default ? 'הפרופיל אושר ונקבע כברירת מחדל.' : 'הפרופיל אושר. הוא לא ברירת מחדל.', 'ok'); }
      if (d.refreject) { const reason = prompt('למה ההצעה נדחית? (לא חובה)'); if (reason === null) return; const by = who(); if (!by) return;
        await api(`/references/${d.refreject}/reject-profile`, { method: 'POST', body: { by, reason } }); await loadRefs(); return notice('ההצעה נדחתה. שום דבר לא השתנה.', 'ok'); }
      if (d.refskill) { refSel = new Set([d.refskill]); return openSkillPicker(); }
      if (d.refagain) { await api(`/references/${d.refagain}/reanalyse`, { method: 'POST', body: {} }); await loadRefs(); return notice('הרפרנס חזר לתור הניתוח.', 'ok'); }
      if (d.refdel) { if (!confirm('למחוק את הרפרנס?')) return; refSel.delete(d.refdel); await api('/references/' + d.refdel, { method: 'DELETE' }); await loadRefs(); }
    } catch (err) { notice(err.message, 'bad'); }
  };
  // several files at once, each with its own note
  $('#refpick').onclick = () => $('#ref_files').click();
  $('#ref_files').onchange = () => {
    refFiles = Array.from($('#ref_files').files);
    $('#refnew').innerHTML = refFiles.length ? refFiles.map((f, i) => `<div class="card" style="margin:8px 0"><b>${esc(f.name)}</b> <span class="small mute">${mb(f.size)}MB</span>
      <label for="rn_t${i}">שם</label><input type="text" id="rn_t${i}" maxlength="120" value="${esc(f.name.replace(/\.[^.]+$/, ''))}">
      <label for="rn_n${i}">מה אהבתי בו</label><textarea id="rn_n${i}" maxlength="2000" placeholder="למשל: הקצב של החיתוכים, הכתוביות הגדולות במרכז"></textarea>
      <div class="bar hidden" id="rn_b${i}"><i></i></div><div class="small mute" id="rn_s${i}"></div></div>`).join('') + `
      <label for="rn_perm">הרשאת שימוש (לכולם)</label><select id="rn_perm"><option value="inspiration_only">להשראה בלבד</option><option value="own">חומר שלי</option><option value="licensed">ברישיון</option><option value="unknown">לא ידועה</option></select>
      <button class="primary" id="refsend" style="margin-top:10px;width:100%">העלאת ${refFiles.length} רפרנסים לניתוח</button>
      ${refFiles.length < 2 ? '<div class="small mute">להשוואה נדרשים לפחות שני רפרנסים — אפשר להוסיף עוד אחר כך.</div>' : ''}` : '';
  };
  $('#refnew').onclick = async e => {
    if (e.target.id !== 'refsend') return;
    const by = who(); if (!by) return;
    e.target.disabled = true; let okN = 0;
    for (let i = 0; i < refFiles.length; i++) {
      const fd = new FormData();
      fd.append('title', $('#rn_t' + i).value || refFiles[i].name); fd.append('owner_note', $('#rn_n' + i).value); fd.append('usage_permission', $('#rn_perm').value); fd.append('by', by);
      fd.append('file', refFiles[i], refFiles[i].name);
      $('#rn_b' + i).classList.remove('hidden');
      try { await sendFile('/references', fd, (sent, total) => { $(`#rn_b${i} i`).style.width = (100 * sent / total).toFixed(1) + '%'; $('#rn_s' + i).textContent = `${(100 * sent / total).toFixed(0)}% · ${mb(sent)} מתוך ${mb(total)}MB`; });
        $('#rn_s' + i).textContent = 'הועלה — ממתין לניתוח'; okN++; } catch (err) { $('#rn_s' + i).textContent = err.message; $('#rn_s' + i).className = 'small bad'; }
    }
    if (okN === refFiles.length) { $('#refnew').innerHTML = ''; $('#ref_files').value = ''; refFiles = []; }
    await loadRefs(); notice(`${okN} רפרנסים הועלו וממתינים לעובד העריכה לניתוח.`, okN ? 'ok' : 'bad');
  };
  $('#reflink').onclick = async () => {
    const by = who(); if (!by) return; const fd = new FormData();
    for (const k of ['title', 'source_url', 'owner_note']) fd.append(k, $('#ref_' + k).value); fd.append('by', by);
    try { await sendFile('/references', fd, () => {}); for (const k of ['title', 'source_url', 'owner_note']) $('#ref_' + k).value = ''; await loadRefs(); notice('הקישור נשמר לתיעוד בלבד. דנה לא מורידה קישורים.', 'warn'); } catch (err) { notice(err.message, 'bad'); }
  };
  // comparison + combined profile
  let cmpNow = null;
  $('#refcompare').onclick = async () => {
    try { const { comparison } = await api('/references/compare', { method: 'POST', body: { ids: [...refSel] } }); cmpNow = comparison; renderCompare(); $('#cmpcard').scrollIntoView({ block: 'start' }); }
    catch (err) { notice(err.message, 'bad'); }
  };
  function renderCompare() {
    const c = cmpNow, R = c.references, title = id => (R.find(r => r.id === id) || {}).title || id;
    $('#cmpcard').classList.remove('hidden');
    $('#cmpcard').innerHTML = `<h2>השוואה: ${R.map(r => esc(r.title)).join(' מול ')}</h2>
      <div style="overflow-x:auto"><table class="cmp"><thead><tr><th></th>${R.map(r => `<th>${esc(r.title)}</th>`).join('')}</tr></thead><tbody>
        <tr><td><b>מה אהבת</b></td>${R.map(r => `<td>${esc(r.owner_note || '—')}</td>`).join('')}</tr>
        <tr><td><b>מדידות</b></td>${R.map(r => { const m = r.measured || {}; return `<td>${tfmt(m.duration_s)} · ${esc(m.cut_count ?? '—')} חיתוכים · ${esc(m.words_per_s ?? '—')} מילים/שנ׳${m.pauses ? ` · ${esc(m.pauses.count)} הפסקות` : ''}</td>`; }).join('')}</tr>
        ${c.aspects.map(a => `<tr><td><b>${esc(ASPECT[a.aspect] || a.aspect)}</b></td>${a.by_reference.map(x => x.observation ? `<td><span class="pill ${(BASIS[x.basis] || ['', 'mute'])[1]}">${esc((BASIS[x.basis] || [x.basis])[0])}</span> ${esc(x.observation)}</td>` : '<td class="mute">—</td>').join('')}</tr>`).join('')}
        <tr><td><b>מתאים לנו</b></td>${R.map(r => `<td>${esc((r.fits_us || []).join(' · ') || '—')}</td>`).join('')}</tr>
        <tr><td><b>לא מתאים</b></td>${R.map(r => `<td>${esc((r.does_not_fit_us || []).join(' · ') || '—')}</td>`).join('')}</tr>
      </tbody></table></div>
      <h3>הצעה לפרופיל משולב — בחירה מה לקחת מכל רפרנס</h3>
      <p class="small mute">${esc(c.proposal.note)}</p>
      <ul class="plain">${Object.entries(c.proposal.params).map(([k, p]) => `<li><b>${esc(PARAM[k] || k)}</b> <span class="small mute">${esc(p.why)}</span>
        <div class="row" style="margin-top:4px">${p.options.map(o => `<label class="chk"><input type="radio" name="pick_${esc(k)}" value="${esc(o.ref)}" ${p.suggested === o.ref ? 'checked' : ''}> ${esc(o.title)}: <b dir="ltr">${esc(o.value)}</b> <span class="pill ${(BASIS[o.basis] || ['', 'mute'])[1]}">${esc((BASIS[o.basis] || [o.basis])[0])}</span></label>`).join('')}
          <label class="chk"><input type="radio" name="pick_${esc(k)}" value="" ${p.suggested ? '' : 'checked'}> לא לקחת</label></div></li>`).join('') || '<li class="mute">הניתוחים לא הציעו מספרים.</li>'}</ul>
      ${c.proposal.rules.length ? `<h3>כללי סגנון</h3><ul class="plain">${c.proposal.rules.map((r, i) => `<li><label class="chk"><input type="checkbox" data-cmprule="${i}"> <span>${esc(r.text)} <span class="mute">(${esc(r.title)})</span></span></label></li>`).join('')}</ul>` : ''}
      <label class="chk"><input type="checkbox" id="cmpdefault"> ברירת מחדל לפרויקטים הבאים</label>
      <button class="primary" id="cmpapprove" style="margin-top:10px;width:100%">אשר פרופיל משולב</button>
      <p class="small mute">האישור יוצר גרסה חדשה של הפרופיל "combined", עם המקור של כל מספר וכל כלל. הוא יופעל בתכנון, ברינדור ובביקורת של הפרויקטים הבאים רק אם סומן כברירת מחדל.</p>`;
  }
  $('#cmpcard').onclick = async e => {
    if (e.target.id !== 'cmpapprove') return;
    const picks = {}; for (const k of Object.keys(cmpNow.proposal.params)) { const r = document.querySelector(`input[name="pick_${CSS.escape(k)}"]:checked`); if (r && r.value) picks[k] = r.value; }
    const rules = $$('[data-cmprule]:checked').map(x => { const r = cmpNow.proposal.rules[Number(x.dataset.cmprule)]; return { ref: r.ref, index: r.index }; });
    if (!Object.keys(picks).length) return notice('לא נבחר אף מספר לקחת.', 'warn');
    const by = who(); if (!by) return; const make_default = $('#cmpdefault').checked;
    if (!confirm(make_default ? 'לאשר את הפרופיל המשולב ולהפוך אותו לברירת המחדל?' : 'לאשר את הפרופיל המשולב (בלי להפוך אותו לברירת מחדל)?')) return;
    try { const { profile } = await api('/profiles/combined', { method: 'POST', body: { by, ids: cmpNow.references.map(r => r.id), picks, rules, make_default } });
      await loadHome(); notice(`הפרופיל המשולב אושר (גרסה ${profile.version})${make_default ? ' ונקבע כברירת מחדל. הוא יופעל בפרויקט הבא.' : '.'}`, 'ok'); } catch (err) { notice(err.message, 'bad'); }
  };

  // ═══ HOW IT WORKS (from the code, plus what the worker reported about its own machine) ═══
  function renderAbout(worker) {
    const c = (worker && worker.capabilities) || null, on = worker && worker.online;
    const CAP = [
      ['active', 'תמלול עם זמני מילים, פעמיים', 'Whisper large-v3 במחשב העריכה. מילים בספק מסומנות להאזנה; רק האזנה שלך מאמתת מילה.'],
      ['active', 'תכנון תוכן', 'מודל בלי כלים: מסר, פתיחה, אילו קטעים ובאיזה סדר, רגעי זום, ציטוט לקאבר. רק ממה שנאמר בהקלטה.'],
      ['active', 'חיתוך וחיבור קטעים', 'חיתוך ישר בין מילים עם מעבר קול קצר. אין מעברים מעוצבים.'],
      ['active', 'כתוביות צרובות', 'המילים שנאמרו בלבד; גודל, מיקום, שורות וצבע; מוזזות מהפנים שנמדדו ונשארות באזור הבטוח.'],
      ['partial', 'הנפשת כתוביות', 'כניסה הדרגתית (עם או בלי עלייה) בלבד. אין הנפשת מילה-מילה.'],
      ['active', 'זומים', 'פנימה והחזקה ברגעי מפתח, ממורכז על הפנים שנמדדו. תחושת התנועה לא נבדקת.'],
      [c && c.hyperframes === false ? 'missing' : 'partial', 'מואושן גרפיק (HyperFrames)', (c && c.hyperframes === false ? 'הכלי לא נמצא כרגע במחשב העריכה. ' : '') + 'כותרת פתיחה והדגשת משפט מפתח בלבד, מציטוט מדויק, ורק כשיש לזה תפקיד. אין תרשימים או גרפיקה מסבירה.'],
      ['partial', 'צבע', 'תיקון עדין לפי מדידה (חשיפה, קונטרסט, איזון לבן, רוויה) עם בדיקת גוון עור. אין מראה / גרייד, ואיש לא מסתכל על התוצאה מלבדך.'],
      ['partial', 'סאונד', 'נרמול עוצמה, וניקוי רעש עדין רק כשנמדד רעש בין המילים. אין מוזיקה, אין אפקטים, ואיש לא מאזין.'],
      ['active', 'ביקורת על התוצר', 'בדיקות אוטומטיות על הקובץ הסופי + הערכת מודל על התמלול ועל פריימים בודדים, ב-12 קטגוריות עם קריטריונים קבועים.'],
      ['active', 'סבבי תיקון', `עריכה ← ביקורת ← תיקון ← בדיקה חוזרת${c ? `, עד ${c.max_review_rounds} סבבים, ${Math.round(c.max_seconds / 60)} דקות ו-$${c.max_cost_usd}` : ''}. נעצר כשאין שיפור או כשאותה תקלה חוזרת.`],
      ['active', 'רפרנסים וסקילי עריכה', 'ניתוח סגנון של רפרנס (מדידות, פריימים, הערכת מודל, השערות — מסומנים בנפרד) וספריית סקילים שנטענים לתכנון, לרינדור ולביקורת.'],
      [c && c.hyperframes === false ? 'missing' : 'partial', 'קטע אנימציה שמחליף את הצילום', 'רק טיפוגרפיה מונפשת במסך מלא של ציטוט מדויק, כשהקול ממשיך. זה לא אותו דבר כמו גרפיקה שמונחת מעל הצילום.'],
      ['missing', 'אנימציה שממחישה את הנאמר', 'לא קיים: אין איור, דמויות או וידאו שנוצר. יידרש שירות יצירה בתשלום ושליחת חומר לספק חדש — רק אחרי הצגת העלות וההרשאה ואישור שלך.'],
      ['active', 'יעד: ריל או סטורי', 'היעד משנה את התכנון (מבנה, משך, פתיחה), את האזור הבטוח, את הקאבר והקפשן. לסטורי מופקים גם קבצים נפרדים לכל כרטיס.'],
      ['missing', 'פרסום סטורי', 'לא נבדק מעולם דרך החיבור הקיים. הקבצים מופקים; הפרסום אינו נתמך.'],
      ['active', 'לקט מכמה קובצי מקור', 'הקבצים מאוחדים לקובץ עבודה אחד עם מפה: לכל קטע בסרטון רשומים הקובץ והזמן בתוכו. בלקט דנה בוחרת לפי מה שרואים (תנועה, חדות, פריים אחד לכל רגע) — היא לא צופה בתנועה, לא מזהה תרגילים ולא שופטת ביצוע.'],
      ['active', 'מוזיקה וקריינות בהעלאה', 'מיקס: דיבור ← מוזיקה (נקודת התחלה, עוצמה, כניסה/יציאה) ← הנמכה מתחת לדיבור ← נרמול. נמדדים עוצמה, שיא, עיוות והיחס בין דיבור למוזיקה. קובץ שהועלה אינו מסומן כמורשה.'],
      ['partial', 'עריכה לפי קצב', 'בלקט בלבד: זיהוי פעימות (librosa) והזזת חיתוך לפעימה רק כשהיא קרובה. לא נכפה חיתוך בכל פעימה.'],
      ['partial', 'כתוביות לקריינות', 'בלקט: הקריינות שהועלתה מתומללת אוטומטית ומוצגת ככתוביות. הן מסומנות כקריינות (לא ציטוט) וכלא מאומתות — לקרוא לפני אישור. אי אפשר עדיין לתקן אותן מהפאנל.'],
      ['missing', 'קריינות ודיבוב ב-ElevenLabs', 'החיבור מוכן אך כבוי. נדרשים: חשבון בתשלום (המסלול החינמי אסור לשימוש מסחרי), מפתח, ואישור עלות שלך. שום חומר לא נשלח לספק.'],
      ['missing', 'ספריית מוזיקה חיצונית', 'אין חיבור פעיל. ל-CapCut אין API ותנאיו אוסרים שימוש מחוץ לאפליקציה. אפשרויות חוקיות ועלויות מפורטות במסמך; עד אז — העלאה ידנית עם רישום רישיון.'],
      ['active', 'שילוב סקילים', 'כמה סקילים מאושרים ממוזגים לפני התכנון לתוכנית אחת, לפי סדר עדיפות. סתירה בפרמטרים מוצגת לפני ההפקה.'],
      ['missing', 'צילומי השלמה (B-roll)', 'לא קיים. אין חומר ואין מנגנון.'],
      ['missing', 'מוזיקה ואפקטים קוליים', 'לא קיים.'],
      ['missing', 'האזנה לאודיו וצפייה בתנועה', 'אף רכיב לא מאזין ולא צופה ברצף. זה נשאר אצלך.'],
      ['missing', 'פרסום', 'כבוי. שום דבר לא עולה ל-Meta בלי אישור נפרד שלך.'],
    ];
    const ST = { active: ['פעיל', 'ok'], partial: ['חלקי', 'warn'], missing: ['חסר', 'bad'] };
    setHtml($('#about'), connectorsCard() + storageCard(worker) + `<div class="card"><h2>המסלול</h2>
        <ol class="plain small" style="counter-reset:s">${[
          ['העלאה', 'הקובץ נשמר כמו שהוא בשרת. השרת רק מתאם; הוא לא עורך.'],
          ['תמלול ומדידות', 'עובד העריכה במחשב מתמלל פעמיים, מודד עוצמת קול לכל מילה ומיקום פנים.'],
          ['תכנון', 'Claude (בלי כלים, בלי גישה לקבצים או לרשת) מחליט על המסר, הקטעים, הזומים, הקאבר והגרפיקה. התשובה שלו היא נתונים שהקוד מאמת לפני שימוש.'],
          ['עריכה', 'העובד מבצע: ffmpeg חותך, מתקן צבע וסאונד לפי מדידה ומקודד; Chrome מצייר כתוביות; HyperFrames מרנדר גרפיקה.'],
          ['ביקורת על התוצר', 'בדיקות קוד על הקובץ הסופי, והערכת מודל על התמלול של אותו קובץ ועל פריימים בודדים ממנו.'],
          ['תיקונים', 'מה שאפשר לתקן בתוך הכללים חוזר לעורך ונבדק שוב. ספקות והחלטות עוברים אלייך.'],
          ['צפייה ואישור שלך', 'רק את/ה מאשר/ת גרסה. אישור חל על הגרסה המדויקת, ואינו פרסום.'],
        ].map(([t, x], i) => `<li><b>${i + 1}. ${t}</b> — ${x}</li>`).join('')}</ol></div>
      <div class="card"><h2>מי מחליט מה</h2><ul class="plain small">
        <li><b>Claude מחליט</b> (שיפוט תוכן, תמיד כנתונים מאומתים): מסר, פתיחה, קטעים וסדר, רגעי זום, ציטוט הקאבר, גרפיקה ותפקידה, חלוקת הכתוביות, טיוטת הקפשן, פירוש בקשה חופשית, ניתוח סגנון של רפרנס, ניסוח טיוטת סקיל.</li>
        <li><b>עובד העריכה מבצע ומודד</b> (קוד): נקודות חיתוך בין מילים, תזמון כתוביות מהאודיו הסופי, מיקום כתוביות מחוץ לפנים, מיקוד זום, האם נדרש תיקון צבע או סאונד וכמה, מיקום גרפיקה, וכל הבדיקות.</li>
        <li><b>דנה בודקת בפועל</b>: מילים מול התמלול, סנכרון, מסגרת ואזור בטוח, כיסוי פנים, זמן קריאה, מה שבאמת על המסך פריים-פריים, פורמט, עוצמה, מדידות צבע ורעש, וחיתוכים בין מילים. מודל מעריך מסר, פתיחה, מבנה, קצב וקאבר — מטקסט ומפריימים.</li>
        <li><b>מה שדנה לא יכולה לבדוק</b>: איך הקול נשמע, תחושת תנועה, האם הצבע נראה נכון, האם תמלול אוטומטי מדויק, המראה בתוך אינסטגרם, וביצועים.</li></ul></div>
      <div class="card"><h2>יכולות: פעיל, חלקי, חסר</h2>
        <p class="small mute">לפי הקוד שרץ, לא לפי שמות של סקילים מותקנים. ${c ? `עובד העריכה דיווח בהתחברות האחרונה: מודל תוכן ${c.content_model && c.content_model.enabled ? esc(c.content_model.model) : 'כבוי'} · זיהוי פנים ${c.face_detection ? 'קיים' : 'חסר'} · HyperFrames ${c.hyperframes ? 'קיים' : 'חסר'}${on ? '' : ' (העובד לא מחובר כרגע)'}.` : 'עובד העריכה עוד לא דיווח על היכולות במחשב שלו.'}</p>
        <ul class="plain">${CAP.map(([st, t, x]) => `<li><div class="row"><b class="grow">${t}</b><span class="pill ${ST[st][1]}">${ST[st][0]}</span></div><div class="small">${x}</div></li>`).join('')}</ul></div>`);
  }

  // ── a package: which version was reviewed, when, on which file, and is that still what is on screen ──
  function reviewInfoCard(r) {
    if (!r) return '';
    const fin = r.onFinalFile === true ? ['כן — על הקובץ הסופי, אחרי כל השינויים', 'ok'] : r.onFinalFile === false ? ['לא — הקובץ השתנה אחרי הביקורת', 'bad'] : ['לא נרשם בגרסה הזו', 'mute'];
    return `<div class="card" id="reviewinfo" ${r.upToDate ? '' : 'style="border-color:var(--bad)"'}><h2>על מה הביקורת הזו</h2>
      ${r.upToDate ? '<span class="pill ok">הביקורת מתייחסת לגרסה המוצגת</span>' : `<span class="pill bad">הביקורת אינה עדכנית</span><ul class="plain small">${r.stale.map(x => `<li class="bad">${esc(x)}</li>`).join('')}</ul>`}
      <ul class="plain small">
        <li>גרסת הסרטון שנבדקה: <b>${esc(r.versionN)}</b> · מועד הביקורת: ${r.reviewedAt ? fmt(r.reviewedAt) : r.packageReadyAt ? fmt(r.packageReadyAt) + ' (מועד החבילה)' : 'לא נרשם'}${r.rounds ? ` · ${esc(r.rounds)} סבבי ביקורת` : ''}</li>
        <li>בוצעה על הקובץ הסופי: <span class="${fin[1]}">${fin[0]}</span>${r.finalSha256 ? ` · <code>${esc(r.finalSha256.slice(0, 12))}…</code>` : ''}</li>
        <li>נמדד בקוד: <b>${r.counts.measured}</b> קריטריונים · נראה בפריימים: <b>${r.counts.frames}</b> · הערכת מודל: <b>${r.counts.model}</b> · לא נבדק: <b>${r.counts.not_checked}</b></li>
        <li>סקיל העריכה הבסיסי: ${r.editingSkill ? `${esc(r.editingSkill.name)} גרסה ${esc(r.editingSkill.version)}` : 'לא נרשם'} · סקיל מהספרייה: ${r.librarySkill ? `${esc(r.librarySkill.name)} גרסה ${esc(r.librarySkill.version)}${r.librarySkill.status === 'draft_test' ? ' (בדיקת טיוטה)' : ''}` : 'אין'} · פרופיל: ${r.profile ? `${esc(r.profile.id)} גרסה ${esc(r.profile.version)}` : '—'}</li>
        <li>רפרנסים ששימשו: ${(r.references || []).length ? r.references.map(x => `<code>${esc(x)}</code>`).join(' · ') : 'אין'} · גרסת קריטריונים <code>${esc(r.rubricVersion)}</code></li></ul>
      ${(r.notChecked || []).length ? `<details class="small"><summary>מה לא נבדק (${r.notChecked.length})</summary><ul class="plain">${r.notChecked.map(x => `<li>${esc(x.criterion)} <span class="mute">— ${esc(x.why)}</span></li>`).join('')}</ul></details>` : ''}
      <p class="small mute">${esc(r.basis || '')} ${esc(r.note)}</p></div>`;
  }

  // ── what a library skill did in this version, rule by rule ──
  const RST = { applied: ['יושם', 'ok'], not_followed: ['לא יושם', 'bad'], not_applicable: ['לא התאים לסרטון הזה', 'mute'], unsupported: ['לא נתמך', 'bad'], not_checked: ['לא נבדק', 'warn'] };
  function skillReportCard(pkg) {
    const r = pkg.skillReport, ch = pkg.skillChoice;
    if (!r) return ch ? `<div class="card" id="skillreport"><h2>סקיל עריכה</h2><div class="small">דנה לא בחרה סקיל מהספרייה: ${esc(ch.why || '')}</div></div>` : '';
    const k = r.skill, sm = r.summary, by = { owner: 'בחרת לפרויקט', default: 'ברירת המחדל המאושרת', dana: 'דנה הציעה', owner_test: 'בדיקת טיוטה' }[k.chosen_by] || k.chosen_by;
    return `<div class="card" id="skillreport"><h2>סקיל העריכה שהופעל: ${esc(k.name)} · גרסה ${esc(k.version)}</h2>
      <div class="row">${k.status === 'draft_test' ? '<span class="pill warn">טיוטה בבדיקה — לא סקיל מאושר</span>' : approvedPill()}<span class="pill mute">${esc(by)}</span>
        ${sm.fully_applied ? '<span class="pill ok">כל הכללים יושמו</span>' : '<span class="pill warn">לא יושם במלואו</span>'}</div>
      ${k.why ? `<div class="small">למה הסקיל הזה: ${esc(k.why)}</div>` : ''}
      <div class="small" style="margin-top:6px">יושמו ${sm.applied} · לא יושמו ${sm.not_followed} · לא התאימו ${sm.not_applicable} · לא נתמכים ${sm.unsupported} · לא נבדקו ${sm.not_checked}</div>
      <ul class="plain">${r.rules.map(x => { const s = RST[x.status] || [x.status, 'mute']; return `<li><div class="row"><span class="pill ${s[1]}">${s[0]}</span><span class="pill mute">${esc(domLabel(x.domain))}</span></div>
        <div>${esc(x.text)}</div><div class="small mute">${esc(x.note || '')}</div></li>`; }).join('') || '<li class="mute">בסקיל אין כללי טקסט, רק פרמטרים.</li>'}</ul>
      ${r.params.length ? `<details class="small" open><summary>פרמטרים (${r.params.filter(x => x.applied).length} מתוך ${r.params.length} כפי שבסקיל)</summary><ul class="plain">${r.params.map(x => `<li>${esc(PARAM[x.key] || x.key)}: בסקיל <b dir="ltr">${esc(x.skill)}</b> · בסרטון <b dir="ltr">${esc(x.used)}</b> ${x.applied ? '<span class="pill ok">זהה</span>' : `<span class="pill warn">שונה</span> <span class="mute">${esc(x.note || '')}</span>`}</li>`).join('')}</ul></details>` : ''}
      ${r.criteria.length ? `<details class="small" open><summary>ביקורת לפי קריטריוני הסקיל</summary><ul class="plain">${r.criteria.map(x => `<li><span class="pill ${x.met === true ? 'ok' : x.met === false ? 'bad' : 'warn'}">${x.met === true ? 'מתקיים' : x.met === false ? 'לא מתקיים' : 'לא נבדק'}</span> ${esc(x.text)}<div class="mute">${esc(x.note)}</div></li>`).join('')}</ul></details>` : ''}
      ${(r.not_adopted || []).length ? `<details class="small"><summary>השערות שלא אומצו ולכן לא הופעלו (${r.not_adopted.length})</summary><ul class="plain">${r.not_adopted.map(x => `<li>${esc(x.text)}</li>`).join('')}</ul></details>` : ''}
      <p class="small mute">${esc(r.basis)}</p></div>`;
  }

  // ═══ SKILL LIBRARY ════════════════════════════════════════════════════════
  let skillsNow = [], skDomains = {}, skProfiles = [], skTimer = null, skPick = null, skSetOrder = null, skFiles = [];
  const skEx = new Set();
  const domLabel = d => (skDomains[d] && skDomains[d].label) || ASPECT[d] || d;
  const SUP = { supported: ['נתמך', 'ok'], partial: ['נתמך חלקית', 'warn'], unsupported: ['לא נתמך', 'bad'] };
  const BASIS2 = Object.assign({}, BASIS, { owner_instruction: ['הוראה שלי', 'ok'], dana_suggestion: ['הצעה של דנה', 'warn'] });
  const SKST = { waiting_analysis: ['ממתין לניתוח סרטון הדוגמה', 'info'], draft: ['טיוטה', 'warn'], drafting: ['בניסוח אצל עובד העריכה', 'info'], draft_failed: ['הניסוח נכשל', 'bad'], approved: ['מאושר', 'ok'], approved_with_draft: ['מאושר · יש טיוטה לגרסה חדשה', 'ok'], retired: ['הוסר', 'mute'], discarded: ['נזנח', 'mute'] };
  const approvedSkills = () => skillsNow.filter(k => k.approved);
  function skillOptions(sel) {
    sel = sel || { mode: 'default' }; const defs = skillsNow.filter(k => k.default).sort((a, b) => (a.defaultOrder || 0) - (b.defaultOrder || 0));
    const mode = sel.mode === 'pinned' ? 'set' : sel.mode;
    return [`<option value="default" ${mode === 'default' ? 'selected' : ''}>ברירת המחדל המאושרת${defs.length ? ': ' + defs.map(k => `${esc(k.name)} גרסה ${k.defaultVersion}`).join(' + ') : ' (אין — נערך בלי סקיל מהספרייה)'}</option>`,
      `<option value="set" ${mode === 'set' ? 'selected' : ''}>לבחור סקיל או שילוב סקילים לפרויקט הזה</option>`,
      `<option value="suggest" ${mode === 'suggest' ? 'selected' : ''}>דנה תציע סקיל או שילוב מתאים מהספרייה, עם נימוק</option>`,
      `<option value="none" ${mode === 'none' ? 'selected' : ''}>בלי סקיל מהספרייה</option>`].join('');
  }
  const selItems = sel => !sel ? [] : sel.mode === 'pinned' ? [{ id: sel.id, version: sel.version, name: sel.name }] : sel.mode === 'set' ? (sel.items || []) : [];
  const skillChoiceNote = sel => !sel || sel.mode === 'default' ? 'אם הגדרת ברירת מחדל מאושרת (סקיל אחד או שילוב), היא מופעלת אוטומטית.'
    : sel.mode === 'pinned' || sel.mode === 'set' ? `לפרויקט נעולות הגרסאות: ${selItems(sel).map(x => `"${x.name}" גרסה ${x.version}`).join(' + ')}. גרסה חדשה של סקיל לא תשנה את הפרויקט עד שתבחר/י אותה.`
    : sel.mode === 'suggest' ? 'דנה תבחר רק מבין הסקילים שאישרת, ותכתוב למה.' : 'הפרויקט נערך לפי הכללים הבסיסיים בלבד.';
  /** The checklist of approved skills for a project. The order they are ticked is the priority order. */
  function skillSetBox(sel) {
    const chosen = selItems(sel).map(x => x.id), ap = approvedSkills();
    if (!ap.length) return '<div class="small mute">אין עדיין סקיל מאושר בספרייה.</div>';
    return `<div id="pskillset">${ap.map(k => { const i = chosen.indexOf(k.id); return `<label class="chk"><input type="checkbox" data-pskill="${esc(k.id)}" ${i >= 0 ? 'checked' : ''} data-nodirty="1">
      <span>${i >= 0 ? `<b>${i + 1}.</b> ` : ''}${esc(k.name)} · גרסה ${k.approved.version} <span class="mute">(${esc((k.kinds || []).join(', ') || 'פרמטרים בלבד')})</span></span></label>`; }).join('')}
      <div class="small mute">הסדר שבו סימנת הוא סדר העדיפות: כששני סקילים סותרים, הראשון קובע. כולם ממוזגים לתוכנית עריכה אחת.</div></div>`;
  }
  const conflictList = cs => !(cs || []).length ? '' : `<div class="card" id="pconf" style="border-color:var(--warn)"><b class="warn">סתירות בשילוב שנבחר — מוצגות לפני ההפקה</b><ul class="plain small">${cs.map(c => c.kind === 'parameter'
      ? `<li><span class="pill bad">סתירה</span> ${esc(PARAM[c.key] || c.key)}: "${esc(c.used.skill)}" קובע <b dir="ltr">${esc(c.used.value)}</b>, "${esc(c.not_used.skill)}" קובע <b dir="ltr">${esc(c.not_used.value)}</b>. ${esc(c.resolution)} → ייכנס <b dir="ltr">${esc(c.used.value)}</b>.</li>`
      : `<li><span class="pill warn">חפיפה</span> ${esc(c.label)}: ${esc(c.skills.join(', '))}. ${esc(c.resolution)}.</li>`).join('')}</ul>
      ${cs.some(c => c.kind === 'parameter') ? '<label class="chk"><input type="checkbox" id="pconfok" data-nodirty="1"> ההכרעה הזו מקובלת עליי</label>' : ''}</div>`;

  async function loadSkills() {
    const j = await api('/skills'); skillsNow = j.skills; skDomains = j.domains; skProfiles = j.profiles || [];
    const def = skillsNow.find(k => k.default);
    $('#skilldef').textContent = def ? `${def.name} · גרסה ${def.defaultVersion}${status && status.dataBanner ? ' (אישור בדיקה סינתטי)' : ''}` : 'אין — פרויקטים נערכים בלי סקיל מהספרייה';
    setHtml($('#skills'), (skillsNow.length ? skillsNow.map(k => { const st = SKST[k.status] || [k.status, 'mute'], v = k.draft || k.approved || {}, c = v.counts || {};
      return `<li data-skid="${esc(k.id)}"><div class="row"><b class="grow">${esc(k.name)}</b><span class="pill ${st[1]}">${st[0]}</span>${k.default ? '<span class="pill ok">ברירת מחדל</span>' : ''}</div>
        <div class="small mute">${k.approved ? `גרסה מאושרת ${k.approved.version} · ` : ''}${c.active ?? 0} כללים פעילים${c.unsupported ? ` · <span class="bad">${c.unsupported} לא נתמכים</span>` : ''}${c.hypotheses ? ` · ${c.hypotheses} השערות` : ''}${c.open_conflicts ? ` · <span class="bad">${c.open_conflicts} סתירות פתוחות</span>` : ''}</div>
        <button class="sm" data-skopen="${esc(k.id)}" style="margin-top:4px">${ui.skill === k.id ? 'פתוח למטה' : 'פתיחה'}</button></li>`; }).join('') : '<li class="mute">עדיין אין סקילים בספרייה.</li>')
      + (skProfiles.length ? `<li><details class="small"><summary>פרופילי פרמטרים מהמנגנון הקודם (${skProfiles.length})</summary><ul class="plain">${skProfiles.map(p => `<li>${esc(p.id)} · גרסה ${esc(p.version)}${p.default ? ' · ברירת מחדל ישנה' : ''} <button class="sm" data-skprofile="${esc(p.id)}|${esc(p.version)}">צור ממנו טיוטת סקיל</button></li>`).join('')}</ul>
          <div class="mute">סקיל מאושר שהוגדר כברירת מחדל גובר על ברירת המחדל הישנה.</div></details></li>` : ''));
    const ap = approvedSkills(), defs = ap.filter(k => k.default).sort((a, b) => (a.defaultOrder || 0) - (b.defaultOrder || 0)).map(k => k.id);
    if (!skSetOrder) skSetOrder = defs.slice();
    setHtml($('#skset'), ap.length ? ap.map(k => { const i = skSetOrder.indexOf(k.id); return `<label class="chk"><input type="checkbox" data-skset="${esc(k.id)}" ${i >= 0 ? 'checked' : ''} data-nodirty="1">
      <span>${i >= 0 ? `<b>${i + 1}.</b> ` : ''}${esc(k.name)} · גרסה ${k.approved.version} <span class="mute">(${esc((k.kinds || []).join(', ') || 'פרמטרים בלבד')})</span></span></label>`; }).join('') : '<span class="mute">אין עדיין סקיל מאושר.</span>');
    renderSkill();
    clearTimeout(skTimer);
    if (skillsNow.some(k => ['drafting', 'waiting_analysis'].includes(k.status)) && !$('#home').classList.contains('hidden')) skTimer = setTimeout(() => loadSkills().catch(e => refreshFailed(e)), 5000);
  }
  function renderSkillRefs() {
    const an = refsNow.filter(r => r.analysis);
    setHtml($('#skex'), an.length ? an.map(r => `<div style="margin:4px 0"><label class="chk"><input type="checkbox" data-skex="${esc(r.id)}" ${skEx.has(r.id) ? 'checked' : ''} data-nodirty="1"> ${esc(r.title)}</label>
      <input type="text" data-sktake="${esc(r.id)}" placeholder="מה לקחת מהסרטון הזה" maxlength="600" value="${esc(r.owner_note || '')}"></div>`).join('') : '<span class="mute">אין עדיין רפרנס מנותח. אפשר לצרף סרטון חדש למטה.</span>');
    setHtml($('#skrefs'), an.length ? an.map(r => `<label class="chk"><input type="checkbox" data-refsel="${esc(r.id)}" ${refSel.has(r.id) ? 'checked' : ''} data-nodirty="1"> ${esc(r.title)}</label>`).join('') : '<span class="mute">אין עדיין רפרנס מנותח. מעלים רפרנס בלשונית "רפרנסים וסגנון עריכה".</span>');
    $('#skfromrefs').disabled = refSel.size < 1;
  }
  $('#skrefs').onchange = e => { const id = e.target.dataset.refsel; if (!id) return; e.target.checked ? refSel.add(id) : refSel.delete(id); $('#skfromrefs').disabled = refSel.size < 1; $('#refcompare').disabled = refSel.size < 2; };
  $('#skfromrefs').onclick = () => openSkillPicker();

  // "צור סקיל מהניתוח": choose what to take from each reference
  async function openSkillPicker() {
    try { const ids = [...refSel]; const { comparison } = await api('/references/compare', { method: 'POST', body: { ids, single: ids.length === 1 } });
      skPick = comparison; ui.skill = null; showHome('skills'); renderPicker(); $('#skillcard').scrollIntoView({ block: 'start' }); } catch (err) { notice(err.message, 'bad'); }
  }
  function defaultPicks(c) {
    return { aspects: c.aspects.flatMap(a => a.by_reference.filter(x => x.observation && x.basis !== 'hypothesis').map(x => ({ ref: x.ref, aspect: a.aspect }))),
             params: Object.fromEntries(Object.entries(c.proposal.params).filter(([, p]) => p.suggested).map(([k, p]) => [k, p.suggested])) };
  }
  function renderPicker() {
    const c = skPick, R = c.references, title = id => (R.find(r => r.id === id) || {}).title || id;
    $('#skillcard').classList.remove('hidden');
    setHtml($('#skillcard'), `<h2>צור סקיל מהניתוח: ${R.map(r => esc(r.title)).join(' + ')}</h2>
      <label for="pk_name">שם הסקיל</label><input type="text" id="pk_name" maxlength="80" placeholder="למשל: ראיון מתאמנת — קצב רגוע">
      <h3>מה לקחת מכל רפרנס</h3>
      <p class="small mute">כל שורה מסומנת תהפוך לכלל, מקושר לממצא ולזמנים שלו ברפרנס. ממצא שהוא השערה ייכנס כהשערה בלבד ולא יופעל, עד שתאמצ/י אותו במפורש בטיוטה.</p>
      <ul class="plain">${c.aspects.map(a => a.by_reference.filter(x => x.observation).map(x => { const b = BASIS[x.basis] || [x.basis, 'mute']; return `<li><label class="chk" style="align-items:flex-start"><input type="checkbox" data-pkasp="${esc(x.ref)}|${esc(a.aspect)}" ${x.basis === 'hypothesis' ? '' : 'checked'}>
        <span><b>${esc(ASPECT[a.aspect] || a.aspect)}</b> <span class="pill ${b[1]}">${esc(b[0])}</span> <span class="mute">${esc(title(x.ref))}${(x.example_times_s || []).length ? ' · ' + x.example_times_s.map(tfmt).join(', ') : ''}</span>
          <br>${esc(x.rule || x.observation)}<br><span class="small mute">הממצא: ${esc(x.observation)}</span></span></label></li>`; }).join('')).join('')}</ul>
      <h3>פרמטרים</h3>
      <ul class="plain">${Object.entries(c.proposal.params).map(([k, p]) => `<li><b>${esc(PARAM[k] || k)}</b>
        <div class="row" style="margin-top:4px">${p.options.map(o => `<label class="chk"><input type="radio" name="pkp_${esc(k)}" value="${esc(o.ref)}" ${p.suggested === o.ref ? 'checked' : ''}> ${esc(o.title)}: <b dir="ltr">${esc(o.value)}</b> <span class="pill ${(BASIS[o.basis] || ['', 'mute'])[1]}">${esc((BASIS[o.basis] || [o.basis])[0])}</span></label>`).join('')}
          <label class="chk"><input type="radio" name="pkp_${esc(k)}" value="" ${p.suggested ? '' : 'checked'}> לא לקחת</label></div></li>`).join('') || '<li class="mute">הניתוחים לא הציעו מספרים.</li>'}</ul>
      <button class="primary" id="pk_create" style="margin-top:10px;width:100%">צור טיוטת סקיל</button>
      <p class="small mute">נוצרת טיוטה בלבד. היא לא תשמש אף פרויקט ולא תהיה ברירת מחדל עד שתאשר/י אותה. סגנון בלבד: תוכן, מוזיקה ונכסים של הרפרנס לא מועתקים.</p>`);
  }
  function collectPicks() {
    const aspects = $$('#skillcard [data-pkasp]:checked').map(x => { const [ref, aspect] = x.dataset.pkasp.split('|'); return { ref, aspect }; }), params = {};
    for (const k of Object.keys(skPick.proposal.params)) { const r = document.querySelector(`#skillcard input[name="pkp_${CSS.escape(k)}"]:checked`); if (r && r.value) params[k] = r.value; }
    return { aspects, params };
  }
  $('#skex').onchange = e => { const id = e.target.dataset.skex; if (id) e.target.checked ? skEx.add(id) : skEx.delete(id); };
  $('#skaddfiles').onclick = () => $('#sk_files').click();
  $('#sk_files').onchange = () => { skFiles = Array.from($('#sk_files').files);
    $('#sknew').innerHTML = skFiles.map((f, i) => `<div style="margin:6px 0"><b>${esc(f.name)}</b> <span class="mute">${mb(f.size)}MB — יועלה וינותח לפני ניסוח הסקיל</span>
      <input type="text" id="skn_t${i}" placeholder="מה לקחת מהסרטון הזה" maxlength="600"><div class="mute" id="skn_s${i}"></div></div>`).join(''); };
  $('#skset').onchange = e => { const id = e.target.dataset.skset; if (!id) return; skSetOrder = (skSetOrder || []).filter(x => x !== id); if (e.target.checked) skSetOrder.push(id); $('#skset').__html = null; loadSkills().catch(() => {}); };
  $('#sksetsave').onclick = async () => {
    const by = who(); if (!by) return; if (!(skSetOrder || []).length) return notice('לא סומן אף סקיל.', 'warn');
    const send = confirm_conflicts => api('/skills/default-set', { method: 'POST', body: { by, ids: skSetOrder, confirm_conflicts } });
    try { await send(false); await loadSkills(); notice('השילוב נקבע כברירת המחדל. הוא יופעל אוטומטית בעריכות הבאות.', 'ok'); }
    catch (err) { const cs = err.data && err.data.conflicts; if (!cs) return notice(err.message, 'bad');
      const text = cs.filter(c => c.kind === 'parameter').map(c => `${PARAM[c.key] || c.key}: "${c.used.skill}" (${c.used.value}) גובר על "${c.not_used.skill}" (${c.not_used.value})`).join('\n');
      if (!confirm('הסקילים שנבחרו סותרים זה את זה. לפי סדר העדיפות שסימנת:\n' + text + '\n\nלאשר את ההכרעה הזו ולקבוע כברירת מחדל?')) return;
      try { await send(true); await loadSkills(); notice('השילוב נקבע כברירת המחדל, עם ההכרעה שאישרת.', 'ok'); } catch (e2) { notice(e2.message, 'bad'); } }
  };
  $('#skfromprompt').onclick = async () => {
    const by = who(); if (!by) return;
    const take = {}; $$('#skex [data-sktake]').forEach(i => { if (skEx.has(i.dataset.sktake)) take[i.dataset.sktake] = i.value; });
    const ids = [...skEx];
    $('#skfromprompt').disabled = true;
    try {
      for (let i = 0; i < skFiles.length; i++) {            // a new example video becomes a reference: analysed once, reusable afterwards
        const fd = new FormData(), f = skFiles[i], note = $('#skn_t' + i).value;
        fd.append('title', f.name.replace(/\.[^.]+$/, '')); fd.append('owner_note', note); fd.append('usage_permission', 'inspiration_only'); fd.append('by', by); fd.append('file', f, f.name);
        const j = await sendFile('/references', fd, (sent, total) => { $('#skn_s' + i).textContent = `${(100 * sent / total).toFixed(0)}%`; });
        ids.push(j.reference.id); take[j.reference.id] = note; $('#skn_s' + i).textContent = 'הועלה — ממתין לניתוח';
      }
      const j = await api('/skills/from-prompt', { method: 'POST', body: { by, name: $('#sk_name').value, prompt: $('#sk_prompt').value, goal: $('#sk_goal').value, must: $('#sk_must').value.split('\n'),
        open: $('#sk_open').value.split('\n'), avoid: $('#sk_avoid').value, ids, take } });
      for (const id of ['#sk_name', '#sk_prompt', '#sk_goal', '#sk_must', '#sk_open', '#sk_avoid']) { $(id).value = ''; delete $(id).dataset.dirty; }
      skEx.clear(); skFiles = []; $('#sk_files').value = ''; $('#sknew').innerHTML = ''; skPick = null; ui.skill = j.skill.id; remember(); await loadRefs().catch(() => {}); await loadSkills();
      notice(j.skill.status === 'waiting_analysis' ? 'סרטון הדוגמה נכנס לניתוח; הטיוטה תנוסח כשהניתוח יסתיים.' : 'הבקשה נשלחה לעובד העריכה לניסוח טיוטה. ניתוחים קיימים של רפרנסים לא חוזרים על עצמם.', 'ok');
    } catch (err) { notice(err.message, 'bad'); } finally { $('#skfromprompt').disabled = false; }
  };
  let storageNow = null;
  const gb = b => b == null ? '—' : (b / 1024 ** 3).toFixed(1) + 'GB';
  async function loadStorage() { try { storageNow = (await api('/storage')).storage; } catch { storageNow = null; } }
  function storageCard(worker) {
    const s = storageNow; if (!s) return '';
    const w = s.worker;
    return `<div class="card" id="storage"><h2>אחסון ועבודה שוטפת</h2><ul class="plain small">
      <li>גודל העלאה מרבי לקובץ: ${esc(s.uploadLimitMb)}MB</li>
      <li class="${s.lowSpace ? 'bad' : ''}">מקום פנוי בשרת: ${gb(s.freeBytes)} מתוך ${gb(s.totalBytes)}${s.lowSpace ? ' — מעט מקום: כדאי לפנות לפני העלאה גדולה' : ''}</li>
      <li>בשימוש: מקורות ואודיו ${gb(s.used.sources_and_audio.bytes)} (${s.used.sources_and_audio.files} קבצים) · גרסאות ${gb(s.used.versions.bytes)} · רפרנסים ${gb(s.used.references.bytes)}</li>
      <li>מחשב העריכה: ${w ? `${esc(w.free_gb)}GB פנויים (נדרשים ${esc(w.min_free_gb)}GB כדי לקבל משימה)${w.ok ? '' : ' — <b class="bad">לא מקבל משימות עד שיתפנה מקום</b>'}` : 'לא דווח'}${s.workerKeepsJobFoldersDays ? ` · תיקיות עבודה זמניות נמחקות אחרי ${esc(s.workerKeepsJobFoldersDays)} ימים` : ''}</li>
      <li>עובד העריכה: ${worker && worker.online ? '<span class="ok">מחובר</span>' : '<span class="bad">לא מחובר</span> — משימות ימתינו בתור ולא יאבדו'} · משימה שנקטעה חוזרת לתור (עד 3 ניסיונות), בלי כפילות</li>
      <li>שאריות של העלאות שנקטעו: ${s.uploadLeftovers.files} קבצים (${gb(s.uploadLeftovers.bytes)}) ${s.uploadLeftovers.files ? '<button class="sm" id="st_clean">למחוק את השאריות</button>' : ''}</li></ul>
      <details class="small"><summary>מדיניות מחיקה</summary><ul class="plain">${s.policy.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>
      <details class="small"><summary>הפעלה קבועה של עובד העריכה</summary><div>העובד יכול לעלות לבד עם הכניסה למחשב (משימה מתוזמנת אחת של Windows, בלי הרשאות מנהל). ההתקנה היא פעולה אחת שלך במחשב העריכה, לא מהפאנל:
        <code dir="ltr">powershell -ExecutionPolicy Bypass -File dana-worker\\autostart\\install.ps1</code>. לעצירה: <code dir="ltr">stop.ps1</code>; להסרה: <code dir="ltr">uninstall.ps1</code>.</div></details></div>`;
  }
  $('#about').onclick = async e => {
    if (e.target.id === 'st_clean') { const by = who(); if (!by) return; if (!confirm('למחוק שאריות של העלאות שנקטעו (מעל 24 שעות)? קובצי מקור ותוצרים לא נמחקים.')) return;
      try { storageNow = (await api('/storage/cleanup-upload-leftovers', { method: 'POST', body: { by } })).storage; notice('השאריות נמחקו.', 'ok'); $('#about').__html = null; renderAbout(status && status.worker); } catch (err) { notice(err.message, 'bad'); }
      return; }
    if (e.target.id !== 'tts_est') return;
    try { const j = await api('/narration/estimate', { method: 'POST', body: { text: $('#tts_text').value } }), x = j.estimate;
      $('#tts_out').textContent = x.characters + ' תווים · כ-' + x.estimated_usd + '$ ליצירה אחת (' + x.model + ', ' + x.usd_per_1000_chars + '$ לאלף תווים). ' + x.basis; }
    catch (err) { notice(err.message, 'bad'); } };
  $('#skills').onclick = async e => {
    const d = e.target.dataset;
    if (d.skopen) { ui.skill = d.skopen; skPick = null; remember(); await loadSkills(); $('#skillcard').scrollIntoView({ block: 'start' }); }
    if (d.skprofile) { const by = who(); if (!by) return; const [profileId, version] = d.skprofile.split('|');
      try { const j = await api('/skills/from-profile', { method: 'POST', body: { by, profileId, version } }); ui.skill = j.skill.id; remember(); await loadSkills(); notice('נוצרה טיוטת סקיל מהפרופיל.', 'ok'); } catch (err) { notice(err.message, 'bad'); } }
  };

  // one skill: a readable draft that can be edited, tested on a clip and approved
  function renderSkill() {
    if (skPick) return renderPicker();
    const k = skillsNow.find(x => x.id === ui.skill), el = $('#skillcard');
    if (!k) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const v = k.draft || k.approved; if (!v) return setHtml(el, `<h2>${esc(k.name)}</h2><div class="mute">לסקיל הזה אין גרסה פעילה.</div>`);
    const isDraft = !!k.draft && v.status === 'draft', st = SKST[k.status] || [k.status, 'mute'], ro = isDraft ? '' : 'disabled';
    if (v.status === 'drafting') return setHtml(el, `<h2>${esc(k.name)}</h2><span class="pill info">עובד העריכה מנסח את הטיוטה מההוראות שלך…</span><div class="quote" style="margin-top:8px">${esc(v.sources.prompt || '')}</div>
      <p class="small mute">${(status && status.worker && status.worker.online) ? '' : 'עובד העריכה לא מחובר כרגע — הניסוח ימתין עד שיתחבר.'}</p>`);
    if (v.status === 'draft_failed') return setHtml(el, `<h2>${esc(k.name)}</h2><span class="pill bad">הניסוח נכשל</span><div class="bad">${esc((v.error || {}).message || '')}</div><button class="sm danger" data-sk="retire" style="margin-top:8px">הסרה</button>`);
    const rule = r => { const b = BASIS2[r.basis] || [r.basis, 'mute'], s = SUP[r.support], src = r.source || {};
      return `<li data-rule="${esc(r.id)}"><div class="row"><span class="pill mute">${esc(domLabel(r.domain))}</span><span class="pill ${b[1]}">${esc(b[0])}</span><span class="pill ${s[1]}">${s[0]}</span>
          ${r.prohibition && r.support !== 'unsupported' ? '<span class="pill ok">איסור — נבדק בכל גרסה</span>' : ''}${r.support === 'unsupported' ? '<span class="pill bad">לא יופעל</span>' : r.overruled ? '<span class="pill mute">נדחה מפני הוראה שלך</span>' : r.basis === 'hypothesis' ? '<span class="pill warn">השערה — לא כלל</span>' : r.basis === 'dana_suggestion' ? '<span class="pill warn">הצעה — לא כלל</span>' : r.active ? '<span class="pill ok">פעיל</span>' : '<span class="pill mute">כבוי</span>'}</div>
        <textarea data-rule="${esc(r.id)}" style="min-height:44px;margin-top:4px" ${ro}>${esc(r.text)}</textarea>
        <div class="small mute">${src.type === 'reference' ? `מקור: הרפרנס "${esc(src.title)}" · ${esc(ASPECT[src.aspect] || src.aspect)} · ${esc(src.observation || '')} ${(src.times_s || []).map(t => `<button class="sm" data-refplay="${esc(src.ref)}" data-t="${t}">▶ ${tfmt(t)}</button>`).join(' ')}`
          : src.type === 'dana' ? 'מקור: הצעה של דנה — לא כלל עד שתאמצ/י אותה' : src.type === 'prompt' ? `מקור: הוראה שלך${r.mandatory ? ' (חובה)' : ''}` : src.type === 'conflict_resolution' ? 'מקור: פתרון סתירה שבחרת' : src.type === 'profile' ? 'מקור: פרופיל קודם' : 'מקור: עריכה שלך'}${r.adopted ? ` · אומץ מהשערה על ידי ${esc(r.adopted.by)}` : ''}</div>
        ${r.support !== 'supported' ? `<div class="small ${r.support === 'unsupported' ? 'bad' : 'warn'}">${esc(r.support_note)}</div>` : ''}
        ${isDraft ? `<div class="row" style="margin-top:4px">${['hypothesis', 'dana_suggestion'].includes(r.basis) && r.support !== 'unsupported' ? `<button class="sm" data-sk="adopt" data-id="${esc(r.id)}">לאמץ כהוראה שלי</button>` : ''}
          ${r.support !== 'unsupported' && !['hypothesis', 'dana_suggestion'].includes(r.basis) ? `<label class="chk" style="margin:0"><input type="checkbox" data-ruleon="${esc(r.id)}" ${r.active ? 'checked' : ''}> פעיל</label>` : ''}<button class="sm danger" data-sk="rmrule" data-id="${esc(r.id)}">הסרה</button></div>` : ''}</li>`; };
    const c = v.counts;
    setHtml(el, `<div class="row"><h2 class="grow">${esc(k.name)} · גרסה ${v.version}</h2><span class="pill ${st[1]}">${st[0]}</span>${k.default ? '<span class="pill ok">ברירת מחדל</span>' : ''}</div>
      <div class="small mute">מזהה <code>${esc(k.id)}</code> · נוצר ${fmt(v.createdAt)} על ידי ${esc(v.createdBy || '—')} · מקור: ${esc({ analysis: 'ניתוח רפרנסים', prompt: 'הוראות', combined: 'הוראות + ניתוח רפרנסים', profile: 'פרופיל קודם' }[v.origin] || v.origin)}${v.approvedAt ? ` · אושר ${fmt(v.approvedAt)} על ידי ${esc(v.approvedBy)}${status && status.dataBanner ? ' (אישור בדיקה סינתטי)' : ''}` : ''}</div>
      ${!isDraft && k.approved ? '<div class="small" style="margin-top:6px">גרסה מאושרת אינה משתנה. שמירת שינוי תפתח טיוטה של גרסה חדשה; פרויקטים קיימים נשארים על הגרסה שלהם.</div>' : '<div class="pill warn" style="margin-top:6px">טיוטה — לא משמשת אף פרויקט ולא ברירת מחדל עד שתאשר/י</div>'}
      ${c.unsupported ? `<div class="card" style="border-color:var(--bad)"><b class="bad">${c.unsupported} מהכללים אינם נתמכים על ידי עובד העריכה.</b><div class="small">הם נשמרים לתיעוד, לא יופעלו ולא ייספרו כמיושמים. הסקיל לא ייושם במלואו.</div></div>` : ''}
      <label for="sk_e_name">שם</label><input type="text" id="sk_e_name" value="${esc(k.name)}" maxlength="80" ${k.draft ? '' : 'disabled'}>
      <label for="sk_e_purpose">מטרת הסקיל</label><textarea id="sk_e_purpose" style="min-height:60px" ${ro}>${esc(v.purpose)}</textarea>
      <label for="sk_e_suit">סוגי סרטונים מתאימים (שורה לכל סוג)</label><textarea id="sk_e_suit" style="min-height:60px" ${ro}>${esc((v.suitable_for || []).join('\n'))}</textarea>
      ${(v.conflicts || []).length ? `<h3 class="${c.open_conflicts ? 'bad' : ''}">סתירות בין הוראות (${c.open_conflicts} פתוחות)</h3><ul class="plain">${v.conflicts.map(x => { const A = v.rules.find(r => r.id === x.a) || {}, B = v.rules.find(r => r.id === x.b) || {};
        return `<li><div class="small">${esc(x.why)}</div>${x.auto ? `<span class="pill ok">הוראה מפורשת שלך גוברת על הסגנון שברפרנס</span><div class="small">נשאר: <b>${esc((x.resolution === 'a' ? A : B).text)}</b> · נדחה: ${esc((x.resolution === 'a' ? B : A).text)}</div>`
          : x.resolution ? `<span class="pill ok">הוכרע: ${esc({ a: 'נשאר הראשון', b: 'נשאר השני', suggestion: 'אומצה ההצעה', keep_both: 'נשארו שניהם' }[x.resolution])}</span>` : `
          <label class="chk"><input type="radio" name="cf_${esc(x.id)}" value="a"> להשאיר: ${esc(A.text)}</label><label class="chk"><input type="radio" name="cf_${esc(x.id)}" value="b"> להשאיר: ${esc(B.text)}</label>
          <label class="chk"><input type="radio" name="cf_${esc(x.id)}" value="suggestion"> הצעת דנה: ${esc(x.suggestion)}</label><label class="chk"><input type="radio" name="cf_${esc(x.id)}" value="keep_both"> להשאיר את שניהם בכל זאת</label>`}</li>`; }).join('')}</ul>` : ''}
      ${v.upgrade ? upgradeDiff(v) : ''}
      ${(v.uncertain || []).length ? `<h3 class="warn">חוסר ודאות — לבדיקה שלך לפני אישור</h3><ul class="plain small">${v.uncertain.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${(v.coverage_gaps || []).length ? `<h3 class="warn">כיסוי שחסר בניתוחים הקיימים</h3><ul class="plain small">${v.coverage_gaps.map(x => `<li>${esc(x)}</li>`).join('')}</ul><div class="small mute">כדי לכסות את זה נדרש ניתוח נוסף או הוראה מפורשת שלך.</div>` : ''}
      ${v.brief ? `<details class="small"><summary>מה ביקשת</summary><ul class="plain">${v.brief.goal ? `<li>מה להשיג: ${esc(v.brief.goal)}</li>` : ''}${(v.brief.must || []).length ? `<li>חובה: ${v.brief.must.map(esc).join(' · ')}</li>` : ''}${(v.brief.open || []).length ? `<li>פתוח להצעה: ${v.brief.open.map(esc).join(' · ')}</li>` : ''}${v.brief.avoid ? `<li>לא לקחת: ${esc(v.brief.avoid)}</li>` : ''}
        ${v.sources.prompt ? `<li>ההוראות: ${esc(v.sources.prompt)}</li>` : ''}</ul></details>` : ''}
      <h3>כללי עריכה (${c.active} פעילים${c.hypotheses ? `, ${c.hypotheses} השערות` : ''}${c.unsupported ? `, ${c.unsupported} לא נתמכים` : ''})</h3>
      <ul class="plain">${v.rules.map(rule).join('') || '<li class="mute">אין כללי טקסט.</li>'}</ul>
      ${isDraft ? `<div class="row"><input type="text" id="sk_e_newrule" class="grow" placeholder="כלל נוסף, כהוראה שלי" style="flex:1;min-width:160px"><select id="sk_e_newdom" style="width:auto">${Object.entries(skDomains).map(([d, x]) => `<option value="${d}">${esc(x.label)}</option>`).join('')}</select></div>` : ''}
      <h3>פרמטרים</h3><ul class="plain">${Object.entries(v.params).map(([key, val]) => `<li><div class="row"><span class="grow">${esc(PARAM[key] || key)} <span class="mute small">${esc((v.param_sources[key] || {}).title || '')}</span></span>
        ${typeof val === 'boolean' ? `<input type="checkbox" data-kp="${esc(key)}" data-pt="boolean" ${val ? 'checked' : ''} ${ro}>` : `<input type="text" data-kp="${esc(key)}" data-pt="${typeof val}" value="${esc(val)}" dir="ltr" style="width:110px" ${ro}>`}</div></li>`).join('') || '<li class="mute">אין פרמטרים — נשארים המספרים של הפרופיל הבסיסי.</li>'}</ul>
      <h3>קריטריוני ביקורת</h3><ul class="plain small">${v.criteria.map(x => `<li><code>${esc(x.id)}</code> ${esc(x.text)}</li>`).join('') || '<li class="mute">אין.</li>'}</ul>
      <h3>יכולות ביצוע שהסקיל דורש</h3><ul class="plain small">${v.requires.map(x => `<li><span class="pill ${SUP[x.support][1]}">${SUP[x.support][0]}</span> <b>${esc(x.label)}</b> — ${esc(x.note)}</li>`).join('')}</ul>
      <p class="small mute">שם הסקיל הוא תווית בלבד; מה שקובע מה יבוצע הוא היכולות האלה.</p>
      ${v.sample ? `<div class="card"><b>דוגמת תוצר מבדיקה</b><div class="small">פרויקט "${esc(v.sample.projectTitle)}", גרסה ${esc(v.sample.versionN)} · ${fmt(v.sample.at)} · יושמו ${v.sample.applied}, לא יושמו ${v.sample.not_followed}, לא התאימו ${v.sample.not_applicable}, לא נבדקו ${v.sample.not_checked}</div>
        <button class="sm" data-id="${esc(v.sample.projectId)}" data-sk="opensample">פתיחת הסרטון</button></div>` : '<div class="small mute">עדיין אין דוגמת תוצר: הסקיל לא נבדק על קליפ.</div>'}
      <details class="small"><summary>היסטוריית שינויים (${v.history.length})</summary><ul class="plain">${v.history.slice().reverse().map(x => `<li>${fmt(x.at)} · ${esc(x.by || '—')} · ${esc(x.action)}${x.detail && Array.isArray(x.detail.changed) ? ' — ' + esc(x.detail.changed.join(', ')) : x.action === 'upgrade_proposed' && x.detail ? ' — נוספו ' + x.detail.added + ', שונו ' + x.detail.changed + ', הוסרו ' + x.detail.removed : ''}</li>`).join('')}</ul>
        <div class="mute">גרסאות: ${k.versions.map(x => `${x.version} (${esc((SKST[x.status] || [x.status])[0])})`).join(' · ')}</div></details>
      <details class="small"><summary>SKILL.md של הגרסה הזו</summary><pre style="white-space:pre-wrap;direction:ltr;text-align:left;font-size:12px">${esc(v.skill_md || '')}</pre></details>
      <div class="row" style="margin-top:10px">
        <button data-sk="save" class="${isDraft ? '' : 'hidden'}">שמירת הטיוטה</button>
        ${isDraft ? `<select id="sk_e_testproj" style="width:auto;flex:1;min-width:150px"><option value="">בדיקה על קליפ: בחר/י פרויקט…</option></select><button data-sk="test">בדוק על הקליפ</button>` : ''}</div>
      ${isDraft ? `<label class="chk"><input type="checkbox" id="sk_e_default"> להפוך לברירת המחדל אחרי האישור</label>
        <button class="primary" data-sk="approve" style="width:100%" ${c.open_conflicts ? 'disabled' : ''}>אישור הסקיל</button>
        <p class="small mute">${c.open_conflicts ? 'יש להכריע בסתירות ולשמור לפני אישור. ' : ''}אישור סקיל מאשר סגנון עריכה. הוא אינו אישור לפרסום.</p>` : ''}
      ${k.approved && !isDraft ? `<div class="card" id="skupgrade"><b>שדרג סקיל באמצעות רפרנס</b>
        <div class="small mute">תיקון ממוקד: מה שהרפרנס וההוראות לא נוגעים בו נשאר כמו שהוא. נוצרת טיוטה של גרסה חדשה עם השוואה; הגרסה הנוכחית ופרויקטים קיימים נשמרים.</div>
        <select id="sk_up_ref">${refsNow.filter(r => r.analysis).map(r => `<option value="${esc(r.id)}">${esc(r.title)} (ניתוח שמור)</option>`).join('') || '<option value="">אין רפרנס מנותח</option>'}</select>
        <textarea id="sk_up_text" style="min-height:50px;margin-top:6px" placeholder="הוראות לשדרוג (לא חובה): מה לשפר לפי הרפרנס"></textarea>
        <button data-sk="upgrade" style="margin-top:6px">הצע שדרוג</button></div>` : ''}
      <div class="row">${k.approved && !isDraft ? `<button data-sk="startdraft">עריכה (פותח טיוטת גרסה חדשה)</button><button data-sk="${k.default ? 'undefault' : 'default'}">${k.default ? 'הסרה מברירת המחדל' : 'קביעה כברירת מחדל'}</button>` : ''}<button class="danger" data-sk="retire">הסרת הסקיל</button></div>`);
    const sel = $('#sk_e_testproj'); if (sel && sel.options.length < 2) api('/projects').then(j => { for (const p of j.projects) if (p.kind !== 'review_only' && ['ready_for_review', 'approved'].includes(p.status)) sel.add(new Option(p.title.slice(0, 40), p.id)); }).catch(() => {});
  }
  function upgradeDiff(v) {
    const d = v.upgrade.diff; if (!d) return '<div class="pill info">הצעת השדרוג בהכנה…</div>';
    return `<div class="card" id="skdiff" style="border-color:var(--info)"><b>שדרוג מגרסה ${esc(v.upgrade.from)} באמצעות: ${v.upgrade.references.map(r => esc(r.title)).join(', ')}</b>
      <div>${esc(d.summary || '')}</div>${d.large_change ? '<div class="small bad">השדרוג נוגע ביותר מחצי מהכללים — זה כבר לא תיקון נקודתי. כדאי לבדוק היטב לפני אישור.</div>' : ''}
      <ul class="plain small">
        <li><span class="pill ok">נשאר</span> ${d.kept.length} כללים בלי שינוי</li>
        ${d.added.map(x => `<li><span class="pill info">נוסף</span> ${esc(x.text)} <span class="mute">(${esc(domLabel(x.domain))}${x.active ? '' : ' · לא פעיל עד שתאמצ/י'})</span><div class="mute">למה: ${esc(x.why)}</div></li>`).join('')}
        ${d.changed.map(x => `<li><span class="pill warn">השתנה</span> <span class="mute">לפני:</span> ${esc(x.before)}<br><span class="mute">אחרי:</span> <b>${esc(x.after)}</b><div class="mute">למה: ${esc(x.why)}</div></li>`).join('')}
        ${d.removed.map(x => `<li><span class="pill bad">הוסר</span> ${esc(x.text)}<div class="mute">למה: ${esc(x.why)}</div></li>`).join('')}
        ${d.params.map(x => `<li><span class="pill warn">פרמטר</span> ${esc(PARAM[x.key] || x.key)}: <span dir="ltr">${esc(x.before ?? '—')} → <b>${esc(x.after)}</b></span><div class="mute">למה: ${esc(x.why)}</div></li>`).join('')}
        ${(d.ignored || []).map(x => `<li class="mute">לא בוצע: ${esc(x)}</li>`).join('')}</ul>
      <div class="small mute">אפשר לערוך את הטיוטה, לבדוק אותה על קליפ, ורק אז לאשר. אישור יפעיל את הגרסה החדשה לעריכות הבאות; גרסה ${esc(v.upgrade.from)} והפרויקטים שנערכו לפיה נשמרים.</div></div>`;
  }
  function skillEdits(k, v) {
    const body = { purpose: $('#sk_e_purpose').value, suitable_for: $('#sk_e_suit').value.split('\n'), rules: [], resolve: [], add_rules: [] };
    if ($('#sk_e_name').value.trim() !== k.name) body.name = $('#sk_e_name').value;
    for (const r of v.rules) { const t = document.querySelector(`#skillcard textarea[data-rule="${CSS.escape(r.id)}"]`), on = document.querySelector(`#skillcard [data-ruleon="${CSS.escape(r.id)}"]`), e = { id: r.id };
      if (t && t.value.trim() && t.value.trim() !== r.text) e.text = t.value; if (on && on.checked !== r.active) e.active = on.checked; if (Object.keys(e).length > 1) body.rules.push(e); }
    for (const x of v.conflicts || []) { const r = document.querySelector(`#skillcard input[name="cf_${CSS.escape(x.id)}"]:checked`); if (r && !x.resolution) body.resolve.push({ id: x.id, resolution: r.value }); }
    const nr = $('#sk_e_newrule'); if (nr && nr.value.trim()) body.add_rules.push({ text: nr.value, domain: $('#sk_e_newdom').value });
    const params = {}; let bad = null;
    $$('#skillcard [data-kp]').forEach(i => { const val = i.dataset.pt === 'boolean' ? i.checked : i.dataset.pt === 'number' ? Number(i.value) : i.value; if (i.dataset.pt === 'number' && !isFinite(val)) bad = i.dataset.kp; params[i.dataset.kp] = val; });
    if (bad) throw new Error(`ערך לא תקין בפרמטר ${PARAM[bad] || bad}`);
    if (JSON.stringify(params) !== JSON.stringify(v.params)) body.params = params;
    return body;
  }
  $('#skillcard').onclick = async e => {
    const t = e.target.closest('button'); if (!t) return; const d = t.dataset;
    if (t.id === 'pk_create') { const by = who(); if (!by) return;
      try { const j = await api('/skills/from-analysis', { method: 'POST', body: { by, name: $('#pk_name').value, ids: skPick.references.map(r => r.id), picks: collectPicks() } });
        skPick = null; ui.skill = j.skill.id; remember(); await loadSkills(); notice('נוצרה טיוטת סקיל מהניתוח. היא טיוטה עד שתאשר/י.', 'ok'); } catch (err) { notice(err.message, 'bad'); }
      return; }
    if (d.refplay) { showHome('refs'); const v = $('#refvid'); if (v.dataset.ref !== d.refplay) { v.src = `${API}/references/${d.refplay}/file`; v.dataset.ref = d.refplay; } v.classList.remove('hidden');
      const go = () => { try { v.currentTime = Number(d.t) || 0; } catch { /* */ } v.play().catch(() => {}); }; if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true }); return v.scrollIntoView({ block: 'center' }); }
    if (!d.sk) return;
    const k = skillsNow.find(x => x.id === ui.skill); if (!k) return; const v = k.draft || k.approved;
    if (d.sk === 'opensample') return open(d.id);
    const by = who(); if (!by) return;
    const done = async (j, msg) => { $$('#skillcard [data-dirty]').forEach(i => delete i.dataset.dirty); if ($('#sk_e_newrule')) $('#sk_e_newrule').value = ''; skillsNow = j.skills || skillsNow; await loadSkills(); notice(msg, 'ok'); };
    try {
      if (d.sk === 'save') return done(await api('/skills/' + k.id, { method: 'PUT', body: { by, ...skillEdits(k, v) } }), 'הטיוטה נשמרה.');
      if (d.sk === 'upgrade') { const ref = $('#sk_up_ref').value; if (!ref) return notice('אין רפרנס מנותח לבחור. מעלים רפרנס בלשונית "רפרנסים וסגנון עריכה".', 'warn');
        return done(await api(`/skills/${k.id}/upgrade`, { method: 'POST', body: { by, ids: [ref], prompt: $('#sk_up_text').value } }), 'הצעת השדרוג נשלחה לעובד העריכה. הגרסה הנוכחית לא השתנתה.'); }
      if (d.sk === 'startdraft') return done(await api('/skills/' + k.id, { method: 'PUT', body: { by } }), 'נפתחה טיוטה של גרסה חדשה. הגרסה המאושרת והפרויקטים שמשתמשים בה לא השתנו.');
      if (d.sk === 'adopt') { if (!confirm('לאמץ את ההשערה כהוראה שלך? היא תהפוך לכלל פעיל, ותסומן שמקורה בהשערה שאימצת.')) return; return done(await api('/skills/' + k.id, { method: 'PUT', body: { by, rules: [{ id: d.id, adopt: true }] } }), 'ההשערה אומצה כהוראה שלך.'); }
      if (d.sk === 'rmrule') return done(await api('/skills/' + k.id, { method: 'PUT', body: { by, rules: [{ id: d.id, remove: true }] } }), 'הכלל הוסר מהטיוטה.');
      if (d.sk === 'test') { const pid = $('#sk_e_testproj').value; if (!pid) return notice('יש לבחור פרויקט לבדיקה.', 'warn');
        await api('/skills/' + k.id, { method: 'PUT', body: { by, ...skillEdits(k, v) } });
        if (!confirm('להפיק בפרויקט שנבחר גרסה חדשה לפי הטיוטה הזו? זו בדיקה: הגרסה תסומן כבדיקת טיוטה, והסקיל נשאר טיוטה.')) return;
        const j = await api(`/skills/${k.id}/test`, { method: 'POST', body: { by, projectId: pid } }); notice('הבדיקה נכנסה לתור. התוצר יירשם כדוגמה בסקיל.', 'ok'); return open(j.project.id); }
      if (d.sk === 'approve') { await api('/skills/' + k.id, { method: 'PUT', body: { by, ...skillEdits(k, v) } }); const make_default = $('#sk_e_default').checked;
        if (!confirm(`לאשר את הסקיל "${k.name}"${make_default ? ' ולהפוך אותו לברירת המחדל של העריכות הבאות' : ''}?\nזה אישור של סגנון עריכה, לא אישור לפרסום.`)) return;
        return done(await api(`/skills/${k.id}/approve`, { method: 'POST', body: { by, make_default } }), make_default ? 'הסקיל אושר ונקבע כברירת מחדל.' : 'הסקיל אושר. אפשר לבחור אותו בפרויקט.'); }
      if (d.sk === 'default') return done(await api(`/skills/${k.id}/default`, { method: 'POST', body: { by } }), 'הסקיל נקבע כברירת מחדל. הוא יופעל בעריכות הבאות; פרויקטים קיימים לא משתנים.');
      if (d.sk === 'undefault') return done(await api(`/skills/${k.id}/default`, { method: 'POST', body: { by, clear: true } }), 'הסקיל כבר אינו ברירת המחדל.');
      if (d.sk === 'retire') { if (!confirm('להסיר את הסקיל? הוא לא ישמש יותר עריכות חדשות. גרסאות שנערכו לפיו נשארות.')) return; ui.skill = null; remember(); return done(await api(`/skills/${k.id}/retire`, { method: 'POST', body: { by } }), 'הסקיל הוסר.'); }
    } catch (err) { notice(err.message + (err.data && err.data.conflicts ? ' (' + err.data.conflicts.join(', ') + ')' : ''), 'bad'); }
  };

  // ═══ PROJECT ══════════════════════════════════════════════════════════════
  const STEPS = [['project', 'פרויקט'], ['transcript', 'תמלול'], ['style', 'סגנון ורפרנסים'], ['edit', 'עריכה'], ['review', 'ביקורת דנה'], ['approve', 'צפייה ואישור']];
  const base = () => `${API}/projects/${current.id}/versions/${current.version ? current.version.n : 0}`;
  const pkgOf = () => current && current.version && current.version.package;
  const busy = () => current && current.job && ['queued', 'leased'].includes(current.job.status);

  async function open(id, quiet) {
    clearTimeout(timer);
    let data;
    try { data = await api('/projects/' + id + (ui.view[id] ? '?version=' + ui.view[id] : '')); if (!status) status = await api('/status');
      // a project opened by a direct link: the lists its forms offer (references for the direction, skills for an upgrade) are loaded once
      if (!quiet && !refsNow.length) api('/references').then(j => { refsNow = j.references || []; if (current && current.id === id) renderPanel(); }).catch(() => {});
      if (!quiet && !skillsNow.length) api('/skills').then(j => { skillsNow = j.skills || []; }).catch(() => {}); }
    catch (e) {
      if (quiet && current && current.id === id) { refreshFailed(e); timer = setTimeout(() => open(id, true), 6000); return; }   // keep what is on screen
      return notice(`הפרויקט לא נטען: ${e.message}. אפשר לנסות שוב או לחזור לרשימת הפרויקטים.`, 'bad');
    }
    refreshOk(); showBanner();
    if (!skillsNow.length) { try { const j = await api('/skills'); skillsNow = j.skills; skDomains = j.domains; } catch { /* the skill list is optional here */ } }
    const project = data.project, first = !current || current.id !== project.id;
    current = project; workerPill(data.worker);
    $('#home').classList.add('hidden'); $('#detail').classList.remove('hidden'); $('#back').classList.remove('hidden');
    $('#title').textContent = project.title;
    if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
    if (first) { draft = newDraft(); listened = {}; cmpN = null; pvSource = null; playerKey = '';
      step = ui.steps[id] || defaultStep(project); selCat = ui.cat[id] || null; }          // only when a project is OPENED - never on a refresh
    const key = `${project.id}:${project.shown ? project.shown.n : 0}`;
    if (key !== draftKey) { const keep = draft ? { note: draft.note, scope: draft.scope } : {}; draft = Object.assign(newDraft(), first ? {} : keep); draftKey = key; pvSource = null; }
    renderSide(data.worker); renderSteps(); renderPanel(); renderActions();   // each goes through setHtml: no change → the DOM is not touched
    if (busy() || rating()) timer = setTimeout(() => open(id, true), 3000);
  }
  function defaultStep(p) {
    const k = p.nextAction && p.nextAction.key;
    if (!p.version || !p.version.package) return 'project';
    return { render_corrections: 'transcript', apply_review: 'review', review_items: 'review', revise: 'edit', watch_approve: 'approve', approved: 'approve' }[k] || 'project';
  }
  function back() { clearTimeout(timer); current = null; playerKey = ''; history.replaceState(null, '', location.pathname + location.search); $('#detail').classList.add('hidden'); $('#actions').classList.add('hidden');
    $('#back').classList.add('hidden'); $('#home').classList.remove('hidden'); $('#title').textContent = '🎬 דנה סטודיו'; loadHome().catch(e => notice(e.message, 'bad')); }
  $('#back').onclick = back;
  $('#projects').onclick = e => { const b = e.target.closest('[data-id]'); if (b) { notice(''); open(b.dataset.id); } };

  // ── Side: player, worker state, stage, progress, versions, next action ──
  function renderSide(worker) {
    const p = current, v = p.version, pr = p.progress, sh = p.shown || {};
    const pk = `${p.id}:${v ? v.n : 0}:${v && v.hasVideo ? 1 : 0}`;
    if (pk !== playerKey || !$('#playerbox')) {            // a status refresh never rebuilds the player (it would stop playback)
      playerKey = pk;
      $('#side').innerHTML = `<div class="card" id="playerbox">${v && v.hasVideo ? `<video id="mainvid" controls playsinline preload="metadata" ${v.hasCover ? `poster="${base()}/cover"` : ''} src="${base()}/video"></video>
          <div class="small mute" id="playerlabel" style="margin-top:6px"></div>`
          : '<div class="mute" style="padding:30px 0;text-align:center">הסרטון יופיע כאן כשהחבילה תהיה מוכנה לצפייה.</div>'}
          <div id="cmpbox"></div></div><div id="statusbox"></div>`;
      $('#statusbox').__html = null;
      if (cmpN) showCompare(cmpN);
    }
    if ($('#playerlabel')) $('#playerlabel').textContent = `מוצגת גרסה ${v.n}${sh.isCurrent ? ' (הנוכחית)' : ` — לא הנוכחית (${sh.currentN})`}${v.kind === 'review_only' ? ' · הסרטון שהעלית, לא נערך' : ''}${v.package ? ' · ' + tfmt(v.package.duration) : ''}`;
    const h = [];
    h.push(`<div class="card next"><div class="small mute">הפעולה הבאה</div><b>${esc(p.nextAction ? p.nextAction.label : '—')}</b></div>`);
    if (v && v.package && v.package.finalReview && !busy()) h.push(reviewHead(p, v, v.package, true));
    if (pr && (busy() || ['failed', 'waiting'].includes((p.job || {}).status))) {
      h.push(`<div class="card" id="progress"><div class="row"><h2 class="grow">${p.job.status === 'queued' ? 'ממתין בתור' : p.job.status === 'leased' ? 'דנה עובדת' : p.job.status === 'failed' ? '<span class="bad">נכשל</span>' : '<span class="warn">ממתין</span>'} — גרסה ${p.currentVersion}</h2>
          ${isNum(pr.percent) ? `<b>${pr.percent}%</b>${pr.percentBasis === 'estimated' ? '<span class="pill warn">משוער</span>' : ''}` : ''}</div>
        <div class="phases">${pr.phases.map(x => `<span class="${x.state}">${esc(x.label)}</span>`).join('')}</div>
        ${isNum(pr.percent) ? `<div class="bar"><i style="width:${pr.percent}%"></i></div><div class="small mute">${esc(pr.percentNote || '')}</div>` : '<div class="small mute">אין מדידה לאחוז בשלב הזה — מוצגים שלב, זמן שחלף ועדכון אחרון.</div>'}
        <ul class="plain small"><li>שלב נוכחי: <b>${esc(pr.note || pr.stage || '—')}</b></li>
          <li>התחיל: ${pr.startedAt ? fmt(pr.startedAt) : 'עוד לא'} · עדכון אחרון מהעובד: ${fmt(pr.lastUpdateAt)}</li>
          <li>ניסיון ${pr.attempts || 1} מתוך ${pr.maxAttempts}${worker && !worker.online ? ' · <span class="bad">העובד לא מחובר — ימשיך כשיחזור</span>' : ''}</li></ul>
        ${p.job.error ? `<div class="bad">${esc(p.job.error.message)}</div><div class="small mute">קוד: ${esc(p.job.error.code)}</div>
          <button data-do="retry" class="primary" style="margin-top:8px;width:100%">נסה שוב</button><div class="small mute">ניסיון חוזר לא מתמלל מחדש ולא מעלה שוב: התמלול וקובץ המקור נשמרים.</div>` : ''}</div>`);
    }
    if (p.versions.length) h.push(`<div class="card" id="versions"><details ${window.innerWidth >= 980 ? 'open' : ''}><summary><b>גרסאות (${p.versions.length})</b></summary><ul class="plain">${p.versions.map(x => `<li><div class="row"><b>גרסה ${x.n}</b>${pill(x.status)}${x.n === p.currentVersion ? '<span class="pill info">נוכחית</span>' : ''}${x.n === sh.n ? '<span class="pill ok">מוצגת</span>' : ''}${x.approved ? '<span class="pill ok">מאושרת</span>' : ''}</div>
        <div class="small mute">${fmt(x.createdAt)}${x.kind === 'review_only' ? ' · הסרטון שהעלית' : ''}${x.appliedReview ? ' · אחרי יישום שיפורי הביקורת' : ''}${x.revisionMode === 'locked_to_previous_plan' ? ' · תיקון ממוקד' : x.revisionMode === 'replanned' ? ' · תוכנן מחדש' : ''}${x.skill ? ` · סקיל: ${esc(x.skill.name)} גרסה ${esc(x.skill.version)}${x.skill.test ? ' (בדיקת טיוטה)' : ''}` : ''}${x.changeRequest ? ' · "' + esc(x.changeRequest) + '"' : ''}</div>
        <div class="row" style="margin-top:4px">${x.hasPackage && x.n !== sh.n ? `<button class="sm" data-view="${x.n}">הצג את הגרסה הזו</button>` : ''}${x.hasVideo && x.n !== sh.n ? `<button class="sm" data-cmp="${x.n}">▶ השוואה לצד המוצגת</button>` : ''}</div></li>`).join('')}</ul>
      <p class="small mute">גרסאות לא נמחקות. אישור חל רק על הגרסה הנוכחית, וכל שינוי בתוצר מבטל אישור קודם.</p></details></div>`);
    setHtml($('#statusbox'), h.join(''));
  }
  function showCompare(n) {
    cmpN = n;
    $('#cmpbox').innerHTML = `<label>גרסה ${n} — להשוואה</label><video id="cmp" controls playsinline preload="metadata" src="${API}/projects/${current.id}/versions/${n}/video"></video>
      <div class="row" style="margin-top:6px"><button class="sm" data-do="cmpsync">▶ נגן את שתיהן יחד</button><button class="sm" data-do="cmpclose">סגירה</button></div>`;
  }

  function renderSteps() {
    const p = current, dots = { transcript: p.pendingCorrections > 0, review: p.version && (p.version.unresolved || []).length > 0 };
    setHtml($('#steps'), STEPS.map(([k, l], i) => `<button data-step="${k}" class="${k === step ? 'on' : ''}"><span class="n">${i + 1}</span>${l}${dots[k] ? '<span class="dot"></span>' : ''}</button>`).join(''));
  }
  function goStep(k) { step = k; ui.steps[current.id] = k; remember(); renderSteps(); renderPanel(); }
  $('#steps').onclick = e => { const b = e.target.closest('[data-step]'); if (!b) return; goStep(b.dataset.step); $('#steps').scrollIntoView({ block: 'nearest' }); };

  function renderActions() {
    const p = current, v = p.version, pkg = pkgOf(), k = p.nextAction && p.nextAction.key, b = [];
    if (p.shown && !p.shown.isCurrent && !busy()) { $('#actions').innerHTML = ''; return $('#actions').classList.add('hidden'); }   // actions belong to the current version only
    if (k === 'retry') b.push('<button class="primary" data-do="retry">נסה שוב</button>');
    if (k === 'render_corrections') b.push(`<button class="primary" data-do="rendercorr">הפק גרסה עם ${p.pendingCorrections} התיקונים</button>`);
    if (k === 'apply_review') b.push('<button class="primary" data-do="applyreview">יישם שיפורים והפק גרסה חדשה</button>');
    if (k === 'review_items') b.push('<button class="primary" data-go="review">לפריטים הפתוחים</button>');
    if (pkg && p.shown.isCurrent && v.kind !== 'review_only' && ['ready_for_review', 'approved'].includes(v.status) && !busy()) {
      const blocked = v.unresolved.length > 0 || v.approvalValid || (v.contentJudgement && v.contentJudgement.missing && !v.contentJudgement.excepted) || p.pendingCorrections > 0;
      b.push(`<button ${k === 'watch_approve' ? 'class="primary"' : ''} data-do="approve" ${blocked ? 'disabled' : ''}>${v.approvalValid ? 'הגרסה מאושרת' : 'אשר גרסה ' + v.n}</button>`);
      b.push('<button data-go="edit">בקש תיקון</button>');
    }
    setHtml($('#actions'), b.join('')); $('#actions').classList.toggle('hidden', !b.length);
  }

  // ── Panels ──
  function renderPanel() {
    const fn = { project: panelProject, transcript: panelTranscript, style: panelStyle, edit: panelEdit, review: panelReview, approve: panelApprove }[step];
    const sh = current.shown || {}, v = current.version;
    // Which version is this? Said at the top of every step, so a review is never read as belonging to another version.
    const head = !v ? '' : !sh.isCurrent
      ? `<div class="card" id="shownote" style="border-color:var(--warn)"><b class="warn">מוצגת גרסה ${sh.n} — לא הגרסה הנוכחית.</b>
          <div class="small">${sh.currentHasPackage ? `הגרסה הנוכחית היא ${sh.currentN}.` : `גרסה ${sh.currentN} עדיין ${busy() ? 'בעבודה' : 'לא הושלמה'}; עד שתהיה מוכנה מוצגת כאן הגרסה האחרונה שהושלמה, כדי שהביקורת, התמלול והעריכה שלה לא ייעלמו.`}
          כל מה שבשלבים למטה (כולל הדירוג של דנה) שייך לגרסה ${sh.n} בלבד. פעולות חלות רק על הגרסה הנוכחית.</div>
          ${sh.currentHasPackage ? '<button class="sm" data-view="current" style="margin-top:6px">עבור לגרסה הנוכחית</button>' : ''}</div>` : '';
    const changed = setHtml($('#panel'), head + fn());
    if (!sh.isCurrent) $$('#panel [data-do], #panel [data-verify], #panel [data-ex], #panel [data-consent]').forEach(b => { if (!['pvframe', 'gorefs', 'goskills'].includes(b.dataset.do)) b.disabled = true; });
    if (step === 'style' && pkgOf() && (changed || !pvSource)) loadPreviewSource(base() + '/cover');
    if (step === 'edit') reviseSummary();
  }
  const noPkg = what => `<div class="card"><h2>${what}</h2><div class="mute">${busy() ? 'דנה עדיין עובדת. השלב הזה ייפתח כשהחבילה תהיה מוכנה לצפייה.' : 'אין עדיין חבילה בגרסה הזו.'}</div></div>`;
  const reviewOnlyNote = '<div class="card"><div class="pill info">סרטון שהועלה לביקורת בלבד</div><p class="small mute">דנה לא ערכה את הסרטון הזה. כדי לקבל גרסה משופרת שלו: שלב "ביקורת דנה" ← "יישם שיפורים והפק גרסה חדשה".</p></div>';

  /** The files of the project (source videos with the owner's marks, music, narration) and the mix for the next version. */
  const mediaDraft = { audio: null, for: '' };
  function audioDraft(p) { if (mediaDraft.for !== p.id || !mediaDraft.audio) { mediaDraft.for = p.id; mediaDraft.audio = JSON.parse(JSON.stringify(p.media.audio)); } return mediaDraft.audio; }
  /** "כיוון העריכה": what the video is for, and a reference with what to take from it and what not to. Without it, the direction is Dana's proposal. */
  function briefCard(p) {
    const m = p.media; if (!m || p.kind === 'review_only') return '';
    const b = m.brief || {}, n = m.sources.filter(x => !x.removed).length, mont = m.projectType !== 'interview', refs = (refsNow || []).filter(r => r.analysis || (b.reference && b.reference.id === r.id));
    const pl = (pkgOf() || {}).plan || {};
    return `<div class="card" id="brief"><h2>כיוון העריכה</h2>
      ${b.demo ? '<div class="pill warn" style="white-space:normal">בדיקת תשתית על חומר הדגמה — לא לקט אימונים. היא מראה שהמסלול עובד, לא איך ייראה לקט מחומר אמיתי.</div>' : ''}
      ${b.goal || b.reference ? '' : `<div class="small warn">לא הוגדרו מטרה או רפרנס. ${pl.direction ? 'הכיוון של הגרסה הזו הוא הצעה של דנה, לא סגנון שאישרת.' : 'בלי זה דנה תציע כיוון משלה, והוא יסומן כהצעה שלה.'}</div>`}
      ${pl.direction ? `<div class="small" style="margin:6px 0"><b>הכיוון בגרסה המוצגת</b> <span class="pill ${pl.direction_source === 'owner_brief' ? 'ok' : 'warn'}">${pl.direction_source === 'owner_brief' ? 'לפי מה שהגדרת' : 'הצעה של דנה'}</span><div>${esc(pl.direction)}</div>
        ${pl.material_fit && pl.material_fit.fits === false ? `<div class="bad">החומר אינו מתאים למה שהתבקש: ${esc(pl.material_fit.why)}</div>` : ''}</div>` : ''}
      <label for="br_goal">מה המטרה של הסרטון? (מה צופה צריך להבין או להרגיש)</label>
      <textarea id="br_goal" maxlength="600" style="min-height:48px" placeholder="למשל: להראות את האווירה באימון קבוצתי בבוקר, אנרגיה גבוהה, לסיים בחיוך">${esc(b.goal || '')}</textarea>
      <label for="br_ref">רפרנס לסגנון (לא חובה)</label>
      <select id="br_ref"><option value="">בלי רפרנס</option>${refs.map(r => `<option value="${esc(r.id)}" ${b.reference && b.reference.id === r.id ? 'selected' : ''}>${esc(r.title)}${r.analysis ? '' : ' (עוד לא נותח)'}</option>`).join('')}</select>
      <div class="small mute">רפרנס מעלים ומנתחים בלשונית "רפרנסים וסגנון עריכה". הוא כיוון לקצב, למבנה ולתחושה — לא תוכן להעתקה.</div>
      <label for="br_take">מה לקחת מהרפרנס</label><textarea id="br_take" maxlength="600" style="min-height:40px" placeholder="למשל: קצב החיתוך, הפתיחה על תנועה, הסיום הרגוע">${esc(b.take || '')}</textarea>
      <label for="br_avoid">מה לא לקחת / ממה להימנע</label><textarea id="br_avoid" maxlength="600" style="min-height:40px" placeholder="למשל: בלי טקסטים על המסך, בלי קטעי דיבור למצלמה">${esc(b.avoid || '')}</textarea>
      ${mont && n > 1 ? `<label for="br_min">מכמה קובצי מקור שונים הסרטון חייב להיבנות?</label>
        <select id="br_min">${[0, ...Array.from({ length: n - 1 }, (_, i) => i + 2)].map(k => `<option value="${k}" ${(b.min_sources || 0) === k ? 'selected' : ''}>${k ? `לפחות ${k} מתוך ${n}` : 'אין דרישה — מותר מקור אחד, עם נימוק'}</option>`).join('')}</select>
        <div class="small mute">כשיש דרישה והחומר לא מאפשר לעמוד בה, הגרסה תסומן כחסומה עם הסיבה — דנה לא תוותר על הדרישה בשקט.</div>` : ''}
      <div class="row" style="margin-top:10px"><button data-do="savebrief" ${busy() && !p.waitingForFiles ? 'disabled' : ''}>שמור כיוון (לגרסה הבאה)</button>
        <button class="primary" data-do="briefreplan" ${p.version && p.version.package && !busy() ? '' : 'disabled'}>שמור, תכנן והפק מחדש לפי הכיוון</button></div>
      ${b.by ? `<div class="small mute">נשמר על ידי ${esc(b.by)} · ${fmt(b.at)}</div>` : ''}</div>`;
  }
  function readBrief() {
    const v = id => ($('#' + id) ? $('#' + id).value : undefined);
    return { goal: v('br_goal'), take: v('br_take'), avoid: v('br_avoid'), reference_id: v('br_ref') || null, ...($('#br_min') ? { min_sources: Number($('#br_min').value) } : {}) };
  }
  /** What changed in the CUT against the previous version: taken out, brought in, moved, the opening and the ending - with Dana's reasons. */
  function cutChangesCard(p, v, pkg) {
    const d = (pkg.plan || {}).changes_vs_previous; if (!d) return '';
    const prevN = (p.versions.filter(x => x.n < v.n && x.hasVideo).pop() || {}).n;
    const li = (x, cls, label) => `<li><div class="row"><span class="pill ${cls}">${label}</span><span class="small mute">במקור ${tfmt(x.in_s)}–${tfmt(x.out_s)}${isNum(x.seconds) ? ` · ${x.seconds} שנ׳` : ''}</span></div><div>"${esc(x.text)}"</div>${x.why ? `<div class="small mute">למה: ${esc(x.why)}</div>` : ''}</li>`;
    // a version made before the comparison read the source transcript carries an empty one: it is not shown as "the same cut"
    if (d.same_cut && (Math.abs(d.before_s - d.after_s) > 0.5 || d.opening_changed)) return `<div class="card" id="cutchanges"><h2>לפני / אחרי — החיתוך</h2><div class="small mute">ההשוואה המפורטת לא זמינה לגרסה הזו (קודם: ${d.before_s} שנ׳, עכשיו: ${d.after_s} שנ׳). אפשר לצפות בשתי הגרסאות זו לצד זו מרשימת הגרסאות.</div></div>`;
    if (d.same_cut) return `<div class="card" id="cutchanges"><h2>לפני / אחרי — החיתוך</h2><div class="small">החיתוך זהה לגרסה הקודמת: אותם קטעים, באותו סדר (${d.after_s} שנ׳).</div></div>`;
    return `<div class="card" id="cutchanges"><h2>לפני / אחרי — מה השתנה בחיתוך</h2>
      <div class="row"><span class="pill mute">קודם: ${d.before_s} שנ׳ · ${d.parts_before} חלקים</span><span class="pill info">עכשיו: ${d.after_s} שנ׳ · ${d.parts_after} חלקים</span>
        ${prevN ? `<button class="sm" data-cmp="${prevN}" style="margin-inline-start:auto">▶ צפייה בגרסה ${prevN} לצד הזו</button>` : ''}</div>
      ${d.message_before && d.message_before !== d.message_after ? `<div class="small" style="margin-top:6px"><span class="mute">המסר קודם:</span> ${esc(d.message_before)}<br><span class="mute">המסר עכשיו:</span> <b>${esc(d.message_after)}</b></div>` : ''}
      ${d.opening_changed ? `<div class="small" style="margin-top:6px"><b>הפתיחה הוחלפה.</b> <span class="mute">קודם:</span> "${esc(d.opening_before)}" <span class="mute">← עכשיו:</span> <b>"${esc(d.opening_after)}"</b>${d.opening_why ? `<div class="mute">למה: ${esc(d.opening_why)}</div>` : ''}</div>` : '<div class="small mute" style="margin-top:6px">הפתיחה לא השתנתה.</div>'}
      ${d.ending_changed ? `<div class="small"><b>הסיום השתנה.</b> <span class="mute">קודם:</span> "${esc(d.ending_before)}" <span class="mute">← עכשיו:</span> <b>"${esc(d.ending_after)}"</b></div>` : ''}
      <ul class="plain">${d.removed.map(x => li(x, 'bad', 'קוצר / יצא')).join('')}${d.added.map(x => li(x, 'ok', 'נכנס')).join('')}${d.moved.map(x => li({ ...x, why: `ממקום ${x.from_position} למקום ${x.to_position}${x.why ? ' · ' + x.why : ''}` }, 'info', 'הוזז')).join('')}</ul>
      <div class="small">יצאו ${d.removed_s} שנ׳, נכנסו ${d.added_s} שנ׳.</div><div class="small mute">${esc(d.basis)}</div></div>`;
  }
  function mediaCard(p) {
    const m = p.media; if (!m || p.kind === 'review_only') return '';
    const au = audioDraft(p), pu = `${API}/projects/${p.id}`, music = m.assets.filter(a => a.kind === 'music'), nar = m.assets.filter(a => a.kind === 'narration');
    const segs = ((pkgOf() || {}).plan || {}).segments || [], lockedOut = busy() && !p.waitingForFiles;
    const numf = (id, label, val, step, min, max) => `<label class="small" style="display:inline-block;margin-inline-end:10px">${label} <input type="number" data-au="${id}" value="${esc(val)}" step="${step}" min="${min}" max="${max}" style="width:84px"></label>`;
    return `<div class="card" id="media"><h2>קבצים, מוזיקה וקריינות</h2>
      ${p.waitingForFiles ? `<div class="pill info">העריכה ממתינה לקבצים נוספים</div> <button class="primary" data-do="startfiles" style="margin-top:6px">כל הקבצים כאן — התחל עריכה</button><div class="small mute">אם לא תלחצ/י, העריכה תתחיל לבד אחרי 15 דקות עם הקבצים שהועלו.</div>` : ''}
      <label for="mtype">סוג הפרויקט</label><select id="mtype" data-nodirty="1">${Object.entries(m.projectTypes).map(([k, l]) => `<option value="${k}" ${m.projectType === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <h3>קובצי מקור (${m.sources.filter(x => !x.removed).length})</h3>
      <ul class="plain">${m.sources.map(x => `<li id="src_${esc(x.id)}"><div class="row"><b class="grow">${esc(x.name)}</b><span class="pill mute">${mb(x.bytes)}MB</span>${x.primary ? '<span class="pill info">ראשון</span>' : ''}${x.removed ? '<span class="pill bad">הוסר מגרסאות הבאות</span>' : ''}</div>
        <details data-keep="src_${esc(x.id)}"><summary class="small">צפייה וסימון קטעים${x.marks.length ? ` (${x.marks.length} סימונים)` : ''}</summary>
          <video controls playsinline preload="none" id="sv_${esc(x.id)}" src="${pu}/sources/${esc(x.id)}/video" style="max-height:40vh"></video>
          <ul class="plain small">${x.marks.map((k, i) => `<li><span class="pill ${k.kind === 'must' ? 'ok' : 'bad'}">${k.kind === 'must' ? 'חייב להיכלל' : 'לא להשתמש'}</span> ${tfmt(k.from_s)}–${tfmt(k.to_s)}${k.note ? ' · ' + esc(k.note) : ''}
            <button class="sm" data-mark-del="${esc(x.id)}" data-i="${i}">הסר סימון</button></li>`).join('') || '<li class="mute">אין סימונים. בלי סימון דנה בוחרת בעצמה.</li>'}</ul>
          <div class="row small"><input type="number" id="mf_${esc(x.id)}" placeholder="מ- (שנ׳)" step="0.1" min="0" style="width:90px"><button class="sm" data-mark-now="mf_${esc(x.id)}" data-v="sv_${esc(x.id)}">מהנגן</button>
            <input type="number" id="mt_${esc(x.id)}" placeholder="עד (שנ׳)" step="0.1" min="0" style="width:90px"><button class="sm" data-mark-now="mt_${esc(x.id)}" data-v="sv_${esc(x.id)}">מהנגן</button>
            <select id="mk_${esc(x.id)}" data-nodirty="1"><option value="must">חייב להיכלל</option><option value="never">לא להשתמש</option></select>
            <input type="text" id="mn_${esc(x.id)}" placeholder="הערה (לא חובה)" maxlength="200" style="flex:1;min-width:120px"><button class="sm" data-mark-add="${esc(x.id)}">הוסף סימון</button></div>
          ${!x.primary && !x.removed ? `<button class="sm danger" data-src-del="${esc(x.id)}" style="margin-top:6px">לא להשתמש בקובץ הזה בגרסאות הבאות</button>` : ''}
        </details></li>`).join('')}</ul>
      <input type="file" id="addsrc" accept="video/*,.mp4,.mov,.m4v,.webm,.mkv,.avi" class="hidden" multiple><button class="sm" data-do="addsrc" ${lockedOut ? 'disabled' : ''}>הוספת קובצי מקור</button>
      <span id="addsrc_s" class="small mute"></span>
      <h3>מוזיקה</h3>
      ${music.map(a => `<div style="margin:6px 0"><label class="chk"><input type="radio" name="au_music" value="${esc(a.id)}" ${au.music && au.music.asset === a.id ? 'checked' : ''} data-nodirty="1"> <b>${esc(a.name)}</b></label>
        <audio controls preload="none" src="${pu}/assets/${esc(a.id)}/audio" style="width:100%"></audio>
        ${a.license.status === 'owner_confirmed' ? `<div class="small ok">רישיון: אושר על ידי ${esc(a.license.by)} · ${esc(a.license.source)}</div>`
          : `<div class="small bad">רישיון: לא אושר. קובץ שהועלה אינו מסומן אוטומטית כמורשה, והחבילה תיחסם לפרסום עד שיירשמו מקור ורישיון.</div>
             <div class="row small"><input type="text" id="lic_${esc(a.id)}" placeholder="מקור הרצועה והרישיון (למשל: שם הספרייה, מספר רישיון)" maxlength="300" style="flex:1;min-width:160px"><button class="sm" data-lic="${esc(a.id)}">אני מאשר/ת שיש לי רישיון לשימוש הזה</button></div>`}</div>`).join('') || '<div class="small mute">לא הועלתה מוזיקה.</div>'}
      ${music.length ? `<label class="chk"><input type="radio" name="au_music" value="" ${au.music ? '' : 'checked'} data-nodirty="1"> בלי מוזיקה</label>
        <div class="small" style="margin-top:6px">${numf('music.start_s', 'נקודת התחלה ברצועה (שנ׳)', au.music ? au.music.start_s : 0, 0.5, 0, 3600)}${numf('music.volume_db', 'כמה מתחת לדיבור (dB)', au.music ? Math.max(-20, Math.min(-6, au.music.volume_db)) : -14, 1, -20, -6)}
          ${numf('music.fade_in_s', 'כניסה (שנ׳)', au.music ? au.music.fade_in_s : 0.5, 0.1, 0, 10)}${numf('music.fade_out_s', 'יציאה (שנ׳)', au.music ? au.music.fade_out_s : 1.5, 0.1, 0, 10)}</div>
        <div class="small mute">העוצמה נקבעת מול הדיבור שנמדד בסרטון: ‎-6 מוזיקה חזקה, ‎-14 רגיל, ‎-20 רקע שקט. מתחת לזה היא לא נשמעת, ולכן אין ערך נמוך יותר. כשאין דיבור, המוזיקה היא הסאונד של הסרטון.</div>
        <label class="chk"><input type="checkbox" data-au="music.duck" ${!au.music || au.music.duck !== false ? 'checked' : ''}> להנמיך את המוזיקה אוטומטית מתחת לדיבור</label>
        <label class="chk"><input type="checkbox" data-au="cut_on_beat" ${au.cut_on_beat ? 'checked' : ''}> בלקט: להזיז חיתוכים לפעימות המוזיקה כשפעימה קרובה (לא נכפה)</label>` : ''}
      <input type="file" id="addmusic" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac" class="hidden"><button class="sm" data-do="addmusic">העלאת קובץ מוזיקה</button>
      <h3>קריינות</h3>
      ${nar.map(a => `<div style="margin:6px 0"><label class="chk"><input type="radio" name="au_nar" value="${esc(a.id)}" ${au.narration && au.narration.asset === a.id ? 'checked' : ''} data-nodirty="1"> <b>${esc(a.name)}</b></label>
        <audio controls preload="none" src="${pu}/assets/${esc(a.id)}/audio" style="width:100%"></audio>
        <label class="chk small"><input type="checkbox" data-nscript="${esc(a.id)}" ${a.script && a.script.is_script ? 'checked' : ''} data-nodirty="1"> זה תסריט שנכתב לסרטון (לא ציטוט של המצולמים)</label>
        ${a.script && a.script.is_script === null ? '<div class="small warn">לא סומן אם זה תסריט או דברי המצולמים. הקריינות תוצג כקריינות בלבד, לא כציטוט.</div>' : ''}</div>`).join('') || '<div class="small mute">לא הועלתה קריינות.</div>'}
      ${nar.length ? `<label class="chk"><input type="radio" name="au_nar" value="" ${au.narration ? '' : 'checked'} data-nodirty="1"> בלי קריינות</label>
        <div class="small">${numf('narration.start_s', 'מתחילה בשנייה', au.narration ? au.narration.start_s : 0, 0.5, 0, 600)}${numf('narration.volume_db', 'עוצמה (dB)', au.narration ? au.narration.volume_db : 0, 1, -12, 6)}</div>` : ''}
      <input type="file" id="addnar" accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac" class="hidden"><button class="sm" data-do="addnar">העלאת קריינות מוכנה</button>
      <div class="small mute">קריינות מטקסט (ElevenLabs) מוכנה בצד המערכת אך אינה פעילה: נדרשים חשבון בתשלום, מפתח ואישור עלות שלך. ראה לשונית "איך דנה עובדת".</div>
      <h3>הסאונד המקורי</h3>
      <select data-au="original.mode" data-nodirty="1"><option value="keep" ${au.original.mode === 'keep' ? 'selected' : ''}>לשמור</option><option value="mute" ${au.original.mode === 'mute' ? 'selected' : ''}>להשתיק בכל הסרטון</option></select>
      ${segs.length > 1 && au.original.mode === 'keep' ? `<div class="small">להשתיק רק בקטעים: ${segs.map(g => `<label class="chk" style="display:inline-flex;margin-inline-end:8px"><input type="checkbox" data-mute-seg="${g.n}" ${au.original.mute_segments.includes(g.n) ? 'checked' : ''}> ${g.n}</label>`).join('')}</div>` : ''}
      <div class="row" style="margin-top:10px">
        <button data-do="saveaudio" ${lockedOut ? 'disabled' : ''}>שמירת הגדרות המיקס (לגרסה הבאה)</button>
        <button class="primary" data-do="remix" ${p.version && p.version.package && !busy() ? '' : 'disabled'}>הפק גרסה עם המיקס הזה — בלי לתכנן מחדש</button>
        <button data-do="replan" ${p.version && p.version.package && !busy() ? '' : 'disabled'}>תכנן והפק מחדש מכל המקורות</button></div>
      <div class="small mute">שינוי במיקס או בקבצים אינו נוגע בגרסה קיימת. הוא נכנס רק לגרסה חדשה, והגרסה הנוכחית נשמרת להשוואה.</div></div>`;
  }
  function readAudio() {
    const au = audioDraft(current), g = sel => document.querySelector(`#media [data-au="${sel}"]`), n = sel => { const e = g(sel); return e ? Number(e.value) : undefined; };
    const m = document.querySelector('#media input[name="au_music"]:checked'), na = document.querySelector('#media input[name="au_nar"]:checked');
    return { music: m && m.value ? { asset: m.value, start_s: n('music.start_s'), volume_db: n('music.volume_db'), fade_in_s: n('music.fade_in_s'), fade_out_s: n('music.fade_out_s'), duck: g('music.duck') ? g('music.duck').checked : true } : null,
      narration: na && na.value ? { asset: na.value, start_s: n('narration.start_s'), volume_db: n('narration.volume_db') } : null,
      original: { mode: g('original.mode') ? g('original.mode').value : au.original.mode, mute_segments: $$('#media [data-mute-seg]:checked').map(e => Number(e.dataset.muteSeg)) },
      cut_on_beat: g('cut_on_beat') ? g('cut_on_beat').checked : !!au.cut_on_beat };
  }
  /** The parts of a multi-file video with their files and times; in a compilation a part can be replaced or removed on its own. */
  function sourceMapCard(p, pkg) {
    const segs = (pkg.plan || {}).segments || []; if (!pkg.sourceMap || !segs.some(g => g.source_name)) return '';
    const mont = (pkg.plan || {}).kind === 'montage', srcs = (p.media || {}).sources || [];
    return `<div class="card" id="sourcemap"><h2>מפת המקורות (${pkg.sourceMap.length} קבצים, ${segs.length} קטעים)</h2>
      ${mont ? `${pkg.plan.message ? `<div class="small"><b>המסר:</b> ${esc(pkg.plan.message)}</div>` : ''}${pkg.plan.opening_why ? `<div class="small"><b>למה הפתיחה הזו:</b> ${esc(pkg.plan.opening_why)}</div>` : ''}
        ${pkg.plan.rationale ? `<div class="small"><b>הקו של הסרטון:</b> ${esc(pkg.plan.rationale)}</div>` : ''}${pkg.plan.closing_why ? `<div class="small"><b>למה הסיום הזה:</b> ${esc(pkg.plan.closing_why)}</div>` : ''}
        <div class="small mute">${esc((pkg.plan || {}).basis || '')}</div>` : ''}
      <ul class="plain">${segs.map(g => `<li><div class="row"><button class="sm" data-play="${g.tl_in_s},${g.tl_out_s}">▶ ${tfmt(g.tl_in_s)}–${tfmt(g.tl_out_s)}</button><span class="pill info">קטע ${g.n}</span>${g.plan_role ? `<span class="pill ok">${esc({ opening: 'פתיחה', build: 'התפתחות', peak: 'שיא', close: 'סיום' }[g.plan_role] || g.plan_role)}</span>` : ''}<span class="pill mute">${esc(g.source_name)}</span>
          ${g.must ? '<span class="pill ok">חובה</span>' : ''}${g.replaced_by_owner ? '<span class="pill warn">הוחלף לבקשתך</span>' : ''}${g.on_beat ? '<span class="pill mute">על פעימה</span>' : ''}</div>
        <div class="small">בקובץ: ${Number(g.file_in_s).toFixed(1)}–${Number(g.file_out_s).toFixed(1)} שנ׳${g.seen ? ` · נראה: ${esc(g.seen)}` : ''}</div><div class="small mute">${esc(g.why || '')}</div>
        ${mont ? `<details class="small" data-keep="seg_${g.n}"><summary>להחליף או להסיר רק את הקטע הזה</summary><div class="row">
            <select id="sr_src_${g.n}" data-nodirty="1">${srcs.filter(x => !x.removed).map(x => `<option value="${esc(x.id)}" ${x.id === g.source_id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
            <input type="number" id="sr_a_${g.n}" placeholder="מ- (שנ׳ בקובץ)" step="0.1" min="0" style="width:120px"><input type="number" id="sr_b_${g.n}" placeholder="עד" step="0.1" min="0" style="width:90px">
            <button class="sm" data-seg-replace="${g.n}" ${busy() ? 'disabled' : ''}>החלף והפק גרסה</button><button class="sm danger" data-seg-remove="${g.n}" ${busy() ? 'disabled' : ''}>הסר והפק גרסה</button></div>
            <div class="mute">שאר הקטעים והמיקס לא משתנים. הגרסה הנוכחית נשמרת.</div></details>` : ''}</li>`).join('')}</ul></div>`;
  }
  /** External connections as they really are: prepared / active / not possible, and the one action still needed. */
  function connectorsCard() {
    const c = (status && status.connectors) || null; if (!c) return '';
    const t = c.narration_tts, m = c.music_library;
    return `<div class="card" id="connectors"><h2>חיבורים חיצוניים</h2>
      <h3>קריינות מטקסט — ${esc(t.provider)} <span class="pill ${t.state === 'active' ? 'ok' : 'warn'}">${t.state === 'active' ? 'פעיל' : 'מוכן, לא פעיל'}</span></h3>
      <div class="small">${esc(t.what)}</div>
      ${t.never_called ? '<div class="small mute">לא בוצעה אף קריאה לספק ולא נשלח אליו חומר.</div>' : ''}
      ${(t.needs || []).length ? `<div class="small">מה חסר:</div><ul class="plain small">${t.needs.map(x => `<li>${esc(x)}</li>`).join('')}</ul><div class="small"><b>הפעולה הבאה שלך:</b> ${esc(t.next_action)}</div>` : ''}
      <label for="tts_text">הערכת עלות לתסריט (חישוב בלבד — שום דבר לא נשלח)</label><textarea id="tts_text" style="min-height:60px" maxlength="5000" placeholder="טקסט התסריט. הוא יסומן כתסריט, לא כציטוט של המצולמים."></textarea>
      <button class="sm" id="tts_est" style="margin-top:6px">חשב עלות</button> <span id="tts_out" class="small"></span>
      <h3>ספריית מוזיקה <span class="pill mute">העלאה ידנית בלבד</span></h3><div class="small">${esc(m.what)}</div>
      <ul class="plain small">${m.options.map(o => `<li><b>${esc(o.name)}</b> — ${esc(o.state)}<div class="mute">${esc(o.needs)}</div></li>`).join('')}</ul>
      <div class="small"><b>הפעולה הבאה שלך:</b> ${esc(m.next_action)}</div>
      <h3>פרסום <span class="pill mute">כבוי</span></h3><div class="small">${esc(c.publishing.what)}</div></div>`;
  }
  function mixCard(pkg) {
    const m = pkg.mix; if (!m || !m.applied) return '';
    const x = m.measured || {}, pr = m.params || {}, lic = m.music_license, audible = (pkg.checks || []).find(c => c.id === 'mix_music_audible');
    return `<div class="card" id="mix"><h2>מיקס האודיו</h2><div class="small mute">${esc(m.structure || '')}</div>
      <ul class="plain small">
        <li>סאונד מקורי: ${pr.original && pr.original.mode === 'mute' ? 'מושתק' : 'נשמר'}${pr.original && (pr.original.muted_spans_s || []).length ? ` · מושתק בקטעים ${pr.original.muted_spans_s.map(a => a.join('–')).join(', ')}` : ''}</li>
        ${pr.music ? `<li class="${audible && audible.status === 'fail' ? 'bad' : ''}"><b>${audible ? (audible.status === 'fail' ? 'המוזיקה כנראה לא נשמעת: ' : 'המוזיקה בקובץ: ') + esc(audible.summary) : (x.speech_over_music_db != null && x.speech_over_music_db > 22 ? `המוזיקה כנראה לא נשמעת: היא נמוכה מהדיבור ב-${esc(x.speech_over_music_db)} dB. גרסה חדשה תתקן את זה.` : 'האם המוזיקה נשמעת לא נבדק בגרסה הזו.')}</b></li>
          <li>מוזיקה: <b>${esc(pr.music.file)}</b> · מנקודה ${esc(pr.music.start_s)} שנ׳ · ${pr.music.under_speech_db_asked != null ? `התבקש ${Math.abs(pr.music.under_speech_db_asked)} dB מתחת לדיבור` : `${esc(pr.music.volume_db)} dB (הגדרה ישנה: עוצמה על הקובץ)`} · כניסה ${esc(pr.music.fade_in_s)} / יציאה ${esc(pr.music.fade_out_s)} שנ׳ · הנמכה מתחת לדיבור: ${pr.music.duck ? 'כן' : 'לא'}</li>
          <li class="${lic && lic.status === 'owner_confirmed' ? 'ok' : 'bad'}">רישיון המוזיקה: ${lic && lic.status === 'owner_confirmed' ? `אושר על ידי ${esc(lic.by)} · ${esc(lic.source)}` : 'לא אושר — אין לפרסם'}</li>` : '<li>מוזיקה: <b>אין מוזיקה בגרסה הזו</b> — לא נבחרה רצועה (או שהסקיל קבע "בלי מוזיקה"). מעלים ובוחרים רצועה במסך "פרויקט".</li>'}
        ${pr.narration ? `<li>קריינות: <b>${esc(pr.narration.file)}</b> · מתחילה ב-${esc(pr.narration.start_s)} שנ׳ · ${esc(pr.narration.volume_db)} dB${m.narration_script && m.narration_script.is_script ? ' · <span class="pill info">תסריט — לא ציטוט</span>' : ''}</li>` : ''}
        <li>נמדד: שיא ${esc(x.peak_dbfs)} dBFS · ${esc(x.clipped_samples)} דגימות בשיא מלא${x.speech_over_music_db != null ? ` · בזמן דיבור המוזיקה נמוכה ב-${esc(x.speech_over_music_db)} dB` : ''}${x.ducking_db != null ? ` · הנמכה שנמדדה ${esc(x.ducking_db)} dB` : ''}
          ${x.speech_words_recognised_after_mix != null ? ` · אחרי המיקס זוהו ${Math.round(x.speech_words_recognised_after_mix * 100)}% מהמילים` : ''}</li>
        ${m.beats && m.beats.requested ? `<li>עריכה לפי קצב: ${m.beats.cuts_on_beat != null ? `${esc(m.beats.cuts_on_beat)} מתוך ${esc(m.beats.cuts)} חיתוכים על פעימה (${esc(m.beats.tempo_bpm)} BPM). ${esc(m.beats.note || '')}` : 'התבקשה ולא בוצעה (זיהוי פעימות לא היה זמין)'}</li>` : ''}
        <li class="mute">${esc(m.not_checked || '')}</li></ul></div>`;
  }
  function panelProject() {
    const p = current, c = p.consent, cs = { unknown: ['לא תועדה', 'warn'], confirmed: ['אושרה', 'ok'], denied: ['סירוב', 'bad'] }[c.status], accts = (status && status.accounts) || [];
    const H = { uploaded: 'הועלה', duplicate_upload: 'העלאה כפולה זוהתה', edit_queued: 'עריכה נכנסה לתור', review_queued: 'הוגש לביקורת דנה', review_ready: 'הביקורת מוכנה', job_leased: 'העובד התחיל', job_released: 'הוחזר לתור',
      job_failed: 'נכשל', package_ready: 'חבילה מוכנה', package_edited: 'החבילה נערכה', approval_invalidated: 'האישור בוטל', approved: 'אושר', changes_requested: 'התבקשו שינויים',
      revision_requested: 'התבקשה גרסה מתוקנת', apply_review_requested: 'התבקש יישום שיפורי הביקורת', caption_verified: 'כתובית אומתה', settings_changed: 'הגדרות הפרויקט שונו', rejected: 'נדחה',
      consent_recorded: 'הסכמה תועדה', exception_recorded: 'חריגה תועדה', review_confirmed: 'פריטי הבדיקה אושרו' };
    return `<div class="card"><h2>הפרויקט</h2>
        <div class="row">${pill(p.status)}<span class="pill mute">${p.kind === 'review_only' ? 'סרטון ערוך שהועלה לביקורת' : 'חומר גלם לעריכה'}</span>${p.kind === 'review_only' ? '' : `<span class="pill info">יעד: ${esc(p.targetLabel)}</span>`}</div>
        ${(p.siblings || []).length ? `<div class="card" id="siblings" style="margin:8px 0"><b>תוצרים נוספים מאותו מקור</b><div class="small mute">לכל יעד תוצר נפרד, עם גרסאות, ביקורת סופית ואישור משלו.</div>
          ${p.siblings.map(x => `<button class="sm" data-open="${esc(x.id)}" style="margin-top:6px">פתיחת גרסת ה${esc(x.targetLabel)} · ${esc((STATUS[x.status] || [x.status])[0])} · גרסה ${x.currentVersion}</button>`).join(' ')}</div>` : ''}
        <div class="small mute" style="margin-top:6px">קובץ המקור: ${esc(p.source.originalName)} · ${mb(p.source.bytes)}MB · <code>${esc(p.source.sha256.slice(0, 12))}…</code> · נשמר כמו שהוא</div>
        <label for="pacct">חשבון יעד לפרויקט</label>
        <select id="pacct">${accts.map(a => `<option value="${esc(a.username)}" ${p.account === a.username ? 'selected' : ''}>@${esc(a.username)} — מחובר ✓ אומת ${esc(a.verifiedAt)}</option>`).join('')}<option value="" ${p.account ? '' : 'selected'}>ברירת המחדל של המותג / לא נבחר</option></select>
        <div class="small mute">בחירת חשבון אינה פרסום. פרסום כבוי ונשאר מאחורי אישור נפרד שלך.</div></div>
      ${briefCard(p)}
      ${mediaCard(p)}
      ${p.kind === 'review_only' ? '' : `<div class="card" id="pskill"><h2>סקיל עריכה לפרויקט</h2>
        <select id="pskillsel" data-nodirty="1">${skillOptions(p.skill)}</select>
        ${['set', 'pinned'].includes((p.skill || {}).mode) ? skillSetBox(p.skill) : ''}
        ${conflictList(p.skillConflicts)}
        <label class="chk" style="margin-top:8px"><input type="checkbox" id="panim" data-nodirty="1" ${p.animationScene ? 'checked' : ''}> לאפשר קטע אנימציה במסך מלא בפרויקט הזה (גם בלי סקיל שמבקש אותו)</label>
        <div class="small mute">קטע אנימציה = טיפוגרפיה מונפשת של משפט שנאמר, שמחליפה את הצילום לכמה שניות כשהקול ממשיך. דנה תוסיף אותו רק אם יש לו תפקיד.</div>
        <div class="small mute" style="margin-top:6px">${esc(skillChoiceNote(p.skill))} הבחירה חלה מהגרסה הבאה; גרסאות קיימות לא משתנות. התאמות לפרויקט הזה (סגנון, זומים, הערות) לא משנות את הסקיל עצמו.</div>
        <button data-do="applyskill" style="margin-top:8px" ${p.version && p.version.package && !busy() ? '' : 'disabled'}>החל את הסקיל והפק גרסה חדשה</button>
        <div class="small mute">החלה יוצרת גרסה חדשה (תכנון, עריכה וביקורת לפי הסקיל), משאירה את הקיימת להשוואה ומבטלת אישור קודם.</div></div>`}
      <div class="card"><h2>הסכמה וזכויות</h2>
        <div class="row"><span class="grow">הסכמת המצולמים לפרסום</span><span class="pill ${cs[1]}">${cs[0]}</span></div>
        ${c.by ? `<div class="small mute">${esc(c.by)} · ${fmt(c.at)}${c.note ? ' · ' + esc(c.note) : ''}</div>` : ''}
        <div class="row" style="margin-top:8px"><button class="sm" data-consent="confirmed">תיעוד הסכמה</button><button class="sm danger" data-consent="denied">אין הסכמה</button></div>
        <div class="row" style="margin-top:10px"><span class="grow">מוזיקה</span>${(() => { const mu = ((p.media || {}).audio || {}).music, a = mu && (p.media.assets || []).find(x => x.id === mu.asset);
          return !a ? '<span class="pill mute">לא נבחרה רצועה</span>' : `<span class="pill ${a.license && a.license.status === 'owner_confirmed' ? 'ok' : 'bad'}">${esc(a.name)} · ${a.license && a.license.status === 'owner_confirmed' ? 'רישיון אושר' : 'רישיון לא אושר — חסום לפרסום'}</span>`; })()}</div></div>
      <div class="card"><details><summary><b>היסטוריה</b></summary><ul class="plain small">${p.history.slice().reverse().map(e => `<li>${fmt(e.at)} · ${esc(e.actor)} · <b>${esc(H[e.action] || e.action)}</b>${e.detail && (e.detail.note || e.detail.reason || e.detail.code) ? ' — ' + esc(e.detail.note || e.detail.reason || e.detail.code) : ''}</li>`).join('')}</ul></details></div>`;
  }

  // ── Transcript: three separate texts ──
  const CS = { unchecked: ['לא נבדק', 'mute'], corrected: ['תוקן', 'info'], verified: ['אומת על ידי הבעלים', 'ok'] };
  const DK = { low_confidence: 'ודאות נמוכה', passes_disagree: 'שתי ההאזנות לא מסכימות', context: 'ספק לפי הקשר' };
  function span(pkg, c) {
    if (isNum(c.source_start_s) && isNum(c.source_end_s)) return [c.source_start_s, c.source_end_s];
    if (!pkg.plan && pkg.segment && isNum(pkg.segment.in_s)) return [+(pkg.segment.in_s + c.start).toFixed(3), +(pkg.segment.in_s + c.start + c.dur).toFixed(3)];
    return null;
  }
  function panelTranscript() {
    const p = current, v = p.version, pkg = pkgOf(); if (!pkg) return noPkg('תמלול');
    const tr = pkg.transcript || {}, states = {}; for (const s of p.cardStates || []) states[s.i] = s;
    const n = { unchecked: 0, corrected: 0, verified: 0 }; for (const s of p.cardStates || []) n[s.status]++;
    const doubts = {}; for (const d of tr.doubts || []) (doubts[d.card] = doubts[d.card] || []).push(d);
    const burned = pkg.burnedInText && pkg.burnedInText.present;
    const h = [];
    h.push(`<div class="card"><h2>שלושה טקסטים נפרדים</h2><ul class="plain small">
      <li><b>תמלול הדיבור</b> — מה שנאמר, לפי תמלול אוטומטי. המקור נשמר תמיד.</li>
      <li><b>כתוביות הסרטון</b> — מה שמופיע על המסך. כאן מתקנים ומאמתים.</li>
      <li><b>קפשן הפוסט</b> — הטקסט שמתחת לסרטון באינסטגרם. נערך בנפרד.</li></ul>
      <p class="small mute">אימות מלל אינו אישור לפרסום. תמלול אוטומטי לא מוצג כ"ציטוט מדויק" עד שאימתת אותו.</p></div>`);
    h.push(`<div class="card" id="speech"><h2>תמלול הדיבור</h2>
      <span class="pill ${n.unchecked === 0 && (p.cardStates || []).length ? 'ok' : n.verified + n.corrected ? 'info' : 'warn'}">${n.unchecked === 0 && (p.cardStates || []).length ? 'כל הכתוביות אומתו על ידך' : n.verified + n.corrected ? `תמלול אוטומטי · ${n.verified} אומתו, ${n.corrected} תוקנו, ${n.unchecked} לא נבדקו` : 'תמלול אוטומטי — לא אומת'}</span>
      <div class="quote" style="margin-top:8px">${esc(pkg.spokenText || '—')}</div>
      <div class="small mute" style="margin-top:6px">${esc(tr.note || '')} התמלול המקורי של כל הקובץ נשמר בחבילה ואינו משתנה בתיקונים.</div></div>`);
    if (v.kind === 'review_only') { h.push(reviewOnlyNote); return h.join(''); }
    h.push(`<div class="card" id="captions"><h2>כתוביות הסרטון</h2>
      ${(pkg.cards[0] || {}).of === 'narration' ? `<div class="pill info" style="white-space:normal">אלה כתוביות הקריינות שהעלית, מתמלול אוטומטי. ${((tr.corrections_applied || []).length) ? `${tr.corrections_applied.length} תיקונים שלך כבר בסרטון.` : 'עוד לא אומתו.'} מאזינים, מתקנים ומאמתים כאן — התיקון נכנס לסרטון בגרסה הבאה ונשמר בכל הגרסאות שאחריה.</div>` : ''}
      ${burned ? '<div class="pill warn">הכתוביות צרובות בקובץ המקור</div><p class="small">דנה לא הוסיפה שכבת כתוביות שנייה, ואינה יכולה לתקן טקסט שצרוב בתמונה. התיקונים כאן נשמרים לתמלול ולטקסטים שנגזרים ממנו, אבל לא ישנו את מה שנראה בסרטון. לתיקון בפועל נדרש חומר גלם בלי כתוביות.</p>' : ''}
      <p class="small mute">לכל כתובית: ▶ להאזנה לקטע שלה, תיקון הטקסט אם צריך, ואז "אמת ושמור תיקון". התיקון נשמר לכל סבבי העריכה, ותמלול אוטומטי חוזר לא ידרוס אותו.</p>
      ${p.pendingCorrections ? `<div class="card next"><b>${p.pendingCorrections} תיקונים נשמרו ועדיין לא בסרטון.</b><button class="primary" data-do="rendercorr" style="margin-top:8px;width:100%">הפק גרסה עם התיקונים</button>
        <div class="small mute">רק הכתוביות שתיקנת ישתנו (והטקסטים שנגזרים מהן). החיתוך, המסר, הקאבר והאפקטים נשארים.</div></div>` : ''}
      <ul class="plain">${pkg.cards.map(c => { const sp = span(pkg, c), s = states[c.i] || { status: 'unchecked' }, cs = CS[s.status], ds = doubts[c.i] || [];
        const val = draft.captions[c.i] !== undefined ? draft.captions[c.i] : (s.saved || c.text);
        return `<li><div class="capline">
          <button class="sm" data-listen="${c.i}" data-play="${Math.max(0, c.start - 0.25).toFixed(2)},${(c.start + c.dur + 0.25).toFixed(2)}">▶ ${c.start.toFixed(1)}–${(c.start + c.dur).toFixed(1)}s</button>
          <div class="row"><span class="pill ${cs[1]}">${cs[0]}</span>${ds.map(d => `<span class="pill warn" title="${esc(d.note || '')}">${esc(DK[d.kind] || 'ספק')}${d.word ? ': ' + esc(d.word) : ''}</span>`).join('')}</div>
          <input class="full" type="text" data-card="${c.i}" maxlength="80" value="${esc(val)}" ${sp ? '' : 'disabled'} aria-label="כתובית ${c.i}">
          ${s.original != null ? `<div class="full small"><span class="mute">לפני:</span> ${esc(s.original)} <span class="mute">← אחרי:</span> <b>${esc(s.saved)}</b>${s.inVideo ? ' <span class="pill ok">בסרטון</span>' : ' <span class="pill warn">ייכנס בגרסה הבאה</span>'}${s.from === 'owner_request' ? ' <span class="pill mute">לפי בקשה חופשית</span>' : ''}</div>` : ''}
          ${ds.length ? `<div class="full small mute">${ds.map(d => esc(d.note || '')).join(' · ')} — מידע בלבד; האזנה שלך מכריעה.</div>` : ''}
          <button class="full sm ${s.status === 'verified' && val === (s.saved || c.text) ? '' : 'primary'}" data-verify="${c.i}" ${sp ? '' : 'disabled'}>אמת ושמור תיקון</button></div></li>`; }).join('')}</ul>
      ${pkg.cards.some(c => !span(pkg, c)) ? '<p class="small warn">לחלק מהכתוביות אין מיפוי לזמני המקור בגרסה הזו, ולכן אי אפשר לתקן אותן כאן.</p>' : ''}
      ${(pkg.derivedTextUpdates || []).length ? `<details class="small"><summary>טקסטים נגזרים שעודכנו לפי התיקונים (${pkg.derivedTextUpdates.length})</summary><ul class="plain">${pkg.derivedTextUpdates.map(d => `<li>${esc(d.where)}: ${esc(d.from)} ← <b>${esc(d.to)}</b></li>`).join('')}</ul></details>` : ''}</div>`);
    const disputes = (pkg.issues || []).filter(i => i.code === 'owner_correction_kept');
    if (disputes.length) h.push(`<div class="card" id="disputes"><h2>מחלוקות עם התמלול האוטומטי — מידע בלבד</h2>
      <p class="small mute">התיקון שלך הוא שקובע ונשאר בסרטון. כאן רק רואים איפה תמלול חוזר של האודיו שמע משהו אחר, עם הקטע להאזנה.</p>
      <ul class="plain">${disputes.map(d => `<li><div class="row">${isNum(d.t0) ? `<button class="sm" data-play="${Math.max(0, d.t0 - 0.6).toFixed(2)},${(d.t0 + 2.2).toFixed(2)}">▶ ${tfmt(d.t0)}</button>` : ''}<span class="pill info">נשאר התיקון שלך</span></div>
        <div class="small">${d.owner ? `בסרטון: <b>${esc(d.owner)}</b> · התמלול החוזר שמע: ${esc(d.heard)}` : esc(d.message)}</div></li>`).join('')}</ul></div>`);
    h.push(`<div class="card" id="freefix"><h2>בקשת תיקון חופשית</h2>
      <p class="small mute">אפשר לכתוב בשפה רגילה, למשל: "בכל מקום שכתוב רפורמר צריך להיות ריפורמר". דנה תשנה רק את מה שהבקשה נוגעת בו; אם הבקשה מחייבת תכנון מחדש, זה ייכתב במפורש בגרסה החדשה.</p>
      ${requestBox()}</div>`);
    h.push(`<div class="card" id="postcap"><h2>קפשן הפוסט</h2>
      ${v.caption.isDraft ? '<div class="pill warn">טיוטה — אין פרופיל קול מאושר</div>' : ''}
      <textarea id="cap">${esc(v.caption.text)}</textarea>
      ${/ציטוט מדויק/.test(v.caption.text) && n.unchecked > 0 ? '<div class="small warn">הקפשן קורא לטקסט "ציטוט מדויק", אבל לא כל המלל אומת. כדאי לתקן את הניסוח או לאמת את הכתוביות.</div>' : ''}
      <label for="cta">קריאה לפעולה (CTA)</label><input type="text" id="cta" value="${esc(v.caption.cta || '')}" placeholder="לא הוגדר — לא יפורסם CTA, ודנה לא תמציא">
      <button data-do="savecap" style="margin-top:10px">שמירת הקפשן</button><p class="small mute">שינוי בקפשן או ב-CTA מבטל אישור קיים.</p></div>`);
    return h.join('');
  }
  function requestBox() {
    return `<textarea id="rvnote" placeholder="מה לשנות?">${esc(draft.note)}</textarea>
      <label class="chk"><input type="radio" name="rvscope" value="project" ${draft.scope === 'project' ? 'checked' : ''}> תיקון לפרויקט הזה</label>
      <label class="chk"><input type="radio" name="rvscope" value="permanent" ${draft.scope === 'permanent' ? 'checked' : ''}> כלל קבוע — יישמר עם מקור וגרסה וייטען בכל הפרויקטים הבאים</label>
      <button class="primary" data-do="revise" style="margin-top:10px;width:100%">הפק גרסה מתוקנת</button>
      <p class="small mute">הגרסה הנוכחית נשמרת להשוואה. אישור קיים מתבטל.</p>`;
  }

  // ── Style & references ──
  function panelStyle() {
    const p = current, pkg = pkgOf(); if (!pkg) return noPkg('סגנון ורפרנסים');
    if (p.version.kind === 'review_only') return reviewOnlyNote;
    const ru = pkg.rulesUsed, st = pkg.style || {}, sv = k => draft.style[k] !== undefined ? draft.style[k] : st[k], burned = pkg.burnedInText && pkg.burnedInText.present;
    return `<div class="card" id="rulesused"><h2>לפי מה נערכה הגרסה הזו</h2>
        ${ru ? `<ul class="plain small">
          <li>פרופיל: <b>${esc(ru.profile.id)}</b> · גרסה ${esc(ru.profile.version)} · ${ru.profile.status === 'owner_approved' ? approvedPill() : '<span class="pill warn">מובנה — לא אושר</span>'} · <code>${esc(String(ru.profile.sha256 || '').slice(0, 12))}</code></li>
          <li>רפרנסים שהפרופיל נגזר מהם: ${(ru.references || []).length ? ru.references.map(x => `<code>${esc(x)}</code>`).join(' · ') : 'אין'}</li>
          <li>כללי סגנון מהפרופיל: ${(ru.profile_rules || []).length ? ru.profile_rules.map(x => esc(x)).join(' · ') : 'אין'}</li>
          <li>כללים קבועים שלך: ${(ru.standing_rules || []).length ? ru.standing_rules.map(x => `<code>${esc(x.id)}</code> גרסה ${esc(x.version ?? '—')}`).join(' · ') : 'אין'}</li>
          <li>סקיל העריכה: ${esc(ru.skill.name)} · גרסה ${esc(ru.skill.version)} · <code>${esc(String(ru.skill.sha256 || '').slice(0, 12))}</code></li></ul>
          <button data-do="profile" data-pid="${esc(ru.profile.id)}">לשמור את הסגנון של הגרסה הזו כפרופיל מאושר לפרויקטים הבאים</button>` : '<div class="mute">הגרסה הזו לא רשמה את הכללים שלה.</div>'}
        <p class="small mute">להעלאת רפרנסים, השוואה והרכבת פרופיל משולב: <button class="sm" data-do="gorefs">רפרנסים וסגנון עריכה</button></p></div>
      <div class="card" id="capstyle"><h2>סגנון הכתוביות</h2>
        ${burned ? '<div class="pill warn">הכתוביות צרובות במקור — אין שכבת כתוביות של דנה לעצב</div>' : ''}
        <canvas id="pv" width="270" height="480" style="display:block;margin:0 auto;border-radius:10px;background:#000;max-width:100%"></canvas>
        <p class="small mute">תצוגה מקדימה מקורבת על פריים אמיתי (גודל, מיקום, שורות וצבע). התוצאה המדויקת היא הרינדור של הגרסה הבאה.</p>
        <button class="sm" data-do="pvframe">להציג על הפריים הנוכחי בנגן</button>
        <label for="st_size">גודל: <b id="st_size_v">${esc(sv('caption_size') ?? '—')}</b></label><input type="range" id="st_size" data-style="caption_size" min="40" max="140" step="2" value="${Number(sv('caption_size')) || 76}" style="width:100%">
        <label for="st_y">מיקום אנכי (0 למעלה, 1920 למטה): <b id="st_y_v">${esc(sv('caption_y_px') ?? '—')}</b></label><input type="range" id="st_y" data-style="caption_y_px" min="200" max="1700" step="10" value="${Number(sv('caption_y_px')) || 1250}" style="width:100%">
        <label for="st_lines">שורות</label><select id="st_lines" data-style="caption_max_lines"><option value="1" ${sv('caption_max_lines') === 1 ? 'selected' : ''}>שורה אחת</option><option value="2" ${sv('caption_max_lines') === 2 ? 'selected' : ''}>עד שתי שורות</option></select>
        <div class="row" style="margin-top:10px"><label class="chk" style="margin:0"><input type="color" data-stylec="caption_ink" value="${esc(sv('caption_ink') || '#F5F5F5')}"> צבע הטקסט</label>
          <label class="chk" style="margin:0"><input type="color" data-stylec="caption_highlight" value="${esc(sv('caption_highlight') || '#FFFF00')}"> צבע ההדגשה</label></div>
        <label class="chk" style="margin-top:10px"><input type="checkbox" data-style="highlight_enabled" ${sv('highlight_enabled') === false ? '' : 'checked'}> הדגשת מילות מפתח בצבע</label>
        <label for="st_anim">הנפשת כניסה של כתובית</label><select id="st_anim" data-styles="caption_animation">
          ${[['none', 'בלי הנפשה'], ['fade', 'הופעה הדרגתית (0.12 שנ׳)'], ['rise', 'הופעה הדרגתית עם עלייה קלה']].map(([k, l]) => `<option value="${k}" ${(sv('caption_animation') || 'none') === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <div id="stsum" class="small" style="margin-top:8px"></div>
        <button class="primary" data-do="revise" style="margin-top:10px;width:100%">הפק גרסה עם הסגנון הזה</button>
        <p class="small mute">הבדיקות מונעות כיסוי פנים, חריגה מהפריים ומהאזור הבטוח וכרטיסים קצרים מדי; כתובית שלא נכנסת מפוצלת או עוברת לשתי שורות.</p></div>`;
  }

  // ── Edit: plan, zooms, graphics, adjustments, before/after, one "produce" action ──
  const ADJ_ORDER = ['color', 'audio_cleanup', 'zooms', 'caption_animation', 'graphics', 'animation'];
  /** Captions that flash by under the style in force: the numbers, a clip of the same seconds with a readable alternative, and a button to ask for it. */
  function readabilityCard(pkg) {
    const r = pkg.readability; if (!r || !r.current) return '';
    return `<div class="card" id="readability" style="border-color:var(--warn)"><h2>קריאות הכתוביות: חלופה להשוואה</h2>
      <div class="small">${esc(r.problem || '')}</div>
      <ul class="plain small"><li><b>עכשיו</b> (גודל ${esc(r.current.caption_size)}, ${r.current.max_lines < 2 ? 'שורה אחת' : r.current.max_lines + ' שורות'}): ${esc(r.current.short_cards)} כרטיסים שחולפים מהר מדי</li>
        ${(r.alternatives || []).map(a => `<li><b>${esc(a.label)}</b>: ${esc(a.short_cards)} כרטיסים שחולפים מהר מדי ${a.key === r.shown ? '<span class="pill info">מוצגת בקטע למטה</span>' : ''}
          <button class="sm" data-do="usealt" data-alt="${esc(a.key)}" ${busy() ? 'disabled' : ''}>הפק גרסה עם החלופה הזו</button></li>`).join('')}</ul>
      ${r.clip ? `<label>אותן שניות זו לצד זו (${esc((r.clip_s || []).join('–'))} שנ׳): משמאל כפי שהוא עכשיו, מימין החלופה</label><video controls playsinline preload="metadata" src="${base()}/readable-compare" style="max-height:46vh"></video>` : ''}
      ${r.error ? `<div class="small bad">ההשוואה לא הופקה: ${esc(r.error)}</div>` : ''}
      <div class="small mute">${esc(r.basis || '')}. ${esc(r.note || '')} הסקיל עצמו לא משתנה.</div></div>`;
  }
  /** What the target changed in THIS output - from the package, not from a label. */
  function targetCard(p, v, pkg) {
    const t = pkg.target; if (!t) return '';
    const parts = (pkg.plan && pkg.plan.segments) || [], z = t.safe_zone || {};
    return `<div class="card" id="target"><h2>היעד: ${esc(t.label)}</h2><ul class="plain small">
      <li>מבנה: ${t.key === 'story' ? `<b>${parts.length} כרטיסי סטורי</b>, כל אחד עד ${esc(t.part_max_s)} שנ׳ ומובן בפני עצמו (${parts.map(g => (g.tl_out_s - g.tl_in_s).toFixed(1) + ' שנ׳').join(' · ')})` : `<b>סרטון רציף אחד</b> שעומד בפני עצמו (${parts.length} חלקים מההקלטה, ${tfmt(pkg.duration)})`}</li>
      <li>אזור בטוח לכתוביות ולגרפיקה: מלמעלה ${esc(z.top)}px, עד ${esc(z.bottom)}px, שוליים בימין ${esc(z.right_clear)}px <span class="mute">(${t.key === 'story' ? 'הגדרת עבודה לסטורי — לא נמדדה מול האפליקציה' : 'הגדרת העבודה לריל'})</span></li>
      <li>קאבר עם טקסט: ${t.cover_text ? 'כן' : 'לא — לסטורי אין קאבר'} · קפשן לפוסט: ${t.post_caption ? 'כן (טיוטה)' : 'לא — לסטורי אין קפשן'}</li>
      <li>פרסום: <span class="${t.key === 'story' ? 'bad' : 'mute'}">${esc(t.publish)}</span></li></ul>
      ${(v.storyParts || []).length ? `<h3>הכרטיסים כקבצים נפרדים</h3><div class="grid">${v.storyParts.map((n, i) => `<div><video controls playsinline preload="metadata" src="${base()}/story-part-${i + 1}" style="max-height:38vh"></video><div class="small mute">כרטיס ${i + 1}${pkg.outputs && pkg.outputs[i + 1] ? ' · ' + pkg.outputs[i + 1].seconds + ' שנ׳' : ''}</div></div>`).join('')}</div>
        <div class="small mute">הנגן הראשי מציג את כל הכרטיסים ברצף, לצפייה ולביקורת.</div>` : ''}</div>`;
  }
  /** One timeline: for every stretch - the picture, the responsible skill, the length, the text, the sound, the assets and the transition. */
  function timelineCard(pkg, v) {
    const tl = pkg.timeline; if (!tl) return '';
    const LAYER = { over_picture: 'מעל הצילום', replaces_picture: 'מחליף את הצילום', on_footage: 'על הצילום' };
    return `<div class="card" id="timeline"><h2>ציר הזמן של העריכה</h2><p class="small mute">${esc(tl.note)}</p>
      <ul class="plain">${tl.spans.map(x => `<li><div class="row"><button class="sm" data-play="${x.t0},${x.t1}">▶ ${tfmt(x.t0)}–${tfmt(x.t1)}</button><span class="pill ${x.picture === 'animation_scene' ? 'warn' : 'info'}">${x.picture === 'animation_scene' ? 'קטע אנימציה' : 'צילום'}</span><span class="pill mute">${esc(x.seconds)} שנ׳</span></div>
        <div><b>${esc(x.picture_label)}</b></div>
        <div class="small">סקיל אחראי: ${esc(x.skill)} · מעבר: ${esc(x.transition_in)}</div>
        <div class="small">טקסט (${esc(x.text_layer)}): ${esc(x.text || '—')}</div>
        <div class="small mute">אודיו: ${esc(x.audio)} · נכסים: ${esc(x.assets)}</div></li>`).join('')}</ul>
      ${tl.events.length ? `<h3>מה מונח על הציר</h3><ul class="plain small">${tl.events.map(e => `<li><button class="sm" data-play="${Math.max(0, e.t0 - 0.5).toFixed(2)},${(e.t1 + 0.3).toFixed(2)}">▶ ${tfmt(e.t0)}</button> ${esc(e.label)} <span class="pill mute">${esc(LAYER[e.layer] || e.layer)}</span> · סקיל אחראי: ${esc(e.skill)}${e.why ? `<div class="mute">${esc(e.why)}</div>` : ''}</li>`).join('')}</ul>` : ''}</div>`;
  }
  /** Why the correction rounds stopped, what was not sent to the editor again and what a rule in force made irrelevant. */
  function loopNotes(pkg) {
    const e = pkg.editorial; if (!e || !Array.isArray(e.cycles)) return '';
    const last = e.cycles[e.delivered_cycle] || e.cycles[e.cycles.length - 1] || {}, ns = last.not_sent_again || [], na = e.cycles.flatMap(c => c.not_applicable || []);
    const stop = e.cycles.map(c => c.stopped_because).filter(Boolean).pop();
    if (!ns.length && !na.length && !stop && !(e.rules_in_force || []).length) return '';
    return `<details class="small" ${ns.length ? 'open' : ''}><summary><b>סבבי התיקון: ${e.cycles.length} סבבי ביקורת, ${e.revisions} תיקונים</b></summary>
      ${stop ? `<div>למה נעצר: ${esc(stop)}</div>` : ''}
      ${(e.rules_in_force || []).length ? `<div>כללים בתוקף בגרסה הזו:</div><ul class="plain">${e.rules_in_force.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${ns.length ? `<div>הערות שלא נשלחו שוב לעורך (להכרעתך):</div><ul class="plain">${ns.map(x => `<li>${esc(x.problem)}<div class="mute">${esc(x.why_not_sent_again)}</div></li>`).join('')}</ul>` : ''}
      ${na.length ? `<div>הערות של הביקורת שלא רלוונטיות לכללים בתוקף (לא נשלחו לעורך):</div><ul class="plain">${na.map(x => `<li>${esc(x.problem)}<div class="mute">${esc(x.why)}</div></li>`).join('')}</ul>` : ''}</details>`;
  }
  /** The three most important improvements of a review. Packages made before 2026-11-16 carry only the long list: its head is used. */
  function topOf(pkg) {
    const f = pkg.finalReview || {};
    if (Array.isArray(f.top_improvements)) return { top: f.top_improvements, total: f.improvements_total || f.top_improvements.length };
    const all = ((pkg.danaReview || {}).improvements || []);
    return { total: all.length, top: all.slice(0, 3).map(i => ({ title: String(i.problem || '').replace(' — לא מתקיים', ''), why: i.evidence, action: i.correction || i.how, time_s: i.time_s,
      who: i.can_apply ? 'dana' : 'owner', who_label: i.can_apply ? 'דנה יכולה ליישם בעצמה' : 'דורש אותך', category: '', basis_label: '' })) };
  }
  /**
   * What the owner needs from Dana's final review, in plain words. `compact` is the card beside the video (every step);
   * the full one opens the review step. Nothing is scored here that was not checked, and it says which file it is about.
   */
  const SL = { 'טוב': 'lv-ok', 'דורש שיפור': 'lv-mid', 'חלש': 'lv-bad', 'לא נבדק': 'lv-none' };
  const RMODE = { delivered: 'הביקורת שנמסרה עם הגרסה', rubric_upgrade: 'דירוג הקובץ הקיים: עדכון לקריטריונים שבתוקף', rating_added: 'דירוג הקובץ הקיים: נוספו ציון מסכם וצעדים הבאים', recomputed: 'דירוג הקובץ הקיים: חישוב מחדש מהתוצאות השמורות ומההכרעות שלך' };
  const rating = () => !!(current && current.rating && ['queued', 'leased'].includes(current.rating.status));
  /** The summary mark and the five areas. Nothing is drawn as a number unless the review carries it. */
  function scoreBlock(p, v, f, compact) {
    const s = f.score, rj = p.rating, wait = rating();
    const state = wait ? `<div class="pill info" style="white-space:normal">הדירוג מתעדכן: ${esc(rj.note || '')}. הסרטון לא משתנה.</div>`
      : rj && rj.status === 'failed' && rj.version === v.n ? `<div class="pill bad" style="white-space:normal">עדכון הדירוג נכשל: ${esc((rj.error || {}).message || '')}</div>` : '';
    const btn = (label) => `<button class="sm" data-do="rate" style="margin-top:6px" ${busy() || wait ? 'disabled' : ''}>${label}</button>`;
    if (!s) return `<div id="scorebox"><div class="score none"><b>אין ציון מסכם</b></div>
      <div class="small">הביקורת של הגרסה הזו נעשתה לפני שהוגדר הציון המסכם. אפשר לדרג את הקובץ הקיים: הסרטון לא משתנה ולא נוצרת גרסה חדשה.</div>${state}${btn('דרג את הקובץ הקיים (בלי רינדור)')}</div>`;
    const col = x => x === null ? 'line' : x >= 85 ? 'ok' : x >= 60 ? 'warn' : 'bad', bb = x => x.by_basis || {};
    const basis = x => ` · נמדד בקוד ${bb(x).measured.met}/${bb(x).measured.decided} · הערכת מודל ${bb(x).model.met}/${bb(x).model.decided}${bb(x).frames.decided ? ` · פריימים ${bb(x).frames.met}/${bb(x).frames.decided}` : ''}${bb(x).human && bb(x).human.decided ? ` · הוכרע בהאזנה שלך ${bb(x).human.met}/${bb(x).human.decided}` : ''}${x.human_only ? ` · ממתין לשיפוט שלך: ${x.human_only}` : ''}${x.not_applicable ? ` · לא רלוונטי: ${x.not_applicable}` : ''}`;
    const ev = s.evidence || { state: 'sufficient', label: '', text: '' }, rg = s.range, un = s.uncertain || { count: 0, items: [] };
    const EV = { sufficient: 'ok', provisional: 'warn', insufficient: 'bad' };
    const groups = s.groups.map(x => `<div class="sg" data-group="${esc(x.key)}"><div class="row"><span class="grow">${esc(x.label)}</span><b class="${SL[x.level]}">${x.score === null ? 'לא נבדק' : x.score}</b></div>
        <div class="bar"><i style="width:${x.score === null ? 0 : x.score}%;background:var(--${col(x.score)})"></i></div>
        <div class="small mute">${x.decided ? `${x.met} מתוך ${x.decided} קריטריונים שנבדקו${x.not_checked ? ` · ${x.not_checked} לא נבדקו` : ''}` : 'אף קריטריון לא הוכרע, ולכן אין ציון'}${x.uncertain ? ` · <span class="warn">${x.uncertain} ממתינים להאזנה שלך${isNum(x.low) && x.low !== x.score ? ` (${x.low} אם יתבררו ככשלים)` : ''}</span>` : ''}${compact || !x.decided ? '' : basis(x)}</div></div>`).join('');
    const c = s.coverage, bl = s.blocking || { count: 0, items: [] };
    const shown = s.overall === null ? null : rg && rg.low !== rg.high ? `${rg.low}–${rg.high}` : String(s.overall);
    return `<div id="scorebox"><div class="small mute">ציון דנה</div><div class="row" style="align-items:flex-end"><div class="score ${shown === null ? 'none' : ''}"><b id="danascore" class="${s.overall === null ? 'lv-none' : SL[s.overall >= 85 ? 'טוב' : s.overall >= 60 ? 'דורש שיפור' : 'חלש']}"><bdi dir="ltr">${shown === null ? esc(ev.label || 'אין ציון כולל') : shown}</bdi></b><span>${shown === null ? '' : 'מתוך 100'}</span></div>
        <div class="small mute grow" id="coverage"><b>כיסוי הבדיקות:</b> ${compact ? `${c.decided} מתוך ${c.applicable} קריטריונים רלוונטיים הוכרעו (${c.percent}%). ${c.not_checked} לא נבדקו${c.uncertain ? `, ${c.uncertain} ממתינים להאזנה שלך` : ''}; הם אינם בציון.` : esc(c.text)}</div></div>
      ${ev.label ? `<div class="small" id="evidence" style="margin-top:4px"><span class="pill ${EV[ev.state] || 'mute'}">${esc(ev.label)}</span> ${esc(ev.text || '')}${rg && !compact ? ` ${esc(rg.text)}` : ''}</div>` : ''}
      ${bl.count ? `<div class="bad small" id="blocking" style="margin-top:6px"><b>${esc(bl.text)}</b>${compact ? '' : `<ul class="plain">${bl.items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`}</div>` : (compact ? '' : `<div class="small ok" style="margin-top:6px">${esc(bl.text)}</div>`)}
      ${un.count ? `<div class="warn small" id="uncertain" style="margin-top:4px"><b>${esc(un.text)}</b>${compact ? '' : `<ul class="plain">${un.items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`}</div>` : ''}
      ${state}${s.kinds ? `<div class="small" id="kinds" style="margin-top:8px"><div><b>${esc(s.kinds.technical.label)}:</b> ${s.kinds.technical.met} מתוך ${s.kinds.technical.decided} עברו <span class="mute">(${esc(s.kinds.technical.what)})</span></div>
        <div><b>${esc(s.kinds.editorial.label)}:</b> ${s.kinds.editorial.met} מתוך ${s.kinds.editorial.decided} · ${s.kinds.editorial.topics.map(t => `${esc(t.label)} ${t.decided ? `${t.met}/${t.decided}` : 'לא הוערך'}`).join(' · ')} <span class="mute">(${esc(s.kinds.editorial.what)})</span></div>
        <div><b>${esc(s.kinds.owner.label)}:</b> ${s.kinds.owner.listening} להאזנה, ${s.kinds.owner.watching} לצפייה או האזנה שרק את/ה יכול/ה לעשות${s.kinds.owner.settled ? `; ${s.kinds.owner.settled} כבר הכרעת` : ''}</div></div>` : ''}${groups}
      ${compact ? '' : `<div class="small mute" style="margin-top:8px"><b>איך מחושב:</b> ${esc(s.how)} ${esc(s.levels)}. גרסת החישוב ${esc(s.version)}, קריטריונים ${esc(s.rubric_version || f.rubric_version)}.</div>
        <div class="small mute">${(s.limits || []).map(esc).join(' · ')}.</div>${btn('דרג שוב את הקובץ הקיים לפי הקריטריונים שבתוקף (בלי רינדור)')}`}</div>`;
  }
  /** Where to go from here: what Dana can do, what needs the owner, what is blocked. */
  function nextSteps(v, f, compact) {
    const ns = f.next_steps; if (!ns) return '';
    if (compact) return `<div class="small" id="nscount" style="margin-top:8px"><b>מה הלאה:</b> <span class="ok">דנה יכולה לבצע ${ns.dana.length}</span> · <span class="warn">דורש אותך ${ns.owner.length}</span> · <span class="bad">חסום ${ns.blockers.length}</span></div>`;
    const tbtn = x => isNum(x.time_s) && v.hasVideo ? `<button class="sm" data-play="${Math.max(0, x.time_s - 0.5).toFixed(2)},${(x.time_s + 4).toFixed(2)}">▶ ${tfmt(x.time_s)}</button>` : '';
    const li = (x, extra) => `<li><div class="row"><span class="grow">${esc(x.title)}</span>${extra || ''}${tbtn(x)}</div>${x.action ? `<div class="small"><b>מה לעשות:</b> ${esc(x.action)}</div>` : ''}</li>`;
    return `<div class="card" id="nextsteps" style="margin-top:10px"><h3>מה הלאה</h3>
      <div class="ns"><b class="ok">1. דנה והעובד יכולים לבצע (${ns.dana.length})</b><ul class="plain small">${ns.dana.map(x => li(x, `<span class="pill ${x.replan ? 'warn' : 'ok'}">${esc(x.how)}</span>`)).join('') || '<li class="mute">אין כרגע.</li>'}</ul></div>
      <div class="ns"><b class="warn">2. דורש החלטה או אימות שלך (${ns.owner.length})</b><ul class="plain small">${ns.owner.map(x => li(x)).join('') || '<li class="mute">אין כרגע.</li>'}</ul>
        ${ns.open_items ? `<div class="small mute">בנוסף, ${ns.open_items} פריטים פתוחים להאזנה או לצפייה מופיעים בהמשך המסך הזה.</div>` : ''}</div>
      <div class="ns"><b class="bad">3. מה חסר ממך כדי להתקדם: חומר, רישיון, מידע עסקי או הכרעה על יכולת (${ns.blockers.length})</b><ul class="plain small">${ns.blockers.map(x => li(x, `<span class="pill bad">${esc(x.kind)}</span>`)).join('') || '<li class="mute">אין חסם.</li>'}</ul></div></div>`;
  }
  /**
   * "הדירוג הסופי של דנה", in plain words. `compact` is the card beside the video (every step); the full one opens the
   * review step. Nothing is scored here that was not checked, and it says which file and which skills it is about.
   */
  function reviewHead(p, v, pkg, compact) {
    const f = pkg.finalReview; if (!f) return '';
    const r = p.review, stale = r && !r.upToDate, pl = f.plain || {}, { top, total } = topOf(pkg), c = f.coverage || {}, ns = f.next_steps;
    const cls = stale ? 'bad' : ({ needs_fix: 'bad', needs_owner: 'warn', ready_for_viewing: 'ok' }[f.verdict] || 'mute');
    const status = stale ? 'הדירוג אינו עדכני' : f.verdict === 'needs_owner' && (f.uncertain_checks || []).length ? 'נדרשת האזנה שלך' : (pl.status || f.verdict_text);
    const READY = { needs_fix: 'לא מוכן: יש מה לתקן', needs_owner: 'לא מוכן: מחכה להכרעה שלך', ready_for_viewing: 'מוכן לצפייה שלך (עדיין לא אישור)' };
    const cats = f.categories || [], okc = cats.filter(x => x.decided && x.met === x.decided), weak = cats.filter(x => x.decided && x.met < x.decided);
    const works = pl.works || ('מה עובד: ' + (okc.map(x => x.label).join(', ') || '—') + '.'), weakT = pl.weak || (weak.length ? 'מה עדיין חלש: ' + weak.map(x => `${x.label} (${x.met} מתוך ${x.decided})`).join('; ') + '.' : 'בקריטריונים שנבדקו לא נמצא דבר חלש.');
    const canApply = ns ? ns.dana.length : top.filter(x => x.who === 'dana').length || ((pkg.danaReview || {}).improvements || []).filter(i => i.can_apply).length + (pkg.danaCanApply || []).length;
    const tried = new Set((((v.appliedImprovements || {}).items) || []).map(x => x.id));
    const imp = (x, n) => `<li class="imp" data-finding="${esc(x.finding || x.id || '')}"><div class="row"><b class="grow">${n}. ${esc(x.title)}</b>${isNum(x.time_s) && v.hasVideo ? `<button class="sm" data-play="${Math.max(0, x.time_s - 0.5).toFixed(2)},${(x.time_s + 4).toFixed(2)}">▶ ${tfmt(x.time_s)}</button>` : '<span class="pill mute">כל הסרטון</span>'}</div>
      <div class="row">${x.category ? `<span class="pill mute">${esc(x.category)}</span>` : ''}${x.basis_label ? `<span class="pill mute">${esc(x.basis_label)}</span>` : ''}<span class="pill ${x.who === 'dana' ? 'ok' : 'warn'}">${esc(x.who_label || '')}</span></div>
      ${x.why ? `<div class="small mute">למה: ${esc(compact && x.why.length > 130 ? x.why.slice(0, 130) + '…' : x.why)}</div>` : ''}<div class="small"><b>מה לעשות:</b> ${esc(x.action || '—')}</div></li>`;
    const refs = f.references || (pkg.rulesUsed || {}).references || [];
    const skillsLine = `<div class="small mute" id="reviewbasis" style="margin-top:6px">גרסה ${v.n} של הסרטון${f.file_sha256 ? ` · קובץ <code>${esc(f.file_sha256.slice(0, 12))}…</code>` : ''} · לפי הסקילים: ${(f.skills || []).map(x => `<b>${esc(x.name)}</b> ${esc(x.version)}`).join(' · ')} · רפרנסים: ${refs.length ? refs.map(x => `<b>${esc(x.title || x.name || x.id || 'רפרנס')}</b>`).join(', ') : 'לא נבחר רפרנס'}${f.rating ? ` · דורג ${fmt(f.rating.rated_at)}` : f.reviewed_at ? ` · נבדק ${fmt(f.reviewed_at)}` : ''}</div>`;
    const head = `<div class="row" id="readiness"><span class="small mute">מצב מוכנות</span><span class="pill ${cls}" style="font-size:16px;padding:5px 14px;font-weight:700">${esc(status)}</span>
        <span class="small mute">${stale ? '' : esc(READY[f.verdict] || '')} · גרסה ${v.n} · ${esc((pkg.target || {}).label || 'ריל')}</span></div>
      ${f.source ? `<div class="small" id="reviewsource" style="margin-top:4px"><span class="pill ${f.source.kind === 'stored_results' ? 'info' : 'ok'}" style="white-space:normal">${esc(f.source.label)}</span></div>` : ''}
      ${stale ? `<ul class="plain small">${r.stale.map(x => `<li class="bad">${esc(x)}</li>`).join('')}</ul><div class="small">הדירוג למטה שייך לקובץ שנבדק אז, לא למה שמוצג עכשיו.</div>` : ''}
      ${pl.note ? `<div class="pill warn" style="white-space:normal">${esc(pl.note)}</div>` : ''}
      ${scoreBlock(p, v, f, compact)}
      <div class="small" style="margin-top:8px"><span class="ok">●</span> ${esc(works)}</div><div class="small"><span class="${weak.length ? 'bad' : 'ok'}">●</span> ${esc(weakT)}</div>`;
    const list = top.length ? `<div style="margin-top:8px"><b>${top.length === 1 ? 'השיפור החשוב ביותר' : `${top.length} השיפורים החשובים ביותר, לפי סדר עדיפות`}</b>${total > top.length ? ` <span class="small mute">(מתוך ${total})</span>` : ''}</div><ul class="plain">${top.map((x, i) => imp(x, i + 1)).join('')}</ul>`
      : '<div class="small ok" style="margin-top:8px">בקריטריונים שנבדקו לא נמצא שיפור נדרש.</div>';
    if (compact) return `<div class="card" id="sidereview" style="border:2px solid var(--${cls})"><h2 style="margin:0 0 6px">הדירוג הסופי של דנה</h2>${head}${list}${nextSteps(v, f, true)}${skillsLine}
      <button class="sm" data-go="review" style="margin-top:8px;width:100%">לדירוג המלא, לצעדים הבאים וליישום השיפורים</button>
      <div class="small mute">הציון אינו אישור פרסום ואינו מבטל כשל מחייב. המודל ראה תמלול ופריימים בודדים; איש לא צפה ולא האזין.</div></div>`;
    const dir = f.direction && f.direction.text ? `<div class="small" style="margin-top:6px"><b>כיוון העריכה</b> <span class="pill ${f.direction.source === 'owner_brief' ? 'ok' : 'warn'}">${esc(f.direction.label)}</span><div>${esc(f.direction.text)}</div></div>` : '';
    const sf = f.same_file, hist = (p.reviews || []);
    const history = hist.length ? `<details class="small" id="reviewhistory" data-keep="rvhist" style="margin-top:8px"><summary><b>היסטוריית הביקורות של הגרסה הזו (${hist.length})</b></summary>
        <ul class="plain" id="reviewlist">${hist.slice().reverse().map(e => `<li>${fmt(e.at)} · ${esc(RMODE[e.mode] || e.mode)} · קריטריונים ${esc(e.rubricVersion || '—')} · ${e.overall === null ? 'בלי ציון מסכם' : `ציון ${e.overall}`}${e.fileSha256 ? ` · קובץ <code>${esc(e.fileSha256.slice(0, 12))}…</code>` : ''}${e.by && e.mode !== 'delivered' ? ` · ביקש/ה: ${esc(e.by)}` : ''}
          ${e.shown ? '<span class="pill info">מוצגת</span>' : ''}${e.aboutStoredFile ? '' : '<span class="pill bad">על קובץ אחר: לא עדכנית</span>'}</li>`).join('')}</ul>
        ${sf ? `<div><b>שינוי בדירוג לאותו קובץ:</b> ${esc(sf.text)}</div>${(sf.criteria || []).length ? `<ul class="plain">${sf.criteria.map(x => `<li><span class="pill mute">${esc(x.category)}</span> ${esc(x.criterion)}: ${esc(x.before)} → <b>${esc(x.after)}</b>${x.why ? `<div class="mute">${esc(x.why)}</div>` : ''}</li>`).join('')}</ul>` : ''}` : ''}
        ${f.rating ? `<div class="mute">${esc(f.rating.note)}</div>` : ''}</details>` : '';
    return `${head}${dir}${skillsLine}
      <h3 style="margin-top:10px">דירוג לפי קטגוריות</h3>
      <div class="grid">${cats.map(x => `<div class="cat"><b>${esc(x.label)}</b><span class="${LV[x.level]}">${esc(x.level)}</span><div class="small mute">${x.decided ? `${x.met} מתוך ${x.decided}` : 'לא נבדק'}${x.not_checked ? ` · ${x.not_checked} לא נבדקו` : ''}</div></div>`).join('')}</div>
      <div class="small mute">הדירוג סופר רק קריטריונים שנבדקו. ${c.measured ? `נמדד בקובץ: ${c.measured.met}/${c.measured.decided} · הערכת מודל על תמלול ופריימים בודדים: ${c.model.met}/${c.model.decided}${c.frames && c.frames.decided ? ` · פריימים: ${c.frames.met}/${c.frames.decided}` : ''} · לא נבדקו: ${c.not_checked}, מהם ${(c.human_only || []).length} שרק צפייה או האזנה שלך יכולה להכריע (בלי ציון).` : ''}</div>
      ${list}
      <div class="small" style="margin-top:8px"><b>מה לא נבדק (${(f.not_checked || []).length}):</b> ${(f.not_checked || []).slice(0, 6).map(x => esc(x.criterion)).join(' · ') || '—'}${(f.not_checked || []).length > 6 ? ' ועוד' : ''}.
        לדברים האלה אין ציון: המודל ראה תמלול ופריימים בודדים, ואיש לא צפה בתנועה ולא האזין.</div>
      <div class="small mute">זו אינה אישור: רק את/ה מאשר/ת גרסה, ואישור אינו פרסום ואינו הבטחה לביצועים.</div>
      ${history}${nextSteps(v, f, false)}
      <div class="card" id="applybox" style="margin-top:10px;background:var(--accent-soft)">
        <b>יישם את השיפורים של דנה והפק גרסה חדשה</b>
        <div class="small">${ns ? esc(ns.apply.text) : canApply ? `דנה תיישם בעצמה ${canApply} שיפורים שבתוך ההוראות והסגנון המאושרים. שיפור של תוכן (פתיחה, מבנה, קצב) מיושם בתכנון מחדש של החיתוך, מאותו חומר.` : 'בביקורת הזו אין שיפור שדנה יכולה ליישם בעצמה. אפשר לכתוב לה משוב, והיא תפיק גרסה חדשה לפיו.'} ${ns && !ns.dana.length ? 'אפשר לכתוב לה משוב, והיא תפיק גרסה חדשה לפיו. ' : ''}הגרסה הנוכחית נשמרת. שום דבר לא מופק עד שלוחצים.</div>
        ${ns && ns.dana.length ? `<ul class="plain small" id="applylist">${ns.dana.map(x => `<li>${esc(x.title)} <span class="mute">— ${esc(x.how)}</span>${tried.has(x.id) ? ' <span class="pill warn" style="white-space:normal">כבר נוסה בהפקת הגרסה הזו ולא נפתר: לא יישלח שוב</span>' : ''}</li>`).join('')}</ul>` : ''}
        ${v.appliedImprovements ? `<div class="small mute" id="appliedfrom">הגרסה הזו הופקה מ"יישם שיפורים" על גרסה ${v.appliedImprovements.fromVersion}: התבקשו ${v.appliedImprovements.items.length} תיקונים${(v.appliedImprovements.leftForOwner || []).length ? `, ו-${v.appliedImprovements.leftForOwner.length} נשארו להחלטתך` : ''}.</div>` : ''}
        ${ns ? `<div class="small" id="applyleft"><b>לא יבוצע אוטומטית:</b> ${ns.owner.length} פריטים שדורשים החלטה או האזנה שלך, ו-${ns.blockers.length} חסמים. הם מפורטים ב"מה הלאה" למעלה.</div>` : ''}
        ${p.kept ? `<div class="small" id="applykept"><b>התיקונים הקודמים שלך נשמרים בגרסה הבאה:</b> ${[[p.kept.captionEdits, 'תיקוני כתוביות'], [p.kept.hearing, 'הכרעות האזנה'], [p.kept.zoomEdits, 'שינויי זום'], [p.kept.segmentEdits, 'שינויי קטעים'], [p.kept.graphicEdits, 'שינויי גרפיקה'], [p.kept.rules, 'כללים קבועים']].filter(x => x[0]).map(x => `${x[0]} ${x[1]}`).join(', ') || 'אין כרגע תיקונים קודמים בפרויקט הזה'}.</div>` : ''}
        <textarea id="arnote" data-keep="arnote" style="min-height:44px;margin-top:6px" placeholder="משוב שלך לגרסה הבאה (לא חובה). למשל: לפתוח במשפט על הקהילה, לקצר את ההקדמה">${esc((draftNotes[p.id] || {}).ar || '')}</textarea>
        <button class="primary" data-do="applyreview" style="margin-top:6px;width:100%" ${busy() || rating() || stale ? 'disabled' : ''}>יישם את השיפורים של דנה והפק גרסה חדשה</button>
        <details class="small" style="margin-top:8px"><summary>צרף את הביקורת והמשוב שלי לטיוטת שדרוג של סקיל עריכה</summary>
          <div class="mute">נוצרת טיוטה בלבד: מוצג מה השתנה ולמה, ורק את/ה מאשר/ת סקיל. פרויקטים קיימים לא משתנים.</div>
          <select id="arskill" style="margin-top:6px">${(skillsNow || []).filter(k => k.approved).map(k => `<option value="${esc(k.id)}">${esc(k.name)}</option>`).join('') || '<option value="">אין סקיל מאושר בספרייה</option>'}</select>
          <button class="sm" data-do="reviewtoskill" style="margin-top:6px">צור טיוטת שדרוג מהביקורת ומהמשוב</button></details></div>`;
  }
  /** "הביקורת הסופית של דנה": about ONE file and ONE version, after all the corrections. */
  function finalReviewCard(p, v, pkg) {
    const f = pkg.finalReview, r = p.review; if (!f) return '';
    const V = { ready_for_viewing: ['ok', 'מוכן לצפייה שלך'], needs_owner: ['warn', f.verdict_text], needs_fix: ['bad', f.verdict_text] }[f.verdict] || ['mute', f.verdict_text];
    const stale = r && !r.upToDate, c = f.coverage, sc = f.skill_compliance, B = { measured: 'נמדד', model: 'הערכת מודל', frames: 'פריימים בודדים', human: 'דורש אותך' };
    return `<div class="card" id="finalreview" style="border:2px solid var(--${stale ? 'bad' : V[0]})"><h2>הדירוג הסופי של דנה — גרסה ${v.n} · ${esc((pkg.target || {}).label || 'ריל')}</h2>
      ${reviewHead(p, v, pkg, false)}
      <details open class="small" style="margin-top:10px"><summary><b>פירוט מלא: כל הבדיקות, הקריטריונים והראיות</b></summary>
      ${stale ? `<div class="pill bad">הביקורת אינה עדכנית</div><ul class="plain small">${r.stale.map(x => `<li class="bad">${esc(x)}</li>`).join('')}</ul>` : `<div class="row"><span class="pill ${V[0]}" style="font-size:15px;padding:4px 12px">${esc(V[1])}</span></div>`}
      <div class="small mute">${esc(f.verdict_basis)} זו אינה אישור: רק את/ה מאשר/ת גרסה, ואישור אינו פרסום.</div>
      ${(f.verdict_reasons || []).length ? `<ul class="plain small">${f.verdict_reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      <ul class="plain small">
        <li>נבדק הקובץ הסופי של הגרסה הזו: ${f.on_delivered_file ? '<span class="ok">כן, אחרי כל התיקונים</span>' : '<span class="bad">לא</span>'} · ${f.reviewed_at ? fmt(f.reviewed_at) : '—'} · ${esc(f.rounds)} סבבי ביקורת${f.file_sha256 ? ` · <code>${esc(f.file_sha256.slice(0, 12))}…</code>` : ''}</li>
        <li>לפי הסקילים: ${f.skills.map(x => `<b>${esc(x.name)}</b> גרסה ${esc(x.version)} <span class="mute">(${esc(x.role)})</span>`).join(' · ')}</li>
        <li><b>סיכום — רק מה שנבדק:</b> ${esc(f.summary)}</li>
        <li>היקף הכיסוי: נבדקו ${c.decided} מתוך ${c.criteria} קריטריונים · נמדד בקוד ${c.measured.met}/${c.measured.decided} · פריימים ${c.frames.met}/${c.frames.decided} · הערכת מודל ${c.model.met}/${c.model.decided} · שיפוט אנושי בלבד: ${c.human_only.length} (ללא ציון)</li>
        ${sc ? `<li>עמידה בכללי הסקילים: ${sc.summary.applied} יושמו · ${sc.summary.not_followed} לא יושמו · ${sc.summary.not_applicable} לא התאימו · ${sc.summary.unsupported} לא נתמכים · ${sc.summary.not_checked} לא נבדקו · פרמטרים ${sc.params_as_in_skill}/${sc.params_total} · קריטריוני הסקיל ${sc.criteria_met}/${sc.criteria_total}</li>` : '<li>לא הופעל סקיל מהספרייה בגרסה הזו.</li>'}</ul>
      <div class="grid">${f.categories.map(x => `<div class="cat"><b>${esc(x.label)}</b><span class="${LV[x.level]}">${esc(x.level)}</span><div class="small mute">${x.decided ? `${x.met}/${x.decided}` : '—'}${x.not_checked ? ` · ${x.not_checked} לא נבדקו` : ''}</div></div>`).join('')}</div>
      <details open><summary><b>מה הצליח (${f.worked.length})</b></summary><ul class="plain small">${f.worked.map(x => `<li><span class="pill ok">${esc(x.category)}</span> ${esc(x.what)}</li>`).join('') || '<li class="mute">—</li>'}</ul></details>
      <details open><summary><b>מה דורש שיפור (${f.needs_improvement.length})</b></summary><ul class="plain small">${f.needs_improvement.map(x => `<li><div class="row"><span class="pill bad">${esc(x.category)}</span><span class="pill mute">${esc(B[x.basis] || x.basis)}</span>${isNum(x.time_s) ? `<button class="sm" data-play="${Math.max(0, x.time_s - 1).toFixed(2)},${(x.time_s + 2.5).toFixed(2)}">▶ ${tfmt(x.time_s)}</button>` : ''}</div>
        <div>${esc(x.criterion)}${x.skill ? ` <span class="mute">(${esc(x.skill)})</span>` : ''}</div><div class="mute">ראיה: ${esc(x.evidence || '—')}</div></li>`).join('') || '<li class="ok">לא נמצא דבר בקריטריונים שנבדקו.</li>'}</ul></details>
      <details><summary><b>מה לא נבדק (${f.not_checked.length})</b></summary><ul class="plain small">${f.not_checked.map(x => `<li>${esc(x.criterion)} <span class="mute">— ${esc(x.why)}</span></li>`).join('')}</ul></details>
      ${f.changes ? `<details ${f.changes.criteria.length ? 'open' : ''}><summary><b>מה השתנה בדירוג מול הגרסה הקודמת (${f.changes.criteria.length})</b></summary><ul class="plain small">${f.changes.criteria.map(x => `<li><span class="pill mute">${esc(x.category)}</span> ${esc(x.criterion)}: ${esc(x.before)} → <b>${esc(x.after)}</b> <span class="pill mute">${esc(B[x.basis] || x.basis)}</span><div class="mute">${esc(x.why)}</div></li>`).join('')}
        ${f.changes.categories.map(x => `<li>${esc(x.label)}: ${esc(x.before)} → <b>${esc(x.after)}</b></li>`).join('')}</ul><div class="small mute">${esc(f.changes.note)}</div></details>` : '<div class="small mute">אין גרסה קודמת עם אותם קריטריונים להשוואה.</div>'}
      ${(f.settled_by_owner || []).length ? `<div class="small">בדיקות שנכשלו במדידה והוכרעו בהאזנה שלך: ${f.settled_by_owner.map(esc).join(', ')}. הן אינן מסומנות כ"עבר".</div>` : ''}
      ${(f.mandatory_violations || []).length ? `<div class="bad"><b>כלל מחייב הופר (נמדד):</b><ul class="plain small">${f.mandatory_violations.map(x => `<li>${esc(x.text)} — ${esc(x.evidence)}</li>`).join('')}</ul></div>` : ''}
      ${loopNotes(pkg)}
      </details>
      <details class="small"><summary>מגבלות הביקורת</summary><ul class="plain">${f.limits.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details></div>`;
  }
  function panelEdit() {
    const p = current, v = p.version, pkg = pkgOf(); if (!pkg) return noPkg('עריכה');
    if (v.kind === 'review_only') return reviewOnlyNote + measuredCard(pkg);
    const h = [], pl = pkg.plan, ri = pkg.requestInterpretation, adj = pkg.adjustments, kinds = p.adjustmentKinds || {};
    const REV = { locked_to_previous_plan: 'תיקון ממוקד: נעול לתוכנית של הגרסה הקודמת — רק מה שביקשת השתנה', replanned: 'תוכנן מחדש', apply_review: 'אותה תוכנית; יושמו שיפורי הביקורת', polish: 'הסרטון הערוך שלך נשמר; הוחלו שיפורים טכניים בלבד' };
    if (REV[pkg.revisionMode] || ri) h.push(`<div class="card" id="revinfo"><h2>מה השתנה בגרסה הזו</h2>
      ${REV[pkg.revisionMode] ? `<div class="pill ${pkg.revisionMode === 'replanned' ? 'warn' : 'info'}">${REV[pkg.revisionMode]}</div>` : ''}
      ${ri ? `<label>הבקשה שלך</label><div class="quote">${esc(ri.request)}</div>
        <label>איך דנה הבינה אותה</label><div>${esc(ri.explanation)}</div>
        <div class="row" style="margin-top:6px">${(ri.domain_labels || []).map(d => `<span class="pill info">${esc(d)}</span>`).join('')}${ri.mode === 'replan' ? '<span class="pill warn">נדרש תכנון חדש — ייתכנו שינויים גם בחלקים אחרים</span>' : ri.mode === 'nothing_applied' ? '<span class="pill bad">לא נמצא שינוי שאפשר ליישם</span>' : '<span class="pill ok">שאר העריכה לא השתנתה</span>'}</div>
        ${(ri.not_applied || []).length ? `<ul class="plain small">${ri.not_applied.map(x => `<li class="warn">לא יושם: ${esc(x)}</li>`).join('')}</ul>` : ''}` : ''}
      ${pkg.revisionNote ? `<div class="quote">${esc(pkg.revisionNote)}</div>` : ''}</div>`);
    h.push(targetCard(p, v, pkg));
    h.push(cutChangesCard(p, v, pkg));
    h.push(sourceMapCard(p, pkg));
    h.push(mixCard(pkg));
    h.push(readabilityCard(pkg));
    h.push(skillReportCard(pkg));
    h.push(timelineCard(pkg, v));
    if (pl) h.push(`<div class="card" id="plan"><h2>התוכנית של דנה</h2>
      <label>המסר</label><div>${esc(pl.message || '—')}</div><label>הפתיחה</label><div>${esc(pl.hook || '—')}</div><label>למה</label><div>${esc(pl.rationale || '—')}</div>
      <label>מפת הקטעים</label><ul class="plain small">${(pl.segments || []).map(g => `<li><div class="row"><b>${esc(g.n)}.</b><span>מקור ${tfmt(g.source_in_s)}–${tfmt(g.source_out_s)}</span>${isNum(g.tl_in_s) ? `<button class="sm" data-play="${g.tl_in_s},${g.tl_out_s}" style="margin-inline-start:auto">▶ ${tfmt(g.tl_in_s)}</button>` : ''}</div><div>${esc(g.why || '')}</div></li>`).join('')}</ul>
      <div class="small mute">${esc(pl.basis || '')}</div></div>`);
    if (Array.isArray(pkg.zooms)) h.push(`<div class="card" id="zooms"><h2>זומים (${pkg.zooms.length})</h2>
      ${pkg.zooms.length ? `<ul class="plain">${pkg.zooms.map(z => { const d = draft.zooms[z.id] || {}; return `<li><div class="row"><button class="sm" data-play="${Math.max(0, z.tl_t_s - 1).toFixed(2)},${Math.min(z.hold_until_s + 0.6, z.tl_t_s + 4).toFixed(2)}">▶ ${tfmt(z.tl_t_s)}</button><span class="pill mute">×${esc(z.scale)}</span>
          <span class="small mute">${z.focus_source === 'face_measured' ? 'ממורכז על הפנים שנמדדו' : 'ממורכז (לא נמדדו פנים)'}</span></div>
        <div>${esc(z.reason || '')}</div>${z.evidence ? `<div class="small mute">${esc(z.evidence)}</div>` : ''}
        <div class="row" style="margin-top:6px"><select data-zoom="${esc(z.id)}" style="flex:1"><option value="">להשאיר</option><option value="remove" ${d.action === 'remove' ? 'selected' : ''}>לבטל את הזום הזה</option><option value="set" ${d.action === 'set' ? 'selected' : ''}>לשנות עוצמה</option></select>
          <input type="number" data-zoomscale="${esc(z.id)}" min="1.05" max="1.5" step="0.05" value="${esc(d.scale || z.scale)}" style="width:90px" ${d.action === 'set' ? '' : 'disabled'}></div></li>`; }).join('')}</ul>`
        : `<div class="mute">הגרסה הזו נערכה בלי זומים${adj && adj.zooms && adj.zooms.enabled === false ? ' (כובו לפרויקט)' : ''}.</div>`}
      ${pl && (pl.zooms_not_used || []).length ? `<details class="small"><summary>זומים שלא נכנסו (${pl.zooms_not_used.length})</summary><ul class="plain">${pl.zooms_not_used.map(z => `<li>${tfmt(z.at_s)}: ${esc(z.why)}</li>`).join('')}</ul></details>` : ''}</div>`);
    if (Array.isArray(pkg.graphics)) { const over = pkg.graphics.filter(g => g.layer !== 'replaces_picture'), scenes = pkg.graphics.filter(g => g.layer === 'replaces_picture');
      const item = g => `<li><div class="row"><button class="sm" data-play="${Math.max(0, g.tl_start_s - 0.5).toFixed(2)},${(g.tl_end_s + 0.5).toFixed(2)}">▶ ${tfmt(g.tl_start_s)}–${tfmt(g.tl_end_s)}</button><span class="pill info">${esc(g.label)}</span><span class="pill ${g.text_class === 'editorial' ? 'warn' : 'ok'}">${g.text_class === 'editorial' ? 'כותרת עריכתית — לא ציטוט' : 'ציטוט מדויק'}</span></div>
        <div><b>${esc(g.text)}</b></div><div class="small">התפקיד: ${esc(g.reason || '—')}</div>
        ${g.design ? `<details class="small"><summary>תדריך הרכיב</summary><ul class="plain">
          <li>מקור הטקסט: ${esc(g.text_source || '—')}</li><li>זמן: ${tfmt(g.tl_start_s)}–${tfmt(g.tl_end_s)} (${(g.tl_end_s - g.tl_start_s).toFixed(1)} שנ׳)${isNum(g.y_px) ? ` · מיקום: ${g.y_px}px מלמעלה${g.scale && g.scale < 1 ? `, מוקטן ל-${Math.round(g.scale * 100)}%` : ''}` : g.layer === 'replaces_picture' ? ' · מסך מלא' : ''}</li>
          <li>עיצוב והנפשה: ${esc(g.design)}</li><li>כלי: ${esc(g.tool || '—')}</li><li>איך נבדק: ${esc(g.check || '—')}</li>
          <li class="mute">מי קבע: מטרה, טקסט ותזמון — ${esc((g.decided_by || {}).purpose_text_timing || '—')}; עיצוב, כלי ובדיקה — ${esc((g.decided_by || {}).design_tool_check || '—')}</li></ul></details>` : ''}
        <label class="chk small"><input type="checkbox" data-grm="${esc(g.id)}" ${draft.graphics && draft.graphics[g.id] ? 'checked' : ''}> להסיר רק את זה בגרסה הבאה (שאר הסרטון לא משתנה)</label></li>`;
      h.push(`<div class="card" id="graphics"><h2>גרפיקה ואנימציה</h2>
      <h3>א. גרפיקה מונפשת מעל הצילום (${over.length})</h3>
      ${over.length ? `<ul class="plain">${over.map(item).join('')}</ul><div class="small mute">שכבה שקופה מעל הדוברת. נבדק שהיא בקובץ הסופי, באזור הבטוח ולא על הפנים.</div>` : '<div class="mute small">אין. דנה מוסיפה גרפיקה רק כשיש לה תפקיד בתוכן.</div>'}
      <h3>ב. קטע אנימציה שמחליף את הצילום (${scenes.length})</h3>
      ${scenes.length ? `<ul class="plain">${scenes.map(item).join('')}</ul><div class="small mute">לכמה שניות התמונה היא הסצנה ולא הצילום; הקול והכתוביות ממשיכים. נבדק שהתמונה בקובץ הסופי אכן מוחלפת בזמן שנקבע.</div>` : `<div class="mute small">אין.${adj && adj.animation && !adj.animation.allowed ? ' קטע אנימציה לא התבקש בסקילים שנבחרו ולא הותר לפרויקט.' : ''}</div>`}
      <div class="small mute">${esc((adj && adj.animation && adj.animation.what) || '')} מנוע: ${esc((adj && adj.graphics && adj.graphics.engine) || 'HyperFrames')}.</div>
      ${pl && (pl.graphics_not_used || []).length ? `<details class="small" open><summary>תוכנן ולא נכנס (${pl.graphics_not_used.length})</summary><ul class="plain">${pl.graphics_not_used.map(g => `<li>"${esc(g.quote)}": ${esc(g.why)}</li>`).join('')}</ul></details>` : ''}</div>`); }
    if (adj) {
      const rec = (r, labelBefore) => r ? `<ul class="plain small">${(r.decisions || []).map(d => `<li>${esc(d)}</li>`).join('')}${r.skin_guard ? `<li class="mute">${esc(r.skin_guard)}</li>` : ''}${r.speech_guard ? `<li class="mute">${esc(r.speech_guard)}</li>` : ''}
        ${r.params && Object.keys(r.params).length ? `<li>פרמטרים: <code dir="ltr">${esc(JSON.stringify(r.params))}</code></li>` : ''}</ul><div class="small mute">${esc(r.basis || '')}</div>` : '';
      const tog = k => { const on = draft.adjustments[k] !== undefined ? draft.adjustments[k] : (p.adjustments || {})[k] !== false;
        return `<label class="chk"><input type="checkbox" data-adj="${k}" ${on ? 'checked' : ''}> ${esc(kinds[k] || k)} — פעיל מהגרסה הבאה</label>`; };
      h.push(`<div class="card" id="adjust"><h2>צבע, סאונד ואפקטים</h2>
        <p class="small mute">אין פילטר קבוע: כל תיקון מתחיל ממדידה של הסרטון הזה ומופעל רק כשהמדידה מחוץ לטווח. כל סוג אפשר לכבות.</p>
        <h3>צבע <span class="pill ${adj.color.applied ? 'info' : 'mute'}">${adj.color.applied ? 'תוקן' : adj.color.enabled === false ? 'כבוי' : 'לא נדרש תיקון'}</span></h3>${rec(adj.color)}${tog('color')}
        <h3>סאונד <span class="pill ${adj.audio_cleanup.applied ? 'info' : 'mute'}">${adj.audio_cleanup.applied ? 'נוקה' : adj.audio_cleanup.enabled === false ? 'כבוי' : 'לא נדרש ניקוי'}</span></h3>${rec(adj.audio_cleanup)}
        ${pkg.audio ? `<div class="small mute">עוצמת המקור ${esc(pkg.audio.source_lufs)} LUFS → נורמלה ליעד ‎-14 LUFS (תמיד).</div>` : ''}${tog('audio_cleanup')}
        <h3>זומים</h3>${tog('zooms')}<h3>הנפשת כתוביות <span class="pill mute">${esc({ none: 'בלי', fade: 'הופעה הדרגתית', rise: 'הופעה עם עלייה' }[adj.caption_animation.style] || adj.caption_animation.style)}</span></h3>${tog('caption_animation')}
        <h3>מואושן גרפיק (מעל הצילום)</h3>${tog('graphics')}<h3>קטעי אנימציה (מחליפים את הצילום)</h3>${tog('animation')}</div>`);
    }
    if (v.hasCompare) h.push(`<div class="card" id="compare"><h2>לפני / אחרי</h2>
      <div class="ba"><span>אחרי — ${esc((pkg.compare || {}).right || 'הסרטון הסופי')}</span><span>לפני — ${esc((pkg.compare || {}).left || '')}</span></div>
      <img class="wide" alt="לפני ואחרי באותם פריימים" src="${base()}/compare-frames" style="max-height:none">
      <div class="small mute">אותם פריימים בדיוק (${esc(((pkg.compare || {}).frames_s || []).map(t => t + 's').join(', '))}).</div>
      ${v.hasCompareClip ? `<label>קטע וידאו: לפני ואחרי זה לצד זה (${esc(((pkg.compare || {}).clip_s || []).join('–'))} שנ׳)</label><video controls playsinline preload="metadata" src="${base()}/compare-clip"></video>
        <div class="small mute">${esc((pkg.compare || {}).sound || '')}</div>` : ''}</div>`);
    const notes = (pkg.issues || []).filter(i => i.severity !== 'blocker' && i.code !== 'owner_correction_kept');
    if (notes.length) h.push(`<div class="card" id="notes"><details><summary><b>הערות מהעריכה (${notes.length})</b></summary><ul class="plain small">${notes.map(i => `<li><span class="pill ${i.severity === 'warn' ? 'warn' : 'mute'}">${i.severity === 'warn' ? 'לתשומת לב' : 'מידע'}</span> ${esc(i.message)}</li>`).join('')}</ul></details></div>`);
    h.push(`<div class="card" id="revise"><h2>בקשת תיקון והפקת גרסה</h2><div id="rvsum" class="small"></div>${requestBox()}</div>`);
    return h.join('');
  }
  function measuredCard(pkg) {
    const m = pkg.measured; if (!m) return '';
    return `<div class="card"><h2>מה נמדד בסרטון שהעלית</h2><ul class="plain small">
      <li>${esc(m.width)}×${esc(m.height)} · ${tfmt(m.duration_s)} · ${esc(m.cut_count ?? 0)} חיתוכים</li>
      ${m.audio ? `<li>סאונד: יחס דיבור/רעש ${esc(m.audio.snr_db)}dB · רעש חדר ${esc(m.audio.room_tone_db)}dB</li>` : ''}
      ${m.picture ? `<li>תמונה: בהירות חציונית ${esc(m.picture.luma_p50)} · רוויה ${esc(m.picture.saturation)}${m.picture.face ? ` · בהירות פנים ${esc(m.picture.face.luma)}` : ''}</li>` : ''}
      ${m.coverage ? `<li class="mute">כיסוי: ${esc(m.coverage.picture_frames)} פריימים (כל ${esc(m.coverage.picture_step_s)} שנ׳) · ${esc(m.coverage.audio)} · ${esc(m.coverage.motion)}</li>` : ''}</ul></div>`;
  }

  // ── Dana's review ──
  const draftNotes = {};           // what the owner typed and did not send yet, per project (kept across the page's own refreshes)
  const LV = { 'תקין': 'lv-ok', 'דורש שיפור': 'lv-mid', 'בעייתי': 'lv-bad', 'לא נבדק': 'lv-none' };
  const CST = { met: ['מתקיים', 'ok'], not_met: ['לא מתקיים', 'bad'], not_checked: ['לא נבדק', 'mute'], na: ['לא רלוונטי', 'mute'], uncertain: ['דורש האזנה שלך', 'warn'] };
  const BS = { measured: 'נמדד', frames: 'פריימים בודדים', model: 'הערכת מודל', human: 'דורש אותך', none: '—' };
  const IK = { technical_defect: ['פגם טכני', 'bad'], creative_preference: ['העדפה יצירתית', 'info'], content_decision: ['החלטת תוכן', 'warn'] };
  function panelReview() {
    const p = current, v = p.version, pkg = pkgOf(); if (!pkg) return noPkg('ביקורת דנה');
    const rv = pkg.danaReview, h = [];
    if (!rv) return `<div class="card"><h2>ביקורת דנה</h2><div class="mute">הגרסה הזו נערכה לפני שהביקורת לפי קטגוריות נוספה. גרסה חדשה תכלול אותה.</div></div>` + reviewItems(v, pkg);
    const cats = rv.categories, sel = cats.find(c => c.key === selCat) || null, imps = rv.improvements || [], can = imps.filter(i => i.can_apply).length + (pkg.danaCanApply || []).length;
    h.push(finalReviewCard(p, v, pkg));
    h.push(reviewInfoCard(p.review));
    h.push(`<div class="card" id="dreview"><h2>הביקורת של דנה — לפי קטגוריות</h2>
      <p class="small mute">${esc(rv.note)} <br>${esc(rv.perception)} · גרסת קריטריונים <code>${esc(rv.rubric_version)}</code></p>
      <div class="grid">${cats.map(c => `<button class="cat ${c.key === selCat ? 'sel' : ''}" data-cat="${c.key}"><b>${esc(c.label)}</b><span class="${LV[c.level]}">${esc(c.level)}</span>
        <div class="small mute">${c.decided ? `${c.met} מתוך ${c.decided} קריטריונים` : 'אין קריטריון שנבדק'}${c.not_checked ? ` · ${c.not_checked} לא נבדקו` : ''}</div></button>`).join('')}</div>
      ${sel ? `<h3>${esc(sel.label)} — הקריטריונים הקבועים</h3><ul class="plain">${sel.criteria.map(c => { const s = CST[c.status]; return `<li><div class="row"><span class="pill ${s[1]}">${s[0]}</span><span class="pill mute">${esc(BS[c.basis] || c.basis)}</span>
        ${isNum(c.time_s) && v.hasVideo ? `<button class="sm" data-play="${Math.max(0, c.time_s - 1).toFixed(2)},${(c.time_s + 2.5).toFixed(2)}" style="margin-inline-start:auto">▶ ${tfmt(c.time_s)}</button>` : ''}</div>
        <div>${esc(c.criterion)}</div><div class="small mute">${esc(c.note)}</div></li>`; }).join('')}</ul>` : '<p class="small mute">לחיצה על קטגוריה מציגה את הקריטריונים, הנימוק והראיות שלה.</p>'}</div>`);
    if (pkg.reviewVsPrevious) h.push(`<div class="card" id="rvcmp"><h2>השוואה לגרסה הקודמת (אותם קריטריונים)</h2><table class="cmp"><thead><tr><th>קטגוריה</th><th>קודם</th><th>עכשיו</th></tr></thead><tbody>
      ${pkg.reviewVsPrevious.map(r => `<tr><td>${esc(r.label)}</td><td class="${LV[r.before.level]}">${esc(r.before.level)} <span class="mute">${r.before.met}/${r.before.decided}</span></td><td class="${LV[r.after.level]}">${esc(r.after.level)} <span class="mute">${r.after.met}/${r.after.decided}</span></td></tr>`).join('')}</tbody></table></div>`);
    h.push(`<div class="card" id="improve"><h2>שיפורים לפי חשיבות (${imps.length + (pkg.danaCanApply || []).length})</h2>
      ${(pkg.danaCanApply || []).length ? `<ul class="plain">${pkg.danaCanApply.map(x => `<li><div class="row"><span class="pill bad">פגם טכני</span><span class="pill ok">דנה יכולה ליישם</span></div><div><b>${esc(x.what)}</b></div><div class="small mute">${esc(x.evidence)}</div></li>`).join('')}</ul>` : ''}
      <ul class="plain">${imps.map(i => { const k = IK[i.kind] || [i.kind, 'mute']; return `<li><div class="row"><span class="pill ${k[1]}">${k[0]}</span><span class="pill ${i.can_apply ? 'ok' : 'warn'}">${i.can_apply ? 'דנה יכולה ליישם' : 'דורש אותך'}</span>
        ${isNum(i.time_s) && v.hasVideo ? `<button class="sm" data-play="${Math.max(0, i.time_s - 1).toFixed(2)},${(i.time_s + 2.5).toFixed(2)}" style="margin-inline-start:auto">▶ ${tfmt(i.time_s)}</button>` : ''}</div>
        <div>${esc(i.problem)}</div><div class="small">→ ${esc(i.correction || i.how)}</div>${i.evidence ? `<div class="small mute">ראיה: ${esc(i.evidence)}</div>` : ''}</li>`; }).join('') || ((pkg.danaCanApply || []).length ? '' : '<li class="ok">לא נמצאו שיפורים נדרשים בקריטריונים שנבדקו.</li>')}</ul>
      <button class="primary" data-do="applyreview" style="margin-top:10px;width:100%" ${can && !busy() ? '' : 'disabled'}>יישם שיפורים והפק גרסה חדשה</button>
      <p class="small mute">${can ? `דנה תיישם בעצמה ${can} שיפורים שבתוך הכללים המאושרים. ספקות והחלטות שהיא לא יכולה לפתור נשארים אצלך.` : 'אין כאן שיפור שדנה יכולה ליישם בעצמה.'} ${v.kind === 'review_only' ? 'התוכן, החיתוך והכתוביות הצרובות של הסרטון שלך לא ישתנו.' : ''}</p></div>`);
    if (v.kind !== 'review_only') h.push(reviewItems(v, pkg));
    const ed = pkg.editorial, calls = (pkg.usage && pkg.usage.calls) || [];
    if (ed) { const STOP = { accepted: 'הביקורת הפנימית הסתיימה בלי ממצאים שדנה יכולה לתקן', locked_revision: 'תיקון ממוקד — דנה לא שינתה דבר שלא ביקשת', needs_owner: 'נשארו נושאים שדורשים אותך',
        no_progress: 'אותה תקלה חזרה אחרי תיקון — נעצר והועבר אלייך', cycle_limit: 'הגיע למגבלת הסבבים', budget: 'הגיע למגבלת הזמן או העלות', revision_regressed: 'תיקון החמיר את הבדיקות — הוחזרה הגרסה הקודמת', editor_failed: 'העורך נכשל בסבב התיקון', no_editor_model: 'בלי מודל עריכה' };
      h.push(`<div class="card" id="loop"><h2>סבבי העבודה של דנה</h2><ul class="plain small">
        <li>עריכה ← ביקורת ← תיקון ← בדיקה חוזרת: <b>${esc(ed.revisions)}</b> סבבי תיקון מתוך ${esc((ed.budget || {}).max_cycles)} מותרים</li>
        <li>למה נעצר: ${esc(STOP[ed.stop_reason] || ed.stop_reason || '—')}</li>
        <li>זמן: ${dur((ed.budget || {}).seconds)} מתוך ${dur((ed.budget || {}).max_total_s)} · עלות מדווחת: $${esc((ed.budget || {}).cost_usd_reported)} מתוך $${esc((ed.budget || {}).max_total_cost_usd)} <span class="mute">(חישוב לפי מחירון של ה-CLI, לא חשבונית)</span></li>
        <li>${calls.length} קריאות למודל, בלי כלים: ${esc([...new Set(calls.map(c => c.role))].join(' · '))}</li></ul>
        <details class="small"><summary>פירוט הסבבים</summary>${(ed.cycles || []).map(c => `<div style="margin-top:6px"><b>סבב ${c.cycle}</b>${c.reused_render ? ' · רק טקסטים השתנו' : ''}${c.rejected ? ' · <span class="bad">נדחה: החמיר את הבדיקות</span>' : ''}
          <ul class="plain">${c.findings.map(f => `<li><span class="pill ${f.severity === 'blocking' ? 'bad' : 'warn'}">${f.severity === 'blocking' ? 'חוסם' : 'המלצה'}</span> ${esc(f.problem)}<div class="mute">→ ${esc(f.correction)}</div></li>`).join('') || '<li class="ok">אין ממצאים</li>'}</ul>
          ${(c.verification_of_previous || []).length ? `<div class="mute">אימות תיקוני הסבב הקודם: ${c.verification_of_previous.filter(x => x.status === 'fixed').length}/${c.verification_of_previous.length} תוקנו</div>` : ''}</div>`).join('')}</details></div>`); }
    if (pkg.burnedInText && pkg.burnedInText.present) h.push(`<div class="card"><h2>כתוביות צרובות במקור</h2><p class="small">דנה זיהתה טקסט שצרוב בתמונה (${esc(pkg.burnedInText.basis || 'פריימים בודדים')}). היא לא מוסיפה שכבה כפולה ולא יכולה לתקן אותו.</p>
      <ul class="plain small">${(pkg.burnedInText.examples || []).map(x => `<li>${tfmt(x.t_s ?? x.source_t_s)}: ${esc(x.text)}</li>`).join('')}</ul></div>`);
    return h.join('');
  }
  function reviewItems(v, pkg) {
    const open = v.unresolved || [];
    const KIND = { timing: 'תזמון', text: 'איות', acoustic: 'שמיעה', technical: 'טכני', content: 'תוכן', editorial: 'עריכה' };
    const VERD = { suspected_false_positive: ['כנראה אזעקת שווא', 'info'], confirmed: ['כשל מאומת', 'bad'], needs_reading: ['לקרוא', 'warn'], needs_listening: ['להאזין', 'warn'], needs_decision: ['להחליט', 'warn'] };
    return `<div class="card" id="review"><h2>${open.length ? `<span class="bad">ספקות והחלטות שדנה מעבירה אלייך: ${open.length}</span>` : '<span class="ok">אין פריטים פתוחים שדורשים אותך</span>'}</h2>
      <ul class="plain">${open.map(u => { const vd = VERD[u.verdict] || ['לבדוק', 'warn']; return `<li><div class="row"><span class="pill mute">${esc(KIND[u.kind] || 'בדיקה')}</span><span class="pill ${vd[1]}">${vd[0]}</span>
        ${u.t0 != null ? `<button class="sm" data-play="${u.t0},${u.t1}" data-listen="h:${esc(u.id)}" style="margin-inline-start:auto">▶ להאזין ${Math.max(0.1, u.t1 - u.t0).toFixed(1)} שנ׳</button>` : ''}</div>
        <div><b>${esc(u.ask || '')}</b>${u.text ? ` <span class="mute">"${esc(u.text)}"</span>` : ''}</div><div class="small">${esc(u.original || u.summary || '')}</div>
        ${u.hearing_key ? `<div class="row" style="margin-top:6px"><button class="sm" data-hear="ok" data-id="${esc(u.id)}" ${listened['h:' + u.id] ? '' : 'disabled'}>שמעתי — תקין</button>
          <button class="sm" data-hear="wrong" data-id="${esc(u.id)}" ${listened['h:' + u.id] ? '' : 'disabled'}>שמעתי — לא תקין</button>
          <span class="small mute">${listened['h:' + u.id] ? 'ההכרעה נשמרת למקום הזה בהקלטה, ולא תישאל שוב בגרסה הבאה.' : 'קודם להאזין לקטע.'}</span></div>` : ''}
        ${u.explanation ? `<details class="small mute"><summary>ראיות</summary>${esc(u.explanation)}</details>` : ''}</li>`; }).join('')}</ul>
      ${open.length ? `<label class="chk"><input type="checkbox" id="watched"> צפיתי והקשבתי לכל הקטעים</label><input type="text" id="rnote" placeholder="הערה (לא חובה)" style="margin-top:8px">
        <button class="primary" data-do="confirm" style="margin-top:8px;width:100%">אישור כל הפריטים יחד</button>` : ''}
      ${(v.exceptions || []).length ? `<details class="small"><summary>פריטים שאושרו (${v.exceptions.length})</summary><ul class="plain">${v.exceptions.map(e => `<li><b>${esc(e.id)}</b> · ${esc(e.by)} · ${fmt(e.at)}<div class="quote">${esc(e.reason)}</div></li>`).join('')}</ul></details>` : ''}
      <details class="small"><summary>כל הבדיקות האוטומטיות (${(pkg.checks || []).length})</summary><ul class="plain">${(pkg.checks || []).map(c => { const m = { pass: ['עבר', 'ok'], fail: ['נכשל', 'bad'], warn: ['אזהרה', 'warn'], human_required: ['דורש אדם', 'info'], review: ['לבדיקה', 'warn'], info: ['מידע', 'mute'] }[c.status] || [c.status, 'mute'];
        return `<li><span class="pill ${m[1]}">${m[0]}</span> <b>${esc(c.id)}</b><div>${esc(c.summary)}</div></li>`; }).join('')}</ul></details>
      ${pkg.quality && (pkg.quality.not_verified || []).length ? `<details class="small"><summary>מה לא נבדק</summary><ul class="plain">${pkg.quality.not_verified.map(x => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}</div>`;
  }

  // ── Watch & approve ──
  function panelApprove() {
    const p = current, v = p.version, pkg = pkgOf(); if (!pkg) return noPkg('צפייה ואישור');
    if (v.kind === 'review_only') return reviewOnlyNote;
    const cj = v.contentJudgement || {}, blockers = [];
    if (p.pendingCorrections) blockers.push(`${p.pendingCorrections} תיקוני מלל נשמרו ועדיין לא בסרטון — יש להפיק גרסה לפני אישור`);
    if (v.unresolved.length) blockers.push(`${v.unresolved.length} פריטים פתוחים בשלב "ביקורת דנה"`);
    if (cj.missing && !cj.excepted) blockers.push('עריכה טכנית בלבד: שיפוט התוכן לא רץ');
    const pub = p.publication;
    return `<div class="card" id="approve"><h2>${v.approvalValid ? '<span class="ok">הגרסה מאושרת</span>' : `אישור גרסה ${v.n}`}</h2>
        ${v.approval ? `<div class="small mute">${esc(v.approval.by)} · ${fmt(v.approval.at)} · טביעת גרסה <code>${esc(v.approval.fingerprint.slice(0, 16))}…</code>${v.approvalValid ? '' : ' · <span class="bad">האישור אינו תקף — התוצר השתנה</span>'}</div>` : ''}
        <p class="small mute">האישור חל על הגרסה המדויקת הזו: סרטון, קאבר, קפשן, CTA, חשבון ומועד. כל שינוי באחד מהם מבטל אותו. אישור גרסה אינו פרסום.</p>
        ${blockers.length ? `<ul class="plain small">${blockers.map(b => `<li class="bad">${esc(b)}</li>`).join('')}</ul>` : ''}
        ${cj.missing && !cj.excepted ? `<button class="sm" data-ex="${esc(cj.exceptionId)}">תיעוד חריגה: בדקתי את התוכן בעצמי</button>` : ''}
        <div class="row" style="margin-top:8px"><button class="primary grow" data-do="approve" ${blockers.length || v.approvalValid ? 'disabled' : ''}>אשר את הגרסה הזו</button><button class="danger" data-do="reject">דחה</button></div></div>
      <div class="card"><h2>קאבר</h2>${pkg.cover ? `<img class="cover" alt="קאבר" src="${base()}/cover"><div class="small mute" style="margin-top:6px">טקסט: ${esc(pkg.cover.text || '— ללא —')}</div>` : ''}
        ${pub.coverNote ? `<div class="small warn">${esc(pub.coverNote)}</div>` : ''}</div>
      <div class="card"><h2>יעד ומועד</h2>
        <div class="small">קפשן: <span class="mute">${esc((v.caption.text || '').slice(0, 140))}${(v.caption.text || '').length > 140 ? '…' : ''}</span> <button class="sm" data-go="transcript">עריכה</button></div>
        <label for="acct">חשבון יעד · ${esc(v.destination.platform)} / ${esc(v.destination.format)}</label><input type="text" id="acct" value="${esc(v.destination.account || '')}" placeholder="לא נבחר חשבון יעד" dir="ltr">
        <label for="when">מועד ${v.scheduleProposed ? 'מוצע (ברירת מחדל טכנית, לא המלצה)' : ''} — שעון ישראל</label><input type="datetime-local" id="when" value="${esc(v.scheduledLocal || '')}">
        <button data-do="savedest" style="margin-top:10px">שמירה</button></div>
      <div class="card"><h2>פרסום</h2><div class="pill ${pub.mode ? 'warn' : 'mute'}">${pub.mode === 'instagram' ? 'ספק אינסטגרם מחובר' : pub.mode === 'mock' ? 'ספק דמה — לא פרסום אמיתי' : 'פרסום כבוי'}</div>
        <ul class="plain small">${(pub.blocked || []).map(b => `<li>${esc(b.message)}</li>`).join('')}</ul>
        <p class="small mute">שום דבר לא עולה ל-Meta ולא מתפרסם בלי אישור נפרד שלך. ההתראות האמיתיות כבויות.</p></div>`;
  }

  // ── Draft, preview ──
  function collect() {
    const pkg = pkgOf(), out = { zoom_edits: [], style_overrides: {}, adjustments: {} };
    for (const [id, z] of Object.entries(draft.zooms)) if (z.action === 'remove') out.zoom_edits.push({ id, action: 'remove' }); else if (z.action === 'set' && isNum(z.scale)) out.zoom_edits.push({ id, action: 'set', scale: z.scale });
    for (const [k, val] of Object.entries(draft.style)) if (val !== (pkg.style || {})[k]) out.style_overrides[k] = val;
    for (const [k, val] of Object.entries(draft.adjustments)) if (val !== ((current.adjustments || {})[k] !== false)) out.adjustments[k] = val;
    out.graphic_edits = Object.keys(draft.graphics || {}).map(id => ({ id, action: 'remove' }));
    return out;
  }
  function reviseSummary() {
    const c = collect(), parts = [];
    if (current.pendingCorrections) parts.push(`${current.pendingCorrections} תיקוני מלל שמורים`);
    if (Object.keys(c.style_overrides).length) parts.push('סגנון כתוביות');
    if (c.zoom_edits.length) parts.push(`${c.zoom_edits.length} שינויי זום`);
    if (c.graphic_edits.length) parts.push(`הסרת ${c.graphic_edits.length} רכיבי גרפיקה / אנימציה`);
    if (Object.keys(c.adjustments).length) parts.push('הפעלה/כיבוי: ' + Object.entries(c.adjustments).map(([k, on]) => `${(current.adjustmentKinds || {})[k] || k} ${on ? 'פעיל' : 'כבוי'}`).join(', '));
    if (draft.note.trim()) parts.push('בקשה חופשית');
    const text = parts.length ? 'ייכנסו לגרסה הבאה: ' + parts.join(' · ') + '. כל השאר נשאר כמו שהוא.' : 'עדיין לא סומן שינוי.';
    for (const id of ['#rvsum', '#stsum']) if ($(id)) $(id).textContent = text;
  }
  function loadPreviewSource(url) { if (pvSource && pvSource.tagName) return drawPreview(); const img = new Image(); img.onload = () => { pvSource = img; drawPreview(); }; img.src = url; }
  function drawPreview() {
    const cv = $('#pv'), pkg = pkgOf(); if (!cv || !pkg) return;
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, k = W / 1080, st = pkg.style || {}, val = key => draft.style[key] !== undefined ? draft.style[key] : st[key];
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    if (pvSource) { try { const sw = pvSource.videoWidth || pvSource.naturalWidth, sh = pvSource.videoHeight || pvSource.naturalHeight;
      if (sw && sh) { const sc = Math.max(W / sw, H / sh); g.drawImage(pvSource, (W - sw * sc) / 2, (H - sh * sc) / 2, sw * sc, sh * sc); } } catch (e) { /* frame not ready */ } }
    const size = (Number(val('caption_size')) || 76) * k, y = (Number(val('caption_y_px')) || 1250) * (H / 1920);
    const card = (pkg.cards || []).reduce((a, c) => (c.text.length > a.text.length ? c : a), (pkg.cards || [])[0] || { text: 'כתובית לדוגמה', highlight: [] });
    const words = card.text.split(/\s+/), lines = Number(val('caption_max_lines')) === 2 && words.length > 2 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [card.text];
    g.font = `800 ${size}px Heebo, "Segoe UI", system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.direction = 'rtl';
    const lh = size * 1.15, top = y - (lines.length - 1) * lh / 2, hl = val('highlight_enabled') !== false && (card.highlight || []).length;
    g.lineWidth = size * 0.12; g.strokeStyle = '#000'; g.lineJoin = 'round';
    lines.forEach((l, i) => { g.strokeText(l, W / 2, top + i * lh); g.fillStyle = hl && i === 0 ? (val('caption_highlight') || '#FFFF00') : (val('caption_ink') || '#F5F5F5'); g.fillText(l, W / 2, top + i * lh); });
    // the working safe zone
    g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1; g.setLineDash([4, 4]); g.strokeRect(60 * k, 230 * (H / 1920), (1080 - 60 - 230) * k, (1440 - 230) * (H / 1920)); g.setLineDash([]);
  }

  // ── Events ──
  $('#panel').addEventListener('input', e => {
    const t = e.target, d = t.dataset;
    // the feedback for the next version is kept per project until it is sent: an action on the page (asking for a rating,
    // settling a doubt) redraws the panel and must not wipe what was typed
    if (t.id === 'arnote' && current) { (draftNotes[current.id] = draftNotes[current.id] || {}).ar = t.value; return; }
    if (!draft) return;
    if (d.card) { draft.captions[Number(d.card)] = t.value; return; }
    if (d.style) { if (t.type === 'checkbox') draft.style[d.style] = t.checked; else draft.style[d.style] = Number(t.value);
      if (d.style === 'caption_size') $('#st_size_v').textContent = t.value; if (d.style === 'caption_y_px') $('#st_y_v').textContent = t.value; }
    else if (d.styles) draft.style[d.styles] = t.value;
    else if (d.stylec) draft.style[d.stylec] = t.value.toUpperCase();
    else if (d.zoom) { const sc = document.querySelector(`[data-zoomscale="${CSS.escape(d.zoom)}"]`); if (!t.value) delete draft.zooms[d.zoom]; else draft.zooms[d.zoom] = { action: t.value, scale: Number(sc.value) }; sc.disabled = t.value !== 'set'; }
    else if (d.zoomscale) { const z = draft.zooms[d.zoomscale]; if (z) z.scale = Number(t.value); }
    else if (d.adj) draft.adjustments[d.adj] = t.checked;
    else if (d.grm) { if (t.checked) draft.graphics[d.grm] = true; else delete draft.graphics[d.grm]; }
    else if (t.id === 'rvnote') draft.note = t.value;
    else if (t.name === 'rvscope') draft.scope = t.value;
    else return;
    reviseSummary(); drawPreview();
  });
  $('#panel').addEventListener('change', async e => { const t = e.target;
    if (t.id === 'pacct') return act('/settings', { account: t.value }, t.value ? `חשבון היעד של הפרויקט: @${t.value}` : 'חשבון היעד של הפרויקט נוקה.', 'PATCH');
    if (t.id === 'pskillsel') { if (t.value === 'set') { const ids = selItems(current.skill).map(x => x.id); if (!ids.length) { current.skill = { mode: 'set', items: [] }; $('#panel').__html = null; return renderPanel(); }
        return act('/settings', { skill: { mode: 'set', ids } }, 'בחירת הסקילים נשמרה.', 'PATCH'); }
      return act('/settings', { skill: { mode: t.value } }, 'בחירת הסקיל נשמרה. היא תחול מהגרסה הבאה.', 'PATCH'); }
    if (t.dataset.pskill) { let ids = selItems(current.skill).map(x => x.id).filter(x => x !== t.dataset.pskill); if (t.checked) ids.push(t.dataset.pskill);
      if (!ids.length) return act('/settings', { skill: { mode: 'default' } }, 'לא נשאר סקיל מסומן — חזרה לברירת המחדל.', 'PATCH');
      return act('/settings', { skill: { mode: 'set', ids } }, 'השילוב נשמר. הסדר שסימנת הוא סדר העדיפות.', 'PATCH'); }
    if (t.id === 'addsrc' || t.id === 'addmusic' || t.id === 'addnar') { const by = who(); if (!by) { t.value = ''; return; } const files = Array.from(t.files); t.value = '';
      const out = $('#addsrc_s');
      try { for (let i = 0; i < files.length; i++) { const fd = new FormData(); fd.append('by', by);
          if (t.id === 'addsrc') fd.append('video', files[i], files[i].name); else { fd.append('kind', t.id === 'addmusic' ? 'music' : 'narration'); fd.append('file', files[i], files[i].name); }
          await sendFile(`/projects/${current.id}/${t.id === 'addsrc' ? 'sources' : 'assets'}`, fd, (sent, total) => { if (out) out.textContent = `מעלה ${files[i].name}: ${(100 * sent / total).toFixed(0)}%`; }); }
        mediaDraft.audio = null; notice(t.id === 'addsrc' ? 'הקובץ נוסף לפרויקט. הוא ישמש בגרסה הבאה — "תכנן והפק מחדש מכל המקורות".' : t.id === 'addmusic' ? 'המוזיקה הועלתה. היא אינה מסומנת כמורשה עד שתאשר/י.' : 'הקריינות הועלתה.', 'ok'); await open(current.id); }
      catch (err) { notice(err.message, 'bad'); }
      return; }
    if (t.dataset.nscript) { const by = who(); if (!by) return; return act(`/assets/${t.dataset.nscript}/narration-info`, { by, is_script: t.checked }, 'נרשם.'); }
    if (t.id === 'mtype') return;
    if (t.id === 'panim') return act('/settings', { animation_scene: t.checked }, t.checked ? 'קטע אנימציה מותר בפרויקט הזה, מהגרסה הבאה.' : 'קטע אנימציה לא יתווסף בלי סקיל שמבקש אותו.', 'PATCH');
    if (t.dataset.zoom || t.dataset.style || t.dataset.styles || t.dataset.adj || t.name === 'rvscope') t.dispatchEvent(new Event('input', { bubbles: true })); });

  async function act(path, body, okMsg, method = 'POST') {
    try { const { project } = await api(`/projects/${current.id}${path}`, { method, body }); notice(okMsg, 'ok'); delete ui.view[project.id]; remember(); $$('#panel [data-dirty]').forEach(i => delete i.dataset.dirty); await open(project.id); }
    catch (e) { notice(e.message, 'bad'); if (e.data && e.data.error === 'fingerprint_mismatch') open(current.id); }
  }
  function play(t0, t1) {
    const vid = $('#mainvid'); if (!vid) return notice('אין סרטון לניגון בגרסה הזו.', 'warn');
    const stop = () => { if (vid.currentTime >= t1) { vid.pause(); vid.removeEventListener('timeupdate', stop); } };
    vid.addEventListener('timeupdate', stop); vid.currentTime = t0; vid.play().catch(() => {});
  }
  async function onClick(e) {
    const t = e.target.closest('button, [data-go]') || e.target, d = t.dataset || {};
    if (!current) return;
    if (d.go) { goStep(d.go); window.scrollTo({ top: 0 }); return; }
    if (d.open) return open(d.open);
    if (d.cat) { selCat = selCat === d.cat ? null : d.cat; ui.cat[current.id] = selCat; remember(); renderPanel(); return; }
    if (d.view) { if (d.view === 'current') delete ui.view[current.id]; else ui.view[current.id] = Number(d.view); remember(); cmpN = null; return open(current.id); }
    if (d.do === 'goskills') { back(); showHome('skills'); return; }
    const pid = current.id, by0 = () => who();
    if (d.do === 'startfiles') { const by = by0(); if (!by) return; return act('/start', { by }, 'העריכה נכנסה לתור עם כל הקבצים.'); }
    if (d.do === 'addsrc') return $('#addsrc').click();
    if (d.do === 'addmusic') return $('#addmusic').click();
    if (d.do === 'addnar') return $('#addnar').click();
    if (d.do === 'saveaudio') { const by = by0(); if (!by) return; mediaDraft.audio = null; return act('/audio', { by, ...readAudio() }, 'הגדרות המיקס נשמרו. הן ייכנסו לגרסה הבאה.', 'PATCH'); }
    if (d.do === 'remix') { const by = by0(); if (!by) return; const audio = readAudio(); mediaDraft.audio = null;
      return act('/revise', { by, audio }, 'גרסה חדשה עם המיקס הזה נכנסה לתור. החיתוך לא משתנה והגרסה הנוכחית נשמרת.'); }
    if (d.do === 'replan') { const by = by0(); if (!by) return; if (!confirm('לתכנן ולהפיק מחדש מכל המקורות? נוצרת גרסה חדשה; הגרסה הנוכחית נשמרת.')) return; const audio = readAudio();
      try { await api(`/projects/${pid}/audio`, { method: 'PATCH', body: { by, ...audio } }); } catch (e2) { return notice(e2.message, 'bad'); }
      mediaDraft.audio = null; return act('/replan', { by, project_type: $('#mtype') ? $('#mtype').value : undefined }, 'גרסה חדשה מכל המקורות נכנסה לתור.'); }
    if (d.markNow) { const vd = document.getElementById(d.v), inp = document.getElementById(d.markNow); if (vd && inp) { inp.value = vd.currentTime.toFixed(1); inp.dataset.dirty = '1'; } return; }
    if (d.markAdd || d.markDel !== undefined && d.markDel) { const by = by0(); if (!by) return; const sid = d.markAdd || d.markDel, src = current.media.sources.find(x => x.id === sid);
      let marks = src.marks.map(k => ({ from_s: k.from_s, to_s: k.to_s, kind: k.kind, note: k.note }));
      if (d.markDel) marks.splice(Number(d.i), 1);
      else marks.push({ from_s: Number($('#mf_' + sid).value), to_s: Number($('#mt_' + sid).value), kind: $('#mk_' + sid).value, note: $('#mn_' + sid).value });
      return act(`/sources/${sid}/marks`, { by, marks }, 'הסימון נשמר. הוא יחול בגרסה הבאה.', 'PATCH'); }
    if (d.srcDel) { const by = by0(); if (!by) return; if (!confirm('לא להשתמש בקובץ הזה בגרסאות הבאות? הקובץ עצמו והגרסאות שכבר נעשו איתו נשמרים.')) return;
      return act(`/sources/${d.srcDel}`, { by }, 'הקובץ לא ישמש גרסאות חדשות.', 'DELETE'); }
    if (d.lic) { const by = by0(); if (!by) return; const src = $('#lic_' + d.lic).value;
      return act(`/assets/${d.lic}/license`, { by, status: 'owner_confirmed', source: src }, 'הרישיון נרשם על שמך, עם המקור שכתבת.'); }
    if (d.segReplace || d.segRemove) { const by = by0(); if (!by) return; const n = Number(d.segReplace || d.segRemove);
      const e2 = d.segRemove ? { n, action: 'remove' } : { n, action: 'replace', source_id: $('#sr_src_' + n).value, from_s: Number($('#sr_a_' + n).value), to_s: Number($('#sr_b_' + n).value) };
      return act('/revise', { by, segment_edits: [e2] }, d.segRemove ? 'גרסה בלי הקטע הזה נכנסה לתור. שאר הקטעים לא משתנים.' : 'גרסה עם הקטע המוחלף נכנסה לתור. שאר הקטעים לא משתנים.'); }
    if (d.do === 'usealt') { const by = who(); if (!by) return; const a = ((current.version.package.readability || {}).alternatives || []).find(x => x.key === d.alt); if (!a) return;
      if (!confirm('להפיק גרסה חדשה עם "' + a.label + '"? זה שינוי לפרויקט הזה בלבד; הגרסה הנוכחית נשמרת להשוואה והסקיל לא משתנה.')) return;
      return act('/revise', { by, style_overrides: a.overrides }, 'גרסה עם החלופה הקריאה נכנסה לתור. הגרסה הנוכחית נשמרה.'); }
    if (d.do === 'applyskill') { const by = who(); if (!by) return;
      if (!confirm('להפיק גרסה חדשה של הפרויקט לפי הסקיל שנבחר? הגרסה הנוכחית נשמרת להשוואה, ואישור קודם מתבטל.')) return;
      const hard = (current.skillConflicts || []).some(c => c.kind === 'parameter');
      if (hard && !($('#pconfok') && $('#pconfok').checked)) return notice('יש סתירה בין הסקילים שנבחרו. יש לסמן שההכרעה המוצגת מקובלת, או לשנות את הבחירה.', 'warn');
      return act('/apply-skill', { by, confirm_conflicts: hard }, 'גרסה חדשה לפי הסקילים נכנסה לתור.'); }
    if (d.play) { const [t0, t1] = d.play.split(',').map(Number); const first = d.listen && !listened[d.listen]; if (d.listen) listened[d.listen] = true;
      if (first && d.listen.startsWith('h:')) { $('#panel').__html = null; renderPanel(); }
      return play(t0, t1); }
    if (d.hear) { const by = who(); if (!by) return;
      if (d.hear === 'wrong') return Promise.resolve(act('/hearing', { id: d.id, decision: 'wrong', by, listened: true }, 'נרשם שהכתובית אינה תואמת. הפריט נשאר פתוח — אפשר לתקן את המילים בשלב "תמלול".')).then(() => goStep('transcript'));
      return act('/hearing', { id: d.id, decision: 'ok', by, listened: true }, 'ההכרעה נשמרה. הפריט לא יישאל שוב בגרסה הבאה.'); }
    if (d.cmp) return showCompare(Number(d.cmp));
    if (d.do === 'cmpclose') { cmpN = null; $('#cmpbox').innerHTML = ''; return; }
    if (d.do === 'cmpsync') { const a = $('#mainvid'), b = $('#cmp'); if (a && b) { a.currentTime = 0; b.currentTime = 0; b.muted = true; a.play().catch(() => {}); b.play().catch(() => {}); } return; }
    if (d.do === 'gorefs') { back(); showHome('refs'); return; }
    if (d.verify) {
      const pkg = pkgOf(), c = pkg.cards.find(x => x.i === Number(d.verify)), sp = span(pkg, c), s = (current.cardStates || []).find(x => x.i === c.i) || {};
      const text = ($(`[data-card="${c.i}"]`).value || '').trim();
      if (!text) return notice('הכתובית ריקה.', 'warn');
      if (!listened[c.i]) return notice('אימות מלל נעשה אחרי האזנה: לחצ/י ▶ ליד הכתובית, הקשיב/י, ואז "אמת ושמור תיקון".', 'warn');
      const by = who(); if (!by) return;
      delete draft.captions[c.i];
      return act('/captions/verify', { source_start_s: sp[0], source_end_s: sp[1], original: s.original != null ? s.original : c.text, text, by, listened: true },
        text === (s.original != null ? s.original : c.text) ? 'הכתובית אומתה כפי שהיא.' : 'התיקון נשמר ואומת. הוא ייכנס לסרטון בגרסה הבאה ויישמר בכל הגרסאות שאחריה.');
    }
    if (d.do === 'rendercorr') { const by = who(); if (!by) return; return act('/revise', { by }, 'הגרסה עם התיקונים נכנסה לתור. רק הכתוביות שתיקנת ישתנו.'); }
    if (d.do === 'revise') {
      const c = collect(), note = draft.note.trim();
      if (!c.zoom_edits.length && !c.graphic_edits.length && !Object.keys(c.style_overrides).length && !Object.keys(c.adjustments).length && !note && !current.pendingCorrections) return notice('לא סומן שום שינוי.', 'warn');
      if (note && !draft.scope) return notice('יש לבחור: "תיקון לפרויקט הזה" או "כלל קבוע".', 'warn');
      const by = who(); if (!by) return;
      if (note && draft.scope === 'permanent' && !confirm('ההערה תישמר ככלל קבוע ותישלח לכל העריכות הבאות, בכל הפרויקטים. להמשיך?')) return;
      return act('/revise', { by, ...(c.zoom_edits.length ? { zoom_edits: c.zoom_edits } : {}), ...(Object.keys(c.style_overrides).length ? { style_overrides: c.style_overrides } : {}),
        ...(Object.keys(c.adjustments).length ? { adjustments: c.adjustments } : {}), ...(c.graphic_edits.length ? { graphic_edits: c.graphic_edits } : {}), ...(note ? { note, note_scope: draft.scope } : {}) }, 'הגרסה המתוקנת נכנסה לתור. הגרסה הקודמת נשמרה להשוואה.');
    }
    if (d.do === 'savebrief' || d.do === 'briefreplan') { const by = who(); if (!by) return;
      try { await api(`/projects/${current.id}/brief`, { method: 'PATCH', body: { by, ...readBrief() } }); }
      catch (e) { return notice('הכיוון לא נשמר: ' + e.message, 'bad'); }
      document.querySelectorAll('#brief [data-dirty]').forEach(i => delete i.dataset.dirty);
      if (d.do === 'savebrief') { await open(current.id, true); return notice('הכיוון נשמר. הוא ייכנס לגרסה הבאה; הגרסה הקיימת לא השתנתה.', 'ok'); }
      return act('/replan', { by }, 'דנה מתכננת ומפיקה מחדש לפי הכיוון שהגדרת. הגרסה הקודמת נשמרת.'); }
    if (d.do === 'rate') { const by = who(); if (!by) return;
      return act('/rating', { by, version: current.version.n }, 'התבקש דירוג של הקובץ הקיים. הסרטון לא משתנה ולא נוצרת גרסה חדשה.'); }
    if (d.do === 'applyreview') { const by = who(); if (!by) return;
      const note = ($('#arnote') ? $('#arnote').value : '').trim();
      if (!confirm('דנה תיישם בעצמה את השיפורים שבתוך הכללים המאושרים' + (note ? ' ואת המשוב שכתבת' : '') + ' ותפיק גרסה חדשה. הגרסה הנוכחית נשמרת להשוואה. להמשיך?')) return;
      if (draftNotes[current.id]) draftNotes[current.id].ar = '';
      return act('/apply-review', { by, ...(note ? { note } : {}) }, 'דנה מיישמת את השיפורים. הגרסה החדשה תופיע עם השוואה לקודמת ועם ביקורת משלה.'); }
    if (d.do === 'reviewtoskill') { const by = who(); if (!by) return;
      const sk = $('#arskill') ? $('#arskill').value : ''; if (!sk) return notice('אין סקיל מאושר לשדרג. יוצרים סקיל בלשונית "סקילים".', 'warn');
      try { await api(`/skills/${sk}/upgrade`, { method: 'POST', body: { by, feedback: { project_id: current.id, version: current.version.n, owner_feedback: ($('#arnote') ? $('#arnote').value : '').trim(), include_review: true } } }); }
      catch (e) { return notice('לא ניתן היה ליצור טיוטת שדרוג: ' + e.message, 'bad'); }
      return notice('נוצרה טיוטת שדרוג לסקיל, מהביקורת של דנה ומהמשוב שלך. היא מחכה בלשונית "סקילים" — שום דבר לא אושר ושום פרויקט לא השתנה.', 'ok'); }
    if (d.do === 'retry') return act('/retry', {}, 'חזר לתור. התמלול והקובץ שכבר הועלו נשמרים — אין עבודה כפולה.');
    if (d.do === 'savecap') return act('/package', { caption: $('#cap').value, cta: $('#cta').value }, 'הקפשן נשמר. אם היה אישור — הוא בוטל.', 'PATCH');
    if (d.do === 'savedest') return act('/package', { account: $('#acct').value, scheduledLocal: $('#when').value || null }, 'נשמר. אם היה אישור — הוא בוטל.', 'PATCH');
    if (d.do === 'pvframe') { const vid = $('#mainvid'); if (vid && vid.readyState >= 2) { pvSource = vid; drawPreview(); } else notice('הסרטון עדיין לא נטען — נגנ/י אותו רגע ונסה/י שוב.', 'warn'); return; }
    if (d.do === 'profile') { const by = who(); if (!by) return;
      if (!confirm('לשמור את הסגנון שבו נערכה הגרסה הזו כפרופיל מאושר וברירת מחדל לפרויקטים הבאים?')) return;
      return api(`/profiles/${encodeURIComponent(d.pid)}/approve`, { method: 'POST', body: { projectId: current.id, version: current.version.n, by } })
        .then(() => notice('הפרופיל אושר כברירת מחדל. הוא יישלח עם העריכות הבאות.', 'ok')).catch(err => notice(err.message, 'bad')); }
    if (d.do === 'confirm') { if (!$('#watched').checked) return notice('יש לסמן שצפית והקשבת לקטעים.', 'warn'); const by = who(); if (!by) return;
      return act('/review-confirm', { ids: current.version.unresolved.map(u => u.id), by, note: $('#rnote').value, watched: true }, 'כל הפריטים אושרו יחד ונרשמו.'); }
    if (d.do === 'approve') { const v = current.version, by = who(); if (!by) return;
      if (!confirm(`לאשר את גרסה ${v.n} בדיוק כפי שהיא? סרטון, קאבר, קפשן, יעד ומועד.\nאישור גרסה אינו פרסום.`)) return;
      return act('/approve', { fingerprint: v.fingerprint, by }, 'הגרסה אושרה. האישור תקף לגרסה הזו בלבד; פרסום הוא שלב נפרד.'); }
    if (d.do === 'reject') { const reason = prompt('סיבת הדחייה:'); if (reason === null) return; return act('/reject', { reason }, 'הגרסה נדחתה.'); }
    if (d.ex) { const reason = prompt('למה לאשר למרות זאת? (לפחות 10 תווים — נשמר בהיסטוריה)'); if (reason === null) return; const by = who(); if (!by) return; return act('/exceptions', { id: d.ex, reason, by }, 'החריגה תועדה.'); }
    if (d.consent) { const by = who(); if (!by) return; const note = prompt(d.consent === 'confirmed' ? 'איך ניתנה ההסכמה? (למשל: הודעת וואטסאפ מתאריך…)' : 'הערה (לא חובה):') ?? '';
      return act('/consent', { status: d.consent, note, by }, 'סטטוס ההסכמה תועד.'); }
  }
  $('#detail').addEventListener('click', onClick);
  $('#actions').addEventListener('click', onClick);

  showHome(ui.home);
  // a link from a notification names the exact version: "#<project>/v<n>"
  const [id, vHash] = location.hash.slice(1).split('/');
  if (id && /^v[0-9]+$/.test(vHash || '')) { ui.view[id] = Number(vHash.slice(1)); remember(); }
  (id ? open(id) : loadHome()).catch(e => notice(e.message, 'bad'));
  setInterval(() => { if (!current) loadHome().catch(e => refreshFailed(e)); }, 10000);
})();
