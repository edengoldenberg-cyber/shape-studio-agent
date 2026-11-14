#!/usr/bin/env node
/**
 * tomer_panel_preview.mjs — open Tomer's finished panel LOCALLY, with nothing real behind it.
 *
 *   node scripts/tomer_panel_preview.mjs
 *
 * Starts the real server.js on a free local port with:
 *   • a fresh temporary data directory (deleted on exit) — never the repo's data/ folder
 *   • a local stand-in for the WhatsApp provider: every "sent" message is only printed here
 *   • a local stand-in for Arbox with four invented members
 *   • authentication ON, with a throw-away preview password printed below
 * then creates four cases by sending invented member messages through the real pipeline
 * (one alert accepted, one failed, one uncertain) and waits. Ctrl+C stops everything.
 *
 * No real member, no real WhatsApp message, no Arbox call, no production variable.
 */
import { spawn, spawnSync } from 'child_process';
import { createServer }     from 'http';
import { createRequire }    from 'module';
import { fileURLToPath }    from 'url';
import { writeFileSync }    from 'fs';
import path                 from 'path';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createIsolatedDataDir, removeDir, isolatedChildEnv, freePort, waitFor, TEST_MANAGER_PHONE } = require(path.join(root, 'tests/helpers/isolated_env.cjs'));
const { createArboxMock } = require(path.join(root, 'tests/helpers/arbox_mock.cjs'));

const PASSWORD = 'preview-' + Math.random().toString(36).slice(2, 10);
const TOKEN    = 'token-' + Math.random().toString(36).slice(2);
const MEMBERS  = [['972507100001', 'דנה', '050-7100001'], ['972507100002', 'נועה', '+972507100002'], ['972507100003', 'מיכל', '0507100003'], ['972507100004', 'רותם', '972507100004']];
const dataDir  = createIsolatedDataDir('shape-tomer-preview-');
writeFileSync(path.join(dataDir, 'known_members.json'), JSON.stringify({ phones: MEMBERS.map(m => m[0]), names: {} }));
const arbox = createArboxMock();
const mgr = { mode: 'ok' };
let server = null, green = null, done = false;

function stop() {
  if (done) return; done = true;
  if (server?.pid) { if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); else { try { server.kill('SIGKILL'); } catch { /* gone */ } } }
  try { green?.close(); } catch { /* ignore */ }
  arbox.close().catch(() => {}).finally(() => { removeDir(dataDir); process.exit(0); });
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);

const [appPort, greenPort] = [await freePort(), await freePort()];
const BASE = `http://127.0.0.1:${appPort}`;
green = createServer((req, res) => {
  let b = ''; req.on('data', d => b += d);
  req.on('end', () => {
    let j = null; try { j = JSON.parse(b); } catch { /* not json */ }
    const toMgr = j && String(j.chatId ?? '').startsWith(TEST_MANAGER_PHONE);
    if (toMgr && mgr.mode !== 'ok') { res.writeHead(mgr.mode === 'reject' ? 400 : 500, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    if (j?.message) console.log(`\n── WhatsApp (מדומה) → ${toMgr ? 'מנהל' : 'חבר/ה ' + String(j.chatId).replace(/@.*/, '')} ──\n${j.message}`);
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ idMessage: `PREVIEW-${Date.now()}` }));
  });
});
await new Promise(r => green.listen(greenPort, '127.0.0.1', r));
const arboxUrl = await arbox.listen();
MEMBERS.forEach(([, first, phone], i) => {
  arbox.state.users.push({ user_id: i + 1, first_name: first, last_name: 'לדוגמה', phone, user_role: 'client', active: 1, gender: 'female' });
  arbox.state.memberships.push({ membership_user_id: 11 + i, user_id: i + 1, membership_type_name: 'מנוי חודשי', type: 'plan', debt: 0, start_time: '2026-10-01', end_time: '2026-12-31', active: 1, cancelled: 0 });
});

server = spawn(process.execPath, ['server.js'], {
  cwd: root, stdio: ['ignore', 'ignore', 'inherit'],
  env: isolatedChildEnv(dataDir, {
    PORT: String(appPort), TEST_MODE: 'true', WHATSAPP_AUTO_REPLY: 'true', LOG_SILENT: 'true', LOG_TO_FILE: 'false',
    GREEN_API_URL: `127.0.0.1:${greenPort}`, GREEN_API_ID_INSTANCE: '9990001', GREEN_API_TOKEN_INSTANCE: 'mock-preview',
    ARBOX_BASE_URL: arboxUrl, ARBOX_CLIENT_ID: 'mock', ARBOX_LOCATION_ID: '1', ARBOX_MIN_GAP_MS: '0',
    TEST_ALLOWLIST_PHONES: [TEST_MANAGER_PHONE, ...MEMBERS.map(m => m[0])].join(','),
    AUTH_DISABLED: 'false', DASHBOARD_PASSWORD: PASSWORD, DASHBOARD_API_TOKEN: TOKEN, BACKEND_URL: BASE,
  }),
});
server.on('exit', () => { if (!done) { console.error('\nהשרת נעצר.'); stop(); } });

const up = await waitFor(async () => (await (await fetch(`${BASE}/health`)).json()).startupComplete === true, { timeoutMs: 40000, intervalMs: 250 });
if (!up) { console.error('השרת לא עלה.'); stop(); }
const say = (phone, text) => fetch(`${BASE}/api/whatsapp/simulate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ from: phone, name: 'WA', text }) }).then(r => r.json());
await say(MEMBERS[0][0], 'רוצה להקפיא את המנוי מ-1.12 עד 15.12');
await say(MEMBERS[1][0], 'רוצה לבטל את המנוי');
mgr.mode = 'reject'; await say(MEMBERS[2][0], 'לא הבנתי על מה חויבתי ועל איזה חודש');
mgr.mode = 'error';  await say(MEMBERS[3][0], 'אני מאוד מאוכזבת מהיחס בשיעור אתמול');
mgr.mode = 'ok';

console.log(`
════════════════════════════════════════════════════════════════
  תצוגה מקדימה של הפאנל של תומר — נתונים מומצאים בלבד
  כתובת:           ${BASE}/#tomer
  סיסמת תצוגה:     ${PASSWORD}     (זמנית, למחשב הזה בלבד — לא סיסמת הייצור)
  4 פניות לדוגמה:  הקפאה · ביטול מנוי · בירור חיוב (התראה נכשלה) · תלונה (התראה לא ודאית)
  כל הודעת "וואטסאפ" שהמערכת שולחת מודפסת כאן ולא יוצאת לשום מקום.
  לעצירה: Ctrl+C
════════════════════════════════════════════════════════════════`);
