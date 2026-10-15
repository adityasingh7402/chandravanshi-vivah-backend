'use strict';

/**
 * Kundli controller (finalized decisions §6; spec §72, §112; step 08 task 12).
 *
 * Request/response only, and owner-scoped: `req.params.kundliId` is always
 * looked up together with `req.auth.userId`, so another account's document is
 * a 404 (spec §44).
 */

const kundliService = require('../services/kundliService');
const { ok } = require('../utils/apiResponse');
const { HTTP_STATUS } = require('../config/constants');

/** GET /api/v1/kundli — metadata plus a short-lived signed URL, or `null`. */
async function get(req, res) {
  const document = await kundliService.getOwn(req.auth.userId);
  return ok(res, { kundli: await kundliService.serialize(document) }, 'OK');
}

/** POST /api/v1/kundli — register a verified upload (private + pending). */
async function create(req, res) {
  const document = await kundliService.create(req.auth.userId, req.body);
  return ok(res, { kundli: await kundliService.serialize(document) }, 'Kundli document added.', HTTP_STATUS.CREATED);
}

/** PATCH /api/v1/kundli/:kundliId — `private | matches_only` only. */
async function update(req, res) {
  const document = await kundliService.updateVisibility(req.auth.userId, req.params.kundliId, req.body.visibility);
  return ok(res, { kundli: await kundliService.serialize(document) }, 'Kundli document updated.');
}

/** DELETE /api/v1/kundli/:kundliId — asset first, then the reference. */
async function remove(req, res) {
  await kundliService.remove(req.auth.userId, req.params.kundliId);
  return ok(res, { kundli: { id: String(req.params.kundliId), deleted: true } }, 'Kundli document deleted.');
}

module.exports = { get, create, update, remove };
