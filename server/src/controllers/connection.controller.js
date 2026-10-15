'use strict';

/**
 * Connection controller (spec §21, §33, §44, §72; step 11 API surface).
 *
 * Request/response only. The actor is `req.auth.userId` (resolved by
 * `requireAuth` from the presented credential) and the inputs are the values the
 * validators already accepted (`req.body`, `req.validatedQuery`, `req.params`) —
 * never a raw request object (spec §31, §44).
 *
 * The response deliberately does **not** echo either account id: the client
 * already knows whom it addressed, and returning the internal `userId` would hand
 * it an identifier it is not meant to hold (spec §112, §113). Each row is
 * reported from the caller's own side (`direction`).
 */

const connectionService = require('../services/connectionService');
const { ok } = require('../utils/apiResponse');
const { HTTP_STATUS } = require('../config/constants');
const { DIRECTION } = require('../constants/connection');

/** The caller's side of a row, so a client always sees `direction` from its POV. */
function directionFor(row, actorId) {
  return String(row.senderId) === String(actorId) ? DIRECTION.SENT : DIRECTION.RECEIVED;
}

/** POST /api/v1/connections — send an interest. */
async function create(req, res) {
  const { connection } = await connectionService.send(req.auth.userId, req.body);
  const payload = connectionService.serializeConnection(connection, DIRECTION.SENT);
  return ok(res, { connection: payload }, 'Interest sent.', HTTP_STATUS.CREATED);
}

/** GET /api/v1/connections — the caller's sent/received interests, as cards. */
async function list(req, res) {
  const result = await connectionService.list(req.auth.userId, req.validatedQuery);
  return ok(res, result, 'OK');
}

/** PATCH /api/v1/connections/:connectionId — accept, reject, withdraw or close. */
async function update(req, res) {
  const updated = await connectionService.respond(req.auth.userId, req.params.connectionId, req.body.action);
  const payload = connectionService.serializeConnection(updated, directionFor(updated, req.auth.userId));
  return ok(res, { connection: payload }, 'Connection updated.');
}

module.exports = { create, list, update, directionFor };
