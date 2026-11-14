'use strict';
/**
 * isolated_env.cjs — shared test isolation for Jest suites and standalone .mjs harnesses.
 *
 * Guarantees for every test process:
 *   • DATA_DIR is a fresh temporary directory (never the repo's data/ folder, never production)
 *   • KNOWN_MEMBERS_PATH points inside that directory (server.js would otherwise write
 *     to the repo's tracked data/known_members.json)
 *   • external-service credentials are replaced with unusable dummies, so a missing mock
 *     can never reach Green API / OpenAI / Arbox / Meta
 *
 * Only STATIC configuration is copied from the repo (staff roster shape, packages,
 * classes). No lead, inbox, appointment or member state is ever copied.
 */

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const net  = require('net');

const REPO_DATA = path.join(__dirname, '..', '..', 'data');

// Static, non-stateful config files that some code paths read from DATA_DIR.
const STATIC_CONFIG_FILES = ['subscription_packages.json', 'classes_knowledge.json', 'staff_directory.json'];

// Synthetic staff roster: one manager on a non-routable synthetic number.
// Real staff phones are never placed in a test DATA_DIR.
const TEST_MANAGER_PHONE = '972509000001';
const TEST_STAFF_CONFIG = {
  default_assignee_id: 'eden',
  appointment_duration_min: 30,
  staff: [
    { id: 'eden', name_he: 'מנהלת בדיקה', name_en: 'Test Manager', phone: TEST_MANAGER_PHONE,
      email: '', role: 'owner', active: true, is_default_assignee: true, notify_all_events: true },
  ],
};

function createIsolatedDataDir(prefix = 'shape-test-', { staffConfig = TEST_STAFF_CONFIG } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const f of STATIC_CONFIG_FILES) {
    const src = path.join(REPO_DATA, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, f));
  }
  if (staffConfig) fs.writeFileSync(path.join(dir, 'staff_config.json'), JSON.stringify(staffConfig, null, 2));
  fs.writeFileSync(path.join(dir, 'known_members.json'), JSON.stringify({ phones: [] }));
  return dir;
}

function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/**
 * Environment that makes real external calls impossible. Port 9 (discard) on loopback
 * refuses connections immediately; keys are syntactically valid but unusable.
 */
function safeExternalEnv() {
  return {
    GREEN_API_URL:            '127.0.0.1:9',
    GREEN_API_INSTANCE_ID:    '0000000000',
    GREEN_API_ID_INSTANCE:    '0000000000',
    GREEN_API_TOKEN:          'test-disabled',
    GREEN_API_TOKEN_INSTANCE: 'test-disabled',
    OPENAI_API_KEY:           'sk-test',
    // Unroutable base URL: even code that builds a real OpenAI client cannot leave the machine.
    OPENAI_BASE_URL:          'http://127.0.0.1:9/v1',
    ARBOX_API_KEY:            'test-disabled',
    ARBOX_BASE_URL:           'http://127.0.0.1:9/arbox',
    META_PAGE_ACCESS_TOKEN:   'test-disabled',
    META_APP_SECRET:          'test-disabled',
    STUDIO_OWNER_PHONE:       TEST_MANAGER_PHONE,
    NOTIFY_PHONES:            TEST_MANAGER_PHONE,
    BACKEND_URL:              '',
    // Quiet hours off by default (start === end) so suites behave the same at any hour of
    // the day; suites that test quiet hours set these explicitly with a fixed clock.
    QUIET_HOUR_START:         '0',
    QUIET_HOUR_END:           '0',
    NODE_ENV:                 'test',
    // Dashboard auth is exercised by its own suite; other suites call the API directly.
    AUTH_DISABLED:            'true',
    TZ:                       'Asia/Jerusalem',
  };
}

/** Full env block for a spawned child server/harness with its own fresh DATA_DIR. */
function isolatedChildEnv(dataDir, extra = {}) {
  return {
    ...process.env,
    ...safeExternalEnv(),
    DATA_DIR:           dataDir,
    KNOWN_MEMBERS_PATH: path.join(dataDir, 'known_members.json'),
    STAFF_CONFIG_PATH:  path.join(dataDir, 'staff_config.json'),
    LOG_DIR:            path.join(dataDir, 'logs'),
    ...extra,
  };
}

/** Ask the OS for a free TCP port (no fixed port numbers, no collisions between runs). */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Bounded wait for a specific condition. Polls `fn` until it returns a truthy value
 * or the deadline passes. Returns the truthy value, or null on timeout — callers
 * assert on the result, so a timeout surfaces as a normal test failure with a label.
 */
async function waitFor(fn, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() >= deadline) return null;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

module.exports = {
  createIsolatedDataDir, removeDir, safeExternalEnv, isolatedChildEnv, freePort, waitFor,
  TEST_MANAGER_PHONE, TEST_STAFF_CONFIG,
};
