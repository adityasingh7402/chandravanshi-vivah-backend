'use strict';

/**
 * Matrimonial profile service (spec §8, §30, §44, §51, §57, §58, §72, §97, §118;
 * step 06 tasks 5, 6, 8, 11, 12).
 *
 * Three rules shape everything here:
 *
 *  1. **Ownership comes from the session.** `userId` is a parameter the caller
 *     passes from `req.auth`, never something read out of a body (spec §72, §118).
 *  2. **Every write validates the *merged* document.** A patch that is valid on
 *     its own can still break a cross-field rule against the stored state, so the
 *     sections are overlaid first and then parsed again (task 6).
 *  3. **Master references are re-derived, never trusted.** IDs are checked with
 *     step 05's `validateIds()` — scoped to their parent, inactive values refused —
 *     and the denormalised `*Name` copy is overwritten from the master record the
 *     server just resolved (spec §10, §97). A client cannot store a name that
 *     disagrees with the source of truth.
 */

const MatrimonialProfile = require('../models/MatrimonialProfile');
const PartnerPreference = require('../models/PartnerPreference');
const KundliDocument = require('../models/KundliDocument');
const Photo = require('../models/Photo');
const User = require('../models/User');
const { getMasterModel } = require('../models/masterData/MasterItem');
const masterDataService = require('./masterDataService');
const profileScoreService = require('./profileScoreService');
const photoService = require('./photoService');
const { calculateCompletion, requiredFieldsState } = require('./profileCompletion');
const { CONTENT_SECTIONS, validateMerged } = require('../validators/profile.validators');
const { allocatePublicProfileId } = require('../utils/publicProfileId');
const { PROFILE_STATUS } = require('../constants/profile');
const { ConflictError, NotFoundError, BadRequestError } = require('../utils/AppError');

/**
 * Every `*Id` field a client may send, the master collection it must exist in,
 * and — where the schema keeps one — the denormalised name beside it.
 *
 * `scope` lists the parent fields the ID must live inside, which is what stops a
 * Kahar clan being attached to a Yadav gotra (spec §97; step 05).
 */
const MASTER_REFERENCES = Object.freeze([
  { field: 'community.communityId', type: 'communities' },
  { field: 'community.subCommunityId', type: 'sub_communities', scope: ['communityId'] },
  { field: 'community.surnameId', type: 'surnames', scope: ['communityId'], nameField: 'community.surnameName' },
  { field: 'community.gotraId', type: 'gotras', scope: ['communityId'], nameField: 'community.gotraName' },
  { field: 'community.clanId', type: 'clans', scope: ['communityId'], nameField: 'community.clanName' },
  { field: 'community.aaspadId', type: 'aaspads', scope: ['communityId'], nameField: 'community.aaspadName' },
  { field: 'community.motherTongueId', type: 'languages', nameField: 'community.motherTongueName' },
  { field: 'location.countryId', type: 'countries', nameField: 'location.countryName' },
  { field: 'location.stateId', type: 'states', scope: ['countryId'], nameField: 'location.stateName' },
  { field: 'location.districtId', type: 'districts', scope: ['stateId'], nameField: 'location.districtName' },
  { field: 'location.cityId', type: 'cities', scope: ['districtId'], nameField: 'location.cityName' },
  { field: 'education.highestQualificationId', type: 'degrees' },
  { field: 'education.degreeId', type: 'degrees', nameField: 'education.degreeName' },
  { field: 'education.specializationId', type: 'specializations', scope: ['degreeId'], nameField: 'education.specializationName' },
  { field: 'education.universityId', type: 'universities', nameField: 'education.universityName' },
  { field: 'career.occupationId', type: 'occupations', nameField: 'career.occupationName' },
  { field: 'career.industryId', type: 'industries', nameField: 'career.industryName' }
]);

/** Multi-valued references (spec §8 `personal`). Ids only — no name copies. */
const MASTER_LIST_FIELDS = Object.freeze([
  { field: 'personal.hobbies', type: 'hobbies' },
  { field: 'personal.interests', type: 'interests' },
  { field: 'personal.languages', type: 'languages' }
]);

/**
 * Fields loaded for another user's read (spec §51 projection, §30 privacy).
 * `userId`, `location.coordinates`, `horoscope.birthTime` and
 * `horoscope.birthPlace` are deliberately absent.
 */
