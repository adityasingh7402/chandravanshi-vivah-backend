'use strict';

/**
 * Index verification (spec §49, §105; step 02 deliverable).
 *
 * Connects, prints the indexes currently present for every existing canonical
 * collection (the baseline step 09 will build on), then asserts that each
 * expected index exists. Any missing index exits non-zero.
 *
 * Run:  node scripts/verify-indexes.js
 *
 * Step 02 creates no domain collection, so EXPECTED_INDEXES is intentionally
 * empty here; each later step adds its collection's required indexes as its
 * model is written (see §105 for the checklist). Tests exercise this script
 * against a scratch collection to prove it actually fails when an index is
 * removed.
 *
 * `VERIFY_INDEXES_EXPECTATIONS` (JSON) can override the registry for testing:
 *   VERIFY_INDEXES_EXPECTATIONS='{"scratch":{"indexName":"indexName"}}'
 */

const mongoose = require('mongoose');
const { connect, disconnect } = require('../src/config/db');
const { ALL_COLLECTIONS } = require('../src/config/collections');
const { logger } = require('../src/middleware/requestLogger');

/** MongoDB error code for a collection that does not exist yet. */
const NAMESPACE_NOT_FOUND = 26;

/**
 * Required indexes per collection. Keys are collection names; each entry lists
 * `{ name, key }`. A collection listed here MUST exist and MUST have every
 * index, or the script exits non-zero.
 */
const EXPECTED_INDEXES = Object.freeze({
  // Step 03 adds:
  //   users: [
  //     { name: 'email_1', key: { email: 1 } },   // partial unique (§5)
  //     { name: 'phone_1', key: { phone: 1 } }
  //   ]
  // Step 09 adds the discover/search compound indexes (§49, §105).
});

/** Parse the optional test override, returning null when it is not set. */
function loadOverride(raw = process.env.VERIFY_INDEXES_EXPECTATIONS) {
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  // Accept either { collection: [{name,key}] } or { collection: {name: indexName} }.
  const normalized = {};
  for (const [collection, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) {
      normalized[collection] = value;
    } else if (value && typeof value === 'object') {
      normalized[collection] = Object.entries(value).map(([name]) => ({ name }));
    } else {
      normalized[collection] = [{ name: String(value) }];
    }
  }
  return normalized;
}

/**
 * Read a collection's indexes, or null when the collection does not exist.
 * @param {import('mongoose').mongo.Db} db
 * @param {string} name
 */
async function listIndexes(db, name) {
  try {
    return await db.collection(name).indexes();
  } catch (err) {
    if (err && (err.code === NAMESPACE_NOT_FOUND || err.codeName === 'NamespaceNotFound')) return null;
    throw err;
  }
}

/** Render an index key object as a stable string, e.g. `email:1,status:-1`. */
function keyToString(key) {
  return Object.entries(key || {})
    .map(([field, dir]) => `${field}:${dir}`)
    .join(',');
}

/**
 * Compare expectations against what is actually present.
 *
 * @returns {Promise<{rows: object[], missing: object[]}>}
 */
async function verifyIndexes(db, expectations = EXPECTED_INDEXES) {
  const rows = [];
  const missing = [];

  for (const [collection, expected] of Object.entries(expectations)) {
    const indexes = await listIndexes(db, collection);

    if (indexes === null) {
      for (const want of expected) missing.push({ collection, name: want.name, reason: 'collection missing' });
      rows.push({ collection, status: 'missing-collection', indexes: [] });
      continue;
    }

    const presentNames = new Set(indexes.map((idx) => idx.name));
    const absent = expected.filter((want) => !presentNames.has(want.name));
    for (const want of absent) missing.push({ collection, name: want.name, reason: 'index missing' });

    rows.push({ collection, status: absent.length ? 'index-missing' : 'ok', indexes });
  }

  return { rows, missing };
}

/** Every canonical collection that currently exists, with its indexes. */
async function baseline(db, extraCollections = []) {
  const names = [...new Set([...ALL_COLLECTIONS, ...extraCollections])].sort();
  const entries = [];
  for (const name of names) {
    const indexes = await listIndexes(db, name);
    if (indexes === null) continue;
    entries.push({ collection: name, indexes });
  }
  return entries;
}

function printBaseline(entries) {
  if (entries.length === 0) {
    console.log('No canonical collections exist yet — nothing to index.');
    return;
  }
  console.log('Existing collection indexes:');
  console.log('| Collection | Index | Keys |');
  console.log('|---|---|---|');
  for (const entry of entries) {
    for (const idx of entry.indexes) {
      console.log(`| ${entry.collection} | ${idx.name} | ${keyToString(idx.key)} |`);
    }
  }
}

function printMissing(missing) {
  console.error('\nMISSING INDEXES:');
  for (const item of missing) {
    console.error(`  ${item.collection}.${item.name} — ${item.reason}`);
  }
}

async function main() {
  let override;
  try {
    override = loadOverride();
  } catch (err) {
    console.error(`Invalid VERIFY_INDEXES_EXPECTATIONS: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const expectations = override || EXPECTED_INDEXES;

  try {
    await connect();
  } catch (err) {
    logger.error({ errName: err && err.name }, 'verify-indexes: could not connect');
    console.error('Could not connect to MongoDB.');
    process.exitCode = 1;
    return;
  }

  try {
    const db = mongoose.connection.db;
    printBaseline(await baseline(db, Object.keys(expectations)));

    const { missing } = await verifyIndexes(db, expectations);
    if (missing.length > 0) {
      printMissing(missing);
      process.exitCode = 1;
      return;
    }
    console.log('\nAll expected indexes are present.');
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ errName: err && err.name }, 'verify-indexes failed');
    console.error('verify-indexes failed.');
    process.exitCode = 1;
  });
}

module.exports = { EXPECTED_INDEXES, verifyIndexes, baseline, listIndexes, keyToString, loadOverride };
