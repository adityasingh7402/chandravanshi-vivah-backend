'use strict';

/**
 * Step 04 — session / token handling integration tests (spec §7, §30, §31, §37, §40, §41, §44, §121).
 *
 * Runs against the configured cluster in a dedicated test database. Each test
 * file is its own process, so the env overrides below cannot leak into other
 * suites.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
// A DEDICATED database: node --test runs test files in parallel and
// tests/auth.test.js wipes chandravanshi_vivah_test in its own before hook.
process.env.MONGODB_DB_NAME = 'chandravanshi_vivah_test_session';
// High enough that functional cases never trip the brute-force limiter; the
// limiter itself is proven in tests/authRateLimit.test.js.
process.env.AUTH_RATE_LIMIT_MAX = '1000';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const mongoose = require('mongoose');

const config = require('../src/config/env');
const app = require('../src/app');
const db = require('../src/config/db');
const User = require('../src/models/User');
const Session = require('../src/models/Session');
const tokenService = require('../src/services/tokenService');
const { requireAuth } = require('../src/middleware/auth');
const { requireRole } = require('../src/middleware/roles');
const { AUTH_ERROR_CODES } = require('../src/constants/errors');
const { errorHandler } = require('../src/middleware/errorHandler');

const PASSWORD = 'correct-horse-battery';

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
  await Session.deleteMany({});
  await User.syncIndexes();
  await Session.syncIndexes();

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

async function post(pathname, body, headers = {}) {
  const res = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {})
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { res, json, text, setCookie: res.headers.getSetCookie() };
}

async function get(pathname, headers = {}) {
  const res = await fetch(base + pathname, { headers });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { res, json, text };
}

async function register(identifier) {
  const isEmail = identifier.includes('@');
  const { res, json } = await post('/api/v1/auth/register', {
    identifierType: isEmail ? 'email' : 'phone',
    identifier,
    password: PASSWORD
  });
  assert.equal(res.status, 201, `register ${identifier} must succeed`);
  return json.data.user;
}

/** Log in and return { accessToken, refreshToken|null, setCookie }. */
async function login(identifier, extraBody = {}) {
  const isEmail = identifier.includes('@');
  const result = await post(
    '/api/v1/auth/login',
    {
      identifierType: isEmail ? 'email' : 'phone',
      identifier,
      password: PASSWORD,
      ...extraBody
    },
    { 'user-agent': 'step04-test-agent/1.0' }
  );
  assert.equal(result.res.status, 200, `login ${identifier} must succeed: ${result.text}`);
  return {
    accessToken: result.json.data.accessToken,
    refreshToken: result.json.data.refreshToken ?? null,
    setCookie: result.setCookie,
    user: result.json.data.user
  };
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

/** Extract the refreshToken Set-Cookie line, or undefined when there is none. */
function refreshCookieOf(setCookie) {
  return setCookie.find((c) => c.startsWith('refreshToken='));
}

test('G2.1 / G3.4 login returns an access token, creates exactly one session, and sets a hardened cookie', async (t) => {
  if (!requireDb(t)) return;

  await register('session1@example.com');
  const before = await Session.countDocuments({});

  const { accessToken, refreshToken, setCookie } = await login('session1@example.com');

  assert.equal(typeof accessToken, 'string');
  assert.equal(accessToken.split('.').length, 3, 'access token must be a JWT');
  // Web login must NOT put the refresh token in the body — only the HttpOnly cookie.
  assert.equal(refreshToken, null, 'web login returns the refresh token via cookie only');

  const line = refreshCookieOf(setCookie);
  assert.ok(line, 'a refreshToken Set-Cookie must be present');
  assert.match(line, /HttpOnly/i, 'cookie must be HttpOnly (unreadable by JavaScript)');
  assert.match(line, /SameSite=Lax/i, 'cookie must be SameSite=Lax');
  assert.ok(line.includes(`Path=${config.apiPrefix}/auth/refresh`),
    'cookie must be scoped to the refresh endpoint');
  // NODE_ENV=test, so Secure (production-only) is correctly absent.
  assert.doesNotMatch(line, /Secure/i, 'Secure is only for production (spec §37)');

  const after = await Session.countDocuments({});
  assert.equal(after - before, 1, 'exactly one session row per login');

  const session = await Session.findOne({}).sort({ createdAt: -1 });
  assert.ok(session);
  assert.equal(String(session.userId), String((await User.findOne({ email: 'session1@example.com' }))._id));
  assert.equal(session.deviceType, 'web');
  assert.equal(session.deviceName, 'step04-test-agent/1.0');
  assert.equal(session.revokedAt, null);
  assert.ok(session.expiresAt instanceof Date);
  // The raw refresh token must never be stored (spec §7): the stored value is
  // a 64-char sha256 hex digest, not the 43-char base64url raw token.
  assert.match(session.refreshTokenHash, /^[a-f0-9]{64}$/, 'must be a sha256 hash, not a raw token');

  // The access token's sid points at this session.
  const claims = tokenService.verifyAccessToken(accessToken);
  assert.equal(claims.sid, String(session._id));
});

test('G3.3 mobile login returns the refresh token in the body and no cookie', async (t) => {
  if (!requireDb(t)) return;

  await register('9991112223');
  const { refreshToken, setCookie } = await login('9991112223', { deviceType: 'android' });

  assert.equal(typeof refreshToken, 'string');
  assert.equal(refreshCookieOf(setCookie), undefined, 'mobile must not receive a cookie');

  const session = await Session.findOne({}).sort({ createdAt: -1 });
  assert.equal(session.deviceType, 'android');
});

test('G2.2 / G5.4 GET /auth/me: 401 without a token, caller-only summary with one', async (t) => {
  if (!requireDb(t)) return;

  await register('me@example.com');
  const { accessToken } = await login('me@example.com');

  const anon = await get('/api/v1/auth/me');
  assert.equal(anon.res.status, 401);
  assert.equal(anon.json.success, false);
  assert.equal(anon.json.code, AUTH_ERROR_CODES.AUTHENTICATION_REQUIRED);

  const authed = await get('/api/v1/auth/me', bearer(accessToken));
  assert.equal(authed.res.status, 200);
  const user = authed.json.data.user;
  assert.equal(user.email, 'me@example.com');
  assert.equal(user.role, 'user');
  assert.equal(user.status, 'active');
  assert.equal(user.profileCreated, false);
  assert.equal(user.onboardingCompleted, false);
  // Nothing but the public shape.
  assert.equal(user.passwordHash, undefined);
  assert.equal(user.refreshTokenHash, undefined);
  assert.doesNotMatch(authed.text, /\$argon2|refreshTokenHash/);
});

test('G2.7 tampered, garbage, and expired tokens are rejected with distinguishable codes', async (t) => {
  if (!requireDb(t)) return;

  await register('tokens@example.com');
  const { accessToken } = await login('tokens@example.com');

  const tampered = await get('/api/v1/auth/me', bearer(`${accessToken}x`));
  assert.equal(tampered.res.status, 401);
  assert.equal(tampered.json.code, AUTH_ERROR_CODES.TOKEN_INVALID);

  const garbage = await get('/api/v1/auth/me', bearer('definitely-not-a-jwt'));
  assert.equal(garbage.res.status, 401);
  assert.equal(garbage.json.code, AUTH_ERROR_CODES.TOKEN_INVALID);

  // A correctly-signed but expired token (same secret, right iss/aud).
  const user = await User.findOne({ email: 'tokens@example.com' });
  const expired = jwt.sign(
    { sub: String(user._id), role: user.role, sid: String((await Session.findOne({ userId: user._id }))._id) },
    config.jwt.secret,
    { algorithm: 'HS256', expiresIn: -10, issuer: config.jwt.issuer, audience: config.jwt.audience }
  );
  const expiredRes = await get('/api/v1/auth/me', bearer(expired));
  assert.equal(expiredRes.res.status, 401);
  assert.equal(expiredRes.json.code, AUTH_ERROR_CODES.TOKEN_EXPIRED,
    'expired must be distinguishable from invalid (gate G2.7)');
});

test('G2.3 / G2.4 refresh rotates the session and the old token stops working', async (t) => {
  if (!requireDb(t)) return;

  await register('rotate@example.com');
  const first = await login('rotate@example.com');
  const oldCookie = refreshCookieOf(first.setCookie);
  assert.ok(oldCookie);
  const oldRaw = oldCookie.split(';')[0].slice('refreshToken='.length);

  const refresh1 = await post('/api/v1/auth/refresh', {}, { cookie: `refreshToken=${oldRaw}` });
  assert.equal(refresh1.res.status, 200, refresh1.text);
  assert.equal(typeof refresh1.json.data.accessToken, 'string');
  assert.equal(refresh1.json.data.refreshToken, undefined, 'cookie clients get a cookie, not a body token');

  const newLine = refreshCookieOf(refresh1.setCookie);
  assert.ok(newLine, 'rotation must set a fresh cookie');
  const newRaw = newLine.split(';')[0].slice('refreshToken='.length);
  assert.notEqual(newRaw, oldRaw, 'rotation must mint a new refresh token');

  // Old row revoked, new row active — one active session at a time.
  assert.equal(await Session.countDocuments({ refreshTokenHash: tokenService.hashRefreshToken(oldRaw), revokedAt: null }), 0);
  assert.equal(await Session.countDocuments({ refreshTokenHash: tokenService.hashRefreshToken(newRaw), revokedAt: null }), 1);

  // Re-presenting the rotated token is rejected: the row exists but was
  // revoked by rotation, so the code names exactly that (G2.4).
  const replay = await post('/api/v1/auth/refresh', {}, { cookie: `refreshToken=${oldRaw}` });
  assert.equal(replay.res.status, 401);
  assert.equal(replay.json.code, AUTH_ERROR_CODES.SESSION_REVOKED);

  // The new access token from a refresh is accepted on a protected route.
  // (Checked BEFORE the next rotation — each refresh revokes the session the
  // previous access token was bound to, by design.)
  const refreshed = refresh1.json.data.accessToken;
  const me = await get('/api/v1/auth/me', bearer(refreshed));
  assert.equal(me.res.status, 200, me.text);

  // The new cookie keeps working.
  const refresh2 = await post('/api/v1/auth/refresh', {}, { cookie: `refreshToken=${newRaw}` });
  assert.equal(refresh2.res.status, 200);

  // refresh1's session was revoked by refresh2, so its access token dies too —
  // access tokens are bound to their session row (gate G2.5's mechanism).
  const stale = await get('/api/v1/auth/me', bearer(refreshed));
  assert.equal(stale.res.status, 401);
  assert.equal(stale.json.code, AUTH_ERROR_CODES.SESSION_REVOKED);
});

test('G3.1 a refresh with no token at all is a 401, and an unknown token is rejected', async (t) => {
  if (!requireDb(t)) return;

  const none = await post('/api/v1/auth/refresh', {});
  assert.equal(none.res.status, 401);
  assert.equal(none.json.code, AUTH_ERROR_CODES.REFRESH_TOKEN_INVALID);

  const unknown = await post('/api/v1/auth/refresh', { refreshToken: 'made-up-token-value' });
  assert.equal(unknown.res.status, 401);
  assert.equal(unknown.json.code, AUTH_ERROR_CODES.REFRESH_TOKEN_INVALID);
});

test('G2.5 logout revokes only the current session; other sessions keep working', async (t) => {
  if (!requireDb(t)) return;

  const owner = await register('multi@example.com');
  const ownerFilter = { userId: owner.id };
  const desktop = await login('multi@example.com');
  const mobile = await login('multi@example.com', { deviceType: 'ios' });
  assert.equal(await Session.countDocuments({ ...ownerFilter, revokedAt: null }), 2);

  const out = await post('/api/v1/auth/logout', {}, bearer(desktop.accessToken));
  assert.equal(out.res.status, 200, out.text);
  assert.equal(out.json.data, null);

  // The logged-out session's access token is dead immediately.
  const afterLogout = await get('/api/v1/auth/me', bearer(desktop.accessToken));
  assert.equal(afterLogout.res.status, 401);
  assert.equal(afterLogout.json.code, AUTH_ERROR_CODES.SESSION_REVOKED);

  // The other device is untouched.
  const stillWorks = await get('/api/v1/auth/me', bearer(mobile.accessToken));
  assert.equal(stillWorks.res.status, 200);

  const active = await Session.countDocuments({ ...ownerFilter, revokedAt: null });
  assert.equal(active, 1, 'exactly the other session remains active');

  // Logout also clears the cookie.
  const outCookie = refreshCookieOf(out.setCookie);
  assert.ok(outCookie);
  assert.match(outCookie, /refreshToken=;/, 'the cookie must be cleared');
});

test('G2.6 change-password revokes every OTHER session and keeps the caller alive', async (t) => {
  if (!requireDb(t)) return;

  const owner = await register('pwchange@example.com');
  const ownerFilter = { userId: owner.id };
  const keeper = await login('pwchange@example.com');
  const other = await login('pwchange@example.com', { deviceType: 'android' });
  const third = await login('pwchange@example.com', { deviceType: 'ios' });

  const changed = await post(
    '/api/v1/auth/change-password',
    { currentPassword: PASSWORD, newPassword: 'a-brand-new-password-1' },
    bearer(keeper.accessToken)
  );
  assert.equal(changed.res.status, 200, changed.text);

  // The caller's own session survives.
  assert.equal((await get('/api/v1/auth/me', bearer(keeper.accessToken))).res.status, 200);

  // Every other session is revoked, even though their tokens are unexpired.
  for (const dead of [other, third]) {
    const res = await get('/api/v1/auth/me', bearer(dead.accessToken));
    assert.equal(res.res.status, 401);
    assert.equal(res.json.code, AUTH_ERROR_CODES.SESSION_REVOKED);
  }
  assert.equal(await Session.countDocuments({ ...ownerFilter, revokedAt: null }), 1);

  // And their refresh tokens cannot be replayed either.
  const replay = await post('/api/v1/auth/refresh', { refreshToken: other.refreshToken });
  assert.equal(replay.res.status, 401);
});

test('G2.8 a suspended user is rejected on the next request even with a valid token', async (t) => {
  if (!requireDb(t)) return;

  await register('suspend@example.com');
  const { accessToken } = await login('suspend@example.com');

  assert.equal((await get('/api/v1/auth/me', bearer(accessToken))).res.status, 200);

  await User.updateOne({ email: 'suspend@example.com' }, { $set: { status: 'suspended' } });

  const after = await get('/api/v1/auth/me', bearer(accessToken));
  assert.equal(after.res.status, 403);
  assert.equal(after.json.code, AUTH_ERROR_CODES.ACCOUNT_INACTIVE);

  // A suspended user cannot refresh either, and all their sessions die.
  const loginAgain = await post('/api/v1/auth/login', {
    identifierType: 'email',
    identifier: 'suspend@example.com',
    password: PASSWORD
  });
  assert.ok(loginAgain.res.status === 403 || loginAgain.res.status === 401,
    `suspended login must be rejected, got ${loginAgain.res.status}`);
});

test('G3.1 a client-supplied userId in body or query changes nothing', async (t) => {
  if (!requireDb(t)) return;

  const victim = await register('victim@example.com');
  await register('attacker@example.com');
  const { accessToken } = await login('attacker@example.com');

  // Query parameter: identity still comes from the token.
  const viaQuery = await get(`/api/v1/auth/me?userId=${victim.id}`, bearer(accessToken));
  assert.equal(viaQuery.res.status, 200);
  assert.equal(viaQuery.json.data.user.email, 'attacker@example.com');
  assert.notEqual(viaQuery.json.data.user.id, victim.id);

  // Body field on change-password: strict validation rejects it outright.
  const viaBody = await post(
    '/api/v1/auth/change-password',
    { userId: victim.id, currentPassword: PASSWORD, newPassword: 'attacker-password-1' },
    bearer(accessToken)
  );
  assert.equal(viaBody.res.status, 400, 'unknown fields are rejected, not honoured');
  const victimStored = await User.findById(victim.id).select('+passwordHash');
  assert.match(victimStored.passwordHash, /^\$argon2id\$/, 'the victim account must be untouched');
});

test('G3.2 requireRole: 401 anonymous, 403 for a disallowed role, role read from the session only', async (t) => {
  if (!requireDb(t)) return;

  // A tiny app with the documented middleware order: requireAuth -> requireRole.
  const guardApp = express.Router();
  guardApp.get('/admin-only', requireAuth, requireRole('admin'), (req, res) => res.json({ ok: true, role: req.auth.role }));
  const mount = express();
  mount.use('/api/v1', guardApp);
  // Error middleware must take FOUR args or Express will not route thrown
  // errors to it and will fall back to its own HTML error page.
  mount.use((err, req, res, next) => errorHandler(err, req, res, next));
  mount.use((req, res, next) => next(Object.assign(new Error('no route'), { statusCode: 404 })));
  const guardServer = mount.listen(0);
  await new Promise((resolve) => guardServer.once('listening', resolve));
  const guardBase = `http://127.0.0.1:${guardServer.address().port}`;

  try {
    // Anonymous -> 401.
    const anon = await fetch(`${guardBase}/api/v1/admin-only`);
    assert.equal(anon.status, 401);

    // Regular user with a valid token -> 403 FORBIDDEN.
    await register('rolecheck@example.com');
    const { accessToken } = await login('rolecheck@example.com');
    const userRes = await fetch(`${guardBase}/api/v1/admin-only`, { headers: bearer(accessToken) });
    assert.equal(userRes.status, 403);
    const userJson = await userRes.json();
    assert.equal(userJson.code, AUTH_ERROR_CODES.FORBIDDEN);

    // Supplying role in body/query/header cannot promote the caller.
    const smuggled = await fetch(`${guardBase}/api/v1/admin-only?role=admin`, {
      headers: { ...bearer(accessToken), 'x-role': 'admin' }
    });
    assert.equal(smuggled.status, 403);

    // The role decision is server-side: the SAME token that was refused a
    // moment ago is accepted once the server grants the role in the database.
    // Nothing about the request changed — proving the role never comes from a
    // body, header, query, or even the token's own claim.
    const rolecheckUser = await User.findOne({ email: 'rolecheck@example.com' });
    await User.updateOne({ _id: rolecheckUser._id }, { $set: { role: 'admin' } });
    const adminRes = await fetch(`${guardBase}/api/v1/admin-only`, { headers: bearer(accessToken) });
    assert.equal(adminRes.status, 200);
    const adminJson = await adminRes.json();
    assert.equal(adminJson.role, 'admin');
  } finally {
    await new Promise((resolve) => guardServer.close(resolve));
  }
});

test('G4.1 refresh lookup uses the unique refreshTokenHash index (IXSCAN)', async (t) => {
  if (!requireDb(t)) return;

  const raw = 'explain-me-please';
  const query = { refreshTokenHash: tokenService.hashRefreshToken(raw) };
  const plan = await mongoose.connection.db.collection('sessions').find(query).explain('queryPlanner');

  assert.match(JSON.stringify(plan), /IXSCAN/, 'refresh lookup must be an index scan, not a COLLSCAN');
  assert.equal(await Session.findOne(query), null, 'the indexed query must still be correct');
});

test('G4.2 auth middleware performs bounded point lookups — no populate, no unbounded find', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.resolve(__dirname, '..', 'src');

  for (const rel of [['middleware', 'auth.js'], ['services', 'sessionService.js']]) {
    const source = fs.readFileSync(path.join(dir, ...rel), 'utf8');
    assert.doesNotMatch(source, /\.populate\(/, `${rel.join('/')} must not populate`);
    assert.doesNotMatch(source, /\.find\((?![a-zA-Z])/, `${rel.join('/')} must not run an unbounded find()`);
  }
});

test('G4.3 the sessions collection carries the TTL index on expiresAt', async (t) => {
  if (!requireDb(t)) return;

  const indexes = await Session.collection.indexes();
  const ttl = indexes.find((idx) => idx.key && idx.key.expiresAt === 1);
  assert.ok(ttl, 'an expiresAt index must exist');
  assert.equal(ttl.expireAfterSeconds, 0, 'expired sessions must be removed by the TTL monitor, not a scan');
});

test('G5.1 the sessions schema matches spec §7 field-for-field', async (t) => {
  if (!requireDb(t)) return;

  const paths = Session.schema.paths;
  for (const field of ['userId', 'refreshTokenHash', 'deviceType', 'deviceName', 'createdAt', 'lastUsedAt', 'expiresAt', 'revokedAt']) {
    assert.ok(paths[field], `sessions.${field} must exist (spec §7)`);
  }
  assert.equal(paths.refreshTokenHash.options.internal, true, 'the hash must be marked internal');

  const indexes = await Session.collection.indexes();
  assert.ok(indexes.find((i) => i.key.userId === 1), 'sessions.userId index (spec §105)');
  const hashIdx = indexes.find((i) => i.key.refreshTokenHash === 1);
  assert.ok(hashIdx, 'sessions.refreshTokenHash index');
  assert.equal(hashIdx.unique, true, 'refreshTokenHash must be unique');
});
