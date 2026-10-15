'use strict';

/**
 * Partner-preference routes (spec §16, §72; step 07 task 8).
 *
 * Mounted at `<API_PREFIX>/preferences`. Every route is authenticated and acts
 * on the caller's own document only — there is deliberately no `/:userId` or
 * `/:publicProfileId` variant, so no route can even be asked for another
 * account's preferences (gate G3.2).
 */

const express = require('express');
const controller = require('../controllers/preference.controller');
const { validateBody, preferenceCreateSchema, preferencePatchSchema } = require('../validators/preference.validators');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, controller.getOwn);
router.post('/', requireAuth, validateBody(preferenceCreateSchema), controller.create);
router.patch('/', requireAuth, validateBody(preferencePatchSchema), controller.update);

module.exports = router;
