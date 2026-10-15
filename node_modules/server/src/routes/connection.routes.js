'use strict';

/**
 * Connection routes (spec §21, §32, §36; step 11 API surface).
 *
 *   POST  /connections                    send an interest
 *   GET   /connections                    the caller's sent/received interests
 *   PATCH /connections/:connectionId      accept / reject / withdraw / close
 *
 * All three require authentication: an interest is a signed-in surface, and the
 * actor is always the session's account (spec §44). Every input is validated
 * before the service runs — an unknown field, a status a client tried to set, or
 * an object-shaped value is a 400 (spec §34, §91).
 *
 * The write routes are rate limited **per account** (spec §36): sending interests
 * is an abuse vector. The limiter runs after `requireAuth` so the key is the real
 * account, and the library's IP-fallback validation is switched off because
 * keying by account is deliberate and stronger than keying by address.
 *
 * Note that `PATCH` is likewise limited: a scripted accept/reject loop is the
 * same abuse vector as a scripted send, so it shares the window.
 */

const express = require('express');
const config = require('../config/env');
const controller = require('../controllers/connection.controller');
const {
  connectionCreateSchema,
  connectionUpdateSchema,
  connectionListQuerySchema,
  connectionIdParamSchema,
  validateQuery
} = require('../validators/connection.validators');
const { validateBody, validateParams } = require('../validators/validate');
const { requireAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const interestLimiter = createRateLimiter({
  name: 'connections',
  windowSeconds: config.connections.rateLimit.windowSeconds,
  limit: config.connections.rateLimit.max,
  keyGenerator: (req) => (req.auth ? req.auth.userId : 'anonymous'),
  validate: { keyGeneratorIpFallback: false }
});

router.post('/', requireAuth, interestLimiter, validateBody(connectionCreateSchema), controller.create);
router.get('/', requireAuth, validateQuery(connectionListQuerySchema), controller.list);
router.patch(
  '/:connectionId',
  requireAuth,
  interestLimiter,
  validateParams(connectionIdParamSchema),
  validateBody(connectionUpdateSchema),
  controller.update
);

module.exports = router;
