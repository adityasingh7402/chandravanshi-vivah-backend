'use strict';

/**
 * Step 01 — graceful shutdown tests (gate G2.5 / G4.1).
 *
 * OS signals cannot prove this on Windows: Node does not invoke a SIGINT or
 * SIGTERM handler when the signal comes from child.kill(). So the shutdown
 * function is driven directly and the exit code, teardown order and
 * idempotency are asserted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { createShutdown } = require('../src/utils/gracefulShutdown');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function makeExitStub() {
  const codes = [];
  const called = () => new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (codes.length) resolve(codes[0]);
      else if (Date.now() - started > 5000) resolve('timeout');
      else setTimeout(tick, 10);
    };
    tick();
  });
  return { codes, called, exit: (code) => codes.push(code) };
}

test('shutdown closes the listener, runs teardown, then exits 0', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  const port = await listen(server);
  const order = [];

  const stub = makeExitStub();
  const shutdown = createShutdown({
    server,
    exit: stub.exit,
    closeResources: async () => {
      order.push('resources');
    },
    logger: null
  });

  assert.equal(shutdown('SIGTERM'), true);
  assert.equal(await stub.called(), 0);
  assert.deepEqual(order, ['resources']);

  // The port must actually be released.
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/' }, resolve);
      req.on('error', reject);
    }),
    'the listener should be closed after shutdown'
  );
});

test('a second signal is ignored instead of tearing down twice', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  await listen(server);

  const stub = makeExitStub();
  const shutdown = createShutdown({ server, exit: stub.exit, logger: null });

  assert.equal(shutdown('SIGTERM'), true);
  assert.equal(shutdown('SIGTERM'), false);
  assert.equal(shutdown('SIGINT'), false);

  assert.equal(await stub.called(), 0);
  assert.deepEqual(stub.codes, [0]);
});

test('a teardown failure still exits, with a non-zero code only for listener errors', async () => {
  const server = http.createServer((req, res) => res.end('ok'));
  await listen(server);

  const stub = makeExitStub();
  const shutdown = createShutdown({
    server,
    exit: stub.exit,
    logger: null,
    closeResources: async () => {
      throw new Error('db close failed');
    }
  });

  shutdown('SIGINT');
  // A failing teardown is logged, but the listener closed cleanly, so the
  // process exits 0 rather than hanging.
  assert.equal(await stub.called(), 0);
});

test('createShutdown refuses to run without a server', () => {
  assert.throws(() => createShutdown({}), /an http.Server is required/);
});
