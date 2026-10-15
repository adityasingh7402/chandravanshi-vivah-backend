'use strict';

/**
 * Profile constants (spec §8, §11, §57, §58; fields dictionary §3-§13, §25).
 *
 * Enum values are frozen arrays so the Mongoose schema and the request
 * validators share one definition — a value can never drift between them.
 * The values are lowercase (frontend enum style, fields dictionary §3.1 etc.);
 * the option *labels* stay in the clients.
 *
 * Numeric bounds are NOT here: they are configured (spec §81) and live in
 * `config/env.js` as `config.profile.*`.
 */

/** Spec §58. `draft` is the create default, and only `active` is discoverable. */
const PROFILE_STATUSES = Object.freeze(['draft', 'active', 'hidden', 'suspended', 'deleted']);
const PROFILE_STATUS = Object.freeze({
  DRAFT: 'draft',
  ACTIVE: 'active',
  HIDDEN: 'hidden',
  SUSPENDED: 'suspended',
  DELETED: 'deleted'
});

/** The only status Discover may return (spec §58). */
const SEARCHABLE_STATUSES = Object.freeze([PROFILE_STATUS.ACTIVE]);

/**
 * Every fixed-dropdown value, sourced from the fields dictionary. A profile
 * field with an entry here rejects anything else (spec §81).
 *
 * `religion` is a controlled list: the dictionary allows a backend master list
 * or a controlled list (§4.6) but documents no options, so the list itself is
 * recorded as a product decision in the tracker rather than invented per-field.
 */
const ENUMS = Object.freeze({
  profileFor: Object.freeze(['self', 'son', 'daughter', 'brother', 'sister', 'relative', 'friend']),
  gender: Object.freeze(['male', 'female']),
  maritalStatus: Object.freeze(['never_married', 'divorced', 'widowed', 'separated']),
  employmentType: Object.freeze([
    'government', 'private', 'business', 'self_employed', 'freelancer',
    'professional', 'student', 'not_working', 'retired', 'other'
  ]),
  incomeRange: Object.freeze([
    'below_3_lpa', '3_5_lpa', '5_10_lpa', '10_20_lpa', '20_30_lpa',
    '30_50_lpa', '50_lpa_plus', 'prefer_not_to_say'
  ]),
  familyType: Object.freeze(['nuclear', 'joint', 'extended']),
  familyStatus: Object.freeze(['middle_class', 'upper_middle_class', 'affluent']),
  diet: Object.freeze(['vegetarian', 'eggetarian', 'non_vegetarian', 'vegan', 'jain', 'other']),
  smoking: Object.freeze(['never', 'occasionally', 'regularly']),
  drinking: Object.freeze(['never', 'occasionally', 'regularly']),
  fitness: Object.freeze(['regularly', 'sometimes', 'rarely', 'not_interested']),
  pets: Object.freeze(['have_pets', 'no_pets', 'like_pets', 'prefer_not_to_say']),
  manglik: Object.freeze(['yes', 'no', 'dont_know']),
  wantsChildren: Object.freeze(['yes', 'no', 'maybe']),
  religion: Object.freeze(['hindu', 'jain', 'buddhist', 'sikh', 'muslim', 'christian', 'other'])
});

/**
 * Fields that are intentionally NOT enums.
 *
 * `rashi` and `nakshatra` are "frontend enum" in the dictionary (§11.4, §11.5)
 * but neither document states the option set, and inventing one would reject
 * valid input; they are bounded strings until the list is published.
 */
const FREE_TEXT_FIELDS = Object.freeze(['horoscope.rashi', 'horoscope.nakshatra']);

/**
 * Spec §57 completion weighting. "The exact weights are product decisions."
 *
 * `enabled` marks a section the product can ask for today. A disabled section is
 * excluded from the denominator rather than scored as zero, so a profile that is
 * complete in every available section scores 100 instead of being permanently
 * penalised for a feature that does not exist yet.
 *
 * Step 07 turned `partnerPreferences` on and step 08 turned `photo` on: both
 * exist now, so the denominator is the full 100 and a profile that is complete
 * in every section scores 100. A profile with all profile fields filled but no
 * preferences and no primary photo scores 75 — the §57 intent, and why both the
 * preference save path and the photo save path re-score the profile instead of
 * leaving the number stale (see `services/profileScoreService.js`).
 */
const COMPLETION_WEIGHTS = Object.freeze([
  Object.freeze({ key: 'basic', weight: 15, enabled: true }),
  Object.freeze({ key: 'community', weight: 10, enabled: true }),
  Object.freeze({ key: 'education', weight: 10, enabled: true }),
  Object.freeze({ key: 'career', weight: 10, enabled: true }),
  Object.freeze({ key: 'family', weight: 15, enabled: true }),
  Object.freeze({ key: 'lifestyle', weight: 10, enabled: true }),
  // Step 07 — partner preferences (scored from their own document).
  Object.freeze({ key: 'partnerPreferences', weight: 15, enabled: true }),
  // Step 08 — primary photo (scored from the photos collection).
  Object.freeze({ key: 'photo', weight: 10, enabled: true }),
  Object.freeze({ key: 'about', weight: 5, enabled: true })
]);

/**
 * Fields dictionary §25 "Core Required Fields for V1", as dotted paths.
 *
 * `partnerPreferences` (step 07) is listed by the dictionary but is not part of
 * the `draft -> active` gate: preferences are optional by design — "save any
 * subset, complete it later" (spec §16) — so requiring them to publish would
 * contradict that step's own acceptance criteria. They are rewarded through the
 * §57 completion score instead.
 *
 * `photos` (step 08) is a gate condition, but a *configurable* one: the platform
 * setting `community_configs.settings.requireProfilePhoto` decides (spec §15),
 * so it is evaluated in `profileService.assertStatusTransition` rather than
 * listed here — this array is for fields that live on the profile document.
 */
const REQUIRED_V1_FIELDS = Object.freeze([
  'basic.profileFor',
  'basic.firstName',
  'basic.gender',
  'basic.dateOfBirth',
  'basic.maritalStatus',
  'basic.heightCm',
  'community.communityId',
  'community.surnameId',
  'community.gotraId',
  'location.cityId',
  'education.highestQualificationId',
  'career.occupationId',
  'family.familyType',
  'lifestyle.diet',
  'about.description'
]);

/** Dictionary §25 entries that are deferred to later steps. */
const REQUIRED_V1_DEFERRED = Object.freeze(['photos', 'partnerPreferences']);

/**
 * Sections the profile page and onboarding expose (spec §92, §93), in the order
 * onboarding presents them.
 */
const PROFILE_SECTIONS = Object.freeze([
  'basic', 'community', 'location', 'education', 'career',
  'family', 'lifestyle', 'personal', 'horoscope', 'marriage', 'about'
]);

/** Read a dotted path off a profile document. */
function getPath(document, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), document);
}

module.exports = {
  PROFILE_STATUSES,
  PROFILE_STATUS,
  SEARCHABLE_STATUSES,
  ENUMS,
  FREE_TEXT_FIELDS,
  COMPLETION_WEIGHTS,
  REQUIRED_V1_FIELDS,
  REQUIRED_V1_DEFERRED,
  PROFILE_SECTIONS,
  getPath
};
