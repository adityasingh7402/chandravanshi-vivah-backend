'use strict';

/**
 * Step 03 — password hashing tests (spec §40).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const passwordService = require('../src/services/passwordService');

test('hash() produces an Argon2id hash, never the plaintext', async () => {
  const password = 'correct-horse-battery';
  const hash = await passwordService.hash(password);

  assert.match(hash, /^\$argon2id\$/, 'must use Argon2id');
  assert.notEqual(hash, password);
  assert.ok(!hash.includes(password), 'the hash must not contain the plaintext');
});

test('two hashes of the same password differ (per-hash salt)', async () => {
  const a = await passwordService.hash('same-password');
  const b = await passwordService.hash('same-password');
  assert.notEqual(a, b);
});

test('verify() accepts the right password and rejects the wrong one', async () => {
  const hash = await passwordService.hash('correct-horse-battery');

  assert.equal(await passwordService.verify(hash, 'correct-horse-battery'), true);
  assert.equal(await passwordService.verify(hash, 'correct-horse-batter'), false);
  assert.equal(await passwordService.verify(hash, ''), false);
  assert.equal(await passwordService.verify(hash, 'CORRECT-HORSE-BATTERY'), false);
});

test('verify() returns false rather than throwing for a corrupt stored hash', async () => {
  for (const bad of ['', 'not-a-hash', null, undefined, '$argon2id$broken']) {
    assert.equal(await passwordService.verify(bad, 'anything'), false);
  }
});

test('needsRehash() is false for a hash made with the current parameters', async () => {
  const hash = await passwordService.hash('correct-horse-battery');
  assert.equal(passwordService.needsRehash(hash), false);
});

test('needsRehash() is true for weaker or unrecognised hashes', () => {
  // Same algorithm, lower memory cost than the configured 19456.
  const weak = '$argon2id$v=19$m=4096,t=1,p=1$c29tZXNhbHQ$aaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(passwordService.needsRehash(weak), true);
  assert.equal(passwordService.needsRehash('plaintext'), true);
  assert.equal(passwordService.needsRehash(''), true);
});

test('currentOptions() reports Argon2id with the configured cost', async () => {
  const config = require('../src/config/env');
  const options = passwordService.currentOptions();

  assert.equal(options.algorithm, passwordService.ARGON2ID);
  assert.equal(options.memoryCost, config.auth.argon2.memoryCost);
  assert.equal(options.timeCost, config.auth.argon2.timeCost);
  assert.equal(options.parallelism, config.auth.argon2.parallelism);
});
