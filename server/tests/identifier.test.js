'use strict';

/**
 * Step 03 — identifier normalisation tests (spec §5, §34).
 *
 * Normalisation is what makes duplicate detection reliable, so the exact
 * normalised output is asserted rather than just "it returned something".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normaliseEmail,
  normalisePhone,
  detectType,
  normaliseIdentifier,
  dialCodeFor
} = require('../src/utils/identifier');

test('email is trimmed and lowercased', () => {
  assert.equal(normaliseEmail('  User@Example.COM '), 'user@example.com');
  assert.equal(normaliseEmail('A@B.co'), 'a@b.co');
});

test('malformed emails are rejected as a field error', () => {
  for (const bad of ['', 'no-at-sign', 'a@b', 'a b@c.com', '@example.com', 'a@.com', 'x'.repeat(250) + '@e.com']) {
    assert.throws(() => normaliseEmail(bad), (err) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.details && err.details.identifier, 'expected an identifier field message');
      return true;
    }, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('phone is normalised to E.164', () => {
  assert.equal(normalisePhone('+919999999999', 'IN'), '+919999999999');
  assert.equal(normalisePhone('+91 99999 99999', 'IN'), '+919999999999');
  assert.equal(normalisePhone('(99999)-99999', 'IN'), '+919999999999');
  assert.equal(normalisePhone('0091 9999999999', 'IN'), '+919999999999');
  assert.equal(normalisePhone('9999999999', 'IN'), '+919999999999');
  assert.equal(normalisePhone('4155552671', 'US'), '+14155552671');
});

test('malformed phones are rejected as a field error', () => {
  for (const bad of ['', 'abc', '+', '+0123456789', '+12345678901234567', '12']) {
    assert.throws(() => normalisePhone(bad, 'IN'), (err) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.details && err.details.identifier);
      return true;
    }, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('an unknown default country cannot silently produce a wrong number', () => {
  assert.equal(dialCodeFor('ZZ'), null);
  assert.throws(
    () => normalisePhone('9999999999', 'ZZ'),
    (err) => {
      // The top-level message stays generic; the field detail names the problem.
      assert.equal(err.statusCode, 400);
      assert.match(err.details.identifier, /phone number/i);
      return true;
    }
  );
});

test('detectType identifies the identifier shape', () => {
  assert.equal(detectType('user@example.com'), 'email');
  assert.equal(detectType(' +91 99999 99999 '), 'phone');
  assert.equal(detectType('9999999999'), 'phone');
  assert.equal(detectType('not-an-identifier'), 'unknown');
  assert.equal(detectType(''), 'unknown');
  assert.equal(detectType({ $ne: null }), 'unknown');
  assert.equal(detectType(null), 'unknown');
});

test('normaliseIdentifier honours the declared type', () => {
  assert.deepEqual(normaliseIdentifier({ identifierType: 'email', identifier: ' A@B.com ' }), {
    type: 'email',
    value: 'a@b.com'
  });
  assert.deepEqual(normaliseIdentifier({ identifierType: 'phone', identifier: '9999999999', country: 'IN' }), {
    type: 'phone',
    value: '+919999999999'
  });
});

test('a phone cannot be smuggled through the email path (and vice versa)', () => {
  assert.throws(
    () => normaliseIdentifier({ identifierType: 'email', identifier: '9999999999' }),
    (err) => err.statusCode === 400
  );
  assert.throws(
    () => normaliseIdentifier({ identifierType: 'phone', identifier: 'user@example.com', country: 'IN' }),
    (err) => err.statusCode === 400
  );
});

test('an unknown identifierType is rejected', () => {
  assert.throws(
    () => normaliseIdentifier({ identifierType: 'sms', identifier: 'x' }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.ok(err.details && err.details.identifierType);
      return true;
    }
  );
});
