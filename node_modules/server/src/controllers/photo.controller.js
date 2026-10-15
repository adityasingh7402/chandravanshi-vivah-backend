'use strict';

/**
 * Photo controller (spec §30, §43, §44, §72; step 08 task 11).
 *
 * Request/response only. Every call passes `req.auth.userId` — resolved by
 * `requireAuth` from the presented credential — so the resource is always the
 * caller's own, and a `userId` in a body is rejected by the validator before it
 * gets here (spec §72).
 *
 * Responses never contain `url`, `publicId` or the Cloudinary secret; they carry
 * the transformed variants instead (spec §18, §30).
 */

const photoService = require('../services/photoService');
const uploadSignature = require('../services/uploadSignature');
const { ok } = require('../utils/apiResponse');
const { HTTP_STATUS } = require('../config/constants');

/** GET /api/v1/photos — the caller's photos with transformation URLs. */
async function list(req, res) {
  const photos = await photoService.listOwn(req.auth.userId);
  return ok(res, { photos }, 'OK');
}

/** POST /api/v1/photos/sign — short-lived signature for a direct upload. */
async function sign(req, res) {
  const upload = uploadSignature.signPhotoUpload(req.auth.userId, { type: req.body && req.body.type });
  return ok(res, { upload }, 'Upload authorized.');
}

/** POST /api/v1/photos — register a verified upload (command 2). */
async function create(req, res) {
  const photo = await photoService.createFromUpload(req.auth.userId, req.body);
  return ok(res, { photo: photoService.serialize(photo) }, 'Photo added.', HTTP_STATUS.CREATED);
}

/** PATCH /api/v1/photos/:photoId — visibility, order or the primary flag. */
async function update(req, res) {
  const { userId } = req.auth;
  const { photoId } = req.params;
  let photo;

  if (Object.prototype.hasOwnProperty.call(req.body, 'visibility')) {
    photo = await photoService.updateVisibility(userId, photoId, req.body.visibility);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'isPrimary')) {
    photo = await photoService.setPrimary(userId, photoId, req.body.isPrimary);
  }
  if (Object.prototype.hasOwnProperty.call(req.body, 'sortOrder')) {
    // "Put this photo at position N", renumbering its type group. The full
    // gallery order is PATCH /photos, which is what a drag-and-drop UI sends.
    photo = await photoService.setSortOrder(userId, photoId, req.body.sortOrder);
  }

  return ok(res, { photo: photoService.serialize(photo) }, 'Photo updated.');
}

/** PATCH /api/v1/photos — persist a whole-gallery order (command 4). */
async function reorder(req, res) {
  const photos = await photoService.reorder(req.auth.userId, req.body.order);
  return ok(res, { photos }, 'Photo order updated.');
}

/** DELETE /api/v1/photos/:photoId — asset first, then the reference. */
async function remove(req, res) {
  await photoService.deletePhoto(req.auth.userId, req.params.photoId);
  return ok(res, { photo: { id: String(req.params.photoId), deleted: true } }, 'Photo deleted.');
}

module.exports = { list, sign, create, update, reorder, remove };
