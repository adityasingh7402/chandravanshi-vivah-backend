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
//
// It does NOT share the login budget: a signed-in browser presents the cookie
// on every page load and every new tab, which is normal traffic rather than a
// guess. Its own window is deliberately wider, and successful rotations are not
// counted at all (`skipSuccessfulRequests`), so only a rejected token can ever
// exhaust it. Sharing the 10-per-15-minutes login limit meant an ordinary
// reload was answered 429 and the client — which reads any non-2xx refresh as
// "no session" — sent the member back to sign-in.
router.post(
  '/refresh',
  createRateLimiter({
    name: 'auth-refresh',
    windowSeconds: config.auth.rateLimit.refreshWindowSeconds,
    limit: config.auth.rateLimit.refreshMax,
    skipSuccessfulRequests: true
  }),
  validateBody(refreshSchema),
  controller.refresh
);

router.post('/logout', requireAuth, controller.logout);
router.get('/me', requireAuth, controller.me);

module.exports = router;
