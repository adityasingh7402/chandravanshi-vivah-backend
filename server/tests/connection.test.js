'use strict';

/**
 * Step 11 — Interests / Connections (spec §21, §22, §36, §44, §91, §96, §99,
 * §100, §105, §112, §121; finalized decisions §7, §8, §9, §16).
 *
 * Runs against the configured cluster in a DEDICATED database, seeded with the
 * real step-05 seeder. Cloudinary is the deterministic gateway double from step
 * 08, because a *target* must be a published profile to be contacted and the
 * seeded community config requires a photo to publish.
 *
 * The interest lifecycle is exercised through the real HTTP surface, so what is
 * verified is the mounted boundary — validation, the state machine, ownership and
 * rate limiting — not a service called directly. The two paths that no HTTP
 * request can reach (the expiry sweep and the block path before step 12 exists)
 * are driven at the service boundary, which is what they are.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.MONGODB_DB_NAME = 'chandravanshi_vivah_test_connection';
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
// Small connection page and a small message cap so both are cheap to exercise.
// The rate cap is per account, and every test uses a fresh account, so one
// account's budget is never another test's problem.
process.env.CONNECTIONS_DEFAULT_LIMIT = '3';
process.env.CONNECTIONS_MAX_LIMIT = '5';
process.env.INTEREST_MESSAGE_MAX_LEN = '40';
process.env.INTEREST_RATE_LIMIT_MAX = '20';
process.env.INTEREST_RATE_LIMIT_WINDOW = '3600';
process.env.INTEREST_EXPIRY_DAYS = '30';
// The lazy sweep is throttled far out of the way; the expiry test forces it.
process.env.CONNECTIONS_SWEEP_INTERVAL_SECONDS = '86400';

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
const Connection = require('../src/models/Connection');
const CommunityConfig = require('../src/models/CommunityConfig');
const { getMasterModel } = require('../src/models/masterData/MasterItem');
const { MASTER_TYPE_VALUES } = require('../src/constants/masterData');
const {
  CONNECTION_STATUSES,
  CONNECTION_STATUS,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  RESPONSE_ACTIONS
} = require('../src/constants/connection');
const profileScoreService = require('../src/services/profileScoreService');
const connectionService = require('../src/services/connectionService');
const connectionPolicy = require('../src/services/connectionPolicy');
const fakeCloudinary = require('./helpers/fakeCloudinary');
const seeder = require('../scripts/seed-master-data');

/**
 * A minimal stand-in for step 12's `blocks` model, so the "a blocked pair cannot
 * send or respond" gate (spec §22, §99) can be exercised before that step
 * exists. It reads the same collection `exclusionService.blockExclusion` reads,
 * and is registered lazily — exactly the seam step 12 will use.
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
  return registerAndLogin(`p11-${Date.now()}-${accountSeq}@example.com`);
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
  const publicId = `${sign.json.data.upload.folder}/p11-${photoSeq}`;
  const res = await api('/api/v1/photos', { method: 'POST', token, body: { publicId, type: 'profile' } });
  assert.equal(res.status, 201, `register photo: ${JSON.stringify(res.json)}`);
  await Photo.updateOne({ userId, isPrimary: true }, { $set: { moderationStatus: 'approved' } });
  await profileScoreService.syncDiscoveryPhotoFlag(userId);
}

/** A complete, published (contactable) account. */
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

const send = (token, body) => api('/api/v1/connections', { method: 'POST', token, body });
const respond = (token, id, action) => api(`/api/v1/connections/${id}`, { method: 'PATCH', token, body: { action } });
const listing = (token, query = '') => api(`/api/v1/connections${query}`, { token });

/** A pending row straight in the collection, bypassing the API. */
async function directPending(a, b, { ageDays = 0, message = null } = {}) {
  const row = await Connection.create({ senderId: a.id, receiverId: b.id, message });
  if (ageDays > 0) {
    await Connection.collection.updateOne(
      { _id: row._id },
      { $set: { createdAt: new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000) } }
    );
  }
  return Connection.findById(row._id).lean();
}

/**
 * Force one pending row past the expiry window and run the sweep, so a status
 * the product has no endpoint for can still be produced through the real code
 * path (task 9).
 */
