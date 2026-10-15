'use strict';

/**
 * Environment loading and validation (spec §79).
 *
 * Rules:
 *  - Validate at require time so a bad config stops the process at boot, never at first use.
 *  - Never print a value. Errors name the *field* and the reason only.
 *  - Export a frozen object so nothing can mutate config after startup.
 */

const path = require('path');
const dotenv = require('dotenv');
// Pure constants (no config import), so requiring this here cannot form a cycle.
const { SAFE_IMAGE_FORMATS } = require('../constants/photo');
// Plan ids are pure constants too (step 15), so the same no-cycle rule holds.
const { PLANS } = require('../constants/plans');
// Only the dial-code table is imported (a plain constant); identifier.js does
// not read config, so there is no cycle.
const { COUNTRY_DIAL_CODES } = require('../utils/identifier');

const NODE_ENVS = ['development', 'test', 'production'];
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const SIZE_RE = /^(\d+(\.\d+)?)(b|kb|mb|gb)?$/i;
const PORT_RE = /^\d{1,5}$/;
const URI_RE = /^mongodb(\+srv)?:\/\//i;
// scheme + host (+ optional port); no path, query or wildcard allowed
const ORIGIN_RE = /^(https?):\/\/(\[[0-9a-f:]+\]|[^/\s:]+)(:\d{1,5})?$/i;
const PLACEHOLDER_SECRET_RE = /change[_-]?me|replace[_-]?me|example[_-]?secret/i;

const UNIT_MS = Object.freeze({ ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 });

class ConfigurationError extends Error {
  constructor(field, reason) {
    // The field name and reason only — never the offending value.
    super(`Invalid environment configuration: ${field} ${reason}`);
    this.name = 'ConfigurationError';
    this.field = field;
    this.isOperational = true;
  }
}

function raw(field) {
  const value = process.env[field];
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}

function requireString(field, { maxLength = 4096 } = {}) {
  const value = raw(field);
  if (value === undefined) throw new ConfigurationError(field, 'is required but is not set.');
  if (value.length > maxLength) throw new ConfigurationError(field, `must be at most ${maxLength} characters.`);
  return value;
}

function optionalString(field, fallback) {
  const value = raw(field);
  return value === undefined ? fallback : value;
}

function oneOf(field, allowed, fallback) {
  const value = optionalString(field, fallback);
  if (!allowed.includes(value)) {
    throw new ConfigurationError(field, `must be one of: ${allowed.join(', ')}.`);
  }
  return value;
}

function integer(field, { fallback, min, max, unsetValues = [] }) {
  let value = raw(field);
  // e.g. PORT=0 means "no fixed port" on some shells and hosts; treat it as
  // unset so the value from .env applies. The result is still range-checked.
  if (unsetValues.includes(value)) value = undefined;
  if (value === undefined) value = fallback === undefined ? undefined : String(fallback);
  if (value === undefined) throw new ConfigurationError(field, 'is required but is not set.');
  if (!PORT_RE.test(value)) throw new ConfigurationError(field, 'must be a whole number.');
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new ConfigurationError(field, 'must be a whole number.');
  if (min !== undefined && parsed < min) throw new ConfigurationError(field, `must be >= ${min}.`);
  if (max !== undefined && parsed > max) throw new ConfigurationError(field, `must be <= ${max}.`);
  return parsed;
}

/** Parse a size like `5mb` into bytes. Used for upload limits (spec §80). */
function sizeToBytes(field, value) {
  const match = SIZE_RE.exec(String(value).toLowerCase());
  if (!match) throw new ConfigurationError(field, 'must be a size such as 5mb, 512kb or 1048576.');
  const unit = (match[3] || 'b').toLowerCase();
  const factor = unit === 'gb' ? 1024 ** 3 : unit === 'mb' ? 1024 ** 2 : unit === 'kb' ? 1024 : 1;
  const bytes = Math.round(Number(match[1]) * factor);
  if (bytes < 1) throw new ConfigurationError(field, 'must be a positive size.');
  return bytes;
}

function durationToMs(field, value) {
  const match = DURATION_RE.exec(value);
  if (!match) throw new ConfigurationError(field, 'must be a duration such as 15m, 7d, 3600s or 500ms.');
  return Number(match[1]) * UNIT_MS[match[2]];
}

function urlOrigin(field, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(field, 'must be an absolute http(s) URL such as https://example.com.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigurationError(field, 'must use http or https.');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new ConfigurationError(field, 'must be an origin only, with no path, query or fragment.');
  }
  return parsed.origin;
}

function loadEnvFile() {
  // Resolve relative to this package, not to process.cwd(), so the file is found
  // no matter where the process is started from.
  const envPath = path.resolve(__dirname, '..', '..', '.env');
  dotenv.config({ path: envPath, quiet: true });
}

