'use strict';

/**
 * `matrimonial_profiles` model (spec §3.3, §8, §9, §10, §30, §97, §105).
 *
 * The single collection Discover queries. Searchable relationships are embedded
 * as IDs so a filter never has to read another collection (spec §9), and a small
 * `*Name` copy sits beside each `*Id` purely for display without a join
 * (spec §10). The master-data record stays the source of truth.
 *
 * **Drafts are legitimate documents.** Every profile section is nullable at the
 * schema level, because step 06 must let an onboarding draft be saved half-finished
 * and resumed (spec §92). Requiredness is enforced by the completion score and by
 * the `draft -> active` gate, not by `required: true` — otherwise no partial draft
 * could ever be persisted.
 *
 * Fields marked `internal: true` are stripped from any raw `toJSON`/`toObject`
 * output, so a careless `res.json(document)` cannot leak exact coordinates or a
 * birth time. The DTO layer builds its own objects either way (spec §30, §59).
 */

const mongoose = require('mongoose');
const { baseSchema } = require('./plugins/baseSchema');
const { COLLECTIONS } = require('../config/collections');
const { PROFILE_STATUSES, ENUMS } = require('../constants/profile');

const { ObjectId } = mongoose.Schema.Types;

const numOrNull = { type: Number, default: null };
const strOrNull = { type: String, default: null, trim: true };
const idOrNull = { type: ObjectId, default: null };
/** A denormalised display name, always written from the referenced master row. */
const nameOrNull = { type: String, default: null, trim: true };

const matrimonialProfileSchema = new mongoose.Schema(
  {
    // One profile per account; the unique index is the enforcement.
    userId: { type: ObjectId, ref: 'User', required: true },
    // Human-facing identifier (spec §113). Unique, never an ObjectId.
    publicProfileId: { type: String, required: true, trim: true },

    basic: {
      profileFor: { type: String, enum: ENUMS.profileFor, default: null },
      firstName: strOrNull,
      middleName: strOrNull,
      lastName: strOrNull,
      gender: { type: String, enum: ENUMS.gender, default: null },
      // Never stored as age: age is derived from this at read time (spec §47).
      dateOfBirth: { type: Date, default: null },
      maritalStatus: { type: String, enum: ENUMS.maritalStatus, default: null },
      heightCm: numOrNull
    },

    community: {
      communityId: idOrNull,
      subCommunityId: idOrNull,
      surnameId: idOrNull,
      surnameName: nameOrNull,
      gotraId: idOrNull,
      gotraName: nameOrNull,
      clanId: idOrNull,
      clanName: nameOrNull,
      aaspadId: idOrNull,
      aaspadName: nameOrNull,
      motherTongueId: idOrNull,
      motherTongueName: nameOrNull,
      religion: { type: String, enum: ENUMS.religion, default: null }
    },

    location: {
      countryId: idOrNull,
      stateId: idOrNull,
      districtId: idOrNull,
      cityId: idOrNull,
      countryName: nameOrNull,
      stateName: nameOrNull,
      districtName: nameOrNull,
      cityName: nameOrNull,
      // Privacy: coordinates are for proximity search on the server only, never
      // a public field (spec §48, §76, §112). Stripped from raw serialisations.
      coordinates: {
        type: new mongoose.Schema(
          { type: { type: String, enum: ['Point'], default: 'Point' }, coordinates: { type: [Number], default: undefined } },
          { _id: false }
        ),
        default: null,
        internal: true
      }
    },

    education: {
      highestQualificationId: idOrNull,
      degreeId: idOrNull,
      degreeName: nameOrNull,
      specializationId: idOrNull,
      specializationName: nameOrNull,
      collegeId: idOrNull,
      universityId: idOrNull,
      universityName: nameOrNull,
      graduationYear: numOrNull
    },

    career: {
      occupationId: idOrNull,
      occupationName: nameOrNull,
      industryId: idOrNull,
      industryName: nameOrNull,
      employmentType: { type: String, enum: ENUMS.employmentType, default: null },
      company: strOrNull,
      designation: strOrNull,
      workLocation: strOrNull,
      experienceYears: numOrNull,
      incomeRange: { type: String, enum: ENUMS.incomeRange, default: null }
    },

    family: {
      familyType: { type: String, enum: ENUMS.familyType, default: null },
      familyStatus: { type: String, enum: ENUMS.familyStatus, default: null },
      fatherOccupation: strOrNull,
      motherOccupation: strOrNull,
      brothersCount: { type: Number, default: 0 },
      marriedBrothersCount: { type: Number, default: 0 },
      sistersCount: { type: Number, default: 0 },
      marriedSistersCount: { type: Number, default: 0 },
      familyLocation: strOrNull
    },

    lifestyle: {
      diet: { type: String, enum: ENUMS.diet, default: null },
      dietOther: strOrNull,
      smoking: { type: String, enum: ENUMS.smoking, default: null },
      drinking: { type: String, enum: ENUMS.drinking, default: null },
      fitness: { type: String, enum: ENUMS.fitness, default: null },
      pets: { type: String, enum: ENUMS.pets, default: null }
    },

    personal: {
      hobbies: { type: [ObjectId], ref: 'Hobby', default: [] },
      interests: { type: [ObjectId], ref: 'Interest', default: [] },
      languages: { type: [ObjectId], ref: 'Language', default: [] }
    },

    horoscope: {
      available: { type: Boolean, default: false },
      // Restricted: exact birth time/place are not public (fields dictionary §26).
      birthTime: { type: Date, default: null, internal: true },
      birthPlace: { type: String, default: null, trim: true, internal: true },
      rashi: strOrNull,
      nakshatra: strOrNull,
      manglik: { type: String, enum: ENUMS.manglik, default: null }
    },

    marriage: {
      hasChildren: { type: Boolean, default: null },
      childrenCount: numOrNull,
      wantsChildren: { type: String, enum: ENUMS.wantsChildren, default: null }
    },

    about: {
      headline: strOrNull,
      description: strOrNull
    },

    profile: {
      status: { type: String, enum: PROFILE_STATUSES, default: 'draft' },
      completionPercentage: { type: Number, default: 0, min: 0, max: 100 },
      isVerified: { type: Boolean, default: false },
      lastActiveAt: { type: Date, default: null },
      // Step 09 — the one denormalised discovery signal (spec §10, §46, §51).
      // It is `true` when the account has a primary photo a moderator has
      // APPROVED, which is exactly the condition a discovery card's `primaryPhoto`
      // needs (spec §101). It is maintained by `services/photoService` on every
      // primary/approval-affecting write, so the `hasPhoto` filter can be answered
      // from this collection instead of joining `photos` per request (§82 item 4).
      // Moderation (step 16) must call `profileScoreService.syncDiscoveryPhotoFlag`
      // after changing `moderationStatus`.
      hasPrimaryPhoto: { type: Boolean, default: false }
    }
  },
  { collection: COLLECTIONS.MATRIMONIAL_PROFILES }
);

