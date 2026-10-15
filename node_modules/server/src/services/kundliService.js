'use strict';

/**
 * Kundli document service (finalized decisions §6; fields dictionary §11.7;
 * spec §17, §44, §112; step 08 task 12).
 *
 * A Kundli is the most private upload on the platform, so three things are
 * deliberately different from a photo:
 *
 *  - It is uploaded as a Cloudinary **authenticated** asset, which has no plain
 *    delivery URL. The API issues a short-lived signed URL instead — and only to
 *    the owner, or to an accepted-connection viewer when the document's
 *    visibility is `matches_only`.
 *  - `visibility` is limited to `private | matches_only` by the schema itself,
 *    so "make my Kundli public" is not an expressible state (decisions §6).
 *  - It is stored in its own collection and is never added to a discovery or
 *    profile-card response (gate G3.8).
 */

const KundliDocument = require('../models/KundliDocument');
const cloudinaryConfig = require('../config/cloudinary');
const config = require('../config/env');
const uploadSignature = require('./uploadSignature');
const { isPublicId } = require('../utils/cloudinaryUrl');
const { BadRequestError, NotFoundError, ConflictError, ServiceUnavailableError } = require('../utils/AppError');
const {
  KUNDLI_ALLOWED_FORMATS,
  KUNDLI_ASSET_TYPE,
  KUNDLI_DELIVERY_TTL_SECONDS,
  KUNDLI_MAX_COUNT,
  KUNDLI_VISIBILITY_VALUE
} = require('../constants/kundli');
// Moderation is the photo vocabulary: decisions §6 gives Kundli documents the
// same three states, and one enum means one set of values to keep in step.
const { MODERATION_STATUS } = require('../constants/photo');

function mediaUnavailable(cause) {
  return new ServiceUnavailableError(
    'Document storage is temporarily unavailable. Please try again in a moment.',
    { cause }
  );
}

function isNotFound(error) {
  if (!error) return false;
  const status = error.http_code || error.statusCode || (error.error && error.error.http_code);
  return status === 404 || error.name === 'NotFound' || /not found/i.test(String(error.message || ''));
}

async function getOwnedOr404(userId, kundliId) {
  const document = await KundliDocument.findOne({ _id: kundliId, userId });
  if (!document) throw new NotFoundError('The requested resource does not exist.');
  return document;
}

/**
 * Who may see this document. There is no "everyone" branch: a Kundli is either
 * the owner's, or an accepted connection's when the owner allowed that.
 */
function visibleToViewer(document, { isOwner = false, isMatch = false } = {}) {
  if (isOwner) return true;
  if (document.moderationStatus !== MODERATION_STATUS.APPROVED) return false;
  return document.visibility === KUNDLI_VISIBILITY_VALUE.MATCHES_ONLY && isMatch;
}

/**
 * A short-lived signed URL for the asset.
 *
 * This is the only form in which a client ever receives a Kundli reference; the
 * stored `url`/`publicId` stay server-side (spec §112).
 */
async function signedUrl(document) {
  if (!cloudinaryConfig.isConfigured()) return null;
  try {
    return await cloudinaryConfig.getAssetGateway().privateUrl({
      publicId: document.publicId,
      format: document.format,
      type: KUNDLI_ASSET_TYPE,
      ttlSeconds: KUNDLI_DELIVERY_TTL_SECONDS
    });
  } catch (err) {
    // A delivery URL is a convenience for the owner's own screen; failing to
    // mint one must not turn a metadata read into a 500.
    if (isNotFound(err)) return null;
    return null;
  }
}

/** The owner's DTO: metadata plus a freshly signed, short-lived URL. */
async function serialize(document) {
  if (!document) return null;
  return {
    id: String(document._id),
    visibility: document.visibility,
    moderationStatus: document.moderationStatus,
    documentUrl: await signedUrl(document),
    urlExpiresInSeconds: KUNDLI_DELIVERY_TTL_SECONDS,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt
  };
}

async function getOwn(userId) {
  return KundliDocument.findOne({ userId });
}

