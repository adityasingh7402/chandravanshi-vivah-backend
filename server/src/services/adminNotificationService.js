'use strict';

/**
 * Admin notification service (spec §24, §28, §101; step 16 task 10).
 *
 * Administrative messages travel through the SAME `notificationService` the
 * peer flows use, so the inbox's pagination, badge count, coalescing rules
 * and ownership scoping apply to an admin message exactly as they do to an
 * interest (task 10). Two differences, both deliberate:
 *
 *   - **Only the two admin-originated types may be sent** (`admin_alert`,
 *     `verification_completed` — spec §24). A moderator cannot fabricate an
 *     `interest_received` from an account that never sent one; the type set
 *     is an allowlist, not a pass-through.
 *   - **There is no peer actor, so there is no block suppression to apply**   *     and nothing coalesces: an admin message is never a repeated high-frequency signal,
 *     and the platform's safety notices must not disappear because two
 *     members blocked each other (spec §22, decisions §16).
 *
 * The recipient is server-derived from the validated body's `userId` and the
 * write is audited with the recipient id, so a notification can always be
 * traced to the moderator who sent it (spec §29, §44; gate G3.3, G3.8).
 */

const notificationService = require('./notificationService');
const auditService = require('./auditService');
const { ADMIN_ACTIONS } = require('../constants/adminActions');
const { ADMIN_NOTIFICATION_TYPES } = require('../constants/adminActions');
const { BadRequestError, NotFoundError } = require('../utils/AppError');
const { isValidObjectId } = require('../utils/objectId');

/**
 * Send one administrative notification (task 10).
 *
 * @param {string} actorUserId the admin/moderator sending it (audited)
 * @param {{userId: string, type: string, title?: string, body?: string,
 *          data?: object}} input validated body
 * @returns {Promise<{notification: object, recipientId: string}>}
 */
async function send(actorUserId, input) {
  if (!isValidObjectId(input.userId)) {
    throw new BadRequestError('Invalid request.', { details: { userId: 'Not a valid identifier.' } });
  }
  if (!ADMIN_NOTIFICATION_TYPES.includes(input.type)) {
    throw new BadRequestError('Invalid request.', {
      details: { type: `An admin may only send: ${ADMIN_NOTIFICATION_TYPES.join(', ')}.` }
    });
  }

  const { notification } = await notificationService.create({
    userId: input.userId,
    type: input.type,
    // No actorId: admin-originated types are never block-suppressed, and
    // passing one would make the platform's own messages disappear for a
    // blocked pair (spec §22).
    title: input.title,
    body: input.body,
    // Identifiers only — the step-13 rule that a payload never carries a
    // copied document applies here unchanged (spec §24, §112).
    data: input.data || {}
  });

  // `notification === null` means the recipient no longer exists — the
  // validated userId named an account that was deleted between the request
  // and the write. That is a 404, not a silent success.
  if (!notification) {
    throw new NotFoundError('The requested resource does not exist.');
  }

  await auditService.log({
    actorUserId,
    action: ADMIN_ACTIONS.SENT_NOTIFICATION,
    targetType: 'notification',
    targetId: notification._id,
    metadata: { type: input.type, recipientId: input.userId }
  });

  return { notification, recipientId: input.userId };
}

module.exports = { send, ADMIN_NOTIFICATION_TYPES };
