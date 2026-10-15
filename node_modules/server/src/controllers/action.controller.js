'use strict';

/**
 * Profile-action controller (spec §20, §33, §44, §72; step 10 task 10).
 *
 * Request/response only. The actor is `req.auth.userId` (resolved by
 * `requireAuth` from the presented credential) and the inputs are the values the
 * validators already accepted (`req.body`, `req.validatedQuery`, `req.params`) —
 * never a raw request object (spec §31, §44).
 *
 * The response deliberately does **not** echo the target's account id: when the
 * client addressed the target by `publicProfileId`, returning the internal
 * `userId` would hand it an identifier it is not meant to hold (spec §112, §113).
 * The client already knows which profile it acted on.
 */

const actionService = require('../services/actionService');
const { ok } = require('../utils/apiResponse');
const { HTTP_STATUS } = require('../config/constants');

/** A safe projection of one action row. */
function serializeAction(action, created) {
  return {
    id: String(action._id),
    type: action.type,
    createdAt: action.createdAt,
    isNew: created
  };
}

/** POST /api/v1/interactions — record a view, like, shortlist or pass. */
async function record(req, res) {
  const { action, created } = await actionService.record(req.auth.userId, req.body);
  return ok(res, { interaction: serializeAction(action, created) }, 'Action recorded.', HTTP_STATUS.CREATED);
}

/** GET /api/v1/interactions — the caller's own actions as cards. */
async function list(req, res) {
  const result = await actionService.listOwn(req.auth.userId, req.validatedQuery);
  return ok(res, result, 'OK');
}

/** DELETE /api/v1/interactions/:interactionId — remove one of the caller's actions. */
async function remove(req, res) {
  const removed = await actionService.remove(req.auth.userId, req.params.interactionId);
  return ok(res, { interaction: removed }, 'Action removed.');
}

module.exports = { record, list, remove, serializeAction };
