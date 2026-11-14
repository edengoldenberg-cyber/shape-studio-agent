#!/usr/bin/env node
/**
 * run_mjs_tests.mjs — runner for the standalone ESM integration harnesses (tests/*.test.mjs).
 *
 * These files are NOT Jest suites. Each one is a self-contained Node script that starts
 * its own mock Green API / Arbox HTTP server and its own app server (in-process or as a
 * child process), prints ✓ / ✗ lines and a final "PASS=N FAIL=M" summary.
 *
 * Usage:
 *   node tests/run_mjs_tests.mjs                    all isolated harnesses
 *   node tests/run_mjs_tests.mjs --filter callback  only files matching the pattern
 *   node tests/run_mjs_tests.mjs --verbose          print each harness's full output
 *
 * Isolation (enforced here, for every harness):
 *   • a FRESH temporary DATA_DIR per file — never the repo's data/ folder, never production
 *   • KNOWN_MEMBERS_PATH / STAFF_CONFIG_PATH inside that directory
 *   • dummy external credentials (Green API, OpenAI, Arbox, Meta) — a harness that forgets
 *     to point at its mock cannot reach a real provider
 *   • no log files
 *   • the harness's whole process tree is killed when it finishes or times out, so no
 *     server process is left behind (only processes started by this runner are touched)
 *
 * LIVE-SERVER harnesses (barak_burst, barak_conversation) need a server you start
 * yourself and are skipped unless TEST_BASE_URL is set. callback_demo.mjs is a demo
 * script, not a test.
 */

import { spawn, spawnSync } from 'child_process';
import { fileURLToPath }    from 'url';
import { readdirSync }      from 'fs';
import { createRequire }    from 'module';
import path                 from 'path';

const require   = createRequire(import.meta.url);
const { createIsolatedDataDir, removeDir, isolatedChildEnv } = require('./helpers/isolated_env.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root      = path.join(__dirname, '..');

const args     = process.argv.slice(2);
const fIdx     = args.indexOf('--filter');
const filterRe = fIdx >= 0 && args[fIdx + 1] ? new RegExp(args[fIdx + 1], 'i') : null;
const verbose  = args.includes('--verbose');
const TIMEOUT_MS = Number(process.env.MJS_TEST_TIMEOUT_MS) || 180_000;

const LIVE_SERVER = new Set(['barak_burst.test.mjs', 'barak_conversation.test.mjs']);
const liveAllowed = !!process.env.TEST_BASE_URL;
// barak_local asserts on real model output (reply content), so it needs a real OpenAI
// key and network access. It is not an isolated test: run it explicitly with
//   LIVE_OPENAI=1 OPENAI_API_KEY=sk-... node tests/barak_local.test.mjs
const LIVE_AI = new Set(['barak_local.test.mjs']);
const liveAiAllowed = process.env.LIVE_OPENAI === '1';

const all = readdirSync(__dirname).filter(f => f.endsWith('.test.mjs')).sort();
const skipped   = all.filter(f => LIVE_SERVER.has(f) && !liveAllowed);
const skippedAi = all.filter(f => LIVE_AI.has(f) && !liveAiAllowed);
const files   = all
  .filter(f => !LIVE_SERVER.has(f) || liveAllowed)
  .filter(f => !LIVE_AI.has(f) || liveAiAllowed)
  .filter(f => !filterRe || filterRe.test(f));

if (!files.length) {
  console.error('No .test.mjs files found (or filter matched nothing).');
  process.exit(1);
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  }
}

console.log(`\n${'─'.repeat(64)}`);
console.log(`  Running ${files.length} standalone harness(es) — isolated DATA_DIR per file`);
if (filterRe) console.log(`  Filter: ${filterRe}`);
if (skipped.length) console.log(`  Skipped (live-server, set TEST_BASE_URL to run): ${skipped.join(', ')}`);
if (skippedAi.length) console.log(`  Skipped (needs a real OpenAI key, LIVE_OPENAI=1): ${skippedAi.join(', ')}`);
console.log(`${'─'.repeat(64)}\n`);

