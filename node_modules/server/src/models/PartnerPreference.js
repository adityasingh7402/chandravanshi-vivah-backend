'use strict';

/**
 * `partner_preferences` model (spec §3.3, §16, §62, §97, §105; finalized
 * decisions §4, §5; step 07 task 1).
 *
 * Answers a different question from `matrimonial_profiles`:
 *
 *   MatrimonialProfile = who am I?
 *   PartnerPreference  = who am I looking for?
 *
 * **Every field is optional, and that is the feature** (spec §16). A user may
 * save an age range now and locations later, so absent means "no preference on
 * this dimension" — the client, not the schema, decides what to fill in. Step 09
 * must therefore treat an absent value as *do not filter*, never as *match
 * nothing*, which is why the model stores no sentinel "any" values.
 *
 * The only non-optional field is `userId`, whose unique index makes "one
 * preference document per account" a database rule rather than a service
 * convention.
 *
 * Enum ownership: every fixed set is imported from `constants/preference.js`, so
 * the schema, the validators and the effective-filter builder share one
 * definition. Mongoose enforces them a second time — belt and braces, because a
 * service bug must not be able to store a value no client can read back.
 */

const mongoose = require('mongoose');
const { baseSchema } = require('./plugins/baseSchema');
const { COLLECTIONS } = require('../config/collections');
const {
  PREFERENCE_ENUM_FIELDS,
  AGE_BOUNDS,
  HEIGHT_BOUNDS,
  defaultAgeRange
} = require('../constants/preference');

const { ObjectId } = mongoose.Schema.Types;

/**
 * A bounded whole number, or null.
 *
 * The whole-number rule is an explicit validator rather than the `integer` path
 * option: the option is not enforced by the Mongoose version in use (verified —
 * `20.5` passes schema validation), so relying on it would silently accept a
 * fractional age. `null` means "this bound is not set" and must stay valid.
 */
const rangeNumber = (min, max) => ({
  type: Number,
  default: null,
  min,
  max,
  validate: {
    validator: (value) => value === null || Number.isInteger(value),
    message: 'must be a whole number.'
  }
});

const rangeSchema = (min, max, defaults) =>
  new mongoose.Schema(
    {
      min: { ...rangeNumber(min, max), default: defaults.min },
      max: { ...rangeNumber(min, max), default: defaults.max }
    },
    { _id: false }
  );

/** A multi-select enum array: capped in the validator, enums enforced here too. */
function enumArray(field) {
  return { type: [String], enum: PREFERENCE_ENUM_FIELDS[field].values, default: [] };
}

/** A single-value enum field, nullable so it can be cleared explicitly. */
function enumScalar(field) {
  return { type: String, enum: PREFERENCE_ENUM_FIELDS[field].values, default: null };
}

const partnerPreferenceSchema = new mongoose.Schema(
  {
    userId: { type: ObjectId, ref: 'User', required: true },

    // Preferred age range. There is deliberately NO stored `age` number: the
    // range is kept as-is and step 09 converts it to a date-of-birth range at
    // query time (spec §47, task 9).
    age: { type: rangeSchema(AGE_BOUNDS.min, AGE_BOUNDS.max, defaultAgeRange()), default: () => defaultAgeRange() },
    // Nullable upper/lower bounds: "no height preference" is expressed by null,
    // never by a sentinel number.
    heightCm: {
      type: rangeSchema(HEIGHT_BOUNDS.min, HEIGHT_BOUNDS.max, { min: null, max: null }),
      default: null
    },

    gender: enumScalar('gender'),
    maritalStatus: enumArray('maritalStatus'),
    childrenPreference: enumScalar('childrenPreference'),

    // Master references (spec §97). Ids only — step 09 joins nothing, and the
    // client already holds the master lists in its own cache (spec §60).
    educationIds: { type: [ObjectId], ref: 'Degree', default: [] },
    occupationIds: { type: [ObjectId], ref: 'Occupation', default: [] },
    industryIds: { type: [ObjectId], ref: 'Industry', default: [] },

    incomeRanges: enumArray('incomeRanges'),

    countryIds: { type: [ObjectId], ref: 'Country', default: [] },
    stateIds: { type: [ObjectId], ref: 'State', default: [] },
    cityIds: { type: [ObjectId], ref: 'City', default: [] },

    motherTongueIds: { type: [ObjectId], ref: 'Language', default: [] },

    // Community context. The scoped arrays are validated against `communityIds`
    // so a value from another community is rejected (community-format scoping).
    communityIds: { type: [ObjectId], ref: 'Community', default: [] },
    subCommunityIds: { type: [ObjectId], ref: 'SubCommunity', default: [] },
    surnameIds: { type: [ObjectId], ref: 'Surname', default: [] },
    gotraIds: { type: [ObjectId], ref: 'Gotra', default: [] },

    diet: enumArray('diet'),
    smoking: enumArray('smoking'),
    drinking: enumArray('drinking'),
    familyTypes: enumArray('familyTypes'),

    workingPreference: enumScalar('workingPreference'),
    // FINAL: a 3-value enum, not the boolean spec §16 sketched (decisions §4).
    horoscopeRequired: enumScalar('horoscopeRequired'),
    manglikPreference: enumArray('manglikPreference'),
    relocationPreference: enumScalar('relocationPreference')
  },
  { collection: COLLECTIONS.PARTNER_PREFERENCES }
);

partnerPreferenceSchema.plugin(baseSchema);

// Spec §105 / step 07 index table: exactly one preference document per account.
partnerPreferenceSchema.index({ userId: 1 }, { unique: true });

// `find({ userId })` is the only read pattern this step has, so no second index
// is added: step 09 owns candidate-filter indexes and creates them from measured
// query patterns rather than guesses (spec §49, §50).

const PartnerPreference =
  mongoose.models.PartnerPreference || mongoose.model('PartnerPreference', partnerPreferenceSchema);

module.exports = PartnerPreference;
module.exports.ENUM_FIELDS = PREFERENCE_ENUM_FIELDS;
