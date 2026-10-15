'use strict';

/**
 * Step 12 — Block & Report (spec §22, §23, §24, §36, §44, §56, §91, §99, §101,
 * §105, §112; finalized decisions §7).
 *
 * Runs against the configured cluster in a DEDICATED database, seeded with the
 * real step-05 seeder. Cloudinary is the deterministic gateway double from step
 * 08, because a *target* must be a published profile to be contacted and the
 * seeded community config requires a photo to publish.
 *
 * The block effects are exercised through the real HTTP surface wherever a route
 * exists (block, unblock, list, report, own reports) and at the service boundary
 * where they do not — discovery exclusion, interest refusal and `canChat` are
 * properties of *other* steps' services, which is exactly what this step rewires.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.MONGODB_DB_NAME = 'chandravanshi_vivah_test_safety';
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
// Small lists, small caps and small write budgets so every bound is cheap to
// exercise. The block/report limiter buckets are per account, and every test uses
// fresh accounts, so one test's flood is never another test's problem.
process.env.BLOCKS_DEFAULT_LIMIT = '2';
process.env.BLOCKS_MAX_LIMIT = '3';
process.env.REPORTS_DEFAULT_LIMIT = '2';
process.env.REPORTS_MAX_LIMIT = '3';
process.env.BLOCK_REASON_MAX_LEN = '40';
process.env.REPORT_DESCRIPTION_MAX_LEN = '60';
process.env.REPORT_EVIDENCE_MAX_ITEMS = '2';
process.env.REPORT_EVIDENCE_MAX_LEN = '40';
process.env.BLOCK_RATE_LIMIT_MAX = '20';
process.env.BLOCK_RATE_LIMIT_WINDOW = '3600';
process.env.REPORT_RATE_LIMIT_MAX = '20';
process.env.REPORT_RATE_LIMIT_WINDOW = '3600';

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
const ProfileAction = require('../src/models/ProfileAction');
const Connection = require('../src/models/Connection');
const Block = require('../src/models/Block');
const Report = require('../src/models/Report');
const CommunityConfig = require('../src/models/CommunityConfig');
const { getMasterModel } = require('../src/models/masterData/MasterItem');
const { MASTER_TYPE_VALUES } = require('../src/constants/masterData');
const {
  REPORT_CATEGORIES,
  REPORT_STATUSES,
  REPORT_STATUS,
  ACTIVE_REPORT_STATUSES
} = require('../src/constants/safety');
const { CONNECTION_STATUS } = require('../src/constants/connection');
const profileScoreService = require('../src/services/profileScoreService');
const blockService = require('../src/services/blockService');
const reportService = require('../src/services/reportService');
const connectionService = require('../src/services/connectionService');
const connectionPolicy = require('../src/services/connectionPolicy');
const exclusionService = require('../src/services/exclusionService');
const fakeCloudinary = require('./helpers/fakeCloudinary');
const seeder = require('../scripts/seed-master-data');

const PASSWORD = 'correct-horse-battery';

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
  return registerAndLogin(`p12-${Date.now()}-${accountSeq}@example.com`);
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
  const publicId = `${sign.json.data.upload.folder}/p12-${photoSeq}`;
  const res = await api('/api/v1/photos', { method: 'POST', token, body: { publicId, type: 'profile' } });
  assert.equal(res.status, 201, `register photo: ${JSON.stringify(res.json)}`);
  await Photo.updateOne({ userId, isPrimary: true }, { $set: { moderationStatus: 'approved' } });
  await profileScoreService.syncDiscoveryPhotoFlag(userId);
}

/** A complete, published (discoverable) account. */
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

const blockUser = (token, body) => api('/api/v1/blocks', { method: 'POST', token, body });
const unblockUser = (token, target) => api(`/api/v1/blocks/${target}`, { method: 'DELETE', token });
const blockList = (token, query = '') => api(`/api/v1/blocks${query}`, { token });
const reportUser = (token, body) => api('/api/v1/reports', { method: 'POST', token, body });
const myReports = (token, query = '') => api(`/api/v1/reports/me${query}`, { token });
const sendInterest = (token, body) => api('/api/v1/connections', { method: 'POST', token, body });

