'use strict';

/**
 * Master-data registry (spec §12, §13, §73, §74, §82, §102, §127; step 05).
 *
 * This module is PURE DATA: it describes every master collection — its
 * collection name, model name, extra fields, parent/scope fields and which
 * query parameters are legal — but it never assembles a Mongoose model.
 * `models/masterData/MasterItem.js` reads these descriptors to build the models,
 * which keeps constants -> models a one-way dependency.
 *
 * The registry is an allowlist. A request `:type` that is not a key here is
 * rejected with 404, so no request can ever reach `users`, `sessions` or any
 * other collection (spec §35, gate G3.1).
 */

const mongoose = require('mongoose');
const { COLLECTIONS } = require('../config/collections');

const { ObjectId } = mongoose.Schema.Types;

/** The community-context scope fields. Every scoped model carries all three. */
const SCOPE_FIELDS = Object.freeze(['communityId', 'subCommunityId', 'clanId']);

/** A scoped model's unique key: one row per name per context (spec §4.4). */
const SCOPED_SLUG_INDEX_NAME = 'communityId_1_subCommunityId_1_clanId_1_slug_1';

/**
 * Per-collection descriptors.
 *
 * `collection`    the canonical collection name from config/collections.js.
 * `scoped`        community-context collection: carries the official/user tier
 *                 fields (`source`, `submittedBy`, `verifiedBy`, `verifiedAt`,
 *                 `aliases`) and a parent-scoped unique slug.
 * `cascadeParent` the field `?parentId=` maps to (country -> state, etc.).
 * `filters`       additional ObjectId fields accepted by name, e.g. `?clanId=`.
 * `extraFields`   Mongoose path definitions layered on the generic schema.
 */
const MASTER_COLLECTIONS = Object.freeze({
  communities: {
    collection: COLLECTIONS.COMMUNITIES,
    label: 'Community',
    model: 'Community',
    scoped: false,
    cascadeParent: null,
    uniqueWith: Object.freeze([]),
    filters: Object.freeze([]),
    extraFields: Object.freeze({}),
    userInputtable: false,
    searchable: true
  },
  sub_communities: {
    collection: COLLECTIONS.SUB_COMMUNITIES,
    label: 'Sub-community',
    model: 'SubCommunity',
    scoped: true,
    cascadeParent: 'communityId',
    uniqueWith: SCOPE_FIELDS,
    filters: Object.freeze([]),
    extraFields: Object.freeze({}),
    userInputtable: true,
    searchable: true
  },
  surnames: {
    collection: COLLECTIONS.SURNAMES,
    label: 'Surname',
    model: 'Surname',
    scoped: true,
    cascadeParent: 'communityId',
    uniqueWith: SCOPE_FIELDS,
    filters: Object.freeze([]),
    extraFields: Object.freeze({}),
    userInputtable: true,
    searchable: true
  },
  gotras: {
    collection: COLLECTIONS.GOTRAS,
    label: 'Gotra',
    model: 'Gotra',
    scoped: true,
    cascadeParent: 'communityId',
    uniqueWith: SCOPE_FIELDS,
    // A clan may map to specific gotras (community format -> clan -> gotra).
    filters: Object.freeze(['clanId']),
    extraFields: Object.freeze({}),
    userInputtable: true,
    searchable: true
  },
  clans: {
    collection: COLLECTIONS.CLANS,
    label: 'Clan',
    model: 'Clan',
    scoped: true,
    cascadeParent: 'communityId',
    uniqueWith: SCOPE_FIELDS,
    filters: Object.freeze([]),
    // A clan may map to specific gotras (community format). This is the
    // many-to-many side of the mapping: one clan -> many gotras.
    extraFields: Object.freeze({ gotraIds: { type: [ObjectId], ref: 'Gotra', default: [] } }),
    userInputtable: true,
    searchable: true
  },
  aaspads: {
    collection: COLLECTIONS.AASPADS,
    label: 'Aaspad',
    model: 'Aaspad',
    scoped: true,
    cascadeParent: 'communityId',
    uniqueWith: SCOPE_FIELDS,
    filters: Object.freeze([]),
    extraFields: Object.freeze({}),
    userInputtable: true,
    searchable: true
  },
  occupations: {
    collection: COLLECTIONS.OCCUPATIONS,
    label: 'Occupation',
    model: 'Occupation',
    scoped: false,
    cascadeParent: null,
    uniqueWith: Object.freeze([]),
    filters: Object.freeze([]),
    extraFields: Object.freeze({ category: { type: String, default: null, trim: true } }),
    userInputtable: false,
    searchable: true
  },
  industries: {
    collection: COLLECTIONS.INDUSTRIES,
    label: 'Industry',
    model: 'Industry',
    scoped: false,
    cascadeParent: null,
    uniqueWith: Object.freeze([]),
    filters: Object.freeze([]),
    extraFields: Object.freeze({}),
    userInputtable: false,
    searchable: true
  },
  degrees: {
    collection: COLLECTIONS.DEGREES,
    label: 'Degree',
    model: 'Degree',
    scoped: false,
    cascadeParent: null,
    uniqueWith: Object.freeze([]),
    filters: Object.freeze([]),
    extraFields: Object.freeze({}),
    userInputtable: false,
    searchable: true
  },
  specializations: {
    collection: COLLECTIONS.SPECIALIZATIONS,
    label: 'Specialization',
    model: 'Specialization',
    scoped: false,
    cascadeParent: 'degreeId',
    // A specialization belongs to one degree, so the same name legitimately
    // exists under several degrees (dependent dropdown, fields dictionary §6.3).
    uniqueWith: Object.freeze(['degreeId']),
    filters: Object.freeze([]),
    extraFields: Object.freeze({
      degreeId: { type: ObjectId, ref: 'Degree', default: null },
      category: { type: String, default: null, trim: true }
    }),
    userInputtable: false,
    searchable: true
  },
  colleges: {
    collection: COLLECTIONS.COLLEGES,
    label: 'College',
    model: 'College',
    scoped: false,
    cascadeParent: null,
    uniqueWith: Object.freeze([]),
    filters: Object.freeze([]),
    extraFields: Object.freeze({}),
    userInputtable: false,
    searchable: true
  },
  universities: {
    collection: COLLECTIONS.UNIVERSITIES,
    label: 'University',
    model: 'University',
    scoped: false,
    cascadeParent: null,
    uniqueWith: Object.freeze([]),
    filters: Object.freeze([]),
    extraFields: Object.freeze({}),
    userInputtable: false,
    searchable: true
  },
  countries: {
    collection: COLLECTIONS.COUNTRIES,
    label: 'Country',
    model: 'Country',
    scoped: false,
    cascadeParent: null,
    uniqueWith: Object.freeze([]),
    filters: Object.freeze([]),
    extraFields: Object.freeze({}),
    userInputtable: false,
    searchable: true
  },
  states: {
    collection: COLLECTIONS.STATES,
    label: 'State',
    model: 'State',
    scoped: false,
    cascadeParent: 'countryId',
    uniqueWith: Object.freeze(['countryId']),
    filters: Object.freeze([]),
    extraFields: Object.freeze({ countryId: { type: ObjectId, ref: 'Country', default: null } }),
    userInputtable: false,
    searchable: true
  },
  districts: {
    collection: COLLECTIONS.DISTRICTS,
    label: 'District',
    model: 'District',
    scoped: false,
    cascadeParent: 'stateId',
    uniqueWith: Object.freeze(['stateId']),
    filters: Object.freeze([]),
    extraFields: Object.freeze({ stateId: { type: ObjectId, ref: 'State', default: null } }),
    userInputtable: false,
    searchable: true
  },
  cities: {
    collection: COLLECTIONS.CITIES,
    label: 'City',
    model: 'City',
    scoped: false,
    cascadeParent: 'districtId',
    uniqueWith: Object.freeze(['districtId']),
    filters: Object.freeze([]),
    extraFields: Object.freeze({
      districtId: { type: ObjectId, ref: 'District', default: null },
      // Coordinates support distance search later (spec §76); never an address.
      coordinates: {
        type: new mongoose.Schema(
          { lat: { type: Number, default: null }, lng: { type: Number, default: null } },
          { _id: false }
        ),
        default: null
      }
    }),
    userInputtable: false,
    searchable: true
  },
  languages: {
    collection: COLLECTIONS.LANGUAGES,
    label: 'Language',
    model: 'Language',
    scoped: false,
    cascadeParent: null,
    uniqueWith: Object.freeze([]),
    filters: Object.freeze([]),
    extraFields: Object.freeze({}),
    userInputtable: false,
    searchable: true
  },
  hobbies: {
    collection: COLLECTIONS.HOBBIES,
    label: 'Hobby',
    model: 'Hobby',
    scoped: false,
    cascadeParent: null,
    uniqueWith: Object.freeze([]),
    filters: Object.freeze([]),
    extraFields: Object.freeze({}),
    userInputtable: false,
    searchable: true
  },
  interests: {
    collection: COLLECTIONS.INTERESTS,
    label: 'Interest',
    model: 'Interest',
    scoped: false,
    cascadeParent: null,
    uniqueWith: Object.freeze([]),
    filters: Object.freeze([]),
    extraFields: Object.freeze({}),
    userInputtable: false,
    searchable: true
  }
});

