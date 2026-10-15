'use strict';

/**
 * Step 06 — Matrimonial Profile tests (spec §8, §30, §44, §47, §51, §57, §58,
 * §59, §70-§72, §81, §97, §105, §113, §118; fields dictionary §3, §8, §9, §12,
 * §25, §26).
 *
 * Runs against the configured cluster in a DEDICATED database, seeded with the
 * real step-05 seeder so every master reference resolves to a genuine record.
 * Each test file is its own process, so the env overrides below cannot leak.
 *
 * Accounts are assigned deliberately: `accountA` and `accountB` are the two
 * long-lived identities, and every test that deletes, suspends or republishes
 * creates its own throwaway account so ordering never matters.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.MONGODB_DB_NAME = 'chandravanshi_vivah_test_profile';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.RATE_LIMIT_MAX = '99999';
process.env.RATE_LIMIT_WINDOW = '3600';
// Step 08: the platform requires a primary photo to publish (spec §15), and a
// photo also carries 10 of the §57 completion weight. The asset gateway is the
// deterministic double, so a photo can be registered without a Cloudinary
// account (see tests/helpers/fakeCloudinary.js).
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
process.env.CLOUDINARY_API_KEY = 'test-key-1234';
process.env.CLOUDINARY_API_SECRET = 'test-secret-abcdef';
process.env.CLOUDINARY_UPLOAD_FOLDER = 'chandravanshi-vivah-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = require('../src/app');
const db = require('../src/config/db');
const User = require('../src/models/User');
const Session = require('../src/models/Session');
const MatrimonialProfile = require('../src/models/MatrimonialProfile');
const { getMasterModel } = require('../src/models/masterData/MasterItem');
const { MASTER_TYPE_VALUES } = require('../src/constants/masterData');
const { COMPLETION_WEIGHTS, REQUIRED_V1_FIELDS, PROFILE_STATUS, PROFILE_SECTIONS } = require('../src/constants/profile');
const { PREFERENCE_COMPLETION_FIELDS } = require('../src/constants/preference');
const { calculateCompletion, requiredFieldsState } = require('../src/services/profileCompletion');
const { computeAge, heightDisplay, discoveryCard } = require('../src/services/profileSerializer');
const { PUBLIC_PROJECTION } = require('../src/services/profileService');
const { generatePublicProfileId, isPublicProfileId } = require('../src/utils/publicProfileId');
const Photo = require('../src/models/Photo');
const fakeCloudinary = require('./helpers/fakeCloudinary');
const seeder = require('../scripts/seed-master-data');

const SERVER_ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';

let server;
let base;
let available = false;
let unavailableReason = '';
let accountA;
let accountB;
let accountSeq = 0;
let photoSeq = 0;

/**
 * Real master rows resolved once after seeding: `master.communityId`,
 * `master.surnameName`, and so on. Every assertion compares against what the
 * seeder actually wrote rather than a literal, so a data change cannot turn a
 * correct server into a "failing" test.
 */
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
  return { status: res.status, json, headers: res.headers };
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
  return registerAndLogin(`p6-${Date.now()}-${accountSeq}@example.com`);
}

/** Remember an id and the display name the server should copy beside it. */
function remember(key, doc) {
  master[`${key}Id`] = String(doc._id);
  master[`${key}Name`] = doc.name;
  return doc;
}

