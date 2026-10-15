'use strict';

/**
 * Deterministic recommendation scoring (spec §54, §55; step 09 task 12).
 *
 * No AI, no learned weights — the seven sub-scores below are product decisions
 * with fixed arithmetic, and every one of them is unit-testable in isolation.
 * The algorithm is intentionally **total**: each dimension returns its full
 * weight when the viewer expressed no preference on it, so a member who has not
 * filled their preferences is ranked on completeness and fit rather than being
 * pushed to the bottom of the list.
 *
 * Scoring never sees the whole collection: `searchService` fetches a bounded
 * candidate window and this module ranks only that window (spec §54, §55).
 *
 * Weight table (spec §54):
 *
 *   Age compatibility        20
 *   Location compatibility   20
 *   Education                15
 *   Occupation               15
 *   Community                10
 *   Lifestyle                10
 *   Profile completeness     10
 */

const { RECOMMENDATION_WEIGHTS, RECOMMENDATION_TOTAL } = require('../constants/search');
const { computeAge } = require('./profileSerializer');

/** Years used as the decay window when an age range has only one bound. */
const ONE_SIDED_AGE_DECAY_YEARS = 10;

function asSet(list) {
  return new Set((Array.isArray(list) ? list : []).map((entry) => String(entry)));
}

function includesValue(list, value) {
  if (value === null || value === undefined) return false;
  return asSet(list).has(String(value));
}

/**
 * Age compatibility.
 *
 * Inside the requested range the score measures **closeness to the middle of the
 * range** — the full weight at the midpoint, half of it at either bound — because
 * the range is what the user is willing to accept, not what they most want. A
 * flat "inside the range is worth everything" rule would give every candidate a
 * hard-filtered page the same age score and make the ranking depend on nothing at
 * all. Outside the range (reachable when the explicit filters widen what the
 * stored preference asked for) it decays linearly to zero.
 *
 * A one-sided range has no midpoint, so it pays its full weight: the user said
 * "at least this old", not "ideally exactly this old".
 *
 * @param {object} document lean projected profile
 * @param {object} filters canonical filters (the viewer's effective filters)
 */
function ageScore(document, filters) {
  const weight = RECOMMENDATION_WEIGHTS.age;
  const range = filters.age;
  if (!range || (range.min == null && range.max == null)) return weight;

  const age = computeAge(document.basic && document.basic.dateOfBirth);
  if (age === null) return 0;

  const min = range.min == null ? null : range.min;
  const max = range.max == null ? null : range.max;
  const inside = (min === null || age >= min) && (max === null || age <= max);

  if (inside) {
    if (min === null || max === null) return weight;
    const midpoint = (min + max) / 2;
    const halfSpan = Math.max(1, (max - min) / 2);
    // 1 at the midpoint, 0.5 at either bound.
    const closeness = 1 - Math.abs(age - midpoint) / (2 * halfSpan);
    return Math.max(1, Math.round(weight * closeness));
  }

  const distance = age < min ? min - age : age - max;
  const span = min !== null && max !== null ? Math.max(1, max - min) : ONE_SIDED_AGE_DECAY_YEARS;
  return Math.max(0, Math.round(weight * (1 - distance / span)));
}

/**
 * Location compatibility: the same city is worth the full weight, the same state
 * most of it, the same country part of it. With no location preference the
 * dimension is worth its full weight.
 */
function locationScore(document, filters) {
  const weight = RECOMMENDATION_WEIGHTS.location;
  const location = document.location || {};
  const hasCity = Array.isArray(filters.cityIds) && filters.cityIds.length > 0;
  const hasState = Array.isArray(filters.stateIds) && filters.stateIds.length > 0;
  const hasCountry = Array.isArray(filters.countryIds) && filters.countryIds.length > 0;
  if (!hasCity && !hasState && !hasCountry) return weight;

  if (hasCity && includesValue(filters.cityIds, location.cityId)) return weight;
  if (hasState && includesValue(filters.stateIds, location.stateId)) return 12;
  if (hasCountry && includesValue(filters.countryIds, location.countryId)) return 6;
  return 0;
}

/** Education: the preferred degree is full weight, a matching specialization is partial. */
function educationScore(document, filters) {
  const weight = RECOMMENDATION_WEIGHTS.education;
  const education = document.education || {};
  const hasDegree = Array.isArray(filters.degreeIds) && filters.degreeIds.length > 0;
  const hasSpecialization = Array.isArray(filters.specializationIds) && filters.specializationIds.length > 0;
  const hasUniversity = Array.isArray(filters.universityIds) && filters.universityIds.length > 0;
  if (!hasDegree && !hasSpecialization && !hasUniversity) return weight;

  if (hasDegree && includesValue(filters.degreeIds, education.degreeId)) return weight;
  if (hasSpecialization && includesValue(filters.specializationIds, education.specializationId)) return 10;
  if (hasUniversity && includesValue(filters.universityIds, education.universityId)) return 8;
  return 0;
}

