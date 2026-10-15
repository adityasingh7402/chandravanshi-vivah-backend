'use strict';

/**
 * Notification controller (spec §24, §33, §44, §112; step 13 API surface).
 *
 * Request/response only. The recipient is always `req.auth.userId` — there is
 * no code path in which a client-supplied value can name whose inbox is read
 * or whose row is marked (spec §44, gate G3.2).
 *
 * The serialiser (`notificationService.serializeNotification`) names every
 * field it returns, so a response can never carry another account's id, an
 * admin note, or a copied profile/message document (spec §30, §112).
 */

const notificationService = require('../services/notificationService');
const { ok } = require('../utils/apiResponse');
const { HTTP_STATUS } = require('../config/constants');

/**
 * GET /api/v1/notifications — the caller's inbox.
 *
 * `req.validatedQuery` carries `{ type?, unreadOnly?, limit?, cursor? }` with
 * types already coerced by the validator. The response includes the unread
 * count computed against the same filter, so a badge rendered from this payload
 * and the list below it can never disagree.
 */
async function list(req, res) {
  const result = await notificationService.list(req.auth.userId, req.validatedQuery ?? {});
  return ok(res, result, 'OK');
}

/** GET /api/v1/notifications/unread-count — the badge count alone. */
async function unreadCount(req, res) {
  const count = await notificationService.unreadCount(req.auth.userId, req.validatedQuery ?? {});
  return ok(res, { unreadCount: count }, 'OK');
}

/**
 * PATCH /api/v1/notifications/:notificationId/read — mark one read.
 *
 * Idempotent by design: a repeat call answers 200 with `alreadyRead: true` and
 * keeps the first `readAt`; a row that is not the caller's is a 404, never a
 * 403 that would confirm it exists (spec §44).
 */
async function markRead(req, res) {
  const { notification, alreadyRead } = await notificationService.markRead(
    req.auth.userId,
    req.params.notificationId
  );
  return ok(res, { notification, alreadyRead }, alreadyRead ? 'Already read.' : 'Marked as read.');
}

/**
 * PATCH /api/v1/notifications/read-all — mark the caller's inbox read.
 *
 * Scoped to the caller inside the service; the response reports how many rows
 * changed so a client can update its badge without a second round trip.
 */
async function markAllRead(req, res) {
  const { modifiedCount } = await notificationService.markAllRead(req.auth.userId);
  return ok(res, { modifiedCount }, 'All notifications marked as read.', HTTP_STATUS.OK);
}

module.exports = { list, unreadCount, markRead, markAllRead };
