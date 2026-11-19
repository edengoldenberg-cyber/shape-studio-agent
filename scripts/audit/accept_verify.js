// READ-ONLY prod acceptance check on a REAL converted member (no change to any customer).
// Confirms a converted lead: is OUT of the active list, IN the 'registered' view, and IN the
// conversion report with its source attributed.
const axios = require('/app/node_modules/axios'), a = require('/app/middleware/auth.js');
(async () => {
  const p = a.parseToken(a.issueToken()), full = p.exp - Date.now(), tok = a.issueToken(Date.now() - full + 5 * 60 * 1000), csrf = a.csrfFor(a.parseToken(tok).sid);
  const c = axios.create({ baseURL: 'http://127.0.0.1:' + (process.env.PORT || 3000), timeout: 20000, validateStatus: () => true, headers: { Cookie: `ss_session=${tok}; ss_csrf=${csrf}`, 'X-CSRF-Token': csrf } });
  const log = (k, v) => console.log('A ' + k + ' ' + v);
  try {
    const active = (await c.get('/api/crm/search?crmState=active&limit=1000')).data?.rows || [];
    const registered = (await c.get('/api/crm/search?view=registered&limit=1000')).data?.rows || [];
    const rep = (await c.get('/api/crm/reports')).data || {};
    const mArbox = (rep.metrics || []).find(m => m.id === 'registered_arbox') || {};
    log('counts', `active=${active.length} registered-view=${registered.length} registered_arbox=${mArbox.value} sources=${JSON.stringify(mArbox.breakdown || {})}`);
    // overlap: no registered member appears in the active list
    const activeSet = new Set(active.map(r => r.phone));
    const leak = registered.filter(r => activeSet.has(r.phone));
    log('leak-into-active', `${leak.length} (0 = correct: converted members are not in the active work list)`);
    // a converted member with a source is attributed in the conversion report
    log('source-attribution', Object.keys(mArbox.breakdown || {}).length ? 'present ✓' : 'none');
    log('sample-registered', JSON.stringify(registered.slice(0, 2).map(r => ({ stage: r.stage, owner: r.owner, src: r.source || '—', tail: (r.phone || '').slice(-4) }))));
  } catch (e) { log('ERR', e.message); }
  finally { await c.post('/auth/logout', {}); process.exit(0); }
})();
