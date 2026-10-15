'use strict';

/**
 * Notification request validation (spec §24, §34, §44, §80; step 13 task 10).
 *
 * The same disciplines as the action, connection and safety validators:
 *
 *  1. **`.strict()` everywhere** — an unknown field is a 400. That makes gate
 *     G3.3 structural: no body or query can carry a `userId` to redirect a
 *     notification or its read state; the recipient is always
 *     `req.auth.userId` (spec §44).
 *  2. **Ids are validated before any query.** A malformed or object-shaped
 *     `notificationId` is a field-level 400, never a cast error and never a
 *     match against another account's row (gate G3.5).
 *  3. **`unreadOnly` is a string flag**, parsed strictly: anything but
 *     `'true'`/`'false'` is a 400 rather than a truthy string silently
 *     filtering the inbox the wrong way.
 *
 * There is no create/POST surface: a notification is never client-created
 * (spec §24, §44). The only inputs this module validates are the two reads and
 * the two mark-read calls.
 */

const { z } = require('zod');
const { NOTIFICATION_TYPES } = require('../constants/notifications');
// The shared query middleware (step 15): this file used to carry its own copy.
const { validateQuery } = require('./validate');

const OID_RE = /^[0-9a-fA-F]{24}$/;
const objectId = z.string({ message: 'Must be a valid identifier.' }).regex(OID_RE, 'Must be a valid identifier.');

/** Query of `GET /notifications` — the recipient's own inbox. */
const notificationListQuerySchema = z
  .object({
    type: z
      .enum(NOTIFICATION_TYPES, { message: `type must be one of: ${NOTIFICATION_TYPES.join(', ')}.` })
      .optional(),
    unreadOnly: z
      .enum(['true', 'false'], { message: 'unreadOnly must be true or false.' })
      .optional()
      .transform((value) => value === 'true'),
    limit: z.coerce
      .number({ message: 'limit must be a whole number.' })
      .int('limit must be a whole number.')
      .min(1, 'limit must be at least 1.')
      .max(100000, 'limit is unreasonably large.')
      .optional(),
    cursor: objectId.optional()
  })
  .strict();

/** Query of `GET /notifications/unread-count` — optionally type-scoped. */
const unreadCountQuerySchema = z
  .object({
    type: z
      .enum(NOTIFICATION_TYPES, { message: `type must be one of: ${NOTIFICATION_TYPES.join(', ')}.` })
      .optional()
  })
  .strict();

/** Param of `PATCH /notifications/:notificationId/read`. */
const notificationIdParamSchema = z
  .object({ notificationId: objectId })
  .strict();

/**
 * Body of `PATCH /notifications/read-all` — intentionally empty and strict.
 *
 * There is nothing to send: the scope is the session's account. Declaring the
 * empty strict object is what makes gate G3.2 structural on this route too — a
 * body carrying `userId` (or anything else) is a 400 rather than an ignored
 * field a client might believe redirected the write.
 */
const markAllReadBodySchema = z.object({}).strict();

module.exports = {
  notificationListQuerySchema,
  unreadCountQuerySchema,
  notificationIdParamSchema,
  markAllReadBodySchema,
  validateQuery
};
