'use strict';

const { rateLimit } = require('express-rate-limit');
const config = require('../config/env');
const { fail } = require('../utils/apiResponse');
const { HTTP_STATUS, MESSAGES } = require('../config/constants');
const { logger, routeOf } = require('./requestLogger');

/**
 * Rate-limit factory (spec §36, §80).
 *
 * Step 01 installs one global limiter. The factory is exported so later steps can
 * mount stricter windows over the same envelope — register, login, refresh,
 * report, send interest, profile actions and master-data search.
 *
 * Limits always come from the caller or from config; nothing is hardcoded here.
 */
function createRateLimiter(options = {}) {
  const {
    name = 'global',
    windowSeconds = config.rateLimit.windowSeconds,
    limit = config.rateLimit.max,
    message = MESSAGES.RATE_LIMITED,
    keyGenerator,
    skip,
    // Express-rate-limit's own option set. A caller that keys by account and
    // action type (step 10) deliberately does not key by IP; that makes one of
    // the library's default validations inapplicable, so it is turned off here
    // rather than leaving a spurious warning in the boot log.
    validate
  } = options;

  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    throw new Error('createRateLimiter: windowSeconds must be a positive number.');
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('createRateLimiter: limit must be a positive number.');
  }

  return rateLimit({
    windowMs: windowSeconds * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    skip,
    ...(validate === undefined ? {} : { validate }),
    handler: (req, res) => {
      logger.warn({ reqId: req.id, route: routeOf(req), limiter: name }, 'rate limit exceeded');
      return fail(res, HTTP_STATUS.TOO_MANY_REQUESTS, message);
    }
  });
}

module.exports = { createRateLimiter };
