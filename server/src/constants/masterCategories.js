'use strict';

/**
 * Community-context categories (community format reference; step 05 task 13).
 *
 * The six categories the community-format source defines are deliberately kept
 * separate and are never cross-merged: the same name (for example `Kashyap`)
 * legitimately exists as a Kahar gotra, a Yadav gotra, a Rajput gotra and a
 * Kahar clan, and those are four distinct records scoped by their parent.
 *
 * `community` is platform-controlled: a user may never create one (fields
 * dictionary §4.1). Every other category accepts a user-contributed value
 * through `POST /master-data/:type/missing`.
 */

/** The keys of the canonical community-context object, in source order. */
const CONTEXT_KEYS = Object.freeze([
  'communityName',
  'subCommunityName',
  'surnameName',
  'gotraName',
  'clanName',
  'aaspadName'
]);

const MASTER_CATEGORIES = Object.freeze({
  community: Object.freeze({
    type: 'communities',
    inputKey: 'communityName',
    requestType: null,
    label: 'Community',
    // Platform-controlled — a request body can never create or extend it.
    userInputtable: false,
    scopeFields: Object.freeze([]),
    missingReason: 'Community is managed by the platform and cannot be user-submitted.'
  }),
  sub_community: Object.freeze({
    type: 'sub_communities',
    inputKey: 'subCommunityName',
    requestType: 'sub_community',
    label: 'Sub-community',
    userInputtable: true,
    scopeFields: Object.freeze(['communityId']),
    missingReason: null
  }),
  surname: Object.freeze({
    type: 'surnames',
    inputKey: 'surnameName',
    requestType: 'surname',
    label: 'Surname',
    userInputtable: true,
    scopeFields: Object.freeze(['communityId']),
    missingReason: null
  }),
  gotra: Object.freeze({
    type: 'gotras',
    inputKey: 'gotraName',
    requestType: 'gotra',
    label: 'Gotra',
    userInputtable: true,
    scopeFields: Object.freeze(['communityId', 'clanId']),
    missingReason: null
  }),
  clan: Object.freeze({
    type: 'clans',
    inputKey: 'clanName',
    // Added by the community-format update: clan is its own category, so a
    // user-submitted clan needs its own review row rather than none at all.
    requestType: 'clan',
    label: 'Clan',
    userInputtable: true,
    scopeFields: Object.freeze(['communityId']),
    missingReason: null
  }),
  aaspad: Object.freeze({
    type: 'aaspads',
    inputKey: 'aaspadName',
    requestType: 'aaspad',
    label: 'Aaspad',
    userInputtable: true,
    scopeFields: Object.freeze(['communityId']),
    missingReason: null
  })
});

const MASTER_CATEGORY_KEYS = Object.freeze(Object.keys(MASTER_CATEGORIES));

/** The `:type` values that accept a user-contributed value. */
const USER_INPUTTABLE_TYPES = Object.freeze(
  Object.values(MASTER_CATEGORIES)
    .filter((category) => category.userInputtable)
    .map((category) => category.type)
);

/**
 * The `master_data_requests.type` values a user-submitted value can create.
 *
 * Decisions §3 named gotra/surname/sub_community; the community-format update
 * (step 05) makes clan and aaspad user-inputtable too, so they are included
 * here rather than submitting without a review row.
 */
const REQUEST_TYPES = Object.freeze(['gotra', 'surname', 'sub_community', 'clan', 'aaspad']);

/** Look up a category descriptor by its collection slug. */
function getCategoryByType(type) {
  return Object.values(MASTER_CATEGORIES).find((entry) => entry.type === type) || null;
}

/** True when `type` accepts a user-contributed value. */
function isMasterCategory(type) {
  return USER_INPUTTABLE_TYPES.includes(type);
}

/** Scope fields a user-submitted value must be scoped by, for a category. */
function scopeFieldsFor(type) {
  const category = getCategoryByType(type);
  return category ? category.scopeFields : Object.freeze([]);
}

module.exports = {
  CONTEXT_KEYS,
  MASTER_CATEGORIES,
  MASTER_CATEGORY_KEYS,
  USER_INPUTTABLE_TYPES,
  REQUEST_TYPES,
  getCategoryByType,
  isMasterCategory,
  scopeFieldsFor
};
