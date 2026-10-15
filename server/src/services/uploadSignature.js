'use strict';

/**
 * Signed direct-upload authorization (spec §43; step 08 task 4).
 *
 * The upload path is *browser → Cloudinary*, so the API secret never leaves the
 * server: the client receives a short-lived signature plus the public API key,
 * and Cloudinary verifies the signature itself. Three things make a signature
 * narrow enough to be safe to hand out:
 *
 *  1. **Per-user folder.** The signed `folder` is `<root>/users/<token>` (or
 *     `.../kundli/<token>`), where `<token>` is a keyed digest of the account —
 *     never the account id itself, because a Cloudinary delivery URL carries the
 *     public id and therefore the folder (see `folderToken`). Registration later
 *     refuses any `publicId` that does not live under the caller's own folder,
 *     so a leaked signature cannot be used to write into somebody else's gallery
 *     (gate G3.3).
 *  2. **Restricted formats.** `allowed_formats` is part of the signed payload,
 *     so Cloudinary rejects a disallowed type before the file is stored — the
 *     allowlist is enforced at the CDN, not only after the fact.
 *  3. **Short lifetime.** Cloudinary honours a timestamp for one hour, so the
 *     TTL is capped at 3600 seconds by configuration (`PHOTO_SIGN_TTL_SECONDS`),
 *     and the response states when the signature stops being accepted rather
 *     than leaving the client to guess (gate G3.5).
 *
 * Size cannot be enforced by the signature: Cloudinary only applies
 * `max_file_size` through an upload preset. The cap is therefore enforced at
 * registration, from the asset's *actual* byte count reported by the admin API —
 * which is strictly stronger than trusting a client-declared size (spec §43).
 */

const crypto = require('node:crypto');
const cloudinaryConfig = require('../config/cloudinary');
const config = require('../config/env');
const { BadRequestError } = require('../utils/AppError');
const { photoFolder, PHOTO_TYPE } = require('../constants/photo');
const { kundliFolder, KUNDLI_ALLOWED_FORMATS, KUNDLI_ASSET_TYPE } = require('../constants/kundli');

/**
 * The opaque, stable folder segment that identifies one account's assets.
 *
 * The raw account id must NOT appear in an upload path: a card image is served
 * from `res.cloudinary.com/.../<publicId>`, the public id contains the folder,
 * and the folder would therefore publish the internal account identifier to every
 * member who loads a discovery card (spec §30, §51, §112 — the card carries a
 * name and a city, not the account's database key). A keyed digest keeps
 * everything the folder needs — stable per account, different per account,
 * provable only by this deployment — without disclosing the id.
 *
 * @param {string} userId from `req.auth`
 * @returns {string} 24 hex characters
 */
function folderToken(userId) {
  return crypto.createHmac('sha256', config.jwt.secret).update(String(userId)).digest('hex').slice(0, 24);
}

/** Where this account's photo uploads must land. */
function photoUploadFolder(userId) {
  return photoFolder(cloudinaryConfig.uploadFolder, folderToken(userId));
}

/** Where this account's Kundli upload must land. */
function kundliUploadFolder(userId) {
  return kundliFolder(cloudinaryConfig.uploadFolder, folderToken(userId));
}

/** The Cloudinary endpoint a signed direct upload posts to. */
function uploadUrl() {
  return `https://api.cloudinary.com/v1_1/${config.cloudinary.cloudName}/image/upload`;
}

/**
 * Build the signed parameter set.
 *
 * `api_sign_request` sorts the keys itself and appends the secret, so the
 * caller's ordering cannot make the signature disagree with Cloudinary's.
 */
function sign({ folder, allowedFormats, type }) {
  cloudinaryConfig.ensureConfigured();

  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = {
    timestamp,
    folder,
    allowed_formats: allowedFormats.join(','),
    // Photos are `upload` (publicly deliverable); Kundli documents are
    // `authenticated` so they have no plain delivery URL (decisions §6).
    type
  };

  const signature = cloudinaryConfig.cloudinary.utils.api_sign_request(
    paramsToSign,
    config.cloudinary.apiSecret
  );

  return {
    signature,
    timestamp,
    folder,
    allowedFormats: [...allowedFormats],
    apiKey: config.cloudinary.apiKey,
    cloudName: config.cloudinary.cloudName,
    uploadUrl: uploadUrl(),
    type,
    expiresAt: new Date((timestamp + config.media.photoSignTtlSeconds) * 1000).toISOString(),
    signTtlSeconds: config.media.photoSignTtlSeconds,
    maxBytes: config.media.photoMaxBytes,
    maxCount: config.media.photoMaxCount
  };
}

/**
 * Signature for a profile/gallery photo upload (command 1).
 *
 * @param {string} userId from `req.auth`
 * @param {{type?: string}} [options] photo type, for the client's own context
 */
function signPhotoUpload(userId, options = {}) {
  const type = PHOTO_TYPE.GALLERY === options.type ? PHOTO_TYPE.GALLERY : PHOTO_TYPE.PROFILE;
  return Object.freeze({
    ...sign({
      folder: photoUploadFolder(userId),
      allowedFormats: config.media.photoAllowedFormats,
      type: 'upload'
    }),
    assetType: 'upload',
    requestedType: type
  });
}

/** Signature for a Kundli document upload (task 12). */
function signKundliUpload(userId) {
  return Object.freeze({
    ...sign({
      folder: kundliUploadFolder(userId),
      allowedFormats: KUNDLI_ALLOWED_FORMATS,
      type: KUNDLI_ASSET_TYPE
    }),
    assetType: KUNDLI_ASSET_TYPE
  });
}

/**
 * A `publicId` belongs to this account when it sits inside that account's own
 * folder. Compared on the folder *prefix* with a slash, so `users/abc` cannot be
 * satisfied by `users/abcd`.
 */
function isInsideFolder(publicId, folder) {
  return typeof publicId === 'string' && publicId.startsWith(`${folder}/`) && publicId.length > folder.length + 1;
}

/** Assert the caller owns the asset path, or 400 (never a silent store). */
function assertOwnedUpload(userId, publicId, kind = 'photo') {
  const folder = kind === 'kundli' ? kundliUploadFolder(userId) : photoUploadFolder(userId);
  if (!isInsideFolder(publicId, folder)) {
    throw new BadRequestError('Invalid request.', {
      details: {
        publicId: 'This asset was not uploaded to your own folder. Upload through the signed endpoint first.'
      }
    });
  }
  return publicId;
}

module.exports = {
  folderToken,
  photoUploadFolder,
  kundliUploadFolder,
  uploadUrl,
  signPhotoUpload,
  signKundliUpload,
  isInsideFolder,
  assertOwnedUpload
};
