'use strict';

/**
 * Event → notification mapping (spec §24; finalized decisions §9, §10; step 13
 * task 4).
 *
 * Subscribes once to the in-process domain buses steps 10–12 already emit
 * (`actionService.events`, `connectionService.events`) and turns their events
 * into `notifications` rows through `notificationService.create()`. Nothing in
 * steps 10–12 changes: a notification is a side effect and must never block or
 * roll back the write that produced it (decisions §16), so every handler runs
 * detached and swallows its own failure into a server-side log.
 *
 * The mapping is **data-driven** (task 4): the two registries below hold
 * `eventType → handler`, and `registerConnectionHandler` /
 * `registerActionHandler` let step 14 (`new_message`) and step 16
 * (`verification_completed`, `admin_alert`) add their own mapping without
 * editing this file or the core service. An event type with no handler is
 * deliberately ignored rather than logged as an error — `like`, `pass`,
 * `interest_withdrawn` and `connection_closed` produce no notification (spec
 * §24's type set has no row for them), and that is a decision, not a gap.
 *
 * FINAL rules this file implements (decisions §9, §10):
 *   - `interest_accepted` (domain event) → **exactly one** `new_match` inbox
 *     row, for the *sender* (the person whose interest was accepted). There is
 *     no second `interest_accepted` row; the domain-event name and the
 *     user-facing type are kept separate on purpose.
 *   - `interest_rejected` → **one** `interest_rejected` row, for the sender,
 *     carrying no private information — the id of the connection and nothing
 *     about why.
 */

const connectionService = require('./connectionService');
const actionService = require('./actionService');
const notificationService = require('./notificationService');
const MatrimonialProfile = require('../models/MatrimonialProfile');
const { logger } = require('../middleware/requestLogger');

/** eventType → async handler(event). */
const connectionHandlers = new Map();
const actionHandlers = new Map();

/**
 * Register a handler for a connection-bus event (used by steps 14 and 16).
 * Re-registering the same type replaces the handler, so a later step can
 * override a default mapping deliberately rather than double-delivering.
 *
 * @param {string} type domain-event type, e.g. 'new_message'
 * @param {(event: object) => Promise<void>} handler
 */
function registerConnectionHandler(type, handler) {
  connectionHandlers.set(type, handler);
}

/** Register a handler for an action-bus event (same contract as above). */
function registerActionHandler(type, handler) {
  actionHandlers.set(type, handler);
}

/**
 * Resolve an account to the public facts a notification may carry: the public
 * profile id (spec §113 — the client's navigation identifier) and the first
 * name for the copy. The account id itself never reaches `data` (spec §112).
 *
 * @param {string} accountId
 * @returns {Promise<{fromProfileId: string|null, name: string|null}>}
 */
async function publicFacts(accountId) {
  const profile = await MatrimonialProfile.findOne({ userId: accountId })
    .select('publicProfileId basic.firstName')
    .lean();
  if (!profile) return { fromProfileId: null, name: null };
  return {
    fromProfileId: profile.publicProfileId ?? null,
    name: profile.basic?.firstName ?? null
  };
}

/**
 * Run a detached handler (decisions §16).
 *
 * The handler is invoked through a microtask so the emit site's synchronous
 * work — the connection write that already succeeded — is never extended by
 * notification creation (gate G4.4). A rejection is logged with its event type
 * and swallowed: the originating user must not see a 500 because an inbox row
 * failed to insert.
 *
 * @param {string} bus which bus, for the log line
 * @param {Map} registry
 * @param {object} event
 */
function dispatch(bus, registry, event) {
  const handler = registry.get(event.type);
  if (!handler) return;
  Promise.resolve()
    .then(() => handler(event))
    .catch((err) => {
      logger.error(
        { bus, eventType: event.type, errName: err && err.name ? err.name : 'Error' },
        'notification handler failed'
      );
    });
}

// ---------------------------------------------------------------------------
// Default mapping — connections (steps 11/12 events)
// ---------------------------------------------------------------------------

/**
 * Interest received → the receiver's inbox. The payload carries the connection
 * id and the sender's *public* profile id, so the client can open the sender's
 * card without ever holding the sender's account id.
 */
connectionHandlers.set('interest_received', async (event) => {
  const { fromProfileId, name } = await publicFacts(event.senderId);
  await notificationService.create({
    userId: event.receiverId,
    actorId: event.senderId,
    type: 'interest_received',
    name,
    data: { connectionId: event.connectionId, fromProfileId }
  });
});

/**
 * Interest accepted (domain event) → **one** `new_match` row for the sender
 * (decisions §9). Wording lives in the copy, so the acceptance and the match
 * are both conveyed by this single row.
 */
connectionHandlers.set('interest_accepted', async (event) => {
  const { name } = await publicFacts(event.receiverId);
  await notificationService.create({
    userId: event.senderId,
    actorId: event.receiverId,
    type: 'new_match',
    name,
    data: { connectionId: event.connectionId }
  });
});

/**
 * Interest rejected → one `interest_rejected` row for the sender (decisions
 * §10). No reason, no private data — just the connection id.
 */
connectionHandlers.set('interest_rejected', async (event) => {
  const { name } = await publicFacts(event.receiverId);
  await notificationService.create({
    userId: event.senderId,
    actorId: event.receiverId,
    type: 'interest_rejected',
    name,
    data: { connectionId: event.connectionId }
  });
});

// ---------------------------------------------------------------------------
// Default mapping — profile actions (step 10 events)
// ---------------------------------------------------------------------------

/**
 * A view → `profile_view` for the viewed member. Coalesced by the service, so
 * a re-rendering client refreshes one row instead of stacking new ones (task
 * 6, spec §36). `like` and `pass` deliberately have no handler: spec §24 has no
 * type for them, and a "someone liked you" teaser is an entitlement question
 * for step 15, not a silent default.
 */
actionHandlers.set('view', async (event) => {
  const { fromProfileId, name } = await publicFacts(event.fromUserId);
  await notificationService.create({
    userId: event.toUserId,
    actorId: event.fromUserId,
    type: 'profile_view',
    name,
    data: { fromProfileId }
  });
});

/** A shortlist add → `shortlisted`, coalesced on the same window as a view. */
actionHandlers.set('shortlist', async (event) => {
  const { fromProfileId, name } = await publicFacts(event.fromUserId);
  await notificationService.create({
    userId: event.toUserId,
    actorId: event.fromUserId,
    type: 'shortlisted',
    name,
    data: { fromProfileId }
  });
});

// ---------------------------------------------------------------------------
// Subscription
// ---------------------------------------------------------------------------

let subscribed = false;

/**
 * Attach the mapping to both buses. Idempotent, so a require from `app.js` and
 * a test that calls it directly cannot double-deliver a single event.
 */
function subscribe() {
  if (subscribed) return;
  subscribed = true;
  connectionService.events.on('connection', (event) => dispatch('connection', connectionHandlers, event));
  actionService.events.on('action', (event) => dispatch('action', actionHandlers, event));
}

// Subscribe on load: any process that boots the app (the server, every HTTP
// test) gets the notification layer with no extra wiring to forget.
subscribe();

module.exports = {
  subscribe,
  registerConnectionHandler,
  registerActionHandler,
  // Exported for tests: swap a handler, assert, restore.
  connectionHandlers,
  actionHandlers,
  publicFacts,
  isSubscribed: () => subscribed
};
