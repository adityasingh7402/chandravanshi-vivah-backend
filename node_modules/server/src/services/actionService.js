'use strict';

/**
 * Profile action service (spec §20, §36, §44, §56, §99, §100, §117; finalized
 * decisions §15; step 10 tasks 4–9).
 *
 * Two halves, on purpose:
 *
 *   **Writes** (`record`, `remove`) are small and idempotent. Every write is an
 *   upsert against the unique `{ fromUserId, toUserId, type }` index, so
 *   repeating a like is not a second row and a repeated view refreshes the
 *   pair's single row instead of growing the collection (decisions §15).
 *
 *   **Reads** (`listOwn`) never return a full profile document: they resolve the
 *   caller's own action rows, then project the referenced profiles through step
 *   09's shared **card projection** and serialiser. A shortlist screen therefore
 *   renders the same shape as a discovery card (spec §51, §70, §108) and can
 *   never leak a private field (spec §112).
 *
 * The actor is always `req.auth.userId`. Nothing in this module accepts an actor
 * from a request body.
 */

const { EventEmitter } = require('node:events');
const config = require('../config/env');
const ProfileAction = require('../models/ProfileAction');
const MatrimonialProfile = require('../models/MatrimonialProfile');
const exclusionService = require('./exclusionService');
const searchService = require('./searchService');
const projections = require('../utils/projections');
const { BadRequestError, NotFoundError } = require('../utils/AppError');
const { PROFILE_STATUS } = require('../constants/profile');
const { ACTION_TYPE } = require('../constants/actions');

/**
 * In-process domain events. Recording an action is one of the signals step 13's
 * notification layer consumes (`profile_view`, `shortlisted`, …) — spec §24 —
 * but **no notification is sent here** (step 10 task 9, scope). Step 13
 * subscribes to `events`; a listener that throws can never break a write because
 * every emit is wrapped.
 */
const events = new EventEmitter();
events.setMaxListeners(0);

function emitActionEvent(payload) {
  try {
    events.emit('action', payload);
  } catch {
    // A subscriber's bug must never fail the write that produced the event.
  }
}

/** Clamp a requested page size into the configured range (spec §80). */
function clampLimit(limit) {
  const requested = Number(limit);
  if (!Number.isInteger(requested) || requested < 1) return config.actions.defaultLimit;
  return Math.min(requested, config.actions.maxLimit);
}

/**
 * Resolve the request's target to an account id.
 *
 * A `publicProfileId` is turned into a `userId` here, server-side — the client
 * never learns or supplies the account id (spec §44, §113).
 *
 * @param {{toUserId?: string, publicProfileId?: string}} input
 * @returns {Promise<string>}
 */
async function resolveTarget(input) {
  if (input.toUserId) return String(input.toUserId);
  const profile = await MatrimonialProfile.findOne({ publicProfileId: input.publicProfileId })
    .select('userId')
    .lean();
  if (!profile) throw new NotFoundError('The requested resource does not exist.');
  return String(profile.userId);
}

/** The target must exist and be discoverable (spec §56, §58). */
async function assertTargetVisible(targetId) {
  const profile = await MatrimonialProfile.findOne({
    userId: targetId,
    ...MatrimonialProfile.publicVisibilityFilter()
  })
    .select('_id userId')
    .lean();
  // A missing target and a non-active target answer identically: a client must
  // not be able to probe another account's status through this endpoint.
  if (!profile) throw new NotFoundError('The requested resource does not exist.');
  return profile;
}

/**
 * Record one action against one target.
 *
 * Order matters: self → target visibility → block → write. Self is checked before
 * any query, the target must be an active profile, and a blocked pair can never
 * record an action in either direction (spec §22, §99).
 *
 * @param {string} actorId from `req.auth.userId`
 * @param {{type: string, toUserId?: string, publicProfileId?: string}} input validated body
 * @returns {Promise<{ action: object, created: boolean }>}
 */
