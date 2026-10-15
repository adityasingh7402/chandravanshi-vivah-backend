'use strict';

/**
 * Block service (spec §22, §44, §56, §99, §105, §112; finalized decisions §7;
 * step 12 tasks 3–7).
 *
 * This module is the single definition of what a block *does*. A block is
 * bilateral in effect — discovery, interests, actions, chat and notifications are
 * all cut, in both directions, regardless of who blocked whom (spec §22) — and
 * every one of those effects is **derived from the row at read time**, never
 * stored as a flag a client could influence (spec §91):
 *
 *   discovery / actions / interests   `exclusionService.blockExclusion()` and
 *                                     `isBlockedEitherWay()` → the pair never
 *                                     matches a query
 *   chat                              `connectionPolicy.canChat()` consults
 *                                     `isBlockedEitherWay()` before the accepted
 *                                     connection (decisions §7)
 *   notifications                     `canNotify()` is the hook step 13 calls
 *                                     before it creates anything (spec §22, §24)
 *
 * Blocking **never deletes history** (spec §98's spirit). The block row is the
 * only thing written; an accepted connection between the pair is additionally
 * moved to `closed` so the stored record reflects reality — that is step 11's
 * documented `closeForAccess` seam, and the row is preserved, never removed
 * (decisions §7). The authoritative gate remains the derived one, so `canChat` is
 * false the moment the block exists even if no connection row had to change.
 *
 * Unblocking is symmetric and cheap: removing the row removes every derived
 * effect at once, and nothing is "restored" — a previously closed connection
 * stays closed and a new interest must be sent (gate G2.6).
 */

const config = require('../config/env');
const Block = require('../models/Block');
const MatrimonialProfile = require('../models/MatrimonialProfile');
const exclusionService = require('./exclusionService');
const { BadRequestError, NotFoundError } = require('../utils/AppError');

/**
 * Is the pair blocked in either direction?
 *
 * The one predicate every effect is built on: A blocking B and B blocking A both
 * answer `true` (spec §22, §99). A search for the reverse row is what makes the
 * effect bilateral without storing two rows.
 *
 * @param {string} a account id
 * @param {string} b account id
 * @returns {Promise<boolean>}
 */
async function isBlockedEitherWay(a, b) {
  if (!a || !b) return false;
  if (String(a) === String(b)) return false;
  const found = await Block.exists({
    $or: [
      { blockerId: a, blockedUserId: b },
      { blockerId: b, blockedUserId: a }
    ]
  });
  return Boolean(found);
}

/**
 * Every account the caller must not see or be seen by: the union of "who I
 * blocked" and "who blocked me" (spec §56, §99).
 *
 * Delegates to `exclusionService.blockExclusion` — the same source Discover
 * already reads — so the block set has exactly one definition and the discover
 * query shape is untouched (step 09/10's acceptance criterion).
 *
 * @param {string} userId
 * @returns {Promise<string[]>}
 */
async function excludeIds(userId) {
  return exclusionService.blockExclusion(userId);
}

/**
 * The step-13 notification hook (spec §22, §24).
 *
 * A notification about, from, or between a blocked pair must never be created.
 * Step 13's creation path calls this before writing a `notifications` row; wiring
 * it here rather than in step 13 is what lets that step stay about delivery.
 *
 * @param {string} fromUserId who the notification would be *about* / from
 * @param {string} toUserId who would receive it
 * @returns {Promise<boolean>} false when the pair is blocked either way
 */
async function canNotify(fromUserId, toUserId) {
  return !(await isBlockedEitherWay(fromUserId, toUserId));
}

/**
 * Block an account (task 3).
 *
 * Self-block is refused before any query. The write is an idempotent upsert
 * against the unique pair index, so a double-tap or a retry answers with the same
 * row rather than a duplicate — and the `reason` is only *set* on insert, so
 * re-blocking cannot silently rewrite the note the blocker first wrote.
 *
 * After the row exists, an accepted connection between the pair is closed for
 * access via step 11's seam (decisions §7). The lazy require is deliberate: it
 * keeps `connectionService → connectionPolicy → blockService` a load-time
 * one-way edge while still letting the block path use the one implementation of
 * "close for access".
 *
 * @param {string} actorId from `req.auth.userId`
 * @param {{userId?: string, publicProfileId?: string, reason?: string|null}} input validated body
 * @returns {Promise<{ block: object, created: boolean }>}
 */
