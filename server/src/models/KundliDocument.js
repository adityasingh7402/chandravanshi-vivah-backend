'use strict';

/**
 * `kundli_documents` model (finalized decisions §6; fields dictionary §11.7;
 * spec §105, §112; step 08 task 12).
 *
 * A Kundli document gets its own collection rather than a `photos.type`, because
 * its privacy model is stricter than any photo's:
 *
 *   - `visibility` accepts **only** `private | matches_only`. There is no public
 *     or registered-users option to select, so a Kundli can never become
 *     profile-card data or appear in discovery output (decisions §6).
 *   - The asset is uploaded as a Cloudinary `authenticated` resource, which has
 *     no plain delivery URL; the API hands out a short-lived signed URL to the
 *     owner (or an accepted-connection viewer) instead (spec §112).
 *
 * MongoDB stores the reference and metadata only — never the file (spec §17).
 */

const mongoose = require('mongoose');
const { baseSchema } = require('./plugins/baseSchema');
const { COLLECTIONS } = require('../config/collections');
const { KUNDLI_VISIBILITY, KUNDLI_DEFAULT_VISIBILITY } = require('../constants/kundli');
// Moderation is shared with photos: one vocabulary for one state machine.
const { MODERATION_STATUSES, MODERATION_STATUS } = require('../constants/photo');

const { ObjectId } = mongoose.Schema.Types;

const kundliDocumentSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },

    url: { type: String, required: true, trim: true, maxlength: 1024 },
    publicId: { type: String, required: true, trim: true, maxlength: 512 },

    // Required to mint the signed delivery URL (decisions §6's suggested document
    // has only url/publicId; the format is needed because an authenticated asset
    // has no plain URL whose extension could be read back).
    format: { type: String, required: true, trim: true, lowercase: true, maxlength: 16 },

    moderationStatus: { type: String, enum: MODERATION_STATUSES, default: MODERATION_STATUS.PENDING },

    // Decisions §6: private by default, and `matches_only` is the only
    // alternative — the reduced enum is the enforcement, not a service check.
    visibility: { type: String, enum: KUNDLI_VISIBILITY, default: KUNDLI_DEFAULT_VISIBILITY }
  },
  { collection: COLLECTIONS.KUNDLI_DOCUMENTS }
);

kundliDocumentSchema.plugin(baseSchema);

// Load a user's document, and decide whether a relationship viewer may see it.
kundliDocumentSchema.index({ userId: 1 });
kundliDocumentSchema.index({ userId: 1, visibility: 1 });
// Delete targets one asset, so a duplicated reference must be impossible.
kundliDocumentSchema.index({ publicId: 1 }, { unique: true });

const KundliDocument =
  mongoose.models.KundliDocument || mongoose.model('KundliDocument', kundliDocumentSchema);

module.exports = KundliDocument;
