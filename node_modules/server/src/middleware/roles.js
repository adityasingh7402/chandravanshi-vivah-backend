'use strict';

/**
 * Role-based access control (spec §28, §31, §44).
 *
 * This is the ONLY place an authorization-by-role decision is made, so the rule
 * cannot drift per route. The role always comes from the server-side session
 * (`req.auth.role`, set by requireAuth from the token), never from a header,
 * body, or query value.
 *
 * Must be mounted AFTER requireAuth.
 */

const { UnauthorizedError, ForbiddenError } = require('../utils/AppError');
const { AUTH_ERROR_CODES, AUTH_MESSAGES } = require('../constants/errors');

/**
 * Allow only the listed roles.
 *
 * @param {...string} roles e.g. requireRole('admin', 'moderator')
 */
function requireRole(...roles) {
  if (roles.length === 0) {
    throw new Error('requireRole requires at least one role.');
  }

  return function roleGuard(req, res, next) {
    if (!req.auth) {
      return next(new UnauthorizedError(AUTH_MESSAGES.AUTHENTICATION_REQUIRED, {
        code: AUTH_ERROR_CODES.AUTHENTICATION_REQUIRED
      }));
    }

    if (!roles.includes(req.auth.role)) {
      return next(new ForbiddenError(AUTH_MESSAGES.FORBIDDEN, { code: AUTH_ERROR_CODES.FORBIDDEN }));
    }

    return next();
  };
}

module.exports = { requireRole };