let totalPass = 0, totalFail = 0;
const results = [];

for (const file of files) {
  const filePath = path.join(__dirname, file);
  const dataDir  = createIsolatedDataDir(`shape-mjs-${file.replace(/\W+/g, '_')}-`);
  process.stdout.write(`  ${file} … `);

  const { exitCode, out, timedOut } = await new Promise(resolve => {
    let out = '', done = false;
    const child = spawn(process.execPath, [filePath], {
      cwd: root,
      env: isolatedChildEnv(dataDir, { TEST_MODE: 'true', LOG_SILENT: 'true', LOG_TO_FILE: 'false', MJS_ISOLATED_DATA_DIR: dataDir }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    child.stdout.on('data', d => { out += d.toString(); });
    child.stderr.on('data', d => { out += d.toString(); });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      killTree(child.pid);
      resolve({ exitCode: 124, out: out + '\n[TIMEOUT]', timedOut: true });
    }, TIMEOUT_MS);
    child.on('close', code => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killTree(child.pid);   // reap any server the harness spawned and left running
      resolve({ exitCode: code, out, timedOut: false });
    });
  });
  removeDir(dataDir);

  // Counts come from the file's own FINAL summary line ("<file>: PASS=N FAIL=M", or the
  // last "PASS=N FAIL=M" it prints). Section sub-totals are not added on top.
  const summaries = [...out.matchAll(/PASS(?:ED)?[=:]\s*(\d+)\s+FAIL(?:ED)?[=:]\s*(\d+)/gi)];
  const named     = [...out.matchAll(new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\n]*PASS=(\\d+)\\s+FAIL=(\\d+)', 'gi'))];
  const finalSum  = named.at(-1) ?? summaries.at(-1) ?? null;
  const checkLines = (out.match(/^\s*✓/gm) ?? []).length;
  const crossLines = (out.match(/^\s*✗/gm) ?? []).length;
  let pass = finalSum ? +finalSum[1] : checkLines;
  let fail = finalSum ? +finalSum[2] : crossLines;
  if (crossLines > fail) fail = crossLines;   // a printed ✗ always counts
  // A crash or timeout is a failure even when every printed check passed — except the
  // known Node-on-Windows libuv abort that fires inside process.exit() AFTER the final
  // summary was printed with FAIL=0; that one is reported as a warning, not hidden.
  const exitAbort = exitCode !== 0 && !timedOut && fail === 0 && !!finalSum
    && /UV_HANDLE_CLOSING/.test(out);
  if ((exitCode !== 0 || timedOut) && fail === 0 && !exitAbort) fail = 1;
  if (exitAbort) results.exitAborts = [...(results.exitAborts ?? []), file];

  totalPass += pass; totalFail += fail;
  results.push({ file, pass, fail, exitCode, timedOut });
  console.log(`${fail === 0 ? '✓' : '✗'}  PASS=${pass}  FAIL=${fail}${timedOut ? '  (TIMEOUT)' : exitAbort ? '  (⚠ all checks passed; Node/libuv aborted inside process.exit on Windows)' : exitCode !== 0 ? `  (exit ${exitCode})` : ''}`);

  if (verbose) console.log(out.split('\n').map(l => '      ' + l).join('\n'));
  else if (fail > 0) {
    out.split('\n')
      .filter(l => /✗|\[FATAL|Error:|TIMEOUT|Unhandled/.test(l))
      .slice(0, 25)
      .forEach(l => console.log('      ' + l.trim().slice(0, 300)));
  }
}

console.log(`\n${'─'.repeat(64)}`);
console.log(`  Results: PASS=${totalPass}  FAIL=${totalFail}  (${files.length} files)`);
console.log(`${'─'.repeat(64)}\n`);

if (results.exitAborts?.length) console.log(`  ⚠ exit-time libuv abort after a clean summary: ${results.exitAborts.join(', ')}
`);
if (totalFail > 0) {
  console.error('  Failing files:');
  results.filter(r => r.fail > 0).forEach(r => console.error(`    ✗ ${r.file}  FAIL=${r.fail}`));
  process.exit(1);
}
process.exit(0);