/** The accounts a member would find through search, as public profile ids. */
async function searchIds(token, gender) {
  const res = await api(`/api/v1/search?gender=${gender}&limit=100`, { token });
  assert.equal(res.status, 200, `search: ${JSON.stringify(res.json)}`);
  return (res.json.data.items || []).map((item) => item.profileId);
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

  for (const model of [
    ...MASTER_TYPE_VALUES.map((type) => getMasterModel(type)),
    Report,
    Block,
    Connection,
    ProfileAction,
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

test('G1.1 every step-12 deliverable exists', () => {
  const files = [
    'src/models/Block.js',
    'src/models/Report.js',
    'src/services/blockService.js',
    'src/services/reportService.js',
    'src/controllers/block.controller.js',
    'src/controllers/report.controller.js',
    'src/routes/block.routes.js',
    'src/routes/report.routes.js',
    'src/validators/safety.validators.js',
    'src/constants/safety.js'
  ];
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', file)), `${file} is missing`);
  }
});

test('G1.1 / G3.8 every block and report route is mounted and requires auth', async (t) => {
  if (!requireDb(t)) return;
  const cases = [
    ['POST', '/api/v1/blocks'],
    ['GET', '/api/v1/blocks'],
    ['DELETE', '/api/v1/blocks/000000000000000000000000'],
    ['POST', '/api/v1/reports'],
    ['GET', '/api/v1/reports/me']
  ];
  for (const [method, route] of cases) {
    const res = await api(route, { method, body: method === 'GET' || method === 'DELETE' ? undefined : {} });
    assert.equal(res.status, 401, `${method} ${route} should require auth`);
  }
});

test('G1.2 / G5.6 §105 — the block and report indexes exist', async (t) => {
  if (!requireDb(t)) return;
  const blockIndexes = await Block.collection.indexes();
  const blockNames = blockIndexes.map((idx) => idx.name);
  assert.ok(blockNames.includes('blockerId_1'), 'blockerId index is missing');
  assert.ok(blockNames.includes('blockedUserId_1'), 'blockedUserId index is missing');
  const pair = blockIndexes.find((idx) => idx.key.blockerId === 1 && idx.key.blockedUserId === 1);
  assert.ok(pair, 'the block pair index is missing');
  assert.equal(pair.unique, true, 'the block pair index must be unique (idempotent blocking)');

  const reportNames = (await Report.collection.indexes()).map((idx) => idx.name);
  for (const expected of ['reportedUserId_1_status_1', 'reporterId_1_createdAt_-1', 'status_1_createdAt_-1']) {
    assert.ok(reportNames.includes(expected), `${expected} is missing`);
  }
});

// ---------------------------------------------------------------------------
// Gate 2 — functional
// ---------------------------------------------------------------------------

test('G2.1 blocking is idempotent, listable and revocable (commands 1, 2)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();

  const first = await blockUser(a.token, { userId: b.id, reason: 'Not interested' });
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.json.data.block.isNew, true);
  assert.equal(first.json.data.block.reason, 'Not interested');

  const again = await blockUser(a.token, { userId: b.id, reason: 'Changed my mind about the note' });
  assert.equal(again.status, 201, 'a repeat block is not an error');
  assert.equal(again.json.data.block.isNew, false, 'a repeat block creates nothing');
  assert.equal(await Block.countDocuments({ blockerId: a.id, blockedUserId: b.id }), 1, 'exactly one row');
  const stored = await Block.findOne({ blockerId: a.id, blockedUserId: b.id }).lean();
  assert.equal(stored.reason, 'Not interested', 're-blocking does not rewrite the original note');

  const list = await blockList(a.token);
  assert.equal(list.status, 200, JSON.stringify(list.json));
  assert.equal(list.json.data.items.length, 1);
  assert.equal(list.json.data.items[0].profileId, b.publicProfileId);
  assert.equal(list.json.data.items[0].reason, 'Not interested');
  assert.ok(!JSON.stringify(list.json).includes(b.id), 'the block list never echoes an account id');

  const removed = await unblockUser(a.token, b.id);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.equal(await Block.countDocuments({ blockerId: a.id, blockedUserId: b.id }), 0);
  const gone = await unblockUser(a.token, b.id);
  assert.equal(gone.status, 404, 'a second unblock has nothing to remove');
});

