'use strict';

/**
 * Step 02 — ObjectId guard tests (spec §35).
 *
 * The point of this gate is that object-shaped injection payloads and short
 * strings must never reach a query, so those cases are asserted explicitly.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');

const { isValidObjectId, toObjectId } = require('../src/utils/objectId');

const VALID = '507f1f77bcf86cd799439011';

test('a 24-hex string is valid', () => {
  assert.equal(isValidObjectId(VALID), true);
  assert.equal(isValidObjectId(VALID.toUpperCase()), true);
});

test('an ObjectId instance is valid', () => {
  assert.equal(isValidObjectId(new mongoose.Types.ObjectId()), true);
});

test('object-shaped injection payloads are rejected (spec §35)', () => {
  assert.equal(isValidObjectId({ $ne: null }), false);
  assert.equal(isValidObjectId({ $gt: '' }), false);
  assert.equal(isValidObjectId(['507f1f77bcf86cd799439011']), false);
  assert.equal(isValidObjectId({ toString: () => VALID }), false);
});

test('malformed strings are rejected', () => {
  assert.equal(isValidObjectId(''), false);
  assert.equal(isValidObjectId('123456789012'), false, '12-byte strings are not ids');
  assert.equal(isValidObjectId('not-an-objectid'), false);
  assert.equal(isValidObjectId('507f1f77bcf86cd79943901'), false, '23 chars');
  assert.equal(isValidObjectId('507f1f77bcf86cd7994390111'), false, '25 chars');
  assert.equal(isValidObjectId('507f1f77bcf86cd79943901z'), false, 'non-hex');
  assert.equal(isValidObjectId(` ${VALID}`), false, 'no implicit trimming');
});

test('null, undefined and numbers are rejected', () => {
  assert.equal(isValidObjectId(null), false);
  assert.equal(isValidObjectId(undefined), false);
  assert.equal(isValidObjectId(0), false);
});

test('toObjectId returns an instance for valid input and null otherwise', () => {
  const converted = toObjectId(VALID);
  assert.ok(converted instanceof mongoose.Types.ObjectId);
  assert.equal(String(converted), VALID);
  assert.equal(toObjectId({ $ne: null }), null);
  assert.equal(toObjectId('nope'), null);
});
