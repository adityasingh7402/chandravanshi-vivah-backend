'use strict';

/**
 * Block controller (spec §22, §33, §44; step 12 API surface).
 *
 * Request/response only. The actor is `req.auth.userId` and the inputs are the
 * values the validators already accepted — never a raw request object
 * (spec §31, §44).
 *
 * The serialiser names every field it returns, so no block response can leak a
 * blocked account's internal id, its private fields, or another account's block
 * (spec §112). The `reason` is the blocker's own note — they wrote it, so they
 * see it back; the blocked account never does.
 */

const blockService = require('../services/blockService');
const { ok } = require('../utils/apiResponse');
const { HTTP_STATUS } = require('../config/constants');

/** A safe projection of one block row. */
function serializeBlock(row, created) {
  return {
    id: String(row._id),
    reason: row.reason ?? null,
    createdAt: row.createdAt,
    isNew: Boolean(created)
  };
}

/** POST /api/v1/blocks — block one account. */
async function create(req, res) {
  const { block, created } = await blockService.block(req.auth.userId, req.body);
  return ok(res, { block: serializeBlock(block, created) }, created ? 'User blocked.' : 'User already blocked.', HTTP_STATUS.CREATED);
}

/** GET /api/v1/blocks — the caller's own block list. */
async function list(req, res) {
  const result = await blockService.list(req.auth.userId, req.validatedQuery);
  return ok(res, result, 'OK');
}

/**
 * DELETE /api/v1/blocks/:userId — remove a block the caller created.
 *
 * The response does not echo the account id back: the client already knows whom
 * it asked to unblock, and the internal id is not something this surface ever
 * hands out (spec §112, §113).
 */
async function remove(req, res) {
  await blockService.unblock(req.auth.userId, req.params.userId);
  return ok(res, { block: { removed: true } }, 'User unblocked.');
}

module.exports = { create, list, remove, serializeBlock };
