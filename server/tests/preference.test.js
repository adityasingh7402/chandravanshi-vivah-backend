'use strict';

/**
 * Step 07 — Partner Preference tests (spec §16, §35, §44, §47, §54, §57, §72,
 * §80, §81, §97, §105, §112; fields dictionary §15; finalized decisions §4, §5).
 *
 * Runs against the configured cluster in a DEDICATED database, seeded with the
 * real step-05 seeder so every master reference resolves to a genuine record.
 * Each test file is its own process, so the env overrides below cannot leak.
 *
 * Accounts are assigned deliberately: `accountA` (male profile) and `accountB`
 * (no profile at all) are the two long-lived identities, and every test that
 * suspends, blocks or deletes an account creates its own throwaway identity so
 * ordering never matters.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.MONGODB_DB_NAME = 'chandravanshi_vivah_test_preference';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.RATE_LIMIT_MAX = '99999';
process.env.RATE_LIMIT_WINDOW = '3600';
// Step 08: a publishable profile carries a primary photo, which is 10 of the
// §57 completion weight. The asset gateway is a deterministic double so this
// suite needs no Cloudinary account (tests/helpers/fakeCloudinary.js).
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
process.env.CLOUDINARY_API_KEY = 'test-key-1234';
process.env.CLOUDINARY_API_SECRET = 'test-secret-abcdef';
process.env.CLOUDINARY_UPLOAD_FOLDER = 'chandravanshi-vivah-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const app = require('../src/app');
const db = require('../src/config/db');
const config = require('../src/config/env');
const User = require('../src/models/User');
const Session = require('../src/models/Session');
const MatrimonialProfile = require('../src/models/MatrimonialProfile');
const PartnerPreference = require('../src/models/PartnerPreference');
const Photo = require('../src/models/Photo');
const { getMasterModel } = require('../src/models/masterData/MasterItem');
const { MASTER_TYPE_VALUES } = require('../src/constants/masterData');
const { STATUSES } = require('../src/constants/auth');
const {
  PREFERENCE_FIELD_NAMES,
  PREFERENCE_ID_ARRAY_FIELDS,
  PREFERENCE_ENUM_FIELDS,
  PREFERENCE_COMPLETION_FIELDS,
  EFFECTIVE_FILTER_KEYS,
  AGE_BOUNDS,
  HEIGHT_BOUNDS,
  defaultAgeRange
} = require('../src/constants/preference');
const preferenceService = require('../src/services/preferenceService');
const fakeCloudinary = require('./helpers/fakeCloudinary');
const { calculateCompletion } = require('../src/services/profileCompletion');
const seeder = require('../scripts/seed-master-data');

const SERVER_ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';
const CAP = config.preference.maxMultiSelect;

let server;
let base;
let available = false;
let unavailableReason = '';
let accountA;
let accountB;
let accountSeq = 0;
let photoSeq = 0;

/** Real master rows resolved once after seeding. */
const master = {};

function requireDb(t) {
  if (!available) {
    t.skip(`database unavailable (${unavailableReason})`);
    return false;
  }
  return true;
}

async function api(route, { method = 'GET', body, token, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

async function registerAndLogin(identifier) {
  const created = await api('/api/v1/auth/register', {
    method: 'POST',
    body: { identifierType: 'email', identifier, password: PASSWORD }
  });
  assert.equal(created.status, 201, `register: ${JSON.stringify(created.json)}`);
  const loggedIn = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { identifierType: 'email', identifier, password: PASSWORD, deviceType: 'android' }
  });
  assert.equal(loggedIn.status, 200, `login: ${JSON.stringify(loggedIn.json)}`);
  return { id: created.json.data.user.id, token: loggedIn.json.data.accessToken };
}

/** A throwaway account, so one test can never leave state for the next. */
async function freshAccount() {
  accountSeq += 1;
  return registerAndLogin(`p7-${Date.now()}-${accountSeq}@example.com`);
}

function remember(key, doc) {
  master[`${key}Id`] = String(doc._id);
  master[`${key}Name`] = doc.name;
  return doc;
}

