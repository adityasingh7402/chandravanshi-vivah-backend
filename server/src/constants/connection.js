'use strict';

/**
 * Connection constants (spec §21, §100, §105; finalized decisions §7, §8;
 * step 11 tasks 2, 3).
 *
 * A `connection` is the formal handshake — send → pending → accept/reject/
 * withdraw/expire, and close for an already accepted match. This module is the
 * single source of truth for the six statuses, the legal transition matrix and
 * the re-send rule, so the model enum, the validator, the policy and the service
 * cannot disagree about what a status means.
 *
 * Two sets of statuses matter and they are deliberately different:
 *
 *   - `ACTIVE_STATUSES` is what the **partial unique index** covers: the states
 *     in which an *open* relationship exists between a sender and a receiver.
 *   - `TERMINAL_STATUSES` is what a **new send may follow** (decisions §8). A
 *     terminal row is history; a new send creates a new row and never mutates
 *     the old one.
 *
 * **Resolved ambiguity (decisions §7/§8 vs. the documented index).** Decisions
 * §8 says a new interest is allowed after `closed`, yet the step-11 index table
 * lists `closed` among the states the pair's unique index covers — the two
 * cannot both hold, because a new `pending` row for the same directed pair would
 * then collide with the preserved `closed` row. The verification commands decide
 * it: command 11 closes an accepted connection, command 12 re-sends and expects
 * **201 with a NEW pending row while the closed row is unchanged** (gates G2.10,
 * G2.11). `ACTIVE_STATUSES` therefore holds the two genuinely open states,
 * `pending` and `accepted`, and `closed` is terminal history like the other
 * three — see `docs/steps/11-interests-connections.md`.
 *
 * Everything mutable (message cap, rate window, expiry days, page sizes) lives
 * in `config/env.js`.
 */

/** Spec §21 + decisions §7 — the final six-value status enum. */
const CONNECTION_STATUSES = Object.freeze([
  'pending',
  'accepted',
  'rejected',
  'withdrawn',
  'expired',
  'closed'
]);

const CONNECTION_STATUS = Object.freeze({
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
  EXPIRED: 'expired',
  CLOSED: 'closed'
});

/**
 * The states the partial unique `{ senderId, receiverId }` index covers: an
 * *open* relationship. `accepted` is included because only one match may exist
 * for a pair; `closed` is not, so a re-send after closure is legal (decisions
 * §8; see the note above).
 */
const ACTIVE_STATUSES = Object.freeze([CONNECTION_STATUS.PENDING, CONNECTION_STATUS.ACCEPTED]);

/**
 * Terminal states. A previous relationship in any of these never returns to
 * `pending`; a new send creates a new record (decisions §8).
 */
const TERMINAL_STATUSES = Object.freeze([
  CONNECTION_STATUS.REJECTED,
  CONNECTION_STATUS.WITHDRAWN,
  CONNECTION_STATUS.EXPIRED,
  CONNECTION_STATUS.CLOSED
]);

/** The direction a connection list is read from (the caller's side). */
const DIRECTIONS = Object.freeze(['sent', 'received']);
const DIRECTION = Object.freeze({ SENT: 'sent', RECEIVED: 'received' });

/** The actions a client may ask for; `send` creates the row and `timeout` is the sweep's. */
const CONNECTION_ACTIONS = Object.freeze(['send', 'accept', 'reject', 'withdraw', 'timeout', 'close']);

/** The actions a client may PATCH onto an existing row. */
const RESPONSE_ACTIONS = Object.freeze(['accept', 'reject', 'withdraw', 'close']);

const CONNECTION_ACTION = Object.freeze({
  SEND: 'send',
  ACCEPT: 'accept',
  REJECT: 'reject',
  WITHDRAW: 'withdraw',
  TIMEOUT: 'timeout',
  CLOSE: 'close'
});

/** Who is allowed to perform an action. `system` is the expiry sweep. */
const ACTOR_ROLE = Object.freeze({
  SENDER: 'sender',
  RECEIVER: 'receiver',
  SYSTEM: 'system'
});

/**
 * The state machine as **data** (decisions §7). Each entry is the one legal
 * transition for that action:
 *
 *   from    the status the row must currently be in (`null` = the row does not
 *           exist yet, i.e. `send`)
 *   to      the resulting status
 *   actors  the roles permitted to perform it
 *
 * Anything not described here is illegal and is refused by
 * `connectionPolicy.canTransition` (spec §91 — the client's requested action is
 * validated against the current status, never trusted).
 */
const TRANSITIONS = Object.freeze({
  [CONNECTION_ACTION.SEND]: Object.freeze({
    from: null,
    to: CONNECTION_STATUS.PENDING,
    actors: Object.freeze([ACTOR_ROLE.SENDER])
  }),
  [CONNECTION_ACTION.ACCEPT]: Object.freeze({
    from: CONNECTION_STATUS.PENDING,
    to: CONNECTION_STATUS.ACCEPTED,
    actors: Object.freeze([ACTOR_ROLE.RECEIVER])
  }),
  [CONNECTION_ACTION.REJECT]: Object.freeze({
    from: CONNECTION_STATUS.PENDING,
    to: CONNECTION_STATUS.REJECTED,
    actors: Object.freeze([ACTOR_ROLE.RECEIVER])
  }),
  [CONNECTION_ACTION.WITHDRAW]: Object.freeze({
    from: CONNECTION_STATUS.PENDING,
    to: CONNECTION_STATUS.WITHDRAWN,
    actors: Object.freeze([ACTOR_ROLE.SENDER])
  }),
  [CONNECTION_ACTION.TIMEOUT]: Object.freeze({
    from: CONNECTION_STATUS.PENDING,
    to: CONNECTION_STATUS.EXPIRED,
    actors: Object.freeze([ACTOR_ROLE.SYSTEM])
  }),
  [CONNECTION_ACTION.CLOSE]: Object.freeze({
    from: CONNECTION_STATUS.ACCEPTED,
    to: CONNECTION_STATUS.CLOSED,
    actors: Object.freeze([ACTOR_ROLE.SENDER, ACTOR_ROLE.RECEIVER])
  })
});

/** Only an accepted connection carries chat access (spec §21, §100). */
const CHAT_STATUSES = Object.freeze([CONNECTION_STATUS.ACCEPTED]);

/** True when `value` is one of the six §21 statuses. */
function isConnectionStatus(value) {
  return CONNECTION_STATUSES.includes(value);
}

/** True when a row in this status occupies the pair's *active* slot. */
function isActiveStatus(value) {
  return ACTIVE_STATUSES.includes(value);
}

/** True when a row in this status is history a new send may follow. */
function isTerminalStatus(value) {
  return TERMINAL_STATUSES.includes(value);
}

/** True when `action` is one the API accepts on an existing connection. */
function isResponseAction(value) {
  return RESPONSE_ACTIONS.includes(value);
}

/** True when a row in this status grants chat access. */
function grantsChat(status) {
  return CHAT_STATUSES.includes(status);
}

module.exports = {
  CONNECTION_STATUSES,
  CONNECTION_STATUS,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  DIRECTIONS,
  DIRECTION,
  CONNECTION_ACTIONS,
  RESPONSE_ACTIONS,
  CONNECTION_ACTION,
  ACTOR_ROLE,
  TRANSITIONS,
  CHAT_STATUSES,
  isConnectionStatus,
  isActiveStatus,
  isTerminalStatus,
  isResponseAction,
  grantsChat
};