async function expireRow(id) {
  await Connection.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(String(id)) },
    { $set: { createdAt: new Date(Date.now() - (config.connections.expiryDays + 1) * 24 * 60 * 60 * 1000) } }
  );
  await connectionService.sweepExpired({ force: true });
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
    Connection,
    Block,
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

test('G1.1 every step-11 deliverable exists', () => {
  const files = [
    'src/models/Connection.js',
    'src/services/connectionService.js',
    'src/services/connectionPolicy.js',
    'src/controllers/connection.controller.js',
    'src/routes/connection.routes.js',
    'src/validators/connection.validators.js',
    'src/constants/connection.js'
  ];
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', file)), `${file} is missing`);
  }
});

test('G1.1 / G3.9 every connection route is mounted and requires auth', async (t) => {
  if (!requireDb(t)) return;
  const cases = [
    ['POST', '/api/v1/connections'],
    ['GET', '/api/v1/connections'],
    ['PATCH', '/api/v1/connections/000000000000000000000000']
  ];
  for (const [method, route] of cases) {
    const res = await api(route, { method, body: method === 'GET' ? undefined : {} });
    assert.equal(res.status, 401, `${method} ${route} should require auth`);
  }
});

test('G1.2 / G5.6 §105 — the connections indexes exist, and the active-pair one is partial', async (t) => {
  if (!requireDb(t)) return;
  const indexes = await Connection.collection.indexes();
  const names = indexes.map((idx) => idx.name);
  for (const expected of ['senderId_1_status_1', 'receiverId_1_status_1', 'status_1_createdAt_1']) {
    assert.ok(names.includes(expected), `${expected} is missing`);
  }

  const pair = indexes.find((idx) => idx.key.senderId === 1 && idx.key.receiverId === 1 && !idx.key.status);
  assert.ok(pair, 'the pair index is missing');
  assert.equal(pair.unique, true, 'the pair index must be unique');
  assert.ok(pair.partialFilterExpression, 'the pair index must be partial (decisions §8)');
  assert.deepEqual(
    pair.partialFilterExpression.status.$in,
    ACTIVE_STATUSES,
    'the partial key must cover exactly the open statuses'
  );
});

// ---------------------------------------------------------------------------
// Gate 2 — functional
// ---------------------------------------------------------------------------

test('G2.1 sending an interest answers 201 with a pending connection', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();

  const withMessage = await send(a.token, { toUserId: b.id, message: '  Hello, I liked your profile.  ' });
  assert.equal(withMessage.status, 201, JSON.stringify(withMessage.json));
  const connection = withMessage.json.data.connection;
  assert.equal(connection.status, CONNECTION_STATUS.PENDING);
  assert.equal(connection.direction, 'sent');
  assert.equal(connection.message, 'Hello, I liked your profile.', 'the message is trimmed');
  assert.equal(connection.canChat, false);
  assert.ok(connection.id, 'the caller learns the row id it must PATCH');

  const stored = await Connection.findById(connection.id).lean();
  assert.equal(String(stored.senderId), String(a.id));
  assert.equal(String(stored.receiverId), String(b.id));
  assert.equal(stored.respondedAt, null, 'a pending row has no respondedAt');
});

test('G2.1 / G2.8 the receiver sees the interest, card-shaped, with the note', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  await send(a.token, { publicProfileId: b.publicProfileId, message: 'Namaste' });

  const received = await listing(b.token);
  assert.equal(received.status, 200, JSON.stringify(received.json));
  assert.equal(received.json.data.box, 'received');
  const row = received.json.data.items.find((item) => item.profileId === a.publicProfileId);
  assert.ok(row, 'the sender appears in the receiver list');

  // The row is exactly the §70 card plus one nested `connection` object — no
  // extra top-level key, so it renders like any discovery card.
  const { connection, ...card } = row;
  assert.deepEqual(Object.keys(card).sort(), CARD_KEYS, 'the profile part is exactly the §70 card');
  assert.equal(connection.status, CONNECTION_STATUS.PENDING);
  assert.equal(connection.direction, 'received');
  assert.equal(connection.message, 'Namaste');

  const sent = await listing(a.token, '?box=sent');
  assert.equal(sent.json.data.box, 'sent');
  assert.ok(sent.json.data.items.some((item) => item.profileId === b.publicProfileId), 'the sender sees it too');
  assert.equal(sent.json.data.items[0].connection.direction, 'sent');
});

