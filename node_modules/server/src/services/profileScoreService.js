'use strict';

/**
 * Profile completion scoring *sources* (spec §15, §57; step 08 task 13).
 *
 * `profileCompletion.calculateCompletion()` is deliberately pure: it scores a
 * profile against the signals it is handed. As soon as two of those signals live
 * in other collections — partner preferences (step 07) and the primary photo
 * (step 08) — every writer needs the same answer to "what are the signals right
 * now?". That is this module, and it exists so the score cannot drift: the
 * preference service, the photo service and the profile service all re-score
 * through here instead of each assembling their own approximation.
 *
 * It imports only models, never another service, so it can be used by
 * `photoService` without creating a cycle.
 */

const PartnerPreference = require('../models/PartnerPreference');
const Photo = require('../models/Photo');
const MatrimonialProfile = require('../models/MatrimonialProfile');
const CommunityConfig = require('../models/CommunityConfig');
const { MODERATION_STATUS } = require('../constants/photo');
const { calculateCompletion } = require('./profileCompletion');

/**
 * The signals the scorer needs, in one round trip.
 *
 * A primary photo counts towards completion as soon as it exists: completion
 * measures "did the user give us this", while *discovery eligibility* is the
 * stricter `approved` filter (spec §101). Those are different questions and are
 * answered by different functions on purpose.
 *
 * @param {string} userId
 */
async function loadSignals(userId) {
  const [partnerPreferences, primaryPhoto] = await Promise.all([
    PartnerPreference.findOne({ userId }).lean(),
    Photo.findOne({ userId, isPrimary: true }).select('publicId').lean()
  ]);

  return {
    partnerPreferences: partnerPreferences || null,
    hasPrimaryPhoto: Boolean(primaryPhoto)
  };
}

/** Score one already-loaded profile document against the current signals. */
async function scoreFor(userId, profile) {
  return calculateCompletion(profile, await loadSignals(userId));
}

/**
 * Re-score and persist `profile.completionPercentage`.
 *
 * Only that one field is written, so a preference or photo write can never
 * rewrite (or race with) an in-flight profile edit (spec §57).
 *
 * @param {string} userId
 * @param {{profile?: object}} [options] an already-loaded document, to save a read
 * @returns {Promise<number|null>} the new score, or null when there is no profile
 */
async function refreshProfileCompletion(userId, options = {}) {
  const profile = options.profile || (await MatrimonialProfile.findOne({ userId }));
  if (!profile) return null;

  const next = await scoreFor(userId, profile);
  if (next !== profile.profile.completionPercentage) {
    await MatrimonialProfile.updateOne(
      { _id: profile._id },
      { $set: { 'profile.completionPercentage': next } }
    );
    profile.profile.completionPercentage = next;
  }
  return next;
}

/** Whether the account has any primary photo (completion signal only). */
async function hasPrimaryPhoto(userId) {
  const photo = await Photo.findOne({ userId, isPrimary: true }).select('_id').lean();
  return Boolean(photo);
}

/**
 * Whether the account has a primary photo a moderator has **approved** — the
 * stricter condition a discovery card needs (spec §101). Completion measures
 * "did the user give us a photo"; discovery measures "may it be shown".
 */
async function hasDiscoverablePhoto(userId) {
  const photo = await Photo.findOne({
    userId,
    isPrimary: true,
    moderationStatus: MODERATION_STATUS.APPROVED
  })
    .select('_id')
    .lean();
  return Boolean(photo);
}

/**
 * Persist `profile.hasPrimaryPhoto` — the denormalised discovery signal step 09
 * filters on (spec §10 controlled denormalization).
 *
 * Called by every photo write that can change which photo is primary or whether
 * it is approved, and by moderation when it changes `moderationStatus` (step 16).
 * The `$ne` guard means a no-op write is not issued, so it is safe to call
 * unconditionally.
 *
 * @param {string} userId
 * @returns {Promise<boolean>} the value now stored
 */
async function syncDiscoveryPhotoFlag(userId) {
  const flag = await hasDiscoverablePhoto(userId);
  await MatrimonialProfile.updateOne(
    { userId, 'profile.hasPrimaryPhoto': { $ne: flag } },
    { $set: { 'profile.hasPrimaryPhoto': flag } }
  );
  return flag;
}

/**
 * The single URL discovery needs: the primary, **approved** photo's card
 * transform. No join, no second query, and - because the card variant is small -
 * a payload step 09 can put straight into a result row (spec §18, §82).
 *
 * @param {string} userId
 * @returns {Promise<{publicId: string, moderationStatus: string}|null>}
 */
async function primaryCardPhoto(userId) {
  const photo = await Photo.findOne({
    userId,
    isPrimary: true,
    moderationStatus: MODERATION_STATUS.APPROVED
  })
    .select('publicId moderationStatus')
    .lean();
  return photo || null;
}

/**
 * Whether publishing this profile requires a photo, and whether it has one.
 *
 * The rule is the platform's `community_configs.settings.requireProfilePhoto`
 * (spec §15) — a product decision, so it is read from the database rather than
 * hardcoded. With no config row the seeded default (`true`) applies: a photo
 * requirement that silently disappears because a collection is empty would be
 * the wrong kind of fail-open for a moderation-adjacent rule.
 *
 * @param {string} userId
 */
async function photoRequirementState(userId) {
  const config = await CommunityConfig.findOne({ isActive: true }).select('settings.requireProfilePhoto').lean();
  const required = config ? config.settings.requireProfilePhoto !== false : true;
  if (!required) return { required: false, hasPhoto: await hasPrimaryPhoto(userId) };
  return { required: true, hasPhoto: await hasPrimaryPhoto(userId) };
}

module.exports = {
  loadSignals,
  scoreFor,
  refreshProfileCompletion,
  hasPrimaryPhoto,
  hasDiscoverablePhoto,
  syncDiscoveryPhotoFlag,
  primaryCardPhoto,
  photoRequirementState
};
