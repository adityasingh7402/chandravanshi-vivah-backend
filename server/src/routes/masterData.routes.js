'use strict';

/**
 * Master-data routes (spec §73, §80, §102; step 05 task 5).
 *
 * Mounted at `<API_PREFIX>/master-data`.
 *
 *   GET  /:type          public — list/search (bounded, allowlisted)
 *   GET  /:type/:id      public — single item for label resolution
 *   POST /:type/missing  authenticated — user-contributed option (rate limited)
 *
 * Reads are public on purpose: master data is shared lookup vocabulary, not
 * personal data (spec §64), and both clients need it before sign-in. Writes are
 * authenticated and rate limited. Admin write endpoints belong to step 16.
 */

const express = require('express');
const config = require('../config/env');
const controller = require('../controllers/masterData.controller');
const { validateBody, validateQuery, listQuerySchema, missingBodySchema } = require('../validators/masterData.validators');
const { createRateLimiter } = require('../middleware/rateLimit');
const { requireAuth } = require('../middleware/auth');

// Anti-spam cap for the user-contributed path. The ".missing" path is the one
// authenticated write in this step, so it gets its own, tighter bucket than the
// global limiter (spec §36, gate G3.7).
const MISSING_REQUESTS_PER_WINDOW = 20;

const missingLimit = {
  windowSeconds: config.rateLimit.windowSeconds,
  limit: Math.min(config.rateLimit.max, MISSING_REQUESTS_PER_WINDOW)
};

const router = express.Router();

router.get('/:type', validateQuery(listQuerySchema), controller.list);
router.get('/:type/:id', controller.getOne);
router.post(
  '/:type/missing',
  createRateLimiter({ name: 'master-data-missing', ...missingLimit }),
  requireAuth,
  validateBody(missingBodySchema),
  controller.submitMissing
);

module.exports = router;
