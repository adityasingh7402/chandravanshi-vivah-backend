'use strict';

/**
 * Partner-preference service (spec §16, §44, §54, §62, §72, §80, §81, §97;
 * finalized decisions §4, §5; step 07 tasks 4, 5, 6, 7).
 *
 * Four rules shape this module:
 *
 *  1. **Ownership comes from the session.** `userId` is a parameter the caller
 *     passes from `req.auth`, never something read out of a body (spec §44, §72).
 *  2. **Partial saves are the product.** A missing field means "no preference on
 *     this dimension" and must never be turned into "match nothing" (spec §16).
 *     That is why the service stores nothing sentinel — not an empty range, not
 *     an "any" enum value — and why `effectiveFilters()` omits absent keys.
 *  3. **Every write validates the *merged* document.** A patch that is valid on
 *     its own can still invert a range against stored state, so the values are
 *     overlaid first and parsed again (task 5, gate G2.4).
 *  4. **Master references are re-derived, never trusted.** Ids are checked with
 *     step 05's `validateIds()` — right collection, active, deduplicated — and
 *     the community-context arrays are additionally checked against the chosen
 *     communities, so a Yadav gotra can never be stored as a Kahar one
 *     (spec §97; community-format scoping).
 */

const PartnerPreference = require('../models/PartnerPreference');
const MatrimonialProfile = require('../models/MatrimonialProfile');
const { getMasterModel } = require('../models/masterData/MasterItem');
const masterDataService = require('./masterDataService');
const profileScoreService = require('./profileScoreService');
const { validateMerged } = require('../validators/preference.validators');
const {
  PREFERENCE_MASTER_ARRAYS,
  PREFERENCE_FIELD_NAMES,
  EFFECTIVE_FILTER_KEYS,
  oppositeGender
} = require('../constants/preference');
const { ConflictError, NotFoundError, BadRequestError } = require('../utils/AppError');

/** The `*Ids` fields whose master rows can be user-contributed (step 05). */
const CONTRIBUTED_ARRAY_FIELDS = Object.freeze(
  PREFERENCE_MASTER_ARRAYS.filter((entry) => entry.scopedBy).map((entry) => ({
    field: entry.field,
    type: entry.type
  }))
);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A field-scoped 400, so the client learns which field to fix. */
function fieldError(field, message) {
  return new BadRequestError('Invalid request.', { details: { [field]: message } });
}

/**
 * Validate every master reference: exists, active, right collection, capped and
 * deduplicated (spec §97). Server-normalised ids are written back so the stored
 * document can never contain a duplicate or an id the client invented.
 *
 * @param {object} values validated request values
 */
async function resolveMasterReferences(values) {
  for (const reference of PREFERENCE_MASTER_ARRAYS) {
    const ids = values[reference.field];
    if (!Array.isArray(ids) || ids.length === 0) continue;

    const report = await masterDataService.validateIds(reference.type, ids);
    if (!report.ok) {
      const entry = report.invalid[0];
      throw fieldError(reference.field, entry ? entry.message : 'One of the selected options is not available.');
    }
    values[reference.field] = report.valid;
  }

  await assertCommunityScoped(values);
  return values;
}

/**
 * Community-context scoping (community format; step 07 build task 3).
 *
 * A sub-community, surname or gotra must belong to one of the chosen
 * communities. With no community chosen there is no context to violate — the id
 * still identifies exactly one row — so the check is skipped rather than turned
 * into an extra requirement.
 */
async function assertCommunityScoped(values) {
  for (const reference of PREFERENCE_MASTER_ARRAYS) {
    if (!reference.scopedBy) continue;
    const ids = values[reference.field];
    if (!Array.isArray(ids) || ids.length === 0) continue;

    const allowed = new Set((values[reference.scopedBy] || []).map(String));
    if (allowed.size === 0) continue;

    const docs = await getMasterModel(reference.type)
      .find({ _id: { $in: ids } })
      .select('communityId')
      .lean();
    const byId = new Map(docs.map((doc) => [String(doc._id), doc]));

    for (const id of ids) {
      const doc = byId.get(String(id));
      if (!doc || !allowed.has(String(doc.communityId))) {
        throw fieldError(reference.field, 'One of the selected options does not belong to the chosen community.');
      }
    }
  }
}

