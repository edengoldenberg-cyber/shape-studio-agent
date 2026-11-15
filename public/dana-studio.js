'use strict';
/* Dana studio — mobile review page. Talks only to /api/dana/studio/*. */
(() => {
  const $ = s => document.querySelector(s);
  const API = '/api/dana/studio';
  const csrf = () => { const m = /(?:^|;\s*)ss_csrf=([^;]+)/.exec(document.cookie); return m ? decodeURIComponent(m[1]) : null; };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = iso => iso ? new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—';
  let current = null, timer = null, me = '';
  try { me = localStorage.getItem('dana_reviewer') || ''; } catch { /* private mode */ }

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {}; const t = csrf();
    if (method !== 'GET' && t) headers['X-CSRF-Token'] = t;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    if (r.status === 401) { location.href = '/login.html'; throw new Error('נדרשת התחברות'); }
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
    if (!worker.online && projects.some(p => p.status === 'editing')) notice('עובד העריכה במחשב לא מחובר. העריכות ממתינות בתור וימשיכו כשהוא יחזור.', 'warn');
  }

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
      if (x.status === 401) return (location.href = '/login.html');
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
      h.push(`<div class="card"><h2>הסרטון הסופי</h2><video controls playsinline preload="metadata" poster="${base}/cover" src="${base}/video"></video>
        <div class="small mute" style="margin-top:6px">${pkg.duration}s · מקור ${pkg.segment.in_s}–${pkg.segment.out_s}s · בחירה: ${esc(pkg.adapter)} · נערך ב-${Math.round(pkg.totalSeconds)}s</div></div>`);
      if (pkg.segment.reason) h.push(`<div class="card"><h2>למה הקטע הזה</h2>
        ${pkg.revisionNote ? `<div class="pill info">מה השתנה בגרסה הזו</div><div class="quote">${esc(pkg.revisionNote)}</div>` : ''}
        <div>${esc(pkg.segment.reason)}</div>
        ${pkg.segment.complete_thought ? `<label>המחשבה השלמה</label><div>${esc(pkg.segment.complete_thought)}</div>` : ''}
        ${pkg.segment.audience_relevance ? `<label>למה זה חשוב לקהל</label><div>${esc(pkg.segment.audience_relevance)}</div>` : ''}
        ${pkg.considered.length ? `<details class="small"><summary>חלופות שנשקלו (${pkg.considered.length})</summary><ul class="plain">${pkg.considered.map(c => `<li>${c.in_s}–${c.out_s}s: ${esc(c.why_not)}</li>`).join('')}</ul></details>` : ''}
        ${pkg.usage ? `<div class="small mute" style="margin-top:6px">נבחר על ידי ${esc(pkg.usage.calls.map(c => c.models_used.join('+') || c.model_requested).join(', '))} · ${pkg.usage.calls.length} קריאות · ${pkg.usage.calls.reduce((t, c) => t + (c.elapsed_s || 0), 0).toFixed(0)}s · עלות מדווחת $${pkg.usage.calls.reduce((t, c) => t + (c.cost_usd_reported || 0), 0).toFixed(3)}</div>` : ''}</div>`);
      h.push(`<div class="card"><h2>קאבר</h2><img class="cover" alt="קאבר" src="${base}/cover"><div class="small mute" style="margin-top:6px">טקסט: ${esc(pkg.cover.text || '— ללא —')}</div></div>`);

      h.push(`<div class="card"><h2>קפשן ו-CTA</h2>
        ${v.caption.isDraft ? '<div class="pill warn">טיוטה — אין פרופיל קול מאושר</div>' : ''}
        <label for="cap">הקפשן המדויק שיפורסם</label><textarea id="cap">${esc(v.caption.text)}</textarea>
        <label for="cta">קריאה לפעולה (CTA)</label><input type="text" id="cta" value="${esc(v.caption.cta || '')}" placeholder="לא הוגדר — לא יפורסם CTA">
        <label for="acct">חשבון יעד · ${esc(v.destination.platform)} / ${esc(v.destination.format)}</label><input type="text" id="acct" value="${esc(v.destination.account || '')}" placeholder="חשבון היעד לא הוגדר">
        <label for="when">מועד פרסום</label><input type="datetime-local" id="when" value="${v.scheduledAt ? new Date(new Date(v.scheduledAt) - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}">
        <button data-do="save" style="margin-top:10px">שמירת שינויים</button>
        <p class="small mute">שינוי בקפשן, ב-CTA, ביעד או במועד מבטל אישור קיים.</p></div>`);

      h.push(`<div class="card"><h2>מה נאמר בסרטון (ציטוט מדויק)</h2><div class="quote">${esc(pkg.spokenText)}</div></div>`);

      const open = v.unresolved;
      const KIND = { timing: 'תזמון', text: 'איות', acoustic: 'שמיעה', technical: 'טכני', content: 'תוכן' };
      const VERD = { suspected_false_positive: ['כנראה אזעקת שווא', 'info'], confirmed: ['כשל מאומת', 'bad'], needs_reading: ['לקרוא', 'warn'],
        needs_listening: ['להאזין', 'warn'], needs_decision: ['להחליט', 'warn'] };
      h.push(`<div class="card" id="review"><h2>${open.length ? `<span class="bad">לבדיקה שלך: ${open.length} פריטים</span>` : '<span class="ok">אין פריטים פתוחים לבדיקה</span>'}</h2>
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

    h.push(`<div class="card"><h2>פרסום</h2><div class="pill ${p.publication.allowed ? 'ok' : 'bad'}">${p.publication.allowed ? 'מותר' : 'חסום'}</div>
      <ul class="plain small">${p.publication.blocked.map(b => `<li>${esc(b.message)}</li>`).join('')}</ul>
      <p class="small mute">בשלב הזה אין חיבור לאינסטגרם ושום דבר לא מתפרסם.</p></div>`);

    if (v && v.approval) h.push(`<div class="card"><h2 class="${v.approvalValid ? 'ok' : 'bad'}">${v.approvalValid ? 'אושר' : 'האישור אינו תקף (התוכן השתנה)'}</h2>
      <div class="small mute">${esc(v.approval.by)} · ${fmt(v.approval.at)} · טביעת גרסה <code>${esc(v.approval.fingerprint.slice(0, 16))}…</code></div></div>`);

    const H = { uploaded: 'הועלה', duplicate_upload: 'העלאה כפולה זוהתה', edit_queued: 'עריכה נכנסה לתור', job_leased: 'העובד התחיל', job_released: 'עריכה הוחזרה לתור',
      job_failed: 'עריכה נכשלה', package_ready: 'חבילה מוכנה', package_edited: 'החבילה נערכה', approval_invalidated: 'האישור בוטל', approved: 'אושר',
      changes_requested: 'התבקשו שינויים', rejected: 'נדחה', consent_recorded: 'הסכמה תועדה', exception_recorded: 'חריגה תועדה', review_confirmed: 'פריטי הבדיקה אושרו' };
    h.push(`<div class="card"><details><summary><b>היסטוריה וגרסאות</b></summary>
      <div class="small">${p.versions.map(x => `גרסה ${x.n}: ${(STATUS[x.status] || [x.status])[0]}${x.changeRequest ? ' — "' + esc(x.changeRequest) + '"' : ''}`).join('<br>')}</div>
      <ul class="plain small">${p.history.slice().reverse().map(e => `<li>${fmt(e.at)} · ${esc(e.actor)} · <b>${esc(H[e.action] || e.action)}</b>${e.detail && (e.detail.note || e.detail.reason || e.detail.code) ? ' — ' + esc(e.detail.note || e.detail.reason || e.detail.code) : ''}</li>`).join('')}</ul></details></div>`);

    $('#detail').innerHTML = h.join('');
    const reviewable = pkg && ['ready_for_review', 'approved'].includes(v.status);
    $('#actions').classList.toggle('hidden', !reviewable);
    if (reviewable) $('#actions [data-act=approve]').disabled = v.unresolved.length > 0 || v.approvalValid;
  }

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
      scheduledAt: $('#when').value ? new Date($('#when').value).toISOString() : null }, 'נשמר. אם היה אישור — הוא בוטל ויש לאשר מחדש.', 'PATCH');
    if (t.dataset.do === 'retry') return act('/retry', {}, 'העריכה חזרה לתור.');
    if (t.dataset.play) {
      const [t0, t1] = t.dataset.play.split(',').map(Number), vid = $('#detail video');
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
    if (a === 'reschedule') { const cur = $('#when') && $('#when').value; const val = prompt('מועד חדש (YYYY-MM-DD HH:MM):', cur ? cur.replace('T', ' ') : '');
      if (!val) return; const d = new Date(val.replace(' ', 'T')); if (isNaN(d)) return notice('תאריך לא תקין', 'bad');
      const keep = v.approvalValid && confirm('התוכן כבר אושר. להשאיר אותו מאושר עם המועד החדש?');
      return act('/reschedule', { scheduledAt: d.toISOString(), keepApproval: keep, by: keep ? who() : undefined }, 'המועד עודכן.'); }
    if (a === 'reject') { const reason = prompt('סיבת הדחייה:'); if (reason === null) return; return act('/reject', { reason }, 'החבילה נדחתה.'); }
  };

  const id = location.hash.slice(1);
  (id ? open(id) : loadList()).catch(e => notice(e.message, 'bad'));
  setInterval(() => { if (!current) loadList().catch(() => {}); }, 8000);
})();
