'use strict';

/**
 * Discover / search routes (spec §32, §45, §53, §119; step 09 API surface).
 *
 *   GET /discover         authenticated — preference-driven candidate list
 *   GET /search           authenticated — explicit filters, no preference merge
 *   GET /recommendations  authenticated — deterministically ranked list
 *
 * All three are authenticated: discovery is a signed-in surface, so there is no
 * anonymous candidate list (spec §58, gate G3.6). Every query parameter is
 * allowlisted by `validateQuery`, which is what turns an object-shaped injection
 * attempt into a 400 before any service code runs (spec §34, §35).
 */

const express = require('express');
const controller = require('../controllers/discover.controller');
const { validateQuery } = require('../validators/search.validators');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/discover', requireAuth, validateQuery(), controller.discover);
router.get('/search', requireAuth, validateQuery(), controller.search);
router.get('/recommendations', requireAuth, validateQuery(), controller.recommendations);

module.exports = router;
