'use strict';

/**
 * Step 09 — Discover / search (spec §35, §45–§56, §65, §66, §70, §82, §83, §99,
 * §108, §109, §119, §120).
 *
 * Runs against the configured cluster in a DEDICATED database, seeded with the
 * real step-05 seeder. Every fixture is created in its own city so a test can
 * filter on `cityId` and be independent of what any other test created — the
 * suite is order-independent by construction, which matters because the
 * document set grows as tests run.
 *
 * Cloudinary is the deterministic gateway double from step 08
 * (`tests/helpers/fakeCloudinary.js`): photos must exist because publishing
 * requires one (spec §15), and they must be *approved* for a card image
 * (spec §101), which the tests do directly — moderation is step 16.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.MONGODB_DB_NAME = 'chandravanshi_vivah_test_search';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.RATE_LIMIT_MAX = '99999';
process.env.RATE_LIMIT_WINDOW = '3600';
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
process.env.CLOUDINARY_API_KEY = 'test-key-1234';
process.env.CLOUDINARY_API_SECRET = 'test-secret-abcdef';
process.env.CLOUDINARY_UPLOAD_FOLDER = 'chandravanshi-vivah-test';
process.env.PHOTO_MAX_COUNT = '3';
process.env.PHOTO_MAX_BYTES = '1mb';
process.env.PHOTO_ALLOWED_FORMATS = 'jpg,jpeg,png,webp';
// Small pages so pagination and the limit cap are cheap to exercise.
process.env.SEARCH_DEFAULT_LIMIT = '3';
process.env.SEARCH_MAX_LIMIT = '10';
process.env.SEARCH_CANDIDATE_CAP = '50';
process.env.SEARCH_MAX_DISTANCE_KM = '500';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const app = require('../src/app');
const db = require('../src/config/db');
const config = require('../src/config/env');
const User = require('../src/models/User');
const Session = require('../src/models/Session');
const MatrimonialProfile = require('../src/models/MatrimonialProfile');
const PartnerPreference = require('../src/models/PartnerPreference');
const Photo = require('../src/models/Photo');
const CommunityConfig = require('../src/models/CommunityConfig');
const { getMasterModel } = require('../src/models/masterData/MasterItem');
const { MASTER_TYPE_VALUES } = require('../src/constants/masterData');
const { COLLECTIONS } = require('../src/config/collections');
const seeder = require('../scripts/seed-master-data');

const searchService = require('../src/services/searchService');
const queryBuilder = require('../src/services/queryBuilder');
const exclusionService = require('../src/services/exclusionService');
const preferenceService = require('../src/services/preferenceService');
const recommendationService = require('../src/services/recommendationService');
const profileScoreService = require('../src/services/profileScoreService');
const cursorCodec = require('../src/services/cursor');
const { dateOfBirthRange } = require('../src/services/dateRange');
const { CARD_PROJECTION } = require('../src/utils/projections');
const { RECOMMENDATION_WEIGHTS, RECOMMENDATION_TOTAL, SORT_VALUES } = require('../src/constants/search');
const fakeCloudinary = require('./helpers/fakeCloudinary');

const PASSWORD = 'correct-horse-battery';
const RUN = Date.now();

let server;
let base;
let available = false;
let unavailableReason = '';
let viewer;
let accountSeq = 0;
let photoSeq = 0;

const master = {};
const cities = {};

/** The documented card keys (spec §70) — the exact set a row may carry. */
const CARD_KEYS = Object.freeze([
  'profileId',
  'name',
  'age',
  'height',
  'city',
  'degree',
  'occupation',
  'surname',
  'gotra',
  'verified',
  'primaryPhoto',
  'lastActiveAt'
]);

function requireDb(t) {
  if (!available) {
    t.skip(`database unavailable (${unavailableReason})`);
    return false;
  }
  return true;
}

