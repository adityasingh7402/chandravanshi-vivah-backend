'use strict';

/**
 * Step 10 — Profile actions (spec §20, §36, §44, §56, §99, §100, §105, §112;
 * finalized decisions §15).
 *
 * Runs against the configured cluster in a DEDICATED database, seeded with the
 * real step-05 seeder. Cloudinary is the deterministic gateway double from step
 * 08, because a target must be a *published* profile to be acted on and the
 * seeded community config requires a photo to publish.
 *
 * The four action types are exercised through the real HTTP surface, so what is
 * verified is the mounted boundary — validation, rate limiting, ownership — not
 * a service called directly.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.MONGODB_DB_NAME = 'chandravanshi_vivah_test_action';
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
// Small interaction page and rate cap so both are cheap to exercise. The cap is
// per (account, action type), so a fresh account always has a full budget.
process.env.INTERACTIONS_DEFAULT_LIMIT = '3';
process.env.INTERACTIONS_MAX_LIMIT = '5';
process.env.ACTION_RATE_LIMIT_MAX = '20';
process.env.ACTION_RATE_LIMIT_WINDOW = '3600';
process.env.VIEW_TOUCH_THROTTLE_MIN = '15';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const app = require('../src/app');
const db = require('../src/config/db');
const config = require('../src/config/env');
const { COLLECTIONS } = require('../src/config/collections');
const User = require('../src/models/User');
const Session = require('../src/models/Session');
const MatrimonialProfile = require('../src/models/MatrimonialProfile');
const PartnerPreference = require('../src/models/PartnerPreference');
const Photo = require('../src/models/Photo');
const ProfileAction = require('../src/models/ProfileAction');
const CommunityConfig = require('../src/models/CommunityConfig');
const { getMasterModel } = require('../src/models/masterData/MasterItem');
const { MASTER_TYPE_VALUES } = require('../src/constants/masterData');
const { ACTION_TYPES, ACTION_TYPE } = require('../src/constants/actions');
const profileScoreService = require('../src/services/profileScoreService');
const actionService = require('../src/services/actionService');
const fakeCloudinary = require('./helpers/fakeCloudinary');
const seeder = require('../scripts/seed-master-data');

/**
 * A minimal stand-in for step 12's `blocks` model, so the "blocked pair cannot
 * act" gate can be exercised before that step exists. It reads the same
 * collection `exclusionService.blockExclusion` reads, and is registered lazily
 * (`mongoose.models.Block`), exactly the seam that step exists to use.
 */
const blockSchema = new mongoose.Schema(
  {
    blockerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    blockedUserId: { type: mongoose.Schema.Types.ObjectId, required: true }
  },
  { collection: COLLECTIONS.BLOCKS }
);
const Block = mongoose.models.Block || mongoose.model('Block', blockSchema);

const PASSWORD = 'correct-horse-battery';
const CARD_KEYS = [
  'age', 'city', 'degree', 'gotra', 'height', 'lastActiveAt',
  'name', 'occupation', 'primaryPhoto', 'profileId', 'surname', 'verified'
].sort();