matrimonialProfileSchema.plugin(baseSchema);

// --- Uniqueness ------------------------------------------------------------
matrimonialProfileSchema.index({ userId: 1 }, { unique: true });
matrimonialProfileSchema.index({ publicProfileId: 1 }, { unique: true });

// --- Discover filters (spec §105) ------------------------------------------
matrimonialProfileSchema.index({ 'profile.status': 1 });
matrimonialProfileSchema.index({ 'profile.lastActiveAt': -1 });
matrimonialProfileSchema.index({ 'basic.gender': 1, 'basic.dateOfBirth': -1 });
matrimonialProfileSchema.index({ 'basic.maritalStatus': 1 });
matrimonialProfileSchema.index({ 'community.communityId': 1 });
matrimonialProfileSchema.index({ 'community.gotraId': 1 });
matrimonialProfileSchema.index({ 'community.surnameId': 1 });
// Clan and aaspad are their own categories, never a gotra (step 05).
matrimonialProfileSchema.index({ 'community.clanId': 1 });
matrimonialProfileSchema.index({ 'community.aaspadId': 1 });
matrimonialProfileSchema.index({ 'location.stateId': 1, 'location.cityId': 1 });
matrimonialProfileSchema.index({ 'career.occupationId': 1 });
matrimonialProfileSchema.index({ 'education.degreeId': 1 });
// Distance search (spec §48). The index key must be the GeoJSON value itself —
// indexing the whole `location` subdocument asks MongoDB to treat an object with
// a `cityId` as GeoJSON and every insert fails with "unknown GeoJSON type".
// The spec's index name (§105) is kept explicit.
matrimonialProfileSchema.index({ 'location.coordinates': '2dsphere' }, { name: 'location_2dsphere' });

// --- Discover compound indexes (step 09; spec §49, §50, §105) --------------
//
// Each one serves a query the discover/search path actually issues, and each was
// confirmed with `explain("executionStats")` (see `tests/search.test.js` and
// `verify-step09.mjs`). The single-field §105 indexes above stay: they still
// serve their own narrow queries (status-only counts, gotra lookup), and one
// giant compound index is explicitly an anti-pattern (spec §49).
//
// Default discover: active + gender + age range (spec §119's documented request).
matrimonialProfileSchema.index({ 'profile.status': 1, 'basic.gender': 1, 'basic.dateOfBirth': 1 });
// Location-filtered discover.
matrimonialProfileSchema.index({ 'profile.status': 1, 'basic.gender': 1, 'location.cityId': 1 });
// Occupation-filtered discover.
matrimonialProfileSchema.index({ 'profile.status': 1, 'basic.gender': 1, 'career.occupationId': 1 });
// Community (gotra) filter.
matrimonialProfileSchema.index({ 'profile.status': 1, 'community.gotraId': 1 });
// The recency sort (the default ordering and the recommendation candidate window).
matrimonialProfileSchema.index({ 'profile.status': 1, 'profile.lastActiveAt': -1 });

/**
 * Only `active` profiles may be returned by a public read (spec §58).
 * Expressed as a query helper so every read path uses the same predicate.
 */
function publicVisibilityFilter() {
  return { 'profile.status': 'active' };
}

const MatrimonialProfile =
  mongoose.models.MatrimonialProfile || mongoose.model('MatrimonialProfile', matrimonialProfileSchema);

module.exports = MatrimonialProfile;
module.exports.publicVisibilityFilter = publicVisibilityFilter;