/** Preferred slug first, then any active row. Throws when the seed is unusable. */
async function pick(key, type, slug) {
  const model = getMasterModel(type);
  const preferred = slug ? await model.findOne({ slug }).select('_id name').lean() : null;
  const doc =
    preferred ||
    (await model
      .findOne({ isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .select('_id name')
      .lean());
  if (!doc) throw new Error(`step-05 seed has no active ${type} row`);
  remember(key, doc);
  return doc;
}

/**
 * The dictionary §25 required set, filled with real seeded master ids, so a
 * profile built from this CAN reach `active`.
 */
function fullProfile(overrides = {}) {
  const personal = { ...(overrides.personal || {}) };
  if (master.hobbyId && !personal.hobbies) personal.hobbies = [master.hobbyId];
  if (master.interestId && !personal.interests) personal.interests = [master.interestId];
  if (master.languageId && !personal.languages) personal.languages = [master.languageId];

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
    personal,
    about: { description: 'Simple family, straightforward person.', ...(overrides.about || {}) },
    ...(overrides.horoscope ? { horoscope: overrides.horoscope } : {}),
    ...(overrides.marriage ? { marriage: overrides.marriage } : {}),
    ...(overrides.extra || {})
  };
}

/**
 * The §57 score of a profile that fills every profile section but has no
 * preferences yet — computed from the weights rather than written as a literal,
 * so a weight change cannot silently turn a correct server into a failing test.
 */
function completionWithoutPreferences() {
  const enabled = COMPLETION_WEIGHTS.filter((entry) => entry.enabled);
  const total = enabled.reduce((sum, entry) => sum + entry.weight, 0);
  const preferences = enabled.find((entry) => entry.key === 'partnerPreferences');
  return Math.round(((total - (preferences ? preferences.weight : 0)) / total) * 100);
}

/**
 * A preference document that fills every §57-scored preference dimension. Plain
 * values are enough: the scorer only asks whether a field is filled.
 */
function completePreferences() {
  return {
    age: { min: 24, max: 30 },
    gender: 'female',
    maritalStatus: ['never_married'],
    educationIds: ['x'],
    occupationIds: ['x'],
    incomeRanges: ['5_10_lpa'],
    cityIds: ['x'],
    communityIds: ['x'],
    diet: ['vegetarian']
  };
}

/** POST fullProfile() and return the parsed own-DTO. */
/**
 * Register a primary profile photo through the documented sign-then-register
 * flow (step 08). A publishable profile now needs one: the platform setting
 * `community_configs.settings.requireProfilePhoto` is on by default (spec §15),
 * and the photo is 10 of the §57 completion weight.
 */
async function addPrimaryPhoto(token) {
  const sign = await api('/api/v1/photos/sign', { method: 'POST', token, body: {} });
  assert.equal(sign.status, 200, `sign: ${JSON.stringify(sign.json)}`);
  photoSeq += 1;
  const res = await api('/api/v1/photos', {
    method: 'POST',
    token,
    body: { publicId: `${sign.json.data.upload.folder}/p6-${photoSeq}`, type: 'profile' }
  });
  assert.equal(res.status, 201, `register photo: ${JSON.stringify(res.json)}`);
  return res.json.data.photo;
}

/**
 * A complete profile — every §25 field plus the primary photo publishing needs.
 * Without the photo the profile is complete but not publishable, which is a
 * different state and is asserted separately in G2.4.
 */
async function createFullProfile(token, overrides) {
  const res = await api('/api/v1/profile', { method: 'POST', token, body: fullProfile(overrides) });
  assert.equal(res.status, 201, `create profile: ${JSON.stringify(res.json)}`);
  await addPrimaryPhoto(token);
  // Re-read: the photo was added after the profile was created, so the create
  // response still carries the pre-photo score.
  const me = await api('/api/v1/profile/me', { token });
  assert.equal(me.status, 200, `read profile: ${JSON.stringify(me.json)}`);
  return me.json.data.profile;
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
  // stale plan cannot mask a missing index. autoIndex is off outside dev.
  const toReset = [
    ...MASTER_TYPE_VALUES.map((type) => getMasterModel(type)),
    MatrimonialProfile,
    Photo,
    User,
    Session
  ];
  for (const model of toReset) {
    await model.collection.drop().catch(() => {});
    await model.createIndexes();
  }
  await seeder.main();

  // A community that actually hosts a surname and a gotra — §25 requires both,
  // so the test profile must reference rows that exist inside one community.
  const Community = getMasterModel('communities');
  const communities = await Community.find({ isActive: true })
    .sort({ sortOrder: 1, name: 1 })
    .select('_id slug name')
    .lean();
  assert.ok(communities.length > 0, 'step-05 seed has no communities');
  const preferred = communities.find((entry) => entry.slug === 'kahar-chandravanshi-kshatriya');
  const ordered = preferred ? [preferred, ...communities.filter((entry) => entry !== preferred)] : communities;

  let chosen = null;
  let surnameDoc = null;
  let gotraDoc = null;
  for (const candidate of ordered) {
    const surname = await getMasterModel('surnames')
      .findOne({ communityId: candidate._id, isActive: true })
      .select('_id name')
      .lean();
    const gotra = await getMasterModel('gotras')
      .findOne({ communityId: candidate._id, isActive: true })
      .select('_id name')
      .lean();
    if (surname && gotra) {
      chosen = candidate;
      surnameDoc = surname;
      gotraDoc = gotra;
      break;
    }
  }
  assert.ok(chosen, 'step-05 seed has no community with both a surname and a gotra');
  remember('community', chosen);
  remember('surname', surnameDoc);
  remember('gotra', gotraDoc);

  // Unscoped references: any active row works (the service validates them
  // against their own collection only).
  await pick('city', 'cities', 'sikar');
  await pick('district', 'districts', 'sikar');
  await pick('state', 'states', 'rajasthan');
  await pick('degree', 'degrees', 'mca');
  await pick('occupation', 'occupations', 'software-engineer');
  await pick('industry', 'industries', 'information-technology');
  await pick('university', 'universities', 'other');
  await pick('language', 'languages', 'hindi');
  await pick('hobby', 'hobbies', 'reading');
  await pick('interest', 'interests');

  // Scoped references: must live inside the chosen community / degree.
  const clanDoc = await getMasterModel('clans')
    .findOne({ communityId: master.communityId, isActive: true })
    .select('_id name')
    .lean();
  if (clanDoc) remember('clan', clanDoc);

  const specializationDoc = await getMasterModel('specializations')
    .findOne({ degreeId: master.degreeId, isActive: true })
    .select('_id name')
    .lean();
  if (specializationDoc) remember('specialization', specializationDoc);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  // Step 08: the asset gateway is the only provider boundary; install the
  // deterministic double so photo signing/registration runs without an account.
  fakeCloudinary.install();

  accountA = await registerAndLogin(`p6a-${Date.now()}@example.com`);
  accountB = await registerAndLogin(`p6b-${Date.now()}@example.com`);
});

test.after(async () => {
  fakeCloudinary.uninstall();
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.disconnect();
});

// ---------------------------------------------------------------------------
// Gate 1 — build integrity
// ---------------------------------------------------------------------------

test('G1.1 every step-06 deliverable exists', () => {
  const files = [
    'src/models/MatrimonialProfile.js',
    'src/services/profileService.js',
    'src/services/profileCompletion.js',
    'src/services/profileSerializer.js',
    'src/utils/publicProfileId.js',
    'src/controllers/profile.controller.js',
    'src/routes/profile.routes.js',
    'src/validators/profile.validators.js',
    'src/constants/profile.js',
    'verify-step06.mjs'
  ];
  for (const file of files) assert.ok(fs.existsSync(path.join(SERVER_ROOT, file)), `${file} is missing`);
});

test('G1.1 every profile route is mounted and requires auth (command 7)', async (t) => {
  if (!requireDb(t)) return;
  const anonymous = [
    ['GET', '/api/v1/profile/me', undefined],
    ['POST', '/api/v1/profile', {}],
    ['PATCH', '/api/v1/profile', {}],
    ['DELETE', '/api/v1/profile', undefined],
    ['GET', '/api/v1/profile/CHV-82A91', undefined]
  ];
  for (const [method, route, body] of anonymous) {
    const res = await api(route, { method, body });
    assert.equal(res.status, 401, `${method} ${route} must be 401 without a token, got ${res.status}`);
    assert.equal(res.json.code, 'AUTHENTICATION_REQUIRED');
  }
});

