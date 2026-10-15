'use strict';

/**
 * Feature keys and the plan → feature map (spec §86, §114; finalized decisions
 * §12; step 15 tasks 2, 9).
 *
 * This is the **single access-control vocabulary** for the application. Nothing
 * outside `entitlementService` may ask "did they pay through provider X?" — the
 * question is always "does this user have feature F?" (spec §86).
 *
 * FINAL — no premium restrictions in the current phase (decisions §12). The
 * keys exist so the access-control point is centralised *before* monetisation,
 * and the free plan grants **every** one of them. No call site may gate a
 * feature today: `hasFeatureAccess()` returns true for all of these on an
 * active account. When payments are introduced, the paid feature sets and any
 * limits are defined together at that time — never preemptively blocking an
 * existing feature and never changing an existing free user's access as a side
 * effect of adding payment code.
 */

/** The feature keys other steps ask about. */
const FEATURES = Object.freeze({
  SEND_INTEREST: 'send_interest',
  VIEW_CONTACT_DETAILS: 'view_contact_details',
  ADVANCED_SEARCH: 'advanced_search',
  SEE_WHO_VIEWED: 'see_who_viewed',
  UNLIMITED_CHAT: 'unlimited_chat'
});

/** Every feature key, for validation and iteration. */
const FEATURE_VALUES = Object.freeze(Object.values(FEATURES));

/**
 * Plan → granted feature set.
 *
 * Free grants everything implemented today (decisions §12). The placeholder
 * plans intentionally grant the *same* set: monetisation is not designed yet,
 * and inventing a difference here would gate features that must stay free.
 */
const PLAN_FEATURES = Object.freeze({
  free: FEATURE_VALUES,
  premium: FEATURE_VALUES,
  premium_plus: FEATURE_VALUES
});

/**
 * The feature set granted by one plan.
 *
 * An unknown plan grants nothing rather than throwing: a future row written by
 * a provider must not crash the read path, and a plan the code does not know
 * cannot be trusted to carry access.
 *
 * @param {string} plan
 * @returns {readonly string[]}
 */
function featuresForPlan(plan) {
  return PLAN_FEATURES[plan] ?? [];
}

/** Is `featureKey` a declared feature at all? A typo must fail closed. */
function isKnownFeature(featureKey) {
  return FEATURE_VALUES.includes(featureKey);
}

module.exports = { FEATURES, FEATURE_VALUES, PLAN_FEATURES, featuresForPlan, isKnownFeature };
