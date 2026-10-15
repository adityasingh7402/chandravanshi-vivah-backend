'use strict';

/**
 * Connection service — the interest handshake (spec §21, §22, §36, §44, §91,
 * §96, §99, §100, §105, §112; finalized decisions §7, §8, §9, §16; step 11 tasks
 * 5–13).
 *
 * The state machine is the source of truth for a matching relationship, and it
 * is enforced here entirely server-side:
 *
 *   send                                              (a new `pending` row)
 *     ↓
 *   accept (receiver)  → accepted   … canChat(A,B) === true   (spec §21, §100)
 *   reject (receiver)  → rejected
 *   withdraw (sender)  → withdrawn
 *   timeout (sweep)    → expired
 *   close (either)     → closed     … canChat(A,B) === false  (decisions §7)
 *
 * Four decisions are deliberate and worth naming:
 *
 *  - **Re-send after a terminal state is legal** and always creates a *new* row;
 *    the old one is never mutated back to `pending` (decisions §8). `closed`
 *    counts as terminal here — see `constants/connection.js` for the resolved
 *    §7/§8 ambiguity.
 *  - **One active relationship per pair.** The `[pending, accepted]` partial
 *    unique index is the database guarantee; the service also refuses a
 *    *crossing* send (an interest in the opposite direction while one is open)
 *    with a 409 and a hint, because a mutual auto-accept is explicitly deferred
 *    by the step (`Later`).
 *  - **No transaction between the status change and the notification.** The
 *    connection update is authoritative; the event is a side effect that must
 *    never block or roll back an acceptance (decisions §16). Events are emitted
 *    on an in-process bus that step 13 subscribes to — this service never writes
 *    a notification document (task 12, task 13).
 *  - **Chat is derived, never stored as a client flag.** `canChat` lives in
 *    `connectionPolicy`; step 14 calls it.
 *
 * The actor is always `req.auth.userId`. Nothing in this module accepts an actor
 * from a request body.
 */

const { EventEmitter } = require('node:events');
const config = require('../config/env');
const Connection = require('../models/Connection');
const MatrimonialProfile = require('../models/MatrimonialProfile');
const actionService = require('./actionService');
const exclusionService = require('./exclusionService');
const searchService = require('./searchService');
const policy = require('./connectionPolicy');
const projections = require('../utils/projections');
const { logger } = require('../middleware/requestLogger');
const { BadRequestError, ConflictError, ForbiddenError, NotFoundError } = require('../utils/AppError');
const { PROFILE_STATUS } = require('../constants/profile');
const {
  CONNECTION_STATUS,
  ACTIVE_STATUSES,
  DIRECTION,
  CONNECTION_ACTION,
  ACTOR_ROLE,
  TRANSITIONS,
  grantsChat
} = require('../constants/connection');

/**
 * In-process domain events for step 13's notification layer. The connection
 * service emits `interest_received`, `interest_accepted`, `interest_rejected`
 * and `connection_closed`; step 13 maps `interest_accepted` to exactly **one**
 * `new_match` notification (decisions §9). A listener that throws can never break
 * a write because every emit is wrapped.
 */
const events = new EventEmitter();
events.setMaxListeners(0);

function emitDomainEvent(payload) {
  try {
    events.emit('connection', payload);
  } catch {
    // A subscriber's bug must never fail the write that produced the event.
  }
}

/** Clamp a requested page size into the configured range (spec §80). */
function clampLimit(limit) {
  const requested = Number(limit);
  if (!Number.isInteger(requested) || requested < 1) return config.connections.defaultLimit;
  return Math.min(requested, config.connections.maxLimit);
}

/** The MongoDB duplicate-key error, whether it arrives as 11000 or 11001. */
function isDuplicateKey(err) {
  return Boolean(err) && (err.code === 11000 || err.code === 11001);
}

/**
 * The target profile's account id, and a check that it is a visible, active
 * profile. Both are the same rules the action service applies (spec §44, §58,
 * §100): a client can name the target by account id or by the public id, and a
 * non-active target answers exactly like a missing one so its status cannot be
 * probed through this endpoint.
 *
 * Reusing the action service's helpers keeps "who may be contacted" identical
 * between a like and an interest.
 */
async function resolveTarget(input) {
  return actionService.resolveTarget(input);
}

async function assertTargetVisible(targetId) {
  return actionService.assertTargetVisible(targetId);
}

/**
 * Is this account blocked from acting on that one, in either direction?
 *
 * Reads the same `exclusionService.blockExclusion` interface Discover uses
 * (spec §22, §99). Until step 12 registers the `blocks` model there is nothing to
 * read and this is a no-op; once it lands, the rule applies automatically.
 */
