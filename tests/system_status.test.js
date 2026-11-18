'use strict';
/**
 * system_status.test.js — the status table says what is really live, limited, off, blocked or failing.
 *
 * Production, 2026-11-18: the "מצב מערכת" tab showed a constant "פעיל" for every agent while reminders were
 * restricted to a test phone, no membership price was saved, Arbox writes were off and the editing PC could be asleep.
 * All data here is invented. The module only reads; the fakes below have no send or write function at all.
 */
const { build, countItems } = require('../services/system_status');

const NOW = Date.parse('2026-11-18T10:00:00Z');
const iso = msAgo => new Date(NOW - msAgo).toISOString();

function providers(over = {}) {
  const base = {
    now: () => NOW,
    env: { WHATSAPP_AUTO_REPLY: 'true', NOTIFY_PHONES: '972500000001', TOMER_MANAGER_PHONE: '972500000001', TOMER_MODE: 'all' },
    greenState: async () => ({ state: 'authorized', at: NOW - 60000 }),
    arboxGateway: {
      getAllUsers: async () => ({ users: new Array(7), fetchedAt: NOW - 120000, stale: false }),
      writeStatus: () => ({ class_book: { contractVerified: false }, class_cancel: { contractVerified: false } }),
    },
    store: { getEvents: () => [], getAllLeads: () => [{ status: 'human_owns' }, { status: 'new' }] },
    pricing: {
      load: () => ({ _source: 'shipped_default', trial: { price_ils: 60 }, packages: [{ price_ils: null }, { price_ils: null }] }),
      pricedPackages: pkg => pkg.packages.filter(p => p.price_ils > 0),
      trialOf: pkg => pkg.trial,
    },
    barakAgent: { getRawKnowledge: () => ({ staff: { instructors: [] }, classes: { classes: [], _universal_access: '' } }) },
    aptStore: { getCallbackPending: () => [] },
    appointmentWorker: { workerStatus: () => ({ pendingAndProspectRemindersEnabled: true, leadAllowlist: ['972500000002'] }) },
    tomerTest: { status: () => ({ mode: 'all', allowlist: ['972500000002'] }) },
    serviceCases: { list: () => [] },
    tomerStore: { getOpenTasks: () => [] },
    memberCare: { overview: () => ({ proactiveOn: false, policyApproval: { approved: false }, programs: [{ label: 'ברוכה הבאה', enabled: false }] }) },
    voiceIntake: { status: () => ({ availability: { state: 'online', lastSeenAt: iso(5000) }, waiting: 0, failed: 0 }) },
    danaStudio: { workerStatus: () => ({ online: true, state: 'idle', lastSeen: iso(5000), pipelineVersion: '1.5.0', queued: 0, running: 0 }), summary: () => ({ awaitingReview: 1 }) },
    danaReferences: { count: () => 0 },
    danaNotify: { status: () => ({ mode: 'mock', pending: 1 }) },
    identity: { severalRows: () => [] },
    ownerTasks: { list: () => ({ counts: { open: 0, snoozed: 0, inProgress: 0 }, sourceError: null, reminders: { state: 'on', text: 'תזכורת מרוכזת אחת בשעות 09:00.' } }) },
  };
  return { ...base, ...over, env: { ...base.env, ...(over.env ?? {}) } };
}
const row = (out, id) => out.rows.find(r => r.id === id);

describe('system status — production as it was on 2026-11-18', () => {
  let out;
  beforeAll(async () => { out = await build(providers()); });

  test('nothing is reported as live while it is restricted, switched off or waiting for the owner', () => {
    expect(row(out, 'barak_reminders').state).toBe('limited');
    expect(row(out, 'barak_reminders').detail).toContain('…0002');
    expect(row(out, 'barak_reminders').action).toMatch(/CALLBACK_PENDING_REMINDER_PHONES/);
    expect(row(out, 'barak_prices').state).toBe('blocked');
    expect(row(out, 'barak_prices').detail).toContain('60');
    expect(row(out, 'barak_knowledge').state).toBe('blocked');
    expect(row(out, 'tomer_class_writes').state).toBe('blocked');
    expect(row(out, 'tomer_class_writes').detail).toMatch(/משימה אחת לצוות/);
    expect(row(out, 'tomer_proactive').state).toBe('off');
    expect(row(out, 'dana_publish').state).toBe('off');
    expect(row(out, 'dana_notify').state).toBe('off');
    expect(row(out, 'dana_references').state).toBe('blocked');
  });

  test('what does work for real customers is live, and nothing needs urgent attention', () => {
    for (const id of ['whatsapp', 'auto_reply', 'arbox_read', 'editing_pc', 'voice', 'barak_reply', 'barak_callback', 'tomer_route', 'tomer_manager', 'dana_editing']) {
      expect([id, row(out, id).state]).toEqual([id, 'live']);
    }
    expect(out.attention).toBe(0);
    expect(row(out, 'dana_editing').action).toMatch(/לצפות/);
  });

  test('every blocked or limited capability that needs the owner says what is needed', () => {
    for (const r of out.rows.filter(x => x.state === 'blocked')) expect([r.id, !!r.action]).toEqual([r.id, true]);
  });

  test('a full phone number never appears in the table', () => {
    expect(JSON.stringify(out)).not.toMatch(/9725\d{8}/);
  });
});

