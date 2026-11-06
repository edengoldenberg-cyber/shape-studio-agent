#!/usr/bin/env node
/**
 * Interactive CLI simulator for the Shape Studio lead agent.
 * Mocks WhatsApp and logger so no real API calls are made.
 * Requires only OPENAI_API_KEY in .env.
 *
 * Usage:   node test_chat.js
 * Commands inside the chat:
 *   /name <First Last>   — set the lead's display name
 *   /reset               — clear session and start a fresh lead
 *   exit                 — quit
 */

require('dotenv').config();

// ── ANSI colour helpers ───────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  blue:   '\x1b[34m',
  magenta:'\x1b[35m',
};

// ── Reply buffer — filled by the WhatsApp mock during each turn ───────────────
const replyBuffer = [];

// ─────────────────────────────────────────────────────────────────────────────
// MOCK 1: utils/logger
// Intercepts the lead-score log line and renders it as a visual bar.
// Must be injected BEFORE lead_agent is required.
// ─────────────────────────────────────────────────────────────────────────────
const { createLogger, format, transports } = require('winston');
const testLogger = createLogger({
  level: 'debug',
  format: format.combine(
    format.timestamp({ format: 'HH:mm:ss' }),
    format.printf(({ timestamp, level, message, ...meta }) => {
      if (message === 'Lead score') {
        const score = meta.score ?? 0;
        const filled = '█'.repeat(score);
        const empty  = '░'.repeat(10 - score);
        const colour = score >= 8 ? C.green : score >= 5 ? C.yellow : C.red;
        return (
          `${C.dim}[${timestamp}]${C.reset} ` +
          `${C.bold}${colour}SCORE ${score}/10${C.reset}  ` +
          `${colour}${filled}${C.dim}${empty}${C.reset}  ` +
          `${C.dim}${score >= 8 ? '🔥 HOT' : score >= 5 ? '🌡 WARM' : '❄️  COLD'}${C.reset}`
        );
      }
      if (level === 'warn') {
        return `${C.dim}[${timestamp}]${C.reset} ${C.yellow}⚠  ${message}${C.dim} ${JSON.stringify(meta)}${C.reset}`;
      }
      if (level === 'error') {
        return `${C.dim}[${timestamp}]${C.reset} ${C.red}✖  ${message}${C.dim} ${JSON.stringify(meta)}${C.reset}`;
      }
      // Suppress other info/debug noise in the simulator
      return '';
    })
  ),
  transports: [new transports.Console()],
});

const loggerCachePath = require.resolve('./utils/logger');
require.cache[loggerCachePath] = {
  id: loggerCachePath, filename: loggerCachePath, loaded: true,
  exports: testLogger,
};

// ─────────────────────────────────────────────────────────────────────────────
// MOCK 2: services/whatsapp.service
// Captures sendText calls into replyBuffer instead of hitting Meta's API.
// alertOwner prints a formatted alert box.
// Must be injected BEFORE lead_agent is required.
// ─────────────────────────────────────────────────────────────────────────────
const waCachePath = require.resolve('./services/whatsapp.service');
require.cache[waCachePath] = {
  id: waCachePath, filename: waCachePath, loaded: true,
  exports: {
    sendText:               async (_to, text) => { replyBuffer.push(text); },
    alertOwner:             async (subject, body) => {
      const bar = `${C.red}${'═'.repeat(62)}${C.reset}`;
      console.log(`\n${bar}`);
      console.log(`${C.red}${C.bold}🚨  OWNER ALERT${C.reset}  ${C.bold}${subject}${C.reset}`);
      console.log(`${C.dim}${body}${C.reset}`);
      console.log(`${bar}\n`);
    },
    releaseQueuedMessages:  async () => {},
    verifyWebhook:          () => {},
    parseInbound:           () => null,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Load the real lead agent — it will pick up both mocks from the cache above.
// ─────────────────────────────────────────────────────────────────────────────
const { handleInbound, clearSession } = require('./agents/lead_agent');

// ── Session state ─────────────────────────────────────────────────────────────
const TEST_PHONE = '972500000001';
let leadName     = null;      // set with /name
let turnCount    = 0;

// ── Readline interface ────────────────────────────────────────────────────────
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// ── UI helpers ────────────────────────────────────────────────────────────────
function divider(char = '─', colour = C.dim) {
  console.log(`${colour}${char.repeat(62)}${C.reset}`);
}

function printBanner() {
  console.clear();
  console.log(`\n${C.cyan}${C.bold}  Shape Studio — Lead Agent Simulator${C.reset}`);
  console.log(`${C.dim}  Type messages as a prospective lead. Special commands:${C.reset}`);
  console.log(`${C.dim}  ${C.reset}${C.bold}/name <First Last>${C.dim}  set lead name   ${C.reset}${C.bold}/reset${C.dim}  new session   ${C.reset}${C.bold}exit${C.dim}  quit${C.reset}\n`);
  divider('═', C.cyan);
  console.log();
}

function printAgentReplies() {
  divider();
  replyBuffer.forEach((msg, i) => {
    // WhatsApp bold markers (*text*) → terminal bold
    const rendered = msg.replace(/\*(.+?)\*/g, `${C.bold}$1${C.reset}`);
    console.log(`${C.cyan}${C.bold}  Agent›${C.reset} ${rendered}`);
    if (i < replyBuffer.length - 1) console.log(); // gap between multi-part replies
  });
  divider();
  console.log();
}

// ── Prompt loop ───────────────────────────────────────────────────────────────
function prompt() {
  const nameTag = leadName ? `${C.dim}(${leadName})${C.reset} ` : '';
  rl.question(`${C.green}${C.bold}  You› ${C.reset}${nameTag}`, async (raw) => {
    const input = raw.trim();
    if (!input) return prompt();

    // ── Built-in commands ─────────────────────────────────────────────────
    if (input.toLowerCase() === 'exit') {
      console.log(`\n${C.dim}  Session ended. Goodbye!${C.reset}\n`);
      rl.close();
      process.exit(0);
    }

    if (input.startsWith('/name ')) {
      leadName = input.slice(6).trim();
      console.log(`${C.dim}  ✔ Lead name set to: ${C.bold}${leadName}${C.reset}\n`);
      return prompt();
    }

    if (input === '/reset') {
      clearSession(TEST_PHONE);
      leadName  = null;
      turnCount = 0;
      console.log(`${C.dim}  ✔ Session cleared — fresh lead.${C.reset}\n`);
      return prompt();
    }

    // ── Normal message — pass to lead agent ──────────────────────────────
    turnCount++;
    console.log(); // breathing room
    replyBuffer.length = 0;

    try {
      await handleInbound({ from: TEST_PHONE, name: leadName, text: input });
    } catch (err) {
      if (err.message?.includes('OPENAI_API_KEY')) {
        console.log(`${C.red}  ✖ OpenAI API key missing or invalid.${C.reset}`);
        console.log(`${C.dim}  Add OPENAI_API_KEY=sk-... to your .env file and restart.${C.reset}\n`);
      } else {
        console.log(`${C.red}  ✖ Agent error: ${err.message}${C.reset}\n`);
      }
      return prompt();
    }

    if (replyBuffer.length > 0) {
      printAgentReplies();
    } else {
      console.log(`${C.dim}  (no reply generated this turn)${C.reset}\n`);
    }

    prompt();
  });
}

// ── Go ────────────────────────────────────────────────────────────────────────
printBanner();
prompt();