async function block(actorId, input) {
  const targetId = await resolveTarget(input);

  if (String(targetId) === String(actorId)) {
    throw new BadRequestError('You cannot block your own profile.', {
      details: { userId: 'Choose another profile.' }
    });
  }

  // The target must be a real profile, but *any* status will do: blocking a
  // suspended or deleted account is legitimate, and refusing it would leave the
  // caller unable to cut off someone who is harassing them. The `userId` spelling
  // therefore still gets an existence check, so a fabricated id cannot create a
  // junk row.
  const profile = await MatrimonialProfile.findOne({ userId: targetId }).select('_id').lean();
  if (!profile) throw new NotFoundError('The requested resource does not exist.');

  // Idempotent upsert against the unique pair index. `reason` is only set on
  // insert, so re-blocking cannot silently rewrite the note the blocker wrote.
  const result = await Block.updateOne(
    { blockerId: actorId, blockedUserId: targetId },
    { $setOnInsert: { blockerId: actorId, blockedUserId: targetId, reason: input.reason ?? null } },
    { upsert: true }
  );

  // Close any accepted connection for access. Never fatal: the derived gate is
  // what makes `canChat` false, and a missing connection row is the normal case.
  const connectionService = require('./connectionService');
  await connectionService.closeAcceptedForPair(actorId, targetId);

  const row = await Block.findOne({ blockerId: actorId, blockedUserId: targetId }).lean();
  return { block: row, created: result.upsertedCount > 0 };
}

/**
 * Remove a block the caller created (task 4).
 *
 * Ownership is a query predicate: the delete is scoped to `blockerId`, so
 * another account's block simply does not match and answers 404 — never a 403
 * that would confirm the row exists (spec §44). Every derived effect disappears
 * with the row, in both directions.
 *
 * @param {string} actorId
 * @param {string} targetIdOrPublicId account id or public profile id
 * @returns {Promise<{ userId: string, removed: true }>}
 */
async function unblock(actorId, targetIdOrPublicId) {
  const targetId = await resolveTarget(
    /^[0-9a-fA-F]{24}$/.test(String(targetIdOrPublicId))
      ? { userId: targetIdOrPublicId }
      : { publicProfileId: targetIdOrPublicId }
  );

  const result = await Block.deleteOne({ blockerId: actorId, blockedUserId: targetId });
  if (result.deletedCount === 0) throw new NotFoundError('The requested resource does not exist.');
  return { userId: targetId, removed: true };
}

/** Clamp a requested page size into the configured range (spec §80). */
function clampLimit(limit) {
  const requested = Number(limit);
  if (!Number.isInteger(requested) || requested < 1) return config.safety.blocks.defaultLimit;
  return Math.min(requested, config.safety.blocks.maxLimit);
}

/**
 * The caller's own block list (task 4), newest first, paginated.
 *
 * The blocked profiles are resolved through a **small dedicated projection**, not
 * the discovery card: someone the caller blocked may have been suspended or
 * deleted since, and the caller must still see the row in order to unblock them
 * (which is why this list does not filter on `profile.status`). Only the public
 * fields the list needs are returned — never an account id, never a private field
 * (spec §112).
 *
 * @param {string} actorId
 * @param {{limit?: number, cursor?: string}} query validated query
 */
async function list(actorId, query = {}) {
  const limit = clampLimit(query.limit);
  const filter = { blockerId: actorId };
  if (query.cursor) filter._id = { $lt: query.cursor };

  const rows = await Block.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const profiles = await MatrimonialProfile.find({ userId: { $in: page.map((row) => row.blockedUserId) } })
    .select('userId publicProfileId basic.firstName profile.status')
    .lean();
  const byUser = new Map(profiles.map((profile) => [String(profile.userId), profile]));

  const items = page.map((row) => {
    const profile = byUser.get(String(row.blockedUserId));
    return {
      id: String(row._id),
      profileId: profile ? profile.publicProfileId : null,
      name: profile ? profile.basic?.firstName || null : null,
      profileStatus: profile ? profile.profile?.status || null : null,
      // The reason is the blocker's own note, so returning it to the blocker is
      // intentional; it is never exposed to the blocked account.
      reason: row.reason ?? null,
      createdAt: row.createdAt
    };
  });

  const last = page[page.length - 1];
  return { items, nextCursor: hasMore && last ? String(last._id) : null };
}

/**
 * Resolve a request's target to an account id.
 *
 * Same contract as the action / connection services: the client may name the
 * target by account id or by the public, non-sequential id (spec §113), and a
 * `publicProfileId` is turned into an account **server-side**. A target that does
 * not exist is a 404.
 *
 * @param {{userId?: string, publicProfileId?: string}} input
 * @returns {Promise<string>}
 */
async function resolveTarget(input) {
  if (input.userId) return String(input.userId);
  const profile = await MatrimonialProfile.findOne({ publicProfileId: input.publicProfileId })
    .select('userId')
    .lean();
  if (!profile) throw new NotFoundError('The requested resource does not exist.');
  return String(profile.userId);
}

module.exports = {
  block,
  unblock,
  list,
  isBlockedEitherWay,
  excludeIds,
  canNotify,
  resolveTarget,
  clampLimit
};