test('G2.1 the direction may be given as status=sent/received (command 8 spelling)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  await send(a.token, { toUserId: b.id });
  const res = await listing(b.token, '?status=received');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.equal(res.json.data.box, 'received');
  assert.ok(res.json.data.items.some((item) => item.profileId === a.publicProfileId));
});

test('G2.2 accept moves pending -> accepted and sets respondedAt (command 5)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  const created = await send(a.token, { toUserId: b.id });
  const id = created.json.data.connection.id;

  const accepted = await respond(b.token, id, 'accept');
  assert.equal(accepted.status, 200, JSON.stringify(accepted.json));
  assert.equal(accepted.json.data.connection.status, CONNECTION_STATUS.ACCEPTED);
  assert.equal(accepted.json.data.connection.direction, 'received', 'the receiver sees it as received');
  assert.ok(accepted.json.data.connection.respondedAt, 'respondedAt is set');
  assert.equal(accepted.json.data.connection.canChat, true, 'an accepted connection grants chat');

  const stored = await Connection.findById(id).lean();
  assert.equal(stored.status, CONNECTION_STATUS.ACCEPTED);
  assert.ok(stored.respondedAt);
});

test('G2.2 / G3.2 only the receiver can accept or reject; only the sender can withdraw (command 4)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  const created = await send(a.token, { toUserId: b.id });
  const id = created.json.data.connection.id;

  const senderAccept = await respond(a.token, id, 'accept');
  assert.equal(senderAccept.status, 403, 'the sender cannot accept their own interest');
  const senderReject = await respond(a.token, id, 'reject');
  assert.equal(senderReject.status, 403);

  const receiverWithdraw = await respond(b.token, id, 'withdraw');
  assert.equal(receiverWithdraw.status, 403, 'the receiver cannot withdraw the sender\'s interest');

  const unchanged = await Connection.findById(id).lean();
  assert.equal(unchanged.status, CONNECTION_STATUS.PENDING, 'a refused role leaves the row pending');
});

test('G2.2 an illegal transition is refused with 409 and the row is unchanged (command 6)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  const created = await send(a.token, { toUserId: b.id });
  const id = created.json.data.connection.id;
  assert.equal((await respond(b.token, id, 'accept')).status, 200);

  const rejectAfterAccept = await respond(b.token, id, 'reject');
  assert.equal(rejectAfterAccept.status, 409, 'an accepted match cannot be rejected');
  const withdrawAfterAccept = await respond(a.token, id, 'withdraw');
  assert.equal(withdrawAfterAccept.status, 409, 'an accepted match cannot be withdrawn');

  const unchanged = await Connection.findById(id).lean();
  assert.equal(unchanged.status, CONNECTION_STATUS.ACCEPTED);
});

test('G2.2 withdrawing from pending is the sender\'s transition (command 7)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  const created = await send(a.token, { toUserId: b.id });
  const id = created.json.data.connection.id;

  const withdrawn = await respond(a.token, id, 'withdraw');
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.json));
  assert.equal(withdrawn.json.data.connection.status, CONNECTION_STATUS.WITHDRAWN);
  assert.equal(withdrawn.json.data.connection.canChat, false);

  // The withdrawn row is terminal: a second withdraw is a 409, not a repeat.
  const again = await respond(a.token, id, 'withdraw');
  assert.equal(again.status, 409);
});

test('G2.3 / G2.4 a duplicate send is refused with 409, and only one row exists (command 2)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  const first = await send(a.token, { toUserId: b.id });
  assert.equal(first.status, 201);

  const duplicate = await send(a.token, { toUserId: b.id });
  assert.equal(duplicate.status, 409, 'a second active interest must be refused');
  assert.equal(await Connection.countDocuments({ senderId: a.id, receiverId: b.id }), 1, 'exactly one row');
  assert.equal(await Connection.countDocuments({ status: { $in: ACTIVE_STATUSES }, $or: [{ senderId: a.id, receiverId: b.id }, { senderId: b.id, receiverId: a.id }] }), 1);
});

