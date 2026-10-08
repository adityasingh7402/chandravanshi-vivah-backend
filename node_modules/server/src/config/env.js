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
      accessTtl: jwtAccessTtl,
      accessTtlMs: jwtAccessTtlMs,
      refreshTtl: jwtRefreshTtl,
      refreshTtlMs: jwtRefreshTtlMs
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
