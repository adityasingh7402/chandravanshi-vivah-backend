'use strict';

/**
 * Discover / search constants (spec §45, §46, §49, §51, §52, §53, §54, §70, §82,
 * §108, §119; step 09 tasks 1, 2, 12).
 *
 * The rule this module exists to enforce is the same one step 05 applied to
 * master data and step 07 to preferences: **the allowlist is data, not a
 * convention**. The validator, the query builder and the recommendation scorer
 * all read the tables below, so a filter cannot be accepted by one layer and
 * silently ignored by another, and a Mongo key can only ever come from a literal
 * written here (spec §35, §46, §82 item 7).
 *
 * Every filter maps a *canonical* key to exactly one dotted path inside
 * `matrimonial_profiles` (spec §109: filtering and display both use values that
 * are already in the document, so no lookup is needed to run the query).
 */

const config = require('../config/env');
const { ENUMS, SEARCHABLE_STATUSES, PROFILE_STATUS } = require('./profile');

/** The three supported sort values (spec §53). Anything else is a 400. */
const SORT = Object.freeze({
  RECENTLY_ACTIVE: 'recently_active',
  NEWLY_JOINED: 'newly_joined',
  RECOMMENDED: 'recommended'
});

const SORT_VALUES = Object.freeze([SORT.RECENTLY_ACTIVE, SORT.NEWLY_JOINED, SORT.RECOMMENDED]);
const DEFAULT_SORT = SORT.RECENTLY_ACTIVE;

/**
 * The database sort each allowed value maps to (spec §53). `_id` is always the
 * final tiebreak: it is unique, so two documents that share a timestamp can
 * never be ordered ambiguously, which is what makes the cursor exact.
 */
const SORT_KEYS = Object.freeze({
  [SORT.RECENTLY_ACTIVE]: Object.freeze({ field: 'profile.lastActiveAt', direction: -1, kind: 'date' }),
  [SORT.NEWLY_JOINED]: Object.freeze({ field: 'createdAt', direction: -1, kind: 'date' }),
  // `recommended` is ordered in the application on a bounded candidate window,
  // so it has no database key of its own (spec §54, §55).
  [SORT.RECOMMENDED]: Object.freeze({ field: null, direction: -1, kind: 'number' })
});

/** The database sort document per allowed value. */
const SORT_SPECS = Object.freeze({
  [SORT.RECENTLY_ACTIVE]: Object.freeze({ 'profile.lastActiveAt': -1, _id: -1 }),
  [SORT.NEWLY_JOINED]: Object.freeze({ createdAt: -1, _id: -1 })
});

/**
 * Single-value filters: canonical key -> dotted path.
 *
 * `gender` is the one dimension whose default comes from preferences rather than
 * from the request (decisions §5), which is why the discover service overlays
 * explicit parameters on top of `effectiveFilters()` instead of either-or.
 */
const SCALAR_FILTERS = Object.freeze({
  gender: 'basic.gender'
});

/** Array filters (`?cityId=` or a repeated parameter) -> dotted path. */
const ARRAY_FILTERS = Object.freeze({
  maritalStatus: 'basic.maritalStatus',
  communityIds: 'community.communityId',
  subCommunityIds: 'community.subCommunityId',
  surnameIds: 'community.surnameId',
  gotraIds: 'community.gotraId',
  // Clan and aaspad are their own categories in the community format, never
  // merged into gotra (step 05); they are filterable for the same reason.
  clanIds: 'community.clanId',
  aaspadIds: 'community.aaspadId',
  countryIds: 'location.countryId',
  stateIds: 'location.stateId',
  districtIds: 'location.districtId',
  cityIds: 'location.cityId',
  degreeIds: 'education.degreeId',
  specializationIds: 'education.specializationId',
  universityIds: 'education.universityId',
  occupationIds: 'career.occupationId',
  industryIds: 'career.industryId',
  employmentTypes: 'career.employmentType',
  incomeRanges: 'career.incomeRange',
  diets: 'lifestyle.diet',
  smoking: 'lifestyle.smoking',
  drinking: 'lifestyle.drinking',
  familyTypes: 'family.familyType',
  familyStatuses: 'family.familyStatus'
});

/**
 * Boolean filters -> dotted path. Only `true` narrows the result set: asking for
 * `verified=false` means "do not filter", which is what the §46 example does
 * (`if (verifiedOnly) query['profile.isVerified'] = true`).
 */
const BOOLEAN_FILTERS = Object.freeze({
  verified: 'profile.isVerified',
  // The denormalised discovery-eligibility signal (an *approved* primary photo
  // exists). It is maintained by the photo service so a card can be filtered in
  // the database instead of joining the photos collection per request
  // (spec §10 controlled denormalization, §82 item 4).
  hasPhoto: 'profile.hasPrimaryPhoto'
});

/** Range filters. `age` is converted to `dateOfBirth` boundaries (spec §47). */
const RANGE_FILTERS = Object.freeze({
  age: Object.freeze({ path: 'basic.dateOfBirth', kind: 'date' }),
  heightCm: Object.freeze({ path: 'basic.heightCm', kind: 'number' })
});

/** Enum allowlists for the filter dimensions that are fixed value sets. */
const FILTER_ENUMS = Object.freeze({
  gender: ENUMS.gender,
  maritalStatus: ENUMS.maritalStatus,
  employmentType: ENUMS.employmentType,
  incomeRange: ENUMS.incomeRange,
  diet: ENUMS.diet,
  smoking: ENUMS.smoking,
  drinking: ENUMS.drinking,
  familyType: ENUMS.familyType,
  familyStatus: ENUMS.familyStatus
});

