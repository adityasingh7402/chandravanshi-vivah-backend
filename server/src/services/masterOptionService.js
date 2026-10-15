'use strict';

/**
 * User-contributed master option service (step 05 task 9b; decisions §3).
 *
 * The "can't find it?" path. A value a user cannot find is NOT blocked on admin
 * review before other users can pick it:
 *
 *   submit -> recorded with source "user" and submittedBy = caller
 *          -> immediately selectable by every other user (flagged)
 *          -> a master_data_requests row is opened for admin review
 *
 * Official-vs-user-contributed is a SERVER-stamped flag. A request body can
 * never set `source`, `submittedBy`, `verifiedBy` or `verifiedAt` (spec §35,
 * §75, gate G3.5).
 */

const config = require('../config/env');
const { getMasterModel, buildMasterIdentity } = require('../models/masterData/MasterItem');
const { getMasterDescriptor } = require('../constants/masterData');
const { getCategoryByType } = require('../constants/masterCategories');
const { normaliseName, toSlug } = require('../utils/slug');
const { BadRequestError, NotFoundError, ForbiddenError } = require('../utils/AppError');
const masterDataService = require('./masterDataService');

/** The canonical slug for a submitted name. */
function normalizeSlug(name) {
  return toSlug(name);
}

/**
 * Add alternate spellings to an existing row instead of creating a second
 * option (fields dictionary §4.4). Case-insensitive, de-duplicated.
 *
 * @param {string} type
 * @param {string} id
 * @param {Array<string>} aliases
 */
async function mergeAliases(type, id, aliases) {
  const model = getMasterModel(type);
  if (!model) throw new NotFoundError('The requested resource does not exist.');
  const cleaned = [...new Set((aliases || []).map((alias) => normaliseName(alias).toLowerCase()).filter(Boolean))];
  if (cleaned.length === 0) return null;
  const doc = await model.findById(id);
  if (!doc) throw new NotFoundError('The requested resource does not exist.');
  const merged = [...new Set([...(doc.aliases || []), ...cleaned])];
  doc.aliases = merged;
  await doc.save();
  return doc;
}

/**
 * Return the existing scoped option for a name, or create a user-contributed
 * one. Idempotent against the scoped slug: two users submitting the same name
 * in the same context get the same row and no duplicate is created (gate G2.10).
 *
 * @param {{type: string, name: string, communityId?: string|null,
 *          subCommunityId?: string|null, clanId?: string|null}} input
 * @param {string} userId the authenticated caller
 * @returns {Promise<object>} the master document (not yet reviewed)
 */
async function findOrCreateUserOption(input, userId) {
  const { type, name } = input;
  const descriptor = getMasterDescriptor(type);
  if (!descriptor) throw new NotFoundError('The requested resource does not exist.');

  const category = getCategoryByType(type);
  if (!category || !category.userInputtable) {
    throw new BadRequestError('Invalid request.', {
      details: { type: category ? category.missingReason : 'This category cannot be user-submitted.' }
    });
  }
  if (!config.masterData.missingEnabled) {
    throw new ForbiddenError('Adding a new value is currently disabled.');
  }

  const displayName = normaliseName(name);
  if (!displayName) {
    throw new BadRequestError('Invalid request.', { details: { name: 'A name is required.' } });
  }
  if (displayName.length > config.masterData.missingMaxLen) {
    throw new BadRequestError('Invalid request.', {
      details: { name: `A name must be at most ${config.masterData.missingMaxLen} characters.` }
    });
  }

  const identity = buildMasterIdentity(type, { name: displayName });
  if (!identity.slug) {
    throw new BadRequestError('Invalid request.', { details: { name: 'Enter a name containing letters or numbers.' } });
  }

  // Scope ids are validated against their own collections, so a Kahar clan can
  // never be attached to a Yadav gotra (step 05, scope is part of identity).
  const scope = { communityId: null, subCommunityId: null, clanId: null };
  if (descriptor.scoped && input.communityId) {
    await masterDataService.assertIds('communities', [input.communityId]);
    scope.communityId = input.communityId;
  }
  if (descriptor.scoped && input.clanId) {
    if (!descriptor.filters.includes('clanId')) {
      throw new BadRequestError('Invalid request.', { details: { clanId: 'This category has no clan scope.' } });
    }
    await masterDataService.assertIds('clans', [input.clanId], { scope: { communityId: scope.communityId } });
    scope.clanId = input.clanId;
  }
  if (descriptor.scoped && category.scopeFields.includes('communityId') && !scope.communityId) {
    throw new BadRequestError('Invalid request.', {
      details: { communityId: 'A community is required to add a value in this category.' }
    });
  }

  const model = getMasterModel(type);
  const lookup = descriptor.scoped ? { ...scope, slug: identity.slug } : { slug: identity.slug };

  const existing = await model.findOne(lookup);
  if (existing) return existing;

  try {
    return await model.create({
      ...identity,
      ...(descriptor.scoped ? scope : {}),
      // Server-stamped tier. Never from the request body.
      source: 'user',
      submittedBy: userId,
      verifiedAt: null,
      isActive: true,
      sortOrder: 0
    });
  } catch (err) {
    // Losing the race on the scoped unique index means someone else just created
    // the same option — return theirs instead of failing.
    if (err && err.code === 11000) {
      const raced = await model.findOne(lookup);
      if (raced) return raced;
    }
    throw err;
  }
}

module.exports = { findOrCreateUserOption, normalizeSlug, mergeAliases };
