'use strict';

/**
 * Authentication constants (spec §5, §6, §40, §77, §117).
 *
 * Enum values are frozen and exported as arrays so both the Mongoose schema and
 * the request validators use one definition. Client-safe messages live here too,
 * so a wording change happens in one place.
 */

/** `User.role` — server-decided only; a request body may never set this (spec §31, §44). */
const ROLES = Object.freeze({
  USER: 'user',
  ADMIN: 'admin',
  MODERATOR: 'moderator'
});

/** Order matches spec §5 exactly. */
const ROLE_VALUES = Object.freeze(['user', 'admin', 'moderator']);

/** `User.status` (spec §5). */
const STATUSES = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  BLOCKED: 'blocked',
  DELETED: 'deleted'
});

const STATUS_VALUES = Object.freeze(['active', 'suspended', 'blocked', 'deleted']);

/** The two identifier shapes a `users` document may carry (spec §5, §117). */
const IDENTIFIER_TYPES = Object.freeze({ EMAIL: 'email', PHONE: 'phone' });
const IDENTIFIER_TYPE_VALUES = Object.freeze(['email', 'phone']);

/**
 * Session device types (spec §7). `web` keeps the refresh token in an HttpOnly
 * cookie; `android`/`ios` keep it in platform secure storage (spec §7, §41).
 */
const DEVICE_TYPES = Object.freeze({ WEB: 'web', ANDROID: 'android', IOS: 'ios' });
const DEVICE_TYPE_VALUES = Object.freeze(['web', 'android', 'ios']);

/** Upper bound for a submitted password (Argon2id has no 72-byte limit; this is abuse control). */
const PASSWORD_MAX_LENGTH = 128;

/**
 * Duplicate-identifier messages. The email wording is the exact example from
 * spec §77; the phone variant mirrors it.
 */
const DUPLICATE_MESSAGES = Object.freeze({
  email: 'A profile with this email already exists.',
  phone: 'A profile with this phone number already exists.'
});

/** One generic login failure for unknown identifier and wrong password (spec §36, §40). */
const INVALID_CREDENTIALS_MESSAGE = 'Invalid credentials.';

/** Wrong current password on an already-authenticated change-password request. */
const WRONG_CURRENT_PASSWORD_MESSAGE = 'Current password is incorrect.';

/** Sensitive account actions recorded in the audit trail (persisted in step 16). */
const AUDIT_ACTIONS = Object.freeze({
  REGISTER: 'auth.register',
  LOGIN: 'auth.login',
  CHANGE_PASSWORD: 'auth.change_password'
});

module.exports = {
  ROLES,
  ROLE_VALUES,
  STATUSES,
  STATUS_VALUES,
  IDENTIFIER_TYPES,
  IDENTIFIER_TYPE_VALUES,
  DEVICE_TYPES,
  DEVICE_TYPE_VALUES,
  PASSWORD_MAX_LENGTH,
  DUPLICATE_MESSAGES,
  INVALID_CREDENTIALS_MESSAGE,
  WRONG_CURRENT_PASSWORD_MESSAGE,
  AUDIT_ACTIONS
};
