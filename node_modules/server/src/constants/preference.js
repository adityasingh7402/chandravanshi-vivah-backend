'use strict';

/**
 * Partner-preference constants (spec §16, §81, §97; fields dictionary §15;
 * finalized decisions §4, §5; step 07 tasks 2, 6, 9).
 *
 * The rule this module exists to enforce: **one definition per value set**. The
 * Mongoose schema, the request validators, the effective-filter builder and the
 * completion scorer all read the arrays below, so a value can never be accepted
 * by one layer and rejected by another.
 *
 * The three sets the fields dictionary left open (§15.21, §15.22, §15.24) are
 * FINAL in the decisions document, so they are declared here rather than flagged
 * as placeholders:
 *
 *   workingPreference      Working / Not Working / Either
 *   horoscopeRequired      Required / Preferred / Not Important   (NOT a boolean)
 *   relocationPreference   Yes / No / Maybe
 *
 * `childrenPreference` is typed `String | null` by spec §16 but neither document
 * lists its options, so it reuses the profile's documented `wantsChildren` set
 * (Yes / No / Maybe) instead of inventing a new one; that is recorded as an open
 * product question in the progress tracker.
 */

const config = require('../config/env');
const { ENUMS } = require('./profile');

/** Finalized decisions §4. Lowercase frontend-enum style, like every other set. */
const WORKING_PREFERENCE = Object.freeze(['working', 'not_working', 'either']);
const HOROSCOPE_REQUIRED = Object.freeze(['required', 'preferred', 'not_important']);
const RELOCATION_PREFERENCE = Object.freeze(['yes', 'no', 'maybe']);

/** Spec §16 types this as a string with no option list — reuse the profile set. */
const CHILDREN_PREFERENCE = ENUMS.wantsChildren;

/**
 * Every preference field whose value is (or contains) one of a fixed set.
 * `multiSelect: true` means a capped array of values, otherwise a single value.
 */
const PREFERENCE_ENUM_FIELDS = Object.freeze({
  gender: Object.freeze({ values: ENUMS.gender, multiSelect: false }),
  maritalStatus: Object.freeze({ values: ENUMS.maritalStatus, multiSelect: true }),
  childrenPreference: Object.freeze({ values: CHILDREN_PREFERENCE, multiSelect: false }),
  incomeRanges: Object.freeze({ values: ENUMS.incomeRange, multiSelect: true }),
  diet: Object.freeze({ values: ENUMS.diet, multiSelect: true }),
  smoking: Object.freeze({ values: ENUMS.smoking, multiSelect: true }),
  drinking: Object.freeze({ values: ENUMS.drinking, multiSelect: true }),
  familyTypes: Object.freeze({ values: ENUMS.familyType, multiSelect: true }),
  workingPreference: Object.freeze({ values: WORKING_PREFERENCE, multiSelect: false }),
  horoscopeRequired: Object.freeze({ values: HOROSCOPE_REQUIRED, multiSelect: false }),
  manglikPreference: Object.freeze({ values: ENUMS.manglik, multiSelect: true }),
  relocationPreference: Object.freeze({ values: RELOCATION_PREFERENCE, multiSelect: false })
});

/** Field names of the multi-select enum arrays (capped, like the id arrays). */
const PREFERENCE_ENUM_ARRAY_FIELDS = Object.freeze(
  Object.entries(PREFERENCE_ENUM_FIELDS)
    .filter(([, definition]) => definition.multiSelect)
    .map(([field]) => field)
);

/** Field names of the single-value enum fields. */
const PREFERENCE_SCALAR_ENUM_FIELDS = Object.freeze(
  Object.entries(PREFERENCE_ENUM_FIELDS)
    .filter(([, definition]) => !definition.multiSelect)
    .map(([field]) => field)
);

/**
 * Every `*Ids` field a client may send, the master collection it must exist in
 * (step 05 allowlist), and — for the community-context collections — the field
 * holding the chosen communities the value must belong to.
 *
 * The ids are validated with step 05's `validateIds()` (exists, active, right
 * collection); `scopedBy` adds the extra rule this step needs: a Kahar clan can
 * never be stored as a Yadav gotra (community-format scoping).
 */
