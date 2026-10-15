'use strict';

/**
 * Subscription controller (spec §26, §33, §44, §86; step 15 API surface).
 *
 * Request/response only. The account is always `req.auth.userId` — there is no
 * parameter, body or query through which a caller can name someone else's
 * subscription, and all three are refused by the schema before the service runs
 * (spec §44, gate G3.1).
 *
 * The response is the caller's **effective entitlement**: the row's plan,
 * status, source and dates, plus the feature list resolved by
 * `entitlementService` — the same list every access check uses, so a client can
 * render exactly what the backend will enforce without re-deriving it
 * (spec §86).
 */

const entitlementService = require('../services/entitlementService');
const subscriptionService = require('../services/subscriptionService');
const { ok } = require('../utils/apiResponse');

/**
 * A safe projection of one effective entitlement.
 *
 * Named fields only: no `userId` (the caller knows who they are), no internal
 * id, no timestamps beyond the two the spec documents. The feature list is
 * always resolved from the plan's map, never from anything a client sent.
 */
function serializeEntitlement(effective) {
  const { subscription, plan, status, features } = effective;
  return {
    plan,
    status,
    source: subscription.source,
    startedAt: subscription.startedAt,
    // `null` = never expires (the current free plan, decisions §11).
    expiresAt: subscription.expiresAt,
    // Every feature granted by this plan, resolved centrally (decisions §12:
    // the free plan currently grants all of them).
    features: [...features],
    isActive: status === 'active'
  };
}

/**
 * GET /api/v1/subscription — the caller's effective entitlement.
 *
 * Self-healing for accounts that predate this step: when the account has **no
 * subscription row at all**, the free grant is created before answering
 * (idempotent, one indexed existence check on the normal path). An account
 * whose only rows are retired (`expired`/`cancelled`) is *not* re-granted —
 * that would be resurrecting access, which is a product decision for a future
 * phase, so this endpoint reports the situation instead.
 */
async function get(req, res) {
  const userId = req.auth.userId;

  let effective = await entitlementService.get(userId);
  if (!effective) {
    await subscriptionService.ensureExists(userId);
    effective = await entitlementService.get(userId);
  }

  // `ensureExists` only heals a truly row-less account; it cannot heal a
  // retired-only one, so a null here is reported rather than fabricated.
  if (!effective) {
    return ok(res, { entitlement: null, reason: 'no_active_entitlement' }, 'No active entitlement.');
  }
  return ok(res, { entitlement: serializeEntitlement(effective) }, 'OK');
}

module.exports = { get, serializeEntitlement };
