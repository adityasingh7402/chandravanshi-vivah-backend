'use strict';

/**
 * Audit service (spec §29, §101; step 16 task 2).
 *
 * The single writer and reader of `audit_logs`. Every privileged action in
 * steps 16 (and any later admin surface) funnels through `log()`, so the
 * invariants live in exactly one place:
 *
 *   1. **The action is a known name** (spec §29). `action` is validated
 *      against `constants/adminActions.js` *before* the insert, and the
 *      model's enum validates it again at the database boundary. A call site
 *      that invents a name fails loudly rather than writing a row no query
 *      will ever match.
 *   2. **Metadata is small and non-sensitive** (spec §29, §30, §112). The
 *      object is capped at `ADMIN_ACTION_MAX_METADATA_KEYS` keys, values are
 *      primitives or short arrays of primitives, and the well-known sensitive
 *      keys (passwords, tokens, hashes, emails, phone numbers) are rejected by
 *      name. An audit trail is exactly the place a secret must never land,
 *      because it is the place most likely to be exported, reviewed and
 *      retained.
 *   3. **A failed audit write is loud, not silent.** `log()` returns the
 *      created row; a caller that performs an admin action and then fails to
 *      audit it gets an exception from this function, which surfaces in the
 *      request's error path rather than quietly losing the trail.
 *
 * The collection is append-only: `log()` only ever inserts, and this module
 * exports no update or delete helper (gate G3.4).
 */

const AuditLog = require('../models/AuditLog');
const config = require('../config/env');
const { BadRequestError, NotFoundError } = require('../utils/AppError');
const { isValidObjectId } = require('../utils/objectId');
const {
  ADMIN_ACTION_SET,
  AUDIT_TARGET_TYPE_SET,
  AUDIT_TARGET_TYPES
} = require('../constants/adminActions');

/**
 * Metadata keys that must never enter an audit row, matched case-insensitively
 * as substrings. An audit export is frequently shared with support staff and
 * lawyers; a password hash or a refresh token in one is a breach by design.
 */
const SENSITIVE_KEY_RE =
  /password|token|secret|hash|credential|authorization|cookie|email|phone|otp|signature/i;

/** Values must be primitives; arrays may only carry primitives. */
function isPrimitive(value) {
  const type = typeof value;
  return value === null || type === 'string' || type === 'number' || type === 'boolean';
}

/** Validate and normalise the metadata object, or throw a field-level 400. */
function sanitizeMetadata(metadata) {
  if (metadata === undefined || metadata === null) return null;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new BadRequestError('Invalid request.', { details: { metadata: 'metadata must be an object.' } });
  }

  const entries = Object.entries(metadata);
  const maxKeys = config.admin.maxMetadataKeys;
  if (entries.length > maxKeys) {
    throw new BadRequestError('Invalid request.', {
      details: { metadata: `metadata may carry at most ${maxKeys} keys.` }
    });
  }

  const clean = {};
  for (const [key, value] of entries) {
    if (SENSITIVE_KEY_RE.test(key)) {
      throw new BadRequestError('Invalid request.', {
        details: { metadata: `metadata key "${key}" is not allowed in an audit entry.` }
      });
    }
    if (isPrimitive(value)) {
      clean[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every(isPrimitive) && value.length <= 20) {
      clean[key] = value;
      continue;
    }
    throw new BadRequestError('Invalid request.', {
      details: { metadata: `metadata.${key} must be a primitive or a short array of primitives.` }
    });
  }
  return Object.keys(clean).length > 0 ? clean : null;
}

/**
 * Write one audit entry (task 2).
 *
 * @param {object} entry
 * @param {string} entry.actorUserId the authenticated account that acted (spec §31)
 * @param {string} entry.action a name from `constants/adminActions.js`
 * @param {string} entry.targetType a name from `constants/adminActions.js` target types
 * @param {string|null} [entry.targetId] the acted-upon row, when there is one
 * @param {object|null} [entry.metadata] small, non-sensitive context
 * @returns {Promise<object>} the created row (lean)
 */