test('G2.4 a crossing send is refused with a hint, not auto-accepted', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  await send(a.token, { toUserId: b.id });

  const crossing = await send(b.token, { toUserId: a.id });
  assert.equal(crossing.status, 409, 'a mutual auto-accept is explicitly deferred by the step');
  assert.equal(crossing.json.details.direction, 'received', 'the hint names the inbound interest');
  assert.equal(await Connection.countDocuments({ $or: [{ senderId: a.id, receiverId: b.id }, { senderId: b.id, receiverId: a.id }] }), 1);
});

test('G2.5 / G3.4 a self-interest is refused with 400 (command 3)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const res = await send(a.token, { toUserId: a.id });
  assert.equal(res.status, 400, JSON.stringify(res.json));
  assert.equal(await Connection.countDocuments({ senderId: a.id, receiverId: a.id }), 0);
});

test('G2.6 canChat is true only for accepted — false for every other status (decisions §7)', async (t) => {
  if (!requireDb(t)) return;
  // A fresh pair per status, so each status is produced by the real transition.
  const make = async (targetStatus) => {
    const a = await publishedAccount();
    const b = await publishedAccount();
    const created = await send(a.token, { toUserId: b.id });
    const id = created.json.data.connection.id;
    if (targetStatus !== CONNECTION_STATUS.PENDING) {
      if (targetStatus === CONNECTION_STATUS.ACCEPTED) {
        await respond(b.token, id, 'accept');
      } else if (targetStatus === CONNECTION_STATUS.REJECTED) {
        await respond(b.token, id, 'reject');
      } else if (targetStatus === CONNECTION_STATUS.WITHDRAWN) {
        await respond(a.token, id, 'withdraw');
      } else if (targetStatus === CONNECTION_STATUS.CLOSED) {
        await respond(b.token, id, 'accept');
        await respond(a.token, id, 'close');
      } else if (targetStatus === CONNECTION_STATUS.EXPIRED) {
        await expireRow(id);
      }
    }
    return { a, b, id };
  };

  for (const status of CONNECTION_STATUSES) {
    const { a, b } = await make(status);
    const canChat = await connectionPolicy.canChat(a.id, b.id);
    assert.equal(canChat, status === CONNECTION_STATUS.ACCEPTED, `canChat must be ${status === 'accepted'} for ${status}`);
    const access = await connectionPolicy.chatAccess(a.id, b.id);
    assert.equal(access.canChat, status === CONNECTION_STATUS.ACCEPTED);
  }
});

test('G2.7 / G2.10 either participant may close; the pair is then closed for chat', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  const created = await send(a.token, { toUserId: b.id });
  const id = created.json.data.connection.id;
  await respond(b.token, id, 'accept');
  assert.equal(await connectionPolicy.canChat(a.id, b.id), true);

  // The *sender* closes this time, to prove "either participant" (decisions §7).
  const closed = await respond(a.token, id, 'close');
  assert.equal(closed.status, 200, JSON.stringify(closed.json));
  assert.equal(closed.json.data.connection.status, CONNECTION_STATUS.CLOSED);
  assert.equal(closed.json.data.connection.canChat, false);
  assert.equal(await connectionPolicy.canChat(a.id, b.id), false, 'a closed connection grants no chat');

  const row = await Connection.findById(id).lean();
  assert.equal(row.status, CONNECTION_STATUS.CLOSED, 'the closed row is preserved');
  assert.ok(row.respondedAt);
});

test('G2.10 closing is only available from accepted', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  const created = await send(a.token, { toUserId: b.id });
  const id = created.json.data.connection.id;
  const early = await respond(a.token, id, 'close');
  assert.equal(early.status, 409, 'a pending interest cannot be closed');
});

