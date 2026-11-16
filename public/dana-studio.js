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

  let verOpen = false;
  let me = '', status = null, current = null, timer = null, step = 'project', stepFor = '', draft = null, draftKey = '', listened = {}, selCat = null, cmpN = null, pvSource = null;
  try { me = localStorage.getItem('dana_reviewer') || ''; } catch { /* private mode */ }
  const newDraft = () => ({ style: {}, zooms: {}, adjustments: {}, note: '', scope: '', captions: {} });

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
  $('#hometabs').onclick = e => { const k = e.target.dataset.home; if (!k) return;
    $$('#hometabs button').forEach(b => b.classList.toggle('on', b === e.target)); $$('[data-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== k)); };

  async function loadHome() {
    const [{ projects, worker }, st] = await Promise.all([api('/projects'), api('/status')]);
    status = st; workerPill(worker);
    $('#projects').innerHTML = projects.length ? projects.map(p => { const pr = p.progress;
      return `<li><button class="proj" data-id="${esc(p.id)}">
      <div class="row"><b class="grow">${esc(p.title)}</b>${p.kind === 'review_only' ? '<span class="pill mute">הועלה לביקורת</span>' : ''}${pill(p.status)}</div>
      <div class="small mute">${fmt(p.createdAt)} · גרסה ${p.currentVersion}${p.status === 'editing' && pr && pr.phase ? ` · ${esc(phaseLabel(pr.phase))}${isNum(pr.percent) ? ` · ${pr.percent}%${pr.percentBasis === 'estimated' ? ' (משוער)' : ''}` : ''}` : ''}</div>
      <div class="small">${esc(p.nextAction ? 'הפעולה הבאה: ' + p.nextAction.label : '')}</div></button></li>`; }).join('') : '<li class="mute">עדיין לא הועלה חומר.</li>';
    const accts = st.accounts || [];
    $('#upacct').innerHTML = accts.map(a => `<option value="${esc(a.username)}">@${esc(a.username)} — מחובר, אומת ${esc(a.verifiedAt)}</option>`).join('') + '<option value="">בלי חשבון יעד כרגע</option>';
    $('#accounts').innerHTML = accts.length ? accts.map(a => `<li><div class="row"><b class="grow" dir="ltr" style="text-align:right">@${esc(a.username)}</b><span class="pill ok">מחובר ✓ אומת ${esc(a.verifiedAt)}</span></div>
      <div class="small mute">${esc(a.platform)} · ${esc(a.how)}</div></li>`).join('') : '<li class="mute">אין חשבון מחובר.</li>';
    $('#profnow').textContent = st.defaultProfile ? `${st.defaultProfile.id} · גרסה ${st.defaultProfile.version} (אושר על ידך)` : 'לא אושר פרופיל — העובד משתמש בפרופיל המובנה שלו, שאינו מאושר';
    if (!worker.online && projects.some(p => p.status === 'editing')) notice('עובד העריכה במחשב לא מחובר. העבודות ממתינות בתור וימשיכו כשהוא יחזור.', 'warn');
    loadBrand().catch(() => {}); loadRules().catch(() => {}); loadRefs().catch(() => {});
  }
  const phaseLabel = k => ((status && status.phases) || []).reduce((a, [key, l]) => key === k ? l : a, k);

  // ── Brand settings: edit, never invent ──
  async function loadBrand() {
    const { brand } = await api('/brand');
    $('#brand').innerHTML = Object.entries(brand).map(([k, v]) => `<li data-field="${esc(k)}">
      <div class="row"><b class="grow">${esc(v.label)}</b><span class="pill ${v.status === 'set' ? 'ok' : 'warn'}">${v.status === 'set' ? 'הוגדר' : 'חסר'}</span></div>
      <textarea data-brand="${esc(k)}" style="min-height:44px" placeholder="לא הוגדר — דנה לא תמציא">${esc(v.value == null ? '' : typeof v.value === 'string' ? v.value : JSON.stringify(v.value))}</textarea>
      <div class="row"><span class="small mute grow">${v.source ? 'מקור: ' + esc(v.source) : ''}</span><button class="sm" data-brandsave="${esc(k)}">שמירה</button></div></li>`).join('');
  }
  $('#brand').onclick = async e => {
    const k = e.target.dataset.brandsave; if (!k) return;
    const by = who(); if (!by) return;
    const val = $(`[data-brand="${k}"]`).value.trim().replace(k === 'instagram_account' ? /^@/ : /^$/, '');
    try { await api('/brand/' + k, { method: 'PUT', body: { value: val, by } }); await loadBrand(); notice(val ? 'ההגדרה נשמרה. היא תיכנס לעריכות הבאות.' : 'ההגדרה נמחקה ומסומנת כחסרה.', 'ok'); } catch (err) { notice(err.message, 'bad'); }
  };

  // ── Standing rules ──
  let rulesNow = [];
  async function loadRules() {
    const { rules } = await api('/rules'); rulesNow = rules.filter(r => r.status === 'active');
    $('#rules').innerHTML = rulesNow.length ? rulesNow.map(r => { const src = r.source || {}; return `<li><div class="row"><span class="grow">${esc(r.text)}</span><span class="pill mute">גרסה ${esc(r.version ?? 1)}</span></div>
      <div class="small mute">מקור: ${src.project_title ? `פרויקט "${esc(src.project_title)}"${src.version_n ? ' · גרסה ' + esc(src.version_n) : ''}` : 'לא נרשם'} · ${esc(src.by ?? r.by ?? '')} · ${fmt(src.at ?? r.at)}</div>
      <div class="row" style="margin-top:6px"><button class="sm" data-ruleedit="${esc(r.id)}">עריכת הנוסח</button><button class="sm danger" data-rule="${esc(r.id)}">הסר כלל</button></div></li>`; }).join('')
      : '<li class="mute">אין כללים קבועים.</li>';
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
    const f = $('#file').files[0]; if (!f) return;
    const fd = new FormData(); fd.append('video', f, f.name);
    fd.append('options', JSON.stringify({ kind: upKind, ...($('#upacct').value ? { account: $('#upacct').value } : {}) }));
    $('#upbox').classList.remove('hidden'); $('#pickraw').disabled = $('#pickreview').disabled = true;
    try {
      const j = await sendFile('/upload', fd, (sent, total, sec) => { const pct = 100 * sent / total;
        $('#upbar').style.width = pct.toFixed(1) + '%'; $('#uppct').textContent = pct.toFixed(pct < 100 ? 1 : 0) + '%';
        $('#upstate').textContent = `${mb(sent)} מתוך ${mb(total)}MB${sec > 1 ? ' · ' + (sent / 1048576 / sec).toFixed(1) + 'MB/שנ׳' : ''}${pct >= 100 ? ' · השרת מאמת את הקובץ…' : ''}`; });
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
    $('#refs').innerHTML = references.length ? references.map(r => {
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
        ${r.file && !['analysing', 'awaiting_analysis'].includes(r.status) ? `<button class="sm" data-refagain="${esc(r.id)}">נתח שוב</button>` : ''}<button class="sm danger" data-refdel="${esc(r.id)}">מחיקה</button></div></li>`; }).join('') : '<li class="mute">עדיין לא נוסף רפרנס.</li>';
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

  // ═══ PROJECT ══════════════════════════════════════════════════════════════
  const STEPS = [['project', 'פרויקט'], ['transcript', 'תמלול'], ['style', 'סגנון ורפרנסים'], ['edit', 'עריכה'], ['review', 'ביקורת דנה'], ['approve', 'צפייה ואישור']];
  const base = () => `${API}/projects/${current.id}/versions/${current.version ? current.version.n : 0}`;
  const pkgOf = () => current && current.version && current.version.package;
  const busy = () => current && current.job && ['queued', 'leased'].includes(current.job.status);

  async function open(id, quiet) {
    clearTimeout(timer);
    try {
      const { project, worker } = await api('/projects/' + id);
      if (!status) status = await api('/status');
      const changed = !current || current.id !== project.id || current.currentVersion !== project.currentVersion || current.status !== project.status
        || current.pendingCorrections !== project.pendingCorrections || JSON.stringify(current.cardStates) !== JSON.stringify(project.cardStates);
      const typing = document.activeElement && ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement.tagName) && $('#panel').contains(document.activeElement);
      current = project; workerPill(worker);
      $('#home').classList.add('hidden'); $('#detail').classList.remove('hidden'); $('#back').classList.remove('hidden');
      $('#title').textContent = project.title;
      if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
      const key = `${project.id}:${project.currentVersion}`;
      if (key !== draftKey) { draft = newDraft(); draftKey = key; listened = {}; selCat = null; cmpN = null; pvSource = null; }
      if (stepFor !== key + project.status) { step = defaultStep(project); stepFor = key + project.status; }
      renderSide(worker, quiet && !changed);
      if (!(quiet && !changed && typing)) { renderSteps(); if (!(quiet && !changed)) renderPanel(); }
      renderActions();
      if (busy()) timer = setTimeout(() => open(id, true), 3000);
    } catch (e) { notice(e.message, 'bad'); }
  }
  function defaultStep(p) {
    const k = p.nextAction && p.nextAction.key;
    if (!p.version || !p.version.package) return 'project';
    return { render_corrections: 'transcript', apply_review: 'review', review_items: 'review', revise: 'edit', watch_approve: 'approve', approved: 'approve' }[k] || 'project';
  }
  function back() { clearTimeout(timer); current = null; history.replaceState(null, '', location.pathname + location.search); $('#detail').classList.add('hidden'); $('#actions').classList.add('hidden');
    $('#back').classList.add('hidden'); $('#home').classList.remove('hidden'); $('#title').textContent = '🎬 דנה סטודיו'; loadHome().catch(e => notice(e.message, 'bad')); }
  $('#back').onclick = back;
  $('#projects').onclick = e => { const b = e.target.closest('[data-id]'); if (b) { notice(''); open(b.dataset.id); } };

  // ── Side: player, worker state, stage, progress, versions, next action ──
  function renderSide(worker, statusOnly) {
    const p = current, v = p.version, pr = p.progress;
    const vd = document.querySelector('#versions details'); if (vd) verOpen = vd.open;
    if (!statusOnly || !$('#playerbox')) {
      $('#side').innerHTML = `<div class="card" id="playerbox">${v && v.hasVideo ? `<video id="mainvid" controls playsinline preload="metadata" ${v.hasCover ? `poster="${base()}/cover"` : ''} src="${base()}/video"></video>
          <div class="small mute" style="margin-top:6px">גרסה ${v.n}${v.kind === 'review_only' ? ' · הסרטון שהעלית (לא נערך)' : ''}${v.package ? ' · ' + tfmt(v.package.duration) : ''}</div>`
          : '<div class="mute" style="padding:30px 0;text-align:center">הסרטון יופיע כאן כשהחבילה תהיה מוכנה לצפייה.</div>'}
          <div id="cmpbox"></div></div><div id="statusbox"></div>`;
    }
    const h = [];
    h.push(`<div class="card next"><div class="small mute">הפעולה הבאה</div><b>${esc(p.nextAction ? p.nextAction.label : '—')}</b></div>`);
    if (pr && (busy() || ['failed', 'waiting'].includes((p.job || {}).status))) {
      h.push(`<div class="card" id="progress"><div class="row"><h2 class="grow">${p.job.status === 'queued' ? 'ממתין בתור' : p.job.status === 'leased' ? 'דנה עובדת' : p.job.status === 'failed' ? '<span class="bad">נכשל</span>' : '<span class="warn">ממתין</span>'}</h2>
          ${isNum(pr.percent) ? `<b>${pr.percent}%</b>${pr.percentBasis === 'estimated' ? '<span class="pill warn">משוער</span>' : ''}` : ''}</div>
        <div class="phases">${pr.phases.map(x => `<span class="${x.state}">${esc(x.label)}</span>`).join('')}</div>
        ${isNum(pr.percent) ? `<div class="bar"><i style="width:${pr.percent}%"></i></div><div class="small mute">${esc(pr.percentNote || '')}</div>` : '<div class="small mute">אין מדידה לאחוז בשלב הזה — מוצגים שלב, זמן שחלף ועדכון אחרון.</div>'}
        <ul class="plain small"><li>שלב נוכחי: <b>${esc(pr.note || pr.stage || '—')}</b>${isNum(pr.stageElapsedS) ? ` · ${dur(pr.stageElapsedS)} בשלב הזה` : ''}</li>
          <li>זמן שחלף: ${dur(pr.elapsedS)} · עדכון אחרון מהעובד: לפני ${dur(pr.sinceUpdateS)}</li>
          <li>ניסיון ${pr.attempts || 1} מתוך ${pr.maxAttempts}${worker && !worker.online ? ' · <span class="bad">העובד לא מחובר — ימשיך כשיחזור</span>' : ''}</li></ul>
        ${p.job.error ? `<div class="bad">${esc(p.job.error.message)}</div><div class="small mute">קוד: ${esc(p.job.error.code)}</div>
          <button data-do="retry" class="primary" style="margin-top:8px;width:100%">נסה שוב</button><div class="small mute">ניסיון חוזר לא מתמלל מחדש ולא מעלה שוב: התמלול וקובץ המקור נשמרים.</div>` : ''}</div>`);
    }
    if (p.versions.length) h.push(`<div class="card" id="versions"><details ${window.innerWidth >= 980 || verOpen ? 'open' : ''}><summary><b>גרסאות (${p.versions.length})</b></summary><ul class="plain">${p.versions.map(x => `<li><div class="row"><b>גרסה ${x.n}</b>${pill(x.status)}${x.n === p.currentVersion ? '<span class="pill info">נוכחית</span>' : ''}${x.approved ? '<span class="pill ok">מאושרת</span>' : ''}
        ${x.hasVideo && x.n !== p.currentVersion ? `<button class="sm" data-cmp="${x.n}" style="margin-inline-start:auto">▶ השוואה</button>` : ''}</div>
        <div class="small mute">${fmt(x.createdAt)}${x.kind === 'review_only' ? ' · הסרטון שהעלית' : ''}${x.appliedReview ? ' · אחרי יישום שיפורי הביקורת' : ''}${x.revisionMode === 'locked_to_previous_plan' ? ' · תיקון ממוקד' : x.revisionMode === 'replanned' ? ' · תוכנן מחדש' : ''}${x.changeRequest ? ' · "' + esc(x.changeRequest) + '"' : ''}</div></li>`).join('')}</ul>
      <p class="small mute">גרסאות לא נמחקות. אישור חל רק על הגרסה הנוכחית, וכל שינוי בתוצר מבטל אישור קודם.</p></details></div>`);
    $('#statusbox').innerHTML = h.join('');
    if (cmpN && !$('#cmpbox').innerHTML) showCompare(cmpN);
  }
  function showCompare(n) {
    cmpN = n;
    $('#cmpbox').innerHTML = `<label>גרסה ${n} — להשוואה</label><video id="cmp" controls playsinline preload="metadata" src="${API}/projects/${current.id}/versions/${n}/video"></video>
      <div class="row" style="margin-top:6px"><button class="sm" data-do="cmpsync">▶ נגן את שתיהן יחד</button><button class="sm" data-do="cmpclose">סגירה</button></div>`;
  }

  function renderSteps() {
    const p = current, dots = { transcript: p.pendingCorrections > 0, review: p.version && (p.version.unresolved || []).length > 0 };
    $('#steps').innerHTML = STEPS.map(([k, l], i) => `<button data-step="${k}" class="${k === step ? 'on' : ''}"><span class="n">${i + 1}</span>${l}${dots[k] ? '<span class="dot"></span>' : ''}</button>`).join('');
  }
  $('#steps').onclick = e => { const b = e.target.closest('[data-step]'); if (!b) return; step = b.dataset.step; renderSteps(); renderPanel(); $('#steps').scrollIntoView({ block: 'nearest' }); };

  function renderActions() {
    const p = current, v = p.version, pkg = pkgOf(), k = p.nextAction && p.nextAction.key, b = [];
    if (k === 'retry') b.push('<button class="primary" data-do="retry">נסה שוב</button>');
    if (k === 'render_corrections') b.push(`<button class="primary" data-do="rendercorr">הפק גרסה עם ${p.pendingCorrections} התיקונים</button>`);
    if (k === 'apply_review') b.push('<button class="primary" data-do="applyreview">יישם שיפורים והפק גרסה חדשה</button>');
    if (k === 'review_items') b.push('<button class="primary" data-go="review">לפריטים הפתוחים</button>');
    if (pkg && v.kind !== 'review_only' && ['ready_for_review', 'approved'].includes(v.status) && !busy()) {
      const blocked = v.unresolved.length > 0 || v.approvalValid || (v.contentJudgement && v.contentJudgement.missing && !v.contentJudgement.excepted) || p.pendingCorrections > 0;
      b.push(`<button ${k === 'watch_approve' ? 'class="primary"' : ''} data-do="approve" ${blocked ? 'disabled' : ''}>${v.approvalValid ? 'הגרסה מאושרת' : 'אשר גרסה ' + v.n}</button>`);
      b.push('<button data-go="edit">בקש תיקון</button>');
    }
    $('#actions').innerHTML = b.join(''); $('#actions').classList.toggle('hidden', !b.length);
  }

  // ── Panels ──
  function renderPanel() {
    const fn = { project: panelProject, transcript: panelTranscript, style: panelStyle, edit: panelEdit, review: panelReview, approve: panelApprove }[step];
    $('#panel').innerHTML = fn();
    if (step === 'style' && pkgOf()) loadPreviewSource(base() + '/cover');
    if (step === 'edit') reviseSummary();
  }
  const noPkg = what => `<div class="card"><h2>${what}</h2><div class="mute">${busy() ? 'דנה עדיין עובדת. השלב הזה ייפתח כשהחבילה תהיה מוכנה לצפייה.' : 'אין עדיין חבילה בגרסה הזו.'}</div></div>`;
  const reviewOnlyNote = '<div class="card"><div class="pill info">סרטון שהועלה לביקורת בלבד</div><p class="small mute">דנה לא ערכה את הסרטון הזה. כדי לקבל גרסה משופרת שלו: שלב "ביקורת דנה" ← "יישם שיפורים והפק גרסה חדשה".</p></div>';

  function panelProject() {
    const p = current, c = p.consent, cs = { unknown: ['לא תועדה', 'warn'], confirmed: ['אושרה', 'ok'], denied: ['סירוב', 'bad'] }[c.status], accts = (status && status.accounts) || [];
    const H = { uploaded: 'הועלה', duplicate_upload: 'העלאה כפולה זוהתה', edit_queued: 'עריכה נכנסה לתור', review_queued: 'הוגש לביקורת דנה', review_ready: 'הביקורת מוכנה', job_leased: 'העובד התחיל', job_released: 'הוחזר לתור',
      job_failed: 'נכשל', package_ready: 'חבילה מוכנה', package_edited: 'החבילה נערכה', approval_invalidated: 'האישור בוטל', approved: 'אושר', changes_requested: 'התבקשו שינויים',
      revision_requested: 'התבקשה גרסה מתוקנת', apply_review_requested: 'התבקש יישום שיפורי הביקורת', caption_verified: 'כתובית אומתה', settings_changed: 'הגדרות הפרויקט שונו', rejected: 'נדחה',
      consent_recorded: 'הסכמה תועדה', exception_recorded: 'חריגה תועדה', review_confirmed: 'פריטי הבדיקה אושרו' };
    return `<div class="card"><h2>הפרויקט</h2>
        <div class="row">${pill(p.status)}<span class="pill mute">${p.kind === 'review_only' ? 'סרטון ערוך שהועלה לביקורת' : 'חומר גלם לעריכה'}</span></div>
        <div class="small mute" style="margin-top:6px">קובץ המקור: ${esc(p.source.originalName)} · ${mb(p.source.bytes)}MB · <code>${esc(p.source.sha256.slice(0, 12))}…</code> · נשמר כמו שהוא</div>
        <label for="pacct">חשבון יעד לפרויקט</label>
        <select id="pacct">${accts.map(a => `<option value="${esc(a.username)}" ${p.account === a.username ? 'selected' : ''}>@${esc(a.username)} — מחובר ✓ אומת ${esc(a.verifiedAt)}</option>`).join('')}<option value="" ${p.account ? '' : 'selected'}>ברירת המחדל של המותג / לא נבחר</option></select>
        <div class="small mute">בחירת חשבון אינה פרסום. פרסום כבוי ונשאר מאחורי אישור נפרד שלך.</div></div>
      <div class="card"><h2>הסכמה וזכויות</h2>
        <div class="row"><span class="grow">הסכמת המצולמים לפרסום</span><span class="pill ${cs[1]}">${cs[0]}</span></div>
        ${c.by ? `<div class="small mute">${esc(c.by)} · ${fmt(c.at)}${c.note ? ' · ' + esc(c.note) : ''}</div>` : ''}
        <div class="row" style="margin-top:8px"><button class="sm" data-consent="confirmed">תיעוד הסכמה</button><button class="sm danger" data-consent="denied">אין הסכמה</button></div>
        <div class="row" style="margin-top:10px"><span class="grow">מוזיקה</span><span class="pill ok">ללא מוזיקה</span></div></div>
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
          <li>פרופיל: <b>${esc(ru.profile.id)}</b> · גרסה ${esc(ru.profile.version)} · ${ru.profile.status === 'owner_approved' ? '<span class="pill ok">אושר על ידך</span>' : '<span class="pill warn">מובנה — לא אושר</span>'} · <code>${esc(String(ru.profile.sha256 || '').slice(0, 12))}</code></li>
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
  const ADJ_ORDER = ['color', 'audio_cleanup', 'zooms', 'caption_animation', 'graphics'];
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
    if (Array.isArray(pkg.graphics)) h.push(`<div class="card" id="graphics"><h2>מואושן גרפיק (${pkg.graphics.length})</h2>
      ${pkg.graphics.length ? `<ul class="plain">${pkg.graphics.map(g => `<li><div class="row"><button class="sm" data-play="${Math.max(0, g.tl_start_s - 0.5).toFixed(2)},${(g.tl_end_s + 0.5).toFixed(2)}">▶ ${tfmt(g.tl_start_s)}–${tfmt(g.tl_end_s)}</button><span class="pill info">${esc(g.label)}</span><span class="pill ok">ציטוט מדויק</span></div>
        <div><b>${esc(g.text)}</b></div><div class="small">התפקיד: ${esc(g.reason || '—')}</div></li>`).join('')}</ul>
        <div class="small mute">רונדר ב-${esc((adj && adj.graphics && adj.graphics.engine) || 'HyperFrames')} כשכבה שקופה, והורכב על הסרטון. נבדק שהוא בקובץ הסופי, באזור הבטוח ולא על הפנים.</div>`
        : '<div class="mute">בגרסה הזו אין מואושן גרפיק. דנה מוסיפה גרפיקה רק כשיש לה תפקיד בתוכן.</div>'}
      ${pl && (pl.graphics_not_used || []).length ? `<details class="small" open><summary>גרפיקה שתוכננה ולא נכנסה (${pl.graphics_not_used.length})</summary><ul class="plain">${pl.graphics_not_used.map(g => `<li>"${esc(g.quote)}": ${esc(g.why)}</li>`).join('')}</ul></details>` : ''}</div>`);
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
        <h3>מואושן גרפיק</h3>${tog('graphics')}</div>`);
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
  const LV = { 'תקין': 'lv-ok', 'דורש שיפור': 'lv-mid', 'בעייתי': 'lv-bad', 'לא נבדק': 'lv-none' };
  const CST = { met: ['מתקיים', 'ok'], not_met: ['לא מתקיים', 'bad'], not_checked: ['לא נבדק', 'mute'], na: ['לא רלוונטי', 'mute'] };
  const BS = { measured: 'נמדד', frames: 'פריימים בודדים', model: 'הערכת מודל', human: 'דורש אותך', none: '—' };
  const IK = { technical_defect: ['פגם טכני', 'bad'], creative_preference: ['העדפה יצירתית', 'info'], content_decision: ['החלטת תוכן', 'warn'] };
  function panelReview() {
    const p = current, v = p.version, pkg = pkgOf(); if (!pkg) return noPkg('ביקורת דנה');
    const rv = pkg.danaReview, h = [];
    if (!rv) return `<div class="card"><h2>ביקורת דנה</h2><div class="mute">הגרסה הזו נערכה לפני שהביקורת לפי קטגוריות נוספה. גרסה חדשה תכלול אותה.</div></div>` + reviewItems(v, pkg);
    const cats = rv.categories, sel = cats.find(c => c.key === selCat) || null, imps = rv.improvements || [], can = imps.filter(i => i.can_apply).length + (pkg.danaCanApply || []).length;
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
        <li>עריכה ← ביקורת ← תיקון ← בדיקה חוזרת: <b>${esc(ed.revisions)}</b> סבבי תיקון מתוך ${esc(ed.budget.max_cycles)} מותרים</li>
        <li>למה נעצר: ${esc(STOP[ed.stop_reason] || ed.stop_reason || '—')}</li>
        <li>זמן: ${dur(ed.budget.seconds)} מתוך ${dur(ed.budget.max_total_s)} · עלות מדווחת: $${esc(ed.budget.cost_usd_reported)} מתוך $${esc(ed.budget.max_total_cost_usd)} <span class="mute">(חישוב לפי מחירון של ה-CLI, לא חשבונית)</span></li>
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
        ${u.t0 != null ? `<button class="sm" data-play="${u.t0},${u.t1}" style="margin-inline-start:auto">▶ ${u.t0}s</button>` : ''}</div>
        <div><b>${esc(u.ask || '')}</b>${u.text ? ` <span class="mute">"${esc(u.text)}"</span>` : ''}</div><div class="small">${esc(u.original || u.summary || '')}</div>
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
    return out;
  }
  function reviseSummary() {
    const c = collect(), parts = [];
    if (current.pendingCorrections) parts.push(`${current.pendingCorrections} תיקוני מלל שמורים`);
    if (Object.keys(c.style_overrides).length) parts.push('סגנון כתוביות');
    if (c.zoom_edits.length) parts.push(`${c.zoom_edits.length} שינויי זום`);
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
    const t = e.target, d = t.dataset; if (!draft) return;
    if (d.card) { draft.captions[Number(d.card)] = t.value; return; }
    if (d.style) { if (t.type === 'checkbox') draft.style[d.style] = t.checked; else draft.style[d.style] = Number(t.value);
      if (d.style === 'caption_size') $('#st_size_v').textContent = t.value; if (d.style === 'caption_y_px') $('#st_y_v').textContent = t.value; }
    else if (d.styles) draft.style[d.styles] = t.value;
    else if (d.stylec) draft.style[d.stylec] = t.value.toUpperCase();
    else if (d.zoom) { const sc = document.querySelector(`[data-zoomscale="${CSS.escape(d.zoom)}"]`); if (!t.value) delete draft.zooms[d.zoom]; else draft.zooms[d.zoom] = { action: t.value, scale: Number(sc.value) }; sc.disabled = t.value !== 'set'; }
    else if (d.zoomscale) { const z = draft.zooms[d.zoomscale]; if (z) z.scale = Number(t.value); }
    else if (d.adj) draft.adjustments[d.adj] = t.checked;
    else if (t.id === 'rvnote') draft.note = t.value;
    else if (t.name === 'rvscope') draft.scope = t.value;
    else return;
    reviseSummary(); drawPreview();
  });
  $('#panel').addEventListener('change', e => { const t = e.target;
    if (t.id === 'pacct') return act('/settings', { account: t.value }, t.value ? `חשבון היעד של הפרויקט: @${t.value}` : 'חשבון היעד של הפרויקט נוקה.', 'PATCH');
    if (t.dataset.zoom || t.dataset.style || t.dataset.styles || t.dataset.adj || t.name === 'rvscope') t.dispatchEvent(new Event('input', { bubbles: true })); });

  async function act(path, body, okMsg, method = 'POST') {
    try { const { project } = await api(`/projects/${current.id}${path}`, { method, body }); notice(okMsg, 'ok'); await open(project.id); }
    catch (e) { notice(e.message, 'bad'); if (e.data && e.data.error === 'fingerprint_mismatch') open(current.id); }
  }
  function play(t0, t1) {
    const vid = $('#mainvid'); if (!vid) return notice('אין סרטון לניגון בגרסה הזו.', 'warn');
    const stop = () => { if (vid.currentTime >= t1) { vid.pause(); vid.removeEventListener('timeupdate', stop); } };
    vid.addEventListener('timeupdate', stop); vid.currentTime = t0; vid.play().catch(() => {});
  }
  function onClick(e) {
    const t = e.target.closest('button, [data-go]') || e.target, d = t.dataset || {};
    if (!current) return;
    if (d.go) { step = d.go; renderSteps(); renderPanel(); window.scrollTo({ top: 0 }); return; }
    if (d.cat) { selCat = selCat === d.cat ? null : d.cat; renderPanel(); const el = $('#dreview'); if (el) el.scrollIntoView({ block: 'nearest' }); return; }
    if (d.play) { const [t0, t1] = d.play.split(',').map(Number); if (d.listen) listened[d.listen] = true; return play(t0, t1); }
    if (d.cmp) return showCompare(Number(d.cmp));
    if (d.do === 'cmpclose') { cmpN = null; $('#cmpbox').innerHTML = ''; return; }
    if (d.do === 'cmpsync') { const a = $('#mainvid'), b = $('#cmp'); if (a && b) { a.currentTime = 0; b.currentTime = 0; b.muted = true; a.play().catch(() => {}); b.play().catch(() => {}); } return; }
    if (d.do === 'gorefs') { back(); $('[data-home="refs"]').click(); return; }
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
      if (!c.zoom_edits.length && !Object.keys(c.style_overrides).length && !Object.keys(c.adjustments).length && !note && !current.pendingCorrections) return notice('לא סומן שום שינוי.', 'warn');
      if (note && !draft.scope) return notice('יש לבחור: "תיקון לפרויקט הזה" או "כלל קבוע".', 'warn');
      const by = who(); if (!by) return;
      if (note && draft.scope === 'permanent' && !confirm('ההערה תישמר ככלל קבוע ותישלח לכל העריכות הבאות, בכל הפרויקטים. להמשיך?')) return;
      return act('/revise', { by, ...(c.zoom_edits.length ? { zoom_edits: c.zoom_edits } : {}), ...(Object.keys(c.style_overrides).length ? { style_overrides: c.style_overrides } : {}),
        ...(Object.keys(c.adjustments).length ? { adjustments: c.adjustments } : {}), ...(note ? { note, note_scope: draft.scope } : {}) }, 'הגרסה המתוקנת נכנסה לתור. הגרסה הקודמת נשמרה להשוואה.');
    }
    if (d.do === 'applyreview') { const by = who(); if (!by) return;
      if (!confirm('דנה תיישם בעצמה את השיפורים שבתוך הכללים המאושרים ותפיק גרסה חדשה. הגרסה הנוכחית נשמרת להשוואה. להמשיך?')) return;
      return act('/apply-review', { by }, 'דנה מיישמת את השיפורים. הגרסה החדשה תופיע עם השוואה לקודמת.'); }
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

  const id = location.hash.slice(1);
  (id ? open(id) : loadHome()).catch(e => notice(e.message, 'bad'));
  setInterval(() => { if (!current) loadHome().catch(() => {}); }, 10000);
})();
