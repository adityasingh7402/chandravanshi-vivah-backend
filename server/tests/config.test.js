'use strict';

/**
 * Step 01 — configuration tests.
 *
 * config/env.js is evaluated in a child process so each case gets a clean
 * module registry. The key assertion is not just that a bad config fails, but
 * that the failure message names the field without echoing its value.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ENV_PATH = path.resolve(__dirname, '..', 'src', 'config', 'env.js');
const SERVER_DIR = path.resolve(__dirname, '..');
const CODE = `require(${JSON.stringify(ENV_PATH)}); process.stdout.write('CONFIG_OK');`;

function runWithEnv(overrides) {
  return spawnSync(process.execPath, ['-e', CODE], {
    cwd: SERVER_DIR,
    encoding: 'utf8',
    env: { ...process.env, ...overrides }
  });
}

test('a valid configuration loads', () => {
  const result = runWithEnv({});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CONFIG_OK/);
});

test('an empty JWT_SECRET stops the process with a field name', () => {
  const result = runWithEnv({ NODE_ENV: 'production', JWT_SECRET: '' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JWT_SECRET/);
});

test('a placeholder JWT_SECRET is rejected', () => {
  const result = runWithEnv({ JWT_SECRET: 'CHANGE_ME_something_secret_value_here_32' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JWT_SECRET/);
  // The value must never be echoed back (spec §79).
  assert.doesNotMatch(result.stderr, /CHANGE_ME_something_secret_value_here_32/);
});

test('a short JWT_SECRET is rejected', () => {
  const result = runWithEnv({ JWT_SECRET: 'short-but-not-long-enough' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JWT_SECRET/);
});

test('a bad NODE_ENV is rejected without printing values', () => {
  const result = runWithEnv({ NODE_ENV: 'staging' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /NODE_ENV/);
  assert.doesNotMatch(result.stderr, /staging/, 'the offending value must not be echoed');
});

test('a wildcard CORS origin is rejected', () => {
  const result = runWithEnv({ CORS_ORIGINS: 'https://ok.example,https://*.evil.example' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /CORS_ORIGINS/);
  assert.doesNotMatch(result.stderr, /\*\.evil\.example/);
});

test('a non-mongodb MONGODB_URI is rejected', () => {
  const result = runWithEnv({ MONGODB_URI: 'postgres://user:pass@host/db' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MONGODB_URI/);
  assert.doesNotMatch(result.stderr, /user:pass/);
});

test('JWT_REFRESH_TTL must be longer than JWT_ACCESS_TTL', () => {
  const result = runWithEnv({ JWT_ACCESS_TTL: '7d', JWT_REFRESH_TTL: '15m' });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /JWT_REFRESH_TTL/);
});

test('.env is gitignored and .env.example carries only a placeholder secret', () => {
  const gitignore = fs.readFileSync(path.join(SERVER_DIR, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.env$/m);

  const example = fs.readFileSync(path.join(SERVER_DIR, '.env.example'), 'utf8');
  assert.match(example, /JWT_SECRET=CHANGE_ME/);
  assert.match(example, /MONGODB_URI=mongodb:\/\/127\.0\.0\.1/);
  assert.doesNotMatch(example, /mongodb\+srv:\/\//);
});

test('every variable declared in .env.example is read by config/env.js', () => {
  const example = fs.readFileSync(path.join(SERVER_DIR, '.env.example'), 'utf8');
  const declared = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  const source = fs.readFileSync(ENV_PATH, 'utf8');

  assert.ok(declared.length >= 10, 'expected the template to declare the documented variables');
  for (const name of declared) {
    assert.ok(source.includes(`'${name}'`), `${name} is declared in .env.example but never validated in env.js`);
  }
});
