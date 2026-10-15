'use strict';

/**
 * Interaction routes (spec §20, §32, §36; step 10 API surface).
 *
 *   POST   /interactions                 record a view / like / shortlist / pass
 *   GET    /interactions                 the caller's own actions, as cards
 *   DELETE /interactions/:interactionId  remove one of the caller's actions
 *
 * All three require authentication: actions are a signed-in surface, and the
 * actor is always the session's account (spec §44). Every input is validated
 * before the service runs: an unknown field or an object-shaped value is a 400,
 * not a filter (spec §34).
 *
 * The write route carries a rate limiter **keyed by (account, action type)**, so
 * a scripted like-burst cannot consume the view budget and vice versa
 * (spec §36). It runs after `requireAuth` so the key is the real account, and the
 * library's IP-fallback validation is switched off because keying by account is
 * deliberate and stronger than keying by address.
 */

const express = require('express');
const config = require('../config/env');
const controller = require('../controllers/action.controller');
const {
  actionCreateSchema,
  actionListQuerySchema,
  interactionIdParamSchema,
  validateQuery
} = require('../validators/action.validators');
const { validateBody, validateParams } = require('../validators/validate');
const { requireAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const actionLimiter = createRateLimiter({
  name: 'interactions',
  windowSeconds: config.actions.rateLimit.windowSeconds,
  limit: config.actions.rateLimit.max,
  keyGenerator: (req) => `${req.auth ? req.auth.userId : 'anonymous'}:${(req.body && req.body.type) || 'unknown'}`,
  validate: { keyGeneratorIpFallback: false }
});

router.post('/', requireAuth, actionLimiter, validateBody(actionCreateSchema), controller.record);
router.get('/', requireAuth, validateQuery(actionListQuerySchema), controller.list);
router.delete('/:interactionId', requireAuth, validateParams(interactionIdParamSchema), controller.remove);

module.exports = router;
