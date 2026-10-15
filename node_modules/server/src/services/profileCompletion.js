'use strict';

/**
 * Profile completion scoring (spec §57; step 06 task 7).
 *
 * §57 gives a section weighting and explicitly says *"The exact weights are
 * product decisions"*, so the weights live in `constants/profile.js` as
 * constants rather than in this function.
 *
 * A section earns its weight **pro rata** across the fields that section scores,
 * which keeps the number smooth as a draft fills in instead of jumping in 10-point
 * steps. The result is a percentage of the weight of the sections that can be
 * scored today: photos (step 08) are part of the documented weighting but do not
 * exist yet, so they are `enabled: false` and excluded from the denominator.
 *
 * Partner preferences (step 07) live in their **own** document, so that section is
 * scored against the preference the caller passes in `signals.partnerPreferences`
 * rather than against the profile. No signal means "no preferences saved yet",
 * which scores zero for that section — the caller decides how to load it, so this
 * function stays pure and testable.
 */

const { COMPLETION_WEIGHTS, REQUIRED_V1_FIELDS, getPath } = require('../constants/profile');
const { PREFERENCE_COMPLETION_FIELDS } = require('../constants/preference');

/**
 * The fields §57 is talking about when it says "the important profile fields".
 * A section is scored as `filled / scored.length`.
 */
const SECTION_FIELDS = Object.freeze({
  basic: Object.freeze([
    'basic.profileFor',
    'basic.firstName',
    'basic.gender',
    'basic.dateOfBirth',
    'basic.maritalStatus',
    'basic.heightCm'
  ]),
  community: Object.freeze(['community.communityId', 'community.surnameId', 'community.gotraId']),
  education: Object.freeze(['education.highestQualificationId']),
  career: Object.freeze(['career.occupationId']),
  family: Object.freeze(['family.familyType']),
  lifestyle: Object.freeze(['lifestyle.diet']),
  about: Object.freeze(['about.description']),
  // Step 07 — scored against the preference document, not the profile.
  partnerPreferences: PREFERENCE_COMPLETION_FIELDS,
  // Deferred: no fields are scored until the owning step lands.
  photo: Object.freeze([])
});

/** A value counts as present when it is set and not an empty string/array. */
function isFilled(value) {
  if (value === null || value === undefined || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Date) return true;
  if (typeof value === 'object') return true;
  return true;
}

/** How much of one section (0..1) is filled. */
function sectionProgress(document, key) {
  const fields = SECTION_FIELDS[key];
  if (!fields || fields.length === 0) return 0;
  const filled = fields.filter((path) => isFilled(getPath(document, path))).length;
  return filled / fields.length;
}

/**
 * @param {object} document a profile (Mongoose document or plain object)
 * @param {{hasPrimaryPhoto?: boolean, partnerPreferences?: object|null}} [signals]
 *   The documents for sections that do not live on the profile. Absent means the
 *   section is unfilled.
 * @returns {number} 0..100, rounded
 */
function calculateCompletion(document, signals = {}) {
  const enabled = COMPLETION_WEIGHTS.filter((entry) => entry.enabled);
  const totalWeight = enabled.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight === 0) return 0;

  let earned = 0;
  for (const entry of enabled) {
    // Partner preferences are a separate collection (spec §16), so that section
    // is scored from the preference document while every other section is scored
    // from the profile itself.
    const source = entry.key === 'partnerPreferences' ? signals.partnerPreferences : document;
    let progress = sectionProgress(source, entry.key);
    // Photos are still deferred; the signal is accepted so step 08 does not have
    // to rewire this function when the section is switched on.
    if (entry.key === 'photo' && signals.hasPrimaryPhoto) progress = 1;
    earned += entry.weight * progress;
  }

  return Math.round((earned / totalWeight) * 100);
}

/**
 * Whether the `draft -> active` gate opens (dictionary §25, spec §58).
 *
 * Only the required fields inside the profile document are checked: `photos`
 * (step 08) and `partnerPreferences` (step 07) are listed by the dictionary but
 * are not part of this gate — preferences are optional by design, so they are
 * rewarded through the §57 completion score instead of blocking a publish.
 *
 * @returns {{complete: boolean, missing: string[]}}
 */
function requiredFieldsState(document) {
  const missing = REQUIRED_V1_FIELDS.filter((path) => !isFilled(getPath(document, path)));
  return { complete: missing.length === 0, missing };
}

module.exports = {
  calculateCompletion,
  requiredFieldsState,
  sectionProgress,
  isFilled,
  SECTION_FIELDS
};
