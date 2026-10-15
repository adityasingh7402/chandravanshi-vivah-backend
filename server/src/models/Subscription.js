'use strict';

/**
 * `subscriptions` model (spec §26, §105, §114; finalized decisions §11, §22;
 * step 15 task 1).
 *
 * The document is spec §26's exactly: the owner, the plan, a status, the
 * source, and the two dates. Its whole purpose is that **no matrimonial logic
 * reads it directly** — every access question goes through
 * `entitlementService`, which maps the plan to a feature set (spec §86) —
 * so the shape here stays deliberately small and provider-agnostic.
 *
 * Current phase (decisions §11, §22): every account receives
 * `{ plan: "free", status: "active", source: "free_trial", startedAt: <when>,
 * expiresAt: null }` and **nothing ever expires it**. `source: "free_trial"` is
 * schema compatibility, not a countdown.
 *
 * Indexes (spec §105):
 *   (1) `{ userId: 1, status: 1 }`     — resolve the user's active entitlement.
 *   (2) `{ status: 1, expiresAt: 1 }`  — the future expiry sweep, which only
 *       ever matches rows with a non-null past-due `expiresAt`. The free
 *       entitlement (`expiresAt: null`) can never appear in this index's result,
 *       which is what implements "free access does not expire" at the data
 *       layer as well as in the sweep's filter.
 *   (3) `{ userId: 1 }` **partial unique** where `status: "active"` — one active
 *       entitlement per user, enforced by the database. History
 *       (`expired`/`cancelled`) is unconstrained, so a row can be retired and a
 *       new one granted without ever deleting anything (spec §98's spirit).
 */

const mongoose = require('mongoose');
const { baseSchema } = require('./plugins/baseSchema');
const { COLLECTIONS } = require('../config/collections');
const { PLAN_VALUES, SUBSCRIPTION_STATUS_VALUES, SUBSCRIPTION_SOURCE_VALUES } = require('../constants/plans');

const { ObjectId } = mongoose.Schema.Types;

const subscriptionSchema = new mongoose.Schema(
  {
    // The owner. Server-derived from `req.auth.userId` or the registration hook
    // — never a client-supplied value (spec §44).
    userId: { type: ObjectId, ref: 'User', required: true },
    // A known plan id. The enum is `constants/plans.js`, so adding a plan is a
    // constants change, not a migration.
    plan: { type: String, required: true, enum: { values: PLAN_VALUES, message: 'Unknown plan.' } },
    // active | expired | cancelled (spec §26).
    status: {
      type: String,
      required: true,
      enum: { values: SUBSCRIPTION_STATUS_VALUES, message: 'Unknown subscription status.' }
    },
    // free_trial | razorpay | google_play (spec §26). Descriptive only: no code
    // branches on it (spec §86, gate G3.5).
    source: {
      type: String,
      required: true,
      enum: { values: SUBSCRIPTION_SOURCE_VALUES, message: 'Unknown subscription source.' }
    },
    // When this entitlement began. For the free plan this is registration time.
    startedAt: { type: Date, required: true },
    // null = never expires. The current free plan uses null and the sweep skips
    // it entirely (decisions §11, §22).
    expiresAt: { type: Date, default: null }
  },
  { collection: COLLECTIONS.SUBSCRIPTIONS }
);

subscriptionSchema.plugin(baseSchema);

// Spec §105 index checklist.
//
// (1) "What is this user's active entitlement?" — the one lookup every access
//     check makes.
subscriptionSchema.index({ userId: 1, status: 1 });
// (2) The expiry sweep. Only rows with a real past-due date can match, so a
//     free row (expiresAt: null) is untouchable by construction.
subscriptionSchema.index({ status: 1, expiresAt: 1 });
// (3) One active entitlement per user, enforced by the database rather than a
//     read-then-write in the service, so a retried registration hook or two
//     concurrent grants can never leave two active rows.
subscriptionSchema.index(
  { userId: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } }
);

const Subscription = mongoose.models.Subscription || mongoose.model('Subscription', subscriptionSchema);

module.exports = Subscription;