/** Every known `:type` value, in declaration order. */
const MASTER_TYPE_VALUES = Object.freeze(Object.keys(MASTER_COLLECTIONS));

/** Every master collection name, in declaration order. */
const MASTER_COLLECTION_NAMES = Object.freeze(
  MASTER_TYPE_VALUES.map((type) => MASTER_COLLECTIONS[type].collection)
);

/** True when `type` is a known master-data collection (allowlist check). */
function isMasterType(type) {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(MASTER_COLLECTIONS, type);
}

/** Descriptor for a known type, or `undefined`. */
function getMasterDescriptor(type) {
  return isMasterType(type) ? MASTER_COLLECTIONS[type] : undefined;
}

/**
 * Query parameters a request may supply for a type. Everything else is ignored,
 * so `Model.find(req.query)` can never happen (spec §35).
 */
function allowedFilterParams(type) {
  const descriptor = getMasterDescriptor(type);
  if (!descriptor) return Object.freeze([]);
  const params = new Set();
  if (descriptor.cascadeParent) {
    params.add(descriptor.cascadeParent);
    // `parentId` is the generic alias for the cascade parent.
    params.add('parentId');
  }
  for (const field of descriptor.filters) params.add(field);
  // A scoped collection can always be filtered by its own community scope.
  if (descriptor.scoped) params.add('communityId');
  return Object.freeze([...params]);
}

/** Default ordering for a listing: curated order, then name (spec §73). */
const MASTER_DEFAULT_SORT = Object.freeze({ sortOrder: 1, nameLower: 1 });

module.exports = {
  MASTER_COLLECTIONS,
  MASTER_TYPE_VALUES,
  MASTER_COLLECTION_NAMES,
  SCOPE_FIELDS,
  SCOPED_SLUG_INDEX_NAME,
  MASTER_DEFAULT_SORT,
  isMasterType,
  getMasterDescriptor,
  allowedFilterParams
};
