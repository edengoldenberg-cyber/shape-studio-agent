'use strict';
// Runs before every Jest test file (jest.config.js → setupFiles).
//
// 1. TEST_NO_BIND: server.js skips app.listen() when loaded via require(); supertest
//    creates its own ephemeral server from the express app.
// 2. Isolation: every test file gets a FRESH temporary DATA_DIR and dummy external
//    credentials. No Jest suite can read or write the repo's data/ folder or reach a
//    real provider, even if a jest.mock() is missing. A test file that needs a specific
//    directory may still overwrite process.env.DATA_DIR before its first require().
const { createIsolatedDataDir, safeExternalEnv } = require('./helpers/isolated_env.cjs');
const path = require('path');

process.env.TEST_NO_BIND = 'true';
Object.assign(process.env, safeExternalEnv());
const _dir = createIsolatedDataDir('shape-jest-');
process.env.DATA_DIR           = _dir;
process.env.KNOWN_MEMBERS_PATH = path.join(_dir, 'known_members.json');
process.env.STAFF_CONFIG_PATH  = path.join(_dir, 'staff_config.json');
process.env.LOG_SILENT         = 'true';
