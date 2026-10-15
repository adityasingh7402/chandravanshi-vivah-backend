'use strict';

/**
 * Plan identifiers, statuses and sources (spec §26; finalized decisions §11,
 * §12, §22; step 15 task 2).
 *
 * One place declares what a plan is called and where an entitlement came from.
 * The schema, the validators and the service all read these values, so adding a
 * plan later is a change here plus a mapping in `constants/features.js` — never
 * a string literal in a controller.
 *
 * The current phase is **indefinite free access** (decisions §11, §22): every
 * account receives `plan: "free"`, `status: "active"`, `source: "free_trial"`
 * with `expiresAt: null`, and nothing ever moves it to `expired`. The paid plan
 * identifiers exist as placeholders so the future provider work has names to
 * target; no code selects them yet.
 */

/** Known plan identifiers. `free` is the only one reachable in this phase. */
const PLANS = Object.freeze({
  FREE: 'free',
  // Placeholders, declared for the future payment work (spec §27, decisions
  // §17). Nothing grants or accepts them yet.
  PREMIUM: 'premium',
  PREMIUM_PLUS: 'premium_plus'
});

/** Every plan id, for schema enums and validators. */
const PLAN_VALUES = Object.freeze(Object.values(PLANS));

/**
 * Subscription statuses (spec §26). `expired` and `cancelled` are future-facing:
 * the sweep can only ever transition rows that carry a non-null `expiresAt`,
 * and the free entitlement never carries one (decisions §11).
 */
const SUBSCRIPTION_STATUSES = Object.freeze({
  ACTIVE: 'active',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled'
});

/** Status values, for enums. */
const SUBSCRIPTION_STATUS_VALUES = Object.freeze(Object.values(SUBSCRIPTION_STATUSES));

/**
 * Where an entitlement came from (spec §26).
 *
 * `free_trial` is retained **for schema compatibility only** (decisions §11) —
 * it does not mean the current free entitlement will ever expire. The provider
 * names are placeholders whose webhooks will call `entitlementService.grant()`
 * when payments are actually added (spec §87, §88, §89).
 */
const SUBSCRIPTION_SOURCES = Object.freeze({
  FREE_TRIAL: 'free_trial',
  RAZORPAY: 'razorpay',
  GOOGLE_PLAY: 'google_play'
});

/** Source values, for enums. */
const SUBSCRIPTION_SOURCE_VALUES = Object.freeze(Object.values(SUBSCRIPTION_SOURCES));

module.exports = {
  PLANS,
  PLAN_VALUES,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_STATUS_VALUES,
  SUBSCRIPTION_SOURCES,
  SUBSCRIPTION_SOURCE_VALUES
};
