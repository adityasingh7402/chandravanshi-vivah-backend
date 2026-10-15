'use strict';

/**
 * Photo service (spec §17, §18, §43, §44, §80, §101, §105, §112; step 08
 * tasks 6-10).
 *
 * The rules this module exists to enforce:
 *
 *  1. **An upload is verified before it is stored.** A client posts a `publicId`
 *     after uploading; the server asks Cloudinary what that asset actually is
 *     and refuses it unless it sits in the caller's own folder, is an allowed
 *     format and is inside the size cap. A client-supplied URL is never trusted
 *     (spec §43).
 *  2. **Ownership is a filter, not a check.** Every management operation looks
 *     the row up by `{ _id, userId }` together, so another account's photo is
 *     *not found* — a 404 that does not confirm the asset exists (spec §44).
 *  3. **The database keeps a reference, never a binary** (spec §17), and a
 *     failed asset deletion keeps the reference and reports a retryable error
 *     instead of orphaning the file (task 10).
 *  4. **`url` is never returned.** Responses carry the three transformed
 *     variants, so a card never receives an original multi-megabyte image and
 *     a delivery URL alone never leaves the API (spec §18).
 */

const Photo = require('../models/Photo');
const cloudinaryConfig = require('../config/cloudinary');
const config = require('../config/env');
const profileScoreService = require('./profileScoreService');
const uploadSignature = require('./uploadSignature');
const { variantsFor, isPublicId } = require('../utils/cloudinaryUrl');
const {
  BadRequestError,
  NotFoundError,
  ConflictError,
  ServiceUnavailableError
} = require('../utils/AppError');
const {
  MODERATION_STATUS,
  PHOTO_TYPE,
  PHOTO_TYPES,
  RELATIONSHIP_ONLY_VISIBILITY,
  TRANSFORMATIONS
} = require('../constants/photo');

/** A retryable 503 for a Cloudinary call that failed for a transport reason. */
function mediaUnavailable(cause) {
  return new ServiceUnavailableError(
    'Image storage is temporarily unavailable. Please try again in a moment.',
    { cause }
  );
}

/** Cloudinary reports a missing asset as a 404-ish error; everything else is retryable. */
function isNotFound(error) {
  if (!error) return false;
  const status = error.http_code || error.statusCode || (error.error && error.error.http_code);
  return status === 404 || error.name === 'NotFound' || /not found/i.test(String(error.message || ''));
}

/** The caller's own photo, or a 404 that reveals nothing (spec §44). */
async function getOwnedOr404(userId, photoId) {
  const photo = await Photo.findOne({ _id: photoId, userId });
  if (!photo) throw new NotFoundError('The requested resource does not exist.');
  return photo;
}

function photoCount(userId) {
  return Photo.countDocuments({ userId });
}

/**
 * The DTO. Every field is named explicitly and `url` / `publicId` are absent on
 * purpose: a client needs the display variants and the management id, and
 * nothing about the stored asset's address (spec §30, §111).
 */
function serialize(photo) {
  return {
    id: String(photo._id),
    type: photo.type,
    isPrimary: Boolean(photo.isPrimary),
    sortOrder: photo.sortOrder,
    visibility: photo.visibility,
    moderationStatus: photo.moderationStatus,
    variants: variantsFor(photo.publicId),
    createdAt: photo.createdAt,
    updatedAt: photo.updatedAt
  };
}

/**
 * The subset another account may see (spec §112).
 *
 * A non-relationship viewer sees only approved photos whose visibility is
 * `public` or `registered_users`; `matches_only` and `private` appear only for
 * an accepted connection. Moderation is applied here as well as in the query
 * because a rejected photo must never leak through a relationship either.
 */
function visibleToViewer(photo, { isOwner = false, isMatch = false } = {}) {
  if (isOwner) return true;
  if (photo.moderationStatus !== MODERATION_STATUS.APPROVED) return false;
  if (RELATIONSHIP_ONLY_VISIBILITY.includes(photo.visibility)) return isMatch;
  return true;
}

/** Another account's visible photos. Owner views use `listOwn`. */
async function listForViewer(targetUserId, options = {}) {
  const photos = await Photo.find({ userId: targetUserId }).sort({ isPrimary: -1, sortOrder: 1, createdAt: 1 });
  return photos.filter((photo) => visibleToViewer(photo, options)).map(serialize);
}

/** GET /photos — the caller's own gallery, primary first. */
async function listOwn(userId) {
  const photos = await Photo.find({ userId }).sort({ isPrimary: -1, sortOrder: 1, createdAt: 1 });
  return photos.map(serialize);
}

