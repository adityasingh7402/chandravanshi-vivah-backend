'use strict';

/**
 * Step 01 — application smoke tests.
 *
 * These cover the audit gates for the app shell: envelope shapes, 404, body
 * limits, malformed JSON, CORS allowlisting, security headers, the correlation
 * id, Express 5 async error forwarding, and the rate-limit factory.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Must be set before any src module is required, because config/env.js reads
// process.env once at require time and dotenv never overrides an existing key.
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const app = require('../src/app');
const requestId = require('../src/middleware/requestId');
const notFound = require('../src/middleware/notFound');
const { errorHandler } = require('../src/middleware/errorHandler');
const { createRateLimiter } = require('../src/middleware/rateLimit');

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('G2.1 health returns 200 with the success envelope', async () => {
  const res = await fetch(`${base}/api/v1/health`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/json/);

  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.data.status, 'ok');
  assert.equal(typeof body.data.env, 'string');
  assert.equal(typeof body.data.uptime, 'number');
  assert.equal(typeof body.message, 'string');
});

test('G2.2 unknown route returns a JSON 404 envelope, not HTML', async () => {
  const res = await fetch(`${base}/api/v1/does-not-exist`);
  assert.equal(res.status, 404);

  const text = await res.text();
  assert.doesNotMatch(text, /<html/i);

  const body = JSON.parse(text);
  assert.equal(body.success, false);
  assert.equal(typeof body.message, 'string');
});

test('G2.3 oversized JSON body is rejected with 413 envelope', async () => {
  const payload = `{"pad":"${'a'.repeat(200000)}"}`;
  const res = await fetch(`${base}/api/v1/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload
  });
  assert.equal(res.status, 413);

  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(typeof body.message, 'string');
  assert.equal(body.stack, undefined);
});

test('G2.3 malformed JSON is rejected with 400 and no stack trace', async () => {
  const res = await fetch(`${base}/api/v1/health`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{'
  });
  assert.equal(res.status, 400);

  const body = await res.json();
  assert.equal(body.success, false);
  assert.equal(body.stack, undefined);
});

test('G2.4 a rejected promise in an async handler reaches errorHandler', async () => {
  // A throwaway app wired with the real middleware, proving Express 5 forwards
  // async rejections and that the 404/error middleware ordering is correct.
  const throwaway = express();
  throwaway.get('/boom', async () => {
    throw new Error('hidden internals: /srv/app/src/secret.js mongodb://user:pass@host');
  });
  throwaway.use(notFound);
  throwaway.use(errorHandler);

  const instance = throwaway.listen(0);
  await new Promise((resolve) => instance.once('listening', resolve));
  const url = `http://127.0.0.1:${instance.address().port}/boom`;

  try {
    const res = await fetch(url);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.success, false);
    assert.equal(body.message, 'Something went wrong. Please try again later.');
    assert.doesNotMatch(body.message, /mongodb:\/\//);
    assert.doesNotMatch(body.message, /secret\.js/);
    // test runs non-production, so a stack is expected here; production is
    // asserted separately in errorHandler.test.js.
    assert.equal(typeof body.stack, 'string');
  } finally {
    await new Promise((resolve) => instance.close(resolve));
  }
});

test('G3.2 disallowed origin gets no CORS header, allowed origin gets one', async () => {
  const blocked = await fetch(`${base}/api/v1/health`, { headers: { origin: 'https://evil.example' } });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);

  const allowedOrigin = process.env.CORS_ORIGINS.split(',')[0].trim();
  const allowed = await fetch(`${base}/api/v1/health`, { headers: { origin: allowedOrigin } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), allowedOrigin);
  assert.notEqual(allowed.headers.get('access-control-allow-origin'), '*');
});

test('G3.3 X-Powered-By is absent and helmet headers are present', async () => {
  const res = await fetch(`${base}/api/v1/health`);
  assert.equal(res.headers.get('x-powered-by'), null);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
});

test('request id is generated, echoed and replaces an unsafe inbound value', async () => {
  const generated = await fetch(`${base}/api/v1/health`);
  const id = generated.headers.get('x-request-id');
  assert.ok(id, 'expected a generated X-Request-Id');

  const echoed = await fetch(`${base}/api/v1/health`, { headers: { 'x-request-id': 'client-abc.123' } });
  assert.equal(echoed.headers.get('x-request-id'), 'client-abc.123');

  const unsafe = await fetch(`${base}/api/v1/health`, { headers: { 'x-request-id': 'bad id with spaces' } });
  assert.notEqual(unsafe.headers.get('x-request-id'), 'bad id with spaces');
});

test('G3.6 the rate-limit factory returns the envelope once the window is exceeded', async () => {
  const limited = express();
  limited.use(requestId);
  // The limiter must sit in front of the route, exactly as it does in app.js.
  limited.use(createRateLimiter({ name: 'test', windowSeconds: 60, limit: 2 }));
  limited.get('/ping', (req, res) => res.json({ ok: true }));
  limited.use(notFound);
  limited.use(errorHandler);

  const instance = limited.listen(0);
  await new Promise((resolve) => instance.once('listening', resolve));
  const url = `http://127.0.0.1:${instance.address().port}/ping`;

  try {
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url)).status, 200);

    const third = await fetch(url);
    assert.equal(third.status, 429);
    const body = await third.json();
    assert.equal(body.success, false);
    assert.equal(typeof body.message, 'string');
    assert.ok(third.headers.get('ratelimit-limit'));
  } finally {
    await new Promise((resolve) => instance.close(resolve));
  }
});
