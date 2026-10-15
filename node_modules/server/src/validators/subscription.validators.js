'use strict';

/**
 * Subscription request validation (spec §26, §31, §44; step 15 task 7).
 *
 * `GET /subscription` takes **no input at all**: the account is always
 * `req.auth.userId`, and a plan, source, feature or period can never be
 * supplied by a client (spec §31, §44). Declaring the empty strict query schema
 * is what makes that structural — `?plan=premium` is a 400, not a query the
 * route silently ignores and a client might believe it set (gate G3.1).
 */

const { z } = require('zod');

/** Query of `GET /subscription` — intentionally empty and strict. */
const subscriptionQuerySchema = z.object({}).strict();

module.exports = { subscriptionQuerySchema };
