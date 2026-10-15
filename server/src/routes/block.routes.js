'use strict';

/**
 * Block routes (spec §22, §32, §36; step 12 API surface).
 *
 *   POST   /blocks             block an account (`userId` or `publicProfileId`)
 *   GET    /blocks             the caller's own block list
 *   DELETE /blocks/:userId     unblock (an account id or a public profile id)
 *
 * All three require authentication and the actor is always the session's account
 * (spec §44). Every input is validated before the service runs, so a body that
 * tried to name the blocker, or to attach an unknown field, is a 400 (spec §34).
 *
 * The write routes are rate limited per account (spec §36): blocking is an
 * harassment vector, and a scripted block/unblock loop is the same vector, so
 * both directions share one bucket.
 */

const express = require('express');
const config = require('../config/env');
const controller = require('../controllers/block.controller');
const {
  blockCreateSchema,
  blockTargetParamSchema,
  blockListQuerySchema,
  validateQuery
} = require('../validators/safety.validators');
const { validateBody, validateParams } = require('../validators/validate');
const { requireAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const blockLimiter = createRateLimiter({
  name: 'blocks',
  windowSeconds: config.safety.blockRateLimit.windowSeconds,
  limit: config.safety.blockRateLimit.max,
  keyGenerator: (req) => (req.auth ? req.auth.userId : 'anonymous'),
  validate: { keyGeneratorIpFallback: false }
});

router.post('/', requireAuth, blockLimiter, validateBody(blockCreateSchema), controller.create);
router.get('/', requireAuth, validateQuery(blockListQuerySchema), controller.list);
router.delete('/:userId', requireAuth, blockLimiter, validateParams(blockTargetParamSchema), controller.remove);

module.exports = router;