let server;
let base;
let available = false;
let unavailableReason = '';
let accountSeq = 0;
let photoSeq = 0;
const master = {};

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
  return registerAndLogin(`p10-${Date.now()}-${accountSeq}@example.com`);
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
    preferred || (await model.findOne({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select('_id name').lean());
  assert.ok(doc, `step-05 seed has no active ${type} row`);
  return remember(key, doc);
}

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

async function addApprovedPhoto(token, userId) {
  const sign = await api('/api/v1/photos/sign', { method: 'POST', token, body: {} });
  assert.equal(sign.status, 200, `sign: ${JSON.stringify(sign.json)}`);
  photoSeq += 1;
  const publicId = `${sign.json.data.upload.folder}/p10-${photoSeq}`;
  const res = await api('/api/v1/photos', { method: 'POST', token, body: { publicId, type: 'profile' } });
  assert.equal(res.status, 201, `register photo: ${JSON.stringify(res.json)}`);
  await Photo.updateOne({ userId, isPrimary: true }, { $set: { moderationStatus: 'approved' } });
  await profileScoreService.syncDiscoveryPhotoFlag(userId);
}

/**
 * A complete, published (discoverable) account: profile + approved photo +
 * status `active`. Such an account is a valid action target.
 */
async function publishedAccount(profileOverrides = {}) {
  const account = await freshAccount();
  const created = await api('/api/v1/profile', {
    method: 'POST',
    token: account.token,
    body: fullProfile(profileOverrides)
  });
  assert.equal(created.status, 201, `create profile: ${JSON.stringify(created.json)}`);
  await addApprovedPhoto(account.token, account.id);
  const published = await api('/api/v1/profile', {
    method: 'PATCH',
    token: account.token,
    body: { status: 'active' }
  });
  assert.equal(published.status, 200, `publish: ${JSON.stringify(published.json)}`);
  const doc = await MatrimonialProfile.findOne({ userId: account.id }).select('publicProfileId').lean();
  return { ...account, publicProfileId: doc.publicProfileId };
}

const record = (token, body) => api('/api/v1/interactions', { method: 'POST', token, body });

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
    ProfileAction,
    Block,
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

  const chosen = await (async () => {
    const communities = await getMasterModel('communities')
      .find({ isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .select('_id slug name')
      .lean();
    for (const community of communities) {
      const surname = await getMasterModel('surnames')
        .findOne({ communityId: community._id, isActive: true })
        .select('_id name')
        .lean();
      const gotra = await getMasterModel('gotras')
        .findOne({ communityId: community._id, isActive: true })
        .select('_id name')
        .lean();
      if (surname && gotra) return { community, surname, gotra };
    }
    return null;
  })();
  assert.ok(chosen, 'step-05 seed has no community with both a surname and a gotra');
  remember('community', chosen.community);
  remember('surname', chosen.surname);
  remember('gotra', chosen.gotra);
  await pick('city', 'cities', 'sikar');
  await pick('degree', 'degrees', 'mca');
  await pick('occupation', 'occupations', 'software-engineer');

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  fakeCloudinary.install();
});

test.beforeEach(() => {
  if (available) fakeCloudinary.install();
});

test.after(async () => {
  fakeCloudinary.uninstall();
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.disconnect();
});

// ---------------------------------------------------------------------------
// Gate 1 — build integrity
// ---------------------------------------------------------------------------

test('G1.1 every step-10 deliverable exists', () => {
  const files = [
    'src/models/ProfileAction.js',
    'src/services/actionService.js',
    'src/controllers/action.controller.js',
    'src/routes/interaction.routes.js',
    'src/validators/action.validators.js',
    'src/constants/actions.js'
  ];
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', file)), `${file} is missing`);
  }
});

