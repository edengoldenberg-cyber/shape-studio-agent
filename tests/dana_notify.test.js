'use strict';
/**
 * Dana — the real "ready for owner review" notification path. The WhatsApp provider is mocked:
 * no message leaves this process. What is tested is who would receive what, how often, and when.
 */
const fs   = require('fs');
const path = require('path');

const PHONE = '972500000001';                       // synthetic
let sends, quiet, reply, studio, notify;

function boot(env = {}) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'dana-notify-'));
  for (const k of ['DANA_NOTIFY_REAL', 'DANA_NOTIFY_PHONE', 'BACKEND_URL', 'RAILWAY_PUBLIC_DOMAIN']) delete process.env[k];
  Object.assign(process.env, env);
  sends = []; quiet = false; reply = () => ({ idMessage: 'wamid.TEST' });
  jest.resetModules();
  jest.doMock('../services/whatsapp.service', () => ({ sendText: jest.fn(async (to, text, opts) => { sends.push({ to, text, opts }); return reply(); }) }));
  jest.doMock('../utils/time', () => ({ isQuietHours: () => quiet }));
  studio = require('../services/dana_studio'); notify = require('../services/dana_notify');
}
function project(title = 'קליפ בדיקה') {
  const p = { id: 'prj_test1', title, currentVersion: 1, history: [],
    versions: [{ n: 1, status: 'ready_for_review', package: { review_items: [{ id: 'timing:16' }] }, caption: { text: 'קפשן סודי שלא אמור להופיע בהודעה' } }] };
  studio.state().projects[p.id] = p;
  return [p, p.versions[0]];
}
const REAL = { DANA_NOTIFY_REAL: 'true', DANA_NOTIFY_PHONE: PHONE, BACKEND_URL: 'https://studio.example.invalid/' };

describe('real notification: off unless everything is configured', () => {
  test.each([
    ['nothing set', {}],
    ['switch only', { DANA_NOTIFY_REAL: 'true' }],
    ['no public base URL (the link would not open the authenticated page)', { DANA_NOTIFY_REAL: 'true', DANA_NOTIFY_PHONE: PHONE }],
    ['switch off', { DANA_NOTIFY_PHONE: PHONE, BACKEND_URL: 'https://x.invalid' }],
  ])('%s → mock, nothing sent', async (_name, env) => {
    boot(env); const [p, v] = project();
    expect(await notify.packageReady(p, v)).toMatchObject({ sent: false, mode: 'mock' });
    expect(sends).toEqual([]);
    expect(notify.status().mode).toBe('mock'); expect(notify.status().why.length).toBeGreaterThan(0);
  });
});

describe('real notification: once, to one number, with the authenticated link', () => {
  test('one message per version, only to the configured number, link to the package, no content', async () => {
    boot(REAL); const [p, v] = project();
    expect(await notify.packageReady(p, v)).toMatchObject({ sent: true, mode: 'real', outcome: 'sent' });
    expect(sends).toHaveLength(1);
    expect(sends[0].to).toBe(PHONE);
    expect(sends[0].opts).toMatchObject({ bypassQuietHours: true });          // never the shared "we will get back to you" path
    expect(sends[0].text).toContain('https://studio.example.invalid/dana-studio.html#prj_test1');
    expect(sends[0].text).toMatch(/נדרשת התחברות/); expect(sends[0].text).toMatch(/אינה מאשרת פרסום/);
    expect(sends[0].text).not.toContain('קפשן סודי');
    await notify.packageReady(p, v); await notify.flush();
    expect(sends).toHaveLength(1);                                            // not again
    expect(v.notifyMessageId).toBe('wamid.TEST');
    const log = notify.sentLog();
    expect(log).toHaveLength(1); expect(log[0].to).toBe('…0001');             // the log never holds the full number
    expect(JSON.stringify(studio.state())).toContain('notifiedAt');
    expect(notify.status()).toMatchObject({ mode: 'real', recipientTail: '0001' });
    expect(JSON.stringify(notify.status())).not.toContain(PHONE);
  });

  test('a new version gets its own notification', async () => {
    boot(REAL); const [p, v] = project();
    await notify.packageReady(p, v);
    const v2 = { n: 2, status: 'ready_for_review', package: { review_items: [] } }; p.versions.push(v2); p.currentVersion = 2;
    await notify.packageReady(p, v2);
    expect(sends).toHaveLength(2); expect(sends[1].text).toContain('גרסה 2'); expect(sends[1].text).toContain('כל הבדיקות האוטומטיות עברו');
  });

  test('quiet hours: nothing is sent at night; it goes out once afterwards, and only if still current', async () => {
    boot(REAL); const [p, v] = project(); quiet = true;
    expect(await notify.packageReady(p, v)).toMatchObject({ sent: false, outcome: 'deferred_quiet_hours' });
    await notify.flush();
    expect(sends).toEqual([]);
    quiet = false;
    expect(await notify.flush()).toBe(1); expect(await notify.flush()).toBe(0);
    expect(sends).toHaveLength(1);
    // a version replaced during the night is not announced
    const v2 = { n: 2, status: 'ready_for_review', package: {} }; p.versions.push(v2); quiet = true;
    await notify.packageReady(p, v2);
    p.versions.push({ n: 3, status: 'editing' }); p.currentVersion = 3; quiet = false;
    expect(await notify.flush()).toBe(0); expect(v2.notifyOutcome).toBe('superseded'); expect(sends).toHaveLength(1);
  });

  test('only a provider message id counts as sent; unknown outcomes are not retried', async () => {
    boot(REAL); let [p, v] = project();
    reply = () => ({ idMessage: 'blocked-1', blocked: true, testMode: true });
    expect((await notify.packageReady(p, v)).outcome).toMatch(/^blocked/);
    boot(REAL); [p, v] = project(); reply = () => ({});
    expect((await notify.packageReady(p, v)).outcome).toMatch(/^uncertain/);
    boot(REAL); [p, v] = project(); reply = () => { throw new Error('socket hang up'); };
    expect(await notify.packageReady(p, v)).toMatchObject({ sent: false }); expect(v.notifyOutcome).toMatch(/^uncertain: socket/);
    await notify.packageReady(p, v); await notify.flush();
    expect(sends).toHaveLength(1);
  });
});

describe('explicit test message', () => {
  test('refused in mock mode; in real mode needs the full number typed again and a name', async () => {
    boot({}); await expect(notify.sendTest({ confirmPhone: PHONE, by: 'Eden' })).rejects.toMatchObject({ code: 'notify_not_real' });
    boot(REAL);
    await expect(notify.sendTest({ confirmPhone: '972500000002', by: 'Eden' })).rejects.toMatchObject({ code: 'notify_phone_mismatch' });
    await expect(notify.sendTest({ confirmPhone: PHONE })).rejects.toMatchObject({ code: 'notify_by_required' });
    expect(sends).toEqual([]);
    expect(await notify.sendTest({ confirmPhone: PHONE, by: 'Eden' })).toEqual({ outcome: 'sent' });
    expect(sends).toHaveLength(1); expect(sends[0].to).toBe(PHONE); expect(sends[0].text).toMatch(/הודעת בדיקה/);
    expect(notify.sentLog()[0]).toMatchObject({ test: true, by: 'Eden', to: '…0001' });
  });
});