/**
 * Register an uploaded asset (task 7, commands 2 and 6).
 *
 * The Cloudinary admin API is the source of truth for existence, format, size
 * and folder. `input.url` is accepted for compatibility with the documented
 * request body but is **ignored**: the stored URL is the asset's own
 * `secure_url`, so a client cannot point a row at an arbitrary address.
 *
 * @param {string} userId from `req.auth` only
 * @param {{publicId: string, type?: string, isPrimary?: boolean}} input
 */
async function createFromUpload(userId, input) {
  cloudinaryConfig.ensureConfigured();

  const publicId = uploadSignature.assertOwnedUpload(userId, input.publicId, 'photo');
  if (!isPublicId(publicId)) {
    throw new BadRequestError('Invalid request.', { details: { publicId: 'This must be a valid uploaded asset reference.' } });
  }

  const existingCount = await photoCount(userId);
  if (existingCount >= config.media.photoMaxCount) {
    throw new ConflictError(
      `You can have at most ${config.media.photoMaxCount} photos. Delete one to add another.`,
      { details: { photos: `The limit of ${config.media.photoMaxCount} photos has been reached.` } }
    );
  }

  // The asset must already be an uploaded photo in *this* account's folder.
  let asset;
  try {
    asset = await cloudinaryConfig.getAssetGateway().describe({ publicId, type: 'upload' });
  } catch (err) {
    if (isNotFound(err)) {
      throw new BadRequestError('Invalid request.', {
        details: { publicId: 'That uploaded asset could not be found. Upload it again.' }
      });
    }
    throw mediaUnavailable(err);
  }

  if (!asset || !asset.exists) {
    throw new BadRequestError('Invalid request.', {
      details: { publicId: 'That uploaded asset could not be found. Upload it again.' }
    });
  }

  const expectedFolder = uploadSignature.photoUploadFolder(userId);
  if (asset.folder && asset.folder !== expectedFolder) {
    throw new BadRequestError('Invalid request.', {
      details: { publicId: 'That asset belongs to a different upload folder.' }
    });
  }

  const format = asset.format ? String(asset.format).toLowerCase() : null;
  if (!format || !config.media.photoAllowedFormats.includes(format)) {
    throw new BadRequestError('Invalid request.', {
      details: { file: `Only ${config.media.photoAllowedFormats.join(', ')} images are accepted.` }
    });
  }

  if (typeof asset.bytes === 'number' && asset.bytes > config.media.photoMaxBytes) {
    throw new BadRequestError('Invalid request.', {
      details: { file: `Each photo must be smaller than ${Math.round(config.media.photoMaxBytes / (1024 * 1024))} MB.` }
    });
  }

  const url = asset.secureUrl;
  if (!url) throw mediaUnavailable(new Error('The uploaded asset has no secure URL.'));

  const type = PHOTO_TYPES.includes(input.type) ? input.type : PHOTO_TYPE.GALLERY;

  // The first profile photo becomes the primary one, so onboarding does not have
  // to make a second call just to have a card image (task 7, command 2).
  const existingPrimary = await Photo.findOne({ userId, type, isPrimary: true }).select('_id').lean();
  const isPrimary = !existingPrimary && (type === PHOTO_TYPE.PROFILE || input.isPrimary === true);

  const photo = new Photo({
    userId,
    url,
    publicId,
    type,
    isPrimary,
    // Appended to the end of the gallery; `reorder` is what changes this.
    sortOrder: existingCount,
    // Spec §17, §101: nothing is eligible for discovery until it is approved.
    moderationStatus: MODERATION_STATUS.PENDING
  });

  try {
    await photo.save();
  } catch (err) {
    if (err && err.code === 11000) {
      // The unique `publicId` index: the same asset registered twice.
      throw new ConflictError('That photo has already been added.');
    }
    throw err;
  }

  await profileScoreService.refreshProfileCompletion(userId);
  // Step 09's denormalised discovery signal: a new photo is `pending`, so this
  // normally records `false` until moderation approves it (spec §101).
  await profileScoreService.syncDiscoveryPhotoFlag(userId);
  return photo;
}

/**
 * Set or clear the primary flag (task 8, command 7).
 *
 * A primary photo is unique per `(userId, type)` in the database, so the old one
 * is cleared before the new one is set. Doing it that way means a concurrent
 * call loses loudly (409) instead of leaving two primaries behind.
 */
async function setPrimary(userId, photoId, isPrimary = true) {
  const photo = await getOwnedOr404(userId, photoId);
  if (photo.isPrimary === isPrimary) return photo;

  if (isPrimary) {
    await Photo.updateMany({ userId, type: photo.type, _id: { $ne: photo._id } }, { $set: { isPrimary: false } });
  }
  photo.isPrimary = isPrimary;
  await photo.save();

  await profileScoreService.refreshProfileCompletion(userId);
  // Which photo is primary changed, so the eligibility flag must follow it.
  await profileScoreService.syncDiscoveryPhotoFlag(userId);
  return photo;
}

