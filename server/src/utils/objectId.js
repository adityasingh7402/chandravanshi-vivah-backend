'use strict';

/**
 * ObjectId guard (spec §35).
 *
 * Every id that arrives from a request MUST pass through `isValidObjectId()`
 * before it reaches a query. It rejects the object-shaped payloads used for
 * NoSQL injection (for example `{ "$ne": null }`) as well as malformed strings.
 *
 * Note: `mongoose.Types.ObjectId.isValid` accepts any 12-byte string, so a
 * 12-character value like `"abcdefghijkl"` passes there but is not a real id.
 * This guard is deliberately stricter: only a 24-character hexadecimal string
 * (or an actual ObjectId instance) is accepted.
 */

const mongoose = require('mongoose');

const { Types } = mongoose;
const OBJECT_ID_HEX_RE = /^[0-9a-fA-F]{24}$/;

/**
 * @param {unknown} value
 * @returns {boolean} true only for a 24-hex string or an ObjectId instance
 */
function isValidObjectId(value) {
  if (value instanceof Types.ObjectId) return true;
  if (typeof value !== 'string') return false;
  return OBJECT_ID_HEX_RE.test(value);
}

/**
 * Convert a validated id to an ObjectId, or return null when invalid.
 * Use the boolean guard for validation; use this when you need the instance.
 *
 * @param {unknown} value
 * @returns {import('mongoose').Types.ObjectId | null}
 */
function toObjectId(value) {
  if (value instanceof Types.ObjectId) return value;
  return isValidObjectId(value) ? new Types.ObjectId(value) : null;
}

module.exports = { isValidObjectId, toObjectId };
