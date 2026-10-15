'use strict';

/**
 * Admin moderation controller (spec §23, §101, §112; step 16 API surface).
 *
 *   GET   /admin/reports                     the moderation queue (admin, moderator)
 *   PATCH /admin/reports/:reportId           reviewing / resolved / dismissed (admin, moderator)
 *   GET   /admin/photos/pending              the photo queue (admin, moderator)
 *   PATCH /admin/photos/:photoId/moderation  approve / reject (admin, moderator)
 *
 * The queue responses are the ONE place `reporterId` and `reviewedBy` may
 * surface (spec §112) — both are `select: false` on the model and are read
 * with an explicit `+select` in the service. The actor is the session's own
 * account (spec §31, §44).
 */

const moderationService = require('../../services/moderationService');
const { ok } = require('../../utils/apiResponse');

/** GET /api/v1/admin/reports — the moderation queue. */
async function listReports(req, res) {
  const result = await moderationService.listReports(req.validatedQuery);
  return ok(res, result, 'OK');
}

/** PATCH /api/v1/admin/reports/:reportId — one legal transition. */
async function transitionReport(req, res) {
  const { report } = await moderationService.transitionReport(req.auth.userId, req.params.reportId, req.body);
  return ok(res, { report }, 'Report updated.');
}

/** GET /api/v1/admin/photos/pending — the photo queue. */
async function listPendingPhotos(req, res) {
  const result = await moderationService.listPendingPhotos(req.validatedQuery);
  return ok(res, result, 'OK');
}

/** PATCH /api/v1/admin/photos/:photoId/moderation — approve or reject. */
async function moderatePhoto(req, res) {
  const result = await moderationService.moderatePhoto(req.auth.userId, req.params.photoId, req.body);
  return ok(res, result, 'Photo moderation updated.');
}

module.exports = { listReports, transitionReport, listPendingPhotos, moderatePhoto };
