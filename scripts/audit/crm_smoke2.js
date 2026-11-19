// Prod verification of the gap fixes + new sections. Synthetic record only (deleted after).
// Reads DASHBOARD_PASSWORD from the container env to test the server-side permanent-delete gate,
// and NEVER prints it.
const axios = require('/app/node_modules/axios'), a = require('/app/middleware/auth.js');
const TEST = '972559990002';
(async () => {
  const p = a.parseToken(a.issueToken()), full = p.exp - Date.now(), tok = a.issueToken(Date.now() - full + 5 * 60 * 1000), csrf = a.csrfFor(a.parseToken(tok).sid);
  const c = axios.create({ baseURL: 'http://127.0.0.1:' + (process.env.PORT || 3000), timeout: 20000, validateStatus: () => true, headers: { Cookie: `ss_session=${tok}; ss_csrf=${csrf}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' } });
  const log = (k, v) => console.log('C ' + k + ' ' + v);
  try {
    // 1. classification: the funnel count should now equal the central sales-list count
    const kinds = await c.get('/api/leads/kinds');
    const active = await c.get('/api/crm/search?crmState=active&limit=1');
    log('classification', `central inSalesList=${kinds.data?.inSalesList} (counts ${JSON.stringify(kinds.data?.counts)}) | CRM active total=${active.data?.total}`);
    // no member/staff/test in CRM active (sample up to 300 and classify would need kinds; here we trust the fix — assert equality)
    log('classification-match', `${kinds.data?.inSalesList === active.data?.total ? 'MATCH ✓' : 'MISMATCH'}`);
    const counts = await c.get('/api/crm/stage-counts'); log('stage-counts', JSON.stringify(counts.data?.counts));
    // a member search by name should not surface in the funnel
    const today = await c.get('/api/crm/today'); log('today', JSON.stringify(today.data?.counts));
    const rep = await c.get('/api/crm/reports?from=2026-10-01&to=2026-12-31'); log('reports', `ok=${rep.data?.ok} metrics=${(rep.data?.metrics||[]).map(m=>m.id+':'+m.value).join(', ')}`);

    // 2. lifecycle on the synthetic record
    await c.delete('/api/crm/lead/' + TEST + '/permanent', { data: { adminConfirmed: true, password: process.env.DASHBOARD_PASSWORD } });
    const create = await c.post('/api/crm/lead', { phone: '0559990002', name: 'בדיקת CRM2', interest: 'כוח', source: 'בדיקה' });
    log('create', `http ${create.status} ok=${create.data?.ok}`);
    // call logging: registered = staff report, NOT arbox-verified
    await c.post('/api/crm/lead/' + TEST + '/call', { outcome: 'registered', note: 'סגר' });
    let card = (await c.get('/api/crm/lead/' + TEST)).data?.card || {};
    log('call-registered', `stage=${card.stage} registration=${JSON.stringify(card.registration)} calls=${(card.calls||[]).length}`);
    // trial
    await c.post('/api/crm/lead/' + TEST + '/trial', { action: 'schedule', at: '2026-11-25T07:00:00Z' });
    await c.post('/api/crm/lead/' + TEST + '/trial', { action: 'attended' });
    card = (await c.get('/api/crm/lead/' + TEST)).data?.card || {};
    log('trial', `stage=${card.stage} trialInfo=${JSON.stringify(card.trialInfo)}`);
    // task lifecycle
    const task = await c.post('/api/crm/lead/' + TEST + '/task', { summary: 'מעקב' });
    const tid = task.data?.taskId;
    await c.post('/api/crm/task/' + tid, { status: 'eden_assigned', assignedTo: 'eden' });
    await c.post('/api/crm/task/' + tid, { dueAt: '2026-11-21T08:00:00Z' });
    await c.post('/api/crm/task/' + tid, { status: 'resolved', outcome: 'נסגר' });
    await c.post('/api/crm/task/' + tid, { status: 'open' });   // reopen
    card = (await c.get('/api/crm/lead/' + TEST)).data?.card || {};
    log('task-lifecycle', `tasks=${JSON.stringify((card.tasks||[]).map(t=>({st:t.status,asg:t.assignedTo,due:!!t.dueAt})))}`);
    // follow-up on no_answer creates a task
    await c.post('/api/crm/lead/' + TEST + '/call', { outcome: 'no_answer', followUpAt: '2026-11-22T08:00:00Z' });
    card = (await c.get('/api/crm/lead/' + TEST)).data?.card || {};
    log('followup-task', `tasks now=${(card.tasks||[]).length}`);

    // 3. permanent delete password gate (server-side)
    await c.delete('/api/crm/lead/' + TEST);  // to trash
    const noPw = await c.delete('/api/crm/lead/' + TEST + '/permanent', { data: { adminConfirmed: true } });
    log('perm-no-password', `http ${noPw.status} error=${noPw.data?.error} (401 = gated)`);
    const wrongPw = await c.delete('/api/crm/lead/' + TEST + '/permanent', { data: { adminConfirmed: true, password: 'definitely-not-the-password' } });
    log('perm-wrong-password', `http ${wrongPw.status} error=${wrongPw.data?.error}`);
    const okPw = await c.delete('/api/crm/lead/' + TEST + '/permanent', { data: { adminConfirmed: true, password: process.env.DASHBOARD_PASSWORD } });
    log('perm-correct-password', `http ${okPw.status} ok=${okPw.data?.ok}`);
    const gone = await c.get('/api/crm/lead/' + TEST); log('after-perm', `http ${gone.status} (404 = gone)`);
  } catch (e) { log('ERR', e.message); }
  finally { await c.post('/auth/logout', {}); log('logout', 'done'); process.exit(0); }
})();