test('G2.11 a send after a terminal state creates a NEW record (command 12)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();

  // rejected -> re-send
  const first = await send(a.token, { toUserId: b.id });
  await respond(b.token, first.json.data.connection.id, 'reject');
  const resend = await send(a.token, { toUserId: b.id });
  assert.equal(resend.status, 201, JSON.stringify(resend.json));
  assert.notEqual(resend.json.data.connection.id, first.json.data.connection.id, 'a fresh row, not a mutation');
  const oldRejected = await Connection.findById(first.json.data.connection.id).lean();
  assert.equal(oldRejected.status, CONNECTION_STATUS.REJECTED, 'the terminal row is untouched');

  // closed -> re-send
  const secondId = resend.json.data.connection.id;
  await respond(b.token, secondId, 'accept');
  await respond(a.token, secondId, 'close');
  const third = await send(a.token, { toUserId: b.id });
  assert.equal(third.status, 201, 'a closed connection does not block a new interest');
  assert.equal(await Connection.countDocuments({ senderId: a.id, receiverId: b.id, status: CONNECTION_STATUS.PENDING }), 1);
  const stillClosed = await Connection.findById(secondId).lean();
  assert.equal(stillClosed.status, CONNECTION_STATUS.CLOSED, 'the closed row is unchanged');
  assert.equal(await Connection.countDocuments({ senderId: a.id, receiverId: b.id }), 3, 'history is preserved');
});

test('G2.7 the expiry sweep marks stale pending rows expired and leaves fresh ones alone (command 10)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const stale = await publishedAccount();
  const fresh = await publishedAccount();

  const oldRow = await directPending(a, stale, { ageDays: config.connections.expiryDays + 1 });
  const freshRow = await directPending(a, fresh, { ageDays: 0 });

  const result = await connectionService.sweepExpired({ force: true });
  assert.ok(result.swept >= 1, `expected at least one row to expire, swept ${result.swept}`);

  const expired = await Connection.findById(oldRow._id).lean();
  assert.equal(expired.status, CONNECTION_STATUS.EXPIRED);
  assert.ok(expired.respondedAt, 'the expiry records when it happened');

  const untouched = await Connection.findById(freshRow._id).lean();
  assert.equal(untouched.status, CONNECTION_STATUS.PENDING, 'a fresh pending row is left alone');
});

test('G2.7 the sweep is throttled, not run on every read', async (t) => {
  if (!requireDb(t)) return;
  const forced = await connectionService.sweepExpired({ force: true });
  assert.equal(forced.skipped, false, 'a forced sweep always runs');

  // The throttle window is 24 h in this suite, so a read-triggered sweep
  // immediately after one has run must be a no-op (task 9).
  const throttled = await connectionService.sweepExpired();
  assert.equal(throttled.skipped, true, 'a sweep inside the window is skipped');
  assert.equal(throttled.swept, 0);
});

test('G2.8 the connection list is paginated in both directions', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  const targets = [await publishedAccount(), await publishedAccount(), await publishedAccount()];
  for (const target of targets) await send(a.token, { toUserId: target.id });

  const page1 = await listing(a.token, '?box=sent&limit=2');
  assert.equal(page1.json.data.items.length, 2, 'page 1 is two rows');
  assert.ok(page1.json.data.nextCursor, 'a further page exists');

  const page2 = await listing(a.token, `?box=sent&limit=2&cursor=${page1.json.data.nextCursor}`);
  const overlap = page1.json.data.items.filter((x) =>
    page2.json.data.items.some((y) => y.connection.id === x.connection.id)
  );
  assert.equal(overlap.length, 0, 'pages do not overlap');

  // An oversized limit is clamped to the configured maximum, not rejected.
  const huge = await listing(a.token, '?box=sent&limit=100000');
  assert.equal(huge.status, 200);
  assert.ok(huge.json.data.items.length <= config.connections.maxLimit);

  // The receiver's side is empty for the same pair of accounts.
  const received = await listing(b.token, '?box=received');
  assert.equal(received.json.data.items.length, 0, 'b received nothing');
});

// ---------------------------------------------------------------------------
// Gate 3 — security
// ---------------------------------------------------------------------------

test('G3.1 a non-participant cannot modify a connection (404, not 403)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  const attacker = await publishedAccount();
  const created = await send(a.token, { toUserId: b.id });
  const id = created.json.data.connection.id;

  const res = await respond(attacker.token, id, 'accept');
  assert.equal(res.status, 404, 'a non-participant must not learn the row exists');
  const unchanged = await Connection.findById(id).lean();
  assert.equal(unchanged.status, CONNECTION_STATUS.PENDING);
});

