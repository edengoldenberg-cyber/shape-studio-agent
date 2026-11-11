/**
 * scripts/demo_conversation.mjs — scripted local conversation demo.
 *
 * Runs 2 preset scenarios through the real lead agent (real OpenAI, mocked WhatsApp).
 * No WhatsApp sends. No data persistence. Prints each exchange clearly for review.
 *
 * Usage: node scripts/demo_conversation.mjs
 * Requires: OPENAI_API_KEY in .env
 */

import { createRequire } from 'module';
import path   from 'path';
import os     from 'os';
import fs     from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require   = createRequire(import.meta.url);

require('dotenv').config({ path: path.join(__dirname, '../.env') });

// ── Redirect persistence to temp dir so demo data never touches data/ ─────────
const TEST_DATA_DIR = path.join(os.tmpdir(), `barak-demo-${process.pid}`);
fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
process.env.DATA_DIR = TEST_DATA_DIR;

// ── Capture all outbound sends ────────────────────────────────────────────────
const _sends  = [];
const _alerts = [];

const waCachePath = require.resolve(path.join(__dirname, '../services/whatsapp.service'));
require.cache[waCachePath] = {
  id: waCachePath, filename: waCachePath, loaded: true,
  exports: {
    sendText:              async (_to, text) => { _sends.push(text); },
    alertOwner:            async (subj)      => { _alerts.push(subj); },
    sendFileByUrl:         async ()          => {},
    releaseQueuedMessages: async ()          => {},
    parseInbound:          ()                => null,
    parseInboundRich:      ()                => null,
    verifyWebhook:         (_req, res)       => res?.status(200).end(),
    notifyLeadTeam:        async ()          => {},
    probeGreenApiConnection: async ()        => ({ ok: true }),
    getGreenCreds:         ()                => ({}),
    _tokenSourceVar:       'DEMO',
    SCOPE_ARBOX_BUSINESS:  'demo',
  },
};

// Suppress console noise from other requires
const { handleInbound, clearSession } = require(path.join(__dirname, '../agents/lead_agent'));
const store = require(path.join(__dirname, '../utils/lead_store'));

// ── ANSI helpers ──────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};

function divider() { console.log(`${C.dim}${'─'.repeat(70)}${C.reset}`); }

function printTurn(role, text, turnNum) {
  if (role === 'lead') {
    console.log(`\n${C.green}${C.bold}  Lead [${turnNum}]›${C.reset} ${text}`);
  } else {
    const lines = text.split('\n');
    console.log(`${C.cyan}${C.bold}  Barak›${C.reset} ${lines[0]}`);
    for (const l of lines.slice(1)) console.log(`         ${l}`);
  }
}

function countQuestions(text) {
  const stripped = text.replace(/https?:\/\/\S+/g, '');
  return (stripped.match(/\?/g) ?? []).length;
}

function checkRules(reply, turn, knownFacts) {
  const warnings = [];
  if (countQuestions(reply) > 1) warnings.push(`⚠ ${countQuestions(reply)} question marks (rule: max 1)`);
  if (knownFacts.location && /מאיזה אזור|מה האזור/i.test(reply))
    warnings.push(`⚠ re-asked location (already known: "${knownFacts.location}")`);
  if (knownFacts.interest && /מה מחפשים|מה את מחפשת|מה אתה מחפש/i.test(reply))
    warnings.push(`⚠ re-asked interest (already known: "${knownFacts.interest}")`);
  return warnings;
}

async function runScenario(title, turns) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`${C.bold}${C.yellow}  ${title}${C.reset}`);
  console.log(`${'═'.repeat(70)}`);

  const phone = `9725009${Math.floor(Math.random() * 90000 + 10000)}`;
  const knownFacts = {};
  let turnNum = 0;

  for (const { text, name = null } of turns) {
    turnNum++;
    _sends.length = 0;

    printTurn('lead', text, turnNum);

    // Track facts from lead messages
    if (/חדרה|קיסריה|זכרון|בנימינה|נתניה|חיפה|תל אביב|ת"א/i.test(text))
      knownFacts.location = text.match(/חדרה|קיסריה|זכרון|בנימינה|נתניה|חיפה|תל אביב|ת"א/i)?.[0];
    if (/פילאטיס|רפורמר|יוגה|כוח|strength|barre/i.test(text))
      knownFacts.interest = text.match(/פילאטיס|רפורמר|יוגה|כוח|strength|barre/i)?.[0];

    try {
      await handleInbound({ from: phone, name, text });
    } catch (err) {
      console.log(`${C.red}  Error: ${err.message}${C.reset}`);
      continue;
    }

    const reply = _sends[0] ?? '(no reply)';
    printTurn('barak', reply, turnNum);

    const warnings = checkRules(reply, turnNum, knownFacts);
    for (const w of warnings) console.log(`  ${C.red}${w}${C.reset}`);

    divider();
  }

  clearSession(phone);
  store.deleteLead(phone);
}

// ── Scenario 1: Multi-fact first message → discovery → call close ─────────────
await runScenario('Scenario 1 — Reformer lead from Hadera, goal-focused', [
  { text: 'שלום, אני מחדרה, מחפשת פילאטיס מכשירים לאחרי הריון' },
  { text: 'אני 5 חודשים אחרי לידה, הגב מאוד כואב לי' },
  { text: 'כמה עולה מנוי?' },
  { text: 'יקר לי קצת' },
  { text: 'אין בעיה עם המיקום' },
  { text: 'רוני' },
  { text: 'בוקר יותר נוח לי' },
]);

// ── Scenario 2: Price-first lead → engagement → call ─────────────────────────
await runScenario('Scenario 2 — Minimal greeting, then price, then interest', [
  { text: 'שלום' },
  { text: 'מה המחירים שלכם?' },
  { text: 'מחדרה, מחפש אימון כוח' },
  { text: 'כן, המיקום בסדר' },
  { text: 'דנה' },
  { text: 'ערב נוח' },
]);

// ── Scenario 3: Lead who refuses call, then agrees after info ─────────────────
await runScenario('Scenario 3 — Refuses call, wants info first, then agrees', [
  { text: 'שלום, מחפש יוגה, מנתניה' },
  { text: 'מה סגנון האשטנגה שלכם?' },
  { text: 'לא רוצה שיתקשרו אלי, רק רוצה פרטים' },
  { text: 'עמי' },
  { text: 'בסדר, אפשר שיתקשרו אלי' },
  { text: 'מחר אחרי הצהריים' },
]);

// ── Clean up temp data ────────────────────────────────────────────────────────
try { fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }); } catch {}

console.log(`\n${C.bold}Done. Review the exchanges above for natural Hebrew, single questions, and no re-asks.${C.reset}\n`);
