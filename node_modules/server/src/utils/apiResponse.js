'use strict';

const { HTTP_STATUS, MESSAGES } = require('../config/constants');

/**
 * Response envelope helpers (spec §33).
 *
 * Success: { "success": true,  "data": ..., "message": "..." }
 * Failure: { "success": false, "message": "..." }
 *
 * `details` is optional and only ever carries field-level validation feedback —
 * never internals, stack traces or driver messages (spec §33, §77).
 */

function ok(res, data = null, message = 'OK', status = HTTP_STATUS.OK) {
  return res.status(status).json({ success: true, data, message });
}

function fail(res, status, message = MESSAGES.INVALID_INPUT, details, extra) {
  const body = { success: false, message };
  if (details !== undefined && details !== null) body.details = details;
  // Optional caller-supplied additions. Only the error handler uses this, and
  // only for the non-production stack that config/env.js governs (spec §77).
  if (extra && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) body[key] = value;
    }
  }
  return res.status(status).json(body);
}

module.exports = { ok, fail };
