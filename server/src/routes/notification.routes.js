'use strict';

/**
 * Notification routes (spec §24, §32, §36, §44; step 13 API surface).
 *
 *   GET   /notifications                       the caller's inbox (paginated)
 *   GET   /notifications/unread-count          badge count
 *   PATCH /notifications/read-all              mark the caller's inbox read
 *   PATCH /notifications/:notificationId/read  mark one read
 *
 * There is deliberately **no POST surface**: a notification is created by the
 * server in response to a domain event, never by a client (spec §24, §44), so
 * the write path of this collection is unreachable over HTTP.
 *
 * All four require authentication and every scope is the session's account
 * (spec §44). Mark-read is a write, so both mark endpoints share one
 * per-account limiter (spec §36): a scripted read/unread loop is the same
 * flooding vector as a scripted create, just aimed at the badge.
 *
 * The literal routes are registered before the parameterised one so
 * `/unread-count` and `/read-all` can never be captured as ids.
 */

const express = require('express');
const config = require('../config/env');
const controller = require('../controllers/notification.controller');
const {
  notificationListQuerySchema,
  unreadCountQuerySchema,
  notificationIdParamSchema,
  markAllReadBodySchema,
  validateQuery
} = require('../validators/notification.validators');
const { validateBody, validateParams } = require('../validators/validate');
const { requireAuth } = require('../middleware/auth');
const { createRateLimiter } = require('../middleware/rateLimit');

const router = express.Router();

const markLimiter = createRateLimiter({
  name: 'notifications-mark',
  windowSeconds: config.notifications.rateLimit.windowSeconds,
  limit: config.notifications.rateLimit.max,
  keyGenerator: (req) => (req.auth ? req.auth.userId : 'anonymous'),
  validate: { keyGeneratorIpFallback: false }
});

router.get('/', requireAuth, validateQuery(notificationListQuerySchema), controller.list);
router.get('/unread-count', requireAuth, validateQuery(unreadCountQuerySchema), controller.unreadCount);
router.patch('/read-all', requireAuth, markLimiter, validateBody(markAllReadBodySchema), controller.markAllRead);
router.patch(
  '/:notificationId/read',
  requireAuth,
  markLimiter,
  validateParams(notificationIdParamSchema),
  controller.markRead
);

module.exports = router;
