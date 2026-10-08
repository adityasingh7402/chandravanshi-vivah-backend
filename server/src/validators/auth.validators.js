'use strict';

/**
 * Authentication request validation (spec §34, §81, §117).
 *
 * Every schema is `.strict()`: an unexpected field is REJECTED, not ignored.
 * That is what stops `{"role":"admin"}` in a register body from ever reaching
 * the service (spec §31, §44).
 */

const { z } = require('zod');
const config = require('../config/env');
const { BadRequestError } = require('../utils/AppError');
const { IDENTIFIER_TYPE_VALUES, DEVICE_TYPE_VALUES, PASSWORD_MAX_LENGTH } = require('../constants/auth');

const identifierType = z.enum(IDENTIFIER_TYPE_VALUES, { message: 'Must be either "email" or "phone".' });

const identifier = z
  .string({ message: 'This field is required.' })
  .min(1, 'This field is required.')
  .max(254, 'This value is too long.');

const password = z
  .string({ message: 'A password is required.' })
  .min(config.auth.passwordMinLength, `Password must be at least ${config.auth.passwordMinLength} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);

/** Register: identifierType + identifier + password (spec §117). */
const registerSchema = z
  .object({ identifierType, identifier, password })
  .strict();

/**
 * Login: the password is only required to be present. Enforcing the registration
 * minimum here would answer "too short" for a wrong password and leak that the
 * guess could never have matched (spec §36).
 */
const loginSchema = z
  .object({
    identifierType,
    identifier,
    password: z
      .string({ message: 'A password is required.' })
      .min(1, 'A password is required.')
      .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`),
    // Which kind of client is signing in. `web` gets the HttpOnly refresh cookie;
    // a mobile client gets the refresh token in the body for secure storage.
    deviceType: z.enum(DEVICE_TYPE_VALUES, { message: 'Must be one of: web, android, ios.' }).optional()
  })
  .strict();

/** Change password: current password required; the new one must differ (spec §40). */
const changePasswordSchema = z
  .object({
    currentPassword: z
      .string({ message: 'Your current password is required.' })
      .min(1, 'Your current password is required.')
      .max(PASSWORD_MAX_LENGTH, `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`),
    newPassword: password
  })
  .strict()
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'The new password must differ from the current password.',
    path: ['newPassword']
  });

/**
 * Refresh: the token arrives in the HttpOnly cookie for web, or in the body for
 * a mobile client. Both are optional so an empty body is valid.
 */
const refreshSchema = z
  .object({
    refreshToken: z.string().min(1, 'This field must not be empty.').max(512, 'This value is too long.').optional(),
    deviceType: z.enum(DEVICE_TYPE_VALUES, { message: 'Must be one of: web, android, ios.' }).optional()
  })
  .strict();

/**
 * Turn a Zod schema into express middleware.
 *
 * On success `req.body` is replaced with the parsed value, so downstream code
 * only ever sees validated fields.
 *
 * @param {import('zod').ZodType} schema
 */
function validateBody(schema) {
  return function validate(req, res, next) {
    const result = schema.safeParse(req.body ?? {});

    if (!result.success) {
      // Field -> message. Array and missing-path issues collapse to a single key
      // so the envelope stays a predictable object (spec §33).
      const details = {};
      for (const issue of result.error.issues) {
        const key = issue.path.length ? issue.path.join('.') : '_';
        if (!(key in details)) details[key] = issue.message;
      }
      return next(new BadRequestError('Invalid request.', { details }));
    }

    req.body = result.data;
    return next();
  };
}

module.exports = {
  registerSchema,
  loginSchema,
  changePasswordSchema,
  refreshSchema,
  validateBody
};
