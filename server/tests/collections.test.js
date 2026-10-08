'use strict';

/**
 * Step 02 — collection registry tests (spec §103, §127; decisions §17-19).
 *
 * The canonical list is a contract other steps depend on, so it is pinned here
 * against the finalized decisions §19 list rather than a copy of itself.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FUTURE_COLLECTIONS,
  ALL_COLLECTIONS,
  FUTURE_COLLECTION_NAMES,
  toCollectionName,
  isKnownCollection
} = require('../src/config/collections');

// Final canonical collection list — finalized decisions §19 (current phase).
const FINAL_CURRENT = [
  'users',
  'sessions',
  'matrimonial_profiles',
  'partner_preferences',
  'photos',
  'verifications',
  'kundli_documents',
  'profile_actions',
  'connections',
  'blocks',
  'reports',
  'master_data_requests',
  'conversations',
  'messages',
  'notifications',
  'subscriptions',
  'audit_logs',
  'community_configs',
  'communities',
  'sub_communities',
  'gotras',
  'surnames',
  'occupations',
  'industries',
  'degrees',
  'specializations',
  'colleges',
  'universities',
  'countries',
  'states',
  'districts',
  'cities',
  'languages',
  'hobbies',
  'interests'
];

test('COLLECTIONS matches the final canonical list exactly', () => {
  assert.deepEqual([...ALL_COLLECTIONS].sort(), [...FINAL_CURRENT].sort());
});

test('every collection name is plural snake_case (spec §103)', () => {
  for (const name of ALL_COLLECTIONS) {
    assert.match(name, /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/, `${name} is not lower snake_case`);
  }
});

test('payment_transactions is future-only and not a current collection', () => {
  assert.deepEqual(FUTURE_COLLECTION_NAMES, ['payment_transactions']);
  assert.equal(FUTURE_COLLECTIONS.PAYMENT_TRANSACTIONS, 'payment_transactions');
  assert.ok(!ALL_COLLECTIONS.includes('payment_transactions'));
  assert.ok(isKnownCollection('payment_transactions'), 'reserved name is still known');
});

test('the naming helper produces plural snake_case', () => {
  const cases = {
    User: 'users',
    MatrimonialProfile: 'matrimonial_profiles',
    PartnerPreference: 'partner_preferences',
    Photo: 'photos',
    KundliDocument: 'kundli_documents',
    ProfileAction: 'profile_actions',
    Connection: 'connections',
    Block: 'blocks',
    Report: 'reports',
    MasterDataRequest: 'master_data_requests',
    Conversation: 'conversations',
    Message: 'messages',
    Notification: 'notifications',
    Subscription: 'subscriptions',
    AuditLog: 'audit_logs',
    CommunityConfig: 'community_configs',
    SubCommunity: 'sub_communities',
    Gotra: 'gotras',
    Surname: 'surnames',
    Occupation: 'occupations',
    Industry: 'industries',
    Degree: 'degrees',
    Specialization: 'specializations',
    College: 'colleges',
    University: 'universities',
    Country: 'countries',
    State: 'states',
    District: 'districts',
    City: 'cities',
    Language: 'languages',
    Hobby: 'hobbies',
    Interest: 'interests'
  };

  for (const [model, expected] of Object.entries(cases)) {
    assert.equal(toCollectionName(model), expected, `${model} -> ${expected}`);
  }
});

test('the naming helper reproduces every registry key from its model name', () => {
  // Registry values must be reachable through the helper, so a future model can
  // never drift from the canonical name.
  for (const name of ALL_COLLECTIONS) {
    const model = name
      .split('_')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('')
      .replace(/ies$/, 'y')
      .replace(/s$/, '');
    assert.equal(toCollectionName(model), name, `${model} should map to ${name}`);
  }
});
