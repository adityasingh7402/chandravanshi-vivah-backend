'use strict';

/**
 * Connection policy — the state machine and the chat derivation (spec §21, §91,
 * §100; finalized decisions §7, §8; step 11 task 2).
 *
 * This module answers the two questions the rest of the system must never answer
 * for itself:
 *
 *   - **`canTransition(from, action, actorRole)`** — is this action legal from
 *     this status for this actor? The matrix is data in `constants/connection.js`;
 *     this is only the lookup, so the service and the tests cannot disagree.
 *   - **`canChat(userA, userB)`** — may these two accounts communicate? Chat is
 *     *derived* from an `accepted` connection and never from a client flag, which
 *     is what makes the backend the authority (spec §21, §100). Step 14 calls
 *     this one function.
 *
 * Both are pure reads over the connection rows. `canChat` deliberately checks
 * **both directions**: the accepted row may have been sent by either account, and
 * a match is symmetric.
 *
 * **A block overrides everything (spec §22, decisions §7).** `canChat` consults
 * `blockService.isBlockedEitherWay` *before* the accepted row, so an accepted
 * match that becomes unusable is closed *for access* the moment the block exists —
 * `canChat` is false and new sends are refused — even though the historical row is
 * preserved and is not deleted. Step 12 also moves such a row to `closed` through
 * `connectionService.closeAcceptedForPair` so the stored record reflects reality;
 * the derived check is what makes the gate authoritative rather than dependent on
 * that write having happened.
 */

const Connection = require('../models/Connection');
const blockService = require('./blockService');
const {
  CONNECTION_STATUS,
  TRANSITIONS,
  ACTOR_ROLE,
  grantsChat
} = require('../constants/connection');

/**
 * Is this action legal from this status for this actor?
 *
 * `from` may be `null`/`undefined`, which means "the row does not exist yet" —
 * the precondition for `send`.
 *
 * @param {string|null|undefined} from current status (null when nothing exists)
 * @param {string} action one of `CONNECTION_ACTIONS`
 * @param {string} actorRole `ACTOR_ROLE.SENDER | RECEIVER | SYSTEM`
 * @returns {boolean}
 */
function canTransition(from, action, actorRole) {
  const rule = TRANSITIONS[action];
  if (!rule) return false;
  if (!rule.actors.includes(actorRole)) return false;

  const status = from === undefined ? null : from;
  if (rule.from === null) return status === null;
  return status === rule.from;
}

/** The single legal target status for an action, or null when the action is unknown. */
function targetStatusFor(action) {
  const rule = TRANSITIONS[action];
  return rule ? rule.to : null;
}

/** True when an action may be performed by this actor on a row in this status. */
function actionAllowedFor(status, action, actorRole) {
  return canTransition(status, action, actorRole);
}

/**
 * Which role is this account for this connection?
 *
 * @returns {'sender'|'receiver'|null} null when the account is a participant of
 *   neither side — the caller must then treat the row as not found (spec §44,
 *   gate G3.1).
 */
function actorRoleFor(connection, actorId) {
  if (!connection || !actorId) return null;
  const actor = String(actorId);
  if (connection.senderId && String(connection.senderId) === actor) return ACTOR_ROLE.SENDER;
  if (connection.receiverId && String(connection.receiverId) === actor) return ACTOR_ROLE.RECEIVER;
  return null;
}

/**
 * Does an `accepted` connection exist between these two accounts, in either
 * direction?
 *
 * This is the only gate on chat access (spec §21, §100). A `closed` (or blocked)
 * connection is treated as closed for access, so `canChat` is false even though
 * the historical row survives (decisions §7).
 *
 * @param {string} userA
 * @param {string} userB
 * @returns {Promise<boolean>}
 */
async function canChat(userA, userB) {
  if (await blockService.isBlockedEitherWay(userA, userB)) return false;
  return Boolean(await acceptedBetween(userA, userB));
}

/**
 * The accepted connection between two accounts, in either direction, or null.
 *
 * Exported for step 14, which needs the conversation's connection id, not just a
 * boolean.
 *
 * @returns {Promise<object|null>} lean connection row
 */
async function acceptedBetween(userA, userB) {
  if (!userA || !userB) return null;
  if (String(userA) === String(userB)) return null;
  return Connection.findOne({
    status: CONNECTION_STATUS.ACCEPTED,
    $or: [
      { senderId: userA, receiverId: userB },
      { senderId: userB, receiverId: userA }
    ]
  }).lean();
}

/**
 * The effective chat access for a pair, with a machine-readable reason.
 *
 * Consumed by step 14 so it can answer "you cannot message this member" without
 * having to interpret connection or block internals itself. `reason` is one of
 * `accepted` | `blocked` | `none`.
 */
async function chatAccess(userA, userB) {
  if (await blockService.isBlockedEitherWay(userA, userB)) {
    return { canChat: false, connectionId: null, reason: 'blocked' };
  }
  const connection = await acceptedBetween(userA, userB);
  return {
    canChat: Boolean(connection),
    connectionId: connection ? String(connection._id) : null,
    reason: connection ? 'accepted' : 'none'
  };
}

module.exports = {
  canTransition,
  actionAllowedFor,
  targetStatusFor,
  actorRoleFor,
  canChat,
  acceptedBetween,
  chatAccess,
  grantsChat
};
