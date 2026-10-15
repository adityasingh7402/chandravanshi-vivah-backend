'use strict';

/**
 * Subscription routes (spec §26, §32, §86, §89; step 15 API surface).
 *
 *   GET /subscription   the caller's effective entitlement
 *
 * This is the **entire** public surface of this step. The provider endpoints
 * listed in spec §32 (`/subscription/razorpay/order`, a Razorpay webhook,
 * `/subscription/google-play/verify`) are deliberately absent: no payment code
 * exists in this phase (spec §89), so those paths answer 404 — which the audit
 * checks explicitly (gate G3.3). Adding any of them is a future, explicitly
 * product-driven step, not a configuration change.
 *
 * Authentication is mandatory and the account is the session's own; the strict
 * empty query schema means `?plan=`, `?userId=` and every other attempt to
 * influence the answer is a 400 before the service runs (spec §44).
 */

const express = require('express');
const controller = require('../controllers/subscription.controller');
const { subscriptionQuerySchema } = require('../validators/subscription.validators');
const { validateQuery } = require('../validators/validate');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, validateQuery(subscriptionQuerySchema), controller.get);

module.exports = router;
