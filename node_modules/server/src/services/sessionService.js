'use strict';

/**
 * Session service (spec §7, §40).
 *
 * Owns the `sessions` collection: one row per logged-in device, holding only a
 * hash of the refresh token. Rotation on every refresh is what makes a stolen
 * refresh token single-use.
 */

const config = require('../config/env');
const Session = require('../models/Session');
const User = require('../models/User');
const tokenService = require('./tokenService');
const { UnauthorizedError, ForbiddenError } = require('../utils/AppError');
const { AUTH_ERROR_CODES, AUTH_MESSAGES } = require('../constants/errors');
const { STATUSES } = require('../constants/auth');

/** When a new session should expire. */
function expiryFrom(now = Date.now()) {
  return new Date(now + config.session.ttlMs);
}

/** Look a session up by a PRESENTED refresh token (hashed before the query). */
async function findByToken(rawToken) {
  if (typeof rawToken !== 'string' || rawToken.length === 0) return null;
  return Session.findOne({ refreshTokenHash: tokenService.hashRefreshToken(rawToken) });
}

/** Load a session by id — used by the auth middleware for immediate revocation. */
async function findById(sessionId) {
  if (!sessionId) return null;
  return Session.findById(sessionId);
}

function assertActive(session, now = new Date()) {
  if (!session) {
    throw new UnauthorizedError(AUTH_MESSAGES.SESSION_REVOKED, { code: AUTH_ERROR_CODES.SESSION_REVOKED });
  }
  if (session.revokedAt !== null) {
    throw new UnauthorizedError(AUTH_MESSAGES.SESSION_REVOKED, { code: AUTH_ERROR_CODES.SESSION_REVOKED });
  }
  if (session.expiresAt <= now) {
    throw new UnauthorizedError(AUTH_MESSAGES.REFRESH_TOKEN_INVALID, { code: AUTH_ERROR_CODES.REFRESH_TOKEN_INVALID });
  }
  return session;
}

/**
 * Create a session document and mint the matching access token.
 *
 * @param {{userId: string, role: string, deviceType?: string, deviceName?: string|null}} input
 * @returns {Promise<{accessToken: string, refreshToken: string, session: object}>}
 */
async function startSession({ userId, role, deviceType = 'web', deviceName = null }) {
  const { token, hash } = tokenService.issueRefreshToken();

  const session = await Session.create({
    userId,
    refreshTokenHash: hash,
    deviceType,
    deviceName,
    lastUsedAt: new Date(),
    expiresAt: expiryFrom()
  });

  const accessToken = tokenService.signAccessToken({ userId, role, sessionId: session._id });
  return { accessToken, refreshToken: token, session };
}

/** Record that a session was used. Best-effort: a failure must not fail the request. */
async function touch(session) {
  if (!session || typeof session.save !== 'function') return;
  session.lastUsedAt = new Date();
  await session.save();
}

/** Revoke one session. Idempotent. */
async function revoke(session) {
  if (!session) return null;
  if (session.revokedAt !== null) return session;
  session.revokedAt = new Date();
  await session.save();
  return session;
}

/** Revoke a session by id (logout path). */
async function revokeById(sessionId) {
  const session = await findById(sessionId);
  return revoke(session);
}

/**
 * Revoke every active session for a user.
 * Used on a password change so other devices lose access (spec §40).
 *
 * @param {string} userId
 * @param {{exceptSessionId?: string}} [options] keep one session alive (the caller's own)
 */
async function revokeAllForUser(userId, { exceptSessionId } = {}) {
  const filter = { userId, revokedAt: null };
  if (exceptSessionId) filter._id = { $ne: exceptSessionId };
  const result = await Session.updateMany(filter, { $set: { revokedAt: new Date() } });
  return result.modifiedCount;
}

/**
 * Rotate a refresh token: verify the presented one, revoke it, and issue a new
 * session. Re-presenting a rotated token is rejected because its row is revoked
 * (gate G2.4).
 *
 * @param {{rawToken: string, deviceType?: string, deviceName?: string|null}} input
 * @returns {Promise<{accessToken: string, refreshToken: string, session: object}>}
 */
async function rotate({ rawToken, deviceType, deviceName }) {
  const session = await findByToken(rawToken);
  if (!session) {
    throw new UnauthorizedError(AUTH_MESSAGES.REFRESH_TOKEN_INVALID, { code: AUTH_ERROR_CODES.REFRESH_TOKEN_INVALID });
  }

  assertActive(session);

  const user = await User.findById(session.userId);
  if (!user) {
    await revoke(session);
    throw new UnauthorizedError(AUTH_MESSAGES.REFRESH_TOKEN_INVALID, { code: AUTH_ERROR_CODES.REFRESH_TOKEN_INVALID });
  }
  if (user.status !== STATUSES.ACTIVE) {
    await revokeAllForUser(user._id);
    throw new ForbiddenError(AUTH_MESSAGES.ACCOUNT_INACTIVE, { code: AUTH_ERROR_CODES.ACCOUNT_INACTIVE });
  }

  // Rotate: the old row is revoked, never reused.
  await revoke(session);

  return startSession({
    userId: user._id,
    role: user.role,
    deviceType: deviceType || session.deviceType,
    deviceName: deviceName ?? session.deviceName
  });
}

module.exports = {
  expiryFrom,
  findByToken,
  findById,
  assertActive,
  startSession,
  touch,
  revoke,
  revokeById,
  revokeAllForUser,
  rotate
};