const PUBLIC_PROJECTION = [
  'publicProfileId', 'basic', 'community',
  'location.countryId', 'location.stateId', 'location.districtId', 'location.cityId',
  'location.countryName', 'location.stateName', 'location.districtName', 'location.cityName',
  'education', 'career', 'family', 'lifestyle', 'personal', 'about', 'marriage',
  'horoscope.available', 'horoscope.rashi', 'horoscope.nakshatra', 'horoscope.manglik',
  'profile.isVerified', 'profile.lastActiveAt', 'profile.status', 'createdAt', 'updatedAt'
].join(' ');

function readPath(target, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), target);
}

function writePath(target, path, value) {
  const keys = path.split('.');
  let node = target;
  for (let index = 0; index < keys.length - 1; index += 1) {
    if (node[keys[index]] == null || typeof node[keys[index]] !== 'object') node[keys[index]] = {};
    node = node[keys[index]];
  }
  node[keys[keys.length - 1]] = value;
}

/** The scope an ID must sit inside, resolved from the *incoming* values. */
function scopeFor(reference, sections) {
  const scope = {};
  for (const key of reference.scope || []) {
    const value = readPath(sections, `${reference.field.split('.')[0]}.${key}`);
    if (value) scope[key] = value;
    else return null; // required parent not set yet — leave the child unvalidated
  }
  return scope;
}

/** Reject a bad ID with the *field* name, so the client knows what to fix. */
function assertReference(reference, id, scope) {
  return masterDataService.validateIds(reference.type, [id], { scope: scope || {} }).then((report) => {
    if (report.ok) return;
    const entry = report.invalid[0];
    throw new BadRequestError('Invalid request.', {
      details: { [reference.field]: entry ? entry.message : 'This option is not available.' }
    });
  });
}

/**
 * Validate every master reference in the sections and re-derive the
 * denormalised names (spec §10, §97).
 *
 * @param {object} sections parsed content sections
 */
async function resolveMasterReferences(sections) {
  for (const reference of MASTER_REFERENCES) {
    const id = readPath(sections, reference.field);
    if (id === undefined || id === null || id === '') continue;

    const scope = scopeFor(reference, sections);
    await assertReference(reference, id, scope);

    if (reference.nameField) {
      const names = await masterDataService.resolveNames(reference.type, [id]);
      const name = names.get(String(id));
      if (name === undefined) {
        throw new BadRequestError('Invalid request.', {
          details: { [reference.field]: 'This option is not available.' }
        });
      }
      // Server-derived: overwrites whatever a client may have sent.
      writePath(sections, reference.nameField, name);
    }
  }

  for (const reference of MASTER_LIST_FIELDS) {
    const ids = readPath(sections, reference.field);
    if (!Array.isArray(ids) || ids.length === 0) continue;
    const report = await masterDataService.validateIds(reference.type, ids);
    if (!report.ok) {
      const entry = report.invalid[0];
      throw new BadRequestError('Invalid request.', {
        details: { [reference.field]: entry ? entry.message : 'One of the selected options is not available.' }
      });
    }
  }

  // Coordinates are server-derived from the selected city, never client input
  // (spec §48, §76). Every write recomputes them, so removing the city clears
  // the point instead of leaving a stale one behind.
  if (sections.location !== undefined && sections.location !== null) {
    const cityId = readPath(sections, 'location.cityId');
    let coordinates = null;
    if (cityId) {
      const city = await getMasterModel('cities')
        .findById(cityId)
        .select('coordinates')
        .lean();
      if (city && city.coordinates && city.coordinates.lat != null && city.coordinates.lng != null) {
        coordinates = { type: 'Point', coordinates: [city.coordinates.lng, city.coordinates.lat] };
      }
    }
    sections.location = sections.location || {};
    sections.location.coordinates = coordinates;
  }

  return sections;
}

/**
 * The §57 completion score for a profile, including the sections that live in
 * their own collection. Partner preferences (step 07) are one of those, so the
 * preference document is loaded on every profile write rather than the score
 * being cached — the percentage must never drift from the data it summarises.
 *
 * @param {string} userId
 * @param {object} profile the profile being scored
 * @returns {Promise<number>} 0..100
 */
async function completionFor(userId, profile) {
  // Both off-document signals — partner preferences (step 07) and the primary
  // photo (step 08) — come from one place so this score cannot disagree with the
  // score the preference or photo services persist (step 08 task 13).
  return calculateCompletion(profile, await profileScoreService.loadSignals(userId));
}

