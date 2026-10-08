'use strict';

/**
 * Step 03 — auth rate-limit tests (gate G2.8, spec §36).
 *
 * A separate process so this file can configure a deliberately tiny limit
 * without constraining the functional suite. Register requests use an invalid
 * body: the limiter runs BEFORE validation, so the 429s are proven without
 * creating any account.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.MONGODB_DB_NAME = 'chandravanshi_vivah_test';
process.env.AUTH_RATE_LIMIT_MAX = '3';
process.env.AUTH_RATE_LIMIT_WINDOW = '900';

const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');
const db = require('../src/config/db');

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
  return { status: res.status, body: await res.json() };
}

test('G2.8 login returns 429 once the window is exceeded', async (t) => {
  if (!requireDb(t)) return;

  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    const { status } = await post('/api/v1/auth/login', {
      identifierType: 'email',
      identifier: 'ratelimit@example.com',
      password: 'wrong-password'
    });
    statuses.push(status);
  }

  assert.deepEqual(statuses.slice(0, 3), [401, 401, 401], `expected 401s first, got ${statuses}`);
  assert.deepEqual(statuses.slice(3), [429, 429, 429], `expected 429s after the limit, got ${statuses}`);
});

test('G2.8 register returns 429 once the window is exceeded (authorization happens first)', async (t) => {
  if (!requireDb(t)) return;

  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    const { status, body } = await post('/api/v1/auth/register', { password: 'correct-horse-battery' });
    statuses.push(status);
    if (status === 429) assert.equal(body.success, false);
  }

  assert.deepEqual(statuses.slice(0, 3), [400, 400, 400], `expected 400s first, got ${statuses}`);
  assert.deepEqual(statuses.slice(3), [429, 429, 429], `expected 429s after the limit, got ${statuses}`);
});