test('G1.2 + G5.9 the schema exposes the §8 sections and every §105 index', () => {
  const paths = Object.keys(MatrimonialProfile.schema.paths);
  for (const section of [...PROFILE_SECTIONS, 'profile']) {
    assert.ok(
      paths.some((entry) => entry.startsWith(`${section}.`)),
      `schema is missing the ${section} section`
    );
  }

  const names = MatrimonialProfile.schema
    .indexes()
    .map(([key, options]) =>
      options.name || Object.entries(key).map(([field, dir]) => `${field}_${dir}`).join('_')
    );
  const expected = [
    'userId_1', 'publicProfileId_1', 'profile.status_1', 'profile.lastActiveAt_-1',
    'basic.gender_1_basic.dateOfBirth_-1', 'basic.maritalStatus_1',
    'community.communityId_1', 'community.gotraId_1', 'community.surnameId_1',
    'community.clanId_1', 'community.aaspadId_1',
    'location.stateId_1_location.cityId_1', 'career.occupationId_1',
    'education.degreeId_1', 'location_2dsphere'
  ];
  for (const index of expected) assert.ok(names.includes(index), `missing index ${index}`);

  const uniqueKeys = MatrimonialProfile.schema
    .indexes()
    .filter(([, options]) => options.unique)
    .map(([key]) => Object.keys(key).join(','))
    .sort();
  assert.deepEqual(uniqueKeys, ['publicProfileId', 'userId'], 'exactly the two §105 unique indexes');
});

// ---------------------------------------------------------------------------
// Gate 2 — functional
// ---------------------------------------------------------------------------

test('G2.1 create -> read -> partial update -> hard delete -> recreate', async (t) => {
  if (!requireDb(t)) return;
  const created = await api('/api/v1/profile', { method: 'POST', token: accountA.token, body: fullProfile() });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const profile = created.json.data.profile;
  assert.equal(profile.status, PROFILE_STATUS.DRAFT, 'a fresh profile is always a draft');
  assert.match(profile.publicProfileId, /^CHV-[2-9A-HJKMNP-Z]{5}$/);
  assert.ok(Number.isInteger(profile.completionPercentage));

  // Task 11 — the user row reflects the new profile.
  const afterCreate = await User.findById(accountA.id).lean();
  assert.equal(afterCreate.profileCreated, true, 'users.profileCreated flips on create');
  assert.equal(afterCreate.onboardingCompleted, true, 'a complete profile flips onboardingCompleted');

  const second = await api('/api/v1/profile', { method: 'POST', token: accountA.token, body: fullProfile() });
  assert.equal(second.status, 409, 'a second profile for the same account is refused');

  const own = await api('/api/v1/profile/me', { token: accountA.token });
  assert.equal(own.status, 200);
  assert.equal(own.json.data.profile.publicProfileId, profile.publicProfileId);
  assert.equal(own.json.data.profile.basic.firstName, 'Rahul');

  const patched = await api('/api/v1/profile', {
    method: 'PATCH',
    token: accountA.token,
    body: { career: { occupationId: master.occupationId, designation: 'Senior Engineer' } }
  });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assert.equal(patched.json.data.profile.career.designation, 'Senior Engineer');
  assert.equal(patched.json.data.profile.basic.firstName, 'Rahul', 'untouched sections survive a patch');

  const removed = await api('/api/v1/profile', { method: 'DELETE', token: accountA.token });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.data.profile.publicProfileId, profile.publicProfileId);
  const deleted = await MatrimonialProfile.findOne({ userId: accountA.id }).lean();
  assert.equal(deleted, null, 'hard delete removes the profile document');
  const resetAccount = await User.findById(accountA.id).select('profileCreated onboardingCompleted onboardingStep').lean();
  assert.deepEqual(
    {
      profileCreated: resetAccount.profileCreated,
      onboardingCompleted: resetAccount.onboardingCompleted,
      onboardingStep: resetAccount.onboardingStep
    },
    { profileCreated: false, onboardingCompleted: false, onboardingStep: 0 },
    'profile deletion resets persisted onboarding progress'
  );

  const editTombstone = await api('/api/v1/profile', {
    method: 'PATCH',
    token: accountA.token,
    body: { about: { headline: 'still here' } }
  });
  assert.equal(editTombstone.status, 404, 'a deleted profile cannot be edited');

  const again = await api('/api/v1/profile', { method: 'POST', token: accountA.token, body: fullProfile() });
  assert.equal(again.status, 201, `create after delete: ${JSON.stringify(again.json)}`);
  assert.equal(again.json.data.profile.status, PROFILE_STATUS.DRAFT, 'a recreated profile starts as a draft');
  assert.notEqual(again.json.data.profile.publicProfileId, profile.publicProfileId, 'a hard delete releases the old public id');
});

test('G2.2 a partial draft persists and is resumable (spec §92)', async (t) => {
  if (!requireDb(t)) return;
  const created = await api('/api/v1/profile', {
    method: 'POST',
    token: accountB.token,
    body: { basic: { profileFor: 'self', firstName: 'Sunita', gender: 'female' } }
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.profile.basic.dateOfBirth, null, 'an unfilled field stays null, not rejected');
  assert.ok(created.json.data.profile.completionPercentage > 0);

  const user = await User.findById(accountB.id).lean();
  assert.equal(user.profileCreated, true);
  assert.equal(user.onboardingCompleted, false, 'a thin draft is not onboarded');

  const resumed = await api('/api/v1/profile/me', { token: accountB.token });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.json.data.profile.basic.firstName, 'Sunita');
  assert.equal(resumed.json.data.profile.community.communityId, null, 'untouched sections stay empty');
  assert.equal(resumed.json.data.profile.status, PROFILE_STATUS.DRAFT, 'a draft stays a draft');
});