function buildConfig() {
  loadEnvFile();

  const nodeEnv = oneOf('NODE_ENV', NODE_ENVS, 'development');
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  const port = integer('PORT', { fallback: 3000, min: 1, max: 65535, unsetValues: ['0'] });

  const apiPrefix = optionalString('API_PREFIX', '/api/v1');
  if (!/^\/[A-Za-z0-9/._-]*$/.test(apiPrefix) || !apiPrefix.startsWith('/')) {
    throw new ConfigurationError('API_PREFIX', 'must start with "/" and contain only path-safe characters.');
  }

  const appUrl = urlOrigin('APP_URL', requireString('APP_URL'));
  const apiUrl = urlOrigin('API_URL', requireString('API_URL'));

  const originsRaw = requireString('CORS_ORIGINS', { maxLength: 2048 })
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (originsRaw.length === 0) throw new ConfigurationError('CORS_ORIGINS', 'must list at least one origin.');

  const corsOrigins = originsRaw.map((origin) => {
    if (origin === '*' || origin.includes('*')) {
      throw new ConfigurationError('CORS_ORIGINS', 'must not contain a wildcard; list explicit origins.');
    }
    if (!ORIGIN_RE.test(origin)) {
      throw new ConfigurationError('CORS_ORIGINS', 'every entry must be an origin like https://example.com (no path).');
    }
    return origin;
  });

  const jsonBodyLimit = optionalString('JSON_BODY_LIMIT', '100kb').toLowerCase();
  if (!SIZE_RE.test(jsonBodyLimit)) {
    throw new ConfigurationError('JSON_BODY_LIMIT', 'must be a size such as 100kb, 1mb or 1048576.');
  }

  const rateLimitWindowSeconds = integer('RATE_LIMIT_WINDOW', { fallback: 60, min: 1, max: 86400 });
  const rateLimitMax = integer('RATE_LIMIT_MAX', { fallback: 100, min: 1, max: 100000 });

  const logLevel = oneOf('LOG_LEVEL', LOG_LEVELS, 'info');

  const jwtSecret = requireString('JWT_SECRET', { maxLength: 512 });
  if (PLACEHOLDER_SECRET_RE.test(jwtSecret)) {
    throw new ConfigurationError('JWT_SECRET', 'is still the placeholder value from .env.example.');
  }
  if (jwtSecret.length < 32) {
    throw new ConfigurationError('JWT_SECRET', 'must be at least 32 characters long.');
  }

  const jwtAccessTtl = requireString('JWT_ACCESS_TTL');
  const jwtRefreshTtl = requireString('JWT_REFRESH_TTL');
  const jwtAccessTtlMs = durationToMs('JWT_ACCESS_TTL', jwtAccessTtl);
  const jwtRefreshTtlMs = durationToMs('JWT_REFRESH_TTL', jwtRefreshTtl);
  if (jwtRefreshTtlMs <= jwtAccessTtlMs) {
    throw new ConfigurationError('JWT_REFRESH_TTL', 'must be longer than JWT_ACCESS_TTL.');
  }

  // --- Session / token transport (step 04) ------------------------------
  // Issuer and audience are checked on every verification, so a token minted
  // for another system cannot be replayed here.
  const jwtIssuer = optionalString('JWT_ISSUER', 'chandravanshi-vivah-api');
  if (!jwtIssuer || jwtIssuer.length > 128) {
    throw new ConfigurationError('JWT_ISSUER', 'must be between 1 and 128 characters.');
  }
  const jwtAudience = optionalString('JWT_AUDIENCE', 'chandravanshi-vivah-clients');
  if (!jwtAudience || jwtAudience.length > 128) {
    throw new ConfigurationError('JWT_AUDIENCE', 'must be between 1 and 128 characters.');
  }

  // Entropy for the opaque refresh token. 32 bytes = 256 bits.
  const refreshTokenBytes = integer('REFRESH_TOKEN_BYTES', { fallback: 32, min: 16, max: 128 });

  // Empty means "host-only cookie" (no Domain attribute).
  const cookieDomain = optionalString('COOKIE_DOMAIN', '');
  if (cookieDomain && !/^\.?[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(cookieDomain)) {
    throw new ConfigurationError('COOKIE_DOMAIN', 'must be a domain such as example.com, with no scheme or path.');
  }
  const cookieSameSite = oneOf('COOKIE_SAME_SITE', ['lax', 'strict', 'none'], 'lax');
  // Browsers drop SameSite=None without Secure, and Secure is only set in
  // production, so this combination would be a silently broken login.
  if (cookieSameSite === 'none' && !isProduction) {
    throw new ConfigurationError('COOKIE_SAME_SITE', 'cannot be "none" outside production because the cookie must be Secure.');
  }

  const mongodbUri = requireString('MONGODB_URI', { maxLength: 2048 });
  if (!URI_RE.test(mongodbUri)) {
    throw new ConfigurationError('MONGODB_URI', 'must start with mongodb:// or mongodb+srv://.');
  }

  // Database name is kept separate from the URI so it can differ per
  // environment without rewriting the secret connection string (step 02).
  const mongodbDbName = requireString('MONGODB_DB_NAME', { maxLength: 64 });
  if (!/^[A-Za-z0-9_-]+$/.test(mongodbDbName)) {
    throw new ConfigurationError('MONGODB_DB_NAME', 'must contain only letters, numbers, underscores or dashes.');
  }

  // --- Authentication (spec §40, §81) ----------------------------------
  const passwordMinLength = integer('PASSWORD_MIN_LENGTH', { fallback: 8, min: 8, max: 128 });
  const argon2Memory = integer('ARGON2_MEMORY', { fallback: 19456, min: 8192, max: 1048576 });
  const argon2Iterations = integer('ARGON2_ITERATIONS', { fallback: 2, min: 1, max: 20 });
  const argon2Parallelism = integer('ARGON2_PARALLELISM', { fallback: 1, min: 1, max: 16 });

  const defaultPhoneCountry = requireString('DEFAULT_PHONE_COUNTRY', { maxLength: 2 }).toUpperCase();
  if (!/^[A-Z]{2}$/.test(defaultPhoneCountry)) {
    throw new ConfigurationError('DEFAULT_PHONE_COUNTRY', 'must be a two-letter ISO country code such as IN.');
  }
  if (!COUNTRY_DIAL_CODES[defaultPhoneCountry]) {
    throw new ConfigurationError('DEFAULT_PHONE_COUNTRY', 'is not a supported country code.');
  }

  const authRateLimitWindow = integer('AUTH_RATE_LIMIT_WINDOW', { fallback: 900, min: 1, max: 86400 });
  const authRateLimitMax = integer('AUTH_RATE_LIMIT_MAX', { fallback: 10, min: 1, max: 100000 });

  // --- Master data (step 05) -------------------------------------------
  // Search is bounded at both ends: a query shorter than the minimum never
  // runs, and `limit` is clamped to the hard maximum (spec §73, §82).
  const masterSearchMinLen = integer('MASTER_SEARCH_MIN_LEN', { fallback: 2, min: 1, max: 10 });
  const masterSearchMaxLimit = integer('MASTER_SEARCH_MAX_LIMIT', { fallback: 50, min: 1, max: 500 });
  const masterDefaultLimit = integer('MASTER_DEFAULT_LIMIT', { fallback: 20, min: 1, max: 500 });
  if (masterDefaultLimit > masterSearchMaxLimit) {
    throw new ConfigurationError('MASTER_DEFAULT_LIMIT', 'must not exceed MASTER_SEARCH_MAX_LIMIT.');
  }
  const masterMissingMaxLen = integer('MASTER_MISSING_MAX_LEN', { fallback: 60, min: 1, max: 200 });
  const masterMissingEnabled = oneOf('MASTER_MISSING_ENABLED', ['true', 'false'], 'true') === 'true';

  // --- Profile (step 06) -----------------------------------------------
  // Bounds are config, not code: the dictionary and spec both call for a
  // *configured* age and height range (spec §81).
  const profileMinAge = integer('PROFILE_MIN_AGE', { fallback: 18, min: 16, max: 60 });
  const profileMaxAge = integer('PROFILE_MAX_AGE', { fallback: 70, min: 16, max: 120 });
  if (profileMinAge >= profileMaxAge) {
    throw new ConfigurationError('PROFILE_MIN_AGE', 'must be less than PROFILE_MAX_AGE.');
  }
  const profileMinHeightCm = integer('PROFILE_MIN_HEIGHT_CM', { fallback: 140, min: 50, max: 250 });
  const profileMaxHeightCm = integer('PROFILE_MAX_HEIGHT_CM', { fallback: 210, min: 50, max: 260 });
  if (profileMinHeightCm >= profileMaxHeightCm) {
    throw new ConfigurationError('PROFILE_MIN_HEIGHT_CM', 'must be less than PROFILE_MAX_HEIGHT_CM.');
  }
  const profileMaxHobbies = integer('PROFILE_MAX_HOBBIES', { fallback: 30, min: 1, max: 200 });
  const profileMaxInterests = integer('PROFILE_MAX_INTERESTS', { fallback: 30, min: 1, max: 200 });
  const profileMaxLanguages = integer('PROFILE_MAX_LANGUAGES', { fallback: 20, min: 1, max: 100 });
  const headlineMaxLen = integer('HEADLINE_MAX_LEN', { fallback: 100, min: 10, max: 300 });
  const aboutMaxLen = integer('ABOUT_MAX_LEN', { fallback: 1500, min: 100, max: 10000 });

  // --- Partner preferences (step 07) ------------------------------------
  // The default range a new preference document starts with, and the per-field
  // cap on every multi-select array (spec §16, §80, §81).
  const prefMinAgeDefault = integer('PREF_MIN_AGE_DEFAULT', {
    fallback: profileMinAge,
    min: profileMinAge,
    max: profileMaxAge
  });
  const prefMaxAgeDefault = integer('PREF_MAX_AGE_DEFAULT', {
    fallback: profileMaxAge,
    min: profileMinAge,
    max: profileMaxAge
  });
  if (prefMinAgeDefault > prefMaxAgeDefault) {
    throw new ConfigurationError('PREF_MIN_AGE_DEFAULT', 'must not exceed PREF_MAX_AGE_DEFAULT.');
  }
  const prefMaxMultiSelect = integer('PREF_MAX_MULTI_SELECT', { fallback: 20, min: 1, max: 200 });

  // --- Photos, Kundli documents & Cloudinary (step 08) ------------------
  //
  // The secret is server-only (spec §43, §79): nothing under `src/routes`,
  // `src/controllers` or any response ever reads it.
  //
  // Fail-fast rule: production must have all three values, and a PARTIAL set is
  // an error in every environment — someone who set the cloud name and the key
  // but not the secret has a typo, and silently running with uploads disabled
  // would be a much worse failure than refusing to boot. Test/development may
  // leave all three unset so the suite and the gate harnesses run without a
  // third-party account; the photo routes then answer 503 and no asset can be
  // registered (see `config/cloudinary.js`).
  const cloudinaryCloudName = optionalString('CLOUDINARY_CLOUD_NAME', undefined);
  const cloudinaryApiKey = optionalString('CLOUDINARY_API_KEY', undefined);
  const cloudinaryApiSecret = optionalString('CLOUDINARY_API_SECRET', undefined);
  const cloudinaryParts = [cloudinaryCloudName, cloudinaryApiKey, cloudinaryApiSecret];
  const cloudinaryConfigured = cloudinaryParts.every(Boolean);
  if (!cloudinaryConfigured && cloudinaryParts.some(Boolean)) {
    throw new ConfigurationError(
      'CLOUDINARY_CLOUD_NAME',
      'must be set together with CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET; a partial set is a configuration error.'
    );
  }
  if (isProduction && !cloudinaryConfigured) {
    throw new ConfigurationError(
      'CLOUDINARY_API_SECRET',
      'is required in production: photo uploads cannot be authorized without it (spec §43).'
    );
  }
  const cloudinaryUploadFolder = optionalString('CLOUDINARY_UPLOAD_FOLDER', 'chandravanshi-vivah');
  if (!/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(cloudinaryUploadFolder)) {
    throw new ConfigurationError('CLOUDINARY_UPLOAD_FOLDER', 'must be a folder path such as chandravanshi-vivah/dev (no leading slash).');
  }

  // A development / gate stand-in for the provider (`config/localAssetStore.js`)
  // so the whole sign -> upload -> verify -> register flow can be exercised
  // without an account. Two guards keep it out of harm's way:
  //   - never in production: a shipped server must refuse an upload it cannot
  //     actually store (spec §43);
  //   - never alongside real credentials: two sources of truth for one asset
  //     would make "did this file really upload?" unanswerable.
  const cloudinaryMock = oneOf('CLOUDINARY_MOCK', ['true', 'false'], 'false') === 'true';
  if (cloudinaryMock && isProduction) {
    throw new ConfigurationError('CLOUDINARY_MOCK', 'is not allowed in production; uploads must be verified by a real provider.');
  }
  if (cloudinaryMock && cloudinaryConfigured) {
    throw new ConfigurationError('CLOUDINARY_MOCK', 'cannot be combined with CLOUDINARY_* credentials; set exactly one mode.');
  }

  // Photo caps (spec §80). The count and the size are both config so the
  // product can change the limits without a code change.
  const photoMaxCount = integer('PHOTO_MAX_COUNT', { fallback: 10, min: 1, max: 100 });
  const photoMaxBytes = sizeToBytes('PHOTO_MAX_BYTES', optionalString('PHOTO_MAX_BYTES', '5mb'));
  if (photoMaxBytes > 25 * 1024 * 1024) {
    throw new ConfigurationError('PHOTO_MAX_BYTES', 'must be at most 25mb.');
  }

  // The configured allowlist is a SUBSET of the formats the code is willing to
  // serve (constants/photo.js). `svg` is deliberately absent there: an uploaded
  // SVG can carry script, so it must never become an image the API hands back.
  const photoFormatsRaw = optionalString('PHOTO_ALLOWED_FORMATS', 'jpg,jpeg,png,webp')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (photoFormatsRaw.length === 0) {
    throw new ConfigurationError('PHOTO_ALLOWED_FORMATS', 'must list at least one image format.');
  }
  for (const format of photoFormatsRaw) {
    if (!SAFE_IMAGE_FORMATS.includes(format)) {
      throw new ConfigurationError(
        'PHOTO_ALLOWED_FORMATS',
        `contains "${format}", which is not one of the servable image formats (${SAFE_IMAGE_FORMATS.join(', ')}).`
      );
    }
  }
  const photoAllowedFormats = Object.freeze([...new Set(photoFormatsRaw)]);

  // Cloudinary accepts a signed upload while the timestamp is within an hour of
  // the request, so a longer TTL here would be a promise the CDN does not keep.
  const photoSignTtlSeconds = integer('PHOTO_SIGN_TTL_SECONDS', { fallback: 600, min: 30, max: 3600 });

  // --- Discover / search (step 09) --------------------------------------
  // Page sizes are configured (spec §52, §80): the default is what a request
  // without `limit` gets, and the maximum is a hard cap the service clamps to
  // rather than a value that can be exceeded by asking for a bigger page.
  const searchDefaultLimit = integer('SEARCH_DEFAULT_LIMIT', { fallback: 20, min: 1, max: 200 });
  const searchMaxLimit = integer('SEARCH_MAX_LIMIT', { fallback: 50, min: 1, max: 200 });
  if (searchDefaultLimit > searchMaxLimit) {
    throw new ConfigurationError('SEARCH_DEFAULT_LIMIT', 'must not exceed SEARCH_MAX_LIMIT.');
  }
  // The radius cap for a distance search (spec §48).
  const searchMaxDistanceKm = integer('SEARCH_MAX_DISTANCE_KM', { fallback: 500, min: 1, max: 20000 });
  // The largest candidate window `recommended` will score in one request
  // (spec §54, §55) — never the whole collection.
  const searchCandidateCap = integer('SEARCH_CANDIDATE_CAP', { fallback: 200, min: 1, max: 5000 });

  // Guard for the exclusion `$nin` strategy (spec §99): a block list larger than
  // this must be handled by a different query shape, so the API refuses rather
  // than silently dropping an exclusion and showing a blocked profile.
  const exclusionMaxIds = integer('EXCLUSION_MAX_IDS', { fallback: 1000, min: 1, max: 100000 });

  // --- Profile actions (step 10) ----------------------------------------
  // Action writes are an obvious abuse vector (spec §36): a like, shortlist or
  // view is cheap to script, so each (account, action type) pair gets its own
  // bucket. The window and cap are configuration; the per-type buckets are code.
  const actionRateLimitWindow = integer('ACTION_RATE_LIMIT_WINDOW', { fallback: 60, min: 1, max: 86400 });
  const actionRateLimitMax = integer('ACTION_RATE_LIMIT_MAX', { fallback: 60, min: 1, max: 1000000 });
  // Page size for the caller's own action lists (shortlist, view history).
  const interactionsDefaultLimit = integer('INTERACTIONS_DEFAULT_LIMIT', { fallback: 20, min: 1, max: 100 });
  const interactionsMaxLimit = integer('INTERACTIONS_MAX_LIMIT', { fallback: 100, min: 1, max: 200 });
  if (interactionsDefaultLimit > interactionsMaxLimit) {
    throw new ConfigurationError('INTERACTIONS_DEFAULT_LIMIT', 'must not exceed INTERACTIONS_MAX_LIMIT.');
  }
  // Minimum gap before a repeat view may refresh the target's activity signal.
  // Without it a client that re-renders the same profile would write to the
  // target's profile on every render (spec §20, §36).
  const viewTouchThrottleMinutes = integer('VIEW_TOUCH_THROTTLE_MIN', { fallback: 15, min: 1, max: 1440 });

  // --- Connections / interests (step 11) --------------------------------
  // The optional note is text, capped per spec §34/§80. Sending interests is an
  // abuse vector (spec §36), so the send window is configuration like every
  // other limiter; the bucket key (the account) is code.
  const interestMessageMaxLen = integer('INTEREST_MESSAGE_MAX_LEN', { fallback: 500, min: 1, max: 2000 });
  const interestRateLimitWindow = integer('INTEREST_RATE_LIMIT_WINDOW', { fallback: 60, min: 1, max: 86400 });
  const interestRateLimitMax = integer('INTEREST_RATE_LIMIT_MAX', { fallback: 30, min: 1, max: 1000000 });
  // A pending interest that nobody answers eventually expires (spec §21, task 9).
  // No product value is published yet, so this is a configurable default rather
  // than an assumed policy — it is recorded as an open product decision.
  const interestExpiryDays = integer('INTEREST_EXPIRY_DAYS', { fallback: 30, min: 1, max: 3650 });
  // Page size for a connection list.
  const connectionsDefaultLimit = integer('CONNECTIONS_DEFAULT_LIMIT', { fallback: 20, min: 1, max: 100 });
  const connectionsMaxLimit = integer('CONNECTIONS_MAX_LIMIT', { fallback: 100, min: 1, max: 200 });
  if (connectionsDefaultLimit > connectionsMaxLimit) {
    throw new ConfigurationError('CONNECTIONS_DEFAULT_LIMIT', 'must not exceed CONNECTIONS_MAX_LIMIT.');
  }
  // Minimum gap between lazy expiry sweeps triggered by a read. Without it every
  // connection list would issue a write, and with it a stale row is still
  // answered as expired on the next read rather than sitting pending forever.
  const connectionsSweepIntervalSeconds = integer('CONNECTIONS_SWEEP_INTERVAL_SECONDS', { fallback: 60, min: 1, max: 86400 });

  // --- Safety: blocks & reports (step 12) -------------------------------
  // Both write paths can be abused (spec §36): blocking is an harassment vector
  // and reporting is a review-flooding vector, so each gets its own window.
  const blockReasonMaxLen = integer('BLOCK_REASON_MAX_LEN', { fallback: 200, min: 1, max: 2000 });
  const blockRateLimitWindow = integer('BLOCK_RATE_LIMIT_WINDOW', { fallback: 60, min: 1, max: 86400 });
  const blockRateLimitMax = integer('BLOCK_RATE_LIMIT_MAX', { fallback: 30, min: 1, max: 1000000 });
  const blocksDefaultLimit = integer('BLOCKS_DEFAULT_LIMIT', { fallback: 20, min: 1, max: 100 });
  const blocksMaxLimit = integer('BLOCKS_MAX_LIMIT', { fallback: 100, min: 1, max: 200 });
  if (blocksDefaultLimit > blocksMaxLimit) {
    throw new ConfigurationError('BLOCKS_DEFAULT_LIMIT', 'must not exceed BLOCKS_MAX_LIMIT.');
  }
  // The description is free text (spec §34, §80); the evidence array is bounded
  // in both dimensions so it can never carry a payload into a moderation screen.
  const reportDescriptionMaxLen = integer('REPORT_DESCRIPTION_MAX_LEN', { fallback: 1000, min: 1, max: 5000 });
  const reportEvidenceMaxItems = integer('REPORT_EVIDENCE_MAX_ITEMS', { fallback: 5, min: 1, max: 50 });
  const reportEvidenceMaxLen = integer('REPORT_EVIDENCE_MAX_LEN', { fallback: 500, min: 1, max: 2000 });
  const reportRateLimitWindow = integer('REPORT_RATE_LIMIT_WINDOW', { fallback: 60, min: 1, max: 86400 });
  const reportRateLimitMax = integer('REPORT_RATE_LIMIT_MAX', { fallback: 10, min: 1, max: 1000000 });
  const reportsDefaultLimit = integer('REPORTS_DEFAULT_LIMIT', { fallback: 20, min: 1, max: 100 });
  const reportsMaxLimit = integer('REPORTS_MAX_LIMIT', { fallback: 100, min: 1, max: 200 });
  if (reportsDefaultLimit > reportsMaxLimit) {
    throw new ConfigurationError('REPORTS_DEFAULT_LIMIT', 'must not exceed REPORTS_MAX_LIMIT.');
  }

  // --- Notifications (step 13) -----------------------------------------
  // Inbox pagination. DEFAULT must not exceed MAX (same rule as every list).
  const notificationsDefaultLimit = integer('NOTIFICATIONS_DEFAULT_LIMIT', { fallback: 20, min: 1, max: 100 });
  const notificationsMaxLimit = integer('NOTIFICATIONS_MAX_LIMIT', { fallback: 100, min: 1, max: 200 });
  if (notificationsDefaultLimit > notificationsMaxLimit) {
    throw new ConfigurationError('NOTIFICATIONS_DEFAULT_LIMIT', 'must not exceed NOTIFICATIONS_MAX_LIMIT.');
  }
  // Bounded growth (spec §36): a repeat profile view/shortlist from the same
  // actor inside this window refreshes the existing row instead of inserting a
  // new one, and `new_message` coalesces per conversation over its own window
  // (wired by step 14 through the same service).
  const notifyViewThrottleMinutes = integer('NOTIFY_VIEW_THROTTLE_MIN', { fallback: 15, min: 1, max: 1440 });
  const notifyMessageCoalesceMinutes = integer('NOTIFY_MESSAGE_COALESCE_MIN', { fallback: 5, min: 1, max: 1440 });
  // Mark-read is a write (spec §36): a client that hammers it is scripted, so
  // the read-marking endpoints get their own per-account bucket.
  const notifyRateLimitWindow = integer('NOTIFY_RATE_LIMIT_WINDOW', { fallback: 60, min: 1, max: 86400 });
  const notifyRateLimitMax = integer('NOTIFY_RATE_LIMIT_MAX', { fallback: 120, min: 1, max: 1000000 });

  // --- Subscription / entitlement (step 15) -----------------------------
  // The plan every registration receives. The value is validated against the
  // declared plan ids, so a typo stops the boot rather than granting an
  // unknown plan.
  const defaultFreePlan = oneOf('DEFAULT_FREE_PLAN', Object.values(PLANS), PLANS.FREE);
  // NOT used in the current phase (decisions §11): the free plan is granted
  // with `expiresAt: null` and never expires, and no code path computes an
  // expiry date from this value. It is declared only so a future explicit
  // payment-related update has its knob in place; changing it today has no
  // effect on any entitlement.
  const freeTrialDays = integer('FREE_TRIAL_DAYS', { fallback: 0, min: 0, max: 3650 });

  // --- Admin & moderation (step 16) -------------------------------------
  // Audit metadata is a bounded, non-sensitive context object (spec §29): the
  // key cap stops an audit row from becoming a place to dump a document.
  const adminActionMaxMetadataKeys = integer('ADMIN_ACTION_MAX_METADATA_KEYS', { fallback: 12, min: 1, max: 50 });
  // Admin lists follow the same DEFAULT ≤ MAX rule as every other list
  // (spec §80): the default is what a request without `limit` gets, and the
  // maximum is a hard cap the service clamps to.
  const adminDefaultLimit = integer('ADMIN_DEFAULT_LIMIT', { fallback: 20, min: 1, max: 500 });
  const adminMaxLimit = integer('ADMIN_MAX_LIMIT', { fallback: 100, min: 1, max: 500 });
  if (adminDefaultLimit > adminMaxLimit) {
    throw new ConfigurationError('ADMIN_DEFAULT_LIMIT', 'must not exceed ADMIN_MAX_LIMIT.');
  }
  // Admin routes are low-volume but privileged: their own limiter means a
  // runaway admin client cannot exhaust the global budget other users share,
  // and a stolen admin token is bounded (spec §36).
  const adminRateLimitWindow = integer('ADMIN_RATE_LIMIT_WINDOW', { fallback: 60, min: 1, max: 86400 });
  const adminRateLimitMax = integer('ADMIN_RATE_LIMIT_MAX', { fallback: 300, min: 1, max: 1000000 });

  const dbMaxPoolSize = integer('DB_MAX_POOL_SIZE', { fallback: 10, min: 1, max: 500 });
  const dbServerSelectionTimeoutMs = integer('DB_SERVER_SELECTION_TIMEOUT_MS', { fallback: 5000, min: 100, max: 60000 });
  const dbConnectTimeoutMs = integer('DB_CONNECT_TIMEOUT_MS', { fallback: 10000, min: 100, max: 120000 });
  // 0 means "no socket timeout" in the driver; only positive values are capped.
  const dbSocketTimeoutMs = integer('DB_SOCKET_TIMEOUT_MS', { fallback: 45000, min: 0, max: 300000 });

  return Object.freeze({
    nodeEnv,
    isDevelopment: nodeEnv === 'development',
    isTest,
    isProduction,
    port,
    apiPrefix,
    appUrl,
    apiUrl,
    corsOrigins: Object.freeze(corsOrigins),
    jsonBodyLimit,
    rateLimit: Object.freeze({ windowSeconds: rateLimitWindowSeconds, max: rateLimitMax }),
    logLevel,
    jwt: Object.freeze({
      secret: jwtSecret,
      issuer: jwtIssuer,
      audience: jwtAudience,
      accessTtl: jwtAccessTtl,
      accessTtlMs: jwtAccessTtlMs,
      refreshTtl: jwtRefreshTtl,
      refreshTtlMs: jwtRefreshTtlMs
    }),
    session: Object.freeze({
      refreshTokenBytes,
      // The refresh/session lifetime is JWT_REFRESH_TTL — one source of truth
      // for the session row, the cookie max-age and the rotation window.
      ttlMs: jwtRefreshTtlMs
    }),
    cookie: Object.freeze({
      domain: cookieDomain || undefined,
      sameSite: cookieSameSite,
      // A Secure cookie is mandatory in production (spec §37, §41).
      secure: isProduction
    }),
    auth: Object.freeze({
      passwordMinLength,
      // Argon2id cost parameters (spec §40). Raising these does not require a
      // data migration — passwordService.needsRehash() upgrades on next login.
      argon2: Object.freeze({
        memoryCost: argon2Memory,
        timeCost: argon2Iterations,
        parallelism: argon2Parallelism
      }),
      defaultPhoneCountry,
      rateLimit: Object.freeze({ windowSeconds: authRateLimitWindow, max: authRateLimitMax })
    }),
    masterData: Object.freeze({
      searchMinLen: masterSearchMinLen,
      maxLimit: masterSearchMaxLimit,
      defaultLimit: masterDefaultLimit,
      missingMaxLen: masterMissingMaxLen,
      // Global kill switch for the user-contributed ".missing" path. Per-category
      // rules live in constants/masterCategories.js.
      missingEnabled: masterMissingEnabled
    }),
    profile: Object.freeze({
      minAge: profileMinAge,
      maxAge: profileMaxAge,
      minHeightCm: profileMinHeightCm,
      maxHeightCm: profileMaxHeightCm,
      maxHobbies: profileMaxHobbies,
      maxInterests: profileMaxInterests,
      maxLanguages: profileMaxLanguages,
      headlineMaxLen,
      aboutMaxLen
    }),
    preference: Object.freeze({
      minAgeDefault: prefMinAgeDefault,
      maxAgeDefault: prefMaxAgeDefault,
      maxMultiSelect: prefMaxMultiSelect
    }),
    cloudinary: Object.freeze({
      // Never the secret: `configured` is a boolean and nothing else here is
      // sensitive (cloud name and API key are public by design — the API key is
      // sent to the browser inside every signature).
      configured: cloudinaryConfigured,
      // Development/gate stand-in; refused by config validation in production.
      mock: cloudinaryMock,
      cloudName: cloudinaryCloudName || undefined,
      apiKey: cloudinaryApiKey || undefined,
      apiSecret: cloudinaryApiSecret || undefined,
      uploadFolder: cloudinaryUploadFolder
    }),
    media: Object.freeze({
      photoMaxCount,
      photoMaxBytes,
      photoAllowedFormats,
      photoSignTtlSeconds
    }),
    search: Object.freeze({
      defaultLimit: searchDefaultLimit,
      maxLimit: searchMaxLimit,
      maxDistanceKm: searchMaxDistanceKm,
      candidateCap: searchCandidateCap
    }),
    exclusion: Object.freeze({ maxIds: exclusionMaxIds }),
    actions: Object.freeze({
      rateLimit: Object.freeze({ windowSeconds: actionRateLimitWindow, max: actionRateLimitMax }),
      defaultLimit: interactionsDefaultLimit,
      maxLimit: interactionsMaxLimit,
      viewTouchThrottleMinutes
    }),
    connections: Object.freeze({
      messageMaxLen: interestMessageMaxLen,
      rateLimit: Object.freeze({ windowSeconds: interestRateLimitWindow, max: interestRateLimitMax }),
      expiryDays: interestExpiryDays,
      defaultLimit: connectionsDefaultLimit,
      maxLimit: connectionsMaxLimit,
      sweepIntervalSeconds: connectionsSweepIntervalSeconds
    }),
    safety: Object.freeze({
      blockReasonMaxLen,
      blockRateLimit: Object.freeze({ windowSeconds: blockRateLimitWindow, max: blockRateLimitMax }),
      blocks: Object.freeze({ defaultLimit: blocksDefaultLimit, maxLimit: blocksMaxLimit }),
      report: Object.freeze({
        descriptionMaxLen: reportDescriptionMaxLen,
        evidenceMaxItems: reportEvidenceMaxItems,
        evidenceMaxLen: reportEvidenceMaxLen
      }),
      reportRateLimit: Object.freeze({ windowSeconds: reportRateLimitWindow, max: reportRateLimitMax }),
      reports: Object.freeze({ defaultLimit: reportsDefaultLimit, maxLimit: reportsMaxLimit })
    }),
    notifications: Object.freeze({
      defaultLimit: notificationsDefaultLimit,
      maxLimit: notificationsMaxLimit,
      viewThrottleMinutes: notifyViewThrottleMinutes,
      messageCoalesceMinutes: notifyMessageCoalesceMinutes,
      rateLimit: Object.freeze({ windowSeconds: notifyRateLimitWindow, max: notifyRateLimitMax })
    }),
    subscription: Object.freeze({
      defaultFreePlan,
      // Declared but unused in the current phase — see the note where it is parsed.
      freeTrialDays
    }),
    admin: Object.freeze({
      maxMetadataKeys: adminActionMaxMetadataKeys,
      defaultLimit: adminDefaultLimit,
      maxLimit: adminMaxLimit,
      rateLimit: Object.freeze({ windowSeconds: adminRateLimitWindow, max: adminRateLimitMax })
    }),
    mongodbUri,
    mongodbDbName,
    db: Object.freeze({
      maxPoolSize: dbMaxPoolSize,
      serverSelectionTimeoutMs: dbServerSelectionTimeoutMs,
      connectTimeoutMs: dbConnectTimeoutMs,
      socketTimeoutMs: dbSocketTimeoutMs,
      // Index auto-build is a development convenience only (spec §49, §105).
      autoIndex: nodeEnv === 'development'
    })
  });
}

const config = buildConfig();

module.exports = config;
