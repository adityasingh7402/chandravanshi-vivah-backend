'use strict';

/**
 * Profile-action constants (spec §20, §36, §56, §99, §100; finalized decisions
 * §15; step 10 task 2).
 *
 * `profile_actions` records four lightweight interactions — `view`, `like`,
 * `shortlist`, `pass` — in their own collection so they never bloat the profile
 * document (spec §20). This module is the single source of truth for what those
 * four values are and what each one *means* to the rest of the system, so the
 * model, the validator, the service and step 09's exclusion set cannot disagree:
 *
 *   - `ACTION_TYPES` is the enum the schema and the validator both read.
 *   - `DISCOVERY_EXCLUDED_TYPES` is the one place a `pass` becomes an exclusion
 *     from Discover (spec §56, §99) — step 09's query shape is unchanged because
 *     the exclusion is still just an id in the `$nin` set.
 *
 * Everything mutable (page sizes, rate-limit windows) lives in `config/env.js`.
 */

/** The four §20 action types, in the order the API documents them. */
const ACTION_TYPES = Object.freeze(['view', 'like', 'shortlist', 'pass']);

const ACTION_TYPE = Object.freeze({
  VIEW: 'view',
  LIKE: 'like',
  SHORTLIST: 'shortlist',
  PASS: 'pass'
});

/**
 * Actions that are also *discoverable intent* — the ones a shortlist screen and
 * the exclusion set care about. A `view` is deliberately absent: viewing is not
 * a decision, so it never hides anyone from Discover.
 */
const ENGAGEMENT_TYPES = Object.freeze([ACTION_TYPE.LIKE, ACTION_TYPE.SHORTLIST, ACTION_TYPE.PASS]);

/**
 * Types whose action removes the target from Discover (spec §56, §99).
 *
 * Currently just `pass`. The list is data rather than an `if` so a product
 * decision to also hide already-*liked* targets is one edit here and nothing
 * else — the object literally is `{ pass: 'pass' }` as a set.
 */
const DISCOVERY_EXCLUDED_TYPES = Object.freeze([ACTION_TYPE.PASS]);

/**
 * Every action is idempotent for a given (from, to, type): repeating a like or a
 * shortlist updates one row rather than adding another, and a repeat view
 * refreshes the timestamp of the pair's single row (decisions §15). The unique
 * `{ fromUserId, toUserId, type }` index is what enforces it under concurrency,
 * so this list mirrors what that index guarantees.
 */
const IDEMPOTENT_TYPES = ACTION_TYPES;

/** Types that a client may record but never list as another user's history. */
const PRIVATE_TYPES = ACTION_TYPES;

/** True when `value` is one of the four §20 action types. */
function isActionType(value) {
  return ACTION_TYPES.includes(value);
}

/** True when a recorded action of this type hides the target from Discover. */
function excludesFromDiscovery(type) {
  return DISCOVERY_EXCLUDED_TYPES.includes(type);
}

module.exports = {
  ACTION_TYPES,
  ACTION_TYPE,
  ENGAGEMENT_TYPES,
  DISCOVERY_EXCLUDED_TYPES,
  IDEMPOTENT_TYPES,
  PRIVATE_TYPES,
  isActionType,
  excludesFromDiscovery
};