test('G2.3 completion follows the documented weighting (spec §57)', async (t) => {
  if (!requireDb(t)) return;

  const empty = calculateCompletion({ basic: {}, community: {}, education: {}, career: {}, family: {}, lifestyle: {}, about: {} });
  assert.equal(empty, 0, 'an empty profile scores 0');

  const basicOnly = calculateCompletion({
    basic: { profileFor: 'self', firstName: 'A', gender: 'male', dateOfBirth: '1995-01-01', maritalStatus: 'never_married', heightCm: 170 }
  });
  assert.ok(basicOnly > 0 && basicOnly < 100, `basic alone should score proportionally, got ${basicOnly}`);

  const complete = fullProfile();

  // The deferred sections are excluded from the denominator, not silently zero.
  const enabledWeight = COMPLETION_WEIGHTS.filter((entry) => entry.enabled).reduce((sum, e) => sum + e.weight, 0);
  assert.equal(
    COMPLETION_WEIGHTS.reduce((sum, e) => sum + e.weight, 0),
    100,
    'the documented §57 table sums to 100'
  );
  assert.equal(enabledWeight, 100, 'step 08 made every §57 section scoreable, so the denominator is the full table');
  assert.ok(COMPLETION_WEIGHTS.some((entry) => entry.key === 'photo' && entry.enabled), 'step 08 turned the photo section on');
  assert.ok(COMPLETION_WEIGHTS.some((entry) => entry.key === 'partnerPreferences' && entry.enabled));

  // Two sections live in their own collections — preferences (step 07) and the
  // primary photo (step 08) — so they are scored from the signals the service
  // loads, and each one's absence costs exactly its own weight.
  const preferenceWeight = COMPLETION_WEIGHTS.find((entry) => entry.key === 'partnerPreferences').weight;
  const photoWeight = COMPLETION_WEIGHTS.find((entry) => entry.key === 'photo').weight;
  const profileOnlyWeight = enabledWeight - preferenceWeight - photoWeight;

  assert.equal(
    calculateCompletion(complete),
    profileOnlyWeight,
    'with no photo and no preferences only the profile sections score'
  );

  const withoutPreferences = Math.round(((enabledWeight - preferenceWeight) / enabledWeight) * 100);
  assert.equal(
    calculateCompletion(complete, { hasPrimaryPhoto: true }),
    withoutPreferences,
    'a primary photo adds exactly the photo weight'
  );

  const withoutPhoto = Math.round(((enabledWeight - photoWeight) / enabledWeight) * 100);
  assert.equal(
    calculateCompletion(complete, { partnerPreferences: completePreferences() }),
    withoutPhoto,
    'preferences add exactly the preference weight'
  );

  // Ten scored preference dimensions; three of them set scores three tenths of
  // that section's weight. Pro rata means strictly between the two extremes.
  const partialProgress = 3 / PREFERENCE_COMPLETION_FIELDS.length;
  const partialPreferences = { age: { min: 1, max: 2 }, gender: 'x' };
  const expectedPartial = Math.round(
    ((profileOnlyWeight + preferenceWeight * partialProgress) / enabledWeight) * 100
  );
  assert.equal(
    calculateCompletion(complete, { partnerPreferences: partialPreferences }),
    expectedPartial,
    'a partially-filled preference set scores pro rata, not all-or-nothing'
  );
  assert.ok(
    expectedPartial > profileOnlyWeight && expectedPartial < 100,
    `a partial set must sit between the extremes, got ${expectedPartial}`
  );

  assert.equal(
    calculateCompletion(complete, { hasPrimaryPhoto: true, partnerPreferences: completePreferences() }),
    100,
    'every enabled section filled scores 100'
  );

  const acc = await freshAccount();
  const profile = await createFullProfile(acc.token);
  assert.equal(profile.completionPercentage, withoutPreferences, 'a new profile has a photo but no preferences yet');

  const state = requiredFieldsState(complete);
  assert.equal(state.complete, true, `missing: ${state.missing.join(', ')}`);
  assert.equal(state.missing.length, 0);
  assert.ok(REQUIRED_V1_FIELDS.includes('community.gotraId'), 'gotra is a §25 V1 requirement');

  // A thin draft lists exactly what is missing — what onboarding must ask for.
  const thin = requiredFieldsState({ basic: { firstName: 'X' }, community: {}, education: {}, career: {}, family: {}, lifestyle: {}, about: {} });
  assert.equal(thin.complete, false);
  assert.ok(thin.missing.includes('basic.dateOfBirth'));
  assert.ok(thin.missing.includes('community.gotraId'));
});

test('G2.4 status transitions follow the §58 rule table', async (t) => {
  if (!requireDb(t)) return;

  // draft -> hidden is not a published state: refuse it, do not store it.
  const hideDraft = await api('/api/v1/profile', { method: 'PATCH', token: accountB.token, body: { status: 'hidden' } });
  assert.equal(hideDraft.status, 409, 'draft -> hidden must be refused');

  // A draft cannot publish before §25 is met.
  const early = await api('/api/v1/profile', { method: 'PATCH', token: accountB.token, body: { status: 'active' } });
  assert.equal(early.status, 409, `expected a state conflict, got ${early.status}: ${JSON.stringify(early.json)}`);
  assert.ok(Array.isArray(early.json.details.missing), 'the response says exactly what is missing');
  assert.ok(early.json.details.missing.length > 0);

  // Fill it in, then publish.
  const filled = await api('/api/v1/profile', { method: 'PATCH', token: accountB.token, body: fullProfile() });
  assert.equal(filled.status, 200, JSON.stringify(filled.json));
  assert.equal(filled.json.data.profile.status, PROFILE_STATUS.DRAFT, 'content alone never publishes');

  // Every §25 field is present but the platform still asks for a photo before a
  // profile becomes discoverable (spec §15, step 08 task 13).
  const noPhotoYet = await api('/api/v1/profile', { method: 'PATCH', token: accountB.token, body: { status: 'active' } });
  assert.equal(noPhotoYet.status, 409, 'a complete profile without a photo is not publishable here');
  assert.ok(
    noPhotoYet.json.details.missing.includes('photos'),
    `the response names the photo requirement: ${JSON.stringify(noPhotoYet.json.details)}`
  );

  await addPrimaryPhoto(accountB.token);

  const published = await api('/api/v1/profile', { method: 'PATCH', token: accountB.token, body: { status: 'active' } });
  assert.equal(published.status, 200, JSON.stringify(published.json));
  assert.equal(published.json.data.profile.status, PROFILE_STATUS.ACTIVE);

  const republished = await api('/api/v1/profile', { method: 'PATCH', token: accountB.token, body: { status: 'active' } });
  assert.equal(republished.status, 200, 'active -> active is an idempotent no-op');

  const unpublished = await api('/api/v1/profile', { method: 'PATCH', token: accountB.token, body: { status: 'hidden' } });
  assert.equal(unpublished.status, 200);
  assert.equal(unpublished.json.data.profile.status, PROFILE_STATUS.HIDDEN);

  const backToActive = await api('/api/v1/profile', { method: 'PATCH', token: accountB.token, body: { status: 'active' } });
  assert.equal(backToActive.status, 200, 'hidden -> active is allowed');
  assert.equal(backToActive.json.data.profile.status, PROFILE_STATUS.ACTIVE);

  // `suspended` / `deleted` are admin + system only (spec §58).
  const suspended = await api('/api/v1/profile', { method: 'PATCH', token: accountB.token, body: { status: 'suspended' } });
  assert.equal(suspended.status, 400, 'suspended is not client-settable');

  const user = await User.findById(accountB.id).lean();
  assert.equal(user.onboardingCompleted, true, 'publishing a complete profile completes onboarding');
});

