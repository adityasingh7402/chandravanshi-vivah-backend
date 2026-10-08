'use strict';

/**
 * Step 02 — MongoDB connection and schema-convention tests.
 *
 * These run against the configured cluster (a local mongod in development).
 * When no cluster is reachable the DB-dependent cases skip with an explicit
 * reason rather than silently passing, so a green run always means the checks
 * actually executed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const config = require('../src/config/env');
const db = require('../src/config/db');
const { baseSchema } = require('../src/models/plugins/baseSchema');

const SERVER_DIR = path.resolve(__dirname, '..');

let available = false;
let unavailableReason = '';

test.before(async () => {
  try {
    await db.connect();
    available = true;
  } catch (err) {
    available = false;
    unavailableReason = (err && err.name) || 'connection failed';
  }
});

test.after(async () => {
  await db.disconnect();
});

/** Skip a DB-dependent case when the cluster is unreachable. */
function requireDb(t) {
  if (available) return true;
  t.skip(`MongoDB not reachable (${unavailableReason})`);
  return false;
}

function scratchName(prefix) {
  return `${prefix}_${process.pid}_${Date.now()}`;
}

test('G4.1 connection options are derived from config, never hardcoded', () => {
  const opts = db.buildOptions();

  assert.equal(opts.dbName, config.mongodbDbName);
  assert.equal(opts.maxPoolSize, config.db.maxPoolSize);
  assert.equal(opts.serverSelectionTimeoutMS, config.db.serverSelectionTimeoutMs);
  assert.equal(opts.connectTimeoutMS, config.db.connectTimeoutMs);
  assert.equal(opts.socketTimeoutMS, config.db.socketTimeoutMs);
  assert.equal(opts.autoIndex, config.db.autoIndex);

  // No connection string may be smuggled into the driver options.
  assert.doesNotMatch(JSON.stringify(opts), /mongodb/i);
});

test('G4.2 autoIndex is disabled outside development (spec §49)', () => {
  assert.equal(config.isDevelopment, false, 'this suite runs with NODE_ENV=test');
  assert.equal(config.db.autoIndex, false);
});

test('G3.1 a DB error message leaks no URI, host, credential or database name', () => {
  const raw = 'connect ECONNREFUSED 127.0.0.1:1 (mongodb://appuser:s3cret@cluster0.abcde.mongodb.net/chandravanshi_vivah)';
  const out = db.sanitizeDatabaseError(raw);

  // The URI body is replaced (only the non-sensitive scheme remains).
  assert.match(out, /mongodb:\/\/\[redacted\]/);
  assert.doesNotMatch(out, /s3cret/);
  assert.doesNotMatch(out, /appuser/);
  assert.doesNotMatch(out, /127\.0\.0\.1/);
  assert.doesNotMatch(out, /mongodb\.net/);
  assert.doesNotMatch(out, /chandravanshi_vivah/);
});

test('G3.1 an SRV failure does not leak cluster hostnames', () => {
  const out = db.sanitizeDatabaseError('querySrv ENOTFOUND _mongodb._tcp.cluster0.abcde.mongodb.net');

  assert.doesNotMatch(out, /cluster0\.abcde\.mongodb\.net/);
  assert.match(out, /ENOTFOUND/, 'the useful part of the error is kept');
});

test('G1.1 server.js connects before it listens', () => {
  const source = fs.readFileSync(path.join(SERVER_DIR, 'src', 'server.js'), 'utf8');
  const connectAt = source.indexOf('await connect(');
  const listenAt = source.indexOf('app.listen(');

  assert.ok(connectAt > -1, 'server.js must await connect()');
  assert.ok(listenAt > -1, 'server.js must call app.listen()');
  assert.ok(connectAt < listenAt, 'connect() must run before listen()');
});

