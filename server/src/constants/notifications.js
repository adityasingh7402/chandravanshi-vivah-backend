'use strict';

/**
 * Notification constants (spec §24; finalized decisions §9, §10; step 13 task 2).
 *
 * The type set is spec §24's exactly — nine values, no more. `NOTIFICATION_COPY`
 * holds the default title/body per type; the wording lives here rather than in
 * the service so it can change (or be localised later) without touching any
 * flow. A body template receives its substitutions as `{placeholders}` and is
 * only ever rendered with identifiers or first names — never a private field
 * (spec §30, §112).
 *
 * The domain-event name and the user-facing type are deliberately separate
 * (decisions §9): the connection service keeps emitting `interest_accepted`,
 * and the notification layer maps it to `new_match`, so wording can change
 * without touching the connection flow.
 */

/** The full spec §24 type set. */
const NOTIFICATION_TYPES = Object.freeze([
  'interest_received',
  'interest_accepted',
  'interest_rejected',
  'new_match',
  'new_message',
  'profile_view',
  'shortlisted',
  'verification_completed',
  'admin_alert'
]);

/** Fast membership check used by the service before any write. */
const NOTIFICATION_TYPE_SET = new Set(NOTIFICATION_TYPES);

/**
 * Types whose *actor* is a real account, so the block rule applies (spec §22).
 * `verification_completed` and `admin_alert` are admin-originated (step 16) and
 * have no peer actor to suppress against.
 */
const PEER_TYPES = new Set([
  'interest_received',
  'interest_accepted',
  'interest_rejected',
  'new_match',
  'new_message',
  'profile_view',
  'shortlisted'
]);

/**
 * High-frequency types that are coalesced rather than inserted repeatedly
 * (task 6, spec §36). Each entry names the `data` field that identifies the
 * actor, so "the same person doing the same thing again" collapses into the
 * existing row: the row is re-dated and un-read rather than duplicated, which
 * keeps the inbox bounded while still surfacing the newest signal.
 */
const COALESCED_TYPES = Object.freeze({
  profile_view: { actorField: 'fromProfileId', windowMinutesEnv: 'viewThrottleMinutes' },
  shortlisted: { actorField: 'fromProfileId', windowMinutesEnv: 'viewThrottleMinutes' },
  // Step 14 wires new_message through the same service; the window is the
  // message-coalesce one and the actor field identifies the conversation's
  // other participant pair per conversation.
  new_message: { actorField: 'conversationId', windowMinutesEnv: 'messageCoalesceMinutes' }
});

/**
 * Default copy per type. `{placeholders}` are filled by the event mapping;
 * a missing name degrades to a neutral word rather than rendering "undefined".
 * No template ever interpolates a message body, an email, a phone number or
 * any other private field (spec §112).
 */
const NOTIFICATION_COPY = Object.freeze({
  interest_received: Object.freeze({
    title: 'New interest',
    body: '{name} sent you an interest.'
  }),
  interest_accepted: Object.freeze({
    title: 'Interest accepted',
    body: '{name} accepted your interest.'
  }),
  interest_rejected: Object.freeze({
    title: 'Interest not accepted',
    body: '{name} did not accept your interest.'
  }),
  // Decisions §9: exactly ONE user-facing row per acceptance, and its wording
  // conveys both the acceptance and the new match. There is no second
  // `interest_accepted` inbox row — that name exists only as a domain event.
  new_match: Object.freeze({
    title: 'It’s a match!',
    body: '{name} accepted your interest — you are now connected.'
  }),
  new_message: Object.freeze({
    title: 'New message',
    body: 'You have a new message from {name}.'
  }),
  profile_view: Object.freeze({
    title: 'Profile viewed',
    body: '{name} viewed your profile.'
  }),
  shortlisted: Object.freeze({
    title: 'Added to shortlist',
    body: '{name} added you to their shortlist.'
  }),
  verification_completed: Object.freeze({
    title: 'Verification complete',
    body: 'Your profile verification has been completed.'
  }),
  admin_alert: Object.freeze({
    title: 'Message from the team',
    body: 'The Chandravanshi Vivah team sent you a message.'
  })
});

module.exports = {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_SET,
  PEER_TYPES,
  COALESCED_TYPES,
  NOTIFICATION_COPY
};
