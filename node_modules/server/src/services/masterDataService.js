'use strict';

/**
 * Master-data service (spec §73, §74, §82, §97, §102; step 05).
 *
 * Reads are allowlisted and bounded. `type` must be a known slug, every filter
 * is an allowlisted field with a validated ObjectId, search is an ANCHORED
 * prefix match against an indexed field, and `limit` is clamped. A caller can
 * never reach an arbitrary collection or issue an unbounded scan (spec §35,
 * §82, gate G3.1/G3.2/G3.3/G4.2).
 */

const mongoose = require('mongoose');
const config = require('../config/env');
const { getMasterModel } = require('../models/masterData/MasterItem');
const {
  getMasterDescriptor,
  allowedFilterParams,
  MASTER_TYPE_VALUES
} = require('../constants/masterData');
const { BadRequestError, NotFoundError } = require('../utils/AppError');
const { isValidObjectId } = require('../utils/objectId');

/** Hard cap on a search term, independent of the configured minimum. */
const SEARCH_MAX_LEN = 64;

/** Escape a user string so it can only ever be a literal prefix. */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Resolve the descriptor + model for a type, or 404 (gate G3.1). */
function resolveType(type) {
  const descriptor = getMasterDescriptor(type);
  const model = descriptor ? getMasterModel(type) : null;
  if (!descriptor || !model) throw new NotFoundError('The requested resource does not exist.');
  return { descriptor, model };
}

/** Coerce and clamp the requested page size (spec §80, gate G3.3). */
function clampLimit(limit) {
  const fallback = config.masterData.defaultLimit;
  if (limit === undefined || limit === null || limit === '') return fallback;
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestError('Invalid request.', { details: { limit: 'limit must be a whole number of at least 1.' } });
  }
  return Math.min(parsed, config.masterData.maxLimit);
}

/** Coerce the page number. */
function clampPage(page) {
  if (page === undefined || page === null || page === '') return 1;
  const parsed = Number(page);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BadRequestError('Invalid request.', { details: { page: 'page must be a whole number of at least 1.' } });
  }
  return parsed;
}

/**
 * Build the Mongo filter for a listing/search.
 *
 * @param {string} type
 * @param {object} params validated query parameters
 */
function buildFilter(type, params = {}) {
  const descriptor = getMasterDescriptor(type);
  const filter = {};

  if (params.activeOnly !== false) filter.isActive = true;

  const term = typeof params.query === 'string' ? params.query.trim() : '';
  if (term) {
    if (term.length < config.masterData.searchMinLen) {
      throw new BadRequestError('Invalid request.', {
        details: { query: `Enter at least ${config.masterData.searchMinLen} characters to search.` }
      });
    }
    if (term.length > SEARCH_MAX_LEN) {
      throw new BadRequestError('Invalid request.', {
        details: { query: `Search text must be at most ${SEARCH_MAX_LEN} characters.` }
      });
    }
    // Anchored, case-sensitive prefix against the indexed lower-cased name.
    // A leading wildcard or `/i` would be a COLLSCAN anti-pattern (spec §82).
    filter.nameLower = { $regex: `^${escapeRegex(term.toLowerCase())}` };
  }

  // Only allowlisted parameters are ever read — never `req.query` wholesale.
  const supplied = params.filters || {};
  for (const param of allowedFilterParams(type)) {
    const raw = supplied[param];
    if (raw === undefined || raw === null || raw === '') continue;
    const field = param === 'parentId' ? descriptor.cascadeParent : param;
    if (!field) continue;
    if (!isValidObjectId(raw)) {
      throw new BadRequestError('Invalid request.', {
        details: { [param]: `${param} must be a valid identifier.` }
      });
    }
    filter[field] = new mongoose.Types.ObjectId(raw);
  }

  return filter;
}

/**
 * Order rows: curated order first, verified values ahead of user-contributed
 * ones at equal order, then name. Sorting in memory keeps the DB query on the
 * indexed filter and is bounded by the limit cap (task 14, gate G4.3).
 */
function orderItems(descriptor, documents) {
  const verifiedFirst = (doc) => (descriptor.scoped && doc.verifiedAt ? 0 : 1);
  return [...documents].sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
    const tier = verifiedFirst(a) - verifiedFirst(b);
    if (tier !== 0) return tier;
    return String(a.nameLower).localeCompare(String(b.nameLower));
  });
}

/** Map a lean document to the client option shape. */
function toOption(descriptor, doc) {
  const option = {
    _id: String(doc._id),
    name: doc.name,
    slug: doc.slug,
    isActive: doc.isActive,
    sortOrder: doc.sortOrder
  };
  if (doc.category !== undefined) option.category = doc.category ?? null;
  for (const field of ['communityId', 'subCommunityId', 'clanId', 'degreeId', 'countryId', 'stateId', 'districtId']) {
    if (doc[field] !== undefined) option[field] = doc[field] ? String(doc[field]) : null;
  }
  if (descriptor.scoped) {
    option.isUserContributed = doc.source === 'user';
    option.verifiedAt = doc.verifiedAt || null;
  }
  return option;
}

/**
 * List/search a master collection (spec §73).
 *
 * @param {string} type
 * @param {{query?: string, limit?: number, page?: number, activeOnly?: boolean,
 *          filters?: object}} params
 */
