'use strict';

/**
 * Entitlement service (spec §26, §86, §87, §88, §89, §114; finalized decisions
 * §11, §12, §22; step 15 tasks 5, 6, 8, 9).
 *
 * **The single access-control point.** Everything in the application that could
 * one day care about a plan asks this module a *feature* question —
 * `hasFeatureAccess(userId, "send_interest")` — and never inspects a
 * subscription row, a plan name, or a payment provider (spec §86). The plan →
 * feature mapping lives in `constants/features.js`; the record lives in
 * `subscriptionService`.
 *
 * Current phase — indefinite free access (decisions §11, §12, §22):
 *
 *   - Every active account has `plan: "free"` with `expiresAt: null`; nothing
 *     expires it, and the sweep below cannot even match such a row.
 *   - `hasFeatureAccess()` returns **true for every implemented feature**. No
 *     call site gates on it yet; the point of building the gate now is that
 *     monetisation later changes one map instead of hunting call sites.
 *
 * ## Provider seam (task 8) — no provider code exists in this phase
 *
 * When payments are introduced (spec §27, §87, §88, §89; decisions §17), a
 * webhook handler will verify the provider signature and then call
 * {@link grant} with the purchased `plan`, the provider's `source` id from
 * `constants/plans.js` and the provider's period end as `expiresAt`.
 * Nothing else changes: the rest of the application keeps asking
 * about features, and `subscriptionService.createFreeTrial()` keeps granting
 * the free plan to new accounts. There is deliberately **no route, no checkout,
 * no webhook and no provider credential** in this step — the collection
 * `payment_transactions` is reserved as future-only in
 * `config/collections.js` and is never created (spec §127).
 */

const Subscription = require('../models/Subscription');
const subscriptionService = require('./subscriptionService');
const { logger } = require('../middleware/requestLogger');
const { featuresForPlan, isKnownFeature, FEATURE_VALUES } = require('../constants/features');
const { SUBSCRIPTION_STATUSES } = require('../constants/plans');

/**
 * The caller's effective entitlement, ready for a response or a decision
 * (task 5). One indexed lookup resolves both the record and its feature set —
 * never a query per feature (gate G4.2).
 *
 * @param {string} userId account id, always `req.auth.userId` on a request path
 * @returns {Promise<{ subscription: object, plan: string, status: string, features: readonly string[] } | null>}
 */
async function get(userId) {
  const subscription = await subscriptionService.getActiveForUser(userId);
  if (!subscription) return null;
  return {
    subscription,
    plan: subscription.plan,
    status: subscription.status,
    features: featuresForPlan(subscription.plan)
  };
}

/**
 * Does this account hold an active, unexpired entitlement? (task 5)
 *
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function hasEntitlement(userId) {
  return (await subscriptionService.getActiveForUser(userId)) !== null;
}

/**
 * The one gate the rest of the application uses (tasks 5, 9).
 *
 * Fails closed on every uncertain input: no active entitlement, an unknown
 * plan, or a feature key that is not declared in `constants/features.js` all
 * answer `false` (and say why through {@link explain}). A typo in a call site
 * must deny, not accidentally grant.
 *
 * In the current phase this returns `true` for every declared feature while the
 * account is active — nothing is gated (decisions §12).
 *
 * @param {string} userId
 * @param {string} featureKey one of `constants/features.FEATURES`
 * @returns {Promise<boolean>}
 */
async function hasFeatureAccess(userId, featureKey) {
  return (await explain(userId, featureKey)).allowed;
}

/**
 * `hasFeatureAccess` with the reason, for logging and tests (task 5's
 * "boolean plus a reason for logging").
 *
 * Exactly one subscription lookup happens per call, whatever the feature count
 * (gate G4.2).
 *
 * @param {string} userId
 * @param {string} featureKey
 * @returns {Promise<{ allowed: boolean, reason: string, plan: string|null }>}
 */
