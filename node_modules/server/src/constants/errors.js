'use strict';

/**
 * Authentication/authorisation error codes (spec §7, §31, §44, §77).
 *
 * These are the machine-readable `code` values returned in a failure envelope,
 * so a client can distinguish "please refresh" from "sign in again" without
 * string-matching a message. Later steps reuse them rather than inventing new
 * spellings (spec §77 error categories).
 */

const AUTH_ERROR_CODES = Object.freeze({
  /** No credential was presented at all. */
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  /** Signature/issuer/audience/format is wrong — the client must sign in again. */
  TOKEN_INVALID: 'TOKEN_INVALID',
  /** Signature is fine but the token is past its expiry — the client may refresh. */
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  /** The refresh token does not match any session, or the session is gone. */
  REFRESH_TOKEN_INVALID: 'REFRESH_TOKEN_INVALID',
  /** The session was revoked (logout, rotation, or a credential change). */
  SESSION_REVOKED: 'SESSION_REVOKED',
  /** The account exists but its status forbids access. */
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  /** Authenticated, but the role is not permitted for this route. */
  FORBIDDEN: 'FORBIDDEN'
});

/** Client-safe messages. No internals, no token fragments (spec §33, §77). */
const AUTH_MESSAGES = Object.freeze({
  AUTHENTICATION_REQUIRED: 'Authentication is required.',
  TOKEN_INVALID: 'Your session is invalid. Please sign in again.',
  TOKEN_EXPIRED: 'Your access token has expired.',
  REFRESH_TOKEN_INVALID: 'Your session has expired. Please sign in again.',
  SESSION_REVOKED: 'This session has been revoked. Please sign in again.',
  ACCOUNT_INACTIVE: 'This account is not active. Please contact support.',
  FORBIDDEN: 'You do not have permission to perform this action.'
});

module.exports = { AUTH_ERROR_CODES, AUTH_MESSAGES };
