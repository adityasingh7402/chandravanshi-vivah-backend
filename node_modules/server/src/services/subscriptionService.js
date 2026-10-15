'use strict';

/**
 * Subscription service (spec §26; finalized decisions §11, §12, §22; step 15
 * tasks 3, 4).
 *
 * The only module that writes `subscriptions` rows in this phase, and the only
 * one that reads them by identity. Access decisions belong to
 * `entitlementService` — this layer owns the *record*:
 *
 *   createFreeTrial(userId)   the grant every new account receives
 *   getActiveForUser(userId)  the one lookup an access check makes
 *   ensureExists(userId)      legacy-account self-healing for the read path
 *
 * **Idempotency is a database rule, not a service convention.** The model's
 * partial unique index allows exactly one `status: "active"` row per user; the
 * upsert below therefore cannot create a second one, and a concurrent retry
 * that loses the race catches `E11000` and re-reads instead of 500-ing. A
 * retried registration hook, a duplicated webhook in a future phase, or two
 * concurrent requests can all call this safely.
 */

const Subscription = require('../models/Subscription');
const config = require('../config/env');
const { logger } = require('../middleware/requestLogger');
const { BadRequestError } = require('../utils/AppError');
const {
  PLAN_VALUES,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_SOURCES
} = require('../constants/plans');

/** True when the driver reports a duplicate-key violation. */
function isDuplicateKey(err) {
  return Boolean(err && (err.code === 11000 || err.code === 11001));
}

/**
 * Grant the indefinite free entitlement to an account (task 3).
 *
 * Creates `{ plan: <DEFAULT_FREE_PLAN>, status: "active", source: "free_trial",
 * startedAt: now, expiresAt: null }` — **no expiry date is computed**, because
 * the free plan never expires (decisions §11, §22). `FREE_TRIAL_DAYS` is not
 * consulted anywhere in this function.
 *
 * `$setOnInsert` is deliberate: if an active row already exists (including one
 * a future provider granted), it is left exactly as it is — a registration
 * retry must not downgrade a paid plan back to free or re-date a row. The
 * driver-level `timestamps: false` keeps a no-op update from touching
 * `updatedAt`.
 *
 * @param {string} userId account id, server-derived (spec §44)
 * @returns {Promise<{ subscription: object, created: boolean }>}
 */
async function createFreeTrial(userId) {
  const now = new Date();
  const filter = { userId, status: SUBSCRIPTION_STATUSES.ACTIVE };

  const insert = {
    userId,
    plan: config.subscription.defaultFreePlan,
    status: SUBSCRIPTION_STATUSES.ACTIVE,
    source: SUBSCRIPTION_SOURCES.FREE_TRIAL,
    startedAt: now,
    // null = never expires. The sweep cannot match this row (decisions §11).
    expiresAt: null,
    createdAt: now,
    updatedAt: now
  };

  let created = false;
  try {
    const result = await Subscription.updateOne(filter, { $setOnInsert: insert }, { upsert: true, timestamps: false });
    created = result.upsertedCount > 0;
  } catch (err) {
    // Two concurrent upserts against the partial unique index: one wins, the
    // loser lands here. Re-reading below returns the winner's row.
    if (!isDuplicateKey(err)) throw err;
  }

  const subscription = await Subscription.findOne(filter).lean();
  if (!subscription) {
    // The only way here is a duplicate-key loss whose opposite insert was
    // itself rolled back; surface it rather than returning a phantom grant.
    throw new BadRequestError('Could not resolve the account entitlement.', { details: { entitlement: 'Retry.' } });
  }
  return { subscription, created };
}

/**
 * The effective active entitlement for an account (steps 5, 7).
 *
 * "Effective" is deliberate: a row is only returned when its status is active
 * **and** it is not past due (`expiresAt: null` or in the future). The lazy
 * expiry sweep records the transition, but access must not depend on the sweep
 * having run — the same derived-gate discipline steps 10–13 use. In the current
 * phase every row has `expiresAt: null`, so this is simply the free grant.
 *
 * @param {string} userId
 * @returns {Promise<object|null>} lean row or null
 */
async function getActiveForUser(userId) {
  return Subscription.findOne({
    userId,
    status: SUBSCRIPTION_STATUSES.ACTIVE,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
  }).lean();
}

/**
 * Ensure a legacy account has an entitlement (task 4).
 *
 * Accounts created before this step — or any account whose registration hook
 * failed mid-flight — are healed on first read, so the documented migration is
 * a backfill convenience rather than a correctness dependency. The check is
 * `exists`, not "active row missing": an account whose rows are all
 * `expired`/`cancelled` kept its history and must **not** silently be granted a
 * fresh free plan (that is a product decision for a future phase).
 *
 * @param {string} userId
 * @returns {Promise<{ subscription: object|null, created: boolean }>}
 */
async function ensureExists(userId) {
  const any = await Subscription.exists({ userId });
  if (any) return { subscription: null, created: false };
  logger.info({ userId }, 'granting the free entitlement to an account that had none');
  return createFreeTrial(userId);
}

module.exports = {
  createFreeTrial,
  getActiveForUser,
  ensureExists,
  isDuplicateKey,
  // Re-exported so a future provider module has one import for valid plan ids.
  PLAN_VALUES
};