test('G2.1 unblocking accepts the public profile id too', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();
  await blockUser(a.token, { publicProfileId: b.publicProfileId });
  const removed = await unblockUser(a.token, b.publicProfileId);
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
});

test('G2.1 / G3.1 a self-block is refused with 400 (command 3)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const res = await blockUser(a.token, { userId: a.id });
  assert.equal(res.status, 400, JSON.stringify(res.json));
  assert.equal(await Block.countDocuments({ blockerId: a.id, blockedUserId: a.id }), 0);
});

test('G2.2 a block removes the pair from discovery in both directions (command 4)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female', firstName: 'Aarohi' } });
  const b = await publishedAccount({ basic: { gender: 'male', firstName: 'Vikram' } });

  assert.ok((await searchIds(a.token, 'male')).includes(b.publicProfileId), 'b is discoverable before the block');
  assert.ok((await searchIds(b.token, 'female')).includes(a.publicProfileId), 'a is discoverable before the block');

  await blockUser(a.token, { userId: b.id });

  assert.ok(
    !(await searchIds(a.token, 'male')).includes(b.publicProfileId),
    'the blocker stops seeing the blocked account'
  );
  assert.ok(
    !(await searchIds(b.token, 'female')).includes(a.publicProfileId),
    'the blocked account stops seeing the blocker'
  );
});

test('G2.3 a block prevents interest send and respond in both directions (command 5)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();

  // An interest sent before the block is pending...
  const pending = await sendInterest(a.token, { toUserId: b.id });
  assert.equal(pending.status, 201);
  const pendingId = pending.json.data.connection.id;

  await blockUser(a.token, { userId: b.id });

  const fromBlocker = await sendInterest(a.token, { toUserId: b.id });
  assert.equal(fromBlocker.status, 404, 'the blocker cannot send');
  const fromBlocked = await sendInterest(b.token, { toUserId: a.id });
  assert.equal(fromBlocked.status, 404, 'the blocked account cannot send either');

  const accepted = await api(`/api/v1/connections/${pendingId}`, {
    method: 'PATCH',
    token: b.token,
    body: { action: 'accept' }
  });
  assert.equal(accepted.status, 404, 'a blocked pair cannot respond');
  const unchanged = await Connection.findById(pendingId).lean();
  assert.equal(unchanged.status, CONNECTION_STATUS.PENDING, 'the row is untouched');
});

test('G2.4 a block makes canChat false, derived rather than written (command 6, decisions §7)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();
  const created = await sendInterest(a.token, { toUserId: b.id });
  const id = created.json.data.connection.id;
  await api(`/api/v1/connections/${id}`, { method: 'PATCH', token: b.token, body: { action: 'accept' } });
  assert.equal(await connectionPolicy.canChat(a.id, b.id), true, 'an accepted match grants chat');

  // Insert the block row DIRECTLY, bypassing the service's close-for-access write.
  // `canChat` must still be false: the gate is derived from the block row, not
  // dependent on the connection status having been rewritten.
  await Block.collection.insertOne({
    blockerId: new mongoose.Types.ObjectId(String(b.id)),
    blockedUserId: new mongoose.Types.ObjectId(String(a.id)),
    reason: null,
    createdAt: new Date(),
    updatedAt: new Date()
  });

  assert.equal(await connectionPolicy.canChat(a.id, b.id), false, 'canChat is false the moment the block exists');
  assert.equal(await connectionPolicy.canChat(b.id, a.id), false, 'in both directions');
  const access = await connectionPolicy.chatAccess(a.id, b.id);
  assert.equal(access.canChat, false);
  assert.equal(access.reason, 'blocked');

  const stillAccepted = await Connection.findById(id).lean();
  assert.equal(stillAccepted.status, CONNECTION_STATUS.ACCEPTED, 'the check never had to touch the row');
});

test('G2.4 the block service also closes an accepted connection for access (decisions §7)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();
  const created = await sendInterest(a.token, { toUserId: b.id });
  const id = created.json.data.connection.id;
  await api(`/api/v1/connections/${id}`, { method: 'PATCH', token: b.token, body: { action: 'accept' } });

  await blockUser(a.token, { userId: b.id });

  const row = await Connection.findById(id).lean();
  assert.equal(row.status, CONNECTION_STATUS.CLOSED, 'the stored record reflects the closure');
  assert.equal(await connectionPolicy.canChat(a.id, b.id), false);

  // The seam itself: idempotent, and it reports "nothing to close" rather than
  // failing when the pair has no accepted connection left.
  assert.equal(await connectionService.closeAcceptedForPair(a.id, b.id), false);
  const outsider = await publishedAccount();
  assert.equal(await connectionService.closeAcceptedForPair(a.id, outsider.id), false, 'no accepted pair, no error');
});

