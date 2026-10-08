'use strict';

/**
 * Authentication middleware (spec §7, §31, §44).
 *
 * Identity comes from the presented credential ONLY. Nothing in a body or query
 * can influence who the caller is (spec §31) — that is what makes object-level
 * authorization enforceable in later steps.
 *
 * Two bounded point lookups per protected request: the session row (so logout
 * and password changes revoke access immediately) and the user row (so a
 * suspended account is rejected even with an unexpired token).
 */

const tokenService = require('../services/tokenService');
const sessionService = require('../services/sessionService');
const User = require('../models/User');
const { UnauthorizedError, ForbiddenError } = require('../utils/AppError');
const { AUTH_ERROR_CODES, AUTH_MESSAGES } = require('../constants/errors');
const { STATUSES } = require('../constants/auth');

/** Extract a bearer token from the Authorization header. */
function extractBearerToken(req) {
  const header = req.get ? req.get('authorization') : req.headers?.authorization;
  if (typeof header !== 'string') return null;

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * Resolve the caller from the bearer token.
 *
 * @returns {Promise<{auth: object, user: object, session: object}|null>} null when no token was presented
 * @throws {UnauthorizedError|ForbiddenError} when a token was presented but is unusable
 */
async function resolveCaller(req) {
  const token = extractBearerToken(req);
  if (!token) return null;

  // Throws TOKEN_EXPIRED / TOKEN_INVALID with distinct codes.
  const claims = tokenService.verifyAccessToken(token);

  const session = await sessionService.findById(claims.sid);
  // A revoked or expired session must stop working immediately — that is what
  // makes logout and password changes effective for an unexpired access token.
  sessionService.assertActive(session);

  const user = await User.findById(claims.sub);
  if (!user) {
    throw new UnauthorizedError(AUTH_MESSAGES.TOKEN_INVALID, { code: AUTH_ERROR_CODES.TOKEN_INVALID });
  }
  if (user.status !== STATUSES.ACTIVE) {
    throw new ForbiddenError(AUTH_MESSAGES.ACCOUNT_INACTIVE, { code: AUTH_ERROR_CODES.ACCOUNT_INACTIVE });
  }

  return {
    auth: { userId: String(user._id), role: user.role, sessionId: String(session._id) },
    user,
    session
  };
}

/** Attach the resolved caller to the request. */
function attach(req, resolved) {
  req.auth = resolved.auth;
  req.user = resolved.user;
  req.session = resolved.session;
}

/**
 * Require a valid credential. Rejects with 401 when none is presented and with
 * 401/403 when the presented one is unusable.
 */
async function requireAuth(req, res, next) {
  const resolved = await resolveCaller(req);

  if (!resolved) {
    throw new UnauthorizedError(AUTH_MESSAGES.AUTHENTICATION_REQUIRED, {
      code: AUTH_ERROR_CODES.AUTHENTICATION_REQUIRED
    });
  }

  attach(req, resolved);
  return next();
}

/**
 * Populate `req.auth` when a valid credential is present, but never reject.
 * A malformed credential is treated as anonymous — useful for routes that show
 * more to a signed-in caller but work for everyone.
 */
async function optionalAuth(req, res, next) {
  try {
    const resolved = await resolveCaller(req);
    if (resolved) attach(req, resolved);
  } catch (err) {
    // Only credential problems are swallowed. Anything else is a real bug and
    // must still surface.
    const isCredentialProblem = err instanceof UnauthorizedError || err instanceof ForbiddenError;
    if (!isCredentialProblem) throw err;
  }
  return next();
}

module.exports = { requireAuth, optionalAuth, extractBearerToken, resolveCaller };
