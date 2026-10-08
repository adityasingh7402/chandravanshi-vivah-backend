'use strict';

/**
 * Authentication controller (spec §7, §33, §94, §95).
 *
 * Controllers orchestrate the request/response and nothing else — logic lives in
 * `services/authService.js` and `services/sessionService.js`. Express 5 forwards
 * a rejected promise from these async handlers to the error handler.
 */

const authService = require('../services/authService');
const sessionService = require('../services/sessionService');
const tokenService = require('../services/tokenService');
const { ok } = require('../utils/apiResponse');
const { setRefreshCookie } = require('../utils/cookies');
const { HTTP_STATUS } = require('../config/constants');
const { DEVICE_TYPES } = require('../constants/auth');
const { deviceNameFromRequest } = require('./session.controller');

/** POST /api/v1/auth/register */
async function register(req, res) {
  const user = await authService.register(req.body);
  return ok(res, { user }, 'Account created successfully.', HTTP_STATUS.CREATED);
}

/**
 * POST /api/v1/auth/login
 *
 * Verifies credentials, creates exactly one session for the device, and returns
 * a short-lived access token. Web receives the refresh token in an HttpOnly
 * cookie; a mobile client receives it in the body for platform secure storage
 * (spec §7, gate G3.3).
 */
async function login(req, res) {
  const user = await authService.verifyCredentials(req.body);
  const deviceType = req.body.deviceType || DEVICE_TYPES.WEB;

  const { accessToken, refreshToken } = await sessionService.startSession({
    userId: user.id,
    role: user.role,
    deviceType,
    deviceName: deviceNameFromRequest(req)
  });

  const payload = { user, accessToken, expiresIn: tokenService.accessTokenTtlSeconds() };

  if (deviceType === DEVICE_TYPES.WEB) {
    setRefreshCookie(res, refreshToken);
    return ok(res, payload, 'Login successful.');
  }

  return ok(res, { ...payload, refreshToken }, 'Login successful.');
}

/**
 * POST /api/v1/auth/change-password
 *
 * Requires an authenticated session (requireAuth runs first). All OTHER sessions
 * for the user are revoked, so a credential change ends access everywhere else
 * (spec §40, gate G2.6).
 */
async function changePassword(req, res) {
  const user = await authService.changePassword({
    userId: req.auth.userId,
    currentSessionId: req.auth.sessionId,
    currentPassword: req.body.currentPassword,
    newPassword: req.body.newPassword
  });

  return ok(res, { user }, 'Password changed successfully.');
}

module.exports = { register, login, changePassword };