test('G2.5 a block suppresses notifications — the step-13 hook is in place (spec §22, §24)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();

  assert.equal(await blockService.canNotify(a.id, b.id), true, 'unblocked pairs may be notified');
  assert.equal(typeof reportService.notificationsAllowed, 'function', 'both surfaces answer the same question');

  await blockService.block(a.id, { userId: b.id });
  assert.equal(await blockService.canNotify(a.id, b.id), false, 'a blocked pair may never be notified');
  assert.equal(await blockService.canNotify(b.id, a.id), false, 'in both directions');
  assert.equal(await reportService.notificationsAllowed(a.id, b.id), false, 'through the shared helper');
});

test('G2.6 unblocking restores interaction without restoring the relationship', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();
  const created = await sendInterest(a.token, { toUserId: b.id });
  const id = created.json.data.connection.id;
  await api(`/api/v1/connections/${id}`, { method: 'PATCH', token: b.token, body: { action: 'accept' } });

  await blockUser(a.token, { userId: b.id });
  await unblockUser(a.token, b.id);

  assert.ok((await searchIds(a.token, 'male')).includes(b.publicProfileId), 'discovery is restored');
  assert.equal(await connectionPolicy.canChat(a.id, b.id), false, 'the closed connection is not reopened');

  const resent = await sendInterest(a.token, { toUserId: b.id });
  assert.equal(resent.status, 201, 'a new interest is possible again');
  assert.notEqual(resent.json.data.connection.id, id, 'and it is a new row');
  const earlier = await Connection.findById(id).lean();
  assert.equal(earlier.status, CONNECTION_STATUS.CLOSED, 'the earlier row stays closed');
});

test('G2.7 a report can be filed for every category and lists as open (command 7)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();

  for (const category of REPORT_CATEGORIES) {
    const res = await reportUser(a.token, {
      reportedUserId: b.id,
      category,
      description: `Reason: ${category}`,
      evidence: ['photo-id-1']
    });
    assert.equal(res.status, 201, `${category}: ${JSON.stringify(res.json)}`);
    assert.equal(res.json.data.report.category, category);
    assert.equal(res.json.data.report.status, REPORT_STATUS.OPEN);
    assert.deepEqual(res.json.data.report.evidence, ['photo-id-1']);
  }

  // The page size is clamped by `REPORTS_MAX_LIMIT`, so the whole history is
  // collected by following the cursor — which is also what exercises pagination.
  const collected = [];
  let cursor = null;
  for (let i = 0; i < REPORT_CATEGORIES.length + 1; i += 1) {
    const page = await myReports(a.token, cursor ? `?limit=3&cursor=${cursor}` : '?limit=3');
    assert.equal(page.status, 200, JSON.stringify(page.json));
    collected.push(...page.json.data.items);
    cursor = page.json.data.nextCursor;
    if (!cursor) break;
  }
  assert.equal(collected.length, REPORT_CATEGORIES.length, 'every report is in the caller\'s own list');
  assert.ok(collected.every((item) => item.status === REPORT_STATUS.OPEN));
  assert.ok(collected.every((item) => item.reported.profileId === b.publicProfileId));
  assert.equal(new Set(collected.map((item) => item.category)).size, REPORT_CATEGORIES.length, 'one per category');

  const filtered = await myReports(a.token, `?status=${REPORT_STATUS.OPEN}&limit=100`);
  assert.equal(filtered.json.data.items.length, config.safety.reports.maxLimit, 'an oversized page is clamped');
  assert.ok(filtered.json.data.items.every((item) => item.status === REPORT_STATUS.OPEN), 'the status filter works');
  const none = await myReports(a.token, `?status=${REPORT_STATUS.DISMISSED}`);
  assert.equal(none.json.data.items.length, 0, 'no dismissed reports exist yet');
});

