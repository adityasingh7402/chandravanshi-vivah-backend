'use strict';

/**
 * Token service (spec §7).
 *
 * Two different mechanisms by design:
 *   - The ACCESS token is a short-lived signed JWT. It carries no personal data
 *     — only the user id, the role and the session id (spec §30).
 *   - The REFRESH token is a high-entropy opaque random string. Only its SHA-256
 *     hash is stored, so a database leak yields nothing replayable (spec §7).
 */

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config/env');
const { UnauthorizedError } = require('../utils/AppError');
const { AUTH_ERROR_CODES, AUTH_MESSAGES } = require('../constants/errors');

/**
 * Pinned algorithm. Passing this to both sign and verify is what defeats
 * `alg: none` and HS/RS confusion attacks (gate G3.5).
 */
const ALGORITHM = 'HS256';

/**
 * Sign a short-lived access token.
 *
 * @param {{userId: string, role: string, sessionId: string}} input
 * @returns {string} the signed JWT
 */
function signAccessToken({ userId, role, sessionId }) {
  return jwt.sign(
    { sub: String(userId), role, sid: String(sessionId) },
    config.jwt.secret,
    {
      algorithm: ALGORITHM,
      expiresIn: config.jwt.accessTtl,
      issuer: config.jwt.issuer,
      audience: config.jwt.audience
    }
  );
}

/**
 * Verify an access token.
 *
 * Expired and invalid tokens are distinguished with typed errors so the client
 * knows whether to refresh or to sign in again (gate G2.7).
 *
 * @param {string} token
 * @returns {{sub: string, role: string, sid: string, iat: number, exp: number}}
 * @throws {UnauthorizedError} with code TOKEN_EXPIRED or TOKEN_INVALID
 */
function verifyAccessToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new UnauthorizedError(AUTH_MESSAGES.TOKEN_INVALID, { code: AUTH_ERROR_CODES.TOKEN_INVALID });
  }

  try {
    return jwt.verify(token, config.jwt.secret, {
      algorithms: [ALGORITHM],
      issuer: config.jwt.issuer,
      audience: config.jwt.audience
    });
  } catch (err) {
    if (err && err.name === 'TokenExpiredError') {
      throw new UnauthorizedError(AUTH_MESSAGES.TOKEN_EXPIRED, { code: AUTH_ERROR_CODES.TOKEN_EXPIRED });
    }
    throw new UnauthorizedError(AUTH_MESSAGES.TOKEN_INVALID, { code: AUTH_ERROR_CODES.TOKEN_INVALID });
  }
}

/**
 * SHA-256 of a refresh token. A fast hash is correct here: the token already has
 * 256 bits of entropy, so it is not guessable and does not need a slow KDF —
 * unlike a user-chosen password.
 *
 * @param {string} token
 * @returns {string} lowercase hex digest
 */
function hashRefreshToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * Mint a new opaque refresh token. The raw value is returned exactly once, to
 * be handed to the client; the caller stores only `hash`.
 *
 * @returns {{token: string, hash: string}}
 */
function issueRefreshToken() {
  const token = crypto.randomBytes(config.session.refreshTokenBytes).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/** Access-token lifetime in seconds, for a client that wants to schedule refresh. */
function accessTokenTtlSeconds() {
  return Math.floor(config.jwt.accessTtlMs / 1000);
}

module.exports = {
  ALGORITHM,
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  hashRefreshToken,
  accessTokenTtlSeconds
};