async function pick(key, type, slug) {
  const model = getMasterModel(type);
  const preferred = slug ? await model.findOne({ slug }).select('_id name').lean() : null;
  const doc =
    preferred ||
    (await model.findOne({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select('_id name').lean());
  assert.ok(doc, `step-05 seed has no active ${type} row`);
  remember(key, doc);
  return doc;
}

/** The dictionary §25 required set, filled with real seeded master ids. */
function fullProfile(overrides = {}) {
  return {
    basic: {
      profileFor: 'self',
      firstName: 'Rahul',
      gender: 'male',
      dateOfBirth: '1998-05-01',
      maritalStatus: 'never_married',
      heightCm: 175,
      ...(overrides.basic || {})
    },
    community: {
      communityId: master.communityId,
      surnameId: master.surnameId,
      gotraId: master.gotraId,
      ...(overrides.community || {})
    },
    location: { cityId: master.cityId, ...(overrides.location || {}) },
    education: { highestQualificationId: master.degreeId, ...(overrides.education || {}) },
    career: { occupationId: master.occupationId, ...(overrides.career || {}) },
    family: { familyType: 'nuclear', ...(overrides.family || {}) },
    lifestyle: { diet: 'vegetarian', ...(overrides.lifestyle || {}) },
    about: { description: 'Simple family, straightforward person.', ...(overrides.about || {}) }
  };
}

/** Preferences filling every scored dimension — the §57 "complete" case. */
function fullPreferences(overrides = {}) {
  return {
    age: { min: 24, max: 30 },
    heightCm: { min: 160, max: 180 },
    gender: 'female',
    maritalStatus: ['never_married', 'divorced'],
    educationIds: [master.degreeId],
    occupationIds: [master.occupationId],
    incomeRanges: ['5_10_lpa'],
    cityIds: [master.cityId],
    communityIds: [master.communityId],
    diet: ['vegetarian'],
    ...overrides
  };
}

/** A primary photo, registered through the real sign-then-register flow. */
async function addPrimaryPhoto(token) {
  const sign = await api('/api/v1/photos/sign', { method: 'POST', token, body: {} });
  assert.equal(sign.status, 200, `sign: ${JSON.stringify(sign.json)}`);
  photoSeq += 1;
  const res = await api('/api/v1/photos', {
    method: 'POST',
    token,
    body: { publicId: `${sign.json.data.upload.folder}/p7-${photoSeq}`, type: 'profile' }
  });
  assert.equal(res.status, 201, `register photo: ${JSON.stringify(res.json)}`);
  return res.json.data.photo;
}

/** A fresh account with a complete profile and no preferences yet. */
async function accountWithProfile(profileOverrides) {
  const account = await freshAccount();
  const created = await api('/api/v1/profile', {
    method: 'POST',
    token: account.token,
    body: fullProfile(profileOverrides)
  });
  assert.equal(created.status, 201, `create profile: ${JSON.stringify(created.json)}`);
  // A profile nobody can publish is not the state these tests describe: the
  // platform requires a primary photo (spec §15), and it carries its own §57
  // weight, so the score is re-read after the photo lands.
  await addPrimaryPhoto(account.token);
  const me = await api('/api/v1/profile/me', { token: account.token });
  assert.equal(me.status, 200, `read profile: ${JSON.stringify(me.json)}`);
  return { ...account, profile: me.json.data.profile };
}

function ids(count) {
  return Array.from({ length: count }, () => String(new mongoose.Types.ObjectId()));
}

test.before(async () => {
  try {
    await db.connect();
    available = true;
  } catch (err) {
    available = false;
    unavailableReason = (err && err.name) || 'connection failed';
    return;
  }

  // Drop rather than empty: dropping also clears the query-plan cache, so a
  // stale plan cannot mask a missing index.
  const toReset = [
    ...MASTER_TYPE_VALUES.map((type) => getMasterModel(type)),
    PartnerPreference,
    Photo,
    MatrimonialProfile,
    User,
    Session
  ];
  for (const model of toReset) {
    await model.collection.drop().catch(() => {});
    await model.createIndexes();
  }
  await seeder.main();

  // A community that actually hosts a surname and a gotra, so a profile built
  // from those ids is valid, and a SECOND community whose gotra must be refused
  // when the first community is the chosen one (scoped validation).
  const communities = await getMasterModel('communities')
    .find({ isActive: true })
    .sort({ sortOrder: 1, name: 1 })
    .select('_id slug name')
    .lean();
  assert.ok(communities.length > 0, 'step-05 seed has no communities');

  let chosen = null;
  for (const candidate of communities) {
    const surname = await getMasterModel('surnames')
      .findOne({ communityId: candidate._id, isActive: true })
      .select('_id name')
      .lean();
    const gotra = await getMasterModel('gotras')
      .findOne({ communityId: candidate._id, isActive: true })
      .select('_id name')
      .lean();
    if (surname && gotra) {
      chosen = { community: candidate, surname, gotra };
      break;
    }
  }
  assert.ok(chosen, 'step-05 seed has no community with both a surname and a gotra');
  remember('community', chosen.community);
  remember('surname', chosen.surname);
  remember('gotra', chosen.gotra);

  const otherCommunity = communities.find((entry) => String(entry._id) !== String(chosen.community._id));
  const foreignGotra = otherCommunity
    ? await getMasterModel('gotras')
        .findOne({ communityId: otherCommunity._id, isActive: true })
        .select('_id name')
        .lean()
    : null;
  if (foreignGotra) {
    master.foreignCommunityId = String(otherCommunity._id);
    master.foreignGotraId = String(foreignGotra._id);
  }

  await pick('city', 'cities', 'sikar');
  await pick('degree', 'degrees', 'mca');
  await pick('occupation', 'occupations', 'software-engineer');
  await pick('industry', 'industries', 'information-technology');
  await pick('language', 'languages', 'hindi');

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  // Step 08's asset gateway: a deterministic double, so signing and registration
  // run without a Cloudinary account.
  fakeCloudinary.install();

  accountA = await accountWithProfile();
  accountB = await registerAndLogin(`p7b-${Date.now()}@example.com`);
});

test.after(async () => {
  fakeCloudinary.uninstall();
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.disconnect();
});

// ---------------------------------------------------------------------------
// Gate 1 — build integrity
// ---------------------------------------------------------------------------

test('G1.1 every step-07 deliverable exists', () => {
  const files = [
    'src/models/PartnerPreference.js',
    'src/services/preferenceService.js',
    'src/controllers/preference.controller.js',
    'src/routes/preference.routes.js',
    'src/validators/preference.validators.js',
    'src/constants/preference.js',
    'verify-step07.mjs'
  ];
  for (const file of files) assert.ok(fs.existsSync(path.join(SERVER_ROOT, file)), `${file} is missing`);
});

test('G1.1 every preference route is mounted and requires auth (command 7)', async (t) => {
  if (!requireDb(t)) return;
  const anonymous = [
    ['GET', '/api/v1/preferences', undefined],
    ['POST', '/api/v1/preferences', {}],
    ['PATCH', '/api/v1/preferences', {}]
  ];
  for (const [method, route, body] of anonymous) {
    const res = await api(route, { method, body });
    assert.equal(res.status, 401, `${method} ${route} must be 401 without a token, got ${res.status}`);
    assert.equal(res.json.code, 'AUTHENTICATION_REQUIRED');
  }
});

test('G1.2 + G5.1 the schema carries exactly the §16 fields and the unique index', () => {
  const paths = Object.keys(PartnerPreference.schema.paths).filter(
    (entry) => !['_id', 'id', 'createdAt', 'updatedAt', '__v'].includes(entry)
  );

  // Every documented field is present...
  for (const field of PREFERENCE_FIELD_NAMES) {
    assert.ok(
      paths.some((entry) => entry === field || entry.startsWith(`${field}.`)),
      `the schema is missing §16 field "${field}"`
    );
  }
  // ...and nothing else is: an extra path would be a field no gate asked for.
  // `userId` is the ownership key spec §16 lists above the content fields.
  for (const entry of paths) {
    const root = entry.split('.')[0];
    assert.ok(
      PREFERENCE_FIELD_NAMES.includes(root) || root === 'userId',
      `the schema has an undocumented field "${entry}"`
    );
  }

  const indexes = PartnerPreference.schema.indexes();
  const unique = indexes.filter(([, options]) => options.unique).map(([key]) => Object.keys(key).join(','));
  assert.deepEqual(unique, ['userId'], 'one preference document per account (spec §105)');

  assert.equal(PartnerPreference.collection.name, 'partner_preferences');
});

test('G5.2 no `age` number is stored — the range is kept for step 09 (spec §47)', () => {
  // `age` is a sub-document of two bounds, never a scalar.
  assert.equal(PartnerPreference.schema.path('age').instance, 'Embedded');
  assert.equal(PartnerPreference.schema.path('age.min').instance, 'Number');
  assert.equal(PartnerPreference.schema.path('age.max').instance, 'Number');
  for (const banned of ['ageValue', 'dateOfBirth']) {
    assert.equal(PartnerPreference.schema.path(banned), undefined, `${banned} must not exist`);
  }
});

// ---------------------------------------------------------------------------
// Gate 2 — functional
// ---------------------------------------------------------------------------

test('G2.1 a partial (even empty) body creates preferences and reads back (command 1)', async (t) => {
  if (!requireDb(t)) return;
  const acc = await freshAccount();

  const created = await api('/api/v1/preferences', {
    method: 'POST',
    token: acc.token,
    body: { age: { min: 24, max: 30 } }
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const preference = created.json.data.preferences;
  assert.deepEqual(preference.age, { min: 24, max: 30 });
  // Every other dimension is defaulted/empty, not rejected.
  assert.equal(preference.heightCm.min, null);
  assert.equal(preference.heightCm.max, null);
  assert.equal(preference.gender, null, 'no profile gender to derive from, so it stays unset');
  for (const field of PREFERENCE_ID_ARRAY_FIELDS) assert.deepEqual(preference[field], [], `${field} starts empty`);
  assert.deepEqual(preference.maritalStatus, []);
  assert.equal(preference.workingPreference, null);

  const read = await api('/api/v1/preferences', { token: acc.token });
  assert.equal(read.status, 200);
  assert.deepEqual(read.json.data.preferences.age, { min: 24, max: 30 });

  // An empty body is a valid partial save too, and gets the configured default range.
  const blank = await freshAccount();
  const empty = await api('/api/v1/preferences', { method: 'POST', token: blank.token, body: {} });
  assert.equal(empty.status, 201, JSON.stringify(empty.json));
  assert.deepEqual(empty.json.data.preferences.age, defaultAgeRange());
  assert.ok(empty.json.data.preferences.age.min <= empty.json.data.preferences.age.max);
});

test('G2.1 a client with no preferences gets `null`, not a phantom document', async (t) => {
  if (!requireDb(t)) return;
  const read = await api('/api/v1/preferences', { token: accountB.token });
  assert.equal(read.status, 200);
  assert.equal(read.json.data.preferences, null);
  assert.equal(await PartnerPreference.countDocuments({ userId: accountB.id }), 0, 'a read must not create a row');
});

test('G2.2 PATCH merges — unspecified dimensions survive (command 3)', async (t) => {
  if (!requireDb(t)) return;
  const acc = await freshAccount();
  await api('/api/v1/preferences', {
    method: 'POST',
    token: acc.token,
    body: { age: { min: 24, max: 30 }, heightCm: { min: 160, max: 180 } }
  });

  const patched = await api('/api/v1/preferences', {
    method: 'PATCH',
    token: acc.token,
    body: { cityIds: [master.cityId], gender: 'female' }
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  const preference = patched.json.data.preferences;
  assert.deepEqual(preference.age, { min: 24, max: 30 }, 'the stored range survives an unrelated patch');
  assert.deepEqual(preference.heightCm, { min: 160, max: 180 });
  assert.deepEqual(preference.cityIds, [master.cityId]);
  assert.equal(preference.gender, 'female');

  // A single bound merges field-wise, not by replacing the range object.
  const partialRange = await api('/api/v1/preferences', { method: 'PATCH', token: acc.token, body: { age: { max: 34 } } });
  assert.deepEqual(partialRange.json.data.preferences.age, { min: 24, max: 34 });

  // A list is replaced, never appended to.
  const replaced = await api('/api/v1/preferences', {
    method: 'PATCH',
    token: acc.token,
    body: { cityIds: [master.cityId], maritalStatus: ['widowed'] }
  });
  assert.deepEqual(replaced.json.data.preferences.maritalStatus, ['widowed']);
});

test('G2.3 a second document for the same account is refused (command 2)', async (t) => {
  if (!requireDb(t)) return;
  const first = await api('/api/v1/preferences', { method: 'POST', token: accountA.token, body: {} });
  assert.equal(first.status, 201, `first create must succeed: ${JSON.stringify(first.json)}`);

  const dup = await api('/api/v1/preferences', { method: 'POST', token: accountA.token, body: {} });
  assert.equal(dup.status, 409, JSON.stringify(dup.json));
  assert.equal(dup.json.code, 'CONFLICT');

  // The unique index is the real enforcement, not just the service check.
  await assert.rejects(
    () => PartnerPreference.create({ userId: accountA.id, age: { min: 25, max: 30 } }),
    (err) => err && err.code === 11000,
    'a duplicate insert must be refused by the unique index'
  );
  assert.equal(await PartnerPreference.countDocuments({ userId: accountA.id }), 1);
});

test('G2.4 inverted ranges are refused, including after a merge (command 4)', async (t) => {
  if (!requireDb(t)) return;
  const acc = await freshAccount();
  await api('/api/v1/preferences', { method: 'POST', token: acc.token, body: { age: { min: 30, max: 40 } } });

  const stored = await PartnerPreference.findOne({ userId: acc.id }).lean();

  const inverted = await api('/api/v1/preferences', { method: 'PATCH', token: acc.token, body: { age: { min: 40, max: 20 } } });
  assert.equal(inverted.status, 400, JSON.stringify(inverted.json));

  // The interesting case: the patch alone is valid, the MERGED range is not.
  const merged = await api('/api/v1/preferences', { method: 'PATCH', token: acc.token, body: { age: { max: 20 } } });
  assert.equal(merged.status, 400, `merged inversion must be refused: ${JSON.stringify(merged.json)}`);

  const after = await PartnerPreference.findOne({ userId: acc.id }).lean();
  assert.deepEqual({ min: after.age.min, max: after.age.max }, { min: 30, max: 40 }, 'a rejected patch writes nothing');
  assert.equal(after.updatedAt.getTime(), stored.updatedAt.getTime(), 'a rejected patch does not touch the document');

  const height = await api('/api/v1/preferences', { method: 'PATCH', token: acc.token, body: { heightCm: { min: 190, max: 150 } } });
  assert.equal(height.status, 400, 'an inverted height range is refused too');

  const outOfBounds = await api('/api/v1/preferences', {
    method: 'PATCH',
    token: acc.token,
    body: { age: { min: AGE_BOUNDS.min - 1, max: AGE_BOUNDS.max } }
  });
  assert.equal(outOfBounds.status, 400, 'an age outside the platform bounds is refused');
  const tallOut = await api('/api/v1/preferences', {
    method: 'PATCH',
    token: acc.token,
    body: { heightCm: { min: HEIGHT_BOUNDS.min, max: HEIGHT_BOUNDS.max + 1 } }
  });
  assert.equal(tallOut.status, 400, 'a height outside the configured bounds is refused');
});

test('G2.5 unknown enums, invalid ids and over-cap arrays are refused (commands 5, 6)', async (t) => {
  if (!requireDb(t)) return;
  const acc = await freshAccount();
  await api('/api/v1/preferences', { method: 'POST', token: acc.token, body: {} });

  const cases = [
    ['unknown diet value', { diet: ['pizza'] }],
    ['unknown marital status', { maritalStatus: ['single'] }],
    ['case-sensitive enum', { workingPreference: 'Working' }],
    ['invalid ObjectId', { gotraIds: ['000000000000000000000000'] }],
    ['malformed ObjectId', { cityIds: ['not-an-id'] }],
    ['too-short ObjectId', { cityIds: ['abc'] }],
    ['over-cap array', { cityIds: ids(CAP + 1) }],
    ['over-cap enum array', { diet: Array.from({ length: CAP + 1 }, () => 'vegetarian') }]
  ];
  for (const [label, body] of cases) {
    const res = await api('/api/v1/preferences', { method: 'PATCH', token: acc.token, body });
    assert.equal(res.status, 400, `${label} must be 400, got ${res.status} ${JSON.stringify(res.json)}`);
    assert.ok(res.json.details && Object.keys(res.json.details).length > 0, `${label} must name the field`);
  }

  // The cap is inclusive: exactly the cap is accepted (the service deduplicates,
  // so the array length — not the number of distinct ids — is what the cap counts).
  const atCap = await api('/api/v1/preferences', {
    method: 'PATCH',
    token: acc.token,
    body: { cityIds: Array.from({ length: CAP }, () => master.cityId) }
  });
  assert.equal(atCap.status, 200, `exactly ${CAP} ids must be accepted: ${JSON.stringify(atCap.json)}`);
  assert.deepEqual(atCap.json.data.preferences.cityIds, [master.cityId], 'server-side ids are deduplicated');

  // An id from another collection is rejected with a reason, not stored.
  const wrongType = await api('/api/v1/preferences', {
    method: 'PATCH',
    token: acc.token,
    body: { occupationIds: [master.cityId] }
  });
  assert.equal(wrongType.status, 400, 'a city id in occupationIds must be refused');
});

test('G2.5 master ids are validated in their parent scope (community format)', async (t) => {
  if (!requireDb(t)) return;
  if (!master.foreignGotraId) {
    t.skip('the seed has only one community, so cross-community scoping cannot be exercised');
    return;
  }

  const acc = await freshAccount();
  await api('/api/v1/preferences', {
    method: 'POST',
    token: acc.token,
    body: { communityIds: [master.communityId] }
  });

  const foreign = await api('/api/v1/preferences', {
    method: 'PATCH',
    token: acc.token,
    body: { gotraIds: [master.foreignGotraId] }
  });
  assert.equal(foreign.status, 400, 'a gotra from another community must be refused');
  assert.match(JSON.stringify(foreign.json.details), /community/i);

  // The same gotra is fine once its own community is among the chosen ones.
  const accepted = await api('/api/v1/preferences', {
    method: 'PATCH',
    token: acc.token,
    body: { communityIds: [master.communityId, master.foreignCommunityId], gotraIds: [master.foreignGotraId] }
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  assert.deepEqual(accepted.json.data.preferences.gotraIds, [master.foreignGotraId]);
});

test('G2.9 working/horoscope/relocation accept only the finalized enums (decisions §4)', async (t) => {
  if (!requireDb(t)) return;
  const acc = await freshAccount();
  await api('/api/v1/preferences', { method: 'POST', token: acc.token, body: {} });

  const ok = await api('/api/v1/preferences', {
    method: 'PATCH',
    token: acc.token,
    body: { workingPreference: 'not_working', horoscopeRequired: 'not_important', relocationPreference: 'maybe' }
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.data.preferences.workingPreference, 'not_working');
  assert.equal(ok.json.data.preferences.horoscopeRequired, 'not_important');
  assert.equal(ok.json.data.preferences.relocationPreference, 'maybe');

  for (const value of ['required', 'preferred', 'not_important']) {
    const res = await api('/api/v1/preferences', { method: 'PATCH', token: acc.token, body: { horoscopeRequired: value } });
    assert.equal(res.status, 200, `horoscopeRequired "${value}" must be accepted`);
  }
  for (const value of ['working', 'not_working', 'either']) {
    const res = await api('/api/v1/preferences', { method: 'PATCH', token: acc.token, body: { workingPreference: value } });
    assert.equal(res.status, 200, `workingPreference "${value}" must be accepted`);
  }
  for (const value of ['yes', 'no', 'maybe']) {
    const res = await api('/api/v1/preferences', { method: 'PATCH', token: acc.token, body: { relocationPreference: value } });
    assert.equal(res.status, 200, `relocationPreference "${value}" must be accepted`);
  }

  // A boolean is NOT a horoscope value: spec §16 sketched `Boolean | null`, and
  // the finalized decision replaces that with a 3-value enum (gate G2.9).
  for (const value of [true, false]) {
    const res = await api('/api/v1/preferences', { method: 'PATCH', token: acc.token, body: { horoscopeRequired: value } });
    assert.equal(res.status, 400, `horoscopeRequired=${value} must be a 400, not silently coerced`);
  }

  const unknownWorking = await api('/api/v1/preferences', { method: 'PATCH', token: acc.token, body: { workingPreference: 'retired' } });
  assert.equal(unknownWorking.status, 400);
});

test('G2.6 + G4.3 effectiveFilters omits absent dimensions and derives gender (decisions §5)', async (t) => {
  if (!requireDb(t)) return;

  // A female profile with no preferences: the derived default is the opposite.
  const acc = await accountWithProfile({ basic: { gender: 'female', firstName: 'Sunita' } });
  assert.deepEqual(await preferenceService.effectiveFilters(acc.id), {}, 'no preferences means no filters at all');

  await api('/api/v1/preferences', {
    method: 'POST',
    token: acc.token,
    body: { cityIds: [master.cityId], maritalStatus: ['never_married'] }
  });

  const filters = await preferenceService.effectiveFilters(acc.id);
  assert.equal(filters.gender, 'male', 'gender defaults to the opposite of the profile gender');
  assert.deepEqual(filters.cityIds, [master.cityId]);
  assert.deepEqual(filters.maritalStatus, ['never_married']);
  // Absent dimensions are omitted entirely — never "match nothing" (spec §16).
  for (const key of ['educationIds', 'occupationIds', 'incomeRanges', 'communityIds', 'diet', 'workingPreference']) {
    assert.equal(key in filters, false, `${key} must be omitted when unset, not present as empty`);
  }
  assert.ok('age' in filters, 'the defaulted age range is always a real filter');

  // It is a plain value object: no query operators, no nested documents, and
  // only allowlisted keys (gate G4.3).
  const json = JSON.stringify(filters);
  assert.ok(!json.includes('"$'), `no Mongo operator may appear: ${json}`);
  for (const key of Object.keys(filters)) assert.ok(EFFECTIVE_FILTER_KEYS.includes(key), `${key} is not allowlisted`);
  assert.deepEqual(JSON.parse(json), filters, 'the filter must survive a JSON round-trip unchanged');

  // An explicit value overrides the derived default — it is a default, not a lock.
  const explicit = await api('/api/v1/preferences', { method: 'PATCH', token: acc.token, body: { gender: 'female' } });
  assert.equal(explicit.status, 200, JSON.stringify(explicit.json));
  assert.equal((await preferenceService.effectiveFilters(acc.id)).gender, 'female');
});

test('G2.7 saving preferences re-scores the profile (command 8)', async (t) => {
  if (!requireDb(t)) return;
  const acc = await accountWithProfile();
  // §57's table now scores every implemented section: 75 profile sections +
  // 15 partner preferences (step 07) + 10 photo (step 08) = 100.
  const photoWeight = 10;
  const preferenceWeight = 15;
  const enabledWeight = photoWeight + preferenceWeight + 75;
  const withoutPreferences = Math.round(((enabledWeight - preferenceWeight) / enabledWeight) * 100);
  assert.equal(acc.profile.completionPercentage, withoutPreferences, 'a full profile with a photo but no preferences scores 85');

  const created = await api('/api/v1/preferences', {
    method: 'POST',
    token: acc.token,
    body: fullPreferences()
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  const own = await api('/api/v1/profile/me', { token: acc.token });
  assert.equal(own.json.data.profile.completionPercentage, 100, 'a complete preference set completes the profile');
  assert.equal(
    (await MatrimonialProfile.findOne({ userId: acc.id }).lean()).profile.completionPercentage,
    100,
    'the stored score is updated, not just the response'
  );

  // A partial preference set moves the score proportionally, never to zero.
  const partial = await freshAccount();
  await api('/api/v1/profile', { method: 'POST', token: partial.token, body: fullProfile() });
  const before = (await api('/api/v1/profile/me', { token: partial.token })).json.data.profile.completionPercentage;
  await api('/api/v1/preferences', { method: 'POST', token: partial.token, body: { age: { min: 25, max: 32 } } });
  const after = (await api('/api/v1/profile/me', { token: partial.token })).json.data.profile.completionPercentage;
  assert.ok(after > before, `saving some preferences must raise the score (${before} -> ${after})`);
  assert.ok(after < 100, 'a two-field preference set is not complete');

  // The scorer itself, in one place: every scored dimension filled == full weight.
  // PREFERENCE_COMPLETION_FIELDS holds dotted paths, so they are built nested here
  // exactly as they are stored.
  const filled = {};
  for (const field of PREFERENCE_COMPLETION_FIELDS) {
    const [head, tail] = field.includes('.') ? field.split('.') : [field, null];
    if (tail === null) filled[head] = 'x';
    else { filled[head] = filled[head] || {}; filled[head][tail] = 25; }
  }
  assert.equal(
    calculateCompletion(fullProfile(), { partnerPreferences: filled, hasPrimaryPhoto: true }),
    100,
    'every enabled section filled scores 100'
  );
  assert.equal(
    calculateCompletion(fullProfile(), {}),
    withoutPreferences - photoWeight,
    'with no signals the profile sections score alone'
  );
});

test('G2.8 the API never stores or returns a computed age', async (t) => {
  if (!requireDb(t)) return;
  const acc = await freshAccount();
  const created = await api('/api/v1/preferences', {
    method: 'POST',
    token: acc.token,
    body: { age: { min: 26, max: 31 } }
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.json.data.preferences.age, { min: 26, max: 31 });

  const raw = await mongoose.connection.db.collection('partner_preferences').findOne({ userId: new mongoose.Types.ObjectId(acc.id) });
  assert.equal(typeof raw.age, 'object', 'age is a range object');
  assert.equal(Number.isInteger(raw.age), false);
  assert.equal(raw.ageValue, undefined);
  assert.equal(raw.dateOfBirthRange, undefined);
});

test('G2.5 a client can clear a dimension explicitly', async (t) => {
  if (!requireDb(t)) return;
  const acc = await freshAccount();
  await api('/api/v1/preferences', {
    method: 'POST',
    token: acc.token,
    body: { gender: 'female', maritalStatus: ['widowed'], heightCm: { min: 150, max: 170 } }
  });

  const cleared = await api('/api/v1/preferences', {
    method: 'PATCH',
    token: acc.token,
    body: { gender: null, maritalStatus: [], heightCm: null }
  });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  assert.equal(cleared.json.data.preferences.gender, null);
  assert.deepEqual(cleared.json.data.preferences.maritalStatus, []);
  assert.deepEqual(cleared.json.data.preferences.heightCm, { min: null, max: null });
});

test('G2.x saving preferences never rewrites the profile (spec §57, task 7)', async (t) => {
  if (!requireDb(t)) return;
  const acc = await accountWithProfile();
  const before = await MatrimonialProfile.findOne({ userId: acc.id }).lean();

  await api('/api/v1/preferences', { method: 'POST', token: acc.token, body: fullPreferences() });

  const after = await MatrimonialProfile.findOne({ userId: acc.id }).lean();
  const withoutScore = (doc) => {
    const copy = JSON.parse(JSON.stringify(doc));
    delete copy.profile.completionPercentage;
    delete copy.updatedAt;
    return copy;
  };
  assert.deepEqual(withoutScore(after), withoutScore(before), 'only the completion score may change');
});

// ---------------------------------------------------------------------------
// Gate 3 — security
// ---------------------------------------------------------------------------

test('G3.1 a userId in the body does not address another account (spec §44)', async (t) => {
  if (!requireDb(t)) return;
  const before = JSON.stringify(await PartnerPreference.findOne({ userId: accountA.id }).lean());

  const res = await api('/api/v1/preferences', { method: 'POST', token: accountB.token, body: { userId: accountA.id } });
  assert.equal(res.status, 400, 'a userId field is rejected, never honoured');

  const after = JSON.stringify(await PartnerPreference.findOne({ userId: accountA.id }).lean());
  assert.equal(after, before, "account A's document is byte-for-byte untouched");
  assert.equal(await PartnerPreference.countDocuments({ userId: accountA.id }), 1, 'still exactly one document per account');

  const own = await api('/api/v1/preferences', { token: accountA.token });
  assert.ok(own.json.data.preferences, 'account A still reads its own document');
});

test('G3.2 no route exposes the preferences of another account', async (t) => {
  if (!requireDb(t)) return;
  const attempts = [
    ['GET', `/api/v1/preferences/${accountA.id}`],
    ['GET', `/api/v1/preferences/user/${accountA.id}`],
    ['GET', `/api/v1/preferences/${accountA.id}/preferences`]
  ];
  for (const [method, route] of attempts) {
    const res = await api(route, { method, token: accountB.token });
    assert.equal(res.status, 404, `${method} ${route} must not resolve: ${JSON.stringify(res.json)}`);
  }

  // A query string cannot select another account either: B still gets B's own
  // (empty) document. The route reads `req.auth.userId` and nothing else.
  const queried = await api(`/api/v1/preferences?userId=${accountA.id}`, { token: accountB.token });
  assert.equal(queried.status, 200);
  assert.equal(queried.json.data.preferences, null, 'the query string selected nothing');

  // Account B's own read is empty, and contains nothing from account A.
  const own = await api('/api/v1/preferences', { token: accountB.token });
  assert.equal(own.json.data.preferences, null);
  assert.ok(!JSON.stringify(own.json).includes(accountA.id));
});

test('G3.3 unknown and extra keys are rejected (spec §34, §35)', async (t) => {
  if (!requireDb(t)) return;
  const acc = await freshAccount();
  await api('/api/v1/preferences', { method: 'POST', token: acc.token, body: {} });

  for (const body of [
    { isActive: true },
    { role: 'admin' },
    { createdAt: '2020-01-01' },
    { age: { min: 25, max: 30, extra: 1 } },
    { clanIds: [master.cityId] }
  ]) {
    const res = await api('/api/v1/preferences', { method: 'PATCH', token: acc.token, body });
    assert.equal(res.status, 400, `${JSON.stringify(body)} must be refused`);
  }
});

test('G3.4 malformed and object-shaped values never reach a query (spec §35)', async (t) => {
  if (!requireDb(t)) return;
  const acc = await freshAccount();
  await api('/api/v1/preferences', { method: 'POST', token: acc.token, body: { cityIds: [master.cityId] } });

  for (const body of [
    { cityIds: [{ $ne: null }] },
    { cityIds: { $in: [master.cityId] } },
    { age: { $gt: 20 } },
    { gender: { $ne: 'male' } },
    { maritalStatus: 'never_married' }
  ]) {
    const res = await api('/api/v1/preferences', { method: 'PATCH', token: acc.token, body });
    assert.equal(res.status, 400, `${JSON.stringify(body)} must be refused, got ${res.status}`);
  }

  const after = await PartnerPreference.findOne({ userId: acc.id }).lean();
  assert.deepEqual(after.cityIds.map(String), [master.cityId], 'nothing was written');
});

test('G3.5 a suspended or blocked account can neither read nor write (spec §44)', async (t) => {
  if (!requireDb(t)) return;
  const acc = await freshAccount();
  await api('/api/v1/preferences', { method: 'POST', token: acc.token, body: { age: { min: 25, max: 30 } } });

  for (const status of [STATUSES.SUSPENDED, STATUSES.BLOCKED, STATUSES.DELETED]) {
    await User.updateOne({ _id: acc.id }, { $set: { status } });
    const read = await api('/api/v1/preferences', { token: acc.token });
    const write = await api('/api/v1/preferences', { method: 'PATCH', token: acc.token, body: { gender: 'female' } });
    const create = await api('/api/v1/preferences', { method: 'POST', token: acc.token, body: {} });
    assert.equal(read.status, 403, `${status}: read must be refused`);
    assert.equal(write.status, 403, `${status}: write must be refused`);
    assert.equal(create.status, 403, `${status}: create must be refused`);
  }

  await User.updateOne({ _id: acc.id }, { $set: { status: STATUSES.ACTIVE } });
  assert.equal((await api('/api/v1/preferences', { token: acc.token })).status, 200, 'restoring the account restores access');
});

test('G3.6 the response carries no user, session or internal field', async (t) => {
  if (!requireDb(t)) return;
  const raw = JSON.stringify((await api('/api/v1/preferences', { token: accountA.token })).json);
  for (const leak of ['userId', 'passwordHash', '__v', 'submittedBy', 'verifiedBy']) {
    assert.ok(!raw.includes(leak), `${leak} must never be in a preference response`);
  }
});

// ---------------------------------------------------------------------------
// Gate 4 — performance & data
// ---------------------------------------------------------------------------

test('G4.1 the userId lookup uses the unique index (spec §105)', async (t) => {
  if (!requireDb(t)) return;
  await PartnerPreference.find({ userId: accountA.id }).limit(1); // warm the plan cache
  const plan = JSON.stringify(await PartnerPreference.find({ userId: accountA.id }).explain('executionStats'));
  assert.ok(plan.includes('IXSCAN'), `the userId lookup must be index-backed: ${plan.slice(0, 300)}`);
  assert.ok(plan.includes('userId_1'), 'the userId index must be the one used');
  assert.ok(!plan.includes('"COLLSCAN"'), 'no collection scan may be planned');
});

test('G4.2 the document stays small and every array is bounded (spec §80)', async (t) => {
  if (!requireDb(t)) return;
  const acc = await freshAccount();
  await api('/api/v1/preferences', {
    method: 'POST',
    token: acc.token,
    body: {
      ...fullPreferences(),
      maritalStatus: ['never_married', 'divorced', 'widowed', 'separated'],
      diet: ['vegetarian', 'eggetarian', 'non_vegetarian', 'vegan', 'jain', 'other']
    }
  });

  const raw = await PartnerPreference.findOne({ userId: acc.id }).lean();
  const size = Buffer.byteLength(JSON.stringify(raw));
  assert.ok(size < 4096, `a preference document must stay small, was ${size} bytes`);

  for (const field of [...PREFERENCE_ID_ARRAY_FIELDS, ...Object.entries(PREFERENCE_ENUM_FIELDS).filter(([, d]) => d.multiSelect).map(([f]) => f)]) {
    assert.ok(raw[field].length <= CAP, `${field} exceeds the configured cap`);
  }
});

test('G4.3 effectiveFilters is built from an allowlist, never a spread', async (t) => {
  if (!requireDb(t)) return;
  const source = fs.readFileSync(path.join(SERVER_ROOT, 'src', 'services', 'preferenceService.js'), 'utf8');
  assert.ok(!/\{\s*\.\.\.preference\s*\}/.test(source), 'the document must never be spread into the filter object');
  assert.ok(!/\$where|\$function/.test(source), 'no server-side script may appear in a filter');
  assert.deepEqual([...EFFECTIVE_FILTER_KEYS], [...PREFERENCE_FIELD_NAMES], 'the filter allowlist is the document field set');
});
