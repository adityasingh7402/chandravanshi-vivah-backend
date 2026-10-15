'use strict';

/**
 * Report routes (spec §23, §32, §36; step 12 API surface).
 *
 *   POST /reports       file a report
 *   GET  /reports/me    the caller's own reports
 *
 * Require authentication; the actor is the session's account (spec §44). The
 * admin moderation routes are a separate, protected surface built in step 16 and
 * are deliberately not mounted here (spec §32) — this router exposes no way to
 * read someone else's report or to touch a report's status.
 *
 * Filing is rate limited per account (spec §36): reports are a review-flooding
 * vector.
 */

const express = require('express');
const config = require('../config/env');
const controller = require('../controllers/report.controller');
const { reportCreateSchema, reportListQuerySchema, validateQuery } = require('../validators/safety.validators');
const { validateBody } = require('../validators/validate');
const { requireAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const reportLimiter = createRateLimiter({
  name: 'reports',
  windowSeconds: config.safety.reportRateLimit.windowSeconds,
  limit: config.safety.reportRateLimit.max,
  keyGenerator: (req) => (req.auth ? req.auth.userId : 'anonymous'),
  validate: { keyGeneratorIpFallback: false }
});

router.post('/', requireAuth, reportLimiter, validateBody(reportCreateSchema), controller.create);
router.get('/me', requireAuth, validateQuery(reportListQuerySchema), controller.listMine);

module.exports = router;