/** Overlay a patch onto the stored values; range objects merge field-wise. */
function mergePreferenceValues(current, patch) {
  const merged = {};
  for (const key of PREFERENCE_FIELD_NAMES) {
    const base = current ? current[key] : undefined;
    if (!(key in patch)) {
      merged[key] = base;
      continue;
    }
    const next = patch[key];
    // `{ age: { max: 30 } }` must keep the stored `min` (gate G2.2).
    merged[key] = isPlainObject(base) && isPlainObject(next) ? { ...base, ...next } : next;
  }
  return merged;
}

/** The owner's preference document, or null before they have saved any. */
async function getOwn(userId) {
  return PartnerPreference.findOne({ userId });
}

/**
 * The default gender is the opposite of the profile's own gender (decisions §5).
 * It is a **default only** — the user can change it — and it is only derived when
 * the owner actually has a gender on their profile.
 */
async function deriveGenderDefault(userId) {
  const profile = await MatrimonialProfile.findOne({ userId }).select('basic.gender').lean();
  return oppositeGender(profile && profile.basic ? profile.basic.gender : null);
}

/**
 * Create the caller's preferences (task 4). A partial (or empty) body is fine:
 * schema defaults fill the age range and every multi-select starts empty.
 *
 * @param {string} userId from `req.auth` only
 * @param {object} input validated request body
 */
async function create(userId, input) {
  const existing = await PartnerPreference.findOne({ userId }).select('_id').lean();
  if (existing) throw new ConflictError('You already have partner preferences.');

  const values = await resolveMasterReferences(validateMerged(input));
  const preference = new PartnerPreference({ userId, ...values });

  if (preference.gender == null) {
    const derived = await deriveGenderDefault(userId);
    if (derived) preference.gender = derived;
  }

  try {
    await preference.save();
  } catch (err) {
    // Losing the race on the unique `userId` index is still a duplicate.
    if (err && err.code === 11000) throw new ConflictError('You already have partner preferences.');
    throw err;
  }

  await refreshProfileCompletion(userId);
  return preference;
}

/**
 * Partial update of the caller's own preferences (task 5).
 *
 * @param {string} userId from `req.auth` only
 * @param {object} patch validated request body
 */
async function update(userId, patch) {
  const preference = await PartnerPreference.findOne({ userId });
  if (!preference) throw new NotFoundError('The requested resource does not exist.');

  // The stored document is Mongoose-flavoured (ObjectIds, sub-documents); the
  // validators accept the wire form, so the stored values are round-tripped
  // through JSON before merging (spec §34).
  const stored = JSON.parse(JSON.stringify(preference.toObject({ transform: null })));
  const merged = validateMerged(mergePreferenceValues(stored, patch));
  const resolved = await resolveMasterReferences(merged);

  for (const key of PREFERENCE_FIELD_NAMES) {
    if (key in resolved) preference[key] = resolved[key];
  }

  await preference.save();
  await refreshProfileCompletion(userId);
  return preference;
}

/**
 * Re-score the owner's profile after a preference write (§57, task 7).
 *
 * Only the single `profile.completionPercentage` field is written — the rest of
 * the profile document is untouched, so saving preferences can never rewrite (or
 * race with) an in-flight profile edit.
 *
 * @returns {Promise<number|null>} the new score, or null when there is no profile
 */
async function refreshProfileCompletion(userId) {
  // Delegated: step 08 added a second off-document signal (the primary photo),
  // so the scoring sources live in `profileScoreService` and every writer uses
  // the same one. Only `profile.completionPercentage` is written.
  return profileScoreService.refreshProfileCompletion(userId);
}

