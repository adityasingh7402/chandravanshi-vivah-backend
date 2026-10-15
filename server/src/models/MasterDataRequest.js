'use strict';

/**
 * `master_data_requests` model (spec §14, §75; finalized decisions §3; step 05).
 *
 * The dedicated store behind the Gotra/Surname "request addition" workflow. A
 * user never writes an OFFICIAL master record; a missing value is recorded as a
 * user-contributed option in its own collection (immediately selectable) AND a
 * review row is opened here so an admin can verify, reject or merge it.
 *
 * `userId` is always the authenticated caller — the server stamps it from the
 * session, so a request body can never attribute a submission to someone else
 * (spec §75, gate G3.6).
 */

const mongoose = require('mongoose');
const { baseSchema } = require('./plugins/baseSchema');
const { COLLECTIONS } = require('../config/collections');
const { REQUEST_TYPES } = require('../constants/masterCategories');

const REQUEST_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);
const REQUEST_STATUS_VALUES = Object.freeze(['pending', 'approved', 'rejected']);

const masterDataRequestSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // Which community-context category the value belongs to.
    type: { type: String, enum: REQUEST_TYPES, required: true },

    requestedName: { type: String, required: true, trim: true },

    // The user-contributed row this request is about, and where it lives, so an
    // approval can promote exactly that row instead of guessing by name.
    masterItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
    masterCollection: { type: String, required: true, trim: true },

    // The parent scope the value was submitted in — never cross-merged.
    communityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', default: null },
    clanId: { type: mongoose.Schema.Types.ObjectId, ref: 'Clan', default: null },

    status: { type: String, enum: REQUEST_STATUS_VALUES, default: 'pending' },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reviewedAt: { type: Date, default: null },
    reviewNote: { type: String, default: null, trim: true }
  },
  { collection: COLLECTIONS.MASTER_DATA_REQUESTS }
);

masterDataRequestSchema.plugin(baseSchema);

// Admin review queue (step 16).
masterDataRequestSchema.index({ status: 1, createdAt: -1 });
// A user's own requests.
masterDataRequestSchema.index({ userId: 1, createdAt: -1 });
// Duplicate visibility: find earlier requests for the same pending name.
// Deliberately NOT unique — each submission is its own review row (step 05
// verification command 10 expects two review requests for one option).
masterDataRequestSchema.index({ type: 1, requestedName: 1, status: 1 });

const MasterDataRequest =
  mongoose.models.MasterDataRequest || mongoose.model('MasterDataRequest', masterDataRequestSchema);

module.exports = MasterDataRequest;
module.exports.REQUEST_STATUSES = REQUEST_STATUSES;
module.exports.REQUEST_STATUS_VALUES = REQUEST_STATUS_VALUES;
