'use strict';
/* Dana studio — mobile review page. Talks only to /api/dana/studio/*. */
(() => {
  const $ = s => document.querySelector(s);
  const API = '/api/dana/studio';
  // Embedded in the panel's Dana tab (?embed=1): the panel is already around the page, and a lost
  // session must send the WHOLE window to the login page, not just this frame.
  const EMBED = new URLSearchParams(location.search).has('embed') && window.top !== window;
  if (EMBED) document.documentElement.classList.add('embed');
  const toLogin = () => { (EMBED ? window.top : window).location.href = '/login.html'; };
  const csrf = () => { const m = /(?:^|;\s*)ss_csrf=([^;]+)/.exec(document.cookie); return m ? decodeURIComponent(m[1]) : null; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = iso => iso ? new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Jerusalem' }) : '—';
  let current = null, timer = null, me = '';
  // Corrections the owner is collecting for the next version. Kept in memory per project+version until "הפק גרסה מתוקנת".
  let draft = null, draftKey = '', pvSource = null;
  const newDraft = () => ({ captions: {}, style: {}, zooms: {}, note: '', scope: '' });
  const isNum = x => typeof x === 'number' && isFinite(x);
  const tfmt = t => isNum(t) ? t.toFixed(1) + 's' : '—';
  try { me = localStorage.getItem('dana_reviewer') || ''; } catch { /* private mode */ }

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
    me = (prompt('שם המאשר/ת (נשמר בהיסטוריה):') || '').trim();
    try { if (me) localStorage.setItem('dana_reviewer', me); } catch { /* */ }
    return me;
  }

  const STATUS = { editing: ['בעריכה', 'info'], ready_for_review: ['ממתין לאישור', 'warn'], approved: ['אושר', 'ok'], rejected: ['נדחה', 'bad'],
    failed: ['נכשל', 'bad'], waiting: ['ממתין', 'warn'], changes_requested: ['התבקשו שינויים', 'warn'] };
  const pill = (st) => { const [t, c] = STATUS[st] || [st, 'mute']; return `<span class="pill ${c}">${esc(t)}</span>`; };
  function workerPill(w) {
    const el = $('#worker');
    if (!w) return;
    if (!w.online) { el.className = 'pill bad'; el.textContent = w.lastSeen ? 'עובד העריכה לא מחובר' : 'עובד העריכה לא חובר'; el.title = w.lastSeen ? 'נראה לאחרונה ' + fmt(w.lastSeen) : ''; }
    else if (w.state === 'busy') { el.className = 'pill info'; el.textContent = 'עובד: עורך כעת'; }
    else { el.className = 'pill ok'; el.textContent = 'עובד: מחובר'; }
  }

  // ── List ──────────────────────────────────────────────────────────────────
  async function loadList() {
    const [{ projects, worker }, st] = await Promise.all([api('/projects'), api('/status')]);
    workerPill(worker);
    $('#projects').innerHTML = projects.length ? projects.map(p => `<li><button class="proj" data-id="${esc(p.id)}">
      <div class="row"><b class="grow">${esc(p.title)}</b>${pill(p.status)}</div>
      <div class="small mute">${fmt(p.createdAt)} · גרסה ${p.currentVersion}${p.job && p.status === 'editing' ? ' · ' + esc(p.job.note || '') : ''}${p.unresolved ? ` · ${p.unresolved} בעיות פתוחות` : ''}</div>
    </button></li>`).join('') : '<li class="mute">עדיין לא הועלה חומר.</li>';
    $('#brand').innerHTML = st.brandMissing.length ? st.brandMissing.map(b => `<li><span class="pill warn">חסר</span> ${esc(b.label)}</li>`).join('') : '<li class="ok">הכול הוגדר</li>';
    $('#acctnow').textContent = st.instagramAccount ? '@' + st.instagramAccount : 'לא הוגדר';
    $('#profnow').textContent = st.defaultProfile ? `${st.defaultProfile.id} · גרסה ${st.defaultProfile.version}` : 'לא אושר פרופיל — העובד משתמש בפרופיל המובנה שלו';
    if (!worker.online && projects.some(p => p.status === 'editing')) notice('עובד העריכה במחשב לא מחובר. העריכות ממתינות בתור וימשיכו כשהוא יחזור.', 'warn');
    loadRules().catch(() => {}); loadRefs().catch(() => {});
  }

  // ── Standing rules ("כלל קבוע") ─────────────────────────────────────────────
  async function loadRules() {
    const { rules } = await api('/rules'), active = rules.filter(r => r.status === 'active');
    $('#rules').innerHTML = active.length ? active.map(r => `<li><div class="row"><span class="grow">${esc(r.text)}</span><button data-rule="${esc(r.id)}" class="danger">הסר כלל</button></div>
      <div class="small mute">${esc(r.by)} · ${fmt(r.at)}</div></li>`).join('') : '<li class="mute">אין כללים קבועים. כלל נוצר כשמסמנים הערה כ"כלל קבוע" בהפקת גרסה מתוקנת.</li>';
  }
  $('#rules').onclick = async e => {
    const id = e.target.dataset.rule; if (!id) return;
    if (!confirm('להסיר את הכלל? הוא לא יישלח יותר לעריכות הבאות (הרישום נשמר).')) return;
    const by = who(); if (!by) return;
    try { await api(`/rules/${id}/retire`, { method: 'POST', body: { by } }); await loadRules(); notice('הכלל הוסר.', 'ok'); } catch (err) { notice(err.message, 'bad'); }
  };

  // ── References ──────────────────────────────────────────────────────────────
  const PERM = { unknown: 'הרשאה לא ידועה', own: 'חומר שלי', licensed: 'ברישיון', inspiration_only: 'להשראה בלבד' };
  async function loadRefs() {
    const { references } = await api('/references');
    $('#refs').innerHTML = references.length ? references.map(r => `<li><div class="row"><b class="grow">${esc(r.title)}</b><span class="pill warn">ממתין לניתוח</span></div>
      <div class="small mute">${r.source_url ? `<a href="${esc(r.source_url)}" target="_blank" rel="noopener noreferrer">קישור</a>` : ''}${r.file ? `קובץ: ${esc(r.file.name)} (${(r.file.bytes / 1048576).toFixed(1)}MB)` : ''} · ${esc(PERM[r.usage_permission] || r.usage_permission)}${r.origin ? ' · מקור: ' + esc(r.origin) : ''}</div>
      ${r.content_type || r.fits_message ? `<div class="small">${esc([r.content_type, r.fits_message].filter(Boolean).join(' · '))}</div>` : ''}
      ${r.owner_note ? `<div class="quote">${esc(r.owner_note)}</div>` : ''}
      <button data-refdel="${esc(r.id)}" class="danger" style="margin-top:6px">מחיקה</button></li>`).join('') : '<li class="mute">עדיין לא נוסף רפרנס.</li>';
  }
  $('#refs').onclick = async e => {
    const id = e.target.dataset.refdel; if (!id) return;
    if (!confirm('למחוק את הרפרנס?')) return;
    try { await api('/references/' + id, { method: 'DELETE' }); await loadRefs(); } catch (err) { notice(err.message, 'bad'); }
  };
  $('#refadd').onclick = async () => {
    const by = who(); if (!by) return;
    const fd = new FormData();
    for (const k of ['title', 'source_url', 'origin', 'usage_permission', 'content_type', 'fits_message', 'owner_note']) fd.append(k, $('#ref_' + k).value);
    fd.append('by', by);
    const f = $('#ref_file').files[0]; if (f) fd.append('file', f, f.name);
    const headers = {}; const t = csrf(); if (t) headers['X-CSRF-Token'] = t;
    $('#refadd').disabled = true;
    try {
      const r = await fetch(API + '/references', { method: 'POST', headers, body: fd, credentials: 'same-origin' });
      if (r.status === 401) return toLogin();
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || j.error || 'ההוספה נכשלה');
      for (const k of ['title', 'source_url', 'origin', 'content_type', 'fits_message', 'owner_note']) $('#ref_' + k).value = '';
      $('#ref_file').value = '';
      await loadRefs(); notice('הרפרנס נשמר. הוא ממתין — ניתוח רפרנסים עדיין לא פעיל.', 'ok');
    } catch (err) { notice(err.message, 'bad'); } finally { $('#refadd').disabled = false; }
  };
  $('#acctset').onclick = async () => {
    const val = prompt('חשבון האינסטגרם ליעד הפרסום (בלי @):', ($('#acctnow').textContent || '').replace(/^@/, '').replace('לא הוגדר', ''));
    if (val === null) return; const by = who(); if (!by) return;
    try { await api('/brand/instagram_account', { method: 'PUT', body: { value: val.trim().replace(/^@/, ''), by } }); await loadList(); notice('חשבון היעד עודכן. הוא יופיע בחבילות הבאות.', 'ok'); } catch (err) { notice(err.message, 'bad'); }
  };

  // ── Upload ────────────────────────────────────────────────────────────────
  $('#pick').onclick = () => $('#file').click();
  $('#file').onchange = () => {
    const f = $('#file').files[0]; if (!f) return;
    const fd = new FormData(); fd.append('video', f, f.name);
    const x = new XMLHttpRequest(); x.open('POST', API + '/upload');
    const t = csrf(); if (t) x.setRequestHeader('X-CSRF-Token', t);
    $('#upbar').classList.remove('hidden'); $('#pick').disabled = true;
    x.upload.onprogress = e => { if (e.lengthComputable) { $('#upbar i').style.width = (100 * e.loaded / e.total).toFixed(1) + '%'; $('#upstate').textContent = `מעלה… ${(e.loaded / 1048576).toFixed(0)} / ${(e.total / 1048576).toFixed(0)}MB`; } };
    const done = (msg, cls) => { $('#upbar').classList.add('hidden'); $('#upbar i').style.width = 0; $('#pick').disabled = false; $('#file').value = ''; $('#upstate').textContent = ''; notice(msg, cls); };
    x.onerror = () => done('ההעלאה נכשלה (בעיית רשת). הקובץ לא נשמר — נסה/י שוב.', 'bad');
    x.onload = () => {
      let j = {}; try { j = JSON.parse(x.responseText); } catch { /* */ }
      if (x.status === 401) return toLogin();
      if (x.status >= 400) return done(j.message || 'ההעלאה נכשלה', 'bad');
      done(j.duplicate ? 'הקובץ הזה כבר הועלה בעבר — נפתח הפרויקט הקיים, בלי עותק נוסף.' : 'הקובץ התקבל. העריכה נכנסה לתור.', j.duplicate ? 'warn' : 'ok');
      open(j.project.id);
    };
    x.send(fd);
  };

  // ── Detail ────────────────────────────────────────────────────────────────
  const CHECK = { pass: ['עבר', 'ok'], fail: ['נכשל', 'bad'], warn: ['אזהרה', 'warn'], human_required: ['דורש אדם', 'info'] };
  function render(p, worker) {
    current = p; workerPill(worker);
    const v = p.version, pkg = v && v.package, base = `${API}/projects/${p.id}/versions/${v ? v.n : 0}`;
    const key = `${p.id}:${v ? v.n : 0}`;
    if (key !== draftKey) { draft = newDraft(); draftKey = key; pvSource = null; }
    const h = [];
    h.push(`<div class="card"><div class="row"><h2 class="grow">${esc(p.title)}</h2>${pill(p.status)}</div>
      <div class="small mute">גרסה ${p.currentVersion} · מקור ${(p.source.bytes / 1048576).toFixed(1)}MB · <code>${esc(p.source.sha256.slice(0, 12))}…</code></div></div>`);

    if (p.job && ['queued', 'leased'].includes(p.job.status)) {
      h.push(`<div class="card"><h2>${p.job.status === 'queued' ? 'ממתין בתור' : 'בעריכה'}</h2><div>${esc(p.job.note || '')}</div>
        <div class="small mute">ניסיון ${p.job.attempts || 1} מתוך ${p.job.maxAttempts}${!worker.online ? ' · העובד לא מחובר — ימשיך כשיחזור' : ''}</div></div>`);
    }
    if (p.job && ['failed', 'waiting'].includes(p.job.status) && p.job.error) {
      h.push(`<div class="card"><h2 class="${p.job.status === 'failed' ? 'bad' : 'warn'}">${p.job.status === 'failed' ? 'העריכה נכשלה' : 'העריכה ממתינה'}</h2>
        <div>${esc(p.job.error.message)}</div><div class="small mute">קוד: ${esc(p.job.error.code)} · ניסיונות: ${p.job.attempts}</div>
        <button data-do="retry" style="margin-top:10px">נסה שוב</button></div>`);
    }
    if (p.pendingChange) h.push(`<div class="card"><h2 class="warn">בקשת שינוי ממתינה</h2><div class="quote">${esc(p.pendingChange.note)}</div>
      <p class="small mute">שינוי תוכני דורש שיפוט. מתאם Claude כבוי, ולכן הבקשה נשמרה וממתינה למפעיל — לא בוצע רינדור מחדש על עיוור.</p></div>`);

    if (pkg) {
      const cj = v.contentJudgement || {};
      const JM = { model: 'שיקול תוכן של המודל', fallback_heuristic: 'כלל אוטומטי — לא שיפוט תוכן', scripted: 'החלטות שהוזנו ידנית' };
      if (cj.missing) h.push(`<div class="card" id="nojudge" style="border-color:var(--bad)"><h2 class="bad">עריכה טכנית בלבד — שיפוט התוכן לא רץ</h2>
        <p>המסר, בחירת הקטעים, הקאבר והביקורת בגרסה הזו <b>לא</b> נבחרו בשיקול תוכן: כלל אוטומטי בחר אותם. החיתוך, הכתוביות והבדיקות הטכניות כן רצו.</p>
        <p class="small mute">אי אפשר לאשר את החבילה כמו שהיא. אפשר להפיק גרסה מתוקנת, או לתעד חריגה מפורשת אם בדקת את התוכן בעצמך.</p>
        ${cj.excepted ? '<span class="pill warn">תועדה חריגה — אפשר לאשר</span>' : `<button data-ex="${esc(cj.exceptionId)}">תיעוד חריגה: בדקתי את התוכן בעצמי</button>`}</div>`);
      h.push(`<div class="card"><h2>הסרטון הסופי</h2><video id="mainvid" controls playsinline preload="metadata" poster="${base}/cover" src="${base}/video"></video>
        <div class="small mute" style="margin-top:6px">${pkg.duration}s · מקור ${pkg.segment.in_s}–${pkg.segment.out_s}s · בחירה: ${esc(JM[pkg.judgementMode] || pkg.adapter || '—')} · נערך ב-${Math.round(pkg.totalSeconds)}s</div></div>`);
      if (pkg.plan) {
        const pl = pkg.plan, ru = pkg.rulesUsed;
        h.push(`<div class="card" id="plan"><h2>התוכנית של דנה</h2>
          ${pkg.revisionNote ? `<div class="pill info">מה השתנה בגרסה הזו</div><div class="quote">${esc(pkg.revisionNote)}</div>` : ''}
          <label>המסר</label><div>${esc(pl.message || '—')}</div>
          <label>הפתיחה</label><div>${esc(pl.hook || '—')}</div>
          <label>למה</label><div>${esc(pl.rationale || '—')}</div>
          <label>מפת הקטעים (זמני מקור → מיקום בסרטון)</label>
          <ul class="plain small">${(pl.segments || []).map(g => `<li><div class="row"><b>${esc(g.n)}.</b> <span>מקור ${tfmt(g.source_in_s)}–${tfmt(g.source_out_s)}</span>
            ${isNum(g.tl_in_s) ? `<button data-play="${g.tl_in_s},${g.tl_out_s}" style="margin-inline-start:auto">▶ ${tfmt(g.tl_in_s)}</button>` : ''}</div>
            <div>${g.role ? `<span class="pill mute">${esc(g.role)}</span> ` : ''}${esc(g.why || '')}</div></li>`).join('') || '<li class="mute">—</li>'}</ul>
          ${(pl.brief || []).length ? `<details class="small"><summary>תדריך העריכה (${pl.brief.length})</summary><ul class="plain">${pl.brief.map(b => `<li>${esc(b)}</li>`).join('')}</ul></details>` : ''}
          ${ru ? `<details class="small" open><summary>לפי אילו כללים נערך</summary><ul class="plain">
            <li>סקיל עריכה: ${ru.skill ? `${esc(ru.skill.name)} · גרסה ${esc(ru.skill.version)} · <code>${esc(String(ru.skill.sha256 || '').slice(0, 12))}</code>` : '—'}</li>
            <li>פרופיל: ${ru.profile ? `${esc(ru.profile.id)} · גרסה ${esc(ru.profile.version)} · <code>${esc(String(ru.profile.sha256 || '').slice(0, 12))}</code>` : '—'}
              ${ru.profile ? `<button data-do="profile" data-pid="${esc(ru.profile.id)}" style="margin-top:6px">אישור הפרופיל הזה כברירת מחדל לפרויקטים הבאים</button>` : ''}</li>
            <li>כללים קבועים: ${(ru.standing_rules || []).length || 'אין'}</li><li>רפרנסים: ${(ru.references || []).length || 'אין'}</li></ul></details>` : ''}
          ${pkg.usage ? `<div class="small mute" style="margin-top:6px">${pkg.usage.calls.length} קריאות למודל · ${pkg.usage.calls.reduce((t, c) => t + (c.elapsed_s || 0), 0).toFixed(0)}s · עלות מדווחת $${pkg.usage.calls.reduce((t, c) => t + (c.cost_usd_reported || 0), 0).toFixed(3)}</div>` : ''}</div>`);
      } else if (pkg.segment.reason) h.push(`<div class="card"><h2>מה נבחר ולמה</h2>
        ${pkg.revisionNote ? `<div class="pill info">מה השתנה בגרסה הזו</div><div class="quote">${esc(pkg.revisionNote)}</div>` : ''}
        ${pkg.segment.complete_thought ? `<label>המסר שנבחר</label><div>${esc(pkg.segment.complete_thought)}</div>` : ''}
        <label>למה הקטע עומד בפני עצמו</label><div>${esc(pkg.segment.reason)}</div>
        ${pkg.segment.audience_relevance ? `<label>קהל יעד (מהגדרות המותג)</label><div>${esc(pkg.segment.audience_relevance)}</div>` : ''}
        ${pkg.considered.length ? `<details class="small"><summary>חלופות שנשקלו (${pkg.considered.length})</summary><ul class="plain">${pkg.considered.map(c => `<li>${c.in_s}–${c.out_s}s: ${esc(c.why_not)}</li>`).join('')}</ul></details>` : ''}
        ${pkg.usage ? `<div class="small mute" style="margin-top:6px">נבחר על ידי ${esc(pkg.usage.calls.map(c => c.models_used.join('+') || c.model_requested).join(', '))} · ${pkg.usage.calls.length} קריאות · ${pkg.usage.calls.reduce((t, c) => t + (c.elapsed_s || 0), 0).toFixed(0)}s · עלות מדווחת $${pkg.usage.calls.reduce((t, c) => t + (c.cost_usd_reported || 0), 0).toFixed(3)}</div>` : ''}</div>`);
      h.push(`<div class="card"><h2>קאבר</h2><img class="cover" id="coverimg" alt="קאבר" src="${base}/cover">
        <div class="small mute" style="margin-top:6px">זו תמונת הקאבר המדויקת שבחבילה · טקסט: ${esc(pkg.cover.text || '— ללא —')}${pkg.cover.source ? ' · ' + (pkg.cover.source === 'plan' ? 'נבחר לפי המסר' : 'ברירת מחדל טכנית — לא נבחר לפי מסר') : ''}</div>
        ${p.publication.coverNote ? `<div class="small warn" style="margin-top:6px">${esc(p.publication.coverNote)}</div>` : ''}</div>`);

      h.push(`<div class="card"><h2>קפשן ו-CTA</h2>
        ${pkg.captionStatus === 'approved_voice' ? '<div class="pill ok">לפי קול מותג מאושר</div>' : v.caption.isDraft ? '<div class="pill warn">טיוטה — אין פרופיל קול מאושר</div>' : ''}
        <label for="cap">הקפשן המדויק שיפורסם</label><textarea id="cap">${esc(v.caption.text)}</textarea>
        ${/ציטוט מדויק/.test(v.caption.text) && !(pkg.transcript && pkg.transcript.status === 'owner_corrected') ? '<div class="small warn">הקפשן קורא לטקסט "ציטוט מדויק", אבל התמלול אוטומטי ולא אומת. כדאי לתקן את הניסוח לפני אישור.</div>' : ''}
        <label for="cta">קריאה לפעולה (CTA)</label><input type="text" id="cta" value="${esc(v.caption.cta || '')}" placeholder="לא הוגדר — לא יפורסם CTA">
        <label for="acct">חשבון יעד · ${esc(v.destination.platform)} / ${esc(v.destination.format)}</label><input type="text" id="acct" value="${esc(v.destination.account || '')}" placeholder="חשבון היעד לא הוגדר">
        <label for="when">מועד פרסום ${v.scheduleProposed ? 'מוצע' : ''} — שעון ישראל</label><input type="datetime-local" id="when" value="${esc(v.scheduledLocal || '')}">
        ${v.scheduleProposed ? '<div class="small mute">ברירת מחדל טכנית (מחר ב-12:00, לא לפני פרסום אחר) — לא המלצת תזמון. אפשר לשנות.</div>' : ''}
        <button data-do="save" style="margin-top:10px">שמירת שינויים</button>
        <p class="small mute">שינוי בקפשן, ב-CTA, ביעד או במועד מבטל אישור קיים.</p></div>`);

      // ── Transcript and captions: automatic text is never called an exact quote ──
      const tr = pkg.transcript, saved = p.captionEdits || [];
      const TS = { auto_unverified: ['תמלול אוטומטי — לא אומת', 'warn'], owner_corrected_partial: ['תמלול אוטומטי, תוקן חלקית על ידך', 'info'], owner_corrected: ['תוקן ואומת על ידך', 'ok'] };
      const ts = TS[tr && tr.status] || TS.auto_unverified;
      const DK = { low_confidence: 'ודאות נמוכה', passes_disagree: 'שתי ההאזנות לא מסכימות', context: 'ספק לפי הקשר — המודל לא שמע את האודיו' };
      const doubts = {};
      if (tr && Array.isArray(tr.doubts)) for (const d of tr.doubts) (doubts[d.card] = doubts[d.card] || []).push(d);
      else for (const u of v.unresolved.concat((v.exceptions || []).filter(x => x.kind === 'acoustic'))) if (u.kind === 'acoustic' && u.card) (doubts[u.card] = doubts[u.card] || []).push({ kind: 'low_confidence', note: u.original });
      h.push(`<div class="card" id="captions"><h2>תמלול וכתוביות</h2>
        <span class="pill ${ts[1]}">${ts[0]}</span>
        <p class="small mute">▶ מנגן רק את הכתובית. אפשר לתקן כל שורה; התיקון נשמר בנפרד מהתמלול המקורי, נכנס בגרסה הבאה ונשאר בכל הגרסאות שאחריה.</p>
        <ul class="plain">${pkg.cards.map(c => { const sp = span(pkg, c), ds = doubts[c.i] || [], val = draft.captions[c.i] !== undefined ? draft.captions[c.i] : c.text;
          const prev = sp && saved.find(e => Math.abs(e.source_start_s - sp[0]) < 0.02 && Math.abs(e.source_end_s - sp[1]) < 0.02);
          return `<li><div class="row"><button data-play="${Math.max(0, c.start - 0.25).toFixed(2)},${(c.start + c.dur + 0.25).toFixed(2)}">▶ ${c.start.toFixed(1)}s</button>
            ${ds.map(d => `<span class="pill warn" title="${esc(d.note || '')}">${esc(DK[d.kind] || 'ספק')}${d.word ? ': ' + esc(d.word) : ''}</span>`).join('')}
            ${prev ? '<span class="pill info">תוקן על ידך</span>' : ''}</div>
            <input type="text" data-card="${c.i}" maxlength="80" value="${esc(val)}" ${sp ? '' : 'disabled'} style="margin-top:6px" aria-label="כתובית ${c.i}">
            ${prev ? `<div class="small mute">בתמלול המקורי: ${esc(prev.original)}</div>` : ''}</li>`; }).join('')}</ul>
        ${pkg.cards.some(c => !span(pkg, c)) ? '<p class="small warn">לחלק מהכתוביות אין מיפוי לזמני המקור בגרסה הזו, ולכן אי אפשר לתקן אותן כאן.</p>' : ''}
        ${pkg.cards.some(c => (span(pkg, c) || [])[2]) ? '<p class="small mute">הגרסה הזו נערכה לפני שנשמרו זמני מקור לכל כתובית; הזמנים מחושבים מתחילת הקטע.</p>' : ''}
        ${saved.length ? `<details class="small"><summary>תיקונים שמורים בפרויקט (${saved.length})</summary><ul class="plain">${saved.map(e => `<li>${tfmt(e.source_start_s)}: <span class="mute">${esc(e.original)}</span> ← <b>${esc(e.text)}</b> · ${esc(e.by)}</li>`).join('')}</ul></details>` : ''}
        <details class="small"><summary>הטקסט המלא של הקטע (${esc(ts[0])})</summary><div class="quote">${esc(pkg.spokenText)}</div></details></div>`);

      // ── Caption style: controls + preview on a real frame ──
      const st = pkg.style || {}, sv = k => draft.style[k] !== undefined ? draft.style[k] : st[k];
      h.push(`<div class="card" id="style"><h2>סגנון כתוביות</h2>
        <canvas id="pv" width="270" height="480" style="display:block;margin:0 auto;border-radius:10px;background:#000;max-width:100%"></canvas>
        <p class="small mute">קירוב של גודל ומיקום בלבד על פריים אמיתי. התוצאה המדויקת היא הרינדור של הגרסה הבאה.</p>
        <button data-do="pvframe">להציג על הפריים הנוכחי בסרטון</button>
        <label for="st_size">גודל: <b id="st_size_v">${esc(sv('caption_size') ?? '—')}</b></label><input type="range" id="st_size" data-style="caption_size" min="40" max="140" step="2" value="${Number(sv('caption_size')) || 76}">
        <label for="st_y">מיקום אנכי (0 למעלה, 1920 למטה): <b id="st_y_v">${esc(sv('caption_y_px') ?? '—')}</b></label><input type="range" id="st_y" data-style="caption_y_px" min="200" max="1700" step="10" value="${Number(sv('caption_y_px')) || 1250}">
        <label for="st_lines">מספר שורות</label><select id="st_lines" data-style="caption_max_lines"><option value="">כמו בגרסה הזו</option><option value="1" ${sv('caption_max_lines') === 1 ? 'selected' : ''}>שורה אחת</option><option value="2" ${sv('caption_max_lines') === 2 ? 'selected' : ''}>עד שתי שורות</option></select>
        <label style="display:flex;gap:8px;align-items:center;color:var(--ink);font-size:15px"><input type="checkbox" id="st_hl" data-style="highlight_enabled" ${sv('highlight_enabled') === false ? '' : 'checked'} style="width:22px;height:22px"> הדגשות צבע במילים</label></div>`);

      // ── Zooms: only what the worker reported ──
      if (Array.isArray(pkg.zooms)) h.push(`<div class="card" id="zooms"><h2>זומים (${pkg.zooms.length})</h2>
        ${pkg.zooms.length ? `<ul class="plain">${pkg.zooms.map(z => { const d = draft.zooms[z.id] || {}; return `<li>
          <div class="row"><button data-play="${Math.max(0, z.tl_t_s - 1).toFixed(2)},${(z.tl_t_s + 2.5).toFixed(2)}">▶ ${tfmt(z.tl_t_s)}</button><span class="pill mute">×${esc(z.scale)}</span><span class="small mute">מקור ${tfmt(z.source_t_s)}</span></div>
          <div>${esc(z.reason || '')}</div>${z.evidence ? `<div class="small mute">${esc(z.evidence)}</div>` : ''}
          <div class="row" style="margin-top:6px"><select data-zoom="${esc(z.id)}" style="flex:1"><option value="">להשאיר</option><option value="remove" ${d.action === 'remove' ? 'selected' : ''}>לבטל את הזום</option><option value="set" ${d.action === 'set' ? 'selected' : ''}>לשנות עוצמה</option></select>
            <input type="number" data-zoomscale="${esc(z.id)}" min="1.05" max="1.5" step="0.05" value="${esc(d.scale || z.scale)}" style="width:90px;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink)" ${d.action === 'set' ? '' : 'disabled'}></div></li>`; }).join('')}</ul>`
          : '<div class="mute">הגרסה הזו נערכה בלי זומים.</div>'}
        ${(p.zoomEdits || []).length ? `<details class="small"><summary>שינויי זום שמורים בפרויקט (${p.zoomEdits.length})</summary><ul class="plain">${p.zoomEdits.map(z => `<li><code>${esc(z.id)}</code>: ${z.action === 'remove' ? 'בוטל' : 'עוצמה ×' + esc(z.scale)} · ${esc(z.by || '')}</li>`).join('')}</ul></details>` : ''}</div>`);

      // ── One action: produce the corrected version ──
      h.push(`<div class="card" id="revise"><h2>הפק גרסה מתוקנת</h2>
        <div id="rvsum" class="small"></div>
        <label for="rvnote">הערה חופשית (לא חובה)</label><textarea id="rvnote" style="min-height:80px" placeholder="למשל: לפתוח במשפט אחר, לקצר את הסוף">${esc(draft.note)}</textarea>
        <div id="rvscope" class="${draft.note ? '' : 'hidden'}">
          <label style="display:flex;gap:8px;align-items:center;color:var(--ink);font-size:15px"><input type="radio" name="rvscope" value="project" ${draft.scope === 'project' ? 'checked' : ''} style="width:20px;height:20px"> תיקון לפרויקט הזה</label>
          <label style="display:flex;gap:8px;align-items:center;color:var(--ink);font-size:15px"><input type="radio" name="rvscope" value="permanent" ${draft.scope === 'permanent' ? 'checked' : ''} style="width:20px;height:20px"> כלל קבוע — יישלח לכל הפרויקטים הבאים</label></div>
        <button class="primary" data-do="revise" style="margin-top:10px;width:100%">הפק גרסה מתוקנת</button>
        <p class="small mute">גרסה ${v.n} נשמרת להשוואה. אישור קיים מתבטל, והגרסה החדשה עוברת עריכה וביקורת מחדש אצל עובד העריכה.</p></div>`);

      const open = v.unresolved;
      const KIND = { timing: 'תזמון', text: 'איות', acoustic: 'שמיעה', technical: 'טכני', content: 'תוכן' };
      const VERD = { suspected_false_positive: ['כנראה אזעקת שווא', 'info'], confirmed: ['כשל מאומת', 'bad'], needs_reading: ['לקרוא', 'warn'],
        needs_listening: ['להאזין', 'warn'], needs_decision: ['להחליט', 'warn'] };
      h.push(`<div class="card" id="review"><h2>${open.length ? `<span class="bad">חוסמים — נדרשת הבדיקה שלך: ${open.length}</span>` : '<span class="ok">אין חוסמים פתוחים</span>'}</h2>
        <p class="small mute">בדיקות אוטומטיות שנכשלו והחלטות תוכן. בלי אישור שלך לפריטים האלה אי אפשר לאשר את החבילה.</p>
        <ul class="plain">${open.map(u => { const vd = VERD[u.verdict] || ['לבדוק', 'warn']; return `<li>
          <div class="row"><span class="pill mute">${esc(KIND[u.kind] || 'בדיקה')}</span><span class="pill ${vd[1]}">${vd[0]}</span>
            ${u.t0 != null ? `<button data-play="${u.t0},${u.t1}" style="margin-inline-start:auto">▶ ${u.t0}s</button>` : ''}</div>
          <div><b>${esc(u.ask || '')}</b>${u.text ? ` <span class="mute">"${esc(u.text)}"</span>` : ''}</div>
          <div class="small">${esc(u.original || u.summary || '')}</div>
          ${u.explanation ? `<details class="small mute"><summary>ראיות</summary>${esc(u.explanation)}</details>` : ''}</li>`; }).join('') || '<li class="mute">—</li>'}</ul>
        ${open.length ? `<label style="display:flex;gap:8px;align-items:center;color:var(--ink);font-size:15px"><input type="checkbox" id="watched" style="width:22px;height:22px"> צפיתי והקשבתי לכל הקטעים</label>
          <input type="text" id="rnote" placeholder="הערה (לא חובה)" style="margin-top:8px">
          <button class="primary" data-do="confirm" style="margin-top:8px;width:100%">אישור כל הפריטים יחד</button>` : ''}
        ${v.exceptions.length ? `<details><summary>פריטים שאושרו (${v.exceptions.length})</summary><ul class="plain small">${v.exceptions.map(e => `<li><b>${esc(e.id)}</b> · ${esc(e.by)} · ${fmt(e.at)}<div>${esc(e.original || '')}</div><div class="quote">${esc(e.reason)}</div></li>`).join('')}</ul></details>` : ''}
        <p class="small mute">התוצאה המקורית של כל בדיקה נשמרת כמו שהיא. אישור אחד מכסה את כל הפריטים המוצגים, ונרשם בהיסטוריה. אפשר גם לבקש שינויים במקום לאשר.</p></div>`);

      const lastCycle = pkg.editorial && pkg.editorial.cycles.length ? pkg.editorial.cycles[pkg.editorial.cycles.length - 1] : null;
      const sugg = lastCycle ? lastCycle.findings.filter(f => f.severity === 'advisory') : [];
      if (sugg.length) h.push(`<div class="card"><h2><span class="warn">הצעות עריכה (לא חוסם): ${sugg.length}</span></h2>
        <ul class="plain">${sugg.map(f => { const cd = f.card ? pkg.cards[f.card - 1] : null; return `<li>
          <div class="row"><span class="pill mute">${esc({ card: 'כתובית', caption: 'קפשן', cover: 'קאבר', highlight: 'הדגשה', segment_start: 'פתיחה', segment_end: 'סיום', frame: 'פריים' }[f.asset] || f.asset)}</span>
            ${cd ? `<button data-play="${Math.max(0, cd.start - 1).toFixed(2)},${(cd.start + cd.dur + 0.8).toFixed(2)}" style="margin-inline-start:auto">▶ ${cd.start.toFixed(1)}s</button>` : ''}</div>
          <div>${esc(f.problem)}</div><div class="small mute">→ ${esc(f.correction)}</div></li>`; }).join('')}</ul>
        <p class="small mute">אלה המלצות שדנה לא הצליחה ליישם אוטומטית בלי לשנות מילים. אפשר לאשר כמו שזה, או לכתוב "בקש שינויים".</p></div>`);
      h.push(`<div class="card"><details ${open.length ? '' : 'open'}><summary><b>בדיקות (${pkg.checks.length})</b></summary><ul class="plain small">${pkg.checks.map(c => {
        const [t, cl] = CHECK[c.status] || [c.status, 'mute']; return `<li><span class="pill ${cl}">${t}</span> <b>${esc(c.id)}</b><div>${esc(c.summary)}</div></li>`; }).join('')}</ul>
        <a class="small" href="${base}/checks" target="_blank" rel="noopener">פלט הבדיקות המלא (JSON)</a></details></div>`);

      const notes = pkg.issues.filter(i => i.severity !== 'blocker');
      if (notes.length) h.push(`<div class="card"><details><summary><b>הערות (${notes.length})</b></summary><ul class="plain small">${notes.map(i => `<li><span class="pill ${i.severity === 'warn' ? 'warn' : 'mute'}">${i.severity === 'warn' ? 'לתשומת לב' : 'מידע'}</span> ${esc(i.message)}</li>`).join('')}</ul></details></div>`);
    }

    const c = p.consent, cs = { unknown: ['לא תועדה', 'warn'], confirmed: ['אושרה', 'ok'], denied: ['סירוב', 'bad'] }[c.status];
    h.push(`<div class="card"><h2>הסכמה וזכויות</h2>
      <div class="row"><span class="grow">הסכמת המצולמים לפרסום</span><span class="pill ${cs[1]}">${cs[0]}</span></div>
      ${c.by ? `<div class="small mute">${esc(c.by)} · ${fmt(c.at)}${c.note ? ' · ' + esc(c.note) : ''}</div>` : ''}
      <div class="row" style="margin-top:8px"><button data-consent="confirmed">תיעוד הסכמה</button><button data-consent="denied" class="danger">אין הסכמה</button></div>
      <div class="row" style="margin-top:10px"><span class="grow">מוזיקה</span><span class="pill ok">ללא מוזיקה</span></div>
      <p class="small mute">אפשר להכין ולאשר חבילה לפני שתועדה הסכמה, אבל פרסום חסום עד שהיא מתועדת.</p></div>`);

    const ed = pkg && pkg.editorial;
    if (ed) {
      const last = ed.cycles[ed.cycles.length - 1];
      h.push(`<div class="card"><h2>העבודה של דנה</h2>
        <div class="row"><span class="pill ${ed.status === 'ready_for_owner_review' ? 'ok' : 'warn'}">${ed.status === 'ready_for_owner_review' ? 'מוכן לבדיקה שלך' : 'נעצר עם נושאים פתוחים'}</span>
          <span class="pill mute">${ed.revisions} סבבי תיקון</span>${ed.test_injection ? '<span class="pill bad">כולל פגם בדיקה מוזרק</span>' : ''}</div>
        ${ed.test_injection ? `<div class="small bad">${esc(ed.test_injection.label)}</div>` : ''}
        <label>מטרת התוכן</label><div>${esc(ed.objective || '—')}</div>
        <details class="small"><summary>תדריך העריכה</summary><ul class="plain">${ed.brief.map(b => `<li>${esc(b)}</li>`).join('') || '<li>—</li>'}</ul>
          <div class="mute">עובדות מאומתות ששימשו: ${esc(ed.verified_facts.join(' · ') || '—')}</div><div class="mute">חסר ולכן הושמט: ${esc(ed.missing_information.join(' · ') || '—')}</div></details>
        <details class="small"><summary>קריטריוני קבלה (${last ? ed.criteria.filter(c => c.met).length : 0}/${ed.criteria.length} מתקיימים)</summary><ul class="plain">${ed.criteria.map(c =>
          `<li><span class="pill ${c.met === true ? 'ok' : c.met === false ? 'bad' : 'mute'}">${c.met === true ? 'כן' : c.met === false ? 'לא' : '?'}</span> ${esc(c.criterion)} <span class="mute">(${esc({ check: 'בדיקה', skill: 'כלי סקיל', reviewer: 'ביקורת דנה' }[c.decided_by])})</span></li>`).join('')}</ul></details>
        <details class="small"><summary>סבבי ביקורת ותיקון</summary>${ed.cycles.map(c => `<div style="margin-top:8px"><b>סבב ${c.cycle}</b>${c.reused_render ? ' · רק טקסטים השתנו' : ''}
          <ul class="plain">${c.findings.map(f => `<li><span class="pill ${f.severity === 'blocking' ? 'bad' : 'warn'}">${f.severity === 'blocking' ? 'חוסם' : 'המלצה'}</span> ${esc(f.problem)}<div class="mute">→ ${esc(f.correction)}</div></li>`).join('') || '<li class="ok">אין ממצאים</li>'}</ul>
          ${c.verification_of_previous.length ? `<div class="mute">אימות תיקוני הסבב הקודם: ${c.verification_of_previous.filter(x => x.status === 'fixed').length}/${c.verification_of_previous.length} תוקנו</div>` : ''}</div>`).join('')}</details>
        <p class="small mute">הביקורת של דנה קוראת טקסט ורואה פריימים בודדים. היא לא שומעת את האודיו ולא צופה בתנועה. קבלה פנימית שלה פירושה "מוכן לבדיקה שלך" — לא אישור פרסום.</p>
        <a class="small" href="${base}/editorial" target="_blank" rel="noopener">הפלט המלא (JSON)</a></div>`);
    }
    const pub = p.publication.record;
    const PS = { scheduled: ['מתוזמן', 'info'], processing: ['בתהליך', 'info'], published: ['פורסם', 'ok'], failed: ['נכשל', 'bad'], uncertain: ['לא ודאי', 'warn'], cancelled: ['בוטל', 'mute'] };
    h.push(`<div class="card"><h2>פרסום</h2>
      ${pub ? `<div class="row"><span class="pill ${PS[pub.state][1]}">${PS[pub.state][0]}</span>${pub.mode === 'mock' ? '<span class="pill bad">MOCK — לא פרסום אמיתי</span>' : '<span class="pill ok">אינסטגרם</span>'}<span class="small mute">${fmt(pub.scheduledAt)} שעון ישראל</span></div>
        ${pub.permalink ? `<div class="small">קישור: <code>${esc(pub.permalink)}</code> · מזהה <code>${esc(pub.mediaId)}</code>${pub.verification ? ` · קפשן תואם: ${pub.verification.captionMatches === true ? 'כן' : pub.verification.captionMatches === false ? 'לא' : '—'}` : ''}</div>` : ''}
        ${pub.error ? `<div class="small bad">${esc(pub.error)}</div>` : ''}
        ${pub.metrics.length ? `<ul class="plain small">${pub.metrics.map(m => `<li><span class="pill bad">${esc(m.source)}</span> אחרי ${m.offsetHours} שעות: ${Object.entries(m.values).map(([k, x]) => `${esc(k)} ${esc(x)}`).join(' · ')}</li>`).join('')}</ul>` : ''}
        ${pub.state === 'scheduled' ? '<button data-do="pubcancel" class="danger" style="margin-top:8px">ביטול הפרסום המתוזמן</button>' : ''}`
      : `<div class="pill ${p.publication.allowed ? 'ok' : 'bad'}">${p.publication.allowed ? 'מותר לתזמן' : 'חסום'}</div>
        <ul class="plain small">${p.publication.blocked.map(b => `<li>${esc(b.message)}</li>`).join('')}</ul>
        ${p.publication.allowed ? `<button data-do="pubschedule" class="primary" style="margin-top:8px">תזמון הפרסום${p.publication.mode === 'mock' ? ' (MOCK)' : ' באינסטגרם'}</button>` : ''}`}
      ${p.publication.paused ? '<div class="pill warn" style="margin-top:8px">כל הפרסומים מושהים</div>' : ''}
      ${p.publication.coverNote ? `<div class="small warn" style="margin-top:8px">${esc(p.publication.coverNote)}</div>` : ''}
      <p class="small mute">${p.publication.mode === 'instagram' ? 'מחובר ספק אינסטגרם אמיתי: פרסום יוצא רק אחרי אישור שלך לחבילה המדויקת, הסכמה מתועדת ומועד.' : p.publication.mode === 'mock' ? 'ספק דמה מקומי לבדיקות — שום דבר לא מתפרסם בפועל.' : 'פרסום כבוי. שום דבר לא מתפרסם.'}</p></div>`);

    if (v && v.approval) h.push(`<div class="card"><h2 class="${v.approvalValid ? 'ok' : 'bad'}">${v.approvalValid ? 'אושר' : 'האישור אינו תקף (התוכן השתנה)'}</h2>
      <div class="small mute">${esc(v.approval.by)} · ${fmt(v.approval.at)} · טביעת גרסה <code>${esc(v.approval.fingerprint.slice(0, 16))}…</code></div></div>`);

    const H = { uploaded: 'הועלה', duplicate_upload: 'העלאה כפולה זוהתה', edit_queued: 'עריכה נכנסה לתור', job_leased: 'העובד התחיל', job_released: 'עריכה הוחזרה לתור',
      job_failed: 'עריכה נכשלה', package_ready: 'חבילה מוכנה', package_edited: 'החבילה נערכה', approval_invalidated: 'האישור בוטל', approved: 'אושר',
      changes_requested: 'התבקשו שינויים', revision_requested: 'התבקשה גרסה מתוקנת', rejected: 'נדחה', consent_recorded: 'הסכמה תועדה', exception_recorded: 'חריגה תועדה', review_confirmed: 'פריטי הבדיקה אושרו', publication_scheduled: 'פרסום תוזמן', publication_processing: 'פרסום בתהליך',
      publication_published: 'פורסם (אומת)', publication_failed: 'פרסום נכשל', publication_uncertain: 'פרסום לא ודאי', publication_cancelled: 'פרסום בוטל', metrics_collected: 'נתונים נאספו' };
    if (p.versions.length) h.push(`<div class="card" id="versions"><h2>גרסאות</h2>
      <ul class="plain">${p.versions.map(x => `<li><div class="row"><b>גרסה ${x.n}</b>${pill(x.status)}${x.n === p.currentVersion ? '<span class="pill info">נוכחית</span>' : ''}${x.approved ? '<span class="pill ok">מאושרת</span>' : ''}
        ${x.hasVideo && x.n !== p.currentVersion ? `<button data-cmp="${x.n}" style="margin-inline-start:auto">▶ צפייה להשוואה</button>` : ''}</div>
        <div class="small mute">${fmt(x.createdAt)}${x.duration ? ' · ' + x.duration + 's' : ''}${x.judgementMode ? ' · ' + esc({ model: 'שיקול תוכן', fallback_heuristic: 'טכני בלבד', scripted: 'החלטות ידניות' }[x.judgementMode] || x.judgementMode) : ''}${x.profile ? ' · פרופיל ' + esc(x.profile.id) : ''}${x.changeRequest ? ' · "' + esc(x.changeRequest) + '"' : ''}</div></li>`).join('')}</ul>
      <div id="cmpbox" class="hidden"><label id="cmplabel"></label><video id="cmp" controls playsinline preload="metadata"></video>
        <p class="small mute">גרסה קודמת מוצגת להשוואה בלבד. האישור והפרסום חלים רק על הגרסה הנוכחית.</p></div></div>`);
    h.push(`<div class="card"><details><summary><b>היסטוריה וגרסאות</b></summary>
      <div class="small">${p.versions.map(x => `גרסה ${x.n}: ${(STATUS[x.status] || [x.status])[0]}${x.changeRequest ? ' — "' + esc(x.changeRequest) + '"' : ''}`).join('<br>')}</div>
      <ul class="plain small">${p.history.slice().reverse().map(e => `<li>${fmt(e.at)} · ${esc(e.actor)} · <b>${esc(H[e.action] || e.action)}</b>${e.detail && (e.detail.note || e.detail.reason || e.detail.code) ? ' — ' + esc(e.detail.note || e.detail.reason || e.detail.code) : ''}</li>`).join('')}</ul></details></div>`);

    $('#detail').innerHTML = h.join('');
    const reviewable = pkg && ['ready_for_review', 'approved'].includes(v.status);
    $('#actions').classList.toggle('hidden', !reviewable);
    if (reviewable) $('#actions [data-act=approve]').disabled = v.unresolved.length > 0 || v.approvalValid || (v.contentJudgement && v.contentJudgement.missing && !v.contentJudgement.excepted);
    if (pkg) { reviseSummary(); loadPreviewSource(base + '/cover'); }
  }

  // ── Draft helpers ─────────────────────────────────────────────────────────
  /** Source-time span of a card: [start, end, approximated]. Old single-cut packages have no per-card source time. */
  function span(pkg, c) {
    if (isNum(c.source_start_s) && isNum(c.source_end_s)) return [c.source_start_s, c.source_end_s, false];
    if (!pkg.plan && pkg.segment && isNum(pkg.segment.in_s)) return [+(pkg.segment.in_s + c.start).toFixed(3), +(pkg.segment.in_s + c.start + c.dur).toFixed(3), true];
    return null;
  }
  function collect() {
    const pkg = current.version.package, out = { caption_edits: [], zoom_edits: [], style_overrides: {} };
    for (const c of pkg.cards) {
      const t = draft.captions[c.i], sp = span(pkg, c);
      if (t === undefined || !sp || t.trim() === c.text || !t.trim()) continue;
      out.caption_edits.push({ source_start_s: sp[0], source_end_s: sp[1], original: c.text, text: t.trim() });
    }
    for (const [id, z] of Object.entries(draft.zooms)) if (z.action === 'remove') out.zoom_edits.push({ id, action: 'remove' });
      else if (z.action === 'set' && isNum(z.scale)) out.zoom_edits.push({ id, action: 'set', scale: z.scale });
    for (const [k, val] of Object.entries(draft.style)) if (val !== (pkg.style || {})[k]) out.style_overrides[k] = val;
    return out;
  }
  function reviseSummary() {
    const el = $('#rvsum'); if (!el || !current || !current.version.package) return;
    const c = collect(), parts = [];
    if (c.caption_edits.length) parts.push(`${c.caption_edits.length} תיקוני כתוביות`);
    if (Object.keys(c.style_overrides).length) parts.push('שינוי סגנון');
    if (c.zoom_edits.length) parts.push(`${c.zoom_edits.length} שינויי זום`);
    if (draft.note.trim()) parts.push('הערה');
    el.textContent = parts.length ? 'ייכנסו לגרסה הבאה: ' + parts.join(' · ') : 'עדיין לא סומן תיקון. אפשר לתקן כתוביות, סגנון או זומים למעלה, או לכתוב הערה.';
  }
  function loadPreviewSource(url) {
    if (pvSource && pvSource.tagName) return drawPreview();
    const img = new Image(); img.onload = () => { if (!pvSource || !pvSource.tagName || pvSource.tagName === 'IMG') { pvSource = img; drawPreview(); } }; img.src = url;
  }
  /** Approximate preview: the caption block drawn over a real frame at the chosen size and height. Not the renderer. */
  function drawPreview() {
    const cv = $('#pv'); if (!cv || !current || !current.version.package) return;
    const g = cv.getContext('2d'), W = cv.width, H = cv.height, k = W / 1080, pkg = current.version.package, st = pkg.style || {};
    const val = key => draft.style[key] !== undefined ? draft.style[key] : st[key];
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    if (pvSource) { try { const sw = pvSource.videoWidth || pvSource.naturalWidth, sh = pvSource.videoHeight || pvSource.naturalHeight;
      if (sw && sh) { const sc = Math.max(W / sw, H / sh); g.drawImage(pvSource, (W - sw * sc) / 2, (H - sh * sc) / 2, sw * sc, sh * sc); } } catch (e) { /* frame not ready */ } }
    const size = (Number(val('caption_size')) || 76) * k, y = (Number(val('caption_y_px')) || 1250) * (H / 1920);
    const card = pkg.cards.reduce((a, c) => (c.text.length > a.text.length ? c : a), pkg.cards[0] || { text: 'כתובית לדוגמה', i: 0 });
    const text = (draft.captions[card.i] !== undefined ? draft.captions[card.i] : card.text) || 'כתובית לדוגמה';
    const words = text.split(/\s+/), lines = val('caption_max_lines') === 2 && words.length > 2 ? [words.slice(0, Math.ceil(words.length / 2)).join(' '), words.slice(Math.ceil(words.length / 2)).join(' ')] : [text];
    g.font = `700 ${size}px Heebo, "Segoe UI", system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.direction = 'rtl';
    const lh = size * 1.25, top = y - (lines.length - 1) * lh / 2;
    if (val('backing') !== false) { const w = Math.max(...lines.map(l => g.measureText(l).width)) + size * 0.7; g.fillStyle = 'rgba(0,0,0,0.42)'; g.fillRect((W - w) / 2, top - lh / 2 - size * 0.1, w, lines.length * lh + size * 0.2); }
    g.shadowColor = 'rgba(0,0,0,0.9)'; g.shadowBlur = size * 0.15; g.fillStyle = '#F5F5F5';
    lines.forEach((l, i) => g.fillText(l, W / 2, top + i * lh));
    g.shadowBlur = 0;
  }
  $('#detail').addEventListener('input', e => {
    const t = e.target; if (!draft) return;
    if (t.dataset.card) draft.captions[Number(t.dataset.card)] = t.value;
    else if (t.dataset.style) {
      const key = t.dataset.style;
      if (t.type === 'checkbox') draft.style[key] = t.checked;
      else if (t.value === '') delete draft.style[key];
      else draft.style[key] = Number(t.value);
      if (key === 'caption_size') $('#st_size_v').textContent = t.value;
      if (key === 'caption_y_px') $('#st_y_v').textContent = t.value;
    } else if (t.dataset.zoom) {
      const id = t.dataset.zoom, sc = document.querySelector(`[data-zoomscale="${CSS.escape(id)}"]`);
      if (!t.value) delete draft.zooms[id]; else draft.zooms[id] = { action: t.value, scale: Number(sc.value) };
      sc.disabled = t.value !== 'set';
    } else if (t.dataset.zoomscale) { const z = draft.zooms[t.dataset.zoomscale]; if (z) z.scale = Number(t.value); }
    else if (t.id === 'rvnote') { draft.note = t.value; $('#rvscope').classList.toggle('hidden', !t.value.trim()); }
    else if (t.name === 'rvscope') draft.scope = t.value;
    else return;
    reviseSummary(); drawPreview();
  });
  $('#detail').addEventListener('change', e => { if (e.target.dataset.zoom || e.target.dataset.style || e.target.name === 'rvscope') e.target.dispatchEvent(new Event('input', { bubbles: true })); });

  async function open(id, quiet) {
    clearTimeout(timer);
    try {
      const { project, worker } = await api('/projects/' + id);
      const editing = document.activeElement && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName);
      const vid = $('#detail video'); const playing = vid && !vid.paused;
      if (!(quiet && (editing || playing) && current && current.status === project.status && current.currentVersion === project.currentVersion)) render(project, worker);
      else workerPill(worker);
      $('#list').classList.add('hidden'); $('#detail').classList.remove('hidden'); $('#back').classList.remove('hidden');
      if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
      if (['editing'].includes(project.status)) timer = setTimeout(() => open(id, true), 4000);
    } catch (e) { notice(e.message, 'bad'); }
  }
  function back() { clearTimeout(timer); current = null; history.replaceState(null, '', location.pathname); $('#detail').classList.add('hidden'); $('#actions').classList.add('hidden'); $('#back').classList.add('hidden'); $('#list').classList.remove('hidden'); loadList().catch(e => notice(e.message, 'bad')); }
  $('#back').onclick = back;
  $('#projects').onclick = e => { const b = e.target.closest('[data-id]'); if (b) { notice(''); open(b.dataset.id); } };

  async function act(path, body, okMsg, method = 'POST') {
    try { const { project } = await api(`/projects/${current.id}${path}`, { method, body }); notice(okMsg, 'ok'); await open(project.id); }
    catch (e) { notice(e.message, 'bad'); if (e.data && e.data.error === 'fingerprint_mismatch') open(current.id); }
  }
  $('#detail').onclick = e => {
    const t = e.target;
    if (t.dataset.do === 'save') return act('/package', { caption: $('#cap').value, cta: $('#cta').value, account: $('#acct').value,
      scheduledLocal: $('#when').value || null }, 'נשמר. אם היה אישור — הוא בוטל ויש לאשר מחדש.', 'PATCH');
    if (t.dataset.do === 'retry') return act('/retry', {}, 'העריכה חזרה לתור.');
    if (t.dataset.do === 'pvframe') { const vid = $('#mainvid'); if (vid && vid.readyState >= 2) { pvSource = vid; drawPreview(); } else notice('הסרטון עדיין לא נטען — נגן/י אותו רגע ונסה/י שוב.', 'warn'); return; }
    if (t.dataset.do === 'revise') {
      const c = collect(), note = draft.note.trim();
      if (!c.caption_edits.length && !c.zoom_edits.length && !Object.keys(c.style_overrides).length && !note) return notice('לא סומן שום תיקון.', 'warn');
      if (note && !draft.scope) return notice('יש לבחור אם ההערה היא תיקון לפרויקט הזה או כלל קבוע.', 'warn');
      const by = who(); if (!by) return;
      if (note && draft.scope === 'permanent' && !confirm('ההערה תישמר ככלל קבוע ותישלח לכל העריכות הבאות, בכל הפרויקטים. להמשיך?')) return;
      const body = { by, ...(c.caption_edits.length ? { caption_edits: c.caption_edits } : {}), ...(c.zoom_edits.length ? { zoom_edits: c.zoom_edits } : {}),
        ...(Object.keys(c.style_overrides).length ? { style_overrides: c.style_overrides } : {}), ...(note ? { note, note_scope: draft.scope } : {}) };
      return act('/revise', body, 'הגרסה המתוקנת נכנסה לתור. הגרסה הקודמת נשמרה להשוואה.');
    }
    if (t.dataset.do === 'profile') {
      const by = who(); if (!by) return;
      if (!confirm('לאשר את הפרופיל שבו נערכה הגרסה הזו כברירת מחדל לכל הפרויקטים הבאים?')) return;
      return api(`/profiles/${encodeURIComponent(t.dataset.pid)}/approve`, { method: 'POST', body: { projectId: current.id, version: current.version.n, by } })
        .then(() => notice('הפרופיל אושר כברירת מחדל. הוא יישלח עם העריכות הבאות.', 'ok')).catch(err => notice(err.message, 'bad'));
    }
    if (t.dataset.cmp) {
      const n = t.dataset.cmp, box = $('#cmpbox'), cv = $('#cmp');
      box.classList.remove('hidden'); $('#cmplabel').textContent = `גרסה ${n} — להשוואה`;
      cv.src = `${API}/projects/${current.id}/versions/${n}/video`; cv.poster = `${API}/projects/${current.id}/versions/${n}/cover`;
      box.scrollIntoView({ block: 'center' }); return;
    }
    if (t.dataset.do === 'pubschedule') {
      if (current.publication.mode !== 'mock' && !confirm(`לתזמן פרסום אמיתי באינסטגרם?\nחשבון: @${current.version.destination.account}\nמועד: ${current.version.scheduledLocal} שעון ישראל\nאפשר לבטל עד רגע הפרסום.`)) return;
      return act('/publish', {}, 'הפרסום תוזמן.');
    }
    if (t.dataset.do === 'pubcancel') return act('/publish/cancel', {}, 'הפרסום המתוזמן בוטל.');
    if (t.dataset.play) {
      const [t0, t1] = t.dataset.play.split(',').map(Number), vid = $('#mainvid') || $('#detail video');
      vid.scrollIntoView({ block: 'center' });
      const stop = () => { if (vid.currentTime >= t1) { vid.pause(); vid.removeEventListener('timeupdate', stop); } };
      vid.addEventListener('timeupdate', stop); vid.currentTime = t0; vid.play();
      return;
    }
    if (t.dataset.do === 'confirm') {
      if (!$('#watched').checked) return notice('יש לסמן שצפית והקשבת לקטעים.', 'warn');
      const by = who(); if (!by) return;
      return act('/review-confirm', { ids: current.version.unresolved.map(u => u.id), by, note: $('#rnote').value, watched: true }, 'כל הפריטים אושרו יחד ונרשמו.');
    }
    if (t.dataset.ex) {
      const reason = prompt(`חריגה עבור "${t.dataset.ex}"\nלמה לאשר למרות שהבדיקה נכשלה? (לפחות 10 תווים — נשמר בהיסטוריה)`);
      if (reason === null) return; const by = who(); if (!by) return;
      return act('/exceptions', { id: t.dataset.ex, reason, by }, 'החריגה תועדה.');
    }
    if (t.dataset.consent) {
      const by = who(); if (!by) return;
      const note = prompt(t.dataset.consent === 'confirmed' ? 'איך ניתנה ההסכמה? (למשל: הודעת וואטסאפ מתאריך…)' : 'הערה (לא חובה):') ?? '';
      return act('/consent', { status: t.dataset.consent, note, by }, 'סטטוס ההסכמה תועד.');
    }
  };
  $('#actions').onclick = e => {
    const a = e.target.dataset.act; if (!a || !current) return;
    const v = current.version;
    if (a === 'approve') { const by = who(); if (!by) return;
      if (!confirm(`לאשר את גרסה ${v.n} בדיוק כפי שהיא מוצגת?\nסרטון, קאבר, קפשן, יעד ומועד.`)) return;
      return act('/approve', { fingerprint: v.fingerprint, by }, 'החבילה אושרה. האישור תקף לגרסה הזו בלבד.'); }
    if (a === 'changes') { const note = prompt('מה לשנות?'); if (!note) return; return act('/request-changes', { note }, 'בקשת השינוי נשמרה.'); }
    if (a === 'reschedule') { const cur = $('#when') && $('#when').value; const val = prompt('מועד חדש בשעון ישראל (YYYY-MM-DD HH:MM):', cur ? cur.replace('T', ' ') : '');
      if (!val) return; const loc = val.trim().replace(' ', 'T'); if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(loc)) return notice('תאריך לא תקין', 'bad');
      const keep = v.approvalValid && confirm('התוכן כבר אושר. להשאיר אותו מאושר עם המועד החדש?');
      return act('/reschedule', { scheduledLocal: loc, keepApproval: keep, by: keep ? who() : undefined }, 'המועד עודכן.'); }
    if (a === 'reject') { const reason = prompt('סיבת הדחייה:'); if (reason === null) return; return act('/reject', { reason }, 'החבילה נדחתה.'); }
  };

  const id = location.hash.slice(1);
  (id ? open(id) : loadList()).catch(e => notice(e.message, 'bad'));
  setInterval(() => { if (!current) loadList().catch(() => {}); }, 8000);
})();
