'use strict';

/**
 * Password hashing service (spec §40).
 *
 * Argon2id only — never plain text, never a reversible encoding. Cost parameters
 * come from config so they can be raised without touching code; `needsRehash()`
 * lets a login upgrade an older hash in place, so raising the cost needs no data
 * migration.
 */

const argon2 = require('@node-rs/argon2');
const config = require('../config/env');

/**
 * @node-rs/argon2 algorithm enum: 0 = Argon2d, 1 = Argon2i, 2 = Argon2id.
 * Argon2id is the spec's preferred variant (spec §40).
 */
const ARGON2ID = 2;

/** Current hashing options, read from config on every call (tests may vary them). */
function currentOptions() {
  return {
    algorithm: ARGON2ID,
    memoryCost: config.auth.argon2.memoryCost,
    timeCost: config.auth.argon2.timeCost,
    parallelism: config.auth.argon2.parallelism
  };
}

/**
 * Hash a password with Argon2id.
 * @param {string} password
 * @returns {Promise<string>} the encoded hash (includes algorithm, params and salt)
 */
async function hash(password) {
  return argon2.hash(password, currentOptions());
}

/**
 * Verify a password against an encoded hash in constant time.
 *
 * A malformed or empty stored hash returns false instead of throwing, so a
 * corrupt record can never turn a login into a 500 that differs from a normal
 * failure (which would leak that the account exists).
 *
 * @param {unknown} encoded the stored hash
 * @param {string} password
 * @returns {Promise<boolean>}
 */
async function verify(encoded, password) {
  if (typeof encoded !== 'string' || encoded.length === 0) return false;
  if (typeof password !== 'string' || password.length === 0) return false;
  try {
    return await argon2.verify(encoded, password);
  } catch {
    return false;
  }
}

/** Parse `$argon2id$v=19$m=<memory>,t=<iterations>,p=<parallelism>$...`. */
function parseParams(encoded) {
  const match = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(String(encoded || ''));
  if (!match) return null;
  return { memoryCost: Number(match[1]), timeCost: Number(match[2]), parallelism: Number(match[3]) };
}

/**
 * True when a stored hash was produced with weaker parameters than the current
 * config (or an unrecognised format), meaning it should be re-hashed on the next
 * successful login (spec §40).
 *
 * @param {unknown} encoded
 * @returns {boolean}
 */
function needsRehash(encoded) {
  const params = parseParams(encoded);
  if (!params) return true;
  const current = currentOptions();
  return (
    params.memoryCost < current.memoryCost
    || params.timeCost < current.timeCost
    || params.parallelism !== current.parallelism
  );
}

module.exports = { hash, verify, needsRehash, currentOptions, parseParams, ARGON2ID };
