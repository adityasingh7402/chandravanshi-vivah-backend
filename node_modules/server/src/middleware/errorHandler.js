'use strict';

const config = require('../config/env');
const { AppError } = require('../utils/AppError');
const { HTTP_STATUS, ERROR_CODES, MESSAGES } = require('../config/constants');
const { fail } = require('../utils/apiResponse');
const { logger, sanitize, routeOf } = require('./requestLogger');

/**
 * Centralised error mapping (spec §33, §77, §78).
 *
 * Two hard rules:
 *   1. Only an operational AppError may contribute its own message to a client.
 *      Every other error — framework, driver, bug — gets a generic message for
 *      its status. That is what keeps Mongo messages, collection names, file
 *      paths and connection strings out of responses.
 *   2. Stacks are returned only for non-operational 5xx in non-production, so a
 *      client can never see internals in production.
 */

const GENERIC_BY_STATUS = Object.freeze({
  400: MESSAGES.INVALID_INPUT,
  401: 'Authentication is required.',
  403: 'You do not have permission to perform this action.',
  404: MESSAGES.NOT_FOUND,
  409: 'The request conflicts with the current state.',
  413: MESSAGES.PAYLOAD_TOO_LARGE,
  415: 'Unsupported content type.',
  422: MESSAGES.INVALID_INPUT,
  429: MESSAGES.RATE_LIMITED,
  500: MESSAGES.INTERNAL,
  503: 'Service temporarily unavailable.'
});

const CODE_BY_STATUS = Object.freeze({
  400: ERROR_CODES.VALIDATION_ERROR,
  401: ERROR_CODES.AUTHENTICATION_ERROR,
  403: ERROR_CODES.AUTHORIZATION_ERROR,
  404: ERROR_CODES.NOT_FOUND,
  409: ERROR_CODES.CONFLICT,
  413: ERROR_CODES.PAYLOAD_TOO_LARGE,
  429: ERROR_CODES.RATE_LIMITED,
  500: ERROR_CODES.INTERNAL_ERROR
});

// body-parser / express error types (client-side input problems)
const BODY_PARSER_STATUS = Object.freeze({
  'entity.too.large': HTTP_STATUS.PAYLOAD_TOO_LARGE,
  'entity.parse.failed': HTTP_STATUS.BAD_REQUEST,
  'entity.verify.failed': HTTP_STATUS.BAD_REQUEST,
  'request.aborted': HTTP_STATUS.BAD_REQUEST,
  'encoding.unsupported': HTTP_STATUS.UNPROCESSABLE_ENTITY,
  'charset.unsupported': HTTP_STATUS.UNPROCESSABLE_ENTITY,
  'request.size.invalid': HTTP_STATUS.BAD_REQUEST,
  'parameters.too.many': HTTP_STATUS.BAD_REQUEST
});

function inRange(value) {
  return Number.isInteger(value) && value >= 400 && value <= 599;
}

function resolveStatus(err) {
  if (!err) return HTTP_STATUS.INTERNAL_SERVER_ERROR;

  if (err.type && BODY_PARSER_STATUS[err.type]) return BODY_PARSER_STATUS[err.type];

  if (inRange(err.statusCode)) return err.statusCode;
  if (inRange(err.status)) return err.status;

  // Data-layer failures raised once step 03/06 exist. Status is mapped, the
  // message never is.
  if (err.name === 'ValidationError' || err.name === 'CastError') return HTTP_STATUS.BAD_REQUEST;
  if (err.name === 'VersionError') return HTTP_STATUS.CONFLICT;
  if (err.name === 'MongoServerError' && (err.code === 11000 || err.code === 11001)) return HTTP_STATUS.CONFLICT;
  if (err.name === 'MongoNetworkError' || err.name === 'MongoServerSelectionError') {
    return HTTP_STATUS.SERVICE_UNAVAILABLE;
  }

  return HTTP_STATUS.INTERNAL_SERVER_ERROR;
}

/**
 * Pure mapping function so it can be unit tested for both production and
 * non-production without restarting the process.
 */
function resolveErrorResponse(err, { isProduction = false } = {}) {
  const status = resolveStatus(err);
  const operational = err instanceof AppError && err.isOperational === true;

  const message = operational ? err.message : (GENERIC_BY_STATUS[status] || MESSAGES.INTERNAL);
  const code = operational ? err.code : (CODE_BY_STATUS[status] || ERROR_CODES.INTERNAL_ERROR);
  const details = operational && err.details ? err.details : undefined;

  const body = { success: false, message };
  if (details !== undefined) body.details = details;

  // Non-production diagnostics for genuine failures only; never for a 4xx the
  // client caused, and never in production.
  if (!isProduction && status >= HTTP_STATUS.INTERNAL_SERVER_ERROR && err && err.stack) {
    body.stack = sanitize(err.stack);
  }

  return { status, code, body };
}

function logLevelFor(status) {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const { status, code, body } = resolveErrorResponse(err, { isProduction: config.isProduction });

  const payload = {
    reqId: req && req.id,
    route: req ? routeOf(req) : undefined,
    status,
    code,
    errName: err && err.name,
    // Server-side only. Sanitised so a driver message can never carry a
    // connection string or credential into the log (spec §78).
    errMessage: err ? sanitize(err.message) : undefined
  };

  logger[logLevelFor(status)](payload, body.message);

  // `code` is the machine-readable category from spec §77, so a client can
  // distinguish e.g. an expired token from an invalid one without matching on
  // the human-readable message.
  // `code` is a sibling of `body` in the resolveErrorResponse result — it must
  // be passed explicitly so the failure envelope carries the machine-readable
  // category (spec §77).
  return fail(res, status, body.message, body.details, { stack: body.stack, code });
}

module.exports = { errorHandler, resolveErrorResponse, resolveStatus };
