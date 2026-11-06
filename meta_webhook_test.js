'use strict';
/**
 * Standalone Meta webhook verification server — port 3001.
 * Run alongside the main server to isolate whether the issue is in
 * server.js or in the ngrok tunnel itself.
 *
 * Usage:
 *   node meta_webhook_test.js
 *
 * Then point a SECOND ngrok tunnel at port 3001:
 *   ngrok http 3001
 *
 * Use the random ngrok URL in Meta portal as a test.
 * If THIS passes but the main server (port 3000) doesn't → issue is in server.js.
 * If THIS also fails → issue is ngrok / Meta connectivity.
 */
const http = require('http');
const url  = require('url');

const VERIFY_TOKEN = process.env.META_LEADS_VERIFY_TOKEN ?? 'shape_studio_leads';
const PORT         = 3001;

const server = http.createServer((req, res) => {
  const parsed  = url.parse(req.url, true);
  const mode      = parsed.query['hub.mode'];
  const token     = parsed.query['hub.verify_token'];
  const challenge = parsed.query['hub.challenge'];

  // Log every single request — raw Node, no Express, no middleware
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  console.log('  User-Agent :', req.headers['user-agent']);
  console.log('  mode       :', mode);
  console.log('  token_got  :', token);
  console.log('  token_want :', VERIFY_TOKEN);
  console.log('  challenge  :', challenge);
  console.log('  match      :', mode === 'subscribe' && token === VERIFY_TOKEN);

  // Set ngrok bypass on every response
  res.setHeader('ngrok-skip-browser-warning', 'true');
  res.setHeader('Cache-Control', 'no-cache');

  if (req.method === 'GET' && parsed.pathname === '/api/leads/webhook'
      && mode === 'subscribe' && token === VERIFY_TOKEN) {
    const body = Buffer.from(String(challenge), 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': body.length });
    res.end(body);
    console.log('  → 200 VERIFIED');
    return;
  }

  if (req.method === 'POST') {
    res.writeHead(200);
    res.end();
    console.log('  → 200 POST ack');
    return;
  }

  res.writeHead(403);
  res.end('403 Forbidden');
  console.log('  → 403 REJECTED');
});

server.listen(PORT, () => {
  console.log(`\nMeta webhook test server on http://localhost:${PORT}`);
  console.log(`Verify token : ${VERIFY_TOKEN}`);
  console.log(`Test locally :`);
  console.log(`  curl "http://localhost:${PORT}/api/leads/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=TEST123"\n`);
});