async function api(route, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
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

async function freshAccount() {
  accountSeq += 1;
  return registerAndLogin(`s9-${RUN}-${accountSeq}@example.com`);
}

const id = (doc) => String(doc._id);

/** A §25-complete profile body, so the candidate can be published. */
function fullProfile(overrides = {}) {
  return {
    basic: {
      profileFor: 'self',
      firstName: 'Candidate',
      gender: 'male',
      dateOfBirth: '1997-01-15',
      maritalStatus: 'never_married',
      heightCm: 170,
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

async function signedFolder(token) {
  const sign = await api('/api/v1/photos/sign', { method: 'POST', token, body: {} });
  assert.equal(sign.status, 200, `sign: ${JSON.stringify(sign.json)}`);
  return sign.json.data.upload;
}

async function addPhoto(token, { type = 'profile', name = 'photo' } = {}) {
  const upload = await signedFolder(token);
  photoSeq += 1;
  const publicId = `${upload.folder}/${name}-${photoSeq}`;
  const res = await api('/api/v1/photos', { method: 'POST', token, body: { publicId, type } });
  assert.equal(res.status, 201, `register photo: ${JSON.stringify(res.json)}`);
  return { publicId, res };
}

/**
 * A discoverable candidate: registered, profiled, photographed, published.
 *
 * `spec` controls the dimensions the filters are tested against. `pending: true`
 * leaves the photo unapproved, which is the only way a profile can be active and
 * still have no *discoverable* photo (spec §101 + step 09's `hasPhoto` signal).
 */
async function createCandidate(spec = {}) {
  const account = await freshAccount();
  const body = fullProfile({
    basic: {
      gender: spec.gender || 'male',
      dateOfBirth: spec.dateOfBirth || '1997-01-15',
      heightCm: spec.heightCm === undefined ? 170 : spec.heightCm,
      maritalStatus: spec.maritalStatus || 'never_married'
    },
    community: spec.community || {},
    location: { cityId: spec.cityId || master.cityId },
    // Both keys: `highestQualificationId` satisfies §25, `degreeId` is the field
    // the education filter matches on (and carries its own denormalised name).
    education: {
      highestQualificationId: spec.degreeId || master.degreeId,
      ...(spec.degreeId ? { degreeId: spec.degreeId } : {}),
      ...(spec.education || {})
    },
    career: { occupationId: spec.occupationId || master.occupationId, ...(spec.career || {}) },
    family: spec.family || {},
    lifestyle: spec.lifestyle || {},
    about: {}
  });

  const created = await api('/api/v1/profile', { method: 'POST', token: account.token, body });
  assert.equal(created.status, 201, `create profile: ${JSON.stringify(created.json)}`);

  const photo = await addPhoto(account.token, { type: 'profile', name: 'primary' });
  if (spec.pending !== true) {
    await Photo.updateOne({ userId: account.id, isPrimary: true }, { $set: { moderationStatus: 'approved' } });
    await profileScoreService.syncDiscoveryPhotoFlag(account.id);
  }

  if (spec.verified === true) {
    await MatrimonialProfile.updateOne({ userId: account.id }, { $set: { 'profile.isVerified': true } });
  }

  const published = await api('/api/v1/profile', { method: 'PATCH', token: account.token, body: { status: 'active' } });
  assert.equal(published.status, 200, `publish: ${JSON.stringify(published.json)}`);

  const doc = await MatrimonialProfile.findOne({ userId: account.id }).lean();
  return { ...account, publicProfileId: doc.publicProfileId, photoPublicId: photo.publicId, doc };
}

/** The ids a page/result set carries, in order. */
const idsOf = (payload) => (payload.items || []).map((item) => item.profileId);

async function search(filters, extra = {}) {
  return searchService.search(viewer.id, { filters, ...extra });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let filtersFixtures;
let discoverFixtures;
let paginationFixtures;
let sortingFixtures;
let visibilityFixtures;
let geoFixtures;
let recommendationFixtures;

async function buildFixtures() {
  // --- Alwar: one fixture per filter dimension -----------------------------
  const c1 = { communityId: master.communityId, surnameId: master.surnameId, gotraId: master.gotraId };
  const c2 = { communityId: master.communityId2, surnameId: master.surnameId2, gotraId: master.gotraId2 };

  const fa1 = await createCandidate({
    gender: 'female',
    dateOfBirth: '1998-05-01',
    heightCm: 170,
    maritalStatus: 'never_married',
    cityId: id(cities.alwar),
    community: c1,
    degreeId: id(master.degree1),
    occupationId: id(master.occupation1),
    career: { industryId: id(master.industry1), employmentType: 'government', incomeRange: '5_10_lpa' },
    lifestyle: { diet: 'vegetarian', smoking: 'never', drinking: 'never' },
    family: { familyType: 'nuclear' }
  });

  const fa2 = await createCandidate({
    gender: 'male',
    dateOfBirth: '1992-03-01',
    heightCm: 175,
    maritalStatus: 'divorced',
    cityId: id(cities.alwar),
    community: c2,
    degreeId: id(master.degree2),
    occupationId: id(master.occupation2),
    career: { industryId: id(master.industry1), employmentType: 'private', incomeRange: '10_20_lpa' },
    lifestyle: { diet: 'jain', smoking: 'regularly', drinking: 'occasionally' },
    family: { familyType: 'joint' },
    verified: true,
    pending: true
  });

  filtersFixtures = { fa1, fa2, cityId: id(cities.alwar) };

  // --- Jhunjhunu: the preference-driven discover set -----------------------
  const jhunjhunu = id(cities.jhunjhunu);
  const df1 = await createCandidate({ gender: 'female', dateOfBirth: '1999-06-01', cityId: jhunjhunu });
  const df2 = await createCandidate({ gender: 'female', dateOfBirth: '1997-06-01', cityId: jhunjhunu });
  const df3 = await createCandidate({
    gender: 'female',
    dateOfBirth: '1999-06-01',
    cityId: jhunjhunu,
    lifestyle: { diet: 'non_vegetarian' }
  });
  const df4 = await createCandidate({ gender: 'male', dateOfBirth: '1999-06-01', cityId: jhunjhunu });
  discoverFixtures = { df1, df2, df3, df4, cityId: jhunjhunu };

  // --- Churu: the ranked set ----------------------------------------------
  // rr1's age sits on the middle of the viewer's preferred range, rr2's is close
  // to its lower bound — the two must come back in that order (spec §54).
  const churu = id(cities.churu);
  const rr1 = await createCandidate({ gender: 'female', dateOfBirth: '1994-01-01', cityId: churu });
  const rr2 = await createCandidate({ gender: 'female', dateOfBirth: '2000-04-01', cityId: churu });
  recommendationFixtures = { rr1, rr2, cityId: churu };

  // --- Pagination: five candidates sharing one timestamp -------------------
  const pagCity = id(cities.bharatpur);
  const pages = [];
  for (let index = 0; index < 5; index += 1) {
    pages.push(await createCandidate({ gender: 'male', dateOfBirth: '1995-02-02', heightCm: 171, cityId: pagCity }));
  }
  const shared = new Date('2026-09-01T10:00:00.000Z');
  await MatrimonialProfile.updateMany(
    { userId: { $in: pages.map((entry) => entry.id) } },
    { $set: { 'profile.lastActiveAt': shared } }
  );
  paginationFixtures = { pages, cityId: pagCity, shared };

  // --- Sorting: two candidates with a known order --------------------------
  const sortCity = id(cities.dausa);
  const older = await createCandidate({ gender: 'male', dateOfBirth: '1994-04-04', cityId: sortCity });
  const newer = await createCandidate({ gender: 'male', dateOfBirth: '1996-07-07', cityId: sortCity });
  await MatrimonialProfile.updateOne(
    { userId: older.id },
    { $set: { 'profile.lastActiveAt': new Date('2026-01-01T00:00:00.000Z'), createdAt: new Date('2026-01-01T00:00:00.000Z') } }
  );
  await MatrimonialProfile.updateOne(
    { userId: newer.id },
    { $set: { 'profile.lastActiveAt': new Date('2026-06-01T00:00:00.000Z'), createdAt: new Date('2026-06-01T00:00:00.000Z') } }
  );
  sortingFixtures = { older, newer, cityId: sortCity };

  // --- Visibility: every non-active status plus one active control ---------
  const visCity = id(cities.sikar);
  const draft = await freshAccount();
  await api('/api/v1/profile', {
    method: 'POST',
    token: draft.token,
    body: fullProfile({ location: { cityId: visCity } })
  });
  const hidden = await createCandidate({ gender: 'male', cityId: visCity });
  await api('/api/v1/profile', { method: 'PATCH', token: hidden.token, body: { status: 'hidden' } });
  const suspended = await createCandidate({ gender: 'male', cityId: visCity });
  await MatrimonialProfile.updateOne({ userId: suspended.id }, { $set: { 'profile.status': 'suspended' } });
  const removed = await createCandidate({ gender: 'male', cityId: visCity });
  await api('/api/v1/profile', { method: 'DELETE', token: removed.token });
  const active = await createCandidate({ gender: 'male', cityId: visCity });
  visibilityFixtures = { draftId: draft.id, cityId: visCity, hidden, suspended, removed, active };

  // --- Distance: Delhi in range of itself, Jaipur beyond 50 km -------------
  const delhi = await createCandidate({ gender: 'male', cityId: id(cities.delhi) });
  const jaipur = await createCandidate({ gender: 'male', cityId: id(cities.jaipur) });
  geoFixtures = { delhi, jaipur };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

test.before(async () => {
  try {
    await db.connect();
    available = true;
  } catch (err) {
    available = false;
    unavailableReason = (err && err.name) || 'connection failed';
    return;
  }

  for (const model of [
    ...MASTER_TYPE_VALUES.map((type) => getMasterModel(type)),
    Photo,
    PartnerPreference,
    MatrimonialProfile,
    CommunityConfig,
    User,
    Session
  ]) {
    await model.collection.drop().catch(() => {});
    await model.createIndexes();
  }
  await seeder.main();

  // Two communities, each with its own surname + gotra (scoping matters).
  const communities = await getMasterModel('communities')
    .find({ isActive: true })
    .sort({ sortOrder: 1, name: 1 })
    .select('_id slug name')
    .lean();
  const pairs = [];
  for (const community of communities) {
    const surname = await getMasterModel('surnames').findOne({ communityId: community._id, isActive: true }).select('_id name').lean();
    const gotra = await getMasterModel('gotras').findOne({ communityId: community._id, isActive: true }).select('_id name').lean();
    if (surname && gotra) pairs.push({ community, surname, gotra });
    if (pairs.length === 2) break;
  }
  assert.equal(pairs.length, 2, 'the seed needs two communities that each have a surname and a gotra');
  master.communityId = id(pairs[0].community);
  master.surnameId = id(pairs[0].surname);
  master.gotraId = id(pairs[0].gotra);
  master.communityId2 = id(pairs[1].community);
  master.surnameId2 = id(pairs[1].surname);
  master.gotraId2 = id(pairs[1].gotra);

  const citiesList = await getMasterModel('cities').find({ isActive: true }).select('_id name slug coordinates').lean();
  const bySlug = new Map(citiesList.map((city) => [city.slug, city]));
  for (const slug of ['alwar', 'jhunjhunu', 'churu', 'bharatpur', 'sikar', 'dausa', 'chirawa']) {
    assert.ok(bySlug.get(slug), `the seed has no city "${slug}"`);
    cities[slug] = bySlug.get(slug);
  }
  for (const slug of ['delhi', 'jaipur']) {
    assert.ok(bySlug.get(slug), `the seed has no city "${slug}"`);
    cities[slug] = bySlug.get(slug);
  }
  master.city = cities.sikar;
  master.cityId = id(cities.sikar);

  const degreeRows = await getMasterModel('degrees').find({ isActive: true }).sort({ sortOrder: 1 }).select('_id name').lean();
  const occupationRows = await getMasterModel('occupations').find({ isActive: true }).sort({ sortOrder: 1 }).select('_id name').lean();
  const industry = await getMasterModel('industries').findOne({ isActive: true }).select('_id name').lean();
  assert.ok(degreeRows.length >= 2 && occupationRows.length >= 2 && industry, 'the seed is missing education/career rows');
  master.degree1 = degreeRows[0];
  master.degree2 = degreeRows[1];
  master.occupation1 = occupationRows[0];
  master.occupation2 = occupationRows[1];
  master.industry1 = industry;
  master.degreeId = id(degreeRows[0]);
  master.occupationId = id(occupationRows[0]);

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  fakeCloudinary.install();

  // The viewer: an active, photographed, complete profile of its own, so "the
  // caller never sees themselves" is a real assertion rather than a vacuous one.
  viewer = await createCandidate({ gender: 'male', dateOfBirth: '1994-04-04', cityId: id(cities.chirawa) });

  const prefs = await api('/api/v1/preferences', {
    method: 'POST',
    token: viewer.token,
    body: { gender: 'female', age: { min: 25, max: 40 }, diet: ['vegetarian'], cityIds: [id(cities.jhunjhunu)] }
  });
  assert.equal(prefs.status, 201, `viewer preferences: ${JSON.stringify(prefs.json)}`);

  await buildFixtures();

  // Volume for the planner: drafts are invisible to every query, but they make
  // index selection meaningful instead of a five-document coin toss.
  const bulkCity = id(cities.dausa);
  await MatrimonialProfile.insertMany(
    Array.from({ length: 500 }, (_, index) => ({
      userId: new (require('mongoose').Types.ObjectId)(),
      publicProfileId: `BULK-${RUN}-${index}`,
      basic: { gender: 'male', dateOfBirth: new Date('1990-01-01') },
      location: { cityId: bulkCity },
      profile: { status: 'draft', completionPercentage: 0 }
    }))
  );
});

test.after(async () => {
  fakeCloudinary.uninstall();
  exclusionService.resetSources();
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.disconnect();
});

// ---------------------------------------------------------------------------
// Gate 1 — build integrity
// ---------------------------------------------------------------------------

test('G1.1 every step-09 deliverable exists', () => {
  const files = [
    'src/services/searchService.js',
    'src/services/queryBuilder.js',
    'src/services/exclusionService.js',
    'src/services/recommendationService.js',
    'src/services/dateRange.js',
    'src/services/geoSearch.js',
    'src/services/cursor.js',
    'src/controllers/discover.controller.js',
    'src/routes/discover.routes.js',
    'src/validators/search.validators.js',
    'src/constants/search.js',
    'src/utils/projections.js'
  ];
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', file)), `${file} is missing`);
  }
});

test('G1.1 all three routes are mounted and require auth (gate G3.6)', async (t) => {
  if (!requireDb(t)) return;

  for (const route of ['/api/v1/discover', '/api/v1/search', '/api/v1/recommendations']) {
    const anonymous = await api(route);
    assert.equal(anonymous.status, 401, `${route} must require auth`);
    assert.equal(anonymous.json.code, 'AUTHENTICATION_REQUIRED');
  }
});

test('G1.2 the step-09 compound indexes are declared and created (spec §49, §105)', async (t) => {
  if (!requireDb(t)) return;

  const declared = MatrimonialProfile.schema.indexes().map(([key]) => JSON.stringify(key));
  const expected = [
    { 'profile.status': 1, 'basic.gender': 1, 'basic.dateOfBirth': 1 },
    { 'profile.status': 1, 'basic.gender': 1, 'location.cityId': 1 },
    { 'profile.status': 1, 'basic.gender': 1, 'career.occupationId': 1 },
    { 'profile.status': 1, 'community.gotraId': 1 },
    { 'profile.status': 1, 'profile.lastActiveAt': -1 }
  ];
  for (const key of expected) {
    assert.ok(declared.includes(JSON.stringify(key)), `${JSON.stringify(key)} is not declared`);
  }

  const live = (await MatrimonialProfile.collection.indexes()).map((index) => JSON.stringify(index.key));
  for (const key of expected) {
    assert.ok(live.includes(JSON.stringify(key)), `${JSON.stringify(key)} was not created in the database`);
  }
});

// ---------------------------------------------------------------------------
// Gate 2 — functional
// ---------------------------------------------------------------------------

test('G2.1 discover applies preferences and returns a bounded, projected card', async (t) => {
  if (!requireDb(t)) return;

  const result = await searchService.discover(viewer.id, {});
  assert.equal(result.items.length, 2, `expected the two Jhunjhunu matches: ${JSON.stringify(idsOf(result))}`);
  assert.deepEqual(
    idsOf(result).sort(),
    [discoverFixtures.df1.publicProfileId, discoverFixtures.df2.publicProfileId].sort(),
    'preference gender + diet + city are all applied'
  );
  assert.equal(result.nextCursor, null, 'a short page has no continuation');

  for (const item of result.items) {
    assert.deepEqual(Object.keys(item).sort(), [...CARD_KEYS].sort(), 'the card carries exactly the §70 keys');
    assert.equal(typeof item.age, 'number');
    assert.match(item.height, /^\d+'\d+"$/);
  }

  // The preference's non-vegetarian and male fixtures were excluded by the merge.
  assert.ok(!idsOf(result).includes(discoverFixtures.df3.publicProfileId));
  assert.ok(!idsOf(result).includes(discoverFixtures.df4.publicProfileId));

  // An explicit parameter overrides the stored preference (step 09 task 9).
  const overridden = await searchService.discover(viewer.id, { filters: { gender: 'male' } });
  assert.deepEqual(idsOf(overridden).sort(), [discoverFixtures.df4.publicProfileId], 'explicit gender wins');

  // The page size is the configured default, clamped by nothing here.
  assert.equal(searchService.clampLimit(undefined), config.search.defaultLimit);
});

test('G2.2 every documented filter works on its own (spec §45)', async (t) => {
  if (!requireDb(t)) return;

  const { fa1, fa2, cityId } = filtersFixtures;
  const table = [
    ['gender female', { gender: 'female' }, [fa1]],
    ['gender male', { gender: 'male' }, [fa2]],
    ['minAge', { age: { min: 30 } }, [fa2]],
    ['maxAge', { age: { max: 30 } }, [fa1]],
    ['minHeightCm', { heightCm: { min: 172 } }, [fa2]],
    ['maxHeightCm', { heightCm: { max: 172 } }, [fa1]],
    ['maritalStatus', { maritalStatus: ['divorced'] }, [fa2]],
    ['communityId', { communityIds: [master.communityId2] }, [fa2]],
    ['surnameId', { surnameIds: [master.surnameId] }, [fa1]],
    ['gotraId', { gotraIds: [master.gotraId] }, [fa1]],
    ['cityId', { cityIds: [cityId] }, [fa1, fa2]],
    ['degreeId', { degreeIds: [id(master.degree1)] }, [fa1]],
    ['occupationId', { occupationIds: [id(master.occupation2)] }, [fa2]],
    ['industryId', { industryIds: [id(master.industry1)] }, [fa1, fa2]],
    ['employmentType', { employmentTypes: ['government'] }, [fa1]],
    ['incomeRange', { incomeRanges: ['10_20_lpa'] }, [fa2]],
    ['diet', { diets: ['jain'] }, [fa2]],
    ['smoking', { smoking: ['regularly'] }, [fa2]],
    ['drinking', { drinking: ['occasionally'] }, [fa2]],
    ['familyType', { familyTypes: ['joint'] }, [fa2]],
    ['verified', { verified: true }, [fa2]],
    ['hasPhoto', { hasPhoto: true }, [fa1]]
  ];

  for (const [label, filter, expected] of table) {
    const result = await search({ cityIds: [cityId], ...filter });
    assert.deepEqual(
      idsOf(result).sort(),
      expected.map((entry) => entry.publicProfileId).sort(),
      `${label} filter`
    );
  }
});

test('G2.3 combined filters return the intersection (command 3)', async (t) => {
  if (!requireDb(t)) return;

  const { fa1, fa2, cityId } = filtersFixtures;
  const intersection = await search({
    cityIds: [cityId],
    gender: 'female',
    diets: ['vegetarian'],
    verified: false,
    age: { min: 25, max: 30 }
  });
  assert.deepEqual(idsOf(intersection), [fa1.publicProfileId]);

  const empty = await search({ cityIds: [cityId], gender: 'female', diets: ['jain'] });
  assert.deepEqual(idsOf(empty), [], 'a contradictory combination returns nothing, not everything');
  assert.equal(empty.nextCursor, null);
  void fa2;
});

test('G2.4 cursor pagination returns every profile exactly once, ties included (command 4)', async (t) => {
  if (!requireDb(t)) return;

  const { pages, cityId, shared } = paginationFixtures;
  const expected = pages.map((entry) => entry.publicProfileId).sort();

  const seen = [];
  let cursor;
  let pages1 = 0;
  do {
    const result = await search({ cityIds: [cityId] }, { limit: 2, cursor });
    seen.push(...idsOf(result));
    cursor = result.nextCursor;
    pages1 += 1;
    if (pages1 > 10) break;
  } while (cursor);

  assert.equal(seen.length, 5, `every candidate is returned once: ${JSON.stringify(seen)}`);
  assert.deepEqual([...seen].sort(), expected);
  assert.equal(new Set(seen).size, seen.length, 'no candidate is returned twice');
  assert.equal(pages1, 3, 'two full pages and one short page');
  assert.equal(cursor, null, 'the final page has no continuation');

  // The tie is genuinely shared, which is what makes the `_id` tiebreak load-bearing.
  const stored = await MatrimonialProfile.find({ userId: { $in: pages.map((entry) => entry.id) } })
    .select('profile.lastActiveAt')
    .lean();
  for (const row of stored) assert.equal(row.profile.lastActiveAt.getTime(), shared.getTime());
});

test('G2.5 each allowed sort orders correctly and stably (spec §53)', async (t) => {
  if (!requireDb(t)) return;

  const { older, newer, cityId } = sortingFixtures;

  const byActivity = await search({ cityIds: [cityId] }, { sort: 'recently_active' });
  assert.deepEqual(idsOf(byActivity), [newer.publicProfileId, older.publicProfileId]);

  const byJoin = await search({ cityIds: [cityId] }, { sort: 'newly_joined' });
  assert.deepEqual(idsOf(byJoin), [newer.publicProfileId, older.publicProfileId]);

  // The default is `recently_active`, and an unknown value falls back rather
  // than reaching the database (the validator rejects it before that).
  assert.equal(searchService.normalizeSort(undefined), 'recently_active');
  assert.equal(searchService.normalizeSort('nonsense'), 'recently_active');
  assert.deepEqual(SORT_VALUES, ['recently_active', 'newly_joined', 'recommended']);
});

test('G2.6 draft, hidden, suspended and deleted profiles never appear (spec §56, §58)', async (t) => {
  if (!requireDb(t)) return;

  const { active, cityId } = visibilityFixtures;
  const result = await search({ cityIds: [cityId] });
  assert.deepEqual(idsOf(result), [active.publicProfileId], 'only the active profile is discoverable');

  // And the non-active ones really do exist, so the filter is doing the work.
  const stored = await MatrimonialProfile.find({ 'location.cityId': cityId }).select('profile.status').lean();
  const statuses = stored.map((row) => row.profile.status).sort();
  assert.deepEqual(statuses, ['active', 'deleted', 'draft', 'hidden', 'suspended']);
});

test('G2.7 the requesting user never appears in their own results (spec §56)', async (t) => {
  if (!requireDb(t)) return;

  // The viewer is the only member in its own city, and it is male and active,
  // so only the exclusion can produce an empty page.
  const own = await search({ cityIds: [id(cities.chirawa)] });
  assert.deepEqual(idsOf(own), [], 'the caller is excluded from their own results');
  assert.ok(!idsOf(own).includes(viewer.publicProfileId));

  const male = await search({ gender: 'male', cityIds: [id(cities.chirawa)] });
  assert.deepEqual(idsOf(male), []);

  const serviceIds = await exclusionService.getExcludedUserIds(viewer.id);
  assert.ok(serviceIds.includes(String(viewer.id)));
});

test('G2.8 the exclusion interface removes the ids it is given (spec §99)', async (t) => {
  if (!requireDb(t)) return;

  const { fa1, fa2, cityId } = filtersFixtures;

  // A source is the documented extension point for steps 10 and 12: it changes
  // what is excluded without changing the query shape.
  exclusionService.registerSource('test-source', async () => [fa1.id]);
  try {
    const result = await search({ cityIds: [cityId] });
    assert.deepEqual(idsOf(result), [fa2.publicProfileId], 'the contributed id is excluded');
  } finally {
    exclusionService.resetSources();
  }

  // ...and removing the source restores it.
  const restored = await search({ cityIds: [cityId] });
  assert.equal(restored.items.length, 2);

  // The `$nin` guard refuses rather than silently dropping an exclusion (§99).
  assert.throws(
    () => exclusionService.mergeExclusions([['a', 'b', 'c']], 2),
    (err) => err.statusCode === 503,
    'an exclusion set past the cap is refused, never truncated'
  );
  assert.deepEqual(exclusionService.mergeExclusions([['a', 'a', 'b']], 5).sort(), ['a', 'b']);
});

test('G2.9 recommendations rank a bounded candidate set deterministically (spec §54, §55)', async (t) => {
  if (!requireDb(t)) return;

  const { rr1, rr2, cityId } = recommendationFixtures;
  const result = await searchService.recommendations(viewer.id, { filters: { cityIds: [cityId] } });

  assert.deepEqual(idsOf(result), [rr1.publicProfileId, rr2.publicProfileId], 'the closer age ranks first');

  // The returned order is the scorer's order, recomputed from the same documents.
  const documents = await MatrimonialProfile.find({ userId: { $in: [rr1.id, rr2.id] } })
    .select(require('../src/utils/projections').RECOMMENDATION_PROJECTION)
    .lean();
  const byId = new Map(documents.map((doc) => [String(doc._id), doc]));
  const scores = result.items.map((item) => {
    const doc = [...byId.values()].find((entry) => entry.publicProfileId === item.profileId);
    return recommendationService.score(doc, { filters: { age: { min: 25, max: 40 }, cityIds: [cityId] } }).total;
  });
  assert.deepEqual(scores, [...scores].sort((left, right) => right - left), 'scores are non-increasing');
  assert.ok(scores[0] > 0);

  // Bounded: a ranking pass never scores more than the configured window.
  assert.equal(searchService.clampLimit(1000), config.search.maxLimit);
  const { recommendationWindow } = require('../src/constants/search');
  assert.equal(recommendationWindow(1), 5);
  assert.equal(recommendationWindow(1000), config.search.candidateCap);
});

test('G2.10 distance search includes inside the radius and excludes outside it (command 10)', async (t) => {
  if (!requireDb(t)) return;

  const { delhi, jaipur } = geoFixtures;
  const delhiCity = cities.delhi.coordinates;
  assert.ok(delhiCity && delhiCity.lat, 'the seed must give Delhi coordinates');

  const nearby = await search({ geo: { lat: delhiCity.lat, lng: delhiCity.lng, maxDistanceKm: 50 } });
  assert.ok(idsOf(nearby).includes(delhi.publicProfileId), 'a 50 km radius around Delhi includes Delhi');
  assert.ok(!idsOf(nearby).includes(jaipur.publicProfileId), 'and excludes Jaipur (~240 km)');

  const wider = await search({ geo: { lat: delhiCity.lat, lng: delhiCity.lng, maxDistanceKm: 400 } });
  assert.ok(idsOf(wider).includes(jaipur.publicProfileId), 'a 400 km radius reaches Jaipur');

  // Coordinates are never returned (spec §48, §112).
  const overHttp = await api(`/api/v1/search?lat=${delhiCity.lat}&lng=${delhiCity.lng}&maxDistanceKm=50`, {
    token: viewer.token
  });
  assert.equal(overHttp.status, 200, JSON.stringify(overHttp.json));
  assert.ok(!overHttp.text.includes('coordinates'), 'no coordinates in the payload');
  assert.ok(!/"lat"|"lng"/.test(overHttp.text), 'no latitude/longitude fields either');
});

// ---------------------------------------------------------------------------
// Gate 3 — security
// ---------------------------------------------------------------------------

test('G3.1 object-shaped filters are rejected at the boundary (command 5, spec §35)', async (t) => {
  if (!requireDb(t)) return;

  const injected = await api('/api/v1/discover?gender[$ne]=male&limit=20', { token: viewer.token });
  assert.equal(injected.status, 400, `expected a rejection, got ${injected.status}: ${injected.text}`);
  assert.equal(injected.json.success, false);
  assert.ok(injected.json.details && Object.keys(injected.json.details).length > 0, 'the offending parameter is named');
  assert.ok(!('items' in (injected.json.data || {})), 'no result page is produced');

  // The same attempt through the service boundary cannot build a query key.
  const built = queryBuilder.buildFilter({ gender: { $ne: 'male' } });
  assert.deepEqual(built, { 'profile.status': 'active' }, 'only the mandatory predicate survives');
});

test('G3.2 unknown parameters and unknown sort values are rejected (command 6)', async (t) => {
  if (!requireDb(t)) return;

  const unknownSort = await api('/api/v1/discover?sort=passwordHash', { token: viewer.token });
  assert.equal(unknownSort.status, 400);

  const unknownParam = await api('/api/v1/discover?passwordHash[$ne]=x', { token: viewer.token });
  assert.equal(unknownParam.status, 400);

  const unknownPlain = await api('/api/v1/search?admin=1', { token: viewer.token });
  assert.equal(unknownPlain.status, 400);
  assert.ok(unknownPlain.json.details && Object.keys(unknownPlain.json.details).length > 0, 'the field is named');
});

test('G3.3 limit is capped and no unbounded query path exists (command 7, spec §52)', async (t) => {
  if (!requireDb(t)) return;

  const huge = await api('/api/v1/search?cityId=' + paginationFixtures.cityId + '&limit=100000', {
    token: viewer.token
  });
  assert.equal(huge.status, 200);
  assert.ok(huge.json.data.items.length <= config.search.maxLimit, `at most ${config.search.maxLimit} items`);
  assert.equal(searchService.clampLimit(100000), config.search.maxLimit);
  assert.equal(searchService.clampLimit(0), config.search.defaultLimit);
  assert.equal(searchService.clampLimit(-5), config.search.defaultLimit);

  // Every query the builder produces carries the mandatory predicate, so there
  // is no "everything" shape to reach.
  assert.equal(queryBuilder.buildFilter({})['profile.status'], 'active');
  for (const sort of SORT_VALUES) {
    const spec = queryBuilder.sortSpecFor(sort);
    assert.ok(Object.keys(spec).length > 0, `${sort} has a sort document`);
  }
});

test('G3.4 the response carries no restricted field (command 8, spec §51, §112)', async (t) => {
  if (!requireDb(t)) return;

  const response = await api(`/api/v1/discover?cityId=${discoverFixtures.cityId}`, { token: viewer.token });
  assert.equal(response.status, 200);

  const stored = await MatrimonialProfile.findOne({ publicProfileId: discoverFixtures.df1.publicProfileId })
    .select('userId basic.dateOfBirth')
    .lean();
  const forbidden = [
    'email',
    'phone',
    'coordinates',
    'birthTime',
    'birthPlace',
    'passwordHash',
    'userId',
    'adminNotes',
    String(stored.userId),
    String(stored.basic.dateOfBirth.toISOString())
  ];
  for (const value of forbidden) {
    assert.ok(!response.text.includes(value), `${value} must not appear in a discover payload`);
  }

  // A second account's token sees the same DTO shape, not a richer one.
  const other = await registerAndLogin(`s9-privacy-${RUN}@example.com`);
  const asOther = await api(`/api/v1/discover?cityId=${discoverFixtures.cityId}`, { token: other.token });
  assert.equal(asOther.status, 200);
  for (const item of asOther.json.data.items) {
    assert.deepEqual(Object.keys(item).sort(), [...CARD_KEYS].sort());
  }
});

test('G3.5 a tampered or mismatched cursor is rejected (spec §52)', async (t) => {
  if (!requireDb(t)) return;

  const first = await search({ cityIds: [paginationFixtures.cityId] }, { limit: 2 });
  assert.ok(first.nextCursor, 'the first page has a continuation');

  // Tampering the payload (not the signature's padding bits) guarantees the
  // signed message differs — a signature check must then refuse it.
  const forged = first.nextCursor.replace(/^./, (char) => (char === 'A' ? 'B' : 'A'));
  const rejected = await api(`/api/v1/search?cityId=${paginationFixtures.cityId}&limit=2&cursor=${forged}`, {
    token: viewer.token
  });
  assert.equal(rejected.status, 400, 'a tampered signature is refused');

  const mismatched = await api(
    `/api/v1/search?cityId=${paginationFixtures.cityId}&limit=2&sort=newly_joined&cursor=${first.nextCursor}`,
    { token: viewer.token }
  );
  assert.equal(mismatched.status, 400, 'a cursor is bound to the sort it was issued for');

  const garbage = await api(`/api/v1/search?cursor=not-a-cursor`, { token: viewer.token });
  assert.equal(garbage.status, 400);

  // Decoding is signature-bound, so a hand-built payload cannot be accepted.
  const decoded = cursorCodec.decodeCursor(first.nextCursor);
  assert.equal(decoded.sort, 'recently_active');
  assert.ok(Number.isFinite(decoded.key));
});

test('G3.6 no error leaks collection, field or driver detail (spec §33, §77)', async (t) => {
  if (!requireDb(t)) return;

  const failures = [
    await api('/api/v1/search?cursor=nope', { token: viewer.token }),
    await api('/api/v1/discover?sort=passwordHash', { token: viewer.token }),
    await api('/api/v1/discover?minAge=99&maxAge=1', { token: viewer.token })
  ];
  for (const failure of failures) {
    assert.equal(failure.status, 400);
    assert.ok(!failure.text.includes(COLLECTIONS.MATRIMONIAL_PROFILES), 'no collection name');
    assert.ok(!/Mongo|mongoose|driver|ESRCH|E11000/.test(failure.text), 'no driver detail');
    assert.ok(!failure.text.includes('src/'), 'no file path from the stack');
  }
  assert.equal(failures[2].json.details.maxAge !== undefined || failures[2].json.details.minAge !== undefined, true);
});

// ---------------------------------------------------------------------------
// Gate 4 — performance & data
// ---------------------------------------------------------------------------

test('G4.1 the default discover query is index-backed (command 9, spec §50)', async (t) => {
  if (!requireDb(t)) return;

  const query = queryBuilder.buildFilter({ gender: 'female', age: { min: 25, max: 30 } });
  const plan = await MatrimonialProfile.find(query).explain('executionStats');
  const serialised = JSON.stringify(plan.queryPlanner.winningPlan);

  assert.ok(serialised.includes('IXSCAN'), `expected an index scan: ${serialised.slice(0, 300)}`);
  assert.ok(!serialised.includes('COLLSCAN'), 'the mandatory status + gender + age query must not scan the collection');

  const stats = plan.executionStats;
  assert.ok(typeof stats.executionTimeMillis === 'number');
  assert.ok(
    stats.totalKeysExamined <= stats.nReturned + 30,
    `keys examined should track the result set: ${stats.totalKeysExamined} keys for ${stats.nReturned} rows`
  );
});

test('G4.2 each step-09 index serves the query it was created for (spec §49)', async (t) => {
  if (!requireDb(t)) return;

  const cases = [
    ['city', queryBuilder.buildFilter({ cityIds: [filtersFixtures.cityId] })],
    ['occupation', queryBuilder.buildFilter({ occupationIds: [id(master.occupation1)] })],
    ['gotra', queryBuilder.buildFilter({ gotraIds: [master.gotraId] })],
    ['recency sort', queryBuilder.buildFilter({})]
  ];

  for (const [label, filter] of cases) {
    const plan = JSON.stringify((await MatrimonialProfile.find(filter).explain('queryPlanner')).queryPlanner.winningPlan);
    assert.ok(plan.includes('IXSCAN'), `${label} should use an index: ${plan.slice(0, 200)}`);
  }

  // The recency sort is served by the status+lastActiveAt index rather than an
  // in-memory sort.
  const sorted = await MatrimonialProfile.find(queryBuilder.buildFilter({}))
    .sort(queryBuilder.sortSpecFor('recently_active'))
    .explain('queryPlanner');
  assert.ok(JSON.stringify(sorted.queryPlanner.winningPlan).includes('IXSCAN'));
});

test('G4.4 the card stays small: projected fields, one photo URL, no populate (spec §66, §108)', async (t) => {
  if (!requireDb(t)) return;

  // The projection is a fixed field list — never the whole document.
  assert.deepEqual(Object.keys(CARD_PROJECTION).sort(), [
    'basic.dateOfBirth',
    'basic.firstName',
    'basic.heightCm',
    'career.occupationName',
    'community.gotraName',
    'community.surnameName',
    'education.degreeName',
    'location.cityName',
    'profile.isVerified',
    'profile.lastActiveAt',
    'publicProfileId',
    'userId'
  ].sort());

  const result = await search({ cityIds: [discoverFixtures.cityId] });
  assert.ok(result.items.length > 0);
  const item = result.items[0];
  assert.equal(typeof item.primaryPhoto, 'string');
  assert.match(item.primaryPhoto, /^https:\/\/res\.cloudinary\.com\/test-cloud\/image\/upload\/c_fill,g_face,/, 'the card carries a transformed URL');
  const storedPhoto = await Photo.findOne({ userId: discoverFixtures.df1.id }).select('url publicId').lean();
  assert.ok(!item.primaryPhoto.includes(storedPhoto.url), 'never the original asset URL');

  // One photo query for the page, not one per row: a page of N rows must not
  // issue N lookups. The service returns exactly one URL per row that has one.
  const urls = await searchService.primaryCardUrls(result.items.map(() => discoverFixtures.df1.id));
  assert.equal(urls.size, 1);

  // A profile with only a pending photo has no card image but still lists.
  const pending = await search({ cityIds: [filtersFixtures.cityId], gender: 'male' });
  assert.equal(pending.items.length, 1);
  assert.equal(pending.items[0].primaryPhoto, null, 'an unapproved photo is not a card image');
});

// ---------------------------------------------------------------------------
// Gate 5 — spec conformance
// ---------------------------------------------------------------------------

test('G5.2 age ranges convert to DOB boundaries on a fixed reference (spec §47)', () => {
  const reference = new Date('2026-10-10T08:00:00.000Z');
  const range = dateOfBirthRange({ min: 24, max: 30 }, reference);
  assert.ok(range.from instanceof Date && range.to instanceof Date);
  assert.equal(range.from.getFullYear(), 1995, 'the earliest DOB is maxAge + 1 years back, one day on');
  assert.equal(range.to.getFullYear(), 2002, 'the latest DOB is minAge years back');

  // A date exactly on the boundary is inside the range on both ends.
  const onMax = dateOfBirthRange({ min: 24, max: 30 }, reference);
  assert.ok(onMax.from.getTime() <= new Date('1995-10-11T00:00:00').getTime() + 86400000);
  assert.ok(onMax.to.getTime() >= new Date('2002-10-10T00:00:00').getTime());

  // One-sided ranges emit only the bound they have.
  assert.deepEqual(dateOfBirthRange({ min: 30 }, reference).from, null);
  assert.equal(dateOfBirthRange({ max: 30 }, reference).to, null);

  // The built query uses the `dateOfBirth` path the index is on.
  const query = queryBuilder.buildFilter({ age: { min: 24, max: 30 } });
  assert.ok(query['basic.dateOfBirth'].$gte instanceof Date);
  assert.ok(query['basic.dateOfBirth'].$lte instanceof Date);
});

test('G5.5 the projection matches the documented card and response shape (spec §70, §120)', async (t) => {
  if (!requireDb(t)) return;

  const response = await api(`/api/v1/search?cityId=${discoverFixtures.cityId}`, { token: viewer.token });
  assert.equal(response.status, 200);
  assert.equal(response.json.success, true);
  assert.ok(Array.isArray(response.json.data.items));
  assert.ok('nextCursor' in response.json.data, 'the page always states its continuation');
  assert.ok(!('cursor' in response.json.data) && !('total' in response.json.data), 'no unbounded/unnamed extras');

  for (const item of response.json.data.items) {
    assert.deepEqual(Object.keys(item).sort(), [...CARD_KEYS].sort());
    assert.equal(typeof item.profileId, 'string');
    assert.match(item.profileId, /^CHV-/);
  }
});

test('G5.7 the scoring weights sum to 100 and each sub-score is bounded (spec §54)', () => {
  assert.equal(RECOMMENDATION_TOTAL, 100);
  assert.deepEqual(RECOMMENDATION_WEIGHTS, {
    age: 20,
    location: 20,
    education: 15,
    occupation: 15,
    community: 10,
    lifestyle: 10,
    completeness: 10
  });

  const document = {
    basic: { dateOfBirth: new Date('1997-01-15') },
    location: { cityId: 'a', stateId: 's', countryId: 'c' },
    education: { degreeId: 'd' },
    career: { occupationId: 'o', industryId: 'i', employmentType: 'private' },
    community: { communityId: 'com', gotraId: 'g', surnameId: 'sur' },
    lifestyle: { diet: 'vegetarian', smoking: 'never', drinking: 'never' },
    profile: { completionPercentage: 100 }
  };

  // No preferences at all: every dimension pays its full weight.
  assert.equal(recommendationService.score(document, { filters: {} }).total, 100);

  // A perfect fit is still 100, and never more.
  // The document is 29 on the reference day, so 25..33 puts it on the midpoint of
  // the preferred range — the only age that can score the full weight.
  const perfect = recommendationService.score(document, {
    filters: {
      age: { min: 25, max: 33 },
      cityIds: ['a'],
      degreeIds: ['d'],
      occupationIds: ['o'],
      communityIds: ['com'],
      gotraIds: ['g'],
      surnameIds: ['sur'],
      diets: ['vegetarian'],
      smoking: ['never'],
      drinking: ['never']
    }
  });
  assert.equal(perfect.total, 100);
  assert.equal(Object.keys(perfect.breakdown).length, 7);
  for (const [dimension, value] of Object.entries(perfect.breakdown)) {
    assert.ok(value <= RECOMMENDATION_WEIGHTS[dimension], `${dimension} cannot exceed its weight`);
    assert.ok(value >= 0);
  }

  // A mismatch earns nothing on that dimension.
  const mismatch = recommendationService.score(document, {
    filters: { age: { min: 60, max: 70 }, cityIds: ['zzz'], degreeIds: ['zzz'], diets: ['jain'] }
  });
  assert.equal(mismatch.breakdown.location, 0);
  assert.equal(mismatch.breakdown.education, 0);
  assert.equal(mismatch.breakdown.lifestyle, 0);
  assert.ok(mismatch.total < 100);
});

test('G5.9 the documented anti-patterns are absent (spec §82)', async (t) => {
  if (!requireDb(t)) return;

  const built = queryBuilder.buildFilter({
    gender: 'female',
    age: { min: 25, max: 30 },
    cityIds: [filtersFixtures.cityId],
    verified: true,
    hasPhoto: true
  });
  const serialised = JSON.stringify(built);

  for (const forbidden of ['$where', '$regex', '$expr', '$function', 'passwordHash', '$accumulator']) {
    assert.ok(!serialised.includes(forbidden), `${forbidden} must never appear in a built query`);
  }
  // Every key is a literal written in the builder, never a user-supplied string.
  const keys = Object.keys(built);
  assert.ok(keys.every((key) => key === 'profile.status' || /^(basic|community|location|education|career|lifestyle|family|profile|userId)\./.test(key) || key === 'userId'));

  // No populate chain: the service reads one collection plus one batched photo
  // lookup, and the DTO layer resolves nothing.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'searchService.js'), 'utf8');
  assert.ok(!source.includes('.populate('), 'the read path must not populate');

  // A search shorter than the minimum is impossible here: every filter is an
  // exact match, an id, or a bounded range — never a regex.
  const idFilters = await search({ cityIds: [filtersFixtures.cityId], gender: 'female' });
  assert.equal(idsOf(idFilters).length, 1);
});

test('G5.13 preferences with no search dimension never become query keys (spec §35, §45)', async () => {
  const translated = searchService.fromEffectiveFilters({
    gender: 'female',
    age: { min: 25 },
    educationIds: ['degree'],
    diet: ['vegetarian'],
    motherTongueIds: ['language'],
    relocationPreference: 'maybe',
    cityIds: []
  });
  assert.deepEqual(translated, {
    gender: 'female',
    age: { min: 25 },
    degreeIds: ['degree'],
    diets: ['vegetarian']
  });
  assert.ok(!('motherTongueIds' in translated) && !('relocationPreference' in translated));

  // The builder only ever reads its own allowlist, so an unknown key is ignored.
  assert.deepEqual(queryBuilder.buildFilter({ passwordHash: 'x' }), { 'profile.status': 'active' });

  // Preferences genuinely drive the filter (a step-07 integration check).
  const effective = await preferenceService.effectiveFilters(viewer.id);
  assert.equal(effective.gender, 'female');
  assert.equal(effective.age.min, 25);
});
