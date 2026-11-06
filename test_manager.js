#!/usr/bin/env node
/**
 * Interactive CLI for Maya — Shape Studio AI Operations Manager.
 * Mocks logger only (manager_agent never calls WhatsApp directly).
 * Requires OPENAI_API_KEY in .env.
 *
 * Usage:   node test_manager.js
 *
 * Commands:
 *   /seed      Populate store with 6 realistic demo leads (hot/warm/cold/crisis)
 *   /report    Ask Maya for a full daily pipeline report
 *   /hot       Ask Maya to list hot leads and recommended next actions
 *   /health    Ask Maya for system health summary
 *   /clear     Clear conversation history (keep store data)
 *   /reset     Clear store AND conversation — fresh start
 *   exit       Quit
 */

require('dotenv').config();

// ── ANSI colours ──────────────────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  red:     '\x1b[31m',
  magenta: '\x1b[35m',
  blue:    '\x1b[34m',
};

// ── Mock logger BEFORE loading any agent ─────────────────────────────────────
const { createLogger, format, transports } = require('winston');
const silentLogger = createLogger({
  level: 'error',  // only surface real errors in the manager CLI
  format: format.combine(
    format.timestamp({ format: 'HH:mm:ss' }),
    format.printf(({ timestamp, level, message, ...meta }) => {
      if (level === 'error') {
        return `${C.dim}[${timestamp}]${C.reset} ${C.red}✖  ${message} ${JSON.stringify(meta)}${C.reset}`;
      }
      return '';
    })
  ),
  transports: [new transports.Console()],
});

const loggerPath = require.resolve('./utils/logger');
require.cache[loggerPath] = {
  id: loggerPath, filename: loggerPath, loaded: true,
  exports: silentLogger,
};

// ── Load agents and store ─────────────────────────────────────────────────────
const manager = require('./agents/manager_agent');
const store   = require('./utils/lead_store');

// ── Readline ──────────────────────────────────────────────────────────────────
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// ── UI helpers ────────────────────────────────────────────────────────────────
function divider(char = '─', colour = C.dim) {
  process.stdout.write(`${colour}${char.repeat(62)}${C.reset}\n`);
}

function printBanner() {
  console.clear();
  console.log(`\n${C.magenta}${C.bold}  Shape Studio — Operations Manager (Maya)${C.reset}`);
  console.log(`${C.dim}  Talk directly with Maya about your lead pipeline and studio ops.${C.reset}`);
  console.log(`\n${C.dim}  Shortcuts:  ${C.reset}${C.bold}/seed${C.dim}  load demo leads   ${C.reset}${C.bold}/report  /hot  /health${C.dim}  quick queries${C.reset}`);
  console.log(`${C.dim}              ${C.reset}${C.bold}/clear${C.dim}  reset chat   ${C.reset}${C.bold}/reset${C.dim}  wipe store   ${C.reset}${C.bold}exit${C.dim}  quit${C.reset}\n`);
  divider('═', C.magenta);
  console.log();
}

function printPipelineSummary() {
  const s = store.getDailyStats();
  const parts = [
    `${C.bold}${s.totalLeads}${C.reset} leads`,
    `${C.green}${C.bold}${s.hotLeadsTotal}🔥${C.reset}`,
    `${C.yellow}${C.bold}${s.warmLeadsTotal}🌡${C.reset}`,
    `${C.dim}${s.coldLeadsTotal}❄️${C.reset}`,
  ];
  if (s.crisisActive > 0) parts.push(`${C.red}${C.bold}${s.crisisActive}🚨${C.reset}`);
  process.stdout.write(`${C.dim}  Pipeline: ${C.reset}${parts.join('  ')}${C.dim} · today: ${s.newLeadsToday} new${C.reset}\n\n`);
}

async function sendToMaya(message) {
  process.stdout.write(`\n${C.dim}  Maya is thinking...${C.reset}\r`);
  let reply;
  try {
    reply = await manager.chat(message);
  } catch (err) {
    reply = `Error: ${err.message}`;
  }

  // Clear "thinking" line
  process.stdout.write(`${' '.repeat(30)}\r`);

  divider();
  // Render *bold* markers
  const rendered = reply.replace(/\*\*(.+?)\*\*/g, `${C.bold}$1${C.reset}`)
                        .replace(/\*(.+?)\*/g,     `${C.bold}$1${C.reset}`);
  // Indent every line
  const indented = rendered.split('\n').map(l => `  ${l}`).join('\n');
  console.log(`${C.magenta}${C.bold}  Maya›${C.reset}\n${indented}`);
  divider();
  console.log();
}

// ── Command shortcuts ─────────────────────────────────────────────────────────
const SHORTCUTS = {
  '/report': 'Give me a full daily pipeline report. Include who needs attention and your top recommendation.',
  '/hot':    'List all hot leads right now. For each one, tell me what the best next action is.',
  '/health': 'Give me a system health summary — pipeline score distribution, any crises, overall status.',
};

// ── Prompt loop ───────────────────────────────────────────────────────────────
function prompt() {
  rl.question(`${C.green}${C.bold}  You› ${C.reset}`, async (raw) => {
    const input = raw.trim();
    if (!input) return prompt();

    // ── Built-in commands ─────────────────────────────────────────────────
    if (input.toLowerCase() === 'exit') {
      console.log(`\n${C.dim}  Session ended.${C.reset}\n`);
      rl.close();
      process.exit(0);
    }

    if (input === '/seed') {
      const count = store.seedDemoData();
      console.log(`${C.dim}  ✔ Seeded ${count} demo leads into the store.${C.reset}`);
      printPipelineSummary();
      return prompt();
    }

    if (input === '/clear') {
      manager.clearHistory();
      console.log(`${C.dim}  ✔ Conversation history cleared.${C.reset}\n`);
      return prompt();
    }

    if (input === '/reset') {
      store.clear();
      manager.clearHistory();
      console.log(`${C.dim}  ✔ Store wiped and conversation cleared.${C.reset}\n`);
      return prompt();
    }

    // Expand shortcut to a full prompt
    const message = SHORTCUTS[input] ?? input;
    if (SHORTCUTS[input]) {
      console.log(`${C.dim}  → ${message}${C.reset}`);
    }

    console.log();
    await sendToMaya(message);
    prompt();
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────
printBanner();

// Show pipeline state on launch if store already has data
if (store.getAllLeads().length > 0) {
  printPipelineSummary();
} else {
  console.log(`${C.dim}  Store is empty. Type ${C.reset}${C.bold}/seed${C.dim} to load demo leads, or start the lead agent first.${C.reset}\n`);
}

prompt();
