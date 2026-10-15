'use strict';

/**
 * Notification service (spec §22, §24, §30, §36, §44, §112; step 13 tasks 3, 5–7).
 *
 * The single writer and reader of the `notifications` collection. Everything
 * that produces a notification — the event mapping in `notificationEvents.js`
 * today, step 14's chat and step 16's admin flows tomorrow — goes through
 * `create()`, so the three safety rules live in exactly one place:
 *
 *   1. **Block suppression (spec §22).** A peer-type notification consults
 *      `blockService.canNotify(actor, recipient)` before any write. A blocked
 *      pair never gets a row, in either direction, and the caller gets a
 *      `suppressed` answer rather than an error — suppression is a policy
 *      outcome, not a failure.
 *   2. **Bounded growth (spec §36).** High-frequency types (profile_view,
 *      shortlisted, new_message) are *coalesced*: a repeat by the same actor
 *      inside the configured window refreshes the existing row — re-dated and
 *      un-read — instead of inserting a new one. One actor viewing a profile on
 *      every render cannot grow the inbox; the newest signal still surfaces.
 *   3. **Small payload (spec §24).** `data` is passed through as produced by the
 *      caller; this module never copies a profile or message document into it,
 *      and `renderCopy` interpolates only a first name.
 *
 * Event handlers call this from *outside* the originating request (decisions
 * §16): a notification is a side effect and must never block or roll back an
 * interest send or acceptance. A failed creation is logged and swallowed by the
 * event layer; a direct call (step 16's admin paths) receives the normal typed
 * errors instead.
 */

const config = require('../config/env');
const Notification = require('../models/Notification');
const User = require('../models/User');
const blockService = require('./blockService');
const { NOTIFICATION_TYPE_SET, PEER_TYPES, COALESCED_TYPES, NOTIFICATION_COPY } = require('../constants/notifications');
const { BadRequestError, NotFoundError } = require('../utils/AppError');

/**
 * Render a type's default copy with its substitutions (task 2).
 *
 * Only the keys a caller passes are substituted, and the templates never carry
 * a private field (spec §112). An unknown name degrades to a neutral word —
 * `"Someone viewed your profile."` rather than `"undefined viewed…"` — because
 * the actor may have deleted their profile between the event and the render.
 *
 * @param {string} type
 * @param {{name?: string}} substitutions
 * @returns {{title: string, body: string}}
 */
function renderCopy(type, substitutions = {}) {
  const copy = NOTIFICATION_COPY[type];
  const name = substitutions.name ? String(substitutions.name).slice(0, 60) : 'Someone';
  return { title: copy.title, body: copy.body.replace('{name}', name) };
}

/**
 * Create one notification (task 3).
 *
 * @param {object} input
 * @param {string} input.userId recipient account id — server-derived, never
 *   client-supplied (spec §44)
 * @param {string} input.type one of the spec §24 types
 * @param {string} [input.actorId] the account the notification is *from/about*;
 *   drives block suppression for peer types
 * @param {string} [input.name] the actor's first name, for the copy
 * @param {object} [input.data] identifiers-only payload (spec §24)
 * @param {string} [input.title] override the default copy (admin paths)
 * @param {string} [input.body] override the default copy
 * @returns {Promise<{notification: object|null, coalesced?: boolean, suppressed?: boolean}>}
 *   `notification: null` with `suppressed: true` when the pair is blocked;
 *   `notification: null` alone when the recipient no longer exists (the event
 *   referenced an account that was deleted — nothing to deliver, not an error).
 */
async function create(input) {
  const { userId, type, actorId = null, data = {} } = input;

  // A type outside the enum is a producer bug, not client input: fail loudly in
  // development so the mapping is fixed, never silently store an unknown type.
  if (!NOTIFICATION_TYPE_SET.has(type)) {
    throw new BadRequestError('Unknown notification type.', { details: { type: 'Unsupported type.' } });
  }

  // Block suppression (task 5, spec §22). Admin-originated types have no peer
  // actor and are never suppressed.
  if (actorId && PEER_TYPES.has(type)) {
    const allowed = await blockService.canNotify(String(actorId), String(userId));
    if (!allowed) return { notification: null, suppressed: true };
  }

  // The recipient must still exist. An event that races an account deletion
  // delivers nothing rather than 500-ing the (already finished) request.
  const recipientExists = await User.exists({ _id: userId });
  if (!recipientExists) return { notification: null };

  const copy = renderCopy(type, { name: input.name });
  const title = input.title ?? copy.title;
  const body = input.body ?? copy.body;

  // Coalescing (task 6). The rule keys on (recipient, type, actor): the same
  // person doing the same thing again inside the window refreshes the row
  // instead of stacking a new one.
  const rule = COALESCED_TYPES[type];
  if (rule && data[rule.actorField]) {
    const windowMinutes = config.notifications[rule.windowMinutesEnv];
    const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);
    const existing = await Notification.findOne({
      userId,
      type,
      [`data.${rule.actorField}`]: data[rule.actorField],
      createdAt: { $gte: windowStart }
    })
      .sort({ createdAt: -1 })
      .lean();

    if (existing) {
      // Re-date and un-read the row the user already has, so the newest signal
      // moves back to the top of the inbox and the badge surfaces it again.
      //
      // This write goes through the driver rather than the model on purpose:
      // `timestamps: true` makes `createdAt` an immutable path, and Mongoose
      // silently strips an explicit `$set` of it from any update — the row
      // would keep its old date, drift out of the throttle window and stop
      // coalescing, with no error anywhere. The driver-level update is the one
      // shape that actually re-dates the row (verified: the model-level write
      // reports `modifiedCount: 1` while leaving `createdAt` untouched).
      const refresh = new Date();
      await Notification.collection.updateOne(
        { _id: existing._id },
        { $set: { createdAt: refresh, readAt: null, title, body, data } }
      );
      const refreshed = await Notification.findOne({ _id: existing._id }).lean();
      return { notification: refreshed, coalesced: true };
    }
  }

  const notification = await Notification.create({ userId, type, title, body, data, readAt: null });
  return { notification: notification.toObject() };
}