test('G2.5 cross-field rules, bounds and enums are each rejected (400)', async (t) => {
  if (!requireDb(t)) return;
  const acc = await freshAccount();
  await api('/api/v1/profile', {
    method: 'POST',
    token: acc.token,
    body: { basic: { profileFor: 'self', firstName: 'Probe', gender: 'male' } }
  });

  const cases = [
    ['brothers', { family: { brothersCount: 2, marriedBrothersCount: 3 } }, /Married brothers/],
    ['sisters', { family: { sistersCount: 1, marriedSistersCount: 2 } }, /Married sisters/],
    ['children', { marriage: { hasChildren: false, childrenCount: 2 } }, /children count/i],
    ['dietOther', { lifestyle: { diet: 'vegetarian', dietOther: 'Jain style' } }, /only accepted when diet is/],
    ['height', { basic: { heightCm: 50 } }, /at least 140/],
    ['underage', { basic: { dateOfBirth: '2015-01-01' } }, /Age must be between/],
    ['bad enum', { basic: { gender: 'other' } }, /allowed options|gender/i],
    ['unknown field', { userId: 'x' }, /Unrecognized/i],
    ['unknown nested field', { basic: { isAdmin: true } }, /Unrecognized/i],
    ['array cap', { personal: { hobbies: Array(31).fill(master.hobbyId) } }, /at most 30/],
    ['malformed id', { community: { gotraId: '{"$ne":1}' } }, /valid identifier/i],
    ['injected object', { community: { gotraId: { $ne: 1 } } }, /valid identifier/i],
    ['unknown id', { community: { gotraId: '000000000000000000000000' } }, /does not exist/i]
  ];

  for (const [name, body, pattern] of cases) {
    const res = await api('/api/v1/profile', { method: 'PATCH', token: acc.token, body });
    assert.equal(res.status, 400, `${name}: expected 400, got ${res.status} ${JSON.stringify(res.json)}`);
    const detail = JSON.stringify(res.json.details || res.json);
    assert.match(detail, pattern, `${name}: ${detail}`);
  }

  // Nothing above wrote a row.
  const own = await api('/api/v1/profile/me', { token: acc.token });
  assert.equal(own.json.data.profile.basic.firstName, 'Probe', 'a rejected patch changes nothing');
  assert.equal(own.json.data.profile.community.gotraId, null);
});

test('G2.6 a valid enum value round-trips (spec §81)', async (t) => {
  if (!requireDb(t)) return;
  const res = await api('/api/v1/profile', {
    method: 'PATCH',
    token: accountB.token,
    body: { lifestyle: { diet: 'other', dietOther: 'Satvik', smoking: 'never', pets: 'no_pets' } }
  });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.profile.lifestyle.dietOther, 'Satvik');
  assert.equal(res.json.data.profile.lifestyle.pets, 'no_pets');
  assert.equal(res.json.data.profile.status, PROFILE_STATUS.ACTIVE, 'content edits do not change status');
});