/** Overlay a patch onto the stored sections (task 6's "merged document"). */
function mergeSections(current, patch) {
  const merged = {};
  for (const key of CONTENT_SECTIONS) {
    const base = current[key] && typeof current[key] === 'object' ? { ...current[key] } : {};
    merged[key] = patch[key] === undefined ? base : { ...base, ...patch[key] };
  }
  return merged;
}

/** Keep `users.profileCreated` / `users.onboardingCompleted` truthful (task 11). */
async function syncUserFlags(userId, profile) {
  const { complete } = requiredFieldsState(profile);
  const update = { profileCreated: true };
  // Only ever promote: a profile that satisfied §25 does not become
  // "not onboarded" again because one optional field was cleared.
  if (complete) update.onboardingCompleted = true;
  await User.updateOne({ _id: userId }, { $set: update });
}

/**
 * Enforce spec §58's transition table for the two statuses a client may set.
 *
 * `draft -> active` only when the required set is complete, `active <-> hidden`
 * freely (and only between those two), `suspended` / `deleted` unreachable from
 * here at all, and a same-status write is an idempotent no-op. Anything else is
 * a 409: an invalid transition must never be silently accepted.
 */
async function assertStatusTransition(current, target, profile, userId) {
  if (current === PROFILE_STATUS.SUSPENDED || current === PROFILE_STATUS.DELETED) {
    throw new ConflictError('This profile can no longer be published. Please contact support.');
  }
  if (current === target) return;
  if (target === PROFILE_STATUS.HIDDEN && current !== PROFILE_STATUS.ACTIVE) {
    throw new ConflictError('Only an active profile can be hidden. Please publish it first.');
  }
  if (target === PROFILE_STATUS.ACTIVE) {
    const { complete, missing } = requiredFieldsState(profile);
    // The photo requirement is a platform product decision, not a field on the
    // profile document: `community_configs.settings.requireProfilePhoto`
    // decides whether a photo is needed to publish (spec §15, step 08 task 13).
    const photoState = await profileScoreService.photoRequirementState(userId);
    const missingAll = photoState.required && !photoState.hasPhoto ? [...missing, 'photos'] : missing;

    if (!complete || missingAll.length > missing.length) {
      throw new ConflictError('Your profile is not complete enough to publish yet.', {
        details: { missing: missingAll }
      });
    }
  }
}

/**
 * Create the caller's profile (spec §118). Always a draft: a brand-new profile
 * cannot satisfy §25, so it must never be discoverable on arrival (spec §58).
 */
async function create(userId, input) {
  const existing = await MatrimonialProfile.findOne({ userId })
    .select('_id publicProfileId profile.status')
    .lean();
  const wasDeleted = existing && existing.profile && existing.profile.status === PROFILE_STATUS.DELETED;
  // A soft-deleted profile keeps the document (spec §98) but must not trap the
  // account: recreating is the one way back from `deleted` (spec §58).
  if (existing && !wasDeleted) throw new ConflictError('You already have a profile.');

  const sections = await resolveMasterReferences(validateMerged(input));
  // The tombstone keeps its public identity: a link that was shared before the
  // delete points at the profile the user rebuilds (spec §113 stability).
  const publicProfileId = existing ? existing.publicProfileId : await allocatePublicProfileId(MatrimonialProfile);

  if (wasDeleted) {
    // Only this explicit "start again" replaces the tombstone; until then the
    // deleted document is retained exactly as §98 requires.
    const removed = await MatrimonialProfile.deleteOne({
      _id: existing._id,
      'profile.status': PROFILE_STATUS.DELETED
    });
    if (removed.deletedCount === 0) throw new ConflictError('You already have a profile.');
  }

  const profile = new MatrimonialProfile({ userId, publicProfileId, ...sections });
  profile.profile.status = PROFILE_STATUS.DRAFT;
  profile.profile.completionPercentage = await completionFor(userId, profile);
  profile.profile.lastActiveAt = new Date();

  try {
    await profile.save();
  } catch (err) {
    // Losing the race on the `userId` unique index is still a duplicate.
    if (err && err.code === 11000) throw new ConflictError('You already have a profile.');
    throw err;
  }

  await syncUserFlags(userId, profile);
  return profile;
}

/**
 * Partial update of the caller's own profile (spec §72).
 *
 * @param {string} userId from `req.auth` only
 * @param {{status?: string} & object} patch parsed request body
 */