async function assertNotBlocked(actorId, targetId) {
  const blocked = await exclusionService.blockExclusion(actorId);
  if (blocked.includes(String(targetId))) {
    throw new NotFoundError('The requested resource does not exist.');
  }
}

/**
 * The open relationship between two accounts, in **either** direction, or null.
 *
 * "Open" is `@see ACTIVE_STATUSES` (`pending`, `accepted`). A terminal row is
 * history and does not block a new send (decisions §8).
 *
 * @param {string} a
 * @param {string} b
 * @returns {Promise<object|null>} lean connection row
 */
async function findActiveBetween(a, b) {
  if (!a || !b) return null;
  return Connection.findOne({
    status: { $in: ACTIVE_STATUSES },
    $or: [
      { senderId: a, receiverId: b },
      { senderId: b, receiverId: a }
    ]
  }).lean();
}

/**
 * Send an interest (task 5).
 *
 * Order matters: self → target visibility → block → active-relationship → insert.
 * Self is checked before any query, the target must be an active profile, a
 * blocked pair is refused, and a pair that already has an open relationship is a
 * 409 — including the crossing case, where the caller is the *receiver* of the
 * open interest and is about to send one back. That case gets a hint rather than
 * a silent duplicate, because a mutual auto-accept is explicitly deferred by the
 * step.
 *
 * @param {string} actorId from `req.auth.userId`
 * @param {{toUserId?: string, publicProfileId?: string, message?: string|null}} input validated body
 * @returns {Promise<{ connection: object, created: boolean }>}
 */
async function send(actorId, input) {
  const targetId = await resolveTarget(input);

  if (String(targetId) === String(actorId)) {
    throw new BadRequestError('You cannot send an interest to your own profile.', {
      details: { toUserId: 'Choose another profile.' }
    });
  }

  await assertTargetVisible(targetId);
  await assertNotBlocked(actorId, targetId);

  const active = await findActiveBetween(actorId, targetId);
  if (active) {
    const inbound = String(active.receiverId) === String(actorId);
    throw new ConflictError('An interest between you and this member is already active.', {
      details: {
        status: active.status,
        direction: inbound ? DIRECTION.RECEIVED : DIRECTION.SENT,
        hint: inbound
          ? 'This member has already sent you an interest. Respond to it instead of sending your own.'
          : 'You already have an active interest with this member.'
      }
    });
  }

  const now = new Date();
  try {
    // The schema's own timestamps give the row its `createdAt`, which is what
    // the expiry sweep reads — so it is never supplied by hand here.
    const connection = await Connection.create({
      senderId: actorId,
      receiverId: targetId,
      status: CONNECTION_STATUS.PENDING,
      message: input.message ?? null,
      respondedAt: null
    });

    emitDomainEvent({
      type: 'interest_received',
      connectionId: String(connection._id),
      senderId: String(actorId),
      receiverId: String(targetId),
      at: now
    });

    return { connection: connection.toObject(), created: true };
  } catch (err) {
    // The partial unique index is the concurrency guarantee (task 11): two
    // identical sends racing each other cannot both insert, and the loser is a
    // 409 Conflict, never a 500 (decisions §8).
    if (isDuplicateKey(err)) {
      throw new ConflictError('An interest between you and this member is already active.');
    }
    throw err;
  }
}

/**
 * The single transition path for accept / reject / withdraw / close (tasks 6–8).
 *
 * Authorization is two separate checks, on purpose:
 *
 *   1. **Participation** — an account that is neither the sender nor the receiver
 *      gets a **404**, never a 403, so the endpoint cannot confirm that another
 *      member's connection exists (spec §44, gate G3.1).
 *   2. **Role** — a participant with the wrong role (the sender trying to accept
 *      their own interest, the receiver trying to withdraw it) gets a **403**.
 *   3. **State** — a legal actor asking for an illegal transition (rejecting an
 *      already accepted match) gets a **409**, and the row is unchanged.
 *
 * The write is a conditional update keyed on the status we read, so two
 * concurrent responses cannot both win: the loser's filter no longer matches and
 * is answered 409.
 *
 * @param {string} actorId from `req.auth.userId`
 * @param {string} connectionId
 * @param {string} action one of `RESPONSE_ACTIONS`
 * @returns {Promise<object>} the updated lean connection row
 */