test('G2.7 denormalised names come from the master record and are refreshed (spec §10, §97)', async (t) => {
  if (!requireDb(t)) return;
  const own = await api('/api/v1/profile/me', { token: accountB.token });
  assert.equal(own.status, 200);
  const profile = own.json.data.profile;

  assert.equal(String(profile.community.gotraId), master.gotraId);
  assert.equal(profile.community.gotraName, master.gotraName, 'gotraName was written from the master row');
  assert.equal(String(profile.community.surnameId), master.surnameId);
  assert.equal(profile.community.surnameName, master.surnameName);
  assert.equal(String(profile.location.cityId), master.cityId);
  assert.equal(profile.location.cityName, master.cityName);
  assert.equal(profile.career.occupationName, master.occupationName);
  assert.equal(profile.community.clanName, null, 'a clan was not set, so no copy exists');

  // Simulate an admin rename (decision §14) and confirm the next write re-derives.
  const Occupation = getMasterModel('occupations');
  const original = await Occupation.findById(master.occupationId).select('name nameLower').lean();
  const renamed = `${original.name} Prime`;
  try {
    await Occupation.updateOne(
      { _id: master.occupationId },
      { $set: { name: renamed, nameLower: renamed.toLowerCase() } }
    );
    const res = await api('/api/v1/profile', {
      method: 'PATCH',
      token: accountB.token,
      body: { career: { occupationId: master.occupationId } }
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.data.profile.career.occupationName, renamed, 'the copy tracks the master rename');
  } finally {
    await Occupation.updateOne(
      { _id: master.occupationId },
      { $set: { name: original.name, nameLower: original.nameLower } }
    );
  }
});

test('G2.7b a clan is validated inside its community (step 05 scoping)', async (t) => {
  if (!requireDb(t)) return;
  const Clan = getMasterModel('clans');
  const scoped = await Clan.findOne({ communityId: master.communityId, isActive: true }).select('_id name').lean();
  const foreign = await Clan.findOne({ communityId: { $ne: master.communityId }, isActive: true })
    .select('_id name')
    .lean();
  if (!scoped && !foreign) {
    t.skip('seed has no clan data to test scoping against');
    return;
  }

  const acc = await freshAccount();
  await createFullProfile(acc.token);

  if (foreign) {
    const wrongScope = await api('/api/v1/profile', {
      method: 'PATCH',
      token: acc.token,
      body: {
        community: {
          communityId: master.communityId,
          clanId: String(foreign._id),
          surnameId: master.surnameId,
          gotraId: master.gotraId
        }
      }
    });
    assert.equal(wrongScope.status, 400, `a foreign clan must be refused: ${JSON.stringify(wrongScope.json)}`);
    assert.match(JSON.stringify(wrongScope.json.details), /does not belong to/i);
  }

  if (scoped) {
    const rightScope = await api('/api/v1/profile', {
      method: 'PATCH',
      token: acc.token,
      body: {
        community: {
          communityId: master.communityId,
          clanId: String(scoped._id),
          surnameId: master.surnameId,
          gotraId: master.gotraId
        }
      }
    });
    assert.equal(rightScope.status, 200, JSON.stringify(rightScope.json));
    assert.equal(rightScope.json.data.profile.community.clanName, scoped.name);
  }
});

test('G2.8 draft and hidden profiles are never publicly readable (spec §58)', async (t) => {
  if (!requireDb(t)) return;
  const acc = await freshAccount();
  const created = await createFullProfile(acc.token);
  const publicProfileId = created.publicProfileId;

  const readAs = async () => api(`/api/v1/profile/${publicProfileId}`, { token: accountB.token });

  // draft -> 404
  assert.equal((await readAs()).status, 404, 'a draft profile is not publicly readable');

  // active -> 200
  const published = await api('/api/v1/profile', { method: 'PATCH', token: acc.token, body: { status: 'active' } });
  assert.equal(published.status, 200, JSON.stringify(published.json));
  const visible = await readAs();
  assert.equal(visible.status, 200, 'an active profile IS readable');
  assert.equal(visible.json.data.profile.publicProfileId, publicProfileId);

  // hidden -> 404
  const hidden = await api('/api/v1/profile', { method: 'PATCH', token: acc.token, body: { status: 'hidden' } });
  assert.equal(hidden.status, 200);
  assert.equal((await readAs()).status, 404, 'a hidden profile disappears from public reads');

  // active again -> 200, then hard delete -> 404.
  await api('/api/v1/profile', { method: 'PATCH', token: acc.token, body: { status: 'active' } });
  assert.equal((await readAs()).status, 200);
  const removed = await api('/api/v1/profile', { method: 'DELETE', token: acc.token });
  assert.equal(removed.status, 200);
  assert.equal((await readAs()).status, 404, 'a deleted profile is not publicly readable');

  // The owner no longer has a profile and may start again.
  const own = await api('/api/v1/profile/me', { token: acc.token });
  assert.equal(own.status, 200);
  assert.equal(own.json.data.profile, null);
  const recreated = await api('/api/v1/profile', { method: 'POST', token: acc.token, body: fullProfile() });
  assert.equal(recreated.status, 201, JSON.stringify(recreated.json));
  assert.notEqual(recreated.json.data.profile.publicProfileId, publicProfileId, 'a hard delete releases the old public id');
  assert.equal((await readAs()).status, 404, 'a recreated profile starts hidden from discovery again');
});

test('G2.9 + G5.8 publicProfileId is unique, stable and not an ObjectId (spec §113)', async (t) => {
  if (!requireDb(t)) return;

  const generated = new Set();
  for (let index = 0; index < 200; index += 1) generated.add(generatePublicProfileId());
  assert.equal(generated.size, 200, 'ids must not repeat');
  for (const id of generated) {
    assert.ok(isPublicProfileId(id), `${id} is not a valid public profile id`);
    assert.equal(id.slice(0, 4), 'CHV-');
    assert.equal(id.length, 9, 'CHV- plus five characters');
    assert.ok(!/[01OIL]/.test(id.slice(4)), 'the alphabet drops ambiguous characters');
  }

  const own = await api('/api/v1/profile/me', { token: accountB.token });
  const stored = own.json.data.profile.publicProfileId;
  const doc = await MatrimonialProfile.findOne({ publicProfileId: stored })
    .select('publicProfileId _id userId')
    .lean();
  assert.ok(isPublicProfileId(stored));
  assert.notEqual(stored, String(doc._id), 'the public id is not the ObjectId');
  assert.ok(!stored.includes(String(doc._id)), 'the public id does not embed the ObjectId');
  assert.ok(!stored.includes(String(doc.userId)), 'the public id does not embed the account id');

  // Uniqueness is enforced in the database, not just in the generator. A brand
  // new account collides only on publicProfileId, so this proves that index.
  const other = await freshAccount();
  await assert.rejects(
    () => MatrimonialProfile.create({ userId: other.id, publicProfileId: stored }),
    (err) => err && err.code === 11000,
    'the unique index rejects a duplicate publicProfileId'
  );
});

// ---------------------------------------------------------------------------
// Gate 3 — security
// ---------------------------------------------------------------------------

test('G3.1 GET /profile/me always resolves the caller (command 7)', async (t) => {
  if (!requireDb(t)) return;
  const a = await api('/api/v1/profile/me', { token: accountA.token });
  const b = await api('/api/v1/profile/me', { token: accountB.token });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.json.data.profile.userId, accountA.id);
  assert.equal(b.json.data.profile.userId, accountB.id);
  assert.notEqual(a.json.data.profile.publicProfileId, b.json.data.profile.publicProfileId);
});

test('G3.2 a userId in the body never touches another account', async (t) => {
  if (!requireDb(t)) return;
  const before = await MatrimonialProfile.findOne({ userId: accountB.id }).select('basic.firstName').lean();

  const res = await api('/api/v1/profile', {
    method: 'PATCH',
    token: accountA.token,
    body: { userId: accountB.id, basic: { firstName: 'Hacked' } }
  });
  assert.equal(res.status, 400, 'userId is rejected as an unknown field');
  assert.match(JSON.stringify(res.json.details), /Unrecognized/i);

  const after = await MatrimonialProfile.findOne({ userId: accountB.id }).select('basic.firstName').lean();
  assert.equal(after.basic.firstName, before.basic.firstName, 'the other profile is untouched');
});

test('G3.3 the public DTO leaks no restricted field (inspected as JSON)', async (t) => {
  if (!requireDb(t)) return;
  const own = await api('/api/v1/profile/me', { token: accountB.token });
  const ownRaw = JSON.stringify(own.json);
  assert.ok(ownRaw.includes('coordinates'), 'the owner sees their own coordinates');
  assert.ok(ownRaw.includes('birthTime'), 'the owner sees their own birth time');
  assert.ok(!ownRaw.includes('passwordHash'));

  const publicProfileId = own.json.data.profile.publicProfileId;
  const res = await api(`/api/v1/profile/${publicProfileId}`, { token: accountA.token });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const raw = JSON.stringify(res.json);

  for (const leak of ['coordinates', 'birthTime', 'birthPlace', 'passwordHash', '"email"', '"phone"', 'userId', 'completionPercentage']) {
    assert.ok(!raw.includes(leak), `public DTO leaked "${leak}": ${raw.slice(0, 400)}`);
  }
});

