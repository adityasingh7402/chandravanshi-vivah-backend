'use strict';

/**
 * Master-data controller (spec §73, §94, §95; step 05 task 5).
 *
 * Request/response only. Reads are public — master data is lookup vocabulary,
 * not personal data (spec §64) — so both clients can populate their selectors
 * without a session. The user-contributed ".missing" path is authenticated.
 */

const masterDataService = require('../services/masterDataService');
const masterDataRequestService = require('../services/masterDataRequestService');
const { ok } = require('../utils/apiResponse');
const { HTTP_STATUS } = require('../config/constants');
const { parseActiveOnly } = require('../validators/masterData.validators');

/** ObjectId-shaped query fields a listing may filter by. */
const FILTER_FIELDS = ['parentId', 'countryId', 'stateId', 'districtId', 'degreeId', 'communityId', 'clanId'];

/** Collect the allowlisted filter values that were actually supplied. */
function collectFilters(query) {
  const filters = {};
  for (const field of FILTER_FIELDS) {
    if (query[field] !== undefined) filters[field] = query[field];
  }
  return filters;
}

/**
 * Cache headers for slowly changing public data (spec §60). The client cache is
 * the primary layer; this only tells a shared/proxy cache the same thing. A
 * back-office call (`activeOnly=false`) is never cached.
 */
function applyCacheHeaders(res, activeOnly) {
  if (activeOnly === false) {
    res.set('Cache-Control', 'no-store');
    return;
  }
  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
}

/** GET /api/v1/master-data/:type */
async function list(req, res) {
  const query = req.validatedQuery || {};
  const activeOnly = parseActiveOnly(query.activeOnly);

  const result = await masterDataService.list(req.params.type, {
    query: query.query,
    limit: query.limit,
    page: query.page,
    activeOnly,
    filters: collectFilters(query)
  });

  applyCacheHeaders(res, activeOnly);
  return ok(res, result, 'OK');
}

/** GET /api/v1/master-data/:type/:id */
async function getOne(req, res) {
  const item = await masterDataService.getById(req.params.type, req.params.id);
  res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
  return ok(res, { item }, 'OK');
}

/**
 * POST /api/v1/master-data/:type/missing
 *
 * Records a value the user cannot find, returns it as an immediately selectable
 * option, and opens a review row for an admin. The caller is taken from the
 * session — never the body (spec §75, gate G3.6).
 */
async function submitMissing(req, res) {
  // The collection being extended comes from the PATH, never the body — a body
  // field could otherwise redirect the write to another category.
  const input = { ...req.body, type: req.params.type };
  const { option, request } = await masterDataRequestService.submitMissing(input, req.auth.userId);
  return ok(
    res,
    { option: option.toOption(), requestId: request._id.toString() },
    'Your value was added and is available to everyone.',
    HTTP_STATUS.CREATED
  );
}

module.exports = { list, getOne, submitMissing };