async function log({ actorUserId, action, targetType, targetId = null, metadata = null }) {
  if (!isValidObjectId(actorUserId)) {
    throw new BadRequestError('Invalid request.', {
      details: { actorUserId: 'An audit entry requires a valid actor.' }
    });
  }
  if (!ADMIN_ACTION_SET.has(action)) {
    // A producer bug, not client input: fail loudly so the call site is fixed,
    // never silently store a name no query will match (spec §29).
    throw new BadRequestError('Invalid request.', { details: { action: 'Unknown audit action.' } });
  }
  if (!AUDIT_TARGET_TYPE_SET.has(targetType)) {
    throw new BadRequestError('Invalid request.', { details: { targetType: 'Unknown audit target type.' } });
  }
  if (targetId !== null && targetId !== undefined && !isValidObjectId(targetId)) {
    throw new BadRequestError('Invalid request.', { details: { targetId: 'Not a valid identifier.' } });
  }

  const row = await AuditLog.create({
    actorUserId,
    action,
    targetType,
    targetId: targetId ?? null,
    metadata: sanitizeMetadata(metadata)
  });
  return row.toObject();
}

/** Clamp a requested page size into the configured range (spec §80). */
function clampLimit(limit) {
  const requested = Number(limit);
  if (!Number.isInteger(requested) || requested < 1) return config.admin.defaultLimit;
  return Math.min(requested, config.admin.maxLimit);
}

/**
 * Read the trail (verification command 9; gate G4.3).
 *
 * Filters are exact-match only — `action` must be a known name and both ids
 * must be valid ObjectIds, so this endpoint can never be used to probe with
 * wildcards. Each page is bounded and cursor-paginated on `_id`, the same
 * shape every other list in this API hands out.
 *
 * @param {{targetId?: string, actorUserId?: string, action?: string, limit?: number, cursor?: string}} query
 * @returns {Promise<{items: object[], nextCursor: string|null}>}
 */
async function list(query = {}) {
  const filter = {};
  if (query.targetId) {
    if (!isValidObjectId(query.targetId)) {
      throw new BadRequestError('Invalid request.', { details: { targetId: 'Not a valid identifier.' } });
    }
    filter.targetId = query.targetId;
  }
  if (query.actorUserId) {
    if (!isValidObjectId(query.actorUserId)) {
      throw new BadRequestError('Invalid request.', { details: { actorUserId: 'Not a valid identifier.' } });
    }
    filter.actorUserId = query.actorUserId;
  }
  if (query.action) {
    if (!ADMIN_ACTION_SET.has(query.action)) {
      throw new BadRequestError('Invalid request.', { details: { action: 'Unknown audit action.' } });
    }
    filter.action = query.action;
  }
  if (query.cursor) {
    if (!isValidObjectId(query.cursor)) {
      throw new BadRequestError('Invalid request.', { details: { cursor: 'Not a valid identifier.' } });
    }
    filter._id = { $lt: query.cursor };
  }

  const limit = clampLimit(query.limit);
  const rows = await AuditLog.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map((row) => ({
      id: String(row._id),
      actorUserId: String(row.actorUserId),
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId ? String(row.targetId) : null,
      metadata: row.metadata ?? null,
      createdAt: row.createdAt
    })),
    nextCursor: hasMore && last ? String(last._id) : null
  };
}

/**
 * Fetch one entry by id, or 404. Used by nothing in the current phase's
 * routes — there is deliberately **no** single-entry audit route — but kept
 * for tests and future tooling that needs a point read.
 *
 * @param {string} id
 */
async function getById(id) {
  if (!isValidObjectId(id)) throw new NotFoundError('The requested resource does not exist.');
  const row = await AuditLog.findById(id).lean();
  if (!row) throw new NotFoundError('The requested resource does not exist.');
  return row;
}

module.exports = {
  log,
  list,
  getById,
  clampLimit,
  sanitizeMetadata,
  AUDIT_TARGET_TYPES
};