describe('system status — failures are shown, not hidden', () => {
  test('the editing PC asleep: Dana editing and voice transcription fail, with the interim path stated', async () => {
    const out = await build(providers({
      voiceIntake: { status: () => ({ availability: { state: 'offline', lastSeenAt: iso(3 * 3600e3) }, waiting: 2, failed: 0 }) },
      danaStudio: { workerStatus: () => ({ online: false, state: 'offline', lastSeen: iso(3 * 3600e3), queued: 1, running: 0 }), summary: () => ({ awaitingReview: 0 }) },
    }));
    expect(row(out, 'editing_pc').state).toBe('fail');
    expect(row(out, 'editing_pc').detail).toContain('לפני 3 שעות');
    expect(row(out, 'voice').state).toBe('fail');
    expect(row(out, 'voice').detail).toMatch(/עוברת לצוות/);
    expect(row(out, 'dana_editing').state).toBe('fail');
    expect(out.attention).toBe(3);
  });

  test('WhatsApp disconnected, Arbox not answering, a failed alert, an old task, an overdue callback', async () => {
    const out = await build(providers({
      greenState: async () => ({ state: 'notAuthorized', at: NOW }),
      arboxGateway: { getAllUsers: async () => { throw new Error('ECONNABORTED'); }, writeStatus: () => ({}) },
      serviceCases: { list: () => [{ notification: { state: 'failed' } }, { notification: { state: 'accepted' } }] },
      tomerStore: { getOpenTasks: () => [{ createdAt: iso(5 * 24 * 3600e3) }, { createdAt: iso(3600e3) }] },
      aptStore: { getCallbackPending: () => [{ scheduledAt: iso(24 * 3600e3) }] },
      store: { getEvents: () => [{ type: 'callback_hold_alert_failed' }], getAllLeads: () => [] },
    }));
    expect(row(out, 'whatsapp').state).toBe('fail');
    expect(row(out, 'arbox_read').state).toBe('fail');
    expect(row(out, 'tomer_manager').state).toBe('fail');
    expect(row(out, 'tomer_tasks').state).toBe('limited');
    expect(row(out, 'tomer_tasks').detail).toContain('2 משימות פתוחות, 1 מהן מעל יומיים');
    expect(row(out, 'barak_callback').state).toBe('limited');
    expect(row(out, 'recent_failures').state).toBe('fail');
  });

  test('stale Arbox data is limited, not live', async () => {
    const out = await build(providers({ arboxGateway: { getAllUsers: async () => ({ users: [], fetchedAt: NOW - 20 * 60000, stale: true }), writeStatus: () => ({}) } }));
    expect(row(out, 'arbox_read').state).toBe('limited');
  });

  test('a slow Arbox answer does not hang the table', async () => {
    const out = await build(providers({ arboxTimeoutMs: 30, arboxGateway: { getAllUsers: () => new Promise(() => {}), writeStatus: () => ({}) } }));
    expect(row(out, 'arbox_read').state).toBe('fail');
  });

  test('a provider that throws yields an "unknown" row and the rest of the table is still built', async () => {
    const out = await build(providers({ pricing: { load: () => { throw new Error('boom'); } }, memberCare: undefined }));
    expect(row(out, 'barak_prices').state).toBe('unknown');
    expect(row(out, 'tomer_proactive').state).toBe('unknown');
    expect(row(out, 'barak_reply').state).toBe('live');
    expect(out.attention).toBeGreaterThanOrEqual(2);
  });

  test('auto reply off and the emergency switch are never shown as live', async () => {
    const out = await build(providers({ env: { WHATSAPP_AUTO_REPLY: 'false', TOMER_SERVICE_ENABLED: 'false' } }));
    expect(row(out, 'auto_reply').state).toBe('off');
    expect(row(out, 'barak_reply').state).toBe('off');
    expect(row(out, 'tomer_route').state).toBe('fail');
  });
});

