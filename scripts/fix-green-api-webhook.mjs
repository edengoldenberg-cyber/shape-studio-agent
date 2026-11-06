/**
 * fix-green-api-webhook.mjs
 *
 * Fixes the Green API webhook not delivering inbound messages.
 *
 * Root cause: Green API's internal routing table caches the webhook URL.
 * After changing the URL via dashboard or API, the instance must be REBOOTED
 * for the change to propagate to Green API's delivery infrastructure.
 *
 * Run from the shape-studio-agent directory:
 *   node scripts/fix-green-api-webhook.mjs
 */

import https from 'https';

// ── Config ────────────────────────────────────────────────────────────────────
const INSTANCE_ID     = process.env.GREEN_API_INSTANCE_ID || '7103533626';
const TOKEN           = process.env.GREEN_API_TOKEN       || '0f6463eed993499192247c00f1cdd69d778cf0069d8c46aa95';
const BASE            = `https://${process.env.GREEN_API_URL || '7103.api.green-api.com'}`;
const TARGET_WEBHOOK  = 'https://shape-studio-agent-production.up.railway.app/api/green-api/webhook';

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url     = new URL(`${BASE}${path}`);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path:     url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Green API Webhook Fix Script');
  console.log(`  Instance : ${INSTANCE_ID}`);
  console.log(`  Target   : ${TARGET_WEBHOOK}`);
  console.log('═══════════════════════════════════════════════════\n');

  // ── Step 1: Verify current state ────────────────────────────────────────────
  process.stdout.write('1/4  Reading current settings ... ');
  const { body: settings } = await request('GET',
    `/waInstance${INSTANCE_ID}/getSettings/${TOKEN}`);
  console.log('done');

  console.log(`     webhookUrl      : ${settings.webhookUrl || '(empty)'}`);
  console.log(`     incomingWebhook : ${settings.incomingWebhook}`);
  console.log(`     stateInstance   : (checking next)\n`);

  const { body: state } = await request('GET',
    `/waInstance${INSTANCE_ID}/getStateInstance/${TOKEN}`);
  console.log(`     stateInstance   : ${state.stateInstance}`);

  if (state.stateInstance !== 'authorized') {
    console.error('\n✗  Instance is not authorized. Scan the QR code in the Green API console first.');
    process.exit(1);
  }
  console.log();

  // ── Step 2: Push correct settings atomically ─────────────────────────────────
  process.stdout.write('2/4  Applying webhook settings ... ');
  const { status: setStatus, body: setResult } = await request(
    'POST',
    `/waInstance${INSTANCE_ID}/setSettings/${TOKEN}`,
    {
      webhookUrl:                   TARGET_WEBHOOK,
      incomingWebhook:              'yes',   // receive incoming messages
      outgoingWebhook:              'no',    // don't receive outgoing-from-phone events
      outgoingMessageWebhook:       'no',    // prevent delivery loops
      outgoingAPIMessageWebhook:    'no',    // prevent loop when we send via API
      deviceWebhook:                'no',
      stateWebhook:                 'no',
      statusInstanceWebhook:        'no',
      incomingCallWebhook:          'no',
    },
  );
  if (setStatus === 200 && setResult.saveSettings) {
    console.log('saved ✓');
  } else {
    console.log(`\n     response: HTTP ${setStatus}`, JSON.stringify(setResult));
  }
  console.log();

  // ── Step 3: Reboot the instance ──────────────────────────────────────────────
  // Green API caches webhook routing internally. A reboot flushes the cache
  // and forces it to reload the new settings from the database.
  process.stdout.write('3/4  Rebooting instance (flushes routing cache) ... ');
  const { status: rebootStatus, body: rebootResult } = await request(
    'GET',
    `/waInstance${INSTANCE_ID}/reboot/${TOKEN}`,
  );
  if (rebootStatus === 200 && rebootResult.isReboot) {
    console.log('rebooting ✓');
  } else {
    console.log(`\n     response: HTTP ${rebootStatus}`, JSON.stringify(rebootResult));
  }
  console.log('     Waiting 20s for instance to restart...');
  await sleep(20_000);
  console.log();

  // ── Step 4: Verify settings and state after reboot ───────────────────────────
  process.stdout.write('4/4  Verifying post-reboot state ... ');
  const { body: newState } = await request('GET',
    `/waInstance${INSTANCE_ID}/getStateInstance/${TOKEN}`);
  const { body: newSettings } = await request('GET',
    `/waInstance${INSTANCE_ID}/getSettings/${TOKEN}`);
  console.log('done\n');

  const webhookOk   = newSettings.webhookUrl === TARGET_WEBHOOK;
  const incomingOk  = newSettings.incomingWebhook === 'yes';
  const authorizedOk = newState.stateInstance === 'authorized';

  console.log('═══════════════════════════════════════════════════');
  console.log('  Verification Results');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  stateInstance    : ${newState.stateInstance}  ${authorizedOk ? '✓' : '✗ NOT AUTHORIZED'}`);
  console.log(`  webhookUrl       : ${newSettings.webhookUrl}`);
  console.log(`  webhookUrl match : ${webhookOk ? '✓' : '✗ MISMATCH'}`);
  console.log(`  incomingWebhook  : ${newSettings.incomingWebhook}  ${incomingOk ? '✓' : '✗'}`);
  console.log('═══════════════════════════════════════════════════\n');

  if (!authorizedOk) {
    console.error('✗  Instance is not authorized after reboot. Open Green API console and re-scan QR code.');
    process.exit(1);
  }
  if (!webhookOk || !incomingOk) {
    console.error('✗  Settings did not apply correctly. Try running this script again.');
    process.exit(1);
  }

  console.log('✓  All settings verified. Sending live webhook test...\n');

  // ── Step 5: Send a self-test message via the API ──────────────────────────────
  // This will cause Green API to push a webhook to our URL immediately
  // (the reply to ourselves is just to trigger the delivery mechanism)
  const ownChatId = `${INSTANCE_ID}@c.us`;  // message to self
  process.stdout.write('  Sending test message to trigger webhook delivery ... ');
  const { status: sendStatus, body: sendResult } = await request(
    'POST',
    `/waInstance${INSTANCE_ID}/sendMessage/${TOKEN}`,
    { chatId: ownChatId, message: `[webhook-test] ${new Date().toISOString()}` },
  );
  if (sendStatus === 200 && sendResult.idMessage) {
    console.log(`sent ✓  (idMessage: ${sendResult.idMessage})`);
  } else {
    console.log(`\n  response: HTTP ${sendStatus}`, JSON.stringify(sendResult));
  }

  console.log('\n✓  Done. Now send a WhatsApp message to your bot number and check Railway logs.');
  console.log('  railway logs --service "shape-studio-agent"\n');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