test('G2.8 / G3.2 a self-report is refused, and the response carries no reporter (commands 8, 9)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();

  const self = await reportUser(a.token, { reportedUserId: a.id, category: 'spam' });
  assert.equal(self.status, 400, JSON.stringify(self.json));
  assert.equal(await Report.countDocuments({ reporterId: a.id, reportedUserId: a.id }), 0);

  const bad = await reportUser(a.token, { reportedUserId: b.id, category: 'nonsense' });
  assert.equal(bad.status, 400, 'an invalid category is refused');

  await reportUser(a.token, { reportedUserId: b.id, category: 'harassment' });

  // The reported account's own view must never reveal the reporter (spec §112).
  const theirs = await myReports(b.token);
  assert.equal(theirs.status, 200);
  assert.equal(theirs.json.data.items.length, 0, 'b sees none of a\'s reports');
  assert.ok(!theirs.text.includes(a.id), 'and never a\'s account id');
  assert.ok(!/"reporterId"|"reviewedBy"|"reviewedAt"/.test(theirs.text), 'no admin or reporter field is exposed');
});

test('G2.9 the duplicate rule refuses a repeated active report and allows one after dismissal', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();

  const first = await reportUser(a.token, { reportedUserId: b.id, category: 'spam' });
  assert.equal(first.status, 201);
  const duplicate = await reportUser(a.token, { reportedUserId: b.id, category: 'spam' });
  assert.equal(duplicate.status, 409, 'a second active report for the same pair and category is refused');
  assert.equal(await Report.countDocuments({ reporterId: a.id, reportedUserId: b.id, category: 'spam' }), 1);

  // A different category is a different case.
  const other = await reportUser(a.token, { reportedUserId: b.id, category: 'fraud' });
  assert.equal(other.status, 201, 'a different category is allowed');

  // Step 16 owns the transition, so the terminal status is set directly here.
  await Report.updateOne({ _id: first.json.data.report.id }, { $set: { status: REPORT_STATUS.DISMISSED } });
  const afterDismiss = await reportUser(a.token, { reportedUserId: b.id, category: 'spam' });
  assert.equal(afterDismiss.status, 201, 'once the case is terminal the pair may be reported again');
  assert.deepEqual(ACTIVE_REPORT_STATUSES, [REPORT_STATUS.OPEN, REPORT_STATUS.REVIEWING]);
});

// ---------------------------------------------------------------------------
// Gate 3 — security
// ---------------------------------------------------------------------------

test('G3.1 a body identity field cannot name the actor or file on another account', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const victim = await publishedAccount({ basic: { gender: 'female' } });
  const target = await publishedAccount();

  for (const extra of [{ blockerId: victim.id }, { reporterId: victim.id }]) {
    const blockRes = await blockUser(a.token, { userId: target.id, ...extra });
    assert.equal(blockRes.status, 400, `unknown field must be rejected: ${JSON.stringify(blockRes.json)}`);
    const reportRes = await reportUser(a.token, {
      reportedUserId: target.id,
      category: 'spam',
      ...extra
    });
    assert.equal(reportRes.status, 400, `unknown field must be rejected: ${JSON.stringify(reportRes.json)}`);
  }
  assert.equal(await Block.countDocuments({ blockerId: victim.id }), 0);
  assert.equal(await Report.countDocuments({ reporterId: victim.id }), 0);
});

test('G3.2 another account cannot block on the caller\'s behalf, and owns their own blocks', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();
  const attacker = await publishedAccount({ basic: { gender: 'female' } });

  await blockUser(a.token, { userId: b.id });
  const attackerUnblock = await unblockUser(attacker.token, b.id);
  assert.equal(attackerUnblock.status, 404, 'another account\'s block cannot be removed');
  assert.equal(await Block.countDocuments({ blockerId: a.id, blockedUserId: b.id }), 1, 'the row survives');

  const attackerList = await blockList(attacker.token);
  assert.equal(attackerList.json.data.items.length, 0, 'a block list is never another account\'s');
});

