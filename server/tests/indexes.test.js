'use strict';

/**
 * Step 02 — index verifier tests (gate G2.4 / G4.3).
 *
 * G2.4 requires proof that `scripts/verify-indexes.js` actually fails when an
 * expected index is absent, so this drives both the exported function and the
 * CLI (asserting its non-zero exit code) against a scratch collection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { connect, disconnect } = require('../src/config/db');
const { verifyIndexes, baseline } = require('../scripts/verify-indexes');

const SERVER_DIR = path.resolve(__dirname, '..');
const SCRIPT = path.join('scripts', 'verify-indexes.js');

const SCRATCH = `scratch_idx_${process.pid}_${Date.now()}`;
const PRESENT_INDEX = 'present_index_1';

let available = false;
let unavailableReason = '';

test.before(async () => {
  try {
    await connect();
    available = true;
    // Create the scratch collection with one known index.
    await mongoose.connection.db.collection(SCRATCH).createIndex({ email: 1 }, { name: PRESENT_INDEX });
  } catch (err) {
    available = false;
    unavailableReason = (err && err.name) || 'connection failed';
  }
});

test.after(async () => {
  if (available) await mongoose.connection.db.collection(SCRATCH).drop().catch(() => {});
  await disconnect();
});

function requireDb(t) {
  if (available) return true;
  t.skip(`MongoDB not reachable (${unavailableReason})`);
  return false;
}

test('verifyIndexes reports no missing index when it is present', async (t) => {
  if (!requireDb(t)) return;

  const { missing } = await verifyIndexes(mongoose.connection.db, {
    [SCRATCH]: [{ name: PRESENT_INDEX }]
  });
  assert.deepEqual(missing, []);
});

test('G2.4 verifyIndexes reports a missing index that is genuinely absent', async (t) => {
  if (!requireDb(t)) return;

  const { missing } = await verifyIndexes(mongoose.connection.db, {
    [SCRATCH]: [{ name: PRESENT_INDEX }, { name: 'never_created_1' }]
  });

  assert.equal(missing.length, 1);
  assert.equal(missing[0].collection, SCRATCH);
  assert.equal(missing[0].name, 'never_created_1');
});

test('verifyIndexes treats an absent collection as missing, not as a pass', async (t) => {
  if (!requireDb(t)) return;

  const { missing } = await verifyIndexes(mongoose.connection.db, {
    definitely_not_a_collection: [{ name: 'x_1' }]
  });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].reason, 'collection missing');
});

test('G4.3 baseline lists the scratch collection indexes', async (t) => {
  if (!requireDb(t)) return;

  const entries = await baseline(mongoose.connection.db, [SCRATCH]);
  const entry = entries.find((e) => e.collection === SCRATCH);
  assert.ok(entry, 'the scratch collection should appear in the baseline');
  assert.ok(entry.indexes.some((idx) => idx.name === PRESENT_INDEX));
});

test('G2.4 the CLI exits non-zero when an expected index is missing', (t) => {
  if (!requireDb(t)) return;

  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: SERVER_DIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      VERIFY_INDEXES_EXPECTATIONS: JSON.stringify({ [SCRATCH]: { never_created_1: 'never_created_1' } })
    }
  });

  assert.equal(result.status, 1, `expected exit 1\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  assert.match(result.stderr, /never_created_1/);
});

test('the CLI exits zero when every expected index is present', (t) => {
  if (!requireDb(t)) return;

  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: SERVER_DIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      VERIFY_INDEXES_EXPECTATIONS: JSON.stringify({ [SCRATCH]: { [PRESENT_INDEX]: PRESENT_INDEX } })
    }
  });

  assert.equal(result.status, 0, `expected exit 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
});