async function update(userId, patch) {
  const profile = await MatrimonialProfile.findOne({ userId });
  if (!profile) throw new NotFoundError('The requested resource does not exist.');
  // A tombstone or an admin-frozen profile is not writable (spec §58). The
  // only way back from `deleted` is a fresh create.
  if (profile.profile.status === PROFILE_STATUS.DELETED) {
    throw new ConflictError('This profile has been deleted. Create a new profile to start again.');
  }
  if (profile.profile.status === PROFILE_STATUS.SUSPENDED) {
    throw new ConflictError('This profile is suspended. Please contact support.');
  }

  const { status, ...sections } = patch;

  // The stored document is Mongoose-flavoured: ObjectIds and Dates, plus the
  // server-owned `location.coordinates`. The validators accept the wire form a
  // client would send — ids as strings, dates as ISO — so the stored sections
  // are round-tripped through JSON before merging (spec §34, task 6).
  // `transform: null` keeps the internal birth fields: they are the owner's own
  // data and must survive an unrelated patch, not be silently dropped.
  const stored = JSON.parse(JSON.stringify(profile.toObject({ transform: null })));
  const current = {};
  for (const key of CONTENT_SECTIONS) current[key] = stored[key] || {};
  if (current.location) delete current.location.coordinates;

  // Validate the MERGED document (a patch valid alone can break a rule against
  // stored state), then re-derive master ids, denormalised names and
  // coordinates from the source of truth (spec §10, §97).
  const validated = validateMerged(mergeSections(current, sections));
  const resolved = await resolveMasterReferences(validated);

  for (const key of CONTENT_SECTIONS) {
    profile[key] = resolved[key];
  }

  if (status !== undefined) {
    await assertStatusTransition(profile.profile.status, status, profile, userId);
    profile.profile.status = status;
  }

  profile.profile.completionPercentage = await completionFor(userId, profile);
  await profile.save();

  await syncUserFlags(userId, profile);
  return profile;
}

/** The owner's view (spec §72). */
async function getOwn(userId) {
  const profile = await MatrimonialProfile.findOne({ userId });
  if (!profile) return null;
  // Reading your own profile is activity (spec §58 lastActiveAt).
  profile.profile.lastActiveAt = new Date();
  profile.markModified('profile');
  await profile.save();
  return profile;
}

/**
 * Another user's permitted view.
 *
 * Only `active` profiles are readable at all: `draft`, `hidden`, `suspended` and
 * `deleted` are all filtered out server-side (spec §58, gate G2.8), and the
 * projection keeps coordinates/birth details off the wire entirely (spec §30).
 *
 * @param {string} publicProfileId
 */
async function getPublic(publicProfileId, options = {}) {
  if (!publicProfileId) return null;
  // `userId` is added to the projection explicitly: it is not part of the public
  // DTO, but it is the only key that links the profile to its photos (step 08),
  // and querying the photos collection by `undefined` would silently return
  // nothing.
  const profile = await MatrimonialProfile.findOne({
    publicProfileId,
    ...MatrimonialProfile.publicVisibilityFilter()
  }).select(`${PUBLIC_PROJECTION} userId`);
  if (!profile) return null;

  // Photos arrive as a separate collection, so the viewer's relationship decides
  // what is visible: `private` and `matches_only` are absent for a non-match
  // viewer (spec §112, gate G3.6). `isMatch` is false because connections are
  // step 11 — it is a parameter rather than a constant so that step only has to
  // pass the relationship in.
  const photos = await photoService.listForViewer(profile.userId, {
    isOwner: options.viewerId ? String(options.viewerId) === String(profile.userId) : false,
    isMatch: options.isMatch === true
  });

  return { profile, photos };
}

/** Permanently delete the profile and its owned records. */
async function hardDelete(userId) {
  const profile = await MatrimonialProfile.findOne({ userId });
  if (!profile) throw new NotFoundError('The requested resource does not exist.');

  const photos = await Photo.find({ userId }).select('_id').lean();
  for (const photo of photos) {
    await photoService.deletePhoto(userId, photo._id);
  }

  await Promise.all([
    PartnerPreference.deleteOne({ userId }),
    KundliDocument.deleteOne({ userId })
  ]);
  await MatrimonialProfile.deleteOne({ _id: profile._id, userId });
  await User.updateOne(
    { _id: userId },
    { $set: { profileCreated: false, onboardingCompleted: false, onboardingStep: 0 } }
  );

  return profile;
}

module.exports = {
  create,
  update,
  getOwn,
  getPublic,
  hardDelete,
  completionFor,
  resolveMasterReferences,
  mergeSections,
  PUBLIC_PROJECTION,
  MASTER_REFERENCES
};
