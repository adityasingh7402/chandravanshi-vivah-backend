'use strict';

/**
 * Admin master-data controller (spec §74, §75, §10; step 16 API surface).
 *
 *   GET    /admin/master-data/:type                  list (incl. deactivated)
 *   POST   /admin/master-data/:type                  create an admin-tier item
 *   PATCH  /admin/master-data/:type/:id              edit; a rename fans out inline
 *   PATCH  /admin/master-data/:type/:id/reorder      curated ordering
 *   DELETE /admin/master-data/:type/:id              DEACTIVATE — never a hard delete
 *   PATCH  /admin/master-data/:type/:id/review       verify / reject a user-contributed option
 *   POST   /admin/master-data/:type/:id/merge        fold a duplicate in as an alias
 *   GET    /admin/master-data-requests               the pending review queue
 *   PATCH  /admin/master-data-requests/:id           approve / reject a request
 *
 * `DELETE` maps to deactivation (spec §74, §98): the row stays, references
 * stay valid, the value disappears from new selections. The `:type` param is
 * the collection allowlist — an unknown type is a 404 before any query runs
 * (spec §35, gate G3.1).
 */

const adminMasterDataService = require('../../services/adminMasterDataService');
const masterDataService = require('../../services/masterDataService');
const { ok } = require('../../utils/apiResponse');
const { HTTP_STATUS } = require('../../config/constants');
const { parseActiveOnly } = require('../../validators/masterData.validators');

/** ObjectId-shaped query fields a listing may filter by (spec §76). */
const FILTER_FIELDS = ['parentId', 'countryId', 'stateId', 'districtId', 'degreeId', 'communityId', 'clanId'];

/** Collect the allowlisted filter values that were actually supplied. */
function collectFilters(query) {
  const filters = {};
  for (const field of FILTER_FIELDS) {
    if (query[field] !== undefined) filters[field] = query[field];
  }
  return filters;
}

/** GET /api/v1/admin/master-data/:type */
async function listItems(req, res) {
  const query = req.validatedQuery || {};
  const result = await masterDataService.list(req.params.type, {
    query: query.query,
    limit: query.limit,
    page: query.page,
    // `activeOnly=false` is how a moderator sees retired values; the default
    // stays "active only", exactly like the public list (spec §74).
    activeOnly: parseActiveOnly(query.activeOnly),
    filters: collectFilters(query)
  });
  // A back-office listing is never cacheable (spec §60).
  res.set('Cache-Control', 'no-store');
  return ok(res, result, 'OK');
}

/** POST /api/v1/admin/master-data/:type */
async function createItem(req, res) {
  const { item } = await adminMasterDataService.createItem(req.auth.userId, req.params.type, req.body);
  return ok(res, { item }, 'Option created.', HTTP_STATUS.CREATED);
}

/** PATCH /api/v1/admin/master-data/:type/:id */
async function updateItem(req, res) {
  const result = await adminMasterDataService.updateItem(req.auth.userId, req.params.type, req.params.id, req.body);
  return ok(
    res,
    { item: result.item, renamed: result.renamed, profilesUpdated: result.profilesUpdated },
    'Option updated.'
  );
}

/** PATCH /api/v1/admin/master-data/:type/:id/reorder */
async function reorderItem(req, res) {
  const { item } = await adminMasterDataService.reorderItem(
    req.auth.userId,
    req.params.type,
    req.params.id,
    req.body.sortOrder
  );
  return ok(res, { item }, 'Option reordered.');
}

/** DELETE /api/v1/admin/master-data/:type/:id — deactivation, never deletion. */
async function deactivateItem(req, res) {
  const { item } = await adminMasterDataService.deactivateItem(req.auth.userId, req.params.type, req.params.id);
  return ok(res, { item }, 'Option deactivated.');
}

/** PATCH /api/v1/admin/master-data/:type/:id/review — verify a user-contributed option. */
async function verifyOption(req, res) {
  const { item } = await adminMasterDataService.verifyOption(req.auth.userId, req.params.type, req.params.id);
  return ok(res, { item }, 'Option verified.');
}

/** PATCH /api/v1/admin/master-data/:type/:id/reject — reject a user-contributed option. */
async function rejectOption(req, res) {
  const { item } = await adminMasterDataService.rejectOption(req.auth.userId, req.params.type, req.params.id);
  return ok(res, { item }, 'Option rejected.');
}

/** POST /api/v1/admin/master-data/:type/:id/merge */
async function mergeOption(req, res) {
  const result = await adminMasterDataService.mergeOption(req.auth.userId, req.params.type, req.params.id, req.body);
  return ok(
    res,
    { survivor: result.survivor, merged: result.merged, aliases: result.aliases },
    'Options merged.'
  );
}

/** GET /api/v1/admin/master-data-requests */
async function listRequests(req, res) {
  const result = await adminMasterDataService.listRequests(req.validatedQuery);
  return ok(res, result, 'OK');
}

/** PATCH /api/v1/admin/master-data-requests/:id */
async function reviewRequest(req, res) {
  const { request } =
    req.body.decision === 'approve'
      ? await adminMasterDataService.approveRequest(req.auth.userId, req.params.id, { note: req.body.note })
      : await adminMasterDataService.rejectRequest(req.auth.userId, req.params.id, { note: req.body.note });
  return ok(res, { request }, 'Request reviewed.');
}

module.exports = {
  listItems,
  createItem,
  updateItem,
  reorderItem,
  deactivateItem,
  verifyOption,
  rejectOption,
  mergeOption,
  listRequests,
  reviewRequest
};