/**
 * The filter object step 09 consumes (task 6, spec §54).
 *
 * Contract, deliberately narrow so discover never has to re-interpret anything:
 *
 *   - **Only allowlisted keys.** Built key by key from `EFFECTIVE_FILTER_KEYS`;
 *     the document is never spread, so no stored extra can become a filter
 *     (spec §35, gate G4.3).
 *   - **Absent means "do not filter".** A key is present only when the user set
 *     that dimension; empty arrays and null scalars are omitted entirely.
 *   - **Plain values only.** Ids are strings, enums are strings, ranges are
 *     `{ min, max }` numbers — no `$` operators, no nested query documents, so
 *     the object can be embedded in a Mongo query without escaping it again.
 *   - **`gender` defaults to the opposite of the owner's own gender** when unset
 *     (decisions §5). It is a default, not a lock: setting `gender` overrides it.
 *   - **`age` is a preference range, not a date of birth.** Step 09 converts it
 *     with the platform's birth-date rule (spec §47) — this layer never guesses.
 *
 * @param {string} userId from `req.auth`
 * @returns {Promise<object>} a plain, non-empty-keys-only filter object
 */
async function effectiveFilters(userId) {
  const [preference, profile] = await Promise.all([
    PartnerPreference.findOne({ userId }).lean(),
    MatrimonialProfile.findOne({ userId }).select('basic.gender').lean()
  ]);

  const filters = {};
  if (!preference) return filters;

  for (const key of EFFECTIVE_FILTER_KEYS) {
    const value = preference[key];
    if (value === undefined || value === null) continue;

    if (key === 'age' || key === 'heightCm') {
      if (!isPlainObject(value)) continue;
      const range = {};
      if (typeof value.min === 'number') range.min = value.min;
      if (typeof value.max === 'number') range.max = value.max;
      if (Object.keys(range).length > 0) filters[key] = range;
      continue;
    }

    if (Array.isArray(value)) {
      // Master ids become strings; enum values are already strings. Nothing but
      // a string can survive this step, so an injected object cannot either.
      const entries = value.map((entry) => String(entry));
      if (entries.length > 0) filters[key] = entries;
      continue;
    }

    if (typeof value === 'string') filters[key] = value;
  }

  if (filters.gender === undefined) {
    const derived = oppositeGender(profile && profile.basic ? profile.basic.gender : null);
    if (derived) filters.gender = derived;
  }

  return filters;
}

/**
 * Which of the referenced community-context options are user-contributed
 * (step 05 tiers). Returned as a side map so the id arrays stay uniform: a client
 * can flag a contributed option without the ids changing shape.
 */
async function userContributedIds(preference) {
  const out = {};
  for (const { field, type } of CONTRIBUTED_ARRAY_FIELDS) {
    const ids = preference[field];
    if (!Array.isArray(ids) || ids.length === 0) continue;
    const docs = await getMasterModel(type)
      .find({ _id: { $in: ids }, source: 'user' })
      .select('_id')
      .lean();
    out[field] = docs.map((doc) => String(doc._id));
  }
  return out;
}

/**
 * The DTO. Every field is named explicitly and every id is a string, so a
 * Mongoose type can never leak into the response (spec §30, §59).
 */
async function serialize(preference) {
  if (!preference) return null;

  const out = {};
  for (const key of PREFERENCE_FIELD_NAMES) {
    const value = preference[key];

    if (key === 'age' || key === 'heightCm') {
      out[key] = {
        min: value && typeof value.min === 'number' ? value.min : null,
        max: value && typeof value.max === 'number' ? value.max : null
      };
      continue;
    }

    if (Array.isArray(value)) {
      out[key] = value.map((entry) => String(entry));
      continue;
    }

    out[key] = value === undefined || value === null ? null : String(value);
  }

  out.userContributedIds = await userContributedIds(preference);
  out.createdAt = preference.createdAt || null;
  out.updatedAt = preference.updatedAt || null;
  return out;
}

module.exports = {
  create,
  update,
  getOwn,
  serialize,
  effectiveFilters,
  refreshProfileCompletion,
  resolveMasterReferences,
  assertCommunityScoped,
  mergePreferenceValues,
  userContributedIds,
  CONTRIBUTED_ARRAY_FIELDS
};