/**
 * `status: active` is the one mandatory predicate every discover/search query
 * carries, appended by the builder *after* user input so a crafted request can
 * never surface a draft, hidden, suspended or deleted profile (spec §56, §83,
 * §99). It is exported so the value and the rule live in one place.
 */
const MANDATORY_FILTER = Object.freeze({
  path: 'profile.status',
  value: SEARCHABLE_STATUSES[0] || PROFILE_STATUS.ACTIVE
});

/**
 * Recommendation weights (spec §54). Product decisions, kept here rather than in
 * the environment because they are part of the algorithm's contract and are
 * asserted by the tests. The seven sub-scores sum to 100.
 */
const RECOMMENDATION_WEIGHTS = Object.freeze({
  age: 20,
  location: 20,
  education: 15,
  occupation: 15,
  community: 10,
  lifestyle: 10,
  completeness: 10
});

/** Sum of the weights, exported so a change cannot silently break the scale. */
const RECOMMENDATION_TOTAL = Object.freeze(
  Object.values(RECOMMENDATION_WEIGHTS).reduce((sum, weight) => sum + weight, 0)
);

/** Page sizes (spec §52, §80). Configured, never hardcoded at a call site. */
const PAGE = Object.freeze({
  defaultLimit: config.search.defaultLimit,
  maxLimit: config.search.maxLimit
});

/** The distance cap for a geo filter, in kilometres (spec §48). */
const MAX_DISTANCE_KM = config.search.maxDistanceKm;

/**
 * How many candidates `recommended` may score in one request (spec §54, §55:
 * "Do not calculate an expensive scoring algorithm across the entire user base
 * on every request"). It is a bounded multiple of the page size, capped by
 * config so a large `limit` cannot turn the ranking pass into a full scan.
 */
const RECOMMENDATION_WINDOW = Object.freeze({
  multiplier: 5,
  cap: config.search.candidateCap
});

/** The result keys ordering the candidate window uses for scoring. */
const CANDIDATE_WINDOW_SORT = Object.freeze({ 'profile.lastActiveAt': -1, _id: -1 });

/** Every canonical filter key the builder understands (nothing else is read). */
const ALLOWED_FILTER_KEYS = Object.freeze([
  ...Object.keys(SCALAR_FILTERS),
  ...Object.keys(ARRAY_FILTERS),
  ...Object.keys(BOOLEAN_FILTERS),
  ...Object.keys(RANGE_FILTERS),
  'geo'
]);

/**
 * `preferenceService.effectiveFilters()` key -> canonical filter key (step 09
 * task 9).
 *
 * The two vocabularies are deliberately different: step 07 names the fields the
 * user *sets* (`educationIds` = the degrees they want), while this step names the
 * profile paths they *filter* (`degreeIds` -> `education.degreeId`). The mapping
 * is explicit rather than a rename, and a preference dimension with no
 * corresponding search dimension is simply absent here — which means it can never
 * become a query key by accident (spec §35).
 *
 * Deliberately absent: `motherTongueIds`, `childrenPreference`,
 * `workingPreference`, `horoscopeRequired`, `manglikPreference` and
 * `relocationPreference` — spec §45 lists no profile filter for them, so they
 * inform the recommendation score, not the query.
 */
const PREFERENCE_FILTER_MAP = Object.freeze({
  gender: 'gender',
  maritalStatus: 'maritalStatus',
  age: 'age',
  heightCm: 'heightCm',
  educationIds: 'degreeIds',
  occupationIds: 'occupationIds',
  industryIds: 'industryIds',
  incomeRanges: 'incomeRanges',
  countryIds: 'countryIds',
  stateIds: 'stateIds',
  cityIds: 'cityIds',
  subCommunityIds: 'subCommunityIds',
  communityIds: 'communityIds',
  surnameIds: 'surnameIds',
  gotraIds: 'gotraIds',
  diet: 'diets',
  smoking: 'smoking',
  drinking: 'drinking',
  familyTypes: 'familyTypes'
});

/** The scored dimensions, in the order the scorer applies them. */
const RECOMMENDATION_DIMENSIONS = Object.freeze([
  'age',
  'location',
  'education',
  'occupation',
  'community',
  'lifestyle',
  'completeness'
]);

/** How many candidates a page may score. Always at least one page. */
function recommendationWindow(limit) {
  const requested = Math.max(1, Number(limit) || PAGE.defaultLimit);
  return Math.min(RECOMMENDATION_WINDOW.cap, requested * RECOMMENDATION_WINDOW.multiplier);
}

module.exports = {
  SORT,
  SORT_VALUES,
  DEFAULT_SORT,
  SORT_KEYS,
  SORT_SPECS,
  CANDIDATE_WINDOW_SORT,
  SCALAR_FILTERS,
  ARRAY_FILTERS,
  BOOLEAN_FILTERS,
  RANGE_FILTERS,
  FILTER_ENUMS,
  MANDATORY_FILTER,
  RECOMMENDATION_WEIGHTS,
  RECOMMENDATION_TOTAL,
  RECOMMENDATION_DIMENSIONS,
  PAGE,
  MAX_DISTANCE_KM,
  ALLOWED_FILTER_KEYS,
  PREFERENCE_FILTER_MAP,
  recommendationWindow
};
