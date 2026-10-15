'use strict';

/**
 * `photos` model (spec §3.3, §17, §18, §43, §105; step 08 tasks 3, 8).
 *
 * The database stores a **reference**, never a binary (spec §17): `publicId`
 * addresses the asset in Cloudinary, `url` is the asset's own secure URL, and
 * the image bytes never touch MongoDB. `url` is never returned to a client —
 * every response carries the three transformed variants instead, so an original
 * multi-megabyte file is not delivered to a card (spec §18).
 *
 * Two invariants are database rules rather than service conventions:
 *
 *   - `publicId` is unique, so the same asset cannot be registered twice (and a
 *     delete always addresses exactly one row).
 *   - **At most one primary per `(userId, type)`**, enforced by a partial unique
 *     index. `setPrimary` still clears the previous primary first, so the normal
 *     path never hits it; the index is what makes a concurrent or buggy write
 *     fail loudly instead of leaving two primaries for discover to choose from.
 */

const mongoose = require('mongoose');
const { baseSchema } = require('./plugins/baseSchema');
const { COLLECTIONS } = require('../config/collections');
const {
  PHOTO_TYPES,
  PHOTO_VISIBILITY,
  PHOTO_VISIBILITY_VALUE,
  MODERATION_STATUSES,
  MODERATION_STATUS,
  PHOTO_TYPE
} = require('../constants/photo');

const { ObjectId } = mongoose.Schema.Types;

const photoSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },

    // The Cloudinary asset reference (§17). `url` is the asset's own secure URL.
    url: { type: String, required: true, trim: true, maxlength: 1024 },
    publicId: { type: String, required: true, trim: true, maxlength: 512 },

    type: { type: String, enum: PHOTO_TYPES, default: PHOTO_TYPE.GALLERY },
    isPrimary: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0, min: 0, max: 1000 },

    // Default is `registered_users`: discovery is a signed-in surface, so
    // "public" would expose a member's photo to anyone holding the URL.
    visibility: {
      type: String,
      enum: PHOTO_VISIBILITY,
      default: PHOTO_VISIBILITY_VALUE.REGISTERED_USERS
    },

    // Spec §17, §101: nothing is discoverable until a moderator approves it.
    moderationStatus: { type: String, enum: MODERATION_STATUSES, default: MODERATION_STATUS.PENDING }
  },
  { collection: COLLECTIONS.PHOTOS }
);

photoSchema.plugin(baseSchema);

// Spec §105 index checklist: `photos.userId`.
photoSchema.index({ userId: 1 });
// The primary photo is read for every discovery card, so it gets its own key
// rather than scanning a user's whole gallery (spec §18, §82).
photoSchema.index({ userId: 1, isPrimary: 1 });
// Gallery ordering (step 08 task 8).
photoSchema.index({ userId: 1, sortOrder: 1 });
// An asset can be registered once, and a delete addresses exactly one row.
photoSchema.index({ publicId: 1 }, { unique: true });
// The invariant "at most one primary profile/gallery photo per user".
photoSchema.index(
  { userId: 1, type: 1 },
  { unique: true, partialFilterExpression: { isPrimary: true }, name: 'userId_type_primary_unique' }
);

const Photo = mongoose.models.Photo || mongoose.model('Photo', photoSchema);

module.exports = Photo;