const PREFERENCE_MASTER_ARRAYS = Object.freeze([
  Object.freeze({ field: 'educationIds', type: 'degrees' }),
  Object.freeze({ field: 'occupationIds', type: 'occupations' }),
  Object.freeze({ field: 'industryIds', type: 'industries' }),
  Object.freeze({ field: 'countryIds', type: 'countries' }),
  Object.freeze({ field: 'stateIds', type: 'states' }),
  Object.freeze({ field: 'cityIds', type: 'cities' }),
  Object.freeze({ field: 'motherTongueIds', type: 'languages' }),
  Object.freeze({ field: 'communityIds', type: 'communities' }),
  Object.freeze({ field: 'subCommunityIds', type: 'sub_communities', scopedBy: 'communityIds' }),
  Object.freeze({ field: 'surnameIds', type: 'surnames', scopedBy: 'communityIds' }),
  Object.freeze({ field: 'gotraIds', type: 'gotras', scopedBy: 'communityIds' })
]);

/** Every `*Ids` field name, in declaration order. */
const PREFERENCE_ID_ARRAY_FIELDS = Object.freeze(PREFERENCE_MASTER_ARRAYS.map((entry) => entry.field));

/** The two range sections, which carry a `min <= max` rule. */
const PREFERENCE_RANGE_FIELDS = Object.freeze(['age', 'heightCm']);

/**
 * The completion scorer's view of this document (§57; step 07 task 7).
 *
 * Deliberately a small, stable subset: the dimensions a user is expected to set
 * on the preference screen. Filling every one of them makes the section score
 * its full weight.
 */
const PREFERENCE_COMPLETION_FIELDS = Object.freeze([
  'age.min',
  'age.max',
  'gender',
  'maritalStatus',
  'educationIds',
  'occupationIds',
  'incomeRanges',
  'cityIds',
  'communityIds',
  'diet'
]);

/**
 * Every field the document carries, in a stable order. Derived from the groups
 * above rather than written out again, so adding an enum or an id array cannot
 * leave the merge, the DTO and the filter builder disagreeing about the shape
 * (they all iterate this list).
 */
const PREFERENCE_FIELD_NAMES = Object.freeze([
  ...new Set([
    ...PREFERENCE_RANGE_FIELDS,
    ...PREFERENCE_SCALAR_ENUM_FIELDS,
    ...PREFERENCE_ENUM_ARRAY_FIELDS,
    ...PREFERENCE_ID_ARRAY_FIELDS
  ])
]);

/**
 * `effectiveFilters()` output keys — an allowlist, never a spread of the
 * document (spec §35, gate G4.3). It is exactly the document's field set, and
 * nothing more can ever be emitted.
 */
const EFFECTIVE_FILTER_KEYS = PREFERENCE_FIELD_NAMES;

/** The ages a preference range may cover (spec §81 — the platform-wide bounds). */
const AGE_BOUNDS = Object.freeze({ min: config.profile.minAge, max: config.profile.maxAge });

/** The heights a preference range may cover. */
const HEIGHT_BOUNDS = Object.freeze({ min: config.profile.minHeightCm, max: config.profile.maxHeightCm });

/**
 * The range a brand-new preference document starts with when the client sends
 * no `age` at all (task 2 — configured, never hardcoded).
 */
function defaultAgeRange() {
  return { min: config.preference.minAgeDefault, max: config.preference.maxAgeDefault };
}

/** Per-field cap for every multi-select array (spec §80, gate G4.2). */
function maxMultiSelect() {
  return config.preference.maxMultiSelect;
}

/** The opposite gender, used as the preference default (decisions §5). */
function oppositeGender(gender) {
  if (gender === 'male') return 'female';
  if (gender === 'female') return 'male';
  return null;
}

module.exports = {
  WORKING_PREFERENCE,
  HOROSCOPE_REQUIRED,
  RELOCATION_PREFERENCE,
  CHILDREN_PREFERENCE,
  PREFERENCE_ENUM_FIELDS,
  PREFERENCE_ENUM_ARRAY_FIELDS,
  PREFERENCE_SCALAR_ENUM_FIELDS,
  PREFERENCE_MASTER_ARRAYS,
  PREFERENCE_ID_ARRAY_FIELDS,
  PREFERENCE_RANGE_FIELDS,
  PREFERENCE_COMPLETION_FIELDS,
  PREFERENCE_FIELD_NAMES,
  EFFECTIVE_FILTER_KEYS,
  AGE_BOUNDS,
  HEIGHT_BOUNDS,
  defaultAgeRange,
  maxMultiSelect,
  oppositeGender
};
