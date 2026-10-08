'use strict';

const { HTTP_STATUS, ERROR_CODES } = require('../config/constants');

/**
 * Typed operational errors (spec §77).
 *
 * `isOperational` distinguishes errors the application raised on purpose
 * (bad input, auth failure, conflict) from genuine bugs. Only the latter are
 * treated as 500s and hidden from the client.
 */
class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = options.statusCode || HTTP_STATUS.INTERNAL_SERVER_ERROR;
    this.code = options.code || ERROR_CODES.INTERNAL_ERROR;
    this.isOperational = options.isOperational !== false;
    this.details = options.details ?? null;
    if (options.cause !== undefined) this.cause = options.cause;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

class BadRequestError extends AppError {
  constructor(message = 'Invalid request.', options = {}) {
    super(message, { statusCode: HTTP_STATUS.BAD_REQUEST, code: ERROR_CODES.VALIDATION_ERROR, ...options });
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Authentication is required.', options = {}) {
    super(message, { statusCode: HTTP_STATUS.UNAUTHORIZED, code: ERROR_CODES.AUTHENTICATION_ERROR, ...options });
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action.', options = {}) {
    super(message, { statusCode: HTTP_STATUS.FORBIDDEN, code: ERROR_CODES.AUTHORIZATION_ERROR, ...options });
  }
}

class NotFoundError extends AppError {
  constructor(message = 'The requested resource does not exist.', options = {}) {
    super(message, { statusCode: HTTP_STATUS.NOT_FOUND, code: ERROR_CODES.NOT_FOUND, ...options });
  }
}

class ConflictError extends AppError {
  constructor(message = 'The request conflicts with the current state.', options = {}) {
    super(message, { statusCode: HTTP_STATUS.CONFLICT, code: ERROR_CODES.CONFLICT, ...options });
  }
}

class PayloadTooLargeError extends AppError {
  constructor(message = 'Request payload is too large.', options = {}) {
    super(message, { statusCode: HTTP_STATUS.PAYLOAD_TOO_LARGE, code: ERROR_CODES.PAYLOAD_TOO_LARGE, ...options });
  }
}

class RateLimitError extends AppError {
  constructor(message = 'Too many requests. Please try again later.', options = {}) {
    super(message, { statusCode: HTTP_STATUS.TOO_MANY_REQUESTS, code: ERROR_CODES.RATE_LIMITED, ...options });
  }
}

class InternalError extends AppError {
  constructor(message = 'Something went wrong. Please try again later.', options = {}) {
    super(message, { statusCode: HTTP_STATUS.INTERNAL_SERVER_ERROR, code: ERROR_CODES.INTERNAL_ERROR, isOperational: false, ...options });
  }
}

module.exports = {
  AppError,
  BadRequestError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  PayloadTooLargeError,
  RateLimitError,
  InternalError
};
