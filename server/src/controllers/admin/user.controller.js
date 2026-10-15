'use strict';

/**
 * Admin user controller (spec §28, §30, §44; step 16 API surface).
 *
 *   GET   /admin/users                       search, safe projection
 *   GET   /admin/users/:userId               account + profile summary
 *   PATCH /admin/users/:userId/status        suspend / reactivate / deactivate (admin)
 *   PATCH /admin/profiles/:profileId/status  hide / restore / deactivate (admin, moderator)
 *
 * The actor is always `req.auth.userId` — the session's own account, resolved
 * by `requireAuth` from the presented token (spec §31, §44). No body or query
 * field can name the actor; the strict validators make that structural rather
 * than a convention (gate G3.8).
 */

const adminUserService = require('../../services/adminUserService');
const { ok } = require('../../utils/apiResponse');

/** GET /api/v1/admin/users — bounded search with a safe projection. */
async function list(req, res) {
  const result = await adminUserService.search(req.validatedQuery);
  return ok(res, result, 'OK');
}

/** GET /api/v1/admin/users/:userId — one account with its profile summary. */
async function get(req, res) {
  const result = await adminUserService.get(req.params.userId);
  return ok(res, result, 'OK');
}

/** PATCH /api/v1/admin/users/:userId/status — suspend / reactivate / deactivate. */
async function setStatus(req, res) {
  const { status, reason } = req.body;
  const actorUserId = req.auth.userId;
  const { userId } = req.params;

  let result;
  if (status === 'suspended') result = await adminUserService.suspend(actorUserId, userId, reason);
  else if (status === 'active') result = await adminUserService.reactivate(actorUserId, userId);
  else result = await adminUserService.deactivate(actorUserId, userId, reason);

  return ok(res, result, 'Account status updated.');
}

/** PATCH /api/v1/admin/profiles/:profileId/status — hide / restore / deactivate. */
async function setProfileStatus(req, res) {
  const result = await adminUserService.setProfileStatus(req.auth.userId, req.params.profileId, req.body);
  return ok(res, result, 'Profile status updated.');
}

module.exports = { list, get, setStatus, setProfileStatus };