test('G2.3 the shutdown hook closes the database connection', () => {
  // OS signals cannot be delivered to a child process on Windows, so the
  // wiring is asserted here and the shutdown mechanism itself is proven by
  // tests/shutdown.test.js driving createShutdown directly.
  const source = fs.readFileSync(path.join(SERVER_DIR, 'src', 'server.js'), 'utf8');
  assert.match(source, /async function closeResources\(\)\s*\{\s*await disconnect\(\);\s*\}/);
});

test('G2.1 connect() reports a connected state, disconnect() closes it', async (t) => {
  if (!requireDb(t)) return;

  assert.equal(db.isConnected(), true);
  assert.equal(db.getConnectionState(), 'connected');
  assert.equal(mongoose.connection.readyState, 1);

  await db.disconnect();
  assert.equal(db.isConnected(), false);
  assert.equal(db.getConnectionState(), 'disconnected');

  // Restore for the remaining cases.
  await db.connect();
  assert.equal(db.isConnected(), true);
});

test('G2.6 strict:true drops an unknown path instead of persisting it', async (t) => {
  if (!requireDb(t)) return;

  const name = scratchName('scratch_strict');
  const modelName = `ScratchStrict_${process.pid}`;
  const schema = new mongoose.Schema({ known: String });
  schema.plugin(baseSchema);
  const Model = mongoose.model(modelName, schema, name);

  try {
    const doc = new Model({ known: 'a', injected: 'x' });
    await doc.save();

    const stored = await mongoose.connection.db.collection(name).findOne({ _id: doc._id });
    assert.equal(stored.known, 'a');
    assert.equal(stored.injected, undefined, 'unknown paths must not be stored');
  } finally {
    await mongoose.connection.db.collection(name).drop().catch(() => {});
    mongoose.deleteModel(modelName);
  }
});

test('baseSchema applies timestamps, disables versionKey and strips internal fields', async (t) => {
  if (!requireDb(t)) return;

  const name = scratchName('scratch_base');
  const modelName = `ScratchBase_${process.pid}`;
  const schema = new mongoose.Schema({
    name: String,
    passwordHash: { type: String, internal: true }
  });
  schema.plugin(baseSchema);
  const Model = mongoose.model(modelName, schema, name);

  try {
    assert.equal(schema.options.timestamps, true);
    assert.equal(schema.options.versionKey, false);
    assert.equal(schema.options.strict, true);

    const doc = await Model.create({ name: 'a', passwordHash: 'topsecret' });
    const json = doc.toJSON();

    assert.equal(json.name, 'a');
    assert.equal(json.passwordHash, undefined, 'internal fields must not serialise');
    assert.equal(json.__v, undefined, 'versionKey must be absent');
    assert.ok(json.createdAt && json.updatedAt, 'timestamps must be present');

    // The field is only hidden from JSON — it is still stored.
    const stored = await mongoose.connection.db.collection(name).findOne({ _id: doc._id });
    assert.equal(stored.passwordHash, 'topsecret');
  } finally {
    await mongoose.connection.db.collection(name).drop().catch(() => {});
    mongoose.deleteModel(modelName);
  }
});

test('G2.5 partial unique index allows many absent values but rejects duplicates', async (t) => {
  if (!requireDb(t)) return;

  const name = scratchName('scratch_unique');
  const modelName = `ScratchUnique_${process.pid}`;
  const schema = new mongoose.Schema({ email: { type: String, default: null } });
  // The spec §5 pattern: unique only when the field is actually a string.
  schema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
  const Model = mongoose.model(modelName, schema, name);

  try {
    await Model.syncIndexes();
    await Model.create({});
    await Model.create({ email: null });

    assert.equal(await Model.countDocuments(), 2, 'many documents with no email must coexist');

    await Model.create({ email: 'dupe@example.com' });
    await assert.rejects(
      () => Model.create({ email: 'dupe@example.com' }),
      (err) => err && err.code === 11000,
      'a duplicate non-null email must be rejected'
    );
  } finally {
    await mongoose.connection.db.collection(name).drop().catch(() => {});
    mongoose.deleteModel(modelName);
  }
});
