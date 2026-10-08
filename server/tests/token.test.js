'use strict';

/**
 * Step 04 — token service unit tests (spec §7, §30, §44).
 *
 * Pure unit tests: no HTTP, no database. They prove the access token is a
 * tightly-pinned JWT and that the refresh token exists only as a hash
 * (gates G2.7, G3.3, G3.5).
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');

const config = require('../src/config/env');
const tokenService = require('../src/services/tokenService');
const { AUTH_ERROR_CODES } = require('../src/constants/errors');

const USER_ID = '64b000000000000000000001';
const SESSION_ID = '64b000000000000000000002';

test('G5.3 sign/verify round trip carries only sub, role and sid — no personal data', () => {
  const token = tokenService.signAccessToken({ userId: USER_ID, role: 'user', sessionId: SESSION_ID });
  const claims = tokenService.verifyAccessToken(token);

  assert.equal(claims.sub, USER_ID);
  assert.equal(claims.role, 'user');
  assert.equal(claims.sid, SESSION_ID);
  assert.equal(claims.iss, config.jwt.issuer);
  assert.equal(claims.aud, config.jwt.audience);

  // Spec §30: the token payload must never carry profile or contact data.
  const decoded = jwt.decode(token);
  const allowed = new Set(['sub', 'role', 'sid', 'iat', 'exp', 'iss', 'aud']);
  for (const key of Object.keys(decoded)) {
    assert.ok(allowed.has(key), `unexpected claim in access token: ${key}`);
  }
});

test('G2.7 an expired token and an invalid token produce distinguishable codes', () => {
  // Expired: correct signature, wrong time.
  const expired = jwt.sign(
    { sub: USER_ID, role: 'user', sid: SESSION_ID },
    config.jwt.secret,
    {
      algorithm: 'HS256',
      expiresIn: -10,
      issuer: config.jwt.issuer,
      audience: config.jwt.audience
    }
  );

  assert.throws(
    () => tokenService.verifyAccessToken(expired),
    (err) => {
      assert.equal(err.statusCode, 401);
      assert.equal(err.code, AUTH_ERROR_CODES.TOKEN_EXPIRED);
      return true;
    },
    'expired must be TOKEN_EXPIRED so the client knows to refresh'
  );

  // Invalid: garbage / wrong signature.
  assert.throws(
    () => tokenService.verifyAccessToken('not-a-jwt'),
    (err) => {
      assert.equal(err.statusCode, 401);
      assert.equal(err.code, AUTH_ERROR_CODES.TOKEN_INVALID);
      return true;
    },
    'invalid must be TOKEN_INVALID so the client knows to sign in again'
  );
});

test('G3.5 a token signed with a different secret is rejected', () => {
  const forged = jwt.sign(
    { sub: USER_ID, role: 'admin', sid: SESSION_ID },
    'some-other-secret-that-is-long-enough-32chars',
    {
      algorithm: 'HS256',
      expiresIn: '5m',
      issuer: config.jwt.issuer,
      audience: config.jwt.audience
    }
  );

  assert.throws(
    () => tokenService.verifyAccessToken(forged),
    (err) => err.code === AUTH_ERROR_CODES.TOKEN_INVALID
  );
});

test('G3.5 a tampered payload (raised role) is rejected', () => {
  const token = tokenService.signAccessToken({ userId: USER_ID, role: 'user', sessionId: SESSION_ID });
  const [header, payload] = token.split('.');

  // Rewrite role: user -> admin inside the payload, keep the original signature.
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  claims.role = 'admin';
  const forgedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');

  assert.throws(
    () => tokenService.verifyAccessToken(`${header}.${forgedPayload}.${token.split('.')[2]}`),
    (err) => err.code === AUTH_ERROR_CODES.TOKEN_INVALID
  );
});

test('G3.5 an unsigned alg:none token is rejected', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: USER_ID,
      role: 'admin',
      sid: SESSION_ID,
      iss: config.jwt.issuer,
      aud: config.jwt.audience,
      exp: Math.floor(Date.now() / 1000) + 600
    })
  ).toString('base64url');
  const unsigned = `${header}.${payload}.`;

  assert.throws(
    () => tokenService.verifyAccessToken(unsigned),
    (err) => err.code === AUTH_ERROR_CODES.TOKEN_INVALID
  );
});

test('G3.5 wrong issuer or audience is rejected', () => {
  const wrongIssuer = jwt.sign(
    { sub: USER_ID, role: 'user', sid: SESSION_ID },
    config.jwt.secret,
    { algorithm: 'HS256', expiresIn: '5m', issuer: 'someone-else', audience: config.jwt.audience }
  );
  const wrongAudience = jwt.sign(
    { sub: USER_ID, role: 'user', sid: SESSION_ID },
    config.jwt.secret,
    { algorithm: 'HS256', expiresIn: '5m', issuer: config.jwt.issuer, audience: 'other-clients' }
  );

  for (const token of [wrongIssuer, wrongAudience]) {
    assert.throws(
      () => tokenService.verifyAccessToken(token),
      (err) => err.code === AUTH_ERROR_CODES.TOKEN_INVALID
    );
  }
});

test('G3.5 a non-HS256 token (algorithm confusion) is rejected', () => {
  // HS256 is pinned in both sign and verify, so any other alg is refused
  // before the signature is even considered.
  const header = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({ sub: USER_ID, role: 'user', sid: SESSION_ID, exp: Math.floor(Date.now() / 1000) + 600 })
  ).toString('base64url');

  assert.throws(
    () => tokenService.verifyAccessToken(`${header}.${payload}.x`),
    (err) => err.code === AUTH_ERROR_CODES.TOKEN_INVALID
  );
});

test('G3.3 issueRefreshToken returns high-entropy base64url and a SHA-256 hash', () => {
  const first = tokenService.issueRefreshToken();
  const second = tokenService.issueRefreshToken();

  // 32 bytes -> 43 base64url characters, URL-safe, no padding.
  assert.equal(first.token.length, Math.ceil((config.session.refreshTokenBytes * 4) / 3));
  assert.match(first.token, /^[A-Za-z0-9_-]+$/);
  assert.notEqual(first.token, second.token, 'two refresh tokens must never collide');

  // Only the hash may be stored; the raw token must not equal it.
  assert.match(first.hash, /^[a-f0-9]{64}$/, 'hash must be a sha256 hex digest');
  assert.notEqual(first.hash, first.token);
  assert.equal(first.hash, tokenService.hashRefreshToken(first.token), 'hashing is deterministic');
  assert.notEqual(first.hash, tokenService.hashRefreshToken(second.token));

  // The hash must be the real sha256 of the raw token.
  const manual = crypto.createHash('sha256').update(first.token).digest('hex');
  assert.equal(first.hash, manual);
});

test('verifyAccessToken rejects empty and non-string input without throwing non-operational errors', () => {
  for (const value of ['', null, undefined, 42, {}]) {
    assert.throws(
      () => tokenService.verifyAccessToken(value),
      (err) => err.statusCode === 401 && err.code === AUTH_ERROR_CODES.TOKEN_INVALID
    );
  }
});

test('accessTokenTtlSeconds reflects JWT_ACCESS_TTL', () => {
  const seconds = tokenService.accessTokenTtlSeconds();
  assert.equal(seconds, Math.floor(config.jwt.accessTtlMs / 1000));
  assert.ok(seconds > 0 && seconds < config.session.ttlMs / 1000, 'access TTL must be shorter than the session TTL');
});
