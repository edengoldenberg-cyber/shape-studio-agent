/* tomer-manage.js — Tomer's member-management board and the owner's tasks waiting for his confirmation.
 *
 * Both screens read real data and say where it came from and when. An empty list is never shown in place of data that
 * could not be read: "אין מנויים מתאימים", "לא נטען", "חסרה הרשאה" and "תקלה בסנכרון" are four different messages.
 * A refresh keeps the search text, the chosen group, the open member card, what was typed in it, and the scroll position.
 * Uses esc() / toast() / post() from app.js and tomer-panel.js.
 */
(() => {
  const $ = id => document.getElementById(id);
  const dmy = iso => { if (!iso) return '—'; const s = String(iso).slice(0, 10).split('-'); return s.length === 3 ? `${s[2]}.${s[1]}.${s[0]}` : String(iso); };
  const hm = iso => { const t = iso ? new Date(iso) : null; return t && !isNaN(t) ? t.toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'; };
  const getJson = async url => { const r = await fetch(url); let j = null; try { j = await r.json(); } catch { /* not JSON */ } return { status: r.status, body: j }; };

  /* ═══ Members board ═══════════════════════════════════════════════════════ */
  const MB = { data: null, group: 'active', q: '', openId: null, cards: new Map(), loading: false };
  const STATE_HE = {
    not_loaded:    ['לא נטען', 'הנתונים לא נקראו מ-Arbox. לנסות "רענון מ-Arbox"; אם זה חוזר — Arbox אינו עונה.'],
    no_permission: ['חסרה הרשאה', 'Arbox דחה את הקריאה (הרשאה / מפתח API). לבדוק את מפתח ה-API של Arbox.'],
    sync_error:    ['תקלה בסנכרון', 'הקריאה מ-Arbox נכשלה באמצע. לנסות שוב בעוד כמה דקות.'],
  };

  async function loadBoard({ fresh = false } = {}) {
    if (MB.loading) return;
    MB.loading = true;
    const st = $('tw-mb-state'); const btn = $('tw-mb-refresh');
    if (btn) btn.disabled = true;
    if (st && !MB.data) st.innerHTML = '<div class="tw-empty" data-state="loading">טוען מנויים מ-Arbox…</div>';
    const y = window.scrollY;
    try {
      const { status, body } = await getJson('/api/tomer/members-board' + (fresh ? '?fresh=1' : ''));
      if (status === 401) { MB.data = { ok: false, state: 'no_session', error: 'נדרשת התחברות מחדש' }; }
      else MB.data = body ?? { ok: false, state: 'sync_error', error: `תשובה לא תקינה מהשרת (${status})` };
    } catch (e) { MB.data = { ok: false, state: 'sync_error', error: e.message }; }
    MB.loading = false;
    if (btn) btn.disabled = false;
    renderBoard();
    window.scrollTo(0, y);
  }

  function renderBoard() {
    const d = MB.data, st = $('tw-mb-state'), gEl = $('tw-mb-groups'), rule = $('tw-mb-rule'), list = $('tw-mb-list'), dec = $('tw-mb-decisions');
    if (!st || !d) return;
    if (!d.ok) {
      const [title, what] = STATE_HE[d.state] ?? ['תקלה', 'לא ניתן להציג את רשימת המנויים.'];
      st.innerHTML = `<div class="tw-state-error" data-state="error" data-why="${esc(d.state ?? '')}" role="alert"><strong>${esc(title)}</strong> — ${esc(what)}${d.error ? `<div class="tw-mb-small">פרטים: ${esc(d.error)}</div>` : ''}</div>`;
      gEl.innerHTML = ''; rule.innerHTML = ''; list.innerHTML = ''; dec.innerHTML = '';
      return;
    }
    st.innerHTML = `<div class="tw-mb-small" data-state="ok">נכון ל-${esc(hm(d.generatedAt))} · ${d.members.length} מנויים ברשימה · מקור: Arbox (קריאה בלבד)</div>`;
    if (!d.groups.some(g => g.id === MB.group)) MB.group = 'active';
    gEl.innerHTML = d.groups.map(g => `<button type="button" class="tw-mb-group${g.id === MB.group ? ' active' : ''}${g.state !== 'ok' ? ' unavailable' : ''}" data-g="${esc(g.id)}" aria-pressed="${g.id === MB.group}">
        <span class="tw-mb-n">${g.state === 'ok' ? g.count : '—'}</span><span class="tw-mb-l">${esc(g.label)}</span>${g.provisional ? '<span class="tw-mb-prov" title="סף זמני — מחכה להחלטה שלך">סף זמני</span>' : ''}</button>`).join('');
    gEl.querySelectorAll('[data-g]').forEach(b => b.addEventListener('click', () => { MB.group = b.dataset.g; renderBoard(); }));
    const g = d.groups.find(x => x.id === MB.group);
    rule.innerHTML = `<div class="tw-mb-rulebox" data-group="${esc(g.id)}"><div><strong>כלל החישוב:</strong> ${esc(g.rule)}</div><div><strong>מקור:</strong> ${esc(g.source)} · <strong>עודכן:</strong> ${esc(hm(g.fetchedAt))}</div>
      ${g.provisional ? `<div class="tw-mb-warn">הסף בכלל הזה זמני ולא אושר. ${esc(g.provisional.ask)}</div>` : ''}</div>`;
    if (g.state !== 'ok') {
      list.innerHTML = `<div class="tw-state-error" data-state="error" role="alert"><strong>לא נטען</strong> — המקור של הקבוצה הזו לא נקרא מ-Arbox, ולכן אין רשימה (זה אינו "אפס מנויים").<div class="tw-mb-small">פרטים: ${esc(g.error ?? '')}</div></div>`;
    } else {
      const q = MB.q.trim().toLowerCase();
      const rows = d.members.filter(m => m.groups.includes(MB.group) && (!q || String(m.name).toLowerCase().includes(q)));
      list.innerHTML = rows.length ? rows.slice(0, 200).map(memberCard).join('') + (rows.length > 200 ? `<div class="tw-mb-small">מוצגים 200 מתוך ${rows.length}. אפשר לצמצם בחיפוש.</div>` : '')
        : `<div class="tw-empty" data-state="empty">${q ? 'אין מנוי בשם הזה בקבוצה הזו.' : 'אין מנויים מתאימים לכלל הזה כרגע.'}</div>`;
      list.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => toggleCard(b.dataset.open)));
      if (MB.openId && MB.cards.has(MB.openId)) fillCard(MB.openId);
    }
    dec.innerHTML = [(d.notes ?? []).length ? `<div class="tw-mb-notes">${d.notes.map(n => `<div>• ${esc(n)}</div>`).join('')}</div>` : '',
      (d.decisions ?? []).length ? `<details class="tw-mb-dec"><summary>החלטות שחסרות ממך (${d.decisions.length})</summary>${d.decisions.map(n => `<div>• ${esc(n)}</div>`).join('')}<div class="tw-mb-small">הספים קובעים רק מי מופיע בכל רשימה. שום הודעה לא נשלחת למנויים מהמסך הזה.</div></details>` : ''].join('');
  }

  const GROUP_HE = { first_month: 'חודש ראשון', not_started: 'לא התחיל להתאמן', expiring: 'עומד להסתיים', expired: 'הסתיים', absent: 'נעדר', declining: 'ירידה בהגעה', frozen: 'בהקפאה', open_requests: 'בקשה פתוחה' };
  function memberCard(m) {
    const ms = m.membership;
    const tags = m.groups.filter(g => GROUP_HE[g]).map(g => `<span class="tw-mb-tag ${esc(g)}">${GROUP_HE[g]}</span>`).join('');
    const att = !m.attendanceKnown ? 'נוכחות: לא נטען' : m.lastAttendance ? `אימון אחרון: ${dmy(m.lastAttendance)} (לפני ${m.daysAbsent} ימים)` : 'אין כניסה ב-30 הימים האחרונים';
    const next = !m.bookingsKnown ? 'רישומים: לא נטען' : m.nextBooking ? `רישום קרוב: ${dmy(m.nextBooking.date)} ${esc(m.nextBooking.time ?? '')}` : 'אין רישום ב-7 הימים הבאים';
    return `<div class="tw-mb-card${MB.openId === String(m.userId) ? ' open' : ''}" data-member="${esc(m.userId)}">
      <div class="tw-mb-card-top"><span class="tw-mb-name">${esc(m.name)}</span>${tags}</div>
      <div class="tw-mb-line">${ms ? `${esc(ms.name ?? 'מנוי')} · ${ms.start ? 'מ-' + dmy(ms.start) : 'תחילה לא ידועה'} ${ms.end ? 'עד ' + dmy(ms.end) : ms.current ? '(בלי תאריך סיום)' : ''}` : 'אין נתוני מנוי'}</div>
      <div class="tw-mb-line">${esc(att)} · ${esc(next)}${m.nextAction ? ` · <strong>${esc(m.nextAction)}</strong>` : ''}</div>
      <button type="button" class="tw-mb-open" data-open="${esc(m.userId)}" aria-expanded="${MB.openId === String(m.userId)}">${MB.openId === String(m.userId) ? 'סגירת הכרטיס' : 'כרטיס לקוח'}</button>
      <div class="tw-mb-detail" id="tw-mb-detail-${esc(m.userId)}"${MB.openId === String(m.userId) ? '' : ' hidden'}></div></div>`;
  }

  async function toggleCard(id) {
    id = String(id);
    if (MB.openId === id) { MB.openId = null; renderBoard(); return; }
    MB.openId = id; renderBoard();
    const box = $(`tw-mb-detail-${id}`);
    if (box && !MB.cards.has(id)) box.innerHTML = '<div class="tw-empty" data-state="loading">טוען כרטיס…</div>';
    try {
      const { body } = await getJson(`/api/tomer/members-board/${encodeURIComponent(id)}`);
      MB.cards.set(id, body ?? { ok: false, error: 'תשובה לא תקינה' });
    } catch (e) { MB.cards.set(id, { ok: false, error: e.message }); }
    if (MB.openId === id) fillCard(id);
  }
  function fillCard(id) {
    const box = $(`tw-mb-detail-${id}`), c = MB.cards.get(id);
    if (!box || !c) return;
    box.hidden = false;
    if (!c.ok) { box.innerHTML = `<div class="tw-state-error" data-state="error" role="alert">לא ניתן לטעון את הכרטיס${c.error ? ` (${esc(c.error)})` : ''}.</div>`; return; }
    const list = (title, items, empty) => `<div class="tw-mb-sec"><h4>${title}</h4>${items.length ? items.join('') : `<div class="tw-mb-small">${empty}</div>`}</div>`;
    box.innerHTML = [
      `<div class="tw-mb-sec"><h4>יתרת כניסות</h4><div class="tw-mb-li" data-entries="${c.entries?.known ? 'known' : 'unknown'}">${c.entries?.known ? `${esc(String(c.entries.left))} כניסות — כפי ש-Arbox ציין ברישום של ${dmy(c.entries.asOf)}` : `לא זמין: ${esc(c.entries?.reason ?? 'לא נקרא')}`}</div></div>`,
      list('מנויים', c.memberships.slice(0, 6).map(x => `<div class="tw-mb-li">${esc(x.name ?? 'מנוי')} · ${dmy(x.start)} – ${x.end ? dmy(x.end) : 'בלי תאריך סיום'} · ${x.cancelled ? 'בוטל' : x.active ? 'פעיל' : 'לא פעיל'}</div>`), 'אין רשומות מנוי.'),
      c.attendance.known ? list(`נוכחות (${esc(c.attendance.window)})`, c.attendance.dates.slice(0, 12).map(x => `<span class="tw-mb-chip">${dmy(x)}</span>`), 'אין כניסה רשומה.') : `<div class="tw-mb-sec"><h4>נוכחות</h4><div class="tw-mb-warn">לא נטען: ${esc(c.attendance.error)}</div></div>`,
      c.upcoming.known ? list(`רישומים קרובים (${esc(c.upcoming.window)})`, c.upcoming.bookings.slice(0, 8).map(x => `<div class="tw-mb-li">${dmy(x.date)} ${esc(x.time ?? '')} · ${esc(x.className ?? x.name ?? 'שיעור')}</div>`), 'אין רישום קרוב.') : `<div class="tw-mb-sec"><h4>רישומים קרובים</h4><div class="tw-mb-warn">לא נטען: ${esc(c.upcoming.error)}</div></div>`,
      list('היסטוריית טיפול', c.history.slice(0, 10).map(x => `<div class="tw-mb-li">${esc(x.kind)} · ${esc(x.what ?? '')} · ${esc(x.status ?? '')} · ${esc(hm(x.at))}${x.resolution ? ` — ${esc(String(x.resolution).slice(0, 120))}` : ''}</div>`), 'אין פניות או משימות רשומות.'),
      `<div class="tw-mb-sec"><h4>הפעולה הבאה</h4><div class="tw-mb-li">${esc(c.nextAction ?? 'אין פעולה פתוחה')}</div></div>`,
    ].join('');
  }

  $('tw-mb-search')?.addEventListener('input', e => { MB.q = e.target.value; if (MB.data?.ok) renderBoard(); });
  // a refresh keeps the search, the chosen group and the open card (its content is read again)
  async function refreshBoard(fresh) { const keep = MB.openId; MB.cards.clear(); await loadBoard({ fresh }); if (keep && MB.data?.ok) { MB.openId = null; await toggleCard(keep); } }
  $('tw-mb-refresh')?.addEventListener('click', () => refreshBoard(true));
  document.querySelector('.tw-tab[data-pane="members"]')?.addEventListener('click', () => { if (!MB.data) loadBoard(); });

  /* ═══ The work board: every open case, task, class request, callback and retention message — once ═══════════════
   * Status, the person on it and the due time are separate. A sent alert is not a delivery and a sent message is not a
   * finished task: each card says what was done, what it waits for and what closes it. The counters of "היום והבא בתור"
   * are the lengths of the very lists they open. A source that was not read is named — its tasks are unknown, not zero. */
  const OT = { data: null, drafts: new Map(), openKey: null, bucket: null, f: { q: '', status: '', type: '', who: '', due: '' }, extra: { roles: null, props: null, ext: null } };
  const ST_HE = { open: 'פתוח', in_progress: 'בטיפול', snoozed: 'נדחה', done: 'בוצע', cancelled: 'בוטל' };
  const ACT_HE = { done: 'בוצע', in_progress: 'בטיפול', snooze: 'נדחה למועד', cancel: 'בוטל', reopen: 'נפתח מחדש', source_closed: 'נסגר במערכת המקור', assign: 'שויך' };
  const BUCKETS = [['needsOwner', 'דורש ממך פעולה'], ['tomerCan', 'אצל תומר / ממתין ללקוח'], ['overdue', 'באיחור'], ['stuck', 'תקוע'], ['planned', 'מתוכנן'], ['recentDone', 'הושלם לאחרונה']];
  const SRC_HE = { cases: 'פניות תומר', tasks: 'משימות ובקשות שיעור', callbacks: 'שיחות חוזרות של ברק', care: 'הודעות שימור' };
  const byName = () => ($('tw-staff-name')?.value ?? '').trim() || 'עדן';

  async function loadOwnerTasks() {
    const box = $('tw-ot-list'); if (!box) return;
    if (!OT.data) box.innerHTML = '<div class="tw-empty" data-state="loading">טוען את לוח המשימות…</div>';
    const y = window.scrollY;
    try { const { status, body } = await getJson('/api/tomer/board'); OT.data = status === 200 && body?.ok ? body : { ok: false, state: body?.state ?? 'sync_error', error: body?.error ?? `שגיאה ${status}` }; }
    catch (e) { OT.data = { ok: false, state: 'not_loaded', error: e.message }; }
    renderOwnerTasks();
    window.scrollTo(0, y);
  }

  function matches(t) {
    const f = OT.f, d = OT.data;
    if (OT.bucket && !(d.today[OT.bucket] ?? []).includes(t.key)) return false;
    if (f.q && !`${t.who ?? ''} ${t.title ?? ''} ${t.reason ?? ''}`.includes(f.q.trim())) return false;
    if (f.status && t.board !== f.status) return false;
    if (f.type && t.kind !== f.type) return false;
    if (f.who && (t.assignee ?? '') !== f.who) return false;
    if (f.due === 'overdue' && !t.overdue) return false;
    if (f.due === 'today' && !(t.dueSetAt && new Date(t.dueSetAt).toDateString() === new Date().toDateString())) return false;
    if (f.due === 'later' && !(t.dueSetAt && new Date(t.dueSetAt) > new Date())) return false;
    return true;
  }

  function renderOwnerTasks() {
    const d = OT.data, box = $('tw-ot-list'), head = $('tw-ot-status'), tiles = $('tw-bd-today');
    if (!box || !d) return;
    if (!d.ok) {
      box.innerHTML = `<div class="tw-state-error" data-state="error" role="alert"><strong>${d.state === 'not_loaded' ? 'לא נטען' : 'תקלה בסנכרון'}</strong> — לוח המשימות לא נקרא (${esc(d.error ?? '')}). זה אינו "אין משימות".</div>`;
      head.innerHTML = ''; if (tiles) tiles.innerHTML = ''; return;
    }
    const r = d.reminders, s = d.settings;
    const bad = Object.entries(d.sources ?? {}).filter(([k, v]) => v && v.ok === false && !(k === 'care' && v.error === 'לא מחובר'));
    head.innerHTML = `${bad.length ? `<div class="tw-state-error" data-state="partial" role="alert"><strong>לא נטען:</strong> ${bad.map(([k, v]) => `${esc(SRC_HE[k] ?? k)} (${esc(v.error ?? '')})`).join(' · ')}. המספרים למטה חלקיים — הם אינם "אפס".</div>` : ''}
      <div class="tw-ot-rem ${esc(r.state)}" data-reminders="${esc(r.state)}"><strong>תזכורות אליך:</strong> ${esc(r.text)} · אחרונה: ${r.lastAt ? `${esc(hm(r.lastAt))} (${r.lastState === 'sent' ? 'התקבלה אצל ספק השליחה' : r.lastState === 'nothing_due' ? 'לא היה מה להזכיר' : 'לא נשלחה'})` : 'לא נשלחה מעולם'} · הבאה: ${r.nextAt ? esc(r.nextAt) : 'אין — השליחה כבויה'}</div>
      <details class="tw-ot-settings"${r.state === 'needs_settings' ? ' open' : ''}><summary>הגדרת תזכורות</summary>
        <label>שעות שליחה (למשל 09:00, 17:00) <input type="text" id="tw-ot-times" class="field-input" inputmode="numeric" value="${esc((OT.drafts.get('times') ?? s.times.join(', ')))}" placeholder="09:00, 17:00"></label>
        <label>לא להזכיר על אותה משימה יותר מפעם ב- <input type="number" id="tw-ot-gap" class="field-input" min="1" max="168" value="${esc(String(OT.drafts.get('gap') ?? s.minGapHours))}"> שעות</label>
        <label class="tw-ot-check"><input type="checkbox" id="tw-ot-enabled"${(OT.drafts.get('enabled') ?? s.enabled) ? ' checked' : ''}> להפעיל תזכורות</label>
        <div class="tw-mb-small">תזכורת אחת מרוכזת בכל שעה שהוגדרה, רק על משימות שמחכות לך ושמועדן הגיע, לא בשעות השקט ולא בשבת. נשלחת אליך בלבד — לא ללקוחות.</div>
        <button type="button" class="btn btn-secondary" id="tw-ot-save">שמירת ההגדרה</button> <button type="button" class="btn btn-secondary" id="tw-ot-preview">מה תכיל התזכורת הראשונה?</button>
        <pre id="tw-ot-preview-box" class="tw-ot-preview" hidden></pre></details>`;
    for (const [id, k] of [['tw-ot-times', 'times'], ['tw-ot-gap', 'gap']]) $(id)?.addEventListener('input', e => OT.drafts.set(k, e.target.value));
    $('tw-ot-enabled')?.addEventListener('change', e => OT.drafts.set('enabled', e.target.checked));
    $('tw-ot-save')?.addEventListener('click', saveSettings);
    $('tw-ot-preview')?.addEventListener('click', async () => { const { body } = await getJson('/api/owner-tasks/preview'); const p = $('tw-ot-preview-box'); p.hidden = false; p.textContent = body?.text ?? 'אין כרגע משימה שמועדה הגיע — לא תישלח תזכורת.'; });

    // "היום והבא בתור": each number is the length of the list the tile opens
    if (tiles) {
      tiles.innerHTML = BUCKETS.map(([k, label]) => `<button type="button" class="tw-bd-tile${OT.bucket === k ? ' active' : ''}" data-bucket="${k}" aria-pressed="${OT.bucket === k}"><span class="tw-bd-n">${d.today[k].length}${bad.length ? '<small>+?</small>' : ''}</span><span class="tw-bd-l">${label}</span></button>`).join('');
      tiles.querySelectorAll('[data-bucket]').forEach(b => b.addEventListener('click', () => { OT.bucket = OT.bucket === b.dataset.bucket ? null : b.dataset.bucket; renderOwnerTasks(); }));
    }
    // filters keep what was chosen; their options follow the data
    const all = [...d.items, ...d.recentDone];
    const fill = (id, vals, cur, first) => { const el = $(id); if (!el) return; const opts = [`<option value="">${first}</option>`, ...vals.map(([v, l]) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`)].join(''); if (el.dataset.sig !== opts) { el.innerHTML = opts; el.dataset.sig = opts; } el.value = cur; };
    fill('tw-bd-f-status', Object.entries(d.statuses), OT.f.status, 'כל הסטטוסים');
    fill('tw-bd-f-type', [...new Set(all.map(x => x.kind).filter(Boolean))].map(v => [v, v]), OT.f.type, 'כל סוגי הטיפול');
    fill('tw-bd-f-who', [...new Set(all.map(x => x.assignee).filter(Boolean))].map(v => [v, v]), OT.f.who, 'כל האחראים');
    if ($('tw-bd-f-q') && $('tw-bd-f-q').value !== OT.f.q) $('tw-bd-f-q').value = OT.f.q;
    if ($('tw-bd-f-due')) $('tw-bd-f-due').value = OT.f.due;

    const card = t => {
      const open = OT.openKey === t.key, closed = ['done', 'cancelled'].includes(t.state);
      const hist = t.history.slice(-8).reverse().map(h => `<div class="tw-mb-li">${esc(hm(h.at))} · ${esc(h.by ?? '')} · ${esc(ACT_HE[h.action] ?? h.action)}${h.until ? ` עד ${esc(hm(h.until))}` : ''}${h.note ? ` — ${esc(h.note)}` : ''}${h.source ? ` (${esc(h.source)})` : ''}</div>`).join('');
      const trail = (t.trail ?? []).map(x => `<div class="tw-mb-li">${x.at ? esc(hm(x.at)) + ' · ' : ''}${esc(x.text)}</div>`).join('');
      return `<div class="tw-ot-card ${esc(t.state)}${t.overdue ? ' overdue' : ''}" data-task="${esc(t.key)}" data-state="${esc(t.state)}" data-board="${esc(t.board)}">
        <div class="tw-mb-card-top"><span class="tw-mb-name">${esc(t.who ?? '')}</span><span class="tw-mb-tag bd-${esc(t.board)}">${esc(t.boardLabel ?? ST_HE[t.state] ?? t.state)}</span>${t.overdue ? '<span class="tw-mb-tag bd-overdue">באיחור</span>' : ''}</div>
        <div class="tw-mb-line"><b>${esc(t.agent === 'barak' ? 'ברק' : 'תומר')} · ${esc(t.kind ?? '')}:</b> ${esc(t.title ?? '')}</div>
        ${t.blocked ? `<div class="tw-bd-blocked" role="alert">חסום: ${esc(t.blocked)}</div>` : ''}
        <div class="tw-mb-line">אחראי/ת: <b>${esc(t.assignee ?? '—')}</b> · ${t.dueSetAt ? `מועד: ${esc(hm(t.dueSetAt))}` : 'לא נקבע מועד'} · ממתין ${esc(t.waiting)}${t.snoozeReason ? ` · סיבת הדחייה: ${esc(t.snoozeReason)}` : ''}</div>
        ${closed ? '' : `<div class="tw-mb-line tw-bd-next">הבא: ${esc(t.next ?? '—')}</div>`}
        <div class="tw-ot-actions">${closed ? `<button type="button" data-act="reopen">פתיחה מחדש</button>` : `<button type="button" data-act="done" class="primary">בוצע</button><button type="button" data-act="in_progress">בטיפול</button><button type="button" data-act="snooze">דחה למועד</button><button type="button" data-act="cancel">בטל</button>`}
          <button type="button" data-toggle="1" aria-expanded="${open}">${open ? 'סגירה' : 'פרטים'}</button>${t.userId ? `<button type="button" data-member="${esc(String(t.userId))}">כרטיס לקוח</button>` : ''}${t.link ? `<a class="tw-ot-link" href="${esc(t.link)}">למקור</a>` : ''}</div>
        <div class="tw-ot-more"${open ? '' : ' hidden'}>
          <div class="tw-mb-sec"><h4>למה נפתחה</h4><div class="tw-mb-li">${esc(t.reason ?? '—')}</div><div class="tw-mb-li">מקור: ${esc(t.source ?? '—')} · נפתחה: ${esc(hm(t.createdAt))}</div></div>
          <div class="tw-mb-sec"><h4>מה בוצע עד עכשיו</h4>${trail || '<div class="tw-mb-small">עדיין לא בוצע דבר.</div>'}</div>
          <div class="tw-mb-sec"><h4>מה סוגר את המשימה</h4><div class="tw-mb-li">${esc(t.closeRule ?? '—')}</div></div>
          ${closed ? '' : `<label>הערה / סיבה <input type="text" class="field-input" data-note maxlength="300" value="${esc(OT.drafts.get('note:' + t.key) ?? '')}"></label>
          <label>דחייה עד <input type="datetime-local" class="field-input" data-until value="${esc(OT.drafts.get('until:' + t.key) ?? '')}"></label>
          <label>אחראי/ת <span class="tw-bd-assign"><input type="text" class="field-input" data-assignee maxlength="40" value="${esc(OT.drafts.get('to:' + t.key) ?? t.assignee ?? '')}"><button type="button" data-act="assign">שיוך</button></span></label>`}
          <div class="tw-mb-sec"><h4>היסטוריית שינויים</h4>${hist || '<div class="tw-mb-small">אין עדיין פעולות.</div>'}</div></div></div>`;
    };
    const pool = OT.bucket === 'recentDone' ? d.recentDone : d.items;
    const shown = pool.filter(matches);
    const filtered = OT.bucket || Object.values(OT.f).some(Boolean);
    box.innerHTML = `<div class="tw-mb-small" id="tw-bd-count">מוצגות ${shown.length} מתוך ${pool.length}${OT.bucket ? ` · ${BUCKETS.find(b => b[0] === OT.bucket)[1]}` : ''}${filtered ? ' · <button type="button" class="tw-bd-clear" id="tw-bd-clear">ניקוי הסינון</button>' : ''} · עודכן ${esc(hm(d.generatedAt))}</div>`
      + (shown.length ? shown.map(card).join('') : `<div class="tw-empty" data-state="empty">${pool.length ? 'אין משימה שמתאימה לסינון.' : (OT.bucket === 'recentDone' ? 'לא נסגרה משימה ב-7 הימים האחרונים.' : 'אין משימה פתוחה.')}</div>`)
      + (!OT.bucket && d.recentDone.length ? `<details class="tw-ot-closed"><summary>הושלמו לאחרונה (${d.recentDone.length})</summary>${d.recentDone.filter(matches).map(card).join('')}</details>` : '');
    $('tw-bd-clear')?.addEventListener('click', () => { OT.bucket = null; OT.f = { q: '', status: '', type: '', who: '', due: '' }; renderOwnerTasks(); });
    box.querySelectorAll('.tw-ot-card').forEach(el => {
      const key = el.dataset.task;
      el.querySelector('[data-note]')?.addEventListener('input', e => OT.drafts.set('note:' + key, e.target.value));
      el.querySelector('[data-until]')?.addEventListener('input', e => OT.drafts.set('until:' + key, e.target.value));
      el.querySelector('[data-assignee]')?.addEventListener('input', e => OT.drafts.set('to:' + key, e.target.value));
      el.querySelector('[data-toggle]')?.addEventListener('click', () => { OT.openKey = OT.openKey === key ? null : key; renderOwnerTasks(); });
      el.querySelector('[data-member]')?.addEventListener('click', e => openMember(e.currentTarget.dataset.member));
      el.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => act(key, b.dataset.act, el)));
    });
    const badge = document.getElementById('tw-badge-tasks'); if (badge) badge.textContent = d.today.needsOwner.length ? String(d.today.needsOwner.length) : '';
  }

  /** From a task to the member's card in the members board. */
  async function openMember(userId) {
    document.querySelector('.tw-tab[data-pane="members"]')?.click();
    if (!MB.data?.ok) await loadBoard();
    if (!MB.data?.ok) return;
    const m = MB.data.members.find(x => String(x.userId) === String(userId));
    if (!m) { toast('ללקוח/ה הזה/ו אין כרטיס בלוח החברים (אינו/ה מנוי פעיל, או חבר/ת מועדון חיצוני).', false); return; }
    MB.group = m.groups[0] ?? 'active'; MB.q = ''; if ($('tw-mb-search')) $('tw-mb-search').value = '';
    renderBoard();
    if (MB.openId !== String(userId)) await toggleCard(String(userId));
    document.querySelector(`#tw-mb-list .tw-mb-card[data-member="${CSS.escape(String(userId))}"]`)?.scrollIntoView({ block: 'start' });
  }

  async function act(key, action, el) {
    const note = OT.drafts.get('note:' + key) ?? '', untilRaw = OT.drafts.get('until:' + key) ?? '', to = (OT.drafts.get('to:' + key) ?? el.querySelector('[data-assignee]')?.value ?? '').trim();
    const focus = sel => { OT.openKey = key; renderOwnerTasks(); document.querySelector(`.tw-ot-card[data-task="${CSS.escape(key)}"] ${sel}`)?.focus(); };
    if (action === 'snooze' && !untilRaw) { toast('לבחור תאריך ושעה לדחייה (בשדה "דחייה עד")', false); focus('[data-until]'); return; }
    if (action === 'snooze' && !note.trim()) { toast('לכתוב את סיבת הדחייה (בשדה "הערה / סיבה")', false); focus('[data-note]'); return; }
    if (action === 'assign' && !to) { toast('לכתוב את שם האחראי/ת', false); focus('[data-assignee]'); return; }
    el.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      const d = await post('/api/owner-tasks/act', { key, action, by: byName(), note: note || null, until: action === 'snooze' ? new Date(untilRaw).toISOString() : null, to: action === 'assign' ? to : null });
      if (!d.ok) throw new Error(d.error === 'snooze_needs_future_time' ? 'מועד הדחייה צריך להיות בעתיד' : (d.error ?? 'הפעולה נכשלה'));
      for (const k of ['note:', 'until:', 'to:']) OT.drafts.delete(k + key);
      toast(`נרשם: ${ACT_HE[action] ?? action}`);
      await loadOwnerTasks();
    } catch (e) { toast(`❌ ${e.message}`, false); el.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
  }

  async function saveSettings() {
    const times = String($('tw-ot-times')?.value ?? '').split(/[,\s]+/).filter(Boolean), bad = times.filter(t => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t));
    if (bad.length) { toast(`שעה לא תקינה: ${bad.join(', ')} (הפורמט: 09:00)`, false); return; }
    try {
      const d = await post('/api/owner-tasks/settings', { times, minGapHours: Number($('tw-ot-gap')?.value) || 20, enabled: !!$('tw-ot-enabled')?.checked, by: byName() });
      if (!d.ok) throw new Error(d.error === 'times_required' ? 'כדי להפעיל צריך לפחות שעת שליחה אחת' : (d.error ?? 'השמירה נכשלה'));
      OT.drafts.delete('times'); OT.drafts.delete('gap'); OT.drafts.delete('enabled');
      toast('✅ ההגדרה נשמרה');
      await loadOwnerTasks();
    } catch (e) { toast(`❌ ${e.message}`, false); }
  }

  /* ── what was only proposed, what Tomer does role by role, and the outside-club members (loaded when opened) ── */
  const errBox = (b, what) => `<div class="tw-state-error" data-state="error" role="alert"><strong>לא נטען</strong> — ${what} (${esc(b?.error ?? '')}). זה אינו "אין נתונים".</div>`;
  async function loadExtra(kind, url, boxId, render) {
    const box = $(boxId); if (!box) return;
    if (!OT.extra[kind]) box.innerHTML = '<div class="tw-empty" data-state="loading">טוען…</div>';
    try { const { status, body } = await getJson(url); OT.extra[kind] = status === 200 && body?.ok ? body : { ok: false, error: body?.error ?? `שגיאה ${status}` }; }
    catch (e) { OT.extra[kind] = { ok: false, error: e.message }; }
    box.innerHTML = OT.extra[kind].ok ? render(OT.extra[kind]) : errBox(OT.extra[kind], 'הנתונים לא נקראו');
  }
  const renderProps = p => `<div class="tw-mb-small">${esc(p.note)}</div>` + p.programs.map(x => `<div class="tw-bd-prop" data-prop="${esc(x.id)}" data-state="${esc(x.state)}">
      <div class="tw-mb-card-top"><span class="tw-mb-name">${esc(x.label)}</span><span class="tw-mb-tag bd-${x.state === 'approved_active' ? 'in_progress' : x.state === 'proposal' ? 'planned' : 'blocked'}">${esc(x.stateLabel ?? 'לא נטען')}</span></div>
      ${x.state === 'not_loaded' ? `<div class="tw-bd-blocked">לא נטען: ${esc(x.error ?? (x.blocks ?? []).join(' · '))}</div>` : `<div class="tw-mb-line">מועמדים היום: <b>${x.candidates}</b> מתוך ${x.totalActive} מנויים פעילים · מקור: ${esc(x.source)} · נכון ל-${esc(dmy(x.today))}</div>
      <div class="tw-mb-line">כלל: ${esc(x.rule)}</div>
      ${x.blocks.length ? `<div class="tw-bd-blocked">למה לא נשלח: ${x.blocks.map(esc).join(' · ')}</div>` : ''}
      ${x.sample.length ? `<details><summary>מי המועמדים (${x.sample.length}${x.candidates > x.sample.length ? ' ראשונים' : ''})</summary>${x.sample.map(m => `<div class="tw-mb-li">${esc(m.name ?? '—')} ${esc(m.phone ?? '')}${m.why ? ` — ${esc(m.why)}` : ''}</div>`).join('')}</details>` : ''}
      ${x.excluded.length ? `<div class="tw-mb-small">לא נכללו: ${x.excluded.map(e => `${esc(e.text)} (${e.count})`).join(' · ')}</div>` : ''}`}</div>`).join('');
  const renderRoles = r => r.rows.map(x => `<div class="tw-bd-role" data-role="${esc(x.id)}" data-state="${esc(x.state)}">
      <div class="tw-mb-card-top"><span class="tw-mb-name">${esc(x.label)}</span><span class="tw-mb-tag bd-${x.state === 'active' ? 'in_progress' : x.state === 'partial' ? 'waiting_member' : x.state === 'ready_off' ? 'planned' : 'blocked'}">${esc(x.stateLabel)}</span></div>
      <div class="tw-mb-li"><b>ממומש:</b> ${esc(x.implemented)}</div><div class="tw-mb-li"><b>פעיל למי:</b> ${esc(x.activeFor)}</div><div class="tw-mb-li"><b>אומת חי:</b> ${esc(x.live)}</div>
      ${x.blocked ? `<div class="tw-mb-li"><b>חסום:</b> ${esc(x.blocked)}</div>` : ''}${x.missing ? `<div class="tw-mb-li"><b>חסר:</b> ${esc(x.missing)}</div>` : ''}</div>`).join('');
  const renderExt = x => `<div class="tw-mb-line"><b>${x.count}</b> חברי מועדון חיצוני · כלל: ${esc(x.rule)} · מקור: ${esc(x.source)} · עודכן: ${esc(hm(x.fetchedAt))}</div>
      ${x.attendance?.known ? `<div class="tw-mb-line" data-ext-att="known">נוכחות (עודכן ${esc(hm(x.attendance.fetchedAt))}): התאמנו ב-7 הימים האחרונים <b>${x.attendance.trainedLast7}</b> · 7 ימים ומעלה בלי אימון <b>${x.attendance.absent7plus}</b> · בלי כניסה ב-30 יום <b>${x.attendance.noCheckin30}</b></div><div class="tw-mb-small">${esc(x.attendance.rule)}</div>`
        : `<div class="tw-bd-blocked" data-ext-att="unknown">הנוכחות לא נטענה מ-Arbox (${esc(x.attendance?.error ?? '')}) — זה אינו "לא התאמנו".</div>`}
      <div class="tw-mb-sec"><h4>מה זמין להם</h4>${x.available.map(a => `<div class="tw-mb-li">${esc(a)}</div>`).join('')}</div>
      <div class="tw-mb-sec"><h4>מה לא כלול</h4>${x.notAvailable.map(a => `<div class="tw-mb-li">${esc(a)}</div>`).join('')}</div>
      <div class="tw-mb-sec"><h4>ממתין להחלטה שלך</h4>${x.decisions.length ? x.decisions.map(a => `<div class="tw-mb-li">${esc(a)}</div>`).join('') : '<div class="tw-mb-li">אין החלטה פתוחה: מעקב נוכחות בלבד, לפי אישורך.</div>'}</div>
      <details><summary>הרשימה (${x.count})</summary>${x.members.length ? x.members.map(m => `<div class="tw-mb-li">${esc(m.name)} ${esc(m.phone)} · ${!x.attendance?.known ? 'נוכחות לא נטענה' : m.lastAttendance ? `אימון אחרון ${esc(dmy(m.lastAttendance))} (לפני ${m.daysAbsent} ימים)` : 'אין כניסה ב-30 הימים האחרונים'}</div>`).join('') : '<div class="tw-mb-small">אין חברי מועדון חיצוני ב-Arbox.</div>'}</details>`;
  const extraDefs = [['props', '/api/tomer/board/proposals', 'tw-bd-props-box', renderProps, 'tw-bd-props'], ['roles', '/api/tomer/board/roles', 'tw-bd-roles-box', renderRoles, 'tw-bd-roles'], ['ext', '/api/tomer/members-external', 'tw-mb-external-box', renderExt, 'tw-mb-external']];
  for (const [kind, url, boxId, render, detailsId] of extraDefs) $(detailsId)?.addEventListener('toggle', e => { if (e.target.open) loadExtra(kind, url, boxId, render); });
  const reloadOpenExtras = () => { for (const [kind, url, boxId, render, detailsId] of extraDefs) if ($(detailsId)?.open) loadExtra(kind, url, boxId, render); };

  for (const [id, k] of [['tw-bd-f-q', 'q'], ['tw-bd-f-status', 'status'], ['tw-bd-f-type', 'type'], ['tw-bd-f-who', 'who'], ['tw-bd-f-due', 'due']])
    $(id)?.addEventListener(id === 'tw-bd-f-q' ? 'input' : 'change', e => { OT.f[k] = e.target.value; if (OT.data?.ok) renderOwnerTasks(); });
  // a link like #tomer/board or #tomer/members opens that pane directly
  const openFromHash = () => { const m = /^#tomer\/(board|tasks|members)$/.exec(location.hash); if (!m) return; document.querySelector('.tab-btn[data-tab="tomer"]')?.click(); setTimeout(() => document.querySelector(`.tw-tab[data-pane="${m[1] === 'members' ? 'members' : 'tasks'}"]`)?.click(), 60); };
  window.addEventListener('hashchange', openFromHash); setTimeout(openFromHash, 400);

  document.querySelector('.tw-tab[data-pane="tasks"]')?.addEventListener('click', loadOwnerTasks);
  document.getElementById('tw-refresh')?.addEventListener('click', () => {
    const active = document.querySelector('.tw-tab.active')?.dataset.pane;
    if (active === 'tasks') { loadOwnerTasks(); reloadOpenExtras(); }
    if (active === 'members') { refreshBoard(false); reloadOpenExtras(); }
  });
  window.__tomerManage = { loadBoard, loadOwnerTasks };
})();