async function explain(userId, featureKey) {
  const subscription = await subscriptionService.getActiveForUser(userId);
  if (!subscription) {
    return { allowed: false, reason: 'no_active_entitlement', plan: null };
  }
  if (!isKnownFeature(featureKey)) {
    // A caller asked about something that does not exist: deny loudly so the
    // typo is visible in the logs, but never throw on a boolean gate.
    logger.warn({ featureKey }, 'feature access checked for an unknown feature key');
    return { allowed: false, reason: 'unknown_feature', plan: subscription.plan };
  }
  const features = featuresForPlan(subscription.plan);
  if (!features.includes(featureKey)) {
    return { allowed: false, reason: 'not_in_plan', plan: subscription.plan };
  }
  return { allowed: true, reason: 'granted', plan: subscription.plan };
}

/**
 * Retire subscriptions whose paid period has ended (task 6).
 *
 * The filter is the entire policy: `status: "active"` **and** a non-null,
 * past-due `expiresAt`. The free entitlement (`expiresAt: null`, decisions §11,
 * §22) therefore cannot be matched even if someone called this on every boot —
 * there is no automatic `active → expired` transition for the free plan, and no
 * code may expire a row that has `expiresAt: null`.
 *
 * The query is served by the `{ status, expiresAt }` index (gate G4.3). The
 * count is logged; failures propagate to the caller (a future billing job),
 * never crash a request path — nothing in the current phase calls this
 * automatically, because nothing can be expirable yet.
 *
 * @param {{ now?: Date }} [options]
 * @returns {Promise<{ expired: number }>}
 */
async function expirePastDue({ now = new Date() } = {}) {
  const result = await Subscription.updateMany(
    {
      status: SUBSCRIPTION_STATUSES.ACTIVE,
      expiresAt: { $ne: null, $lte: now }
    },
    { $set: { status: SUBSCRIPTION_STATUSES.EXPIRED } }
  );
  if (result.modifiedCount > 0) {
    logger.info({ expired: result.modifiedCount }, 'subscription expiry sweep retired past-due rows');
  }
  return { expired: result.modifiedCount };
}

/**
 * Grant or update an entitlement — the documented provider seam (task 8).
 *
 * There is **no caller in this phase**. A future provider webhook will call
 * this after verifying the provider's signature; it is implemented now so that
 * the seam is a real, testable shape rather than a comment. It updates the
 * user's single active row in place when one exists (the partial unique index
 * guarantees there is at most one), which is what keeps "one active
 * entitlement per user" true across a plan change; it never touches history
 * rows and never deletes anything.
 *
 * @param {object} input
 * @param {string} input.userId
 * @param {string} input.plan one of `constants/plans.PLANS`
 * @param {string} [input.source] one of `constants/plans.SUBSCRIPTION_SOURCES`
 * @param {Date} [input.startedAt]
 * @param {Date|null} [input.expiresAt]
 * @returns {Promise<{ subscription: object }>}
 */
async function grant({ userId, plan, source = null, startedAt = new Date(), expiresAt = null }) {
  const now = new Date();
  const filter = { userId, status: SUBSCRIPTION_STATUSES.ACTIVE };

  // `$set` applies on both paths — including to the document an upsert
  // inserts — so `expiresAt` lives there alone. A field may not appear in both
  // `$set` and `$setOnInsert` (MongoDB rejects the conflicting update), which
  // is why the nullable field is not repeated below. `source` is set only when
  // provided; a grant that omits it must not blank an existing provider id.
  const set = { plan, expiresAt, updatedAt: now };
  if (source) set.source = source;
  const update = {
    $set: set,
    $setOnInsert: { userId, status: SUBSCRIPTION_STATUSES.ACTIVE, startedAt, createdAt: now }
  };

  await Subscription.updateOne(filter, update, { upsert: true, timestamps: false });
  const subscription = await Subscription.findOne(filter).lean();
  return { subscription };
}

module.exports = {
  get,
  hasEntitlement,
  hasFeatureAccess,
  explain,
  expirePastDue,
  grant,
  // Re-exported for call sites that only need the vocabulary.
  FEATURE_VALUES
};