describe('system status — once the owner has supplied what was missing', () => {
  test('saved prices and knowledge, reminders for all leads, verified Arbox writes for everyone', async () => {
    const out = await build(providers({
      env: { ARBOX_WRITES_ENABLED: 'true', ARBOX_WRITE_AUDIENCE: 'all' },
      pricing: { load: () => ({ _source: 'owner_saved', trial: { price_ils: 60 }, packages: [{ price_ils: 400 }, { price_ils: 520 }] }),
                 pricedPackages: pkg => pkg.packages.filter(p => p.price_ils > 0), trialOf: pkg => pkg.trial },
      barakAgent: { getRawKnowledge: () => ({ staff: { instructors: [{}, {}] }, classes: { classes: [{}] } }) },
      appointmentWorker: { workerStatus: () => ({ pendingAndProspectRemindersEnabled: true, leadAllowlist: null }) },
      arboxGateway: { getAllUsers: async () => ({ users: [], fetchedAt: NOW, stale: false }),
                      writeStatus: () => ({ class_book: { contractVerified: true }, class_cancel: { contractVerified: true }, class_move_late: { contractVerified: false } }) },
      danaReferences: { count: () => 3 },
    }));
    expect(row(out, 'barak_prices').state).toBe('live');
    expect(row(out, 'barak_knowledge').state).toBe('live');
    expect(row(out, 'barak_reminders').state).toBe('live');
    expect(row(out, 'tomer_class_writes').state).toBe('live');
    expect(row(out, 'tomer_class_writes').detail).toContain('class_book, class_cancel');
    expect(row(out, 'tomer_class_writes').detail).not.toContain('class_move_late');
    expect(row(out, 'dana_references').state).toBe('live');
  });

  test('verified writes with the switch on but a test audience stay "limited"', async () => {
    const out = await build(providers({ env: { ARBOX_WRITES_ENABLED: 'true' },
      arboxGateway: { getAllUsers: async () => ({ users: [], fetchedAt: NOW, stale: false }), writeStatus: () => ({ class_book: { contractVerified: true } }) } }));
    expect(row(out, 'tomer_class_writes').state).toBe('limited');
  });

  test('test-only mode is reported as the old route for real members', async () => {
    const out = await build(providers({ tomerTest: { status: () => ({ mode: 'test_only', allowlist: ['972500000002'] }) } }));
    expect(row(out, 'tomer_route').state).toBe('limited');
    expect(row(out, 'tomer_route').detail).toMatch(/המסלול הישן/);
  });
});

describe('system status — lead records', () => {
  test('refusals, corrected classifications and records waiting for a decision are counted; a full phone is never shown', async () => {
    const leads = [{ phone: '972500000011', status: 'cold', meta: { qualData: { registrationDeclined: true } } }, { phone: '972500000012', status: 'cold', meta: { classificationCorrected: { evidence: 'lead' } } },
      { phone: '972500008704', status: 'converted_member', meta: { classificationReview: { reason: 'כמה שורות Arbox על אותו טלפון: member + lead' } } }, { phone: '972500000014', status: 'new', meta: { qualData: { doNotCall: true } } }];
    const out = await build(providers({ store: { getEvents: () => [], getAllLeads: () => leads } }));
    const r = row(out, 'barak_records');
    expect(r.state).toBe('blocked');
    expect(r.detail).toContain('1 סירובים מפורשים');
    expect(r.detail).toContain('1 בקשות לא להתקשר');
    expect(r.detail).toContain('1 רשומות שסיווגן תוקן');
    expect(r.detail).toContain('…8704 (כמה שורות Arbox');
    expect(JSON.stringify(out)).not.toMatch(/9725\d{8}/);
    const clean = await build(providers({ store: { getEvents: () => [], getAllLeads: () => leads.slice(0, 2) } }));
    expect(row(clean, 'barak_records').state).toBe('live');
  });
});

describe('system status — phones with several Arbox rows', () => {
  test('names and Arbox ids of every row are listed for the owner; the phone only by its last four digits', async () => {
    const identity = { severalRows: () => [{ phone: '972500001540', rows: [{ userId: 11274768, role: 'client', name: 'אילנה לוי', category: 'member' }, { userId: 12197234, role: 'lead', name: 'אילנה לוי', category: 'lead' }] }] };
    const out = await build(providers({ identity }));
    const r = row(out, 'tomer_duplicates');
    expect(r.state).toBe('blocked');
    expect(r.detail).toMatch(/איש אינו נבחר אוטומטית/);
    expect(r.action).toMatch(/אינה מוחקת ואינה מאחדת/);
    expect(r.items).toEqual([{ phoneTail: '…1540', rows: [{ name: 'אילנה לוי', userId: '11274768', role: 'לקוח', status: 'מנוי בתוקף' }, { name: 'אילנה לוי', userId: '12197234', role: 'ליד', status: 'בלי מנוי' }] }]);
    expect(JSON.stringify(out)).not.toMatch(/9725\d{8}/);
    expect(row(await build(providers({ identity: { severalRows: () => [] } })), 'tomer_duplicates').state).toBe('live');
    expect(row(await build(providers({ identity: undefined })), 'tomer_duplicates').state).toBe('unknown');
  });
});

test('countItems reads the knowledge shapes the panel saves', () => {
  expect(countItems({ instructors: [1, 2] })).toBe(2);
  expect(countItems({ classes: [1], _universal_access: '' })).toBe(1);
  expect(countItems([1, 2, 3])).toBe(3);
  expect(countItems(null)).toBe(0);
});