async function list(type, params = {}) {
  const { descriptor, model } = resolveType(type);
  const filter = buildFilter(type, params);
  const limit = clampLimit(params.limit);
  const page = clampPage(params.page);

  const total = await model.countDocuments(filter);
  const docs = await model
    .find(filter)
    .sort({ sortOrder: 1, nameLower: 1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

  const items = orderItems(descriptor, docs).map((doc) => toOption(descriptor, doc));

  return {
    items,
    type,
    page,
    limit,
    total,
    hasMore: page * limit < total,
    maxLimit: config.masterData.maxLimit
  };
}

/** Fetch one item by id, for label resolution. */
async function getById(type, id) {
  const { descriptor, model } = resolveType(type);
  if (!isValidObjectId(id)) throw new NotFoundError('The requested resource does not exist.');
  const doc = await model.findById(id).lean();
  if (!doc) throw new NotFoundError('The requested resource does not exist.');
  return toOption(descriptor, doc);
}

/**
 * Validate that every id exists, is active (unless told otherwise) and belongs
 * to the requested collection AND parent scope (spec §97, gate G2.6/G2.12).
 *
 * Returns a report rather than throwing, so a caller can decide whether to
 * reject the whole batch. `assertIds()` is the throwing convenience wrapper
 * step 06 will use.
 *
 * @param {string} type
 * @param {Array<string>} ids
 * @param {{requireActive?: boolean, scope?: object}} [options]
 */
async function validateIds(type, ids, options = {}) {
  const { descriptor, model } = resolveType(type);
  const requireActive = options.requireActive !== false;
  const scope = options.scope || {};

  if (!Array.isArray(ids)) {
    throw new BadRequestError('Invalid request.', { details: { ids: 'ids must be an array.' } });
  }

  const invalid = [];
  const unique = [];

  for (const raw of ids) {
    const id = String(raw);
    if (!isValidObjectId(id)) {
      invalid.push({ id, reason: 'INVALID_FORMAT', message: 'Not a valid option identifier.' });
      continue;
    }
    if (!unique.includes(id)) unique.push(id);
  }

  const scopeFields = descriptor.scoped ? ['communityId', 'subCommunityId', 'clanId'] : [];
  const found = await model
    .find({ _id: { $in: unique.map((id) => new mongoose.Types.ObjectId(id)) } })
    .select(['_id', 'isActive', ...scopeFields])
    .lean();
  const byId = new Map(found.map((doc) => [String(doc._id), doc]));

  const valid = [];
  for (const id of unique) {
    const doc = byId.get(id);
    if (!doc) {
      // Distinguish "an id from another collection" from "no such id at all".
      const elsewhere = await findInOtherCollections(type, id);
      invalid.push({
        id,
        reason: elsewhere ? 'WRONG_TYPE' : 'NOT_FOUND',
        message: elsewhere
          ? `This option belongs to ${elsewhere}, not ${descriptor.label}.`
          : `This ${descriptor.label} option does not exist.`
      });
      continue;
    }
    if (requireActive && doc.isActive === false) {
      invalid.push({ id, reason: 'INACTIVE', message: `This ${descriptor.label} is no longer available.` });
      continue;
    }
    const mismatched = scopeFields.find(
      (field) => scope[field] !== undefined && String(doc[field] || '') !== String(scope[field] || '')
    );
    if (mismatched) {
      invalid.push({
        id,
        reason: 'OUT_OF_SCOPE',
        message: `This ${descriptor.label} does not belong to the selected ${mismatched}.`
      });
      continue;
    }
    valid.push(id);
  }

  return { valid, invalid, ok: invalid.length === 0 };
}

/** Which other master collection, if any, an id belongs to. */
async function findInOtherCollections(type, id) {
  const objectId = new mongoose.Types.ObjectId(id);
  for (const candidate of MASTER_TYPE_VALUES) {
    if (candidate === type) continue;
    const descriptor = getMasterDescriptor(candidate);
    const model = getMasterModel(candidate);
    // Only scoped rows are cross-checked, to keep the failure path cheap.
    const exists = await model.exists({ _id: objectId });
    if (exists) return descriptor.label;
  }
  return null;
}

/** Throwing wrapper around validateIds() (step 06 profile submission). */
async function assertIds(type, ids, options) {
  const report = await validateIds(type, ids, options);
  if (!report.ok) {
    throw new BadRequestError('Invalid request.', {
      details: Object.fromEntries(report.invalid.map((entry) => [entry.id, entry.message]))
    });
  }
  return report.valid;
}

/**
 * Resolve ids to display names, for the denormalised `*Name` companions a
 * profile stores alongside the id (spec §10).
 *
 * @returns {Promise<Map<string, string>>} id -> name
 */
async function resolveNames(type, ids) {
  const { model } = resolveType(type);
  const clean = (Array.isArray(ids) ? ids : []).map(String).filter(isValidObjectId);
  if (clean.length === 0) return new Map();
  const docs = await model
    .find({ _id: { $in: clean.map((id) => new mongoose.Types.ObjectId(id)) } })
    .select('name')
    .lean();
  return new Map(docs.map((doc) => [String(doc._id), doc.name]));
}

module.exports = {
  list,
  getById,
  validateIds,
  assertIds,
  resolveNames,
  buildFilter,
  clampLimit,
  SEARCH_MAX_LEN
};
