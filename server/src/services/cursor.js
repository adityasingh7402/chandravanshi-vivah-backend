'use strict';

/**
 * Opaque pagination cursor (spec §52; step 09 tasks 6, 15).
 *
 * The cursor carries the active sort key plus the `_id` tiebreak, is HMAC-signed
 * with the application secret, and is base64url-encoded. The client never sees a
 * sort field, an offset or a raw database value, and a tampered cursor is
 * **rejected** rather than decoded into an arbitrary sort (spec §52, gate G3.5).
 *
 * It is a continuation token, not a credential: it contains an id that is
 * already public (a page boundary) and nothing personal, and the signature means
 * a client cannot forge one for a different sort or key.
 */

const crypto = require('node:crypto');
const config = require('../config/env');
const { BadRequestError } = require('../utils/AppError');
const { SORT_VALUES } = require('../constants/search');

const SECRET = config.jwt.secret;
const VERSION = 1;
const MAX_LENGTH = 512;
const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

function sign(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

function invalid(message) {
  return new BadRequestError('Invalid request.', { details: { cursor: message } });
}

/**
 * Encode a continuation token.
 *
 * @param {{sort: string, key: number|Date, id: string}} position
 * @returns {string}
 */
function encodeCursor({ sort, key, id }) {
  const epoch = key instanceof Date ? key.getTime() : Number(key);
  const payload = JSON.stringify({ v: VERSION, s: sort, k: Number.isFinite(epoch) ? epoch : 0, i: String(id) });
  return `${Buffer.from(payload, 'utf8').toString('base64url')}.${sign(payload)}`;
}

/**
 * Decode and verify a continuation token.
 *
 * @param {string} cursor
 * @returns {{sort: string, key: number, id: string}}
 * @throws {BadRequestError} on anything malformed, unsigned or tampered
 */
function decodeCursor(cursor) {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > MAX_LENGTH) {
    throw invalid('This cursor is not valid.');
  }

  const parts = cursor.split('.');
  if (parts.length !== 2) throw invalid('This cursor is not valid.');

  const [encoded, signature] = parts;
  const payload = Buffer.from(encoded, 'base64url').toString('utf8');

  const expected = sign(payload);
  const given = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) {
    throw invalid('This cursor is not valid.');
  }

  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw invalid('This cursor is not valid.');
  }

  if (!parsed || parsed.v !== VERSION || !SORT_VALUES.includes(parsed.s)) {
    throw invalid('This cursor is not valid.');
  }
  if (typeof parsed.k !== 'number' || !Number.isFinite(parsed.k) || !OBJECT_ID_RE.test(String(parsed.i))) {
    throw invalid('This cursor is not valid.');
  }

  return { sort: parsed.s, key: parsed.k, id: String(parsed.i) };
}

/**
 * Decode a cursor for a specific requested sort.
 *
 * A cursor minted for another sort (or another filter set) would otherwise page
 * through an unrelated ordering, so it is refused explicitly.
 *
 * @param {string} cursor
 * @param {string} sort the sort the current request asked for
 */
function decodeCursorFor(cursor, sort) {
  const decoded = decodeCursor(cursor);
  if (decoded.sort !== sort) {
    throw invalid('This cursor was issued for a different sort order.');
  }
  return decoded;
}

module.exports = { encodeCursor, decodeCursor, decodeCursorFor, MAX_LENGTH };
