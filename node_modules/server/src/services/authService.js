'use strict';

/**
 * Authentication service (spec §5, §6, §40, §94, §95).
 *
 * Business logic lives here; controllers only orchestrate request/response.
 * The service returns sanitised public objects — never a document with
 * `passwordHash` on it.
 */

const crypto = require('crypto');
const config = require('../config/env');
const User = require('../models/User');
const passwordService = require('./passwordService');
const sessionService = require('./sessionService');
const { normaliseIdentifier } = require('../utils/identifier');
const { ConflictError, UnauthorizedError, ForbiddenError, BadRequestError } = require('../utils/AppError');
const { logger } = require('../middleware/requestLogger');
const {
  ROLES,
  STATUSES,
  DUPLICATE_MESSAGES,
  INVALID_CREDENTIALS_MESSAGE,
  WRONG_CURRENT_PASSWORD_MESSAGE,
  AUDIT_ACTIONS
} = require('../constants/auth');

/**
 * Record a sensitive account action.
 *
 * The `audit_logs` model arrives in step 16; until then the event is written to
 * the structured log (action + user id only — never a password or hash). Step 16
 * replaces this body with a persisted audit document (spec §78, §29).
 */
function audit(action, fields = {}) {
  logger.info({ audit: true, action, ...fields }, `audit: ${action}`);
}

// A hash of a random value, used to spend comparable CPU when an identifier does
// not exist, so login timing cannot reveal whether an account exists.
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) dummyHashPromise = passwordService.hash(crypto.randomUUID());
  return dummyHashPromise;
}

/**
 * Build the users-collection lookup for a normalised identifier.
 *
 * The email/phone unique indexes are PARTIAL (`partialFilterExpression` on
 * `$type: "string"`), and MongoDB only uses a partial index when the query
 * itself includes that filter predicate. A plain `{ email: value }` lookup is
 * planned as a COLLSCAN — verified with `explain()` — so the `$type` predicate
 * is part of the query. `tests/auth.test.js` asserts the plan is an IXSCAN.
 *
 * @param {'email'|'phone'} type
 * @param {string} value normalised identifier
 */
function identifierQuery(type, value) {
  const field = type === 'email' ? 'email' : 'phone';
  return { $and: [{ [field]: value }, { [field]: { $type: 'string' } }] };
}

/**
 * Register a new account (spec §117).
 *
 * @param {{identifierType: string, identifier: string, password: string}} input
 * @returns {Promise<object>} the public user shape
 */
async function register({ identifierType, identifier, password }) {
  const { type, value } = normaliseIdentifier({
    identifierType,
    identifier,
    country: config.auth.defaultPhoneCountry
  });

  // Friendly 409 before hashing; the unique index still guards the race below.
  const existing = await User.findOne(identifierQuery(type, value)).select('_id');
  if (existing) throw new ConflictError(DUPLICATE_MESSAGES[type]);

  const passwordHash = await passwordService.hash(password);

  const document = {
    email: null,
    phone: null,
    passwordHash,
    // Role and status are server-decided; a request body can never set them (spec §31, §44).
    role: ROLES.USER,
    status: STATUSES.ACTIVE
  };
  document[type] = value;

  let user;
  try {
    user = await User.create(document);
  } catch (err) {
    // Losing the race on the unique index is still a duplicate, not a 500.
    if (err && err.code === 11000) throw new ConflictError(DUPLICATE_MESSAGES[type]);
    throw err;
  }

  audit(AUDIT_ACTIONS.REGISTER, { userId: String(user._id) });
  return user.toPublic();
}

/**
 * Verify credentials for login (spec §36, §40).
 *
 * Unknown identifier and wrong password produce the SAME error, so the login
 * path cannot be used to enumerate accounts.
 *
 * @param {{identifierType: string, identifier: string, password: string}} input
 * @returns {Promise<object>} the public user shape (token issuance is step 04)
 */
async function verifyCredentials({ identifierType, identifier, password }) {
  const { type, value } = normaliseIdentifier({
    identifierType,
    identifier,
    country: config.auth.defaultPhoneCountry
  });

  // `passwordHash` is select:false, so it must be asked for explicitly here.
  const user = await User.findOne(identifierQuery(type, value)).select('+passwordHash');

  if (!user) {
    // Burn comparable CPU so timing does not distinguish "no such account".
    await passwordService.verify(await dummyHash(), password);
    throw new UnauthorizedError(INVALID_CREDENTIALS_MESSAGE);
  }

  const matches = await passwordService.verify(user.passwordHash, password);
  if (!matches) throw new UnauthorizedError(INVALID_CREDENTIALS_MESSAGE);

  // Only a holder of the correct password sees the account-state message, so
  // this does not leak account existence.
  if (user.status !== STATUSES.ACTIVE) {
    throw new ForbiddenError('This account is not active. Please contact support.');
  }

  // Transparently upgrade a hash produced with weaker parameters (spec §40).
  if (passwordService.needsRehash(user.passwordHash)) {
    user.passwordHash = await passwordService.hash(password);
  }
  user.lastLoginAt = new Date();
  await user.save();

  audit(AUDIT_ACTIONS.LOGIN, { userId: String(user._id) });
  return user.toPublic();
}

/**
 * Change the password of an already-authenticated user (spec §6, §40).
 *
 * Requires the current password. There is deliberately NO self-service reset:
 * an unverified email or phone is not a trustworthy identity proof (spec §6).
 *
 * @param {{userId: string, currentPassword: string, newPassword: string,
 *          currentSessionId?: string}} input
 * @returns {Promise<object>} the public user shape
 */
async function changePassword({ userId, currentPassword, newPassword, currentSessionId }) {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw new UnauthorizedError('Authentication is required.');

  const currentMatches = await passwordService.verify(user.passwordHash, currentPassword);
  if (!currentMatches) {
    throw new BadRequestError(WRONG_CURRENT_PASSWORD_MESSAGE, {
      details: { currentPassword: WRONG_CURRENT_PASSWORD_MESSAGE }
    });
  }

  if (currentPassword === newPassword) {
    throw new BadRequestError('Invalid request.', {
      details: { newPassword: 'The new password must differ from the current password.' }
    });
  }

  user.passwordHash = await passwordService.hash(newPassword);
  await user.save();

  // A credential change ends access on every other device (spec §40, gate G2.6).
  // The caller's own session is kept alive so they are not signed out by their
  // own action.
  const revoked = await sessionService.revokeAllForUser(user._id, { exceptSessionId: currentSessionId });

  audit(AUDIT_ACTIONS.CHANGE_PASSWORD, { userId: String(user._id), otherSessionsRevoked: revoked });

  return user.toPublic();
}

module.exports = { register, verifyCredentials, changePassword, identifierQuery };
