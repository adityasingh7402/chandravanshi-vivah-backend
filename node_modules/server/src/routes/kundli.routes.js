'use strict';

/**
 * Kundli document routes (finalized decisions §6; spec §112; step 08 task 12).
 *
 * Mounted at `<API_PREFIX>/kundli`. Owner-only and authenticated: a Kundli is
 * never exposed to a non-owner here, and another account's id returns 404
 * (spec §44). A relationship viewer gets access through the connection surface
 * (step 11), not through this router.
 */

const express = require('express');
const controller = require('../controllers/kundli.controller');
const { requireAuth } = require('../middleware/auth');
const { validateBody, validateParams } = require('../validators/validate');
const { kundliCreateSchema, kundliPatchSchema, kundliIdParamSchema } = require('../validators/kundli.validators');

const router = express.Router();

router.use(requireAuth);

router.get('/', controller.get);
router.post('/', validateBody(kundliCreateSchema), controller.create);
router.patch('/:kundliId', validateParams(kundliIdParamSchema), validateBody(kundliPatchSchema), controller.update);
router.delete('/:kundliId', validateParams(kundliIdParamSchema), controller.remove);

module.exports = router;