async function respond(actorId, connectionId, action) {
  const connection = await Connection.findById(connectionId).lean();
  if (!connection) throw new NotFoundError('The requested resource does not exist.');

  const role = policy.actorRoleFor(connection, actorId);
  if (!role) throw new NotFoundError('The requested resource does not exist.');

  const rule = TRANSITIONS[action];
  if (!rule) throw new BadRequestError('Invalid request.', { details: { action: 'Unknown action.' } });

  if (!rule.actors.includes(role)) {
    const message =
      action === CONNECTION_ACTION.WITHDRAW
        ? 'Only the sender can withdraw an interest.'
        : action === CONNECTION_ACTION.CLOSE
          ? 'Only a participant can close this connection.'
          : 'Only the receiver can accept or reject an interest.';
    throw new ForbiddenError(message);
  }

  if (connection.status !== rule.from) {
    throw new ConflictError(`This connection is "${connection.status}" and cannot be changed by "${action}".`, {
      details: { status: connection.status, action }
    });
  }

  await assertNotBlocked(actorId, role === ACTOR_ROLE.SENDER ? connection.receiverId : connection.senderId);

  const now = new Date();
  const updated = await Connection.findOneAndUpdate(
    { _id: connectionId, status: rule.from },
    { $set: { status: rule.to, respondedAt: now } },
    { new: true }
  ).lean();

  if (!updated) {
    throw new ConflictError('This connection changed while the request was in flight. Reload and try again.', {
      details: { action }
    });
  }

  const eventType =
    action === CONNECTION_ACTION.ACCEPT
      ? 'interest_accepted'
      : action === CONNECTION_ACTION.REJECT
        ? 'interest_rejected'
        : action === CONNECTION_ACTION.WITHDRAW
          ? 'interest_withdrawn'
          : 'connection_closed';

  emitDomainEvent({
    type: eventType,
    connectionId: String(updated._id),
    senderId: String(updated.senderId),
    receiverId: String(updated.receiverId),
    status: updated.status,
    at: now
  });

  return updated;
}

/** Accept, reject and withdraw are all `respond` with a named action (tasks 6, 8). */
const accept = (actorId, connectionId) => respond(actorId, connectionId, CONNECTION_ACTION.ACCEPT);
const reject = (actorId, connectionId) => respond(actorId, connectionId, CONNECTION_ACTION.REJECT);
const withdraw = (actorId, connectionId) => respond(actorId, connectionId, CONNECTION_ACTION.WITHDRAW);
const close = (actorId, connectionId) => respond(actorId, connectionId, CONNECTION_ACTION.CLOSE);

/**
 * Close the accepted connection between two accounts, if there is one.
 *
 * Step 12's block path and step 16's moderation path call this rather than
 * searching for the row themselves: "close for access" stays one implementation.
 * It answers `false` when the pair has no accepted connection, which is the
 * normal case and never an error.
 *
 * @param {string} a account id
 * @param {string} b account id
 * @returns {Promise<boolean>} true when a row was moved to `closed`
 */
async function closeAcceptedForPair(a, b) {
  if (!a || !b) return false;
  const accepted = await Connection.findOne({
    status: CONNECTION_STATUS.ACCEPTED,
    $or: [
      { senderId: a, receiverId: b },
      { senderId: b, receiverId: a }
    ]
  })
    .select('_id')
    .lean();
  if (!accepted) return false;
  return closeForAccess(String(accepted._id));
}

/**
 * Close an accepted connection for **access** without a participant asking.
 *
 * This is the seam step 12's block path and step 16's moderation path use: an
 * accepted match that becomes unusable is treated as closed for access, while the
 * historical row is preserved (decisions §7). Only an `accepted` row is touched —
 * calling it on a row that is already terminal is a no-op, not an error.
 *
 * @param {string} connectionId
 * @returns {Promise<boolean>} true when the row was moved to `closed`
 */
async function closeForAccess(connectionId) {
  const now = new Date();
  const updated = await Connection.findOneAndUpdate(
    { _id: connectionId, status: CONNECTION_STATUS.ACCEPTED },
    { $set: { status: CONNECTION_STATUS.CLOSED, respondedAt: now } },
    { new: true }
  ).lean();

  if (!updated) return false;

  emitDomainEvent({
    type: 'connection_closed',
    connectionId: String(updated._id),
    senderId: String(updated.senderId),
    receiverId: String(updated.receiverId),
    status: updated.status,
    reason: 'access',
    at: now
  });
  return true;
}

/** Module-level throttle state for the lazy sweep. */
let lastSweepAt = 0;

