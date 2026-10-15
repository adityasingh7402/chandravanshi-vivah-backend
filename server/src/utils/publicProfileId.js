'use strict';

/**
 * Public profile identifier (spec §113, step 06 task 3).
 *
 * A profile URL uses a non-sequential `CHV-XXXXX` value rather than a raw
 * ObjectId, so the human-facing identifier reveals nothing about insertion
 * order or volume. It is deliberately NOT derived from the ObjectId, a counter
 * or a timestamp — any of those would be enumerable, and the spec is explicit
 * that this identifier must be non-sequential.
 *
 * Spec §113 also notes it is *not* a security boundary: authorization checks
 * remain mandatory, which is why every public read still runs behind
 * `requireAuth` and a status filter.
 *
 * The alphabet drops `0/O`, `1/I/L`, `Q` and other characters that are easy to
 * mistype, and is always uppercase, so `CHV-82A91`-style ids read unambiguously.
 */

const crypto = require('crypto');

const PUBLIC_PROFILE_PREFIX = 'CHV-';
const PUBLIC_PROFILE_LENGTH = 5;

/** 29 unambiguous characters; every id is uniformly distributed over them. */
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const ALPHABET_SIZE = ALPHABET.length;
/** Largest multiple of the alphabet size that fits in one byte (29 * 8 = 232). */
const UNIFORM_MAX = Math.floor(256 / ALPHABET_SIZE) * ALPHABET_SIZE;

/** How many distinct ids we try before declaring the unique index unreachable. */
const MAX_ATTEMPTS = 5;

/**
 * `MAX_ATTEMPTS` random characters, drawn without modulo bias (rejection
 * sampling on a single byte per character).
 */
function randomBody(length = PUBLIC_PROFILE_LENGTH) {
  let out = '';
  const bytes = crypto.randomBytes(length * 2);
  let used = 0;
  while (out.length < length) {
    const byte = used < bytes.length ? bytes[used++] : crypto.randomBytes(1)[0];
    if (byte >= UNIFORM_MAX) continue;
    out += ALPHABET[byte % ALPHABET_SIZE];
  }
  return out;
}

/** Generate one candidate id. Pure — no I/O, no model knowledge. */
function generatePublicProfileId() {
  return `${PUBLIC_PROFILE_PREFIX}${randomBody()}`;
}

/** True when `value` is a syntactically valid public profile id. */
function isPublicProfileId(value) {
  if (typeof value !== 'string') return false;
  if (!value.startsWith(PUBLIC_PROFILE_PREFIX)) return false;
  const body = value.slice(PUBLIC_PROFILE_PREFIX.length);
  if (body.length !== PUBLIC_PROFILE_LENGTH) return false;
  for (const char of body) if (!ALPHABET.includes(char)) return false;
  return true;
}

/**
 * Allocate an id that is free against the unique index.
 *
 * The unique index is the real guarantee; this loop only reduces the chance a
 * collision ever reaches it, and gives up rather than spinning forever if the
 * index cannot be satisfied (spec §113).
 *
 * @param {import('mongoose').Model} model
 * @param {{maxAttempts?: number}} [options]
 */
async function allocatePublicProfileId(model, options = {}) {
  const maxAttempts = options.maxAttempts || MAX_ATTEMPTS;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generatePublicProfileId();
    const taken = await model.exists({ publicProfileId: candidate });
    if (!taken) return candidate;
  }
  const error = new Error(`Could not allocate a public profile id in ${maxAttempts} attempts.`);
  error.isOperational = false;
  throw error;
}

module.exports = {
  PUBLIC_PROFILE_PREFIX,
  PUBLIC_PROFILE_LENGTH,
  ALPHABET,
  generatePublicProfileId,
  isPublicProfileId,
  allocatePublicProfileId
};
