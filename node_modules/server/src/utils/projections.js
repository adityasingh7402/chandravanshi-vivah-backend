'use strict';

/**
 * Discover projections and card serialisation (spec §18, §51, §70, §82, §108;
 * step 09 tasks 7, 14).
 *
 * This module is the single definition of *what a discovery row is*. The reason
 * it exists: the projection, the serialiser and the recommendation scorer must
 * agree about the candidate document's shape, and the cheapest way to guarantee
 * that is to keep the field list in one place.
 *
 * The projection follows spec §108 literally — one small `select`, no `populate`
 * chain (spec §66), no original image (spec §18) — and `userId` is the only
 * internal key in it: it links a row to its photo without putting the account id
 * on the wire (the card serialiser names every field it returns, never a spread,
 * so a projected-but-unserialised key cannot leak).
 */

const profileSerializer = require('../services/profileSerializer');

/**
 * The §70 / §108 card projection.
 *
 * `age` is not here because it is not stored — it is derived from
 * `basic.dateOfBirth` at serialisation time (spec §47).
 */
const CARD_PROJECTION = Object.freeze({
  publicProfileId: 1,
  'basic.firstName': 1,
  'basic.dateOfBirth': 1,
  'basic.heightCm': 1,
  'community.surnameName': 1,
  'community.gotraName': 1,
  'location.cityName': 1,
  'education.degreeName': 1,
  'career.occupationName': 1,
  'profile.isVerified': 1,
  'profile.lastActiveAt': 1,
  // Internal: joins a row to its primary photo for this page. Never serialised.
  userId: 1
});

/**
 * The scoring projection: the card fields plus exactly the values the
 * deterministic model compares (spec §54). Adding a field here is the only way a
 * sub-score can read it, so the ranking cost stays proportional to the bounded
 * candidate window rather than to the document size.
 */
const RECOMMENDATION_PROJECTION = Object.freeze({
  ...CARD_PROJECTION,
  'location.countryId': 1,
  'location.stateId': 1,
  'location.cityId': 1,
  'education.degreeId': 1,
  'education.specializationId': 1,
  'career.occupationId': 1,
  'career.industryId': 1,
  'community.communityId': 1,
  'community.gotraId': 1,
  'lifestyle.diet': 1,
  'lifestyle.smoking': 1,
  'lifestyle.drinking': 1,
  'profile.completionPercentage': 1,
  createdAt: 1
});

/**
 * Build the card DTO from a lean, projected document.
 *
 * Age, height formatting and the §70 field names all live in the DTO layer
 * (`profileSerializer.discoveryCard`), so this does not re-implement them — it
 * adds the one value the DTO cannot know: the card's transformed photo URL,
 * which the caller looks up once per page (never once per row, spec §82 item 4).
 *
 * @param {object} document lean projected profile document
 * @param {{primaryPhoto?: string|null}} [options]
 */
function serializeCard(document, options = {}) {
  return profileSerializer.discoveryCard(document, { primaryPhoto: options.primaryPhoto || null });
}

module.exports = { CARD_PROJECTION, RECOMMENDATION_PROJECTION, serializeCard };
