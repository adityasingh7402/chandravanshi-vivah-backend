'use strict';

/**
 * Session controller (spec §7, §44, §94).
 *
 * Thin orchestration only; the session lifecycle lives in
 * `services/sessionService.js`.
 */

const sessionService = require('../services/sessionService');
const tokenService = require('../services/tokenService');
const { ok } = require('../utils/apiResponse');
const { setRefreshCookie, clearRefreshCookie, readRefreshCookie } = require('../utils/cookies');
const { UnauthorizedError } = require('../utils/AppError');
const { AUTH_ERROR_CODES, AUTH_MESSAGES } = require('../constants/errors');

/**
 * A short, sanitised device label derived from the user agent. Never trusted as
 * a free-form string from the client (step 04 task 10).
 */
function deviceNameFromRequest(req) {
  const userAgent = req.get ? req.get('user-agent') : req.headers?.['user-agent'];
  if (typeof userAgent !== 'string' || userAgent.trim().length === 0) return null;
  return userAgent.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * POST /api/v1/auth/refresh
 *
 * Rotates the session. A browser presents the HttpOnly cookie and receives a new
 * cookie; a mobile client presents the refresh token in the body and receives a
 * new one there. The token is never returned in both places (gate G3.3).
 */
async function refresh(req, res) {
  const cookieToken = readRefreshCookie(req);
  const bodyToken = req.body && typeof req.body.refreshToken === 'string' ? req.body.refreshToken : null;
  const presented = cookieToken || bodyToken;

  if (!presented) {
    throw new UnauthorizedError(AUTH_MESSAGES.REFRESH_TOKEN_INVALID, {
      code: AUTH_ERROR_CODES.REFRESH_TOKEN_INVALID
    });
  }

  const { accessToken, refreshToken } = await sessionService.rotate({
    rawToken: presented,
    deviceType: req.body ? req.body.deviceType : undefined
  });

  const payload = { accessToken, expiresIn: tokenService.accessTokenTtlSeconds() };

  if (cookieToken) {
    setRefreshCookie(res, refreshToken);
    return ok(res, payload, 'Token refreshed.');
  }

  return ok(res, { ...payload, refreshToken }, 'Token refreshed.');
}

/**
 * POST /api/v1/auth/logout
 *
 * Revokes the caller's own session only, so other devices stay signed in
 * (gate G2.5).
 */
async function logout(req, res) {
  await sessionService.revokeById(req.auth.sessionId);
  clearRefreshCookie(res);
  return ok(res, null, 'Signed out.');
}

/**
 * GET /api/v1/auth/me
 *
 * The caller's own account summary. `toPublic()` is the only shape returned, so
 * the hash and internal fields cannot leak (gate G5.4).
 */
async function me(req, res) {
  return ok(res, { user: req.user.toPublic() }, 'OK');
}

module.exports = { refresh, logout, me, deviceNameFromRequest };
