'use strict';

/**
 * Kundli-document constants (finalized decisions §6; fields dictionary §11.7;
 * spec §112; step 08 task 12).
 *
 * A Kundli document is **not** a photo type. It lives in its own collection
 * because its privacy model is stricter than any photo's:
 *
 *   - `visibility` is limited to `private | matches_only` — there is no public
 *     or registered-users option, so a Kundli can never become profile-card
 *     data or discovery output.
 *   - The asset is uploaded as a Cloudinary **authenticated** asset, which is
 *     not fetchable from a plain delivery URL; the API issues a short-lived
 *     signed URL to the owner (or an accepted-connection viewer) instead.
 */

const { MODERATION_STATUSES, MODERATION_STATUS } = require('./photo');

/** Decisions §6. Reduced on purpose: `public` and `registered_users` do not exist here. */
const KUNDLI_VISIBILITY = Object.freeze(['private', 'matches_only']);
const KUNDLI_VISIBILITY_VALUE = Object.freeze({
  PRIVATE: 'private',
  MATCHES_ONLY: 'matches_only'
});

/** The default for a new document — "private" until the owner says otherwise. */
const KUNDLI_DEFAULT_VISIBILITY = KUNDLI_VISIBILITY_VALUE.PRIVATE;

/** A Kundli is a scan or a PDF; the same image formats plus a document format. */
const KUNDLI_ALLOWED_FORMATS = Object.freeze(['jpg', 'jpeg', 'png', 'webp', 'pdf']);

/** Cloudinary asset type for Kundli documents: not publicly deliverable. */
const KUNDLI_ASSET_TYPE = 'authenticated';

/** Signed delivery URL lifetime. Short by design (spec §112). */
const KUNDLI_DELIVERY_TTL_SECONDS = 300;

/** One Kundli document per account. */
const KUNDLI_MAX_COUNT = 1;

/**
 * Where a user's Kundli upload lives. Separate from the photo folder so the two
 * asset families can be told apart by prefix alone.
 *
 * @param {string} uploadFolder configured root folder
 * @param {string} userId owner id
 */
function kundliFolder(uploadFolder, userId) {
  return `${uploadFolder}/kundli/${userId}`;
}

module.exports = {
  KUNDLI_VISIBILITY,
  KUNDLI_VISIBILITY_VALUE,
  KUNDLI_DEFAULT_VISIBILITY,
  KUNDLI_ALLOWED_FORMATS,
  KUNDLI_ASSET_TYPE,
  KUNDLI_DELIVERY_TTL_SECONDS,
  KUNDLI_MAX_COUNT,
  KUNDLI_MODERATION_STATUSES: MODERATION_STATUSES,
  KUNDLI_MODERATION_STATUS: MODERATION_STATUS,
  kundliFolder
};