test('G3.4 the fields dictionary §26 restricted list is absent from card and public DTOs', async (t) => {
  if (!requireDb(t)) return;
  const { publicProfile, discoveryCard: card } = require('../src/services/profileSerializer');
  const doc = await MatrimonialProfile.findOne({ userId: accountB.id });
  const restricted = ['email', 'phone', 'coordinates', 'birthTime', 'birthPlace', 'passwordHash', 'userId'];

  for (const dto of [publicProfile(doc), card(doc)]) {
    const raw = JSON.stringify(dto);
    for (const field of restricted) {
      assert.ok(!raw.includes(field), `${field} leaked into a shared DTO: ${raw.slice(0, 300)}`);
    }
  }
  // The own DTO is the one place the restricted values are allowed.
  assert.ok(JSON.stringify(require('../src/services/profileSerializer').ownProfile(doc)).includes('coordinates'));
});

test('G3.5 object-shaped filters never reach a query', async (t) => {
  if (!requireDb(t)) return;
  // Injection payloads in the body are a schema failure, before any database call.
  const injected = await api('/api/v1/profile', {
    method: 'PATCH',
    token: accountA.token,
    body: { community: { gotraId: { $ne: 1 } } }
  });
  assert.equal(injected.status, 400, JSON.stringify(injected.json));

  // A query string is not part of any route contract: it resolves to nothing.
  const withQuery = await api('/api/v1/profile?publicProfileId[$ne]=x', { token: accountA.token });
  assert.equal(withQuery.status, 404, `bare /profile with a junk query must not match: ${withQuery.status}`);
  assert.equal(withQuery.json.data, undefined, 'no profile data is returned');

  const paramInjection = await api("/api/v1/profile/CHV-82A91?status[$ne]=x", { token: accountA.token });
  assert.equal(paramInjection.status, 404, 'an unknown id stays a 404 whatever the query says');
});

test('G3.6 a suspended account cannot read or write a profile', async (t) => {
  if (!requireDb(t)) return;
  const acc = await freshAccount();
  await createFullProfile(acc.token);

  await User.updateOne({ _id: acc.id }, { $set: { status: 'suspended' } });
  try {
    const read = await api('/api/v1/profile/me', { token: acc.token });
    assert.equal(read.status, 403, JSON.stringify(read.json));
    assert.equal(read.json.code, 'ACCOUNT_INACTIVE');

    const write = await api('/api/v1/profile', { method: 'PATCH', token: acc.token, body: { about: { headline: 'nope' } } });
    assert.equal(write.status, 403, 'a suspended account cannot write either');
    const removed = await api('/api/v1/profile', { method: 'DELETE', token: acc.token });
    assert.equal(removed.status, 403, 'a suspended account cannot delete either');
  } finally {
    await User.updateOne({ _id: acc.id }, { $set: { status: 'active' } });
  }
});

// ---------------------------------------------------------------------------
// Gate 4 — performance & data
// ---------------------------------------------------------------------------

test('G4.1 userId and publicProfileId lookups are index-backed (§105)', async (t) => {
  if (!requireDb(t)) return;
  const own = await api('/api/v1/profile/me', { token: accountB.token });
  const publicProfileId = own.json.data.profile.publicProfileId;

  const byUser = JSON.stringify(await MatrimonialProfile.find({ userId: accountB.id }).explain('executionStats'));
  assert.ok(byUser.includes('IXSCAN'), `userId lookup must use an index: ${byUser.slice(0, 300)}`);
  assert.ok(!byUser.includes('"COLLSCAN"'));

  const byPublic = JSON.stringify(await MatrimonialProfile.find({ publicProfileId }).explain('executionStats'));
  assert.ok(byPublic.includes('IXSCAN'), 'publicProfileId lookup must use an index');
  assert.ok(!byPublic.includes('"COLLSCAN"'));
});

test('G4.2 the public read is projected and never loads restricted fields (spec §51)', async (t) => {
  if (!requireDb(t)) return;
  const own = await api('/api/v1/profile/me', { token: accountB.token });
  const publicProfileId = own.json.data.profile.publicProfileId;

  const doc = await MatrimonialProfile.findOne({ publicProfileId }).select(PUBLIC_PROJECTION);
  assert.ok(doc, 'the profile exists');
  assert.equal(doc.location.coordinates, undefined, 'the projection excludes coordinates');
  assert.equal(doc.horoscope.birthTime, undefined, 'the projection excludes the birth time');
  assert.equal(doc.horoscope.birthPlace, undefined, 'the projection excludes the birth place');
  assert.equal(doc.userId, undefined, 'the projection excludes the owner id');

  const res = await api(`/api/v1/profile/${publicProfileId}`, { token: accountA.token });
  assert.ok(!JSON.stringify(res.json).includes('coordinates'));
});

test('G4.3 the profile read paths perform no populate chain (spec §66)', () => {
  const service = fs.readFileSync(path.join(SERVER_ROOT, 'src', 'services', 'profileService.js'), 'utf8');
  const controller = fs.readFileSync(path.join(SERVER_ROOT, 'src', 'controllers', 'profile.controller.js'), 'utf8');
  assert.ok(!service.includes('.populate('), 'profileService must not populate');
  assert.ok(!controller.includes('.populate('), 'the controller must not populate');
});

// ---------------------------------------------------------------------------
// Gate 5 — spec conformance
// ---------------------------------------------------------------------------

