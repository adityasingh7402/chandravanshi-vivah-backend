'use strict';

/**
 * Identifier normalisation (spec §5, §34, §117).
 *
 * Normalising before storage AND before lookup is what stops `User@x.com` and
 * `user@x.com` becoming two accounts. Every identifier that reaches the users
 * collection passes through this module first.
 */

const { BadRequestError } = require('./AppError');

/**
 * Country calling codes for phone normalisation.
 *
 * Only the countries this product realistically receives are listed; add more as
 * needed. `DEFAULT_PHONE_COUNTRY` must be one of these keys (validated at boot).
 */
const COUNTRY_DIAL_CODES = Object.freeze({
  IN: '91',
  US: '1',
  CA: '1',
  GB: '44',
  AU: '61',
  NZ: '64',
  AE: '971',
  SA: '966',
  QA: '974',
  KW: '965',
  OM: '968',
  BH: '973',
  SG: '65',
  MY: '60',
  NP: '977',
  LK: '94',
  BD: '880',
  PK: '92'
});

// A deliberately permissive but safe email shape: no whitespace, one @, dotted domain.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;
// E.164: "+", a non-zero leading digit, then 7–14 more digits (8–15 total).
// The lower bound rejects values too short to be a real number.
const E164_RE = /^\+[1-9]\d{7,14}$/;

/** @returns {string|null} the dial code for an ISO country code, or null */
function dialCodeFor(country) {
  return COUNTRY_DIAL_CODES[String(country || '').toUpperCase()] || null;
}

/**
 * Trim, lowercase and validate an email address.
 * @param {unknown} value
 * @returns {string}
 * @throws {BadRequestError} with a field-level message
 */
function normaliseEmail(value) {
  if (typeof value !== 'string') {
    throw new BadRequestError('Invalid request.', { details: { identifier: 'Enter a valid email address.' } });
  }
  const normalised = value.trim().toLowerCase();
  if (!normalised || normalised.length > EMAIL_MAX_LENGTH || !EMAIL_RE.test(normalised)) {
    throw new BadRequestError('Invalid request.', { details: { identifier: 'Enter a valid email address.' } });
  }
  return normalised;
}

/**
 * Normalise a phone number to E.164 (spec §34).
 *
 * Accepts `+919999999999`, `00919999999999`, `9999999999` (with a default
 * country), and tolerates spaces, dashes, dots and parentheses.
 *
 * @param {unknown} value
 * @param {string} [country] ISO country code used when no country code is present
 * @returns {string}
 * @throws {BadRequestError}
 */
function normalisePhone(value, country) {
  const invalid = () => new BadRequestError('Invalid request.', {
    details: { identifier: 'Enter a valid phone number in international format, e.g. +919999999999.' }
  });

  if (typeof value !== 'string') throw invalid();

  // Keep digits and a single leading '+'.
  let cleaned = value.trim().replace(/[\s().\-/]/g, '');
  if (cleaned.startsWith('00')) cleaned = `+${cleaned.slice(2)}`;

  if (!cleaned.startsWith('+')) {
    const dial = dialCodeFor(country);
    if (!dial) throw invalid();
    cleaned = `+${dial}${cleaned.replace(/^\+/, '')}`;
  }

  if (!E164_RE.test(cleaned)) throw invalid();
  return cleaned;
}

/**
 * Guess the identifier type from its shape.
 * @param {unknown} value
 * @returns {'email'|'phone'|'unknown'}
 */
function detectType(value) {
  if (typeof value !== 'string') return 'unknown';
  const trimmed = value.trim();
  if (!trimmed) return 'unknown';
  if (trimmed.includes('@')) return 'email';
  if (/^[+]?[\d\s().\-/]+$/.test(trimmed)) return 'phone';
  return 'unknown';
}

/**
 * Normalise an identifier given the request's declared `identifierType`.
 *
 * The declared type must agree with the identifier's shape, so a phone cannot be
 * smuggled through the email path (or vice versa).
 *
 * @param {{identifierType: string, identifier: unknown, country?: string}} input
 * @returns {{type: 'email'|'phone', value: string}}
 */
function normaliseIdentifier({ identifierType, identifier, country }) {
  if (identifierType === 'email') {
    // Reject a clearly non-email value before normalising, so the message names the field.
    if (detectType(identifier) === 'phone') {
      throw new BadRequestError('Invalid request.', { details: { identifier: 'Enter a valid email address.' } });
    }
    return { type: 'email', value: normaliseEmail(identifier) };
  }

  if (identifierType === 'phone') {
    return { type: 'phone', value: normalisePhone(identifier, country) };
  }

  throw new BadRequestError('Invalid request.', {
    details: { identifierType: 'Must be either "email" or "phone".' }
  });
}

module.exports = {
  COUNTRY_DIAL_CODES,
  EMAIL_MAX_LENGTH,
  dialCodeFor,
  normaliseEmail,
  normalisePhone,
  detectType,
  normaliseIdentifier
};
