// One-command gate runner.
//
//   npm run verify                      # or: node scripts/verify-all.mjs
//
// Boots the API on a scratch database with the project's real configuration,
// then runs every step verification harness (01, 03–13, 15) against it, plus
// scripts/verify-indexes.js, and prints one gate report. Exits non-zero if any
// harness fails.
//
// Why a fresh server per harness: the rate limiters are in-memory, and the
// harnesses are written for production defaults — step 03 deliberately exhausts
// the login bucket to prove the 429, which would starve every later harness if
// they shared one process. Each harness therefore gets a clean window, exactly
// as the step audits ran them.
//
// Environment:
//   GATE_DB=chandravanshi_vivah_gate   scratch database (name must contain
//                                      "test" or "gate" — it is dropped first)
//   GATE_PORT=3000                     port 3000 is required by verify-step01
//   GATE_KEEP_DB=1                     keep the scratch database for inspection
//   GATE_KEEP_LOGS=1                   keep the per-harness logs and print paths

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mongoose from 'mongoose';

const require = createRequire(import.meta.url);
const config = require('../src/config/env');

/** Every child process is resolved from the package root, never from cwd. */
const SERVER_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_ENTRY = path.join(SERVER_ROOT, 'src', 'server.js');
const SEEDER = path.join(SERVER_ROOT, 'scripts', 'seed-master-data.js');
const INDEX_CHECK = path.join(SERVER_ROOT, 'scripts', 'verify-indexes.js');
const PRIVILEGE_CHECK = path.join(SERVER_ROOT, 'scripts', 'check-db-privileges.js');

const PORT = String(process.env.GATE_PORT || 3000);
const DB_NAME = process.env.GATE_DB || 'chandravanshi_vivah_gate';
const KEEP_DB = process.env.GATE_KEEP_DB === '1';
const KEEP_LOGS = process.env.GATE_KEEP_LOGS === '1';
const BASE = `http://localhost:${PORT}`;

/** Harnesses in run order; 01 and 04 also take the server log path as argv[2]. */
const HARNESSES = [
  { step: '01', label: 'Project setup & configuration', wantsLog: true },
  { step: '03', label: 'User & authentication', wantsLog: false },
  { step: '04', label: 'Session / token handling', wantsLog: true },
  { step: '05', label: 'Master data', wantsLog: false },
  { step: '06', label: 'Matrimonial profile', wantsLog: false },
  { step: '07', label: 'Partner preferences', wantsLog: false },
  { step: '08', label: 'Photos & Cloudinary', wantsLog: false },
  // Step 09 registers 11 fixture accounts (viewer + 10 candidates), which is
  // more logins than the default brute-force limiter (AUTH_RATE_LIMIT_MAX=10)
  // allows in one window. That limiter is not what this harness verifies, so its
  // server gets a raised limit; step 03, which *does* verify the limiter, keeps
  // the production default and is unaffected (each harness has its own server).
  { step: '09', label: 'Discover / search', wantsLog: false, env: { AUTH_RATE_LIMIT_MAX: '1000' } },
  // Step 10 builds ~9 fixture accounts and deliberately floods an action write
  // (command 7), so it needs both a raised login budget and a raised *global*
  // limiter — otherwise the request-per-minute global cap, not the interaction
  // limiter under test, produces the 429. The action limiter itself keeps the
  // project's real `ACTION_RATE_LIMIT_MAX`.
  { step: '10', label: 'Profile actions', wantsLog: false, env: { AUTH_RATE_LIMIT_MAX: '1000', RATE_LIMIT_MAX: '99999' } },
  // Step 11 builds ~9 fixture accounts and deliberately floods an interest write
  // (command 9), so it needs the same raised login budget and global limiter as
  // step 10. The interest limiter itself keeps the project's real
  // `INTEREST_RATE_LIMIT_MAX`.
  { step: '11', label: 'Interests / connections', wantsLog: false, env: { AUTH_RATE_LIMIT_MAX: '1000', RATE_LIMIT_MAX: '99999' } },
  // Step 12 builds ~8 fixture accounts and deliberately floods both write paths
  // (the block and report limiters), so it needs the same raised login budget and
  // global limiter as steps 10–11. The two safety limiters keep the project's real
  // `BLOCK_RATE_LIMIT_MAX` / `REPORT_RATE_LIMIT_MAX`.
  { step: '12', label: 'Block & report', wantsLog: false, env: { AUTH_RATE_LIMIT_MAX: '1000', RATE_LIMIT_MAX: '99999' } },
  // Step 13 builds ~9 fixture accounts and deliberately floods the mark-read
  // path, so it needs the same raised login budget and global limiter as steps
  // 10–12. The notification limiter itself keeps the project's real
  // `NOTIFY_RATE_LIMIT_MAX`.
  { step: '13', label: 'Notifications', wantsLog: false, env: { AUTH_RATE_LIMIT_MAX: '1000', RATE_LIMIT_MAX: '99999' } },
  // Step 15 (Subscription / Entitlement) builds ~8 fixture accounts — twice as
  // many register+login pairs as the shared brute-force limiter's default — so
  // it needs a raised login budget only. The global limiter stays at its real
  // value: this harness floods nothing.
  { step: '15', label: 'Subscription / entitlement', wantsLog: false, env: { AUTH_RATE_LIMIT_MAX: '1000' } }
];