/**
 * Register an uploaded Kundli document.
 *
 * One document per account (a Kundli is a single artefact); replacing it means
 * deleting the old one first, so a stale file can never linger unaddressed.
 */
async function create(userId, input) {
  cloudinaryConfig.ensureConfigured();

  const publicId = uploadSignature.assertOwnedUpload(userId, input.publicId, 'kundli');
  if (!isPublicId(publicId)) {
    throw new BadRequestError('Invalid request.', { details: { publicId: 'This must be a valid uploaded asset reference.' } });
  }

  if ((await KundliDocument.countDocuments({ userId })) >= KUNDLI_MAX_COUNT) {
    throw new ConflictError('You have already uploaded a Kundli document. Delete it first to replace it.');
  }

  let asset;
  try {
    asset = await cloudinaryConfig.getAssetGateway().describe({ publicId, type: KUNDLI_ASSET_TYPE });
  } catch (err) {
    if (isNotFound(err)) {
      throw new BadRequestError('Invalid request.', { details: { publicId: 'That uploaded document could not be found. Upload it again.' } });
    }
    throw mediaUnavailable(err);
  }

  if (!asset || !asset.exists) {
    throw new BadRequestError('Invalid request.', { details: { publicId: 'That uploaded document could not be found. Upload it again.' } });
  }

  const expectedFolder = uploadSignature.kundliUploadFolder(userId);
  if (asset.folder && asset.folder !== expectedFolder) {
    throw new BadRequestError('Invalid request.', { details: { publicId: 'That document belongs to a different upload folder.' } });
  }

  const format = asset.format ? String(asset.format).toLowerCase() : null;
  if (!format || !KUNDLI_ALLOWED_FORMATS.includes(format)) {
    throw new BadRequestError('Invalid request.', {
      details: { file: `Only ${KUNDLI_ALLOWED_FORMATS.join(', ')} documents are accepted.` }
    });
  }

  if (typeof asset.bytes === 'number' && asset.bytes > config.media.photoMaxBytes) {
    throw new BadRequestError('Invalid request.', {
      details: { file: `The document must be smaller than ${Math.round(config.media.photoMaxBytes / (1024 * 1024))} MB.` }
    });
  }

  const document = new KundliDocument({
    userId,
    url: asset.secureUrl || `authenticated:${publicId}`,
    publicId,
    format,
    // Decisions §6: private until the owner changes it, and pending until a
    // moderator approves it (spec §101).
    visibility: KUNDLI_VISIBILITY_VALUE.PRIVATE,
    moderationStatus: MODERATION_STATUS.PENDING
  });

  try {
    await document.save();
  } catch (err) {
    if (err && err.code === 11000) throw new ConflictError('That document has already been added.');
    throw err;
  }

  return document;
}

/** Change visibility. The validator restricts the value to `private | matches_only`. */
async function updateVisibility(userId, kundliId, visibility) {
  const document = await getOwnedOr404(userId, kundliId);
  document.visibility = visibility;
  await document.save();
  return document;
}

/** Destroy the asset, then the reference — same recoverable order as photos. */
async function remove(userId, kundliId) {
  const document = await getOwnedOr404(userId, kundliId);
  cloudinaryConfig.ensureConfigured();

  let result;
  try {
    result = await cloudinaryConfig.getAssetGateway().destroy({ publicId: document.publicId, type: KUNDLI_ASSET_TYPE });
  } catch (err) {
    if (isNotFound(err)) result = { result: 'not found' };
    else throw mediaUnavailable(err);
  }

  const outcome = result && result.result;
  if (outcome !== 'ok' && outcome !== 'not found') {
    throw mediaUnavailable(new Error(`Cloudinary destroy returned "${outcome}".`));
  }

  await KundliDocument.deleteOne({ _id: document._id, userId });
  return document;
}

module.exports = {
  getOwnedOr404,
  visibleToViewer,
  serialize,
  signedUrl,
  getOwn,
  create,
  updateVisibility,
  remove,
  KUNDLI_MAX_COUNT
};