test('G3.1 a non-participant cannot read another member\'s connections', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  const attacker = await publishedAccount();
  await send(a.token, { toUserId: b.id });

  const asAttacker = await listing(attacker.token, '?box=received&limit=100');
  assert.equal(asAttacker.status, 200);
  assert.equal(asAttacker.json.data.items.length, 0, 'the list is never another account\'s rows');
});

test('G3.3 a blocked pair cannot send or respond, in either direction (spec §22, §99)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  const created = await send(a.token, { toUserId: b.id });
  const id = created.json.data.connection.id;

  await Block.create({ blockerId: b.id, blockedUserId: a.id });

  const sendFromBlocked = await send(a.token, { toUserId: b.id });
  assert.equal(sendFromBlocked.status, 404, 'the blocked account cannot send');
  const sendFromBlocker = await send(b.token, { toUserId: a.id });
  assert.equal(sendFromBlocker.status, 404, 'the blocker cannot send either');

  const respondBlocked = await respond(b.token, id, 'accept');
  assert.equal(respondBlocked.status, 404, 'a blocked pair cannot respond');
  const unchanged = await Connection.findById(id).lean();
  assert.equal(unchanged.status, CONNECTION_STATUS.PENDING);

  await Block.collection.deleteMany({});
});

test('G3.4 a body identity field cannot name the actor or the receiver (spec §44)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  const c = await publishedAccount();

  for (const extra of [{ senderId: c.id }, { receiverId: c.id }, { userId: c.id }, { status: 'accepted' }]) {
    const res = await send(a.token, { toUserId: b.id, ...extra });
    assert.equal(res.status, 400, `an unknown field must be rejected: ${JSON.stringify(res.json)}`);
  }
  const patched = await api(`/api/v1/connections/${new mongoose.Types.ObjectId()}`, {
    method: 'PATCH',
    token: a.token,
    body: { action: 'accept', status: 'accepted' }
  });
  assert.equal(patched.status, 400, 'a client cannot set a status');
});

test('G3.5 the interest message is length-capped and cannot inject markup', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  const cap = config.connections.messageMaxLen;

  const tooLong = await send(a.token, { toUserId: b.id, message: 'x'.repeat(cap + 1) });
  assert.equal(tooLong.status, 400, 'an over-long message is refused');
  const markup = await send(a.token, { toUserId: b.id, message: '<script>alert(1)</script>' });
  assert.equal(markup.status, 400, 'markup is refused, not stored');
  const entity = await send(a.token, { toUserId: b.id, message: 'hi <b>' });
  assert.equal(entity.status, 400);

  const ok = await send(a.token, { toUserId: b.id, message: 'x'.repeat(cap) });
  assert.equal(ok.status, 201, 'exactly at the cap is allowed');

  const stored = await Connection.findOne({ senderId: a.id, receiverId: b.id }).lean();
  assert.ok(!/[<>]/.test(stored.message), 'the stored value can never contain markup');
});

test('G3.6 malformed ids and object-shaped values are rejected before any query (spec §34)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  for (const body of [{ toUserId: 'not-an-id' }, { toUserId: { $ne: null } }, { publicProfileId: 42 }]) {
    const res = await send(a.token, body);
    assert.equal(res.status, 400, `must reject: ${JSON.stringify(body)}`);
  }
  const both = await send(a.token, { toUserId: b.id, publicProfileId: b.publicProfileId });
  assert.equal(both.status, 400, 'both target spellings at once is ambiguous');

  const badParam = await respond(a.token, 'not-an-id', 'accept');
  assert.equal(badParam.status, 400, 'a malformed path id is a 400, not a cast 500');

  const badAction = await respond(a.token, new mongoose.Types.ObjectId(), 'explode');
  assert.equal(badAction.status, 400, 'an unknown action is a 400');

  const badQuery = await listing(a.token, '?status[$ne]=pending');
  assert.equal(badQuery.status, 400, 'an object-shaped query value is rejected');
});

