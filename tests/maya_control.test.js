'use strict';
const os = require('os'), path = require('path'), fs = require('fs');
const { createMayaControl } = require('../services/maya_control');

function build(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-ctl-'));
  const base = {
    dataDir: dir, logger: { info() {}, warn() {}, error() {} }, now: () => new Date('2026-11-19T12:00:00Z'),
    getThreads: () => [], leadOf: () => null, getAppointments: () => [], activeStatuses: new Set(['callback_pending', 'confirmed']),
    isSuperseded: () => false, deliverySummary: () => ({ failed: 0, byStatus: {}, oldestUnconfirmedAt: null, anyStatusReported: true }),
    systemRows: async () => [], danaList: () => [], casesList: () => [],
  };
  const mc = createMayaControl({ ...base, ...over });
  return { mc, dir };
}

describe('maya_control — anomaly detection, dedup and resolution', () => {
  test('detects an unanswered inbound (2h+), not an opted-out silence', async () => {
    const threads = [
      { phone: '972521111111', name: 'דנה', messages: [{ direction: 'in', timestamp: '2026-11-19T06:00:00Z' }] },   // 6h unanswered
      { phone: '972522222222', name: 'ענה', messages: [{ direction: 'in', timestamp: '2026-11-19T06:00:00Z' }, { direction: 'out', timestamp: '2026-11-19T06:05:00Z' }] }, // answered
      { phone: '972523333333', name: 'הוסר', messages: [{ direction: 'in', timestamp: '2026-11-19T06:00:00Z' }] },
    ];
    const { mc } = build({ getThreads: () => threads, leadOf: p => (p === '972523333333' ? { status: 'opted_out' } : { status: 'warm' }) });
    await mc.tick();
    const open = mc.list().open;
    expect(open.filter(a => a.type === 'unanswered_inbound').map(a => a.key)).toEqual(['unanswered:972521111111']);
  });

  test('detects an overdue callback with no outcome', async () => {
    const { mc } = build({ getAppointments: () => [{ id: 'apt1', leadPhone: '972521111111', leadName: 'דנה', status: 'confirmed', scheduledAt: new Date('2026-11-19T10:00:00Z') }] });
    await mc.tick();
    expect(mc.list().open.some(a => a.type === 'callback_overdue' && a.key === 'callback:apt1')).toBe(true);
  });

  test('a re-run updates the same anomaly (no duplicate) and resolves it when it clears', async () => {
    let apts = [{ id: 'apt1', leadPhone: '9725', leadName: 'דנה', status: 'confirmed', scheduledAt: new Date('2026-11-19T10:00:00Z') }];
    const { mc } = build({ getAppointments: () => apts });
    await mc.tick();
    const first = mc.list().open.find(a => a.key === 'callback:apt1');
    expect(first.detectedAt).toBe('2026-11-19T12:00:00.000Z');
    await mc.tick();
    expect(mc.list().open.filter(a => a.key === 'callback:apt1')).toHaveLength(1);                       // not duplicated
    apts = [];                                                                                            // the callback got an outcome / was removed
    await mc.tick();
    expect(mc.list().open.some(a => a.key === 'callback:apt1')).toBe(false);
    expect(mc.list().resolved.some(a => a.key === 'callback:apt1' && a.resolveReason)).toBe(true);        // closed with a reason
  });

  test('a source that could not be read leaves its anomalies unknown, never resolved, never "all clear"', async () => {
    let fail = false;
    const { mc } = build({ getAppointments: () => { if (fail) throw new Error('store down'); return [{ id: 'apt1', leadPhone: '9725', status: 'confirmed', scheduledAt: new Date('2026-11-19T10:00:00Z') }]; } });
    await mc.tick();
    expect(mc.list().open.some(a => a.key === 'callback:apt1')).toBe(true);
    fail = true;                                                                                          // the appointments store is now unavailable
    const r = await mc.tick();
    expect(r.sources.callbacks.ok).toBe(false);
    expect(mc.list().open.some(a => a.key === 'callback:apt1')).toBe(true);                               // NOT resolved — unknown, not zero
  });

  test('integration down and failed sends are flagged; a healthy system is not', async () => {
    const { mc } = build({ systemRows: async () => [{ id: 'arbox', label: 'Arbox', state: 'fail', detail: 'לא מחובר' }, { id: 'wa', label: 'WhatsApp', state: 'live' }], deliverySummary: () => ({ failed: 3, byStatus: { failed: 3 }, oldestUnconfirmedAt: null, anyStatusReported: true }) });
    await mc.tick();
    const open = mc.list().open;
    expect(open.some(a => a.type === 'integration_down' && a.key === 'integration:arbox')).toBe(true);
    expect(open.some(a => a.key === 'integration:wa')).toBe(false);                                        // a live system is not an anomaly
    expect(open.some(a => a.type === 'send_failure' && a.key === 'delivery:failed')).toBe(true);
  });
});
