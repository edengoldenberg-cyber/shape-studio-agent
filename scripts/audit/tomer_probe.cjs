// Tomer behaviour probe — isolated. Synthetic members, temp DATA_DIR, HTTP mocks for
// Arbox, Green API and OpenAI. Nothing here reaches production or a real provider.
const fs = require('fs');
const path = require('path');
const http = require('http');
const REPO = require('path').join(__dirname, '..', '..').split(require('path').sep).join('/');
const { createIsolatedDataDir, safeExternalEnv, freePort } = require(REPO + '/tests/helpers/isolated_env.cjs');

(async () => {
  const dataDir = createIsolatedDataDir('tomer-probe-');
  fs.writeFileSync(path.join(dataDir, 'studio_assets.json'), JSON.stringify({ wazeUrl: 'https://waze.com/ul?q=TEST' }));

  // ── synthetic Arbox roster (phone formats as seen in production: mostly 05…) ──
  const M = (i, phone, extra = {}) => ({ user_id: 9000 + i, first_name: 'חברה' + i, last_name: 'בדיקה', phone, email: '', active: 1,
    user_role: 'client', membership_start_date: '2026-06-01', membership_end_date: '2026-12-10', gender: 'female', birthday: '1990-03-03', allow_sms: 1, allow_email: 1, ...extra });
  const users = [];
  for (let i = 1; i <= 40; i++) users.push(M(i, '058111' + String(1000 + i)));          // 05… local format
  users.push(M(90, '+972581119090'));                                                  // +972 format
  const today = new Date(); const d = n => new Date(today.getTime() + n * 86400000).toISOString().slice(0, 10);
  const schedule = [];
  for (let day = 0; day < 4; day++) for (const [st, en, nm, tr] of [['07:30', '08:20', 'אימון כח', 'עדן'], ['09:00', '09:50', 'פילאטיס מכשירים', 'מלאני'], ['18:00', '18:50', 'Pilates Barre', 'מירי']])
    schedule.push({ schedule_id: 100 + schedule.length, date: d(day), start_time: st, end_time: en, session_name: nm, max_participants: 8, staff_member: { name: tr }, registration_link: 'https://arbox.example/r/' + schedule.length });

  const sent = []; const aiCalls = []; const arboxCalls = [];
  let aiMode = 'ok';
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', x => b += x);
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/arbox')) {
        arboxCalls.push(req.url.split('?')[0] + '?' + (req.url.split('?')[1] ?? '').replace(/location_id=\d+&?/, ''));
        if (req.url.includes('/v3/users')) {
          const u = new URL('http://x' + req.url); const page = +(u.searchParams.get('page') ?? 1); const lim = +(u.searchParams.get('limit') ?? 200);
          const slice = users.slice((page - 1) * lim, page * lim);
          return res.end(JSON.stringify({ data: slice, extra: { pagination: { next_page_url: page * lim < users.length ? 'x' : null } } }));
        }
        if (req.url.includes('/v3/schedule')) return res.end(JSON.stringify({ data: schedule }));
        return res.end(JSON.stringify({ data: [] }));
      }
      if (req.url.startsWith('/v1/chat/completions')) {
        if (aiMode === 'fail') { res.statusCode = 500; return res.end(JSON.stringify({ error: { message: 'mock outage' } })); }
        const body = JSON.parse(b); aiCalls.push(body);
        return res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '«AI-REPLY»' }, finish_reason: 'stop' }], usage: {} }));
      }
      try { const p = JSON.parse(b); if (p.chatId) sent.push(p); } catch { /* ignore */ }
      res.end(JSON.stringify({ idMessage: 'PROBE' + sent.length }));
    });
  });
  await new Promise(r => srv.listen(port, '127.0.0.1', r));

  Object.assign(process.env, safeExternalEnv(), {
    DATA_DIR: dataDir, KNOWN_MEMBERS_PATH: path.join(dataDir, 'known_members.json'), STAFF_CONFIG_PATH: path.join(dataDir, 'staff_config.json'),
    TEST_NO_BIND: 'true', TEST_MODE: 'false', LOG_SILENT: 'true', LOG_TO_FILE: 'false', NODE_ENV: 'test',
    GREEN_API_URL: `localhost:${port}`, GREEN_API_ID_INSTANCE: '9990003', GREEN_API_TOKEN_INSTANCE: 'mock',
    ARBOX_BASE_URL: `http://localhost:${port}/arbox`, ARBOX_API_KEY: 'mock', ARBOX_CLIENT_ID: 'mock',
    OPENAI_BASE_URL: `http://localhost:${port}/v1`, OPENAI_API_KEY: 'sk-probe',
    WHATSAPP_AUTO_REPLY: 'true', TZ: 'Asia/Jerusalem',
  });
  process.chdir(REPO);
  const request = require(REPO + '/node_modules/supertest');
  const app = require(REPO + '/server.js');
  const store = require(REPO + '/utils/lead_store');
  const tomerStore = require(REPO + '/utils/tomer_store');
  const aptStore = require(REPO + '/utils/appointment_store');
  const registry = require(REPO + '/utils/phone_registry');
  await registry.init({ timeoutMs: 8000 });
  console.log('registry size', registry.size());

  const MGR = '972509000001';
  const phoneOf = i => '97258111' + String(1000 + i);
  let seq = 0;
  async function say(i, text, type = 'text') {
    const from = typeof i === 'number' ? phoneOf(i) : i;
    const s0 = sent.length, a0 = aiCalls.length, t0 = tomerStore.getTasks({}).length;
    const r = await request(app).post('/api/whatsapp/simulate').send({ from, name: 'WA', text, type });
    await new Promise(r2 => setTimeout(r2, 250));
    const news = sent.slice(s0);
    const toMember = news.filter(p => p.chatId === from + '@c.us').map(p => p.message);
    const toMgr = news.filter(p => p.chatId === MGR + '@c.us').map(p => p.message.replace(/\n+/g, ' ⏎ ').slice(0, 170));
    const ai = aiCalls.slice(a0);
    const sys = ai[0]?.messages?.[0]?.content ?? '';
    const ci = sys.lastIndexOf('[MEMBER_CONTEXT]\n');
    const ctx = ci >= 0 ? sys.slice(ci, sys.indexOf('[/MEMBER_CONTEXT]', ci) + 17)
      : (ai.length ? '(no MEMBER_CONTEXT block in this prompt) messages=' + ai[0].messages.length + ' last user msg: ' + JSON.stringify(ai[0].messages.at(-1).content).slice(0, 260) : undefined);
    console.log(`\n#${++seq} [${type}] "${text}"`);
    console.log(`   route=${r.body.route} intent=${r.body.intent} aiCalls=${ai.length}${ai.length ? ' (system prompt ' + ai[0].messages[0].content.length + ' chars)' : ''} newTasks=${tomerStore.getTasks({}).length - t0}`);
    console.log(`   → member: ${toMember.length ? toMember.map(m => JSON.stringify(m.slice(0, 260))).join(' | ') : '(nothing sent)'}`);
    console.log(`   → manager: ${toMgr.length ? toMgr.join(' | ') : '(nothing sent)'}`);
    return { r: r.body, toMember, toMgr, ctx, ai };
  }

  console.log('\n════ A. the three known incidents ════');
  await say(1, 'ביטלתי היום');
  await say(2, 'לא הצלחתי להגיע ולא לבטל');
  console.log('\n════ B. cancellation / booking / schedule ════');
  await say(3, 'לא יכולה להגיע מחר לשיעור');
  await say(4, 'תרשמי אותי למחר ב-9 לפילאטיס');
  const sch = await say(5, 'מה יש מחר?');
  await say(5, 'פילאטיס מכשירים');
  await say(6, 'אולי אעבור לכוח של 7:30 ואז מלאני ב 9:00?');
  await say(7, 'שבץ אותי קבוע בימי שני');
  console.log('\n════ C. membership / billing / app ════');
  const c1 = await say(8, 'כמה כניסות נשארו לי ועד מתי המנוי בתוקף?');
  console.log('   MEMBER_CONTEXT given to the model (05… member):\n' + (c1.ctx ?? '(no AI call)').split('\n').slice(0, 9).map(l => '     ' + l).join('\n'));
  const c2 = await say('972581119090', 'עד מתי המנוי שלי בתוקף?');
  console.log('   MEMBER_CONTEXT given to the model (+972 member):\n' + (c2.ctx ?? '(no AI call)').split('\n').slice(0, 9).map(l => '     ' + l).join('\n'));
  const c3 = await say(9, 'רוצה להקפיא את המנוי מ-1.12 עד 15.12');
  console.log('   CTX05:' + String.fromCharCode(10) + String(c3.ctx).split(String.fromCharCode(10)).map(l => '     ' + l).join(String.fromCharCode(10)));
  console.log('   STAGE HINT: ' + (c3.ai[0].messages[0].content.split(String.fromCharCode(10)).find(l => l.startsWith('[STAGE]')) ?? '(none)'));
  await say(10, 'בוקר טוב לא הבנתי על מה חויבתי, אני כבר חודשיים בהקפאה');
  await say(11, 'חויבתי פעמיים החודש');
  await say(12, 'יכול לבדוק עבורי, ולזכות את חשבוני. תודה רבה');
  await say(13, 'האפליקציה לא נותנת לי להירשם');
  await say(13, 'מוזר זה היה נראה שבוטל באפליקציה');
  await say(14, 'שלחתי ביט');
  await say(15, '[תמונה]', 'image');
  await say(16, '[הודעה קולית]', 'audio');
  console.log('\n════ D. people, complaints, injuries, staff ════');
  await say(17, 'הי תתקשר אלי כשתוכל');
  await say(18, 'אפשר לדבר עם נציג?');
  await say(18, 'מחר ב-10');
  console.log('   → appointment created for a MEMBER:', JSON.stringify(aptStore.getByPhone(phoneOf(18)).map(a => ({ status: a.status, rawTime: a.rawTime, scheduledAt: a.scheduledAt }))), '| lead record status:', store.getLead(phoneOf(18))?.status);
  await say(19, 'אני מאוד מאוכזבת מהשירות שקיבלתי אתמול');
  await say(20, 'נפצעתי בברך באימון אתמול, אפשר להמשיך להתאמן?');
  await say(21, 'איפה אתם נמצאים?');
  await say(22, 'הסר אותי מהרשימה');
  await say(22, 'מה יש מחר?');
  console.log('\n════ E. model unavailable ════');
  aiMode = 'fail';
  await say(23, 'כמה כניסות נשארו לי?');
  await say(24, 'רוצה לבטל את המנוי');
  aiMode = 'ok';

  console.log('\n════ F. staff takeover from the studio phone (outgoing webhook) ════');
  async function staffTypesOnPhone(i, text) {
    await request(app).post('/api/green-api/webhook').set('Content-Type', 'application/json').send(JSON.stringify({
      typeWebhook: 'outgoingMessageReceived', idMessage: 'STAFF' + Date.now(), senderData: { chatId: phoneOf(i) + '@c.us', senderName: 'Studio' },
      messageData: { typeMessage: 'textMessage', textMessageData: { textMessage: text } } }));
    await new Promise(r => setTimeout(r, 400));
  }
  // F1: member with no lead record
  await staffTypesOnPhone(30, 'היי מהקורה את מגיעה לשיעור?');
  console.log('   F1 after staff message → lead status:', store.getLead(phoneOf(30))?.status);
  await say(30, 'לא יכולה להגיע היום');
  // F2: member who was once a lead (record reclassified to converted_member — the common case)
  store.upsertLead(phoneOf(31), { status: 'warm', messageCount: 3 });
  await say(31, 'מה יש מחר?');                                   // first member message → reclassified
  console.log('   F2 lead record after first member message:', store.getLead(phoneOf(31))?.status);
  await staffTypesOnPhone(31, 'היי מהקורה את מגיעה לשיעור?');
  console.log('   F2 after staff message → lead status:', store.getLead(phoneOf(31))?.status);
  await say(31, 'לא יכולה להגיע היום');
  // F3: takeover → release → staff writes again
  const rel = await request(app).post(`/api/leads/${phoneOf(30)}/release`).send({});
  console.log('   F3 release of F1 member → status:', rel.body.status);
  await staffTypesOnPhone(30, 'רק מוודאת שראית');
  console.log('   F3 staff writes again after release → lead status:', store.getLead(phoneOf(30))?.status);
  await say(30, 'לא יכולה להגיע מחר');

  console.log('\n════ G. dashboard sends ════');
  for (const [url, body] of [['/api/tomer/send-whatsapp', { phone: phoneOf(22), message: 'בדיקה' }], ['/api/tomer/action', { segment: 'churn_risk', phone: phoneOf(22), name: 'חברה' }]]) {
    const s0 = sent.length; const r = await request(app).post(url).send(body);
    console.log(`   ${url} to an OPTED-OUT-requesting / arbitrary member → http ${r.status}, messages sent: ${sent.length - s0}, lead status: ${store.getLead(phoneOf(22))?.status ?? '(none)'}`);
  }
  const hs0 = sent.length; await request(app).post('/api/tomer/action').send({ segment: 'renewal', phone: phoneOf(30), name: 'חברה' });
  console.log(`   /api/tomer/action to a member (status ${store.getLead(phoneOf(30))?.status}) → messages sent: ${sent.length - hs0}`);

  console.log('\n════ Arbox calls per message (sample) ════');
  const byUrl = {}; for (const u of arboxCalls) byUrl[u.replace(/page=\d+/, 'page=N')] = (byUrl[u.replace(/page=\d+/, 'page=N')] || 0) + 1; console.log(byUrl);
  console.log('\ntasks:', JSON.stringify(tomerStore.getTasks({}).map(t => ({ type: t.type, pr: t.priority, st: t.status, msg: (t.memberMessage ?? '').slice(0, 40) }))));
  console.log('audit events:', JSON.stringify(tomerStore.getAudit({ limit: 200 }).reduce((a, e) => (a[e.event + ':' + String(e.tomerAction).split(' task')[0]] = (a[e.event + ':' + String(e.tomerAction).split(' task')[0]] || 0) + 1, a), {})));
  srv.close(); registry.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error('[FATAL]', e); process.exit(1); });
