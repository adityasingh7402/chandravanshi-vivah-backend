'use strict';

/**
 * Generic master-item model factory (spec §13, §105; step 05 task 1).
 *
 * Every master collection uses the same document shape (spec §13) plus a small
 * per-collection extra-field spec, so a new list is a descriptor entry in
 * `constants/masterData.js` and nothing else. All models inherit the step-02
 * base plugin: timestamps, `versionKey` off, `strict: true`, and an internal
 * field stripper.
 *
 * Two tiers live in one collection (step 05, decisions §3):
 *   official            source seed|admin, verifiedAt set
 *   user-contributed    source "user", submittedBy set, verifiedAt null
 *
 * Community-context collections are `scoped`: the same name in two contexts is
 * two rows, and the unique key is per parent scope, never global.
 */

const mongoose = require('mongoose');
const { baseSchema } = require('../plugins/baseSchema');
const { toSlug, normaliseName } = require('../../utils/slug');
const {
  MASTER_COLLECTIONS,
  MASTER_TYPE_VALUES
} = require('../../constants/masterData');

/** Where a master row came from. A request body can never set this (spec §75). */
const SOURCE_VALUES = Object.freeze(['seed', 'admin', 'user']);

/**
 * Build the Mongoose model for one master collection.
 *
 * @param {string} type a key of MASTER_COLLECTIONS
 * @returns {import('mongoose').Model}
 */
function createMasterModel(type) {
  const descriptor = MASTER_COLLECTIONS[type];
  if (!descriptor) throw new Error(`createMasterModel: unknown master type "${type}"`);

  const paths = {
    name: { type: String, required: true, trim: true, set: normaliseName },
    // Lower-cased mirror of `name`. The search runs an ANCHORED, case-sensitive
    // regex against this field so the planner can use the index (spec §82) —
    // a case-insensitive regex would force a COLLSCAN.
    nameLower: { type: String, required: true, internal: true },
    slug: { type: String, required: true, trim: true },
    category: { type: String, default: null, trim: true },
    isActive: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    ...descriptor.extraFields
  };

  if (descriptor.scoped) {
    Object.assign(paths, {
      // All three scope fields exist on every scoped model so the documented
      // compound unique index is uniform; only a meaningful one is ever set.
      communityId: { type: mongoose.Schema.Types.ObjectId, ref: 'Community', default: null },
      subCommunityId: { type: mongoose.Schema.Types.ObjectId, ref: 'SubCommunity', default: null },
      clanId: { type: mongoose.Schema.Types.ObjectId, ref: 'Clan', default: null },

      source: { type: String, enum: SOURCE_VALUES, default: 'seed' },
      // Internal: a client never sees who contributed a value, but an admin can
      // read it with an explicit projection (spec §75, gate G3.6).
      submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, internal: true },
      verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, internal: true },
      verifiedAt: { type: Date, default: null },
      // Alternate spellings resolve to ONE row, never a second option (§4.4).
      // Stored lower-cased so the alias lookup is a plain anchored match.
      aliases: { type: [String], default: [] }
    });
  }

  const schema = new mongoose.Schema(paths, { collection: descriptor.collection });
  schema.plugin(baseSchema);

  // Default ordering and search (spec §73, §105).
  schema.index({ nameLower: 1 });
  schema.index({ isActive: 1, sortOrder: 1 });

  // Cascading parent filters (spec §76, §105): a parent lookup must never be a
  // COLLSCAN. `communityId` is skipped when scoped because it already leads the
  // compound unique index.
  const parentFields = new Set();
  if (descriptor.cascadeParent) parentFields.add(descriptor.cascadeParent);
  for (const field of descriptor.filters || []) parentFields.add(field);
  for (const [field, definition] of Object.entries(descriptor.extraFields || {})) {
    if (definition && definition.ref) parentFields.add(field);
  }
  for (const field of parentFields) {
    if (descriptor.scoped && field === 'communityId') continue;
    schema.index({ [field]: 1 });
  }

  // Uniqueness is SCOPE-AWARE: the same name legitimately exists in more than
  // one context (a `Kashyap` gotra exists in three communities), so the unique
  // key is per parent scope, never global (step 05 index table).
  const uniqueWith = descriptor.uniqueWith || [];
  if (uniqueWith.length > 0) {
    schema.index({ ...Object.fromEntries(uniqueWith.map((field) => [field, 1])), slug: 1 }, { unique: true });
  } else {
    schema.index({ slug: 1 }, { unique: true });
  }

  if (descriptor.scoped) {
    schema.index({ aliases: 1 });
    // Verified values are listed ahead of user-contributed ones (task 14).
    schema.index({ communityId: 1, verifiedAt: 1, sortOrder: 1 });
  }

  /** The client-facing option shape. Exact fields only, so payloads stay small. */
  schema.methods.toOption = function toOption() {
    const option = {
      _id: this._id.toString(),
      name: this.name,
      slug: this.slug,
      isActive: this.isActive,
      sortOrder: this.sortOrder
    };
    if (this.category !== undefined) option.category = this.category ?? null;
    for (const field of ['communityId', 'subCommunityId', 'clanId']) {
      if (this.schema.path(field)) option[field] = this[field] ? this[field].toString() : null;
    }
    if (this.schema.path('degreeId')) option.degreeId = this.degreeId ? this.degreeId.toString() : null;
    if (this.schema.path('countryId')) option.countryId = this.countryId ? this.countryId.toString() : null;
    if (this.schema.path('stateId')) option.stateId = this.stateId ? this.stateId.toString() : null;
    if (this.schema.path('districtId')) option.districtId = this.districtId ? this.districtId.toString() : null;
    if (this.schema.path('coordinates')) {
      option.coordinates = this.coordinates
        ? { lat: this.coordinates.lat ?? null, lng: this.coordinates.lng ?? null }
        : null;
    }
    if (this.schema.path('source')) {
      // Origin is a server-stamped flag, never a client field (spec §35).
      option.isUserContributed = this.source === 'user';
      option.verifiedAt = this.verifiedAt || null;
    }
    return option;
  };

  return mongoose.models[descriptor.model] || mongoose.model(descriptor.model, schema);
}

/**
 * Compute the derived identity fields for a master row.
 *
 * Done here rather than in a Mongoose hook so create, update and upsert all
 * agree, and so the seeder and the API cannot drift.
 *
 * @param {string} type
 * @param {{name: string}} input
 */
function buildMasterIdentity(type, input) {
  const name = normaliseName(input.name);
  const slug = input.slug ? toSlug(input.slug) : toSlug(name);
  return { name, slug, nameLower: name.toLowerCase() };
}

/** `{ type -> model }` for every registered master collection. */
const MASTER_MODELS = Object.freeze(
  Object.fromEntries(MASTER_TYPE_VALUES.map((type) => [type, createMasterModel(type)]))
);

/** The model for a known type, or `null`. */
function getMasterModel(type) {
  return MASTER_MODELS[type] || null;
}

module.exports = {
  createMasterModel,
  buildMasterIdentity,
  getMasterModel,
  MASTER_MODELS,
  SOURCE_VALUES
};