/** Clamp a requested page size into the configured range (spec §80). */
function clampLimit(limit) {
  const requested = Number(limit);
  if (!Number.isInteger(requested) || requested < 1) return config.notifications.defaultLimit;
  return Math.min(requested, config.notifications.maxLimit);
}

/**
 * The recipient's inbox (task 7), newest first, cursor-paginated.
 *
 * **Keyset pagination on `(createdAt, _id)`, not `_id` alone and not an
 * offset.** The inbox is spec'd to sort by `createdAt`, so the cursor anchors
 * on it; `_id` is the tiebreaker because two rows can share a millisecond and
 * MongoDB's sort is stable only per key. The cursor the client holds is the
 * last row's `_id` (the same shape every other list in this API hands out); the
 * anchor's `createdAt` is looked up server-side to rebuild the predicate — one
 * point read per page, and it never trusts a client-supplied timestamp. A
 * cursor that no longer resolves (deleted row, another account's id) degrades
 * to an `_id`-only keyset, which is still bounded and still scoped to the
 * caller by the mandatory `userId` filter.
 *
 * @param {string} userId
 * @param {{type?: string, unreadOnly?: boolean, limit?: number, cursor?: string}} query
 * @returns {Promise<{items: object[], nextCursor: string|null, unreadCount: number}>}
 */
async function list(userId, query = {}) {
  const limit = clampLimit(query.limit);
  const filter = { userId };
  if (query.type) filter.type = query.type;
  // `unreadOnly` is a filter, not a sort trick: unread is `{ readAt: null }`,
  // which the `{ userId, readAt }` index serves.
  if (query.unreadOnly) filter.readAt = null;
  if (query.cursor) {
    const anchor = await Notification.findOne({ _id: query.cursor, userId }).select('createdAt').lean();
    if (anchor) {
      filter.$or = [
        { createdAt: { $lt: anchor.createdAt } },
        { createdAt: anchor.createdAt, _id: { $lt: anchor._id } }
      ];
    } else {
      filter._id = { $lt: query.cursor };
    }
  }

  const rows = await Notification.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const last = page[page.length - 1];
  return {
    items: page.map(serializeNotification),
    nextCursor: hasMore && last ? String(last._id) : null,
    // Returned alongside the page so a badge and the list can never disagree
    // (they are computed in one request against the same filter minus the
    // cursor).
    unreadCount: await unreadCount(userId, query.type ? { type: query.type } : undefined)
  };
}

/**
 * The badge count (task 7), backed by the `{ userId, readAt }` index.
 *
 * @param {string} userId
 * @param {{type?: string}} [scope] optional type scope, used by a filtered inbox
 * @returns {Promise<number>}
 */
async function unreadCount(userId, scope = {}) {
  const filter = { userId, readAt: null };
  if (scope && scope.type) filter.type = scope.type;
  return Notification.countDocuments(filter);
}

/**
 * Mark one notification read (task 7) — owner-only and idempotent.
 *
 * Ownership is a query predicate (`{ _id, userId }`), so another account's row
 * simply does not match and answers 404 — never a 403 that would confirm it
 * exists (spec §44, gate G3.1). Idempotency: a repeat mark keeps the *first*
 * `readAt` rather than re-stamping it, so "read 3 days ago" does not become
 * "read now" because a client re-rendered the inbox.
 *
 * @param {string} userId
 * @param {string} notificationId
 * @returns {Promise<{notification: object, alreadyRead: boolean}>}
 */
async function markRead(userId, notificationId) {
  // Try the unread transition first; it is the common path and it is atomic.
  const updated = await Notification.findOneAndUpdate(
    { _id: notificationId, userId, readAt: null },
    { $set: { readAt: new Date() } },
    { new: true }
  ).lean();

  if (updated) return { notification: serializeNotification(updated), alreadyRead: false };

  // No unread match: either it is already read (idempotent 200) or it is not
  // the caller's row (404, indistinguishable from nonexistent by design).
  const existing = await Notification.findOne({ _id: notificationId, userId }).lean();
  if (!existing) throw new NotFoundError('The requested resource does not exist.');
  return { notification: serializeNotification(existing), alreadyRead: true };
}

/**
 * Mark the caller's whole inbox read (task 7). Scoped to the caller by
 * construction — the update filter always carries `userId` (spec §44).
 *
 * @param {string} userId
 * @returns {Promise<{modifiedCount: number}>}
 */
async function markAllRead(userId) {
  const result = await Notification.updateMany(
    { userId, readAt: null },
    { $set: { readAt: new Date() } }
  );
  return { modifiedCount: result.modifiedCount };
}

/**
 * A safe projection of one row (task 10, spec §30, §112).
 *
 * Named fields only: no `userId` (the recipient knows who they are), no
 * `updatedAt`, and `data` exactly as its producer shaped it — identifiers,
 * never a copied document.
 */
function serializeNotification(row) {
  return {
    id: String(row._id),
    type: row.type,
    title: row.title,
    body: row.body,
    data: row.data ?? {},
    readAt: row.readAt ?? null,
    createdAt: row.createdAt
  };
}

module.exports = {
  create,
  list,
  unreadCount,
  markRead,
  markAllRead,
  renderCopy,
  clampLimit,
  serializeNotification
};
