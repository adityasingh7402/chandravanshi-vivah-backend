'use strict';

/**
 * Profile controller (spec §30, §72, §94, §95, §118; step 06 task 10).
 *
 * Request/response only. Every call passes `req.auth.userId` — resolved by
 * `requireAuth` from the presented credential — so the resource is always the
 * caller's own (spec §72). A `userId` in a body never reaches the service.
 *
 * The response body is always one of the three DTOs, never the raw document
 * (spec §30, §59).
 */

const profileService = require('../services/profileService');
const serializer = require('../services/profileSerializer');
const { ok } = require('../utils/apiResponse');
const { HTTP_STATUS } = require('../config/constants');

/** GET /api/v1/profile/me — the own DTO. 200 with `null` before onboarding. */
async function getMe(req, res) {
  const profile = await profileService.getOwn(req.auth.userId);
  return ok(res, { profile: profile ? serializer.ownProfile(profile) : null }, 'OK');
}

/** POST /api/v1/profile — creates a draft (spec §118). */
async function create(req, res) {
  const profile = await profileService.create(req.auth.userId, req.body);
  return ok(res, { profile: serializer.ownProfile(profile) }, 'Profile created.', HTTP_STATUS.CREATED);
}

/** PATCH /api/v1/profile — partial update of the caller's own document. */
async function update(req, res) {
  const profile = await profileService.update(req.auth.userId, req.body);
  return ok(res, { profile: serializer.ownProfile(profile) }, 'Profile updated.');
}

/** DELETE /api/v1/profile — permanently deletes the profile and owned records. */
async function remove(req, res) {
  const profile = await profileService.hardDelete(req.auth.userId);
  return ok(res, { profile: { publicProfileId: profile.publicProfileId } }, 'Profile deleted.');
}

/**
 * GET /api/v1/profile/:publicProfileId — another user's permitted view.
 * 404 for an unknown id AND for any profile that is not `active` (spec §58).
 */
async function getPublic(req, res) {
  // The viewer is passed in because photo visibility is relationship-aware:
  // `private` and `matches_only` photos are absent for a non-match viewer
  // (spec §112; step 08 gate G3.6).
  const result = await profileService.getPublic(req.params.publicProfileId, {
    viewerId: req.auth.userId
  });
  if (!result) {
    const { NotFoundError } = require('../utils/AppError');
    throw new NotFoundError('The requested resource does not exist.');
  }
  return ok(res, { profile: serializer.publicProfile(result.profile, { photos: result.photos }) }, 'OK');
}

module.exports = { getMe, create, update, remove, getPublic };