test('G3.7 / G5.5 sending interests is rate limited (command 9)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  const cap = config.connections.rateLimit.max;

  let sawTooMany = false;
  for (let i = 0; i < cap + 5; i += 1) {
    const res = await send(a.token, { toUserId: b.id });
    if (res.status === 429) {
      sawTooMany = true;
      break;
    }
  }
  assert.ok(sawTooMany, `expected a 429 within ${cap + 5} sends`);
});

test('G3.8 a connection listing exposes no private profile field or account id (spec §112)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  await send(a.token, { toUserId: b.id, message: 'hello there' });

  const res = await listing(b.token);
  const blob = JSON.stringify(res.json);
  for (const forbidden of ['"email"', '"phone"', '"coordinates"', '"dateOfBirth"', '"birthTime"', '"userId"', '"senderId"', '"receiverId"']) {
    assert.ok(!blob.includes(forbidden), `listing must not carry ${forbidden}`);
  }
  assert.ok(!blob.includes(a.id), 'the counterpart account id must not appear');
});

// ---------------------------------------------------------------------------
// Gate 4 — performance & data
// ---------------------------------------------------------------------------

test('G4.1 the sent/received list queries are index-backed (IXSCAN)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  await send(a.token, { toUserId: b.id });

  const receivedPlan = await Connection.find({ receiverId: b.id, status: CONNECTION_STATUS.PENDING })
    .sort({ _id: -1 })
    .explain('queryPlanner');
  assert.ok(JSON.stringify(receivedPlan).includes('IXSCAN'), 'the received list must be index-backed');

  const sentPlan = await Connection.find({ senderId: a.id, status: CONNECTION_STATUS.PENDING })
    .sort({ _id: -1 })
    .explain('queryPlanner');
  assert.ok(JSON.stringify(sentPlan).includes('IXSCAN'), 'the sent list must be index-backed');
});

test('G4.2 the expiry sweep query is index-backed and only touches pending rows', async (t) => {
  if (!requireDb(t)) return;
  const plan = await Connection.find({
    status: CONNECTION_STATUS.PENDING,
    createdAt: { $lt: new Date() }
  }).explain('queryPlanner');
  assert.ok(JSON.stringify(plan).includes('IXSCAN'), 'the sweep must use status_1_createdAt_1');
});

test('G4.3 the list uses the shared card projection and performs no populate', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  await send(a.token, { toUserId: b.id });
  const result = await connectionService.list(b.id, { box: 'received' });
  const { connection, ...card } = result.items[0];
  assert.deepEqual(Object.keys(card).sort(), CARD_KEYS, 'the DTO is exactly the card');
  assert.ok(connection.id);
});

test('G4.4 a concurrent duplicate send resolves to one 201, one 409 and one row (command 13)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();

  // Two independent HTTP requests racing on the same directed pair. The partial
  // unique index is the guarantee; whichever loses is translated to a 409.
  const [first, second] = await Promise.all([send(a.token, { toUserId: b.id }), send(a.token, { toUserId: b.id })]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [201, 409], `expected one success and one conflict, got ${statuses.join(',')}`);
  assert.equal(await Connection.countDocuments({ senderId: a.id, receiverId: b.id }), 1, 'exactly one row');
});

// ---------------------------------------------------------------------------
// Gate 5 — spec conformance
// ---------------------------------------------------------------------------

test('G5.1 §21 — the connection document matches the shape', () => {
  for (const field of ['senderId', 'receiverId', 'status', 'message', 'respondedAt', 'createdAt', 'updatedAt']) {
    assert.ok(Connection.schema.path(field), `${field} must exist on the schema`);
  }
  assert.equal(Connection.schema.path('senderId').instance, 'ObjectId');
  assert.equal(Connection.schema.path('receiverId').instance, 'ObjectId');
  assert.equal(Connection.schema.path('message').instance, 'String');
  assert.equal(Connection.schema.path('respondedAt').instance, 'Date');
  assert.deepEqual(Connection.schema.path('status').enumValues, CONNECTION_STATUSES, 'the §21 status set plus `closed`');
});