/** Occupation: the preferred occupation is full weight, a matching industry is partial. */
function occupationScore(document, filters) {
  const weight = RECOMMENDATION_WEIGHTS.occupation;
  const career = document.career || {};
  const hasOccupation = Array.isArray(filters.occupationIds) && filters.occupationIds.length > 0;
  const hasIndustry = Array.isArray(filters.industryIds) && filters.industryIds.length > 0;
  const hasEmployment = Array.isArray(filters.employmentTypes) && filters.employmentTypes.length > 0;
  if (!hasOccupation && !hasIndustry && !hasEmployment) return weight;

  if (hasOccupation && includesValue(filters.occupationIds, career.occupationId)) return weight;
  if (hasIndustry && includesValue(filters.industryIds, career.industryId)) return 10;
  if (hasEmployment && includesValue(filters.employmentTypes, career.employmentType)) return 8;
  return 0;
}

/**
 * Community: an exact community match is worth most of the dimension, with the
 * gotra and surname narrowing it further (spec §16 community context). Nothing is
 * *required* — same-community rules are a community_configs product decision
 * (spec §15), so the scorer rewards a match rather than filtering on it.
 */
function communityScore(document, filters) {
  const weight = RECOMMENDATION_WEIGHTS.community;
  const community = document.community || {};
  const hasCommunity = Array.isArray(filters.communityIds) && filters.communityIds.length > 0;
  const hasGotra = Array.isArray(filters.gotraIds) && filters.gotraIds.length > 0;
  const hasSurname = Array.isArray(filters.surnameIds) && filters.surnameIds.length > 0;
  if (!hasCommunity && !hasGotra && !hasSurname) return weight;

  let total = 0;
  if (hasCommunity && includesValue(filters.communityIds, community.communityId)) total += 6;
  if (hasGotra && includesValue(filters.gotraIds, community.gotraId)) total += 4;
  if (hasSurname && includesValue(filters.surnameIds, community.surnameId)) total += 2;
  return Math.min(weight, total);
}

/**
 * Lifestyle: only the dimensions the viewer actually set are scored, each worth
 * an equal share; a set dimension the candidate does not match earns nothing.
 */
function lifestyleScore(document, filters) {
  const weight = RECOMMENDATION_WEIGHTS.lifestyle;
  const lifestyle = document.lifestyle || {};
  const dimensions = [
    { key: 'diets', value: lifestyle.diet },
    { key: 'smoking', value: lifestyle.smoking },
    { key: 'drinking', value: lifestyle.drinking }
  ].filter((dimension) => Array.isArray(filters[dimension.key]) && filters[dimension.key].length > 0);

  if (dimensions.length === 0) return weight;

  const share = weight / dimensions.length;
  let earned = 0;
  for (const dimension of dimensions) {
    if (includesValue(filters[dimension.key], dimension.value)) earned += share;
  }
  return Math.round(earned);
}

/** Profile completeness: the §57 score, scaled to its own weight. */
function completenessScore(document) {
  const weight = RECOMMENDATION_WEIGHTS.completeness;
  const percentage = document.profile ? document.profile.completionPercentage : 0;
  if (typeof percentage !== 'number' || Number.isNaN(percentage)) return 0;
  return Math.max(0, Math.min(weight, Math.round((weight * percentage) / 100)));
}

/**
 * Score one candidate. Returns the total *and* the per-dimension breakdown, so a
 * ranking decision can be explained and a test can pin one sub-score without
 * restating the others.
 *
 * @param {object} document lean projected profile (`RECOMMENDATION_PROJECTION`)
 * @param {{filters?: object}} [options] the viewer's effective filters
 * @returns {{total: number, breakdown: object}}
 */
function score(document, options = {}) {
  const filters = options.filters || {};
  const breakdown = {
    age: ageScore(document, filters),
    location: locationScore(document, filters),
    education: educationScore(document, filters),
    occupation: occupationScore(document, filters),
    community: communityScore(document, filters),
    lifestyle: lifestyleScore(document, filters),
    completeness: completenessScore(document)
  };

  const total = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  return { total: Math.max(0, Math.min(RECOMMENDATION_TOTAL, total)), breakdown };
}

/**
 * Rank a bounded candidate window: highest score first, `_id` descending as the
 * stable tiebreak (so two candidates with the same score always come back in the
 * same order).
 *
 * @param {object[]} documents
 * @param {{filters?: object}} [options]
 * @returns {Array<{document: object, score: number, breakdown: object}>}
 */
function rank(documents = [], options = {}) {
  return documents
    .map((document) => {
      const { total, breakdown } = score(document, options);
      return { document, score: total, breakdown };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftId = String(left.document._id || '');
      const rightId = String(right.document._id || '');
      if (leftId === rightId) return 0;
      return leftId < rightId ? 1 : -1;
    });
}

/**
 * Apply a `recommended` cursor inside an already-scored window: keep only the
 * entries that come strictly after the cursor position (score first, then id).
 *
 * @param {Array<{document: object, score: number}>} scored
 * @param {{key: number, id: string}} cursor
 */
function afterCursor(scored, cursor) {
  if (!cursor) return scored;
  return scored.filter((entry) => {
    if (entry.score !== cursor.key) return entry.score < cursor.key;
    return String(entry.document._id || '') < cursor.id;
  });
}

module.exports = {
  score,
  rank,
  afterCursor,
  ageScore,
  locationScore,
  educationScore,
  occupationScore,
  communityScore,
  lifestyleScore,
  completenessScore
};
