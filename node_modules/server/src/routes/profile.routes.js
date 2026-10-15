'use strict';

/**
 * Profile routes (spec §72, §118; step 06 task 10).
 *
 * Mounted at `<API_PREFIX>/profile`. Every route is authenticated: there is no
 * anonymous profile read, even for a published profile, because discovery is a
 * signed-in surface (spec §58, verification command 7).
 *
 * `/me` is registered before `/:publicProfileId` so the literal segment is
 * matched first.
 */

const express = require('express');
const controller = require('../controllers/profile.controller');
const { validateBody, profileCreateSchema, profilePatchSchema } = require('../validators/profile.validators');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/me', requireAuth, controller.getMe);
router.post('/', requireAuth, validateBody(profileCreateSchema), controller.create);
router.patch('/', requireAuth, validateBody(profilePatchSchema), controller.update);
router.delete('/', requireAuth, controller.remove);
router.get('/:publicProfileId', requireAuth, controller.getPublic);

module.exports = router;