async function record(actorId, input) {
  const type = input.type;
  const targetId = await resolveTarget(input);

  if (String(targetId) === String(actorId)) {
    throw new BadRequestError('You cannot perform this action on your own profile.', {
      details: { toUserId: 'Choose another profile.' }
    });
  }

  await assertTargetVisible(targetId);

  // A block in either direction forbids the action. Read the same interface
  // Discover uses, so this cannot drift from the exclusion rule (spec §99).
  const blocked = await exclusionService.blockExclusion(actorId);
  if (blocked.includes(String(targetId))) {
    throw new NotFoundError('The requested resource does not exist.');
  }

  const now = new Date();
  const filter = { fromUserId: actorId, toUserId: targetId, type };
  let created = false;

  if (type === ACTION_TYPE.VIEW) {
    // One row per pair (decisions §15); the previous timestamp decides whether
    // the target's activity signal may be refreshed again (throttle, task 8).
    const existing = await ProfileAction.findOne(filter).select('createdAt').lean();
    const throttleMs = config.actions.viewTouchThrottleMinutes * 60 * 1000;
    const shouldTouch = !existing || now.getTime() - new Date(existing.createdAt).getTime() >= throttleMs;

    const result = await ProfileAction.updateOne(
      filter,
      { $set: { createdAt: now, updatedAt: now } },
      { upsert: true, timestamps: false }
    );
    created = result.upsertedCount > 0;

    if (shouldTouch) {
      // The target's recency signal moves at most once per throttle window, so a
      // re-rendering client cannot cause a write storm (spec §20, §36).
      await MatrimonialProfile.updateOne({ userId: targetId }, { $set: { 'profile.lastActiveAt': now } });
    }
  } else {
    // Idempotent insert: `createdAt` is set only when the row is first created,
    // so repeating a like/shortlist/pass never re-dates it.
    const result = await ProfileAction.updateOne(
      filter,
      { $set: { updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true, timestamps: false }
    );
    created = result.upsertedCount > 0;
  }

  const action = await ProfileAction.findOne(filter).lean();
  emitActionEvent({ type, fromUserId: String(actorId), toUserId: String(targetId), at: now, created });
  return { action, created };
}

/**
 * Remove one of the caller's actions (for example, un-shortlist).
 *
 * Ownership is a query predicate: the delete is scoped to `fromUserId`, so
 * another account's action simply does not match and answers 404 — never a 403
 * that would confirm the row exists (spec §44, gate G3.2).
 *
 * @param {string} actorId
 * @param {string} interactionId
 */
async function remove(actorId, interactionId) {
  const result = await ProfileAction.deleteOne({ _id: interactionId, fromUserId: actorId });
  if (result.deletedCount === 0) throw new NotFoundError('The requested resource does not exist.');
  return { id: String(interactionId), deleted: true };
}

/**
 * The caller's own action list, as cards (spec §51, §70, §108).
 *
 * Pagination is by the action row's `_id` (an opaque ObjectId cursor, newest
 * first): actions are insertion-ordered, so an id comparison is exact and
 * index-supported without an offset (spec §52's rule, applied to this list).
 * A profile that is no longer `active` drops out of the page rather than being
 * rendered from a stale action (spec §56, §58, §112).
 *
 * @param {string} actorId from `req.auth.userId`
 * @param {{type?: string, limit?: number, cursor?: string}} query validated query
 */
async function listOwn(actorId, query = {}) {
  const limit = clampLimit(query.limit);
  const filter = { fromUserId: actorId };
  if (query.type) filter.type = query.type;
  if (query.cursor) filter._id = { $lt: query.cursor };

  const rows = await ProfileAction.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const targetIds = page.map((row) => row.toUserId).filter(Boolean);
  const profiles = await MatrimonialProfile.find({
    userId: { $in: targetIds },
    'profile.status': PROFILE_STATUS.ACTIVE
  })
    .select(projections.CARD_PROJECTION)
    .lean();

  const byUser = new Map(profiles.map((profile) => [String(profile.userId), profile]));
  const ordered = page.map((row) => byUser.get(String(row.toUserId))).filter(Boolean);
  const items = await searchService.toItems(ordered);

  const last = page[page.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? String(last._id) : null
  };
}

/** The caller's shortlist, newest first (spec §20; command 4). */
async function listShortlisted(actorId, query = {}) {
  return listOwn(actorId, { ...query, type: ACTION_TYPE.SHORTLIST });
}

/**
 * The caller's own outgoing view history.
 *
 * Deliberately the *caller's* views, never "who viewed me": an incoming view
 * list is not exposed by this step (spec §112) — step 13 may notify, but the raw
 * list stays private.
 */
async function listViews(actorId, query = {}) {
  return listOwn(actorId, { ...query, type: ACTION_TYPE.VIEW });
}

module.exports = {
  record,
  remove,
  listOwn,
  listShortlisted,
  listViews,
  resolveTarget,
  // Exported for step 11: an interest target must satisfy the same eligibility
  // rule as an action target, so the rule lives in exactly one place.
  assertTargetVisible,
  clampLimit,
  events
};