test('G3.3 a user route cannot write moderation state (command 10)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();

  const cases = [
    { status: REPORT_STATUS.DISMISSED },
    { reviewedBy: a.id },
    { reviewedAt: new Date().toISOString() }
  ];
  for (const extra of cases) {
    const res = await reportUser(a.token, { reportedUserId: b.id, category: 'spam', ...extra });
    assert.equal(res.status, 400, `must reject: ${JSON.stringify(extra)}`);
  }

  const created = await reportUser(a.token, { reportedUserId: b.id, category: 'spam' });
  assert.equal(created.status, 201);
  const stored = await Report.findById(created.json.data.report.id).lean();
  assert.equal(stored.status, REPORT_STATUS.OPEN, 'a new report is always open');
  assert.equal(stored.reviewedAt, null, 'and unreviewed');
});

test('G3.4 evidence accepts only bounded strings (spec §23, §34)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();
  const cap = config.safety.report.evidenceMaxItems;

  const objects = await reportUser(a.token, {
    reportedUserId: b.id,
    category: 'spam',
    evidence: [{ url: 'https://example.com/x.png' }]
  });
  assert.equal(objects.status, 400, 'an object in evidence is refused');
  const tooMany = await reportUser(a.token, {
    reportedUserId: b.id,
    category: 'spam',
    evidence: Array.from({ length: cap + 1 }, (_, i) => `ref-${i}`)
  });
  assert.equal(tooMany.status, 400, 'an oversized evidence array is refused');
  const tooLong = await reportUser(a.token, {
    reportedUserId: b.id,
    category: 'spam',
    evidence: ['x'.repeat(config.safety.report.evidenceMaxLen + 1)]
  });
  assert.equal(tooLong.status, 400, 'an over-long evidence entry is refused');

  const ok = await reportUser(a.token, {
    reportedUserId: b.id,
    category: 'spam',
    evidence: Array.from({ length: cap }, (_, i) => `ref-${i}`)
  });
  assert.equal(ok.status, 201, 'exactly at the cap is allowed');
  assert.deepEqual(ok.json.data.report.evidence, Array.from({ length: cap }, (_, i) => `ref-${i}`));
});

test('G3.5 free text is capped and cannot inject markup', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();

  const longReason = await blockUser(a.token, { userId: b.id, reason: 'x'.repeat(config.safety.blockReasonMaxLen + 1) });
  assert.equal(longReason.status, 400, 'an over-long block reason is refused');
  const markupReason = await blockUser(a.token, { userId: b.id, reason: '<b>because</b>' });
  assert.equal(markupReason.status, 400, 'markup in a reason is refused');

  const longDescription = await reportUser(a.token, {
    reportedUserId: b.id,
    category: 'spam',
    description: 'x'.repeat(config.safety.report.descriptionMaxLen + 1)
  });
  assert.equal(longDescription.status, 400, 'an over-long description is refused');
  const markupDescription = await reportUser(a.token, {
    reportedUserId: b.id,
    category: 'spam',
    description: '<script>alert(1)</script>'
  });
  assert.equal(markupDescription.status, 400, 'markup in a description is refused');

  const okReason = await blockUser(a.token, { userId: b.id, reason: 'Not interested' });
  assert.equal(okReason.status, 201);
  const okDescription = await reportUser(a.token, { reportedUserId: b.id, category: 'spam', description: 'Spam messages' });
  assert.equal(okDescription.status, 201);
  assert.equal(okDescription.json.data.report.description, 'Spam messages', 'the text is trimmed, not rewritten');
});

test('G3.6 malformed ids and object-shaped values are rejected before any query (spec §34)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();

  const cases = [
    () => blockUser(a.token, { userId: 'not-an-id' }),
    () => blockUser(a.token, { userId: { $ne: null } }),
    () => blockUser(a.token, { userId: b.id, publicProfileId: b.publicProfileId }),
    () => reportUser(a.token, { reportedUserId: 'not-an-id', category: 'spam' }),
    () => reportUser(a.token, { reportedUserId: { $ne: null }, category: 'spam' })
  ];
  for (const run of cases) {
    const res = await run();
    assert.equal(res.status, 400, `must reject: ${JSON.stringify(res.json)}`);
  }

  const badParam = await unblockUser(a.token, 'not-an-id');
  assert.equal(badParam.status, 400, 'a malformed path id is a 400, not a cast 500');
  const badQuery = await blockList(a.token, '?limit[$ne]=2');
  assert.equal(badQuery.status, 400, 'an object-shaped query value is rejected');
  const badStatus = await myReports(a.token, '?status[$ne]=open');
  assert.equal(badStatus.status, 400);
});

