'use strict';

/**
 * Step 03 — authentication integration tests (spec §5, §6, §34, §40, §117, §121).
 *
 * Runs against the configured cluster in a dedicated test database so a dev
 * database is never polluted with test accounts. Each file is its own process,
 * so the env overrides below cannot leak into other suites.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.MONGODB_DB_NAME = 'chandravanshi_vivah_test';
// High enough that functional cases never trip the brute-force limiter; the
// limiter itself is proven in tests/authRateLimit.test.js.
process.env.AUTH_RATE_LIMIT_MAX = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const app = require('../src/app');
const db = require('../src/config/db');
const User = require('../src/models/User');
const authService = require('../src/services/authService');
const passwordService = require('../src/services/passwordService');
const { COLLECTIONS } = require('../src/config/collections');
const { INVALID_CREDENTIALS_MESSAGE } = require('../src/constants/auth');

const PASSWORD = 'correct-horse-battery';
const SERVER_DIR = path.resolve(__dirname, '..');

let server;
let base;
let available = false;
let unavailableReason = '';

test.before(async () => {
  try {
    await db.connect();
    available = true;
  } catch (err) {
    available = false;
    unavailableReason = (err && err.name) || 'connection failed';
    return;
  }

  await User.deleteMany({});
  await User.syncIndexes();

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.disconnect();
});

function requireDb(t) {
  if (available) return true;
  t.skip(`MongoDB not reachable (${unavailableReason})`);
  return false;
}

async function post(pathname, body) {
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { res, json, text };
}

function registerBody(identifier, overrides = {}) {
  const isEmail = identifier.includes('@');
  return {
    identifierType: isEmail ? 'email' : 'phone',
    identifier,
    password: PASSWORD,
    ...overrides
  };
}

test('G2.1 registration with email returns 201 and persists the documented defaults', async (t) => {
  if (!requireDb(t)) return;

  const { res, json } = await post('/api/v1/auth/register', registerBody('alice@example.com'));

  assert.equal(res.status, 201);
  assert.equal(json.success, true);
  assert.equal(typeof json.message, 'string');

  const user = json.data.user;
  assert.equal(user.email, 'alice@example.com');
  assert.equal(user.role, 'user');
  assert.equal(user.status, 'active');
  assert.equal(user.profileCreated, false);
  assert.equal(user.onboardingCompleted, false);
  assert.equal(user.passwordHash, undefined, 'the hash must never be returned');

  const stored = await User.findOne({ email: 'alice@example.com' }).select('+passwordHash');
  assert.ok(stored, 'the user must be persisted');
  assert.equal(stored.role, 'user');
  assert.equal(stored.status, 'active');
  assert.equal(stored.profileCreated, false);
  assert.match(stored.passwordHash, /^\$argon2id\$/);
  assert.notEqual(stored.passwordHash, PASSWORD);
});

test('G2.2 registration with phone normalises to E.164 before storage', async (t) => {
  if (!requireDb(t)) return;

  const { res, json } = await post('/api/v1/auth/register', registerBody('9998887776'));

  assert.equal(res.status, 201);
  assert.equal(json.data.user.phone, '+919998887776');

  const stored = await User.findOne({ phone: '+919998887776' });
  assert.ok(stored, 'the normalised phone must be what is stored');
  assert.equal(stored.email, null);
});

test('G2.3 duplicate email and duplicate phone each return a clean 409', async (t) => {
  if (!requireDb(t)) return;

  await post('/api/v1/auth/register', registerBody('dup@example.com'));
  const dupEmail = await post('/api/v1/auth/register', registerBody('dup@example.com'));

  assert.equal(dupEmail.res.status, 409);
  assert.equal(dupEmail.json.success, false);
  assert.equal(dupEmail.json.message, 'A profile with this email already exists.');
  assert.equal(dupEmail.json.stack, undefined);
  assert.doesNotMatch(dupEmail.text, /duplicate key|E11000|node_modules/i);

  await post('/api/v1/auth/register', registerBody('9900000001'));
  const dupPhone = await post('/api/v1/auth/register', registerBody('9900000001'));

  assert.equal(dupPhone.res.status, 409);
  assert.equal(dupPhone.json.message, 'A profile with this phone number already exists.');
});

test('G2.4 case and whitespace variants are one account, not two', async (t) => {
  if (!requireDb(t)) return;

  await post('/api/v1/auth/register', registerBody('Case@Example.com'));
  const variant = await post('/api/v1/auth/register', registerBody('  CASE@example.COM '));

  assert.equal(variant.res.status, 409);
  assert.equal(await User.countDocuments({ email: 'case@example.com' }), 1);
});

test('G2.5 invalid registrations return 400 with a field-level message', async (t) => {
  if (!requireDb(t)) return;

  const cases = [
    ['neither identifier', { password: PASSWORD }],
    ['both identifiers', { identifierType: 'email', identifier: 'both@example.com', password: PASSWORD, phone: '9990000009' }],
    ['malformed email', { identifierType: 'email', identifier: 'not-an-email', password: PASSWORD }],
    ['malformed phone', { identifierType: 'phone', identifier: 'abc', password: PASSWORD }],
    ['too-short password', { identifierType: 'email', identifier: 'short@example.com', password: 'x' }]
  ];

  for (const [label, body] of cases) {
    const { res, json } = await post('/api/v1/auth/register', body);
    assert.equal(res.status, 400, `${label} should be a 400`);
    assert.equal(json.success, false, `${label} should use the failure envelope`);
    assert.ok(json.details && Object.keys(json.details).length > 0, `${label} should carry field details`);
    assert.equal(json.stack, undefined, `${label} must not expose a stack`);
  }

  // None of the rejected bodies may have created an account.
  assert.equal(await User.countDocuments({ email: 'both@example.com' }), 0);
  assert.equal(await User.countDocuments({ email: 'not-an-email' }), 0);
});

test('G2.6 login succeeds with the right password and is generic on failure', async (t) => {
  if (!requireDb(t)) return;

  await post('/api/v1/auth/register', registerBody('login@example.com'));

  const wrong = await post('/api/v1/auth/login', { identifierType: 'email', identifier: 'login@example.com', password: 'wrong-password' });
  const unknown = await post('/api/v1/auth/login', { identifierType: 'email', identifier: 'nobody@example.com', password: 'wrong-password' });

  assert.equal(wrong.res.status, 401);
  assert.equal(unknown.res.status, 401);
  assert.equal(wrong.json.message, INVALID_CREDENTIALS_MESSAGE);
  assert.equal(unknown.json.message, wrong.json.message, 'no account enumeration on login');

  const before = await User.findOne({ email: 'login@example.com' });
  assert.equal(before.lastLoginAt, null);

  const good = await post('/api/v1/auth/login', { identifierType: 'email', identifier: 'Login@Example.com', password: PASSWORD });
  assert.equal(good.res.status, 200);
  assert.equal(good.json.success, true);
  assert.equal(good.json.data.user.email, 'login@example.com');

  const after = await User.findOne({ email: 'login@example.com' });
  assert.ok(after.lastLoginAt instanceof Date, 'lastLoginAt must be set on success');
});

test('G2.7 change-password requires the current password and rotates the hash', async (t) => {
  if (!requireDb(t)) return;

  await post('/api/v1/auth/register', registerBody('change@example.com'));
  const user = await User.findOne({ email: 'change@example.com' });
  const userId = String(user._id);

  await assert.rejects(
    () => authService.changePassword({ userId, currentPassword: 'not-the-password', newPassword: 'brand-new-password' }),
    (err) => err.statusCode === 400,
    'a wrong current password must fail'
  );

  const updated = await authService.changePassword({ userId, currentPassword: PASSWORD, newPassword: 'brand-new-password' });
  assert.equal(updated.passwordHash, undefined, 'the service must return a sanitised user');

  const stored = await User.findById(userId).select('+passwordHash');
  assert.equal(await passwordService.verify(stored.passwordHash, 'brand-new-password'), true);
  assert.equal(await passwordService.verify(stored.passwordHash, PASSWORD), false, 'the old password must stop working');
});

test('change-password over HTTP refuses an unauthenticated request', async (t) => {
  if (!requireDb(t)) return;

  const { res, json } = await post('/api/v1/auth/change-password', {
    currentPassword: PASSWORD,
    newPassword: 'another-password-1'
  });

  assert.equal(res.status, 401);
  assert.equal(json.success, false);
});

test('G3.1 no auth response leaks the hash or the submitted password', async (t) => {
  if (!requireDb(t)) return;

  const register = await post('/api/v1/auth/register', registerBody('leak@example.com'));
  const login = await post('/api/v1/auth/login', { identifierType: 'email', identifier: 'leak@example.com', password: PASSWORD });

  for (const { res, text } of [register, login]) {
    assert.equal(res.status === 200 || res.status === 201, true);
    assert.doesNotMatch(text, /passwordHash/);
    assert.doesNotMatch(text, /correct-horse-battery/);
    assert.doesNotMatch(text, /\$argon2/);
  }
});

test('G3.2 a role in the request body never produces an admin', async (t) => {
  if (!requireDb(t)) return;

  const { res } = await post('/api/v1/auth/register', registerBody('escalate@example.com', { role: 'admin' }));

  assert.equal(res.status, 400, 'the unknown field must be rejected');
  assert.equal(await User.countDocuments({ role: 'admin' }), 0);
  assert.equal(await User.countDocuments({ email: 'escalate@example.com' }), 0);
});

test('G3.6 there is no self-service password-reset route', async (t) => {
  if (!requireDb(t)) return;

  for (const pathname of ['/api/v1/auth/forgot-password', '/api/v1/auth/reset-password']) {
    const { res } = await post(pathname, { identifier: 'login@example.com' });
    assert.equal(res.status, 404, `${pathname} must not exist (spec §6)`);
  }
});

test('G3.8 an object-shaped identifier is rejected before any query', async (t) => {
  if (!requireDb(t)) return;

  const { res, json } = await post('/api/v1/auth/register', {
    identifierType: 'email',
    identifier: { $ne: null },
    password: PASSWORD
  });

  assert.equal(res.status, 400);
  assert.equal(json.success, false);
});

test('G4.1 the identifier lookup uses the unique index (IXSCAN)', async (t) => {
  if (!requireDb(t)) return;

  // Explain the exact lookup the service issues. A partial index is only used
  // when the query carries its filter predicate, so the bare form would be a
  // COLLSCAN — this asserts the real path is indexed.
  const query = authService.identifierQuery('email', 'login@example.com');
  const plan = await mongoose.connection.db.collection(COLLECTIONS.USERS).find(query).explain('queryPlanner');

  assert.match(JSON.stringify(plan), /IXSCAN/, 'expected an index scan, not a COLLSCAN');
  assert.equal(await User.countDocuments(query), 1, 'the indexed query must still find the user');
});

test('G4.2 passwordHash is not loaded on paths that do not ask for it', async (t) => {
  if (!requireDb(t)) return;

  const user = await User.findOne({ email: 'login@example.com' });
  assert.ok(user);
  assert.equal(user.passwordHash, undefined, 'select:false must exclude the hash');
  assert.equal(user.toJSON().passwordHash, undefined, 'the JSON transform must also exclude it');
});

test('G4.3 the auth service has no unbounded find()', () => {
  const source = fs.readFileSync(path.join(SERVER_DIR, 'src', 'services', 'authService.js'), 'utf8');
  // Only findOne / findById / findByIdAndUpdate are allowed; a bare User.find() is not.
  assert.doesNotMatch(source, /User\.find\((?![a-zA-Z])/, 'authService must not run an unbounded find()');
});