// Everything else is inherited unchanged: the harnesses are written for the
// project's real configuration (default rate limits, request logging on —
// verify-step01 and verify-step04 inspect the server log).
//
// CLOUDINARY_MOCK: the gate is an **offline** harness run. Its harnesses
// fabricate asset references — they call `/photos/sign`, then register a
// `publicId` nobody uploaded — which only `src/config/localAssetStore.js` can
// verify. A live provider answers 404 for every fabricated id, so no photo could
// be registered, no profile could publish (spec §15), and steps 06-10 would all
// fail for a reason unrelated to what they test.
//
// The run is therefore pinned to mock mode and the credential variables are
// removed from the children **for this run only** — whatever `.env` holds. This
// never touches `.env`, and `npm start` still uses the real provider.
// `config/env.js` refuses mock-plus-credentials, so they must be cleared, not
// merely overridden. Set `GATE_LIVE_CLOUDINARY=1` to run the harnesses against
// the real provider instead (then `verify-step08.mjs`'s live round trip runs and
// its fabricated-reference checks are expected to fail).
const childEnv = { ...process.env, PORT, MONGODB_DB_NAME: DB_NAME };
const liveCloudinary = process.env.GATE_LIVE_CLOUDINARY === '1';
if (!liveCloudinary) {
  childEnv.CLOUDINARY_MOCK = 'true';
  // Blanked, not deleted: the child re-loads `.env` with dotenv, which fills any
  // key that is *absent* from the environment but leaves a present-but-empty one
  // alone. An empty value reads as "not set" in config, so this holds the child
  // in mock mode without editing `.env`.
  childEnv.CLOUDINARY_CLOUD_NAME = '';
  childEnv.CLOUDINARY_API_KEY = '';
  childEnv.CLOUDINARY_API_SECRET = '';
}

const logDir = path.join(os.tmpdir(), `chv-gate-${Date.now()}`);
const rows = [];
let failed = 0;

function fail(message) {
  console.error(`\n${message}`);
  process.exitCode = 1;
}