test('G5.1 + G5.3 the schema matches §8 and keeps names only beside ids', () => {
  const paths = Object.keys(MatrimonialProfile.schema.paths);

  for (const [idField, nameField] of [
    ['community.surnameId', 'community.surnameName'],
    ['community.gotraId', 'community.gotraName'],
    ['community.clanId', 'community.clanName'],
    ['community.aaspadId', 'community.aaspadName'],
    ['location.cityId', 'location.cityName'],
    ['location.stateId', 'location.stateName'],
    ['career.occupationId', 'career.occupationName'],
    ['career.industryId', 'career.industryName'],
    ['education.degreeId', 'education.degreeName'],
    ['education.specializationId', 'education.specializationName']
  ]) {
    assert.ok(paths.includes(idField), `${idField} is missing`);
    assert.ok(paths.includes(nameField), `${nameField} is missing`);
  }

  // No denormalised name without the id that anchors it.
  assert.ok(!paths.includes('community.name'), 'no unanchored community name');

  // Restricted fields are marked internal, so a raw serialisation drops them too.
  assert.equal(MatrimonialProfile.schema.path('horoscope.birthTime').options.internal, true);
  assert.equal(MatrimonialProfile.schema.path('horoscope.birthPlace').options.internal, true);
  assert.equal(MatrimonialProfile.schema.path('location.coordinates').options.internal, true);

  // Age is never a stored path (spec §47).
  assert.ok(!paths.some((entry) => entry === 'age' || entry.endsWith('.age')), 'age must not be a schema path');
});

test('G5.3b age is derived, never stored (spec §47)', async (t) => {
  if (!requireDb(t)) return;
  const own = await api('/api/v1/profile/me', { token: accountB.token });
  const profile = own.json.data.profile;
  assert.ok(Number.isInteger(profile.age), 'age is computed at read time');
  assert.equal(profile.age, computeAge(profile.basic.dateOfBirth));

  // Stored representation is the date only.
  const stored = await MatrimonialProfile.findOne({ userId: accountB.id }).select('basic.dateOfBirth').lean();
  assert.ok(stored.basic.dateOfBirth instanceof Date, 'the database keeps a date, not an age');
});

test('G5.3c height is exposed as centimetres and feet/inches (§3.9)', async (t) => {
  if (!requireDb(t)) return;
  assert.equal(heightDisplay(175), `5'9"`);
  assert.equal(heightDisplay(182.88), `6'0"`);
  assert.equal(heightDisplay(null), null);

  const own = await api('/api/v1/profile/me', { token: accountB.token });
  const height = own.json.data.profile.height;
  assert.equal(height.cm, 175);
  assert.equal(height.display, `5'9"`);
});

test('G5.7 the discovery card is the §70 subset and nothing more', async (t) => {
  if (!requireDb(t)) return;
  const doc = await MatrimonialProfile.findOne({ userId: accountB.id });
  const card = discoveryCard(doc);

  assert.deepEqual(Object.keys(card), [
    'profileId', 'name', 'age', 'height', 'city', 'degree', 'occupation',
    'surname', 'gotra', 'verified', 'primaryPhoto', 'lastActiveAt'
  ]);
  assert.equal(card.profileId, doc.publicProfileId);
  assert.equal(card.primaryPhoto, null, 'photos belong to step 08');
  assert.equal(card.city, master.cityName, 'the card is display-ready without a join');
});

test('acceptance: a full onboarding body round-trips through every section', async (t) => {
  if (!requireDb(t)) return;

  const education = { degreeId: master.degreeId, universityId: master.universityId };
  if (master.specializationId) education.specializationId = master.specializationId;

  const community = { motherTongueId: master.languageId };
  if (master.clanId) community.clanId = master.clanId;

  const body = fullProfile({
    community,
    education,
    career: { occupationId: master.occupationId, industryId: master.industryId, employmentType: 'private', incomeRange: '5_10_lpa' },
    family: { familyType: 'nuclear', brothersCount: 1, marriedBrothersCount: 0, sistersCount: 1, marriedSistersCount: 1 },
    location: { cityId: master.cityId },
    horoscope: { available: true, manglik: 'no', rashi: 'Simha', birthTime: '1998-05-01T02:30:00.000Z', birthPlace: 'Sikar, Rajasthan' },
    marriage: { hasChildren: false, wantsChildren: 'yes' },
    // §9.1: switching away from "other" must clear the custom description —
    // the merged document is validated, so a stale dietOther would be refused.
    lifestyle: { diet: 'vegetarian', dietOther: null },
    personal: {}
  });

  const patch = await api('/api/v1/profile', { method: 'PATCH', token: accountB.token, body });
  assert.equal(patch.status, 200, JSON.stringify(patch.json));

  const own = await api('/api/v1/profile/me', { token: accountB.token });
  const profile = own.json.data.profile;

  assert.equal(profile.basic.firstName, 'Rahul');
  assert.equal(profile.community.gotraName, master.gotraName);
  assert.equal(profile.community.motherTongueName, master.languageName);
  if (master.clanId) assert.equal(profile.community.clanName, master.clanName);
  assert.equal(profile.location.cityName, master.cityName);
  assert.equal(profile.education.degreeName, master.degreeName);
  if (master.specializationId) assert.equal(profile.education.specializationName, master.specializationName);
  assert.equal(profile.education.universityName, master.universityName);
  assert.equal(profile.career.occupationName, master.occupationName);
  assert.equal(profile.career.industryName, master.industryName);
  assert.equal(profile.career.incomeRange, '5_10_lpa');
  assert.equal(profile.personal.hobbies.length, 1);
  assert.equal(profile.personal.interests.length, 1);
  assert.equal(profile.personal.languages.length, 1);
  assert.equal(profile.horoscope.manglik, 'no');
  assert.equal(profile.horoscope.birthPlace, 'Sikar, Rajasthan');
  assert.equal(profile.marriage.wantsChildren, 'yes');
  // Step 07: the profile sections are all filled, but preferences are not saved
  // for this account, so the score is short of 100 (see G2.3 for the arithmetic).
  assert.equal(profile.completionPercentage, completionWithoutPreferences());
  assert.equal(profile.status, PROFILE_STATUS.ACTIVE, 'an already-active profile stays active');
  assert.equal(profile.age, computeAge(profile.basic.dateOfBirth));

  // Own view keeps birth details; the public view (still active) does not.
  const publicView = await api(`/api/v1/profile/${profile.publicProfileId}`, { token: accountA.token });
  assert.equal(publicView.status, 200, JSON.stringify(publicView.json));
  const publicRaw = JSON.stringify(publicView.json);
  assert.ok(!publicRaw.includes('birthTime'), 'birth time stays private');
  assert.ok(!publicRaw.includes('birthPlace'), 'birth place stays private');
  assert.ok(publicRaw.includes('"manglik":"no"'), 'the horoscope summary itself is shareable');
});
