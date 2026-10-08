'use strict';

/**
 * Shared API constants (spec §33, §80).
 *
 * Anything that varies per deployment lives in config/env.js instead.
 * This module holds values that are part of the API contract itself.
 */

const API_PREFIX = '/api/v1';

const HTTP_STATUS = Object.freeze({
  OK: 200,
  CREATED: 201,
  NO_CONTENT: 204,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNPROCESSABLE_ENTITY: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503
});

/** Stable machine-readable error codes (spec §77). */
const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
  AUTHORIZATION_ERROR: 'AUTHORIZATION_ERROR',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  MALFORMED_JSON: 'MALFORMED_JSON',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
});

/** Pagination bounds (spec §80). */
const PAGINATION = Object.freeze({
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
  MIN_LIMIT: 1
});

/** Correlation-id header shared by client and server. */
const REQUEST_ID_HEADER = 'X-Request-Id';

/** Client-safe generic messages. Never include internals here (spec §33, §77). */
const MESSAGES = Object.freeze({
  INTERNAL: 'Something went wrong. Please try again later.',
  NOT_FOUND: 'The requested resource does not exist.',
  MALFORMED_JSON: 'Request body is not valid JSON.',
  PAYLOAD_TOO_LARGE: 'Request payload is too large.',
  RATE_LIMITED: 'Too many requests. Please try again later.',
  INVALID_INPUT: 'Invalid request.'
});

module.exports = {
  API_PREFIX,
  HTTP_STATUS,
  ERROR_CODES,
  PAGINATION,
  REQUEST_ID_HEADER,
  MESSAGES
};
