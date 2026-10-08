'use strict';

/**
 * Step 01 — error mapping tests.
 *
 * The important property is that only an operational AppError can put its own
 * message in front of a client; everything else collapses to a generic message
 * for its status, and stacks never leave a production process.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';

const { resolveErrorResponse } = require('../src/middleware/errorHandler');
const { AppError, BadRequestError, NotFoundError, ConflictError, InternalError } = require('../src/utils/AppError');
const { MESSAGES, HTTP_STATUS } = require('../src/config/constants');

const SENSITIVE = 'mongodb+srv://user:pass@cluster0.example.mongodb.net/db failed';

test('an operational AppError keeps its own message and status', () => {
  const err = new BadRequestError('Email format is invalid.');
  const { status, body } = resolveErrorResponse(err, { isProduction: true });

  assert.equal(status, HTTP_STATUS.BAD_REQUEST);
  assert.equal(body.success, false);
  assert.equal(body.message, 'Email format is invalid.');
  assert.equal(body.stack, undefined);
});

test('operational errors expose their details payload', () => {
  const err = new AppError('Invalid request.', {
    statusCode: 400,
    code: 'VALIDATION_ERROR',
    details: [{ field: 'age.min', message: 'must be a number' }]
  });
  const { body } = resolveErrorResponse(err, { isProduction: true });

  assert.deepEqual(body.details, [{ field: 'age.min', message: 'must be a number' }]);
});

test('a non-operational 500 hides its message in production and returns no stack', () => {
  const err = new Error(SENSITIVE);
  err.name = 'MongoServerSelectionError';

  const { status, body } = resolveErrorResponse(err, { isProduction: true });

  assert.equal(status, HTTP_STATUS.SERVICE_UNAVAILABLE);
  assert.equal(body.message, 'Service temporarily unavailable.');
  assert.equal(body.stack, undefined);
  assert.doesNotMatch(body.message, /mongodb\+srv:\/\//);
});

test('a generic 500 in non-production includes a stack but still hides the message', () => {
  const err = new Error('boom internals at /srv/app/src/index.js');
  const { status, body } = resolveErrorResponse(err, { isProduction: false });

  assert.equal(status, HTTP_STATUS.INTERNAL_SERVER_ERROR);
  assert.equal(body.message, MESSAGES.INTERNAL);
  assert.equal(typeof body.stack, 'string');
  assert.doesNotMatch(body.message, /boom internals/);
});

test('InternalError is never operational, even though it carries a message', () => {
  const { body } = resolveErrorResponse(new InternalError('database exploded'), { isProduction: false });

  assert.equal(body.message, MESSAGES.INTERNAL);
  assert.doesNotMatch(body.message, /database exploded/);
});

test('body-parser too-large maps to 413 with a generic message', () => {
  const err = Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413 });
  const { status, body } = resolveErrorResponse(err, { isProduction: true });

  assert.equal(status, HTTP_STATUS.PAYLOAD_TOO_LARGE);
  assert.equal(body.message, MESSAGES.PAYLOAD_TOO_LARGE);
});

test('body-parser parse failure maps to 400 with a generic message', () => {
  const err = Object.assign(new Error('Unexpected end of JSON input'), { type: 'entity.parse.failed', status: 400 });
  const { status, body } = resolveErrorResponse(err, { isProduction: true });

  assert.equal(status, HTTP_STATUS.BAD_REQUEST);
  assert.equal(body.message, MESSAGES.INVALID_INPUT);
  assert.doesNotMatch(body.message, /Unexpected end/);
});

test('a duplicate-key error maps to 409 without leaking the key or collection', () => {
  const err = Object.assign(new Error('E11000 duplicate key error collection: users index: email_1'), {
    name: 'MongoServerError',
    code: 11000
  });
  const { status, body } = resolveErrorResponse(err, { isProduction: true });

  assert.equal(status, HTTP_STATUS.CONFLICT);
  assert.equal(body.message, 'The request conflicts with the current state.');
  assert.doesNotMatch(body.message, /users|E11000|email_1/);
});

test('validation and cast failures map to 400 with a generic message', () => {
  for (const name of ['ValidationError', 'CastError']) {
    const err = Object.assign(new Error('Path `email` failed'), { name });
    const { status, body } = resolveErrorResponse(err, { isProduction: true });
    assert.equal(status, HTTP_STATUS.BAD_REQUEST, name);
    assert.equal(body.message, MESSAGES.INVALID_INPUT, name);
  }
});

test('unknown statuses fall back to the internal error message', () => {
  const err = new AppError('weird status', { statusCode: 599, isOperational: false });
  const { status, body } = resolveErrorResponse(err, { isProduction: false });

  assert.equal(status, 599);
  assert.equal(body.message, MESSAGES.INTERNAL);
});

test('404 and 409 operational errors keep their messages', () => {
  assert.equal(resolveErrorResponse(new NotFoundError(), { isProduction: true }).body.message, MESSAGES.NOT_FOUND);
  assert.equal(
    resolveErrorResponse(new ConflictError('Already connected.'), { isProduction: true }).body.message,
    'Already connected.'
  );
});