function runNode(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: SERVER_ROOT,
    env: childEnv,
    encoding: 'utf8',
    ...options
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

/** Run a harness and pull its `N/M checks passed` line and any FAIL lines. */
function summarise(output) {
  const counts = output.match(/(\d+)\/(\d+)\s+checks passed/);
  const failures = output
    .split('\n')
    .filter((line) => line.startsWith('FAIL '))
    .map((line) => line.replace(/^FAIL\s+/, '').slice(0, 120));
  return {
    passed: counts ? Number(counts[1]) : null,
    total: counts ? Number(counts[2]) : null,
    failures
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll the health endpoint until the server answers, or give up. */
async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  return false;
}

async function portIsFree() {
  try {
    await fetch(`${BASE}/api/v1/health`, { signal: AbortSignal.timeout(1500) });
    return false; // something answered — the port is taken
  } catch {
    return true;
  }
}

/** Drop the scratch database so harnesses that assert "first submission" see a clean slate. */
async function resetDatabase() {
  await mongoose.connect(config.mongodbUri, { dbName: DB_NAME, serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

async function seedDatabase() {
  const result = runNode([SEEDER]);
  if (result.status !== 0) throw new Error(`seeding failed:\n${result.stderr || result.stdout}`);
  return result.stdout.trim().split('\n').pop();
}

async function runHarness({ step, label, wantsLog, env: envOverrides }) {
  const serverLog = path.join(logDir, `server-step${step}.log`);
  const harnessOut = path.join(logDir, `harness-step${step}.out`);
  let server;
  const started = Date.now();

  // A harness may raise a limit that is not part of what it verifies (see the
  // step-09 entry); everything else inherits the project's real configuration.
  const harnessEnv = envOverrides ? { ...childEnv, ...envOverrides } : childEnv;

  try {
    const fd = fs.openSync(serverLog, 'a');
    server = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: SERVER_ROOT,
      env: harnessEnv,
      stdio: ['ignore', fd, fd]
    });

    if (!(await waitForHealth())) {
      return { step, label, ok: false, detail: 'server did not become healthy', lines: [] };
    }

    const args = [path.join(SERVER_ROOT, `verify-step${step}.mjs`)];
    if (wantsLog) args.push(serverLog);
    const result = runNode(args);
    fs.writeFileSync(harnessOut, `${result.stdout}${result.stderr}`);

    const { passed, total, failures } = summarise(`${result.stdout}${result.stderr}`);
    // The harness's own count is the primary signal; a non-zero exit with a
    // full count means it crashed after printing (the detail line says so).
    const counted = passed !== null && passed === total;
    const ok = counted && result.status === 0;
    const detail =
      passed === null
        ? `no summary line found (exit ${result.status})`
        : `${passed}/${total} checks (exit ${result.status})`;
    return {
      step,
      label,
      ok,
      detail,
      seconds: ((Date.now() - started) / 1000).toFixed(1),
      lines: failures,
      passed,
      total
    };
  } finally {
    if (server) {
      server.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        server.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

/** Advisory only: never changes this report's exit code (see check-db-privileges.js). */
function privilegeAdvisory() {
  const result = runNode([PRIVILEGE_CHECK]);
  // The VERDICT line goes to stdout on success and stderr on failure.
  const verdict = /VERDICT: ([A-Z- ]+)/.exec(`${result.stdout}${result.stderr}`);
  return {
    ok: result.status === 0,
    text: verdict ? verdict[1].trim() : 'unknown'
  };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

if (!/(test|gate)/i.test(DB_NAME)) {
  fail(`Refusing to run: GATE_DB="${DB_NAME}" does not look like a scratch database (must contain "test" or "gate").`);
  process.exit(1);
}

if (!(await portIsFree())) {
  fail(`Port ${PORT} is already in use — stop the process listening there first (verify-step01.mjs requires port 3000).`);
  process.exit(1);
}

fs.mkdirSync(logDir, { recursive: true });
console.log(`Gate run: database "${DB_NAME}", port ${PORT}, logs in ${logDir}\n`);

try {
  await resetDatabase();
  console.log(`seeding: ${await seedDatabase()}`);
} catch (err) {
  fail(`Could not prepare the scratch database: ${err.message}`);
  process.exit(1);
}

for (const harness of HARNESSES) {
  const row = await runHarness(harness);
  rows.push(row);
  if (!row.ok) failed += 1;
  const status = row.ok ? 'PASS' : 'FAIL';
  console.log(`${status}  step ${row.step}  ${row.label.padEnd(30)} ${row.detail}${row.seconds ? ` (${row.seconds}s)` : ''}`);
  for (const line of row.lines) console.log(`        ↳ ${line}`);
}

const indexResult = runNode([INDEX_CHECK]);
const indexOk = indexResult.status === 0;
if (!indexOk) failed += 1;
console.log(`${indexOk ? 'PASS' : 'FAIL'}  scripts/verify-indexes.js${indexOk ? '' : `\n${indexResult.stdout}${indexResult.stderr}`}`);

const advisory = privilegeAdvisory();
console.log(
  `\nAdvisory (does not affect this exit code): MongoDB credential is ${advisory.ok ? 'LEAST PRIVILEGE' : `OVER-PRIVILEGED — ${advisory.text}`}`
);
if (!advisory.ok) {
  console.log('  step 02 G3.2 is open; run `npm run check:db-privileges` for the enforced check and its remediation.');
}

const totalChecks = rows.reduce((sum, row) => sum + (row.total || 0), 0);
const passedChecks = rows.reduce((sum, row) => sum + (row.passed || 0), 0);
console.log(`\n${rows.length - failed + (indexOk ? 1 : 0)}/${rows.length + 1} gates passed; ${passedChecks}/${totalChecks} harness checks passed.`);

if (KEEP_LOGS) {
  console.log(`\nLogs kept in ${logDir}`);
} else {
  // Windows can still hold the per-harness log files for a moment after the
  // server exits, which surfaces as ENOTEMPTY/EBUSY. Retry rather than crashing
  // a gate run that has already produced a verdict.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(logDir, { recursive: true, force: true });
      break;
    } catch (err) {
      if (attempt === 4) {
        console.log(`\nNote: could not remove the log directory ${logDir} (${err.code}) — it is safe to delete.`);
      } else {
        await sleep(300);
      }
    }
  }
}

if (!KEEP_DB) {
  await mongoose.connect(config.mongodbUri, { dbName: DB_NAME, serverSelectionTimeoutMS: 8000 });
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
} else {
  console.log(`Scratch database "${DB_NAME}" kept.`);
}

if (failed > 0) {
  console.error(`\nFAILED gates: ${rows.filter((row) => !row.ok).map((row) => `step ${row.step}`).join(', ')}${indexOk ? '' : ', indexes'}`);
  process.exit(1);
}
console.log('\nAll gates passed.');