test('G5.8 decisions §7/§8 — the six-status enum, the transitions and the re-send rule', () => {
  assert.deepEqual(CONNECTION_STATUSES, ['pending', 'accepted', 'rejected', 'withdrawn', 'expired', 'closed']);
  assert.deepEqual(ACTIVE_STATUSES, ['pending', 'accepted']);
  assert.deepEqual(TERMINAL_STATUSES, ['rejected', 'withdrawn', 'expired', 'closed']);
  assert.deepEqual(RESPONSE_ACTIONS, ['accept', 'reject', 'withdraw', 'close']);

  // The matrix is data, and it is exactly the documented one.
  assert.equal(connectionPolicy.canTransition(null, 'send', 'sender'), true);
  assert.equal(connectionPolicy.canTransition('pending', 'accept', 'receiver'), true);
  assert.equal(connectionPolicy.canTransition('pending', 'reject', 'receiver'), true);
  assert.equal(connectionPolicy.canTransition('pending', 'withdraw', 'sender'), true);
  assert.equal(connectionPolicy.canTransition('pending', 'timeout', 'system'), true);
  assert.equal(connectionPolicy.canTransition('accepted', 'close', 'sender'), true);
  assert.equal(connectionPolicy.canTransition('accepted', 'close', 'receiver'), true);

  // Everything else is illegal.
  assert.equal(connectionPolicy.canTransition(null, 'accept', 'receiver'), false);
  assert.equal(connectionPolicy.canTransition('accepted', 'accept', 'receiver'), false);
  assert.equal(connectionPolicy.canTransition('closed', 'close', 'sender'), false);
  assert.equal(connectionPolicy.canTransition('pending', 'accept', 'sender'), false);
  assert.equal(connectionPolicy.canTransition('pending', 'close', 'sender'), false);
  assert.equal(connectionPolicy.canTransition('pending', 'send', 'sender'), false);
});

test('G5.4 decisions §16 — accept and its notification are not wrapped in a transaction', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'connectionService.js'), 'utf8');
  assert.ok(!/withTransaction|startSession/.test(source), 'no transaction may wrap the accept/notify pair');
  assert.ok(/emitDomainEvent/.test(source), 'the notification is a side effect on the event bus');
});

test('G5.4 the accept path emits exactly one accepted event for step 13 to map to new_match', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();

  const seen = [];
  const listener = (payload) => seen.push(payload);
  connectionService.events.on('connection', listener);
  try {
    const created = await send(a.token, { toUserId: b.id });
    await respond(b.token, created.json.data.connection.id, 'accept');
  } finally {
    connectionService.events.off('connection', listener);
  }

  const received = seen.filter((e) => e.type === 'interest_received');
  const accepted = seen.filter((e) => e.type === 'interest_accepted');
  assert.equal(received.length, 1, 'one interest_received event');
  assert.equal(accepted.length, 1, 'exactly one interest_accepted event (decisions §9)');
  assert.equal(seen.some((e) => e.type === 'new_match'), false, 'the notification layer owns new_match, not the service');
});

test('G5.7 §121 — the documented service surface and the block/admin access path exist', () => {
  for (const fn of [
    'send',
    'respond',
    'accept',
    'reject',
    'withdraw',
    'close',
    'closeForAccess',
    'sweepExpired',
    'list'
  ]) {
    assert.equal(typeof connectionService[fn], 'function', `connectionService.${fn} must exist`);
  }
  for (const fn of ['canTransition', 'canChat', 'actorRoleFor', 'acceptedBetween', 'chatAccess']) {
    assert.equal(typeof connectionPolicy[fn], 'function', `connectionPolicy.${fn} must exist`);
  }
  assert.equal(typeof connectionService.events.emit, 'function', 'a domain event bus exists for step 13');
});

test('G5.8 closeForAccess preserves the row and removes chat access without a participant (decisions §7)', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();
  const created = await send(a.token, { toUserId: b.id });
  const id = created.json.data.connection.id;
  await respond(b.token, id, 'accept');
  assert.equal(await connectionPolicy.canChat(a.id, b.id), true);

  const closed = await connectionService.closeForAccess(id);
  assert.equal(closed, true, 'an accepted connection is closed for access');
  assert.equal(await connectionPolicy.canChat(a.id, b.id), false);
  assert.equal((await Connection.findById(id).lean()).status, CONNECTION_STATUS.CLOSED, 'the row is preserved');

  // Calling it again is a no-op, not an error.
  assert.equal(await connectionService.closeForAccess(id), false);
});
