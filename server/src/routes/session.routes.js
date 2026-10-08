'use strict';

/**
 * Session routes (spec §7, §36).
 *
 * Mounted alongside the auth routes under `<API_PREFIX>/auth`. Refresh is public
 * (it authenticates with the refresh token itself); logout and me require a
 * valid access token (step 04 task 14).
 */

const express = require('express');
const config = require('../config/env');
const controller = require('../controllers/session.controller');
const { validateBody, refreshSchema } = require('../validators/auth.validators');
const { requireAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

// Refresh is rate limited: it is a credential-accepting endpoint (spec §36).
router.post(
  '/refresh',
  createRateLimiter({
    name: 'auth-refresh',
    windowSeconds: config.auth.rateLimit.windowSeconds,
    limit: config.auth.rateLimit.max
  }),
  validateBody(refreshSchema),
  controller.refresh
);

router.post('/logout', requireAuth, controller.logout);
router.get('/me', requireAuth, controller.me);

module.exports = router;
