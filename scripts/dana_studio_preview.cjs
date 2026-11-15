'use strict';
/**
 * dana_studio_preview.cjs — LOCAL preview of Dana studio. Not the production server.
 *
 * Starts ONLY the Dana studio routes and the review page. It does not load .env, does not
 * start Barak / Tomer, WhatsApp, Arbox, OpenAI or any scheduler, and cannot send a message.
 *
 *   node scripts/dana_studio_preview.cjs                 http://127.0.0.1:3100/dana-studio.html (this computer only)
 *   node scripts/dana_studio_preview.cjs --lan           also reachable from a phone on the same Wi-Fi;
 *                                                        REQUIRES DASHBOARD_PASSWORD (login page is enforced)
 * Environment:
 *   DANA_PREVIEW_DATA   data directory   (default C:/Users/owner/dana-work/preview-data)
 *   DANA_WORKER_TOKEN   worker token     (default: a random token for this run, written to <data>/worker.token)
 *   PORT                default 3100
 */
const crypto  = require('crypto');
const express = require('express');
const fs      = require('fs');
const os      = require('os');
const path    = require('path');

function start({ lan = process.argv.includes('--lan'), port = Number(process.env.PORT) || 3100, dataDir } = {}) {
  dataDir = dataDir || process.env.DANA_PREVIEW_DATA || 'C:/Users/owner/dana-work/preview-data';
  fs.mkdirSync(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  process.env.LOG_TO_FILE = 'false';
  delete process.env.DANA_PUBLISHING_ENABLED;          // never on in a preview
  delete process.env.DANA_NOTIFY_REAL;                 // notifications are always mocked here
  if (!process.env.DANA_WORKER_TOKEN) process.env.DANA_WORKER_TOKEN = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(path.join(dataDir, 'worker.token'), process.env.DANA_WORKER_TOKEN, { mode: 0o600 });

  const app = express();
  app.use('/api/dana/worker', require('../routes/dana_studio_routes').workerRouter);
  if (lan) {
    if (!process.env.DASHBOARD_PASSWORD) { console.error('--lan requires DASHBOARD_PASSWORD (the review page must not be open on the network).'); process.exit(1); }
    require('../middleware/auth').mount(app, express);
  }
  app.get('/', (_req, res) => res.redirect('/dana-studio.html'));
  for (const f of ['dana-studio.html', 'dana-studio.js', ...(lan ? ['login.html'] : [])])
    app.get('/' + f, (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', f)));
  app.use('/api/dana/studio', require('../routes/dana_studio_routes').panelRouter);
  require('../services/dana_studio').reconcileOnStartup();

  return new Promise(resolve => {
    const server = app.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
      const ips = lan ? Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => i.address) : [];
      console.log(`Dana studio preview: http://127.0.0.1:${port}/dana-studio.html`);
      for (const ip of ips) console.log(`  from a phone on the same Wi-Fi: http://${ip}:${port}/dana-studio.html (login required)`);
      console.log(`data: ${dataDir}   publishing: OFF   notifications: MOCK`);
      resolve({ server, port, dataDir, token: process.env.DANA_WORKER_TOKEN });
    });
  });
}

module.exports = { start };
if (require.main === module) start();
