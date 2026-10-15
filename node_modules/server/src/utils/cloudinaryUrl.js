'use strict';

/**
 * Cloudinary transformation URLs (spec §18, §82; step 08 task 5).
 *
 * Every photo response is built here, so one rule is enforced in one place:
 * **a client is never handed the original asset.** Each variant carries an
 * explicit width/height/crop, and the card variant is deliberately tiny, because
 * profile discovery is image-heavy and a grid of multi-megabyte originals is the
 * single easiest way to make the app feel slow (spec §18).
 *
 * The builder needs the cloud name only — it is public (it appears in every
 * delivery URL), so nothing sensitive flows through this module. The API secret
 * is used for *signing uploads*, never for building a delivery URL.
 */

const config = require('../config/env');
const { BadRequestError } = require('./AppError');
const { TRANSFORMATIONS, PHOTO_VARIANTS } = require('../constants/photo');

/**
 * A Cloudinary public id: path segments of safe characters. Validated rather
 * than trusted, because it is interpolated into a URL and a `?` or `#` inside it
 * would let a client append its own query string (spec §35).
 */
const PUBLIC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_\-/.]*$/;

function assertPublicId(publicId) {
  if (typeof publicId !== 'string' || publicId.length === 0 || publicId.length > 512 || !PUBLIC_ID_RE.test(publicId)) {
    throw new BadRequestError('Invalid request.', { details: { publicId: 'This must be a valid uploaded asset reference.' } });
  }
  return publicId;
}

function isPublicId(publicId) {
  return typeof publicId === 'string' && publicId.length > 0 && publicId.length <= 512 && PUBLIC_ID_RE.test(publicId);
}

/** Cloudinary's transformation syntax: comma-separated, alphabetical keys. */
function transformationString(specification) {
  return [
    `c_${specification.crop}`,
    `g_${specification.gravity}`,
    `h_${specification.height}`,
    `w_${specification.width}`,
    `q_${specification.quality}`,
    `f_${specification.fetchFormat}`
  ].join(',');
}

/** `card` | `profile` | `gallery` -> the documented dimensions. */
function dimensionsFor(variant) {
  const specification = TRANSFORMATIONS[variant];
  if (!specification) return null;
  return { width: specification.width, height: specification.height };
}

/** The transformed delivery URL for one variant. */
function variantUrl(publicId, variant) {
  const specification = TRANSFORMATIONS[variant];
  if (!specification) throw new BadRequestError('Invalid request.', { details: { variant: 'Unknown image size.' } });
  const cloudName = config.cloudinary.cloudName;
  // No cloud name means the integration is unconfigured; the service answers 503
  // before it ever gets here, so this is a belt-and-braces null.
  if (!cloudName) return null;
  return `https://res.cloudinary.com/${cloudName}/image/upload/${transformationString(specification)}/${assertPublicId(publicId)}`;
}

/**
 * Every variant for one asset, ready for a DTO: the URL plus the dimensions it
 * was rendered at, so a client can reserve layout space and lazy-load without
 * shifting the page (spec §18).
 *
 * @param {string} publicId
 * @returns {{card: object, profile: object, gallery: object}}
 */
function variantsFor(publicId) {
  const variants = {};
  for (const variant of PHOTO_VARIANTS) {
    const dimensions = dimensionsFor(variant);
    variants[variant] = Object.freeze({
      url: variantUrl(publicId, variant),
      width: dimensions.width,
      height: dimensions.height
    });
  }
  return variants;
}

module.exports = {
  assertPublicId,
  isPublicId,
  transformationString,
  dimensionsFor,
  variantUrl,
  variantsFor
};