/**
 * Move stale `pending` rows to `expired` (task 9).
 *
 * The query is exactly the shape the `{ status: 1, createdAt: 1 }` index serves:
 * `status: pending` plus an age bound, so it never scans the collection
 * (§105, gate G4.2).
 *
 * It runs lazily on read (throttled by `CONNECTIONS_SWEEP_INTERVAL_SECONDS`) and
 * is exported so a scheduler — or a verification harness — can force it. The
 * count is logged server-side, never returned to a client.
 *
 * @param {{force?: boolean, now?: Date}} [options]
 * @returns {Promise<{swept: number, skipped: boolean}>}
 */
async function sweepExpired({ force = false, now = new Date() } = {}) {
  const throttleMs = config.connections.sweepIntervalSeconds * 1000;
  if (!force && Date.now() - lastSweepAt < throttleMs) return { swept: 0, skipped: true };
  lastSweepAt = Date.now();

  const cutoff = new Date(now.getTime() - config.connections.expiryDays * 24 * 60 * 60 * 1000);
  const result = await Connection.updateMany(
    { status: CONNECTION_STATUS.PENDING, createdAt: { $lt: cutoff } },
    { $set: { status: CONNECTION_STATUS.EXPIRED, respondedAt: now } }
  );

  const swept = result.modifiedCount || 0;
  if (swept > 0) logger.info({ count: swept }, 'connection expiry sweep: pending -> expired');
  return { swept, skipped: false };
}

/** The one public projection of a connection row, from the caller's side. */
function serializeConnection(row, box) {
  return {
    id: String(row._id),
    status: row.status,
    direction: box,
    message: row.message ?? null,
    respondedAt: row.respondedAt ?? null,
    createdAt: row.createdAt,
    canChat: grantsChat(row.status)
  };
}

/**
 * The caller's own connections, as cards (task 10).
 *
 * `box` selects the caller's side (`sent` = the caller is the sender, `received`
 * = the receiver); `status` narrows to one of the six statuses. The counterpart
 * profiles are resolved through step 09's shared **card projection** and
 * serialiser, so a connection list renders like a discovery card and can never
 * leak a private field (spec §112, gate G3.8) — and the row's own account id is
 * never echoed.
 *
 * Pagination is by the connection row's `_id` (an opaque ObjectId cursor, newest
 * first), exactly as step 10's action list pages.
 *
 * @param {string} actorId from `req.auth.userId`
 * @param {{box?: string, status?: string, limit?: number, cursor?: string}} query validated query
 */
async function list(actorId, query = {}) {
  // Lazy expiry: a stale pending row is answered as `expired` on the next read
  // rather than sitting `pending` forever (task 9). Throttled, so a read never
  // waits on a write it does not need.
  await sweepExpired();

  const box = query.box === DIRECTION.SENT ? DIRECTION.SENT : DIRECTION.RECEIVED;
  const limit = clampLimit(query.limit);

  const filter = box === DIRECTION.SENT ? { senderId: actorId } : { receiverId: actorId };
  if (query.status) filter.status = query.status;
  if (query.cursor) filter._id = { $lt: query.cursor };

  const rows = await Connection.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const counterpartOf = (row) => (box === DIRECTION.SENT ? row.receiverId : row.senderId);
  const counterpartIds = page.map(counterpartOf).filter(Boolean);

  const profiles = await MatrimonialProfile.find({
    userId: { $in: counterpartIds },
    'profile.status': PROFILE_STATUS.ACTIVE
  })
    .select(projections.CARD_PROJECTION)
    .lean();

  const byUser = new Map(profiles.map((profile) => [String(profile.userId), profile]));
  const pairs = page
    .map((row) => ({ row, profile: byUser.get(String(counterpartOf(row))) }))
    .filter((pair) => Boolean(pair.profile));

  const cards = await searchService.toItems(pairs.map((pair) => pair.profile));
  const items = cards.map((card, index) => ({
    ...card,
    connection: serializeConnection(pairs[index].row, box)
  }));

  const last = page[page.length - 1];
  return {
    items,
    box,
    nextCursor: hasMore && last ? String(last._id) : null
  };
}

/** The caller's received interests, newest first. */
async function listReceived(actorId, query = {}) {
  return list(actorId, { ...query, box: DIRECTION.RECEIVED });
}

/** The caller's sent interests, newest first. */
async function listSent(actorId, query = {}) {
  return list(actorId, { ...query, box: DIRECTION.SENT });
}

module.exports = {
  send,
  respond,
  accept,
  reject,
  withdraw,
  close,
  closeForAccess,
  closeAcceptedForPair,
  sweepExpired,
  list,
  listReceived,
  listSent,
  findActiveBetween,
  serializeConnection,
  clampLimit,
  events
};