/**
 * Persist a new gallery order (task 8, command 4).
 *
 * The list must name the caller's own photos and nothing else: a foreign or
 * unknown id is a 404, so the endpoint cannot be used to probe for other
 * accounts' assets.
 */
async function reorder(userId, order) {
  const owned = await Photo.find({ userId }).select('_id').lean();
  const ownedIds = new Set(owned.map((row) => String(row._id)));

  for (const id of order) {
    if (!ownedIds.has(String(id))) throw new NotFoundError('The requested resource does not exist.');
  }

  const operations = order.map((id, index) => ({
    updateOne: { filter: { _id: id, userId }, update: { $set: { sortOrder: index } } }
  }));
  if (operations.length > 0) await Photo.bulkWrite(operations, { ordered: true });

  return listOwn(userId);
}

/**
 * Move one photo to a position inside its own type group (task 8).
 *
 * Expressed as a move rather than a raw assignment: writing `sortOrder = 3` onto
 * one row while three others already hold 0..3 would make the gallery order
 * ambiguous, and the list would then depend on the tie-breaker. The target is
 * clamped into range, the group is renumbered, and the invariant "sortOrder is a
 * dense 0..n-1 sequence per (user, type)" holds afterwards.
 */
async function setSortOrder(userId, photoId, position) {
  const photo = await getOwnedOr404(userId, photoId);
  const group = await Photo.find({ userId, type: photo.type }).sort({ sortOrder: 1, createdAt: 1 }).select('_id').lean();

  const ids = group.map((row) => String(row._id)).filter((id) => id !== String(photo._id));
  const target = Math.max(0, Math.min(position, ids.length));
  ids.splice(target, 0, String(photo._id));

  await Photo.bulkWrite(
    ids.map((id, index) => ({ updateOne: { filter: { _id: id, userId }, update: { $set: { sortOrder: index } } } })),
    { ordered: true }
  );

  return photo;
}

/** Change per-photo visibility (task 9). Enum membership is the validator's job. */
async function updateVisibility(userId, photoId, visibility) {
  const photo = await getOwnedOr404(userId, photoId);
  photo.visibility = visibility;
  await photo.save();
  return photo;
}

/**
 * Delete the asset and then the reference (task 10).
 *
 * Order matters: the row is only removed once Cloudinary confirms the asset is
 * gone. A transport failure therefore leaves a recoverable state — a reference
 * whose asset still exists — and answers 503 so the client can retry, rather
 * than an orphaned file nobody can address (gate G2.6, G4.3).
 */
async function deletePhoto(userId, photoId) {
  const photo = await getOwnedOr404(userId, photoId);
  cloudinaryConfig.ensureConfigured();

  let result;
  try {
    result = await cloudinaryConfig.getAssetGateway().destroy({ publicId: photo.publicId, type: 'upload' });
  } catch (err) {
    // "Already gone" is a success for our purposes; anything else is retryable.
    if (isNotFound(err)) result = { result: 'not found' };
    else throw mediaUnavailable(err);
  }

  const outcome = result && result.result;
  if (outcome !== 'ok' && outcome !== 'not found') {
    throw mediaUnavailable(new Error(`Cloudinary destroy returned "${outcome}".`));
  }

  await Photo.deleteOne({ _id: photo._id, userId });
  await profileScoreService.refreshProfileCompletion(userId);
  await profileScoreService.syncDiscoveryPhotoFlag(userId);
  return photo;
}

/**
 * The single URL a discovery row needs (step 09): primary + approved + the small
 * card transform. `null` when there is nothing to show, so a caller always gets
 * a usable value and never an original.
 */
async function primaryCard(userId) {
  const photo = await profileScoreService.primaryCardPhoto(userId);
  if (!photo) return null;
  return { url: variantsFor(photo.publicId).card.url, ...TRANSFORMATIONS.card };
}

/** Whether this account has any primary photo (completion + activation gate). */
async function hasPrimaryPhoto(userId) {
  return profileScoreService.hasPrimaryPhoto(userId);
}

module.exports = {
  getOwnedOr404,
  photoCount,
  serialize,
  visibleToViewer,
  listOwn,
  listForViewer,
  createFromUpload,
  setPrimary,
  setSortOrder,
  reorder,
  updateVisibility,
  deletePhoto,
  primaryCard,
  hasPrimaryPhoto
};