test('G3.7 / G5.5 block and report writes are rate limited (spec §36)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();

  const blockCap = config.safety.blockRateLimit.max;
  let sawBlockLimit = false;
  for (let i = 0; i < blockCap + 5; i += 1) {
    const res = await blockUser(a.token, { userId: b.id });
    if (res.status === 429) {
      sawBlockLimit = true;
      break;
    }
  }
  assert.ok(sawBlockLimit, `expected a 429 within ${blockCap + 5} blocks`);

  const reporter = await publishedAccount({ basic: { gender: 'female' } });
  const reportCap = config.safety.reportRateLimit.max;
  let sawReportLimit = false;
  for (let i = 0; i < reportCap + 5; i += 1) {
    const res = await reportUser(reporter.token, { reportedUserId: b.id, category: 'spam' });
    if (res.status === 429) {
      sawReportLimit = true;
      break;
    }
  }
  assert.ok(sawReportLimit, `expected a 429 within ${reportCap + 5} reports`);
});

// ---------------------------------------------------------------------------
// Gate 4 — performance & data
// ---------------------------------------------------------------------------

test('G4.1 the exclusion lookup is index-backed and discover still plans IXSCAN', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();
  await blockUser(a.token, { userId: b.id });

  const plan = await Block.find({ $or: [{ blockerId: a.id }, { blockedUserId: a.id }] }).explain('queryPlanner');
  assert.ok(JSON.stringify(plan).includes('IXSCAN'), 'the bilateral exclusion query must be index-backed');

  const discoverPlan = await MatrimonialProfile.find({
    'profile.status': 'active',
    userId: { $nin: [a.id, b.id] }
  }).explain('queryPlanner');
  assert.ok(JSON.stringify(discoverPlan).includes('IXSCAN'), 'the discover predicate is unchanged');
});

test('G4.2 both lists are paginated and bounded', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const targets = [await publishedAccount(), await publishedAccount(), await publishedAccount()];
  for (const target of targets) await blockUser(a.token, { userId: target.id });

  const page1 = await blockList(a.token, '?limit=2');
  assert.equal(page1.json.data.items.length, 2, 'page 1 is two rows');
  assert.ok(page1.json.data.nextCursor, 'a further page exists');
  const page2 = await blockList(a.token, `?limit=2&cursor=${page1.json.data.nextCursor}`);
  const overlap = page1.json.data.items.filter((x) => page2.json.data.items.some((y) => y.id === x.id));
  assert.equal(overlap.length, 0, 'pages do not overlap');

  const hugeBlocks = await blockList(a.token, '?limit=100000');
  assert.equal(hugeBlocks.status, 200);
  assert.ok(hugeBlocks.json.data.items.length <= config.safety.blocks.maxLimit, 'the block page is clamped');

  const reporter = await publishedAccount({ basic: { gender: 'female' } });
  for (const [index, target] of targets.entries()) {
    await reportUser(reporter.token, { reportedUserId: target.id, category: REPORT_CATEGORIES[index] });
  }
  const reportsPage = await myReports(reporter.token, '?limit=2');
  assert.equal(reportsPage.json.data.items.length, 2);
  assert.ok(reportsPage.json.data.nextCursor, 'a further report page exists');
  const hugeReports = await myReports(reporter.token, '?limit=100000');
  assert.ok(hugeReports.json.data.items.length <= config.safety.reports.maxLimit, 'the report page is clamped');
});

test('G4.3 a large block set is returned whole and guarded against the $nin cap (spec §99)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const targets = [];
  for (let i = 0; i < 5; i += 1) targets.push(await publishedAccount());

  for (const target of targets) await blockService.block(a.id, { userId: target.id });

  const excluded = await exclusionService.getExcludedUserIds(a.id);
  assert.ok(excluded.includes(a.id), 'the caller is still excluded');
  for (const target of targets) {
    assert.ok(excluded.includes(target.id), 'every blocked account joins the exclusion set');
  }
  assert.equal(excluded.length, targets.length + 1, 'and nothing else does');

  // The step-09 guard still refuses an over-large set rather than dropping an id.
  let capped = false;
  try {
    exclusionService.mergeExclusions([targets.map((target) => target.id)], 2);
  } catch (err) {
    capped = err.statusCode === 503;
  }
  assert.ok(capped, 'an oversized exclusion set is refused, never silently trimmed');
});

