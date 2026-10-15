'use strict';

/**
 * Photo constants (spec §17, §18, §43, §105; step 08 tasks 3, 5, 8, 9).
 *
 * This module is deliberately **pure**: it imports nothing, because
 * `config/env.js` requires it to validate `PHOTO_ALLOWED_FORMATS` at boot. That
 * keeps the security allowlist in code while which subset is enabled stays in
 * configuration.
 *
 * The Mongoose schema, the request validators, the transformation-URL builder
 * and the upload signature all read the arrays below, so a value can never be
 * accepted by one layer and rejected by another.
 */

/** Spec §17. `profile` photos are the matcher-facing ones; `gallery` is extra. */
const PHOTO_TYPES = Object.freeze(['profile', 'gallery']);
const PHOTO_TYPE = Object.freeze({ PROFILE: 'profile', GALLERY: 'gallery' });

/** Spec §17. Who may see the image. */
const PHOTO_VISIBILITY = Object.freeze(['public', 'registered_users', 'matches_only', 'private']);
const PHOTO_VISIBILITY_VALUE = Object.freeze({
  PUBLIC: 'public',
  REGISTERED_USERS: 'registered_users',
  MATCHES_ONLY: 'matches_only',
  PRIVATE: 'private'
});

/** Spec §17, §101. Every new photo starts `pending`; only `approved` is discoverable. */
const MODERATION_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);
const MODERATION_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected'
});

/** Visibilities that are never shown to a viewer without an accepted connection. */
const RELATIONSHIP_ONLY_VISIBILITY = Object.freeze([
  PHOTO_VISIBILITY_VALUE.MATCHES_ONLY,
  PHOTO_VISIBILITY_VALUE.PRIVATE
]);

/**
 * Formats the API is willing to store and serve.
 *
 * `svg` is deliberately absent: an SVG is a script container, and returning one
 * from an image endpoint would be a stored-XSS vector. An operator can narrow
 * this list through `PHOTO_ALLOWED_FORMATS` but can never widen it.
 */
const SAFE_IMAGE_FORMATS = Object.freeze([
  'jpg', 'jpeg', 'png', 'webp', 'avif', 'heic', 'heif', 'gif'
]);

/**
 * Spec §18 transformation sizes. The *widths* are code-level contract (a card
 * must be small, an original must never be delivered to one); the caps that
 * limit abuse are configuration.
 *
 * `gravity: 'face'` keeps the subject centered when a non-square upload is
 * cropped, and `fetchFormat: 'auto'` lets Cloudinary deliver WebP/AVIF to a
 * client that accepts it.
 */
const TRANSFORMATIONS = Object.freeze({
  card: Object.freeze({
    label: 'Discovery card',
    width: 200,
    height: 200,
    crop: 'fill',
    gravity: 'face',
    quality: 'auto',
    fetchFormat: 'auto'
  }),
  profile: Object.freeze({
    label: 'Profile page',
    width: 600,
    height: 600,
    crop: 'fill',
    gravity: 'face',
    quality: 'auto',
    fetchFormat: 'auto'
  }),
  gallery: Object.freeze({
    label: 'Gallery',
    width: 400,
    height: 400,
    crop: 'fill',
    gravity: 'face',
    quality: 'auto',
    fetchFormat: 'auto'
  })
});

/** The three variants every photo DTO carries, in display order. */
const PHOTO_VARIANTS = Object.freeze(['card', 'profile', 'gallery']);

/**
 * Where a user's own uploads live, so a `publicId` is scoped per account.
 *
 * Registration verifies the uploaded asset's folder equals this value, which is
 * what stops a client from registering somebody else's asset — or an asset it
 * never uploaded through our signature (spec §43, gate G3.3).
 *
 * @param {string} uploadFolder configured root folder
 * @param {string} userId owner id
 */
function photoFolder(uploadFolder, userId) {
  return `${uploadFolder}/users/${userId}`;
}

module.exports = {
  PHOTO_TYPES,
  PHOTO_TYPE,
  PHOTO_VISIBILITY,
  PHOTO_VISIBILITY_VALUE,
  MODERATION_STATUSES,
  MODERATION_STATUS,
  RELATIONSHIP_ONLY_VISIBILITY,
  SAFE_IMAGE_FORMATS,
  TRANSFORMATIONS,
  PHOTO_VARIANTS,
  photoFolder
};