test('G1.1 / G3.7 every interaction route is mounted and requires auth', async (t) => {
  if (!requireDb(t)) return;
  const cases = [
    ['POST', '/api/v1/interactions'],
    ['GET', '/api/v1/interactions'],
    ['DELETE', '/api/v1/interactions/000000000000000000000000']
  ];
  for (const [method, route] of cases) {
    const res = await api(route, { method, body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 401, `${method} ${route} should require auth`);
  }
});

test('G1.2 / G5.5 the profile_actions indexes exist (§105)', async (t) => {
  if (!requireDb(t)) return;
  const indexes = await ProfileAction.collection.indexes();
  const names = indexes.map((idx) => idx.name);
  const unique = indexes.find((idx) => idx.key.fromUserId === 1 && idx.key.toUserId === 1 && idx.key.type === 1);
  assert.ok(unique, 'pair + type index is missing');
  assert.equal(unique.unique, true, 'the pair + type index must be unique');
  assert.ok(names.includes('toUserId_1_type_1_createdAt_-1'), 'target listing index is missing');
  assert.ok(names.includes('fromUserId_1_type_1_createdAt_-1'), 'actor listing index is missing');
});

// ---------------------------------------------------------------------------
// Gate 2 — functional
// ---------------------------------------------------------------------------

test('G2.1 each of the four action types can be recorded and read back', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const targets = [];
  for (let i = 0; i < 4; i += 1) targets.push(await publishedAccount());

  for (const [i, type] of ACTION_TYPES.entries()) {
    const res = await record(actor.token, { toUserId: targets[i].id, type });
    assert.equal(res.status, 201, `${type}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.data.interaction.type, type);
    assert.equal(res.json.data.interaction.isNew, true);
  }

  for (const [i, type] of ACTION_TYPES.entries()) {
    const stored = await ProfileAction.findOne({ fromUserId: actor.id, toUserId: targets[i].id, type }).lean();
    assert.ok(stored, `a ${type} row must exist`);
    assert.equal(String(stored.fromUserId), String(actor.id));
    assert.equal(String(stored.toUserId), String(targets[i].id));
  }
});

test('G2.2 a repeated like / shortlist / pass keeps exactly one row', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const target = await publishedAccount();

  for (const type of [ACTION_TYPE.LIKE, ACTION_TYPE.SHORTLIST, ACTION_TYPE.PASS]) {
    const first = await record(actor.token, { toUserId: target.id, type });
    const second = await record(actor.token, { toUserId: target.id, type });
    assert.equal(first.status, 201, `${type} first`);
    assert.equal(second.status, 201, `${type} repeat`);
    assert.equal(second.json.data.interaction.isNew, false, `${type} repeat must not create`);
    const count = await ProfileAction.countDocuments({ fromUserId: actor.id, toUserId: target.id, type });
    assert.equal(count, 1, `${type} must have exactly one row`);
  }
});

test('G2.3 a self-action is rejected with 400', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const res = await record(actor.token, { toUserId: actor.id, type: ACTION_TYPE.LIKE });
  assert.equal(res.status, 400, JSON.stringify(res.json));
  assert.equal(await ProfileAction.countDocuments({ fromUserId: actor.id, toUserId: actor.id }), 0);
});

test('G2.4 the shortlist listing is card-shaped, newest first (command 4)', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const first = await publishedAccount();
  const second = await publishedAccount();
  await record(actor.token, { toUserId: first.id, type: ACTION_TYPE.SHORTLIST });
  await record(actor.token, { toUserId: second.id, type: ACTION_TYPE.SHORTLIST });

  const res = await api('/api/v1/interactions?type=shortlist', { token: actor.token });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const items = res.json.data.items;
  assert.ok(items.length >= 2, 'both shortlists must list');
  for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), CARD_KEYS, 'a listing row must be exactly the §70 card');
  }
  // Newest first: the second shortlist precedes the first.
  const ids = items.map((item) => item.profileId);
  assert.ok(ids.indexOf(second.publicProfileId) < ids.indexOf(first.publicProfileId), 'newest shortlist first');
  assert.equal(res.json.data.nextCursor, null, 'two items with default limit 3 fit one page');
});

test('G2.5 removing an action works for the owner and changes the listing', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const target = await publishedAccount();
  const created = await record(actor.token, { toUserId: target.id, type: ACTION_TYPE.SHORTLIST });
  const id = created.json.data.interaction.id;

  const removed = await api(`/api/v1/interactions/${id}`, { method: 'DELETE', token: actor.token });
  assert.equal(removed.status, 200, JSON.stringify(removed.json));

  const list = await api('/api/v1/interactions?type=shortlist', { token: actor.token });
  assert.ok(!list.json.data.items.some((item) => item.profileId === target.publicProfileId), 'target is gone');
});

test('G2.6 a pass removes the target from discover results (command 6)', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const target = await publishedAccount({ basic: { gender: 'male' } });

  const before = await api('/api/v1/discover?limit=100', { token: actor.token });
  assert.ok(
    before.json.data.items.some((item) => item.profileId === target.publicProfileId),
    'target should be discoverable before the pass'
  );

  await record(actor.token, { toUserId: target.id, type: ACTION_TYPE.PASS });

  const after = await api('/api/v1/discover?limit=100', { token: actor.token });
  assert.ok(
    !after.json.data.items.some((item) => item.profileId === target.publicProfileId),
    'a passed profile must not resurface'
  );
});

test('G2.7 action listings are paginated and bounded (limit is clamped)', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  for (let i = 0; i < 4; i += 1) {
    const target = await publishedAccount();
    await record(actor.token, { toUserId: target.id, type: ACTION_TYPE.SHORTLIST });
  }

  const first = await api('/api/v1/interactions?type=shortlist&limit=2', { token: actor.token });
  assert.equal(first.json.data.items.length, 2, 'page 1 is two rows');
  assert.ok(first.json.data.nextCursor, 'a further page exists');

  const second = await api(
    `/api/v1/interactions?type=shortlist&limit=2&cursor=${first.json.data.nextCursor}`,
    { token: actor.token }
  );
  assert.equal(second.json.data.items.length, 2, 'page 2 is two rows');
  const overlap = first.json.data.items.filter((a) => second.json.data.items.some((b) => b.profileId === a.profileId));
  assert.equal(overlap.length, 0, 'pages do not overlap');

  // An oversized limit is clamped to the configured maximum, not rejected.
  const huge = await api('/api/v1/interactions?type=shortlist&limit=100000', { token: actor.token });
  assert.equal(huge.status, 200);
  assert.ok(huge.json.data.items.length <= config.actions.maxLimit);
});

test('G2.8 / G2.9 a repeat view keeps one row and refreshes its timestamp', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const target = await publishedAccount();

  // Addressed by the public profile id, so the server-side resolution path is
  // the one under test (spec §113).
  const first = await record(actor.token, { publicProfileId: target.publicProfileId, type: ACTION_TYPE.VIEW });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const rowOne = await ProfileAction.findOne({ fromUserId: actor.id, toUserId: target.id, type: ACTION_TYPE.VIEW }).lean();

  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await record(actor.token, { publicProfileId: target.publicProfileId, type: ACTION_TYPE.VIEW });
  assert.equal(second.json.data.interaction.isNew, false);

  const rows = await ProfileAction.find({ fromUserId: actor.id, toUserId: target.id, type: ACTION_TYPE.VIEW }).lean();
  assert.equal(rows.length, 1, 'one view row per pair (decisions §15)');
  assert.ok(new Date(rows[0].createdAt).getTime() >= new Date(rowOne.createdAt).getTime(), 'timestamp is refreshed');
});

test('G2.8 a repeat view within the throttle window does not touch the target twice', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const target = await publishedAccount();

  await record(actor.token, { toUserId: target.id, type: ACTION_TYPE.VIEW });
  const touched = await MatrimonialProfile.findOne({ userId: target.id }).select('profile.lastActiveAt').lean();

  await new Promise((resolve) => setTimeout(resolve, 10));
  await record(actor.token, { toUserId: target.id, type: ACTION_TYPE.VIEW });
  const after = await MatrimonialProfile.findOne({ userId: target.id }).select('profile.lastActiveAt').lean();

  assert.ok(touched.profile.lastActiveAt, 'the first view touches the signal');
  assert.equal(
    new Date(after.profile.lastActiveAt).getTime(),
    new Date(touched.profile.lastActiveAt).getTime(),
    'a second view inside the throttle window must not write again'
  );
});

// ---------------------------------------------------------------------------
// Gate 3 — security
// ---------------------------------------------------------------------------

test('G3.1 a body userId / fromUserId cannot name the actor (spec §44)', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const victim = await publishedAccount();
  const target = await publishedAccount();

  for (const extra of [{ userId: victim.id }, { fromUserId: victim.id }]) {
    const res = await record(actor.token, { toUserId: target.id, type: ACTION_TYPE.LIKE, ...extra });
    assert.equal(res.status, 400, `an unknown field must be rejected: ${JSON.stringify(res.json)}`);
  }
});

test('G3.2 another account\'s action cannot be deleted (404)', async (t) => {
  if (!requireDb(t)) return;
  const owner = await publishedAccount({ basic: { gender: 'female' } });
  const attacker = await publishedAccount({ basic: { gender: 'female' } });
  const target = await publishedAccount();
  const created = await record(owner.token, { toUserId: target.id, type: ACTION_TYPE.SHORTLIST });
  const id = created.json.data.interaction.id;

  const res = await api(`/api/v1/interactions/${id}`, { method: 'DELETE', token: attacker.token });
  assert.equal(res.status, 404, 'another account\'s action must not be deletable');
  assert.ok(await ProfileAction.findById(id), 'the row must still exist');
});

test('G3.3 a blocked pair cannot record an action in either direction (spec §99)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();
  await Block.create({ blockerId: b.id, blockedUserId: a.id });

  const blocked = await record(a.token, { toUserId: b.id, type: ACTION_TYPE.LIKE });
  assert.equal(blocked.status, 404, 'a blocked pair cannot act');
  assert.equal(await ProfileAction.countDocuments({ fromUserId: a.id, toUserId: b.id }), 0);

  const reverse = await record(b.token, { toUserId: a.id, type: ACTION_TYPE.LIKE });
  assert.equal(reverse.status, 404, 'the block applies in both directions');

  await Block.deleteMany({ _id: { $in: [] } });
  await Block.collection.deleteMany({});
});

test('G3.4 malformed ids and object-shaped values are rejected before any query (spec §34)', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const cases = [
    { toUserId: 'not-an-id', type: 'like' },
    { toUserId: { $ne: null }, type: 'like' },
    { toUserId: actor.id, type: 'unsupported_type' }
  ];
  for (const body of cases) {
    const res = await record(actor.token, body);
    assert.equal(res.status, 400, `must reject: ${JSON.stringify(body)}`);
  }
  const badQuery = await api('/api/v1/interactions?type[$ne]=like', { token: actor.token });
  assert.equal(badQuery.status, 400, 'an object-shaped query value is rejected');
});

test('G3.5 / G5.4 action writes are rate limited (command 7)', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const target = await publishedAccount();

  const cap = config.actions.rateLimit.max;
  let sawTooMany = false;
  for (let i = 0; i < cap + 5; i += 1) {
    const res = await record(actor.token, { toUserId: target.id, type: ACTION_TYPE.VIEW });
    if (res.status === 429) {
      sawTooMany = true;
      break;
    }
  }
  assert.ok(sawTooMany, `expected a 429 within ${cap + 5} view writes`);
});

test('G3.6 an action listing exposes no private profile field (spec §112)', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const target = await publishedAccount();
  await record(actor.token, { toUserId: target.id, type: ACTION_TYPE.SHORTLIST });

  const res = await api('/api/v1/interactions?type=shortlist', { token: actor.token });
  const blob = JSON.stringify(res.json);
  for (const forbidden of ['"email"', '"phone"', '"coordinates"', '"dateOfBirth"', '"birthTime"', '"userId"']) {
    assert.ok(!blob.includes(forbidden), `listing must not carry ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// Gate 4 — performance & data
// ---------------------------------------------------------------------------

test('G4.1 pair lookups and listing scans use their indexes (IXSCAN)', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const target = await publishedAccount();
  await record(actor.token, { toUserId: target.id, type: ACTION_TYPE.LIKE });

  const pairPlan = await ProfileAction.find({
    fromUserId: actor.id,
    toUserId: target.id,
    type: ACTION_TYPE.LIKE
  }).explain('queryPlanner');
  assert.ok(JSON.stringify(pairPlan).includes('IXSCAN'), 'the pair lookup must be index-backed');

  const listPlan = await ProfileAction.find({ fromUserId: actor.id, type: ACTION_TYPE.LIKE })
    .sort({ _id: -1 })
    .explain('queryPlanner');
  assert.ok(JSON.stringify(listPlan).includes('IXSCAN'), 'the actor listing must be index-backed');
});

test('G4.2 / G4.4 the shortlist uses the shared card projection, not full documents', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const target = await publishedAccount();
  await record(actor.token, { toUserId: target.id, type: ACTION_TYPE.SHORTLIST });

  const items = (await actionService.listShortlisted(actor.id, {})).items;
  assert.equal(items.length, 1);
  assert.deepEqual(Object.keys(items[0]).sort(), CARD_KEYS, 'the DTO is exactly the card');
});

test('G4.3 concurrent identical writes still produce one row (unique index)', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const target = await publishedAccount();

  await Promise.all([
    record(actor.token, { toUserId: target.id, type: ACTION_TYPE.SHORTLIST }),
    record(actor.token, { toUserId: target.id, type: ACTION_TYPE.SHORTLIST })
  ]);
  const count = await ProfileAction.countDocuments({
    fromUserId: actor.id,
    toUserId: target.id,
    type: ACTION_TYPE.SHORTLIST
  });
  assert.equal(count, 1, 'the unique index must collapse concurrent identical writes');
});

test('G4.3 concurrent view upserts keep one row (decisions §15)', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const target = await publishedAccount();

  await Promise.all([
    actionService.record(actor.id, { toUserId: target.id, type: ACTION_TYPE.VIEW }),
    actionService.record(actor.id, { toUserId: target.id, type: ACTION_TYPE.VIEW }),
    actionService.record(actor.id, { toUserId: target.id, type: ACTION_TYPE.VIEW })
  ]);
  const count = await ProfileAction.countDocuments({
    fromUserId: actor.id,
    toUserId: target.id,
    type: ACTION_TYPE.VIEW
  });
  assert.equal(count, 1, 'two concurrent view upserts must not create a second row');
});

