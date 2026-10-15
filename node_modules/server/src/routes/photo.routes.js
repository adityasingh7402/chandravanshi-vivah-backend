'use strict';

/**
 * Photo routes (spec §17, §43, §44; step 08 task 11).
 *
 * Mounted at `<API_PREFIX>/photos`. Every route is authenticated: photos are
 * owner-managed, and there is no anonymous listing (command 8 expects 401).
 *
 * `POST /sign` is registered before the collection routes so the literal segment
 * is matched first, and both PATCH routes are distinct paths (`/photos` for the
 * whole order, `/photos/:photoId` for one photo).
 */

const express = require('express');
const controller = require('../controllers/photo.controller');
const { requireAuth } = require('../middleware/auth');
const { validateBody, validateParams } = require('../validators/validate');
const {
  photoCreateSchema,
  photoPatchSchema,
  photoReorderSchema,
  photoIdParamSchema
} = require('../validators/photo.validators');

const router = express.Router();

router.use(requireAuth);

router.get('/', controller.list);
router.post('/sign', controller.sign);
router.post('/', validateBody(photoCreateSchema), controller.create);
router.patch('/', validateBody(photoReorderSchema), controller.reorder);
router.patch('/:photoId', validateParams(photoIdParamSchema), validateBody(photoPatchSchema), controller.update);
router.delete('/:photoId', validateParams(photoIdParamSchema), controller.remove);

module.exports = router;