// ---------------------------------------------------------------------------
// Gate 5 — spec conformance
// ---------------------------------------------------------------------------

test('G5.1 §22 — the block document matches the shape', () => {
  for (const field of ['blockerId', 'blockedUserId', 'reason', 'createdAt']) {
    assert.ok(Block.schema.path(field), `${field} must exist on the schema`);
  }
  assert.equal(Block.schema.path('blockerId').instance, 'ObjectId');
  assert.equal(Block.schema.path('blockedUserId').instance, 'ObjectId');
  assert.equal(Block.schema.path('reason').instance, 'String');
});

test('G5.2 §23 — the report document, categories and statuses match', () => {
  for (const field of ['reporterId', 'reportedUserId', 'category', 'description', 'evidence', 'status', 'reviewedBy', 'reviewedAt', 'createdAt', 'updatedAt']) {
    assert.ok(Report.schema.path(field), `${field} must exist on the schema`);
  }
  assert.deepEqual(Report.schema.path('category').enumValues, REPORT_CATEGORIES);
  assert.deepEqual(Report.schema.path('status').enumValues, REPORT_STATUSES);
  assert.deepEqual(REPORT_CATEGORIES, [
    'fake_profile', 'spam', 'harassment', 'fraud',
    'inappropriate_photo', 'wrong_information', 'already_married', 'other'
  ]);
  assert.equal(Report.schema.path('evidence').instance, 'Array');
});

test('G5.7 §112 — reporter and reviewer identity are not returned by default', async (t) => {
  if (!requireDb(t)) return;
  assert.equal(Report.schema.path('reporterId').options.select, false, 'reporterId is opt-in');
  assert.equal(Report.schema.path('reviewedBy').options.select, false, 'reviewedBy is opt-in');

  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();
  const created = await reportUser(a.token, { reportedUserId: b.id, category: 'other' });
  assert.equal(created.status, 201);

  const asDefault = await Report.findById(created.json.data.report.id).lean();
  assert.equal(asDefault.reporterId, undefined, 'a default read cannot see the reporter');
  assert.ok(!('reporterId' in asDefault), 'the field is absent, not null');

  // Step 16's admin view opts in explicitly — and is the only reader that does.
  const asAdmin = await Report.findById(created.json.data.report.id).select('+reporterId +reviewedBy').lean();
  assert.equal(String(asAdmin.reporterId), String(a.id), 'an explicit select can still read it');
  assert.equal(asAdmin.reviewedBy, null);
});

test('G5.4 §101 — the report surface is moderation-ready without exposing admin data', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();
  await reportUser(a.token, { reportedUserId: b.id, category: 'fraud', description: 'Asked for money' });

  // The queue step 16 will read: report + status, ordered newest first.
  const queue = await Report.find({ status: { $in: ACTIVE_REPORT_STATUSES } })
    .sort({ status: 1, createdAt: -1 })
    .select('+reporterId')
    .lean();
  assert.ok(queue.length >= 1, 'a moderator can find open cases');
  assert.ok(queue.some((row) => row.category === 'fraud' && row.description === 'Asked for money'));

  // The public surface has no update route at all (spec §32).
  const noUpdate = await api(`/api/v1/reports/${'0'.repeat(24)}`, { method: 'PATCH', token: a.token, body: {} });
  assert.equal(noUpdate.status, 404, 'no report route exists beyond create and me');
});

test('G5.3 §56 / §99 — blockers and blocked accounts are cut from discovery both ways', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount({ basic: { gender: 'female' } });
  const b = await publishedAccount();

  assert.ok(!(await exclusionService.getExcludedUserIds(a.id)).includes(b.id), 'nothing is excluded up front');
  await blockUser(a.token, { userId: b.id });

  assert.ok((await exclusionService.getExcludedUserIds(a.id)).includes(b.id), 'the blocked account is excluded');
  assert.ok((await exclusionService.getExcludedUserIds(b.id)).includes(a.id), 'and the blocker is excluded for them');
  assert.equal(await blockService.isBlockedEitherWay(a.id, b.id), true);
  assert.equal(await blockService.isBlockedEitherWay(b.id, a.id), true, 'the pair is blocked in both directions');
});