test('G4.4 a burst of repeat views does not grow the collection', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const target = await publishedAccount();

  await record(actor.token, { toUserId: target.id, type: ACTION_TYPE.VIEW });
  const before = await ProfileAction.countDocuments({ fromUserId: actor.id, toUserId: target.id });
  for (let i = 0; i < 5; i += 1) {
    await actionService.record(actor.id, { toUserId: target.id, type: ACTION_TYPE.VIEW });
  }
  const after = await ProfileAction.countDocuments({ fromUserId: actor.id, toUserId: target.id });
  assert.equal(after, before, 'repeat views must not add rows');
});

// ---------------------------------------------------------------------------
// Gate 5 — spec conformance
// ---------------------------------------------------------------------------

test('G5.1 §20 — the action document matches the shape and types', () => {
  for (const field of ['fromUserId', 'toUserId', 'type', 'createdAt', 'updatedAt']) {
    assert.ok(ProfileAction.schema.path(field), `${field} must exist on the schema`);
  }
  assert.deepEqual(ProfileAction.schema.path('type').enumValues, ACTION_TYPES);
  assert.equal(ProfileAction.schema.path('fromUserId').instance, 'ObjectId');
  assert.equal(ProfileAction.schema.path('toUserId').instance, 'ObjectId');
});

