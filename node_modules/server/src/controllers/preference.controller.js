'use strict';

/**
 * Partner-preference controller (spec §30, §44, §72, §118; step 07 task 8).
 *
 * Request/response only. Every call passes `req.auth.userId` — resolved by
 * `requireAuth` from the presented credential — so the resource is always the
 * caller's own (spec §72). A `userId` in a body never reaches the service.
 *
 * There is no other user's preference route at all: preferences are private to
 * the owner (spec §112), so no public read path exists to secure (gate G3.2).
 */

const preferenceService = require('../services/preferenceService');
const { ok } = require('../utils/apiResponse');
const { HTTP_STATUS } = require('../config/constants');

/** GET /api/v1/preferences — 200 with `null` before the user has saved any. */
async function getOwn(req, res) {
  const preference = await preferenceService.getOwn(req.auth.userId);
  return ok(res, { preferences: await preferenceService.serialize(preference) }, 'OK');
}

/** POST /api/v1/preferences — creates the caller's preferences (partial allowed). */
async function create(req, res) {
  const preference = await preferenceService.create(req.auth.userId, req.body);
  return ok(
    res,
    { preferences: await preferenceService.serialize(preference) },
    'Preferences created.',
    HTTP_STATUS.CREATED
  );
}

/** PATCH /api/v1/preferences — partial update of the caller's own document. */
async function update(req, res) {
  const preference = await preferenceService.update(req.auth.userId, req.body);
  return ok(res, { preferences: await preferenceService.serialize(preference) }, 'Preferences updated.');
}

module.exports = { getOwn, create, update };
