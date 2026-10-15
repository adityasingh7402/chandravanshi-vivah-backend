'use strict';

/**
 * Discover / search controller (spec §33, §120; step 09).
 *
 * Request/response only. The caller's identity comes from `req.auth.userId`
 * (resolved by `requireAuth` from the presented credential) and the validated
 * filters from `req.validatedQuery` — never from a body or a raw query object,
 * so no unvalidated key can reach the query builder (spec §31, §35, §44).
 *
 * Every response is the documented page shape: `{ items: [card…], nextCursor }`
 * (spec §120). `nextCursor` is `null` on the last page, never an empty string.
 */

const searchService = require('../services/searchService');
const { ok } = require('../utils/apiResponse');

/** GET /api/v1/discover — preferences + explicit filters (spec §83, §119). */
async function discover(req, res) {
  const result = await searchService.discover(req.auth.userId, req.validatedQuery);
  return ok(res, result, 'OK');
}

/** GET /api/v1/search — explicit filters only, no preference merge. */
async function search(req, res) {
  const result = await searchService.search(req.auth.userId, req.validatedQuery);
  return ok(res, result, 'OK');
}

/** GET /api/v1/recommendations — deterministic ranking (spec §54, §55). */
async function recommendations(req, res) {
  const result = await searchService.recommendations(req.auth.userId, req.validatedQuery);
  return ok(res, result, 'OK');
}

module.exports = { discover, search, recommendations };