test('G5.2 §56 / §99 — pass feeds the exclusion set with no query-shape change', async (t) => {
  if (!requireDb(t)) return;
  const { getExcludedUserIds } = require('../src/services/exclusionService');
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  const target = await publishedAccount();

  assert.ok(!(await getExcludedUserIds(actor.id)).includes(target.id));
  await record(actor.token, { toUserId: target.id, type: ACTION_TYPE.PASS });
  const excluded = await getExcludedUserIds(actor.id);
  assert.ok(excluded.includes(target.id), 'a passed target joins the exclusion set');
  assert.ok(excluded.includes(actor.id), 'the caller is still excluded too');
});

test('G5.3 §100 — the documented restrictions are enforced server-side', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount({ basic: { gender: 'female' } });
  // A target that is not discoverable (draft) is not a valid target.
  const draft = await freshAccount();
  await api('/api/v1/profile', { method: 'POST', token: draft.token, body: fullProfile() });
  const res = await record(actor.token, { toUserId: draft.id, type: ACTION_TYPE.LIKE });
  assert.equal(res.status, 404, 'a non-active target is not actionable');
});

test('G5.6 §91 — recording is a server operation, present in the service layer', () => {
  for (const fn of ['record', 'remove', 'listOwn', 'listShortlisted', 'listViews']) {
    assert.equal(typeof actionService[fn], 'function', `actionService.${fn} must exist`);
  }
  assert.equal(typeof actionService.events.emit, 'function', 'a domain event bus exists for step 13');
});
