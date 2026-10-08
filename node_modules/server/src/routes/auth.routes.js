'use strict';

/**
 * Authentication routes (spec §36, §117).
 *
 * Mounted at `<API_PREFIX>/auth`. Each route carries its own limiter, tighter
 * than the global one and with a separate bucket, so login brute-force attempts
 * cannot consume the register budget and vice versa (spec §36).
 */

const express = require('express');
const config = require('../config/env');
const controller = require('../controllers/auth.controller');
const { validateBody, registerSchema, loginSchema, changePasswordSchema } = require('../validators/auth.validators');
const { createRateLimiter } = require('../middleware/rateLimit');
const { requireAuth } = require('../middleware/auth');

const authLimit = {
  windowSeconds: config.auth.rateLimit.windowSeconds,
  limit: config.auth.rateLimit.max
};

const router = express.Router();

router.post('/register', createRateLimiter({ name: 'auth-register', ...authLimit }), validateBody(registerSchema), controller.register);
router.post('/login', createRateLimiter({ name: 'auth-login', ...authLimit }), validateBody(loginSchema), controller.login);
// Requires a valid access token first, then validates the body (step 04 task 14).
router.post(
  '/change-password',
  createRateLimiter({ name: 'auth-change-password', ...authLimit }),
  requireAuth,
  validateBody(changePasswordSchema),
  controller.changePassword
);

module.exports = router;
