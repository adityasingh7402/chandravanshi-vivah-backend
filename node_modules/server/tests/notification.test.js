'use strict';

/**
 * Step 13 — Notifications (spec §22, §24, §30, §36, §44, §105, §112; finalized
 * decisions §9, §10, §16).
 *
 * Runs against the configured cluster in a DEDICATED database, seeded with the
 * real step-05 seeder. Cloudinary is the deterministic gateway double from step
 * 08, because producing the interesting events (interests, accepts, views)
 * requires published profiles and the seeded community config requires a photo
 * to publish.
 *
 * Two kinds of assertion, matching how this step is layered:
 *
 *  1. **End-to-end over HTTP** for everything the API owns: the inbox, the badge
 *     count, mark-one/mark-all, ownership, validation and rate limits.
 *  2. **Service boundary** for the event mapping itself, because the events are
 *     emitted *detached* (decisions §16 — a notification must never block or
 *     roll back an interest send). A row created by an event lands a
 *     microtask-plus-IO after the originating response, so the event tests
 *     `await` the service directly or poll the collection for the row rather
 *     than pretending the HTTP response proves it.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.MONGODB_DB_NAME = 'chandravanshi_vivah_test_notify';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.RATE_LIMIT_MAX = '99999';
process.env.RATE_LIMIT_WINDOW = '3600';
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
process.env.CLOUDINARY_API_KEY = 'test-key-1234';
process.env.CLOUDINARY_API_SECRET = 'test-secret-abcdef';
process.env.CLOUDINARY_UPLOAD_FOLDER = 'chandravanshi-vivah-test';
// Small lists and a small mark-read budget so every bound is cheap to exercise.
// The mark-read limiter is keyed per account and every test uses fresh
// accounts, so one test's flood is never another test's problem.
process.env.NOTIFICATIONS_DEFAULT_LIMIT = '2';
process.env.NOTIFICATIONS_MAX_LIMIT = '3';
process.env.NOTIFY_RATE_LIMIT_MAX = '8';
process.env.NOTIFY_RATE_LIMIT_WINDOW = '3600';
process.env.NOTIFY_VIEW_THROTTLE_MIN = '15';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const app = require('../src/app');
const db = require('../src/config/db');
const User = require('../src/models/User');
const Session = require('../src/models/Session');
const MatrimonialProfile = require('../src/models/MatrimonialProfile');
const PartnerPreference = require('../src/models/PartnerPreference');
const Photo = require('../src/models/Photo');
const ProfileAction = require('../src/models/ProfileAction');
const Connection = require('../src/models/Connection');
const Block = require('../src/models/Block');
const Report = require('../src/models/Report');
const Notification = require('../src/models/Notification');
const CommunityConfig = require('../src/models/CommunityConfig');
const { getMasterModel } = require('../src/models/masterData/MasterItem');
const { MASTER_TYPE_VALUES } = require('../src/constants/masterData');
const { NOTIFICATION_TYPES, NOTIFICATION_TYPE_SET } = require('../src/constants/notifications');
const profileScoreService = require('../src/services/profileScoreService');
const notificationService = require('../src/services/notificationService');
const notificationEvents = require('../src/services/notificationEvents');
const connectionService = require('../src/services/connectionService');
const actionService = require('../src/services/actionService');
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
  return registerAndLogin(`p13-${Date.now()}-${accountSeq}@example.com`);
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
  const publicId = `${sign.json.data.upload.folder}/p13-${photoSeq}`;
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

const sendInterest = (token, body) => api('/api/v1/connections', { method: 'POST', token, body });
const respond = (token, id, action) =>
  api(`/api/v1/connections/${id}`, { method: 'PATCH', token, body: { action } });
const recordAction = (token, body) => api('/api/v1/interactions', { method: 'POST', token, body });
const inbox = (token, query = '') => api(`/api/v1/notifications${query}`, { token });
const unreadCount = (token, query = '') => api(`/api/v1/notifications/unread-count${query}`, { token });
const markRead = (token, id, body) =>
  api(`/api/v1/notifications/${id}/read`, { method: 'PATCH', token, body: body ?? undefined });
const markAllRead = (token) => api('/api/v1/notifications/read-all', { method: 'PATCH', token });

/** Poll until `fn` is truthy; event-created rows land a tick after their cause. */
async function waitFor(fn, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Every notification row for one recipient, newest first, straight from the DB. */
const rowsFor = (userId) => Notification.find({ userId }).sort({ createdAt: -1, _id: -1 }).lean();

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
    Notification,
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

test('G1.1 every step-13 deliverable exists', () => {
  const root = path.join(__dirname, '..');
  for (const rel of [
    'src/models/Notification.js',
    'src/services/notificationService.js',
    'src/services/notificationEvents.js',
    'src/controllers/notification.controller.js',
    'src/routes/notification.routes.js',
    'src/validators/notification.validators.js',
    'src/constants/notifications.js'
  ]) {
    assert.ok(fs.existsSync(path.join(root, rel)), `missing deliverable: ${rel}`);
  }
});

test('G1.1 / G3.7 every notification route is mounted and requires auth', async (t) => {
  if (!requireDb(t)) return;
  const routes = [
    ['GET', '/api/v1/notifications'],
    ['GET', '/api/v1/notifications/unread-count'],
    ['PATCH', '/api/v1/notifications/read-all'],
    ['PATCH', `/api/v1/notifications/${new mongoose.Types.ObjectId()}/read`]
  ];
  for (const [method, route] of routes) {
    const res = await api(route, { method });
    assert.equal(res.status, 401, `${method} ${route} must 401 without a token, got ${res.status}`);
  }
});

test('G1.2 / G5.4 §105 — the notification indexes exist', async (t) => {
  if (!requireDb(t)) return;
  const indexes = await Notification.collection.indexes();
  const names = indexes.map((index) => index.name);
  assert.ok(names.includes('userId_1_createdAt_-1__id_-1'), `inbox index missing: ${names.join(', ')}`);
  assert.ok(names.includes('userId_1_readAt_1'), `unread index missing: ${names.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Gate 2 — functional
// ---------------------------------------------------------------------------

test('G2.1 an interest received produces a notification for the receiver (command 1)', async (t) => {
  if (!requireDb(t)) return;
  const sender = await publishedAccount();
  const receiver = await publishedAccount();

  const sent = await sendInterest(sender.token, { toUserId: receiver.id });
  assert.equal(sent.status, 201, `send: ${JSON.stringify(sent.json)}`);

  const row = await waitFor(async () =>
    (await rowsFor(receiver.id)).find((n) => n.type === 'interest_received')
  );
  assert.ok(row, 'the receiver must get an interest_received row');
  assert.equal(row.title, 'New interest');
  // The payload carries the connection id and the sender's PUBLIC profile id —
  // never the sender's account id (spec §113, §112).
  assert.equal(row.data.connectionId, String(sent.json.data.connection.id));
  assert.equal(row.data.fromProfileId, sender.publicProfileId);
  assert.ok(!('senderId' in row.data), 'data must not carry an account id');
});

test('G2.1 profile_view and shortlisted are produced by their step-10 events', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount();
  const target = await publishedAccount();

  await recordAction(actor.token, { toUserId: target.id, type: 'view' });
  const view = await waitFor(async () => (await rowsFor(target.id)).find((n) => n.type === 'profile_view'));
  assert.ok(view, 'a view must produce a profile_view row');
  assert.equal(view.data.fromProfileId, actor.publicProfileId);

  await recordAction(actor.token, { toUserId: target.id, type: 'shortlist' });
  const shortlist = await waitFor(async () =>
    (await rowsFor(target.id)).find((n) => n.type === 'shortlisted')
  );
  assert.ok(shortlist, 'a shortlist must produce a shortlisted row');
});

test('G2.1 new_message, verification_completed and admin_alert are creatable (steps 14/16 producers)', async (t) => {
  if (!requireDb(t)) return;
  // These types have no producer yet — step 14 owns chat, step 16 owns
  // verification and admin alerts. What this step owes is that `create()`
  // accepts them with a small identifiers-only payload, so those steps add a
  // producer without touching the core service (task 4).
  const account = await freshAccount();
  const conversationId = new mongoose.Types.ObjectId();
  const created = await notificationService.create({
    userId: account.id,
    type: 'new_message',
    data: { conversationId: String(conversationId), messageId: String(new mongoose.Types.ObjectId()) }
  });
  assert.ok(created.notification, 'new_message must be creatable');
  assert.equal(created.notification.type, 'new_message');

  for (const type of ['verification_completed', 'admin_alert']) {
    const result = await notificationService.create({ userId: account.id, type, data: {} });
    assert.ok(result.notification, `${type} must be creatable`);
    assert.equal(result.notification.type, type);
  }
  const rows = await rowsFor(account.id);
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((row) => row.type).sort(),
    ['admin_alert', 'new_message', 'verification_completed']
  );
});

test('G2.1 an unknown type is refused by the service before any write', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  await assert.rejects(
    () => notificationService.create({ userId: account.id, type: 'made_up', data: {} }),
    (err) => err.statusCode === 400
  );
  assert.equal((await rowsFor(account.id)).length, 0);
});

test('G2.2 the inbox lists newest first, paginated and bounded (task 7)', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  // Five rows, inserted oldest-first, so sort order is observable.
  for (let i = 0; i < 5; i += 1) {
    await notificationService.create({ userId: account.id, type: 'admin_alert', data: { seq: i } });
  }

  const page1 = await inbox(account.token);
  assert.equal(page1.status, 200);
  // NOTIFICATIONS_DEFAULT_LIMIT=2.
  assert.equal(page1.json.data.items.length, 2);
  assert.ok(page1.json.data.nextCursor, 'a full page must carry a cursor');
  const seqs = page1.json.data.items.map((item) => item.data.seq);
  assert.deepEqual(seqs, [4, 3], 'the inbox must be newest first');

  const page2 = await inbox(account.token, `?cursor=${page1.json.data.nextCursor}`);
  assert.equal(page2.json.data.items.length, 2);
  assert.deepEqual(
    page2.json.data.items.map((item) => item.data.seq),
    [2, 1]
  );

  const page3 = await inbox(account.token, `?cursor=${page2.json.data.nextCursor}`);
  assert.equal(page3.json.data.items.length, 1);
  assert.equal(page3.json.data.nextCursor, null, 'the last page has no cursor');

  // The limit is clamped, never exceeded (NOTIFICATIONS_MAX_LIMIT=3).
  const clamped = await inbox(account.token, '?limit=999');
  assert.equal(clamped.json.data.items.length, 3);

  // An unknown query field is a 400, not a silently ignored filter (.strict()).
  const strict = await inbox(account.token, '?sort=whatever');
  assert.equal(strict.status, 400);
});

test('G2.3 unreadOnly filters correctly and the unread count matches (command 3)', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  const rows = [];
  for (let i = 0; i < 3; i += 1) {
    const { notification } = await notificationService.create({
      userId: account.id,
      type: 'admin_alert',
      data: { seq: i }
    });
    rows.push(notification);
  }
  await notificationService.markRead(account.id, String(rows[0]._id));

  const count = await unreadCount(account.token);
  assert.equal(count.status, 200);
  assert.equal(count.json.data.unreadCount, 2);

  const unread = await inbox(account.token, '?unreadOnly=true');
  assert.equal(unread.json.data.items.length, 2, 'unreadOnly must hide the read row');
  assert.ok(unread.json.data.items.every((item) => item.readAt === null));

  const all = await inbox(account.token, '?limit=3');
  assert.equal(all.json.data.items.length, 3, 'with an explicit limit the full inbox is listed');
  assert.equal(all.json.data.unreadCount, 2, 'the page carries the same badge count');

  // unreadOnly is strictly boolean: 'yes' is a 400, not a truthy string.
  const bad = await inbox(account.token, '?unreadOnly=yes');
  assert.equal(bad.status, 400);
});

test('G2.4 mark one and mark all behave correctly and marking is idempotent (commands 4, 5)', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  const a = (await notificationService.create({ userId: account.id, type: 'admin_alert', data: {} })).notification;
  const b = (await notificationService.create({ userId: account.id, type: 'admin_alert', data: {} })).notification;

  const marked = await markRead(account.token, String(a._id));
  assert.equal(marked.status, 200);
  assert.equal(marked.json.data.alreadyRead, false);
  assert.ok(marked.json.data.notification.readAt, 'readAt must be set');

  // Idempotent: the FIRST readAt is kept, not re-stamped.
  const firstReadAt = marked.json.data.notification.readAt;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const again = await markRead(account.token, String(a._id));
  assert.equal(again.status, 200);
  assert.equal(again.json.data.alreadyRead, true);
  assert.equal(
    new Date(again.json.data.notification.readAt).toISOString(),
    new Date(firstReadAt).toISOString(),
    'a repeat mark must keep the original readAt'
  );

  const count = await unreadCount(account.token);
  assert.equal(count.json.data.unreadCount, 1, 'b is still unread');

  const all = await markAllRead(account.token);
  assert.equal(all.status, 200);
  assert.equal(all.json.data.modifiedCount, 1, 'only b changes');
  const zero = await unreadCount(account.token);
  assert.equal(zero.json.data.unreadCount, 0);

  // Marking all again modifies nothing (idempotent).
  const allAgain = await markAllRead(account.token);
  assert.equal(allAgain.json.data.modifiedCount, 0);

  // b's row is unchanged and still the caller's.
  const rows = await rowsFor(account.id);
  assert.ok(rows.every((row) => row.readAt), 'every row is read after read-all');
  assert.ok(String(b._id));
});

test('G2.5 blocked pairs produce no notifications in either direction', async (t) => {
  if (!requireDb(t)) return;
  const a = await publishedAccount();
  const b = await publishedAccount();

  // A blocks B. The write goes through the real HTTP surface so the block row
  // is exactly what a user's request produces.
  const blocked = await api('/api/v1/blocks', { method: 'POST', token: a.token, body: { userId: b.id } });
  assert.equal(blocked.status, 201, `block: ${JSON.stringify(blocked.json)}`);

  // Service boundary: create() suppresses in BOTH directions — the rule is
  // bilateral (spec §22) even though only A wrote the block row.
  const aToB = await notificationService.create({
    userId: b.id,
    actorId: a.id,
    type: 'profile_view',
    data: { fromProfileId: a.publicProfileId }
  });
  assert.equal(aToB.notification, null);
  assert.equal(aToB.suppressed, true, 'A -> B must be suppressed');

  const bToA = await notificationService.create({
    userId: a.id,
    actorId: b.id,
    type: 'profile_view',
    data: { fromProfileId: b.publicProfileId }
  });
  assert.equal(bToA.notification, null);
  assert.equal(bToA.suppressed, true, 'B -> A must be suppressed even though B did not block');

  assert.equal((await rowsFor(a.id)).length, 0);
  assert.equal((await rowsFor(b.id)).length, 0);

  // End-to-end: an action between the blocked pair is refused outright by step
  // 10/12, so no event fires and no row appears. Unblock restores delivery
  // without any other change.
  const refused = await recordAction(b.token, { toUserId: a.id, type: 'view' });
  assert.ok(refused.status >= 400, `a blocked action must not succeed, got ${refused.status}`);
  assert.equal((await rowsFor(a.id)).length, 0);

  // A created the block, so A removes it — an unblock by the other side is a
  // 404 (ownership is a query predicate, step 12).
  const foreignUnblock = await api(`/api/v1/blocks/${b.publicProfileId}`, {
    method: 'DELETE',
    token: b.token
  });
  assert.equal(foreignUnblock.status, 404, 'the blocked account cannot remove a block it does not own');
  const unblock = await api(`/api/v1/blocks/${b.publicProfileId}`, { method: 'DELETE', token: a.token });
  assert.equal(unblock.status, 200);
  const view = await recordAction(b.token, { toUserId: a.id, type: 'view' });
  assert.equal(view.status, 201);
  const row = await waitFor(async () => (await rowsFor(a.id)).find((n) => n.type === 'profile_view'));
  assert.ok(row, 'after unblock the same event must deliver');
});

test('G2.6 repeated views coalesce into one row instead of flooding (task 6)', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount();
  const target = await publishedAccount();

  for (let i = 0; i < 5; i += 1) {
    await recordAction(actor.token, { toUserId: target.id, type: 'view' });
  }
  const rows = await waitFor(async () => {
    const found = await rowsFor(target.id);
    return found.filter((n) => n.type === 'profile_view').length >= 1 ? found : null;
  });
  assert.ok(rows, 'the coalesced row must appear');
  const views = rows.filter((n) => n.type === 'profile_view');
  assert.equal(views.length, 1, 'five views by one actor inside the window collapse to one row');

  // A different actor is a different row: coalescing is per (recipient, type,
  // actor), not a blanket cap.
  const other = await publishedAccount();
  await recordAction(other.token, { toUserId: target.id, type: 'view' });
  const two = await waitFor(async () => {
    const found = await rowsFor(target.id);
    return found.filter((n) => n.type === 'profile_view').length === 2 ? found : null;
  });
  assert.ok(two, 'a second actor must get their own row');

  // A coalesced repeat of an already-read row resets readAt: the newest signal
  // surfaces again in the badge.
  const victim = two.find((n) => n.type === 'profile_view' && String(n.data.fromProfileId) === actor.publicProfileId);
  await notificationService.markRead(target.id, String(victim._id));
  assert.equal((await unreadCount(target.token)).json.data.unreadCount, 1);
  await recordAction(actor.token, { toUserId: target.id, type: 'view' });
  const refreshed = await waitFor(async () => {
    const found = await Notification.findOne({ _id: victim._id }).lean();
    return found && found.readAt === null ? found : null;
  });
  assert.ok(refreshed, 'a repeat view must un-read the coalesced row');
  assert.equal((await rowsFor(target.id)).filter((n) => n.type === 'profile_view').length, 2, 'still one row per actor');

  // Outside the window a new row is allowed: backdate past NOTIFY_VIEW_THROTTLE_MIN.
  // Driver-level write on the same reason the service uses one — Mongoose strips
  // an explicit `createdAt` from any update.
  await Notification.collection.updateOne(
    { _id: victim._id },
    { $set: { createdAt: new Date(Date.now() - 20 * 60 * 1000) } }
  );
  await recordAction(actor.token, { toUserId: target.id, type: 'view' });
  const third = await waitFor(async () => {
    const found = await rowsFor(target.id);
    return found.filter((n) => n.type === 'profile_view').length === 3 ? found : null;
  });
  assert.ok(third, 'a view outside the throttle window must create a new row');
});

test('G2.7 accept produces exactly ONE new_match and reject exactly ONE interest_rejected (commands 2, 2b; decisions §9, §10)', async (t) => {
  if (!requireDb(t)) return;
  const sender = await publishedAccount();
  const responder = await publishedAccount();

  const sent = await sendInterest(sender.token, { toUserId: responder.id });
  assert.equal(sent.status, 201);
  const connectionId = String(sent.json.data.connection.id);

  const accepted = await respond(responder.token, connectionId, 'accept');
  assert.equal(accepted.status, 200, `accept: ${JSON.stringify(accepted.json)}`);

  // The receiver already has the interest_received row from the send; the
  // acceptance must add exactly ONE row for the sender, of type new_match.
  const senderRows = await waitFor(async () => {
    const found = await rowsFor(sender.id);
    return found.filter((n) => n.type === 'new_match').length >= 1 ? found : null;
  });
  assert.ok(senderRows, 'the sender must get the new_match row');
  const newMatch = senderRows.filter((n) => n.type === 'new_match');
  assert.equal(newMatch.length, 1, 'exactly ONE new_match row per acceptance — not two');
  assert.equal(newMatch[0].data.connectionId, connectionId);
  // No `interest_accepted` row exists anywhere: the domain event name and the
  // user-facing type are separate on purpose (decisions §9).
  assert.equal(
    await Notification.countDocuments({ type: 'interest_accepted' }),
    0,
    'there is no user-facing interest_accepted type'
  );
  // The responder gained nothing from accepting beyond the send's row.
  assert.equal(
    (await rowsFor(responder.id)).filter((n) => n.type === 'interest_received').length,
    1
  );

  // Rejection: a second pair, one row for the sender, no private data.
  const sender2 = await publishedAccount();
  const responder2 = await publishedAccount();
  const sent2 = await sendInterest(sender2.token, { toUserId: responder2.id });
  const rejected = await respond(responder2.token, String(sent2.json.data.connection.id), 'reject');
  assert.equal(rejected.status, 200);

  const rejectedRows = await waitFor(async () => {
    const found = await rowsFor(sender2.id);
    return found.filter((n) => n.type === 'interest_rejected').length >= 1 ? found : null;
  });
  assert.ok(rejectedRows, 'the sender must get the interest_rejected row');
  const rejections = rejectedRows.filter((n) => n.type === 'interest_rejected');
  assert.equal(rejections.length, 1, 'exactly ONE interest_rejected row');
  assert.deepEqual(
    Object.keys(rejections[0].data).sort(),
    ['connectionId'],
    'a rejection carries no private information — just the connection id'
  );
});

// ---------------------------------------------------------------------------
// Gate 3 — security
// ---------------------------------------------------------------------------

test('G3.1 no account can read or modify another account’s notifications (command 6)', async (t) => {
  if (!requireDb(t)) return;
  const owner = await freshAccount();
  const outsider = await freshAccount();
  const row = (await notificationService.create({ userId: owner.id, type: 'admin_alert', data: {} })).notification;

  // Mark-one by another account is a 404 — never a 403 that would confirm the
  // row exists (spec §44).
  const marked = await markRead(outsider.token, String(row._id));
  assert.equal(marked.status, 404);
  // And it did not flip the owner's row.
  assert.ok((await Notification.findOne({ _id: row._id }).lean()).readAt === null);

  // The outsider's inbox is empty; the owner's is not.
  const theirs = await inbox(outsider.token);
  assert.equal(theirs.json.data.items.length, 0);
  const mine = await inbox(owner.token);
  assert.equal(mine.json.data.items.length, 1);

  // Mark-all scopes to the caller: the outsider's read-all leaves the owner
  // untouched.
  await markAllRead(outsider.token);
  assert.ok((await Notification.findOne({ _id: row._id }).lean()).readAt === null);
});

test('G3.2 a client-supplied userId cannot redirect a notification or its read state', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  const other = await freshAccount();

  // The recipient is always req.auth.userId: a query userId is a 400 and no
  // row is created for the named account.
  const spoofList = await inbox(account.token, `?userId=${other.id}`);
  assert.equal(spoofList.status, 400);
  const spoofCount = await unreadCount(account.token, `?userId=${other.id}`);
  assert.equal(spoofCount.status, 400);

  // read-all with a body naming another account is a 400, not an ignored field.
  const spoofBody = await markAllRead(account.token);
  assert.equal(spoofBody.status, 200, 'read-all with no body is fine');
  const res = await api('/api/v1/notifications/read-all', {
    method: 'PATCH',
    token: account.token,
    body: { userId: other.id }
  });
  assert.equal(res.status, 400, 'a body-supplied userId must be refused by the strict schema');

  // There is no user-reachable create surface at all (spec §24).
  const post = await api('/api/v1/notifications', {
    method: 'POST',
    token: account.token,
    body: { userId: other.id, type: 'admin_alert' }
  });
  assert.equal(post.status, 404);
});

test('G3.3 / G5.5 the serialiser exposes only named fields — no identity or admin data (task 10)', async (t) => {
  if (!requireDb(t)) return;
  const actor = await publishedAccount();
  const target = await publishedAccount();
  await recordAction(actor.token, { toUserId: target.id, type: 'view' });
  const row = await waitFor(async () => (await rowsFor(target.id)).find((n) => n.type === 'profile_view'));
  assert.ok(row);

  const listed = await inbox(target.token);
  const item = listed.json.data.items[0];
  assert.deepEqual(
    Object.keys(item).sort(),
    ['body', 'createdAt', 'data', 'id', 'readAt', 'title', 'type'],
    'the DTO is exactly the serialised field set'
  );
  assert.ok(!('userId' in item), 'the recipient id is never echoed');
  assert.ok(!('updatedAt' in item), 'no internal timestamp leaks');
  assert.ok(!('reporterId' in item) && !('reviewedBy' in item), 'no moderation identity leaks');

  const marked = await markRead(target.token, item.id);
  assert.deepEqual(
    Object.keys(marked.json.data.notification).sort(),
    ['body', 'createdAt', 'data', 'id', 'readAt', 'title', 'type'],
    'mark-one returns the same DTO, nothing more'
  );
});

test('G3.4 data payloads carry identifiers only, never copied content (spec §24)', async (t) => {
  if (!requireDb(t)) return;
  const sender = await publishedAccount();
  const receiver = await publishedAccount();
  const sent = await sendInterest(sender.token, { toUserId: receiver.id });
  const row = await waitFor(async () =>
    (await rowsFor(receiver.id)).find((n) => n.type === 'interest_received')
  );
  assert.ok(row);
  const keys = Object.keys(row.data).sort();
  assert.deepEqual(keys, ['connectionId', 'fromProfileId'], 'identifiers only');
  for (const value of Object.values(row.data)) {
    assert.equal(typeof value, 'string');
    assert.ok(String(value).length <= 64, 'an identifier, not a document');
  }
  // And nothing resembling the connection document rode along.
  assert.ok(!('message' in row.data), 'the interest note is not copied into the notification');
  assert.ok(!('status' in row.data));
  assert.ok(sent);
});

test('G3.5 malformed ObjectIds are rejected before any query', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  const bad = await markRead(account.token, 'not-an-id');
  assert.equal(bad.status, 400);
  const shaped = await markRead(account.token, '[$ne]');
  assert.equal(shaped.status, 400);
  const badType = await inbox(account.token, '?type=explode');
  assert.equal(badType.status, 400);
  const badCursor = await inbox(account.token, '?cursor=zzz');
  assert.equal(badCursor.status, 400);
});

test('G3.6 the mark-read rate limit triggers (spec §36)', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  const row = (await notificationService.create({ userId: account.id, type: 'admin_alert', data: {} })).notification;

  // NOTIFY_RATE_LIMIT_MAX=8 per account per window, shared by mark-one and
  // mark-all (both are writes against the badge).
  let sawLimit = false;
  for (let i = 0; i < 12; i += 1) {
    const res = i % 2 === 0 ? await markRead(account.token, String(row._id)) : await markAllRead(account.token);
    if (res.status === 429) {
      sawLimit = true;
      break;
    }
  }
  assert.ok(sawLimit, 'hammering mark-read must hit 429');

  // A different account is unaffected: the bucket is keyed per account.
  const other = await freshAccount();
  const fine = await markAllRead(other.token);
  assert.equal(fine.status, 200);
});

// ---------------------------------------------------------------------------
// Gate 4 — performance & data
// ---------------------------------------------------------------------------

test('G4.1 the inbox query is index-backed (IXSCAN)', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  const plan = await Notification.find({ userId: account.id })
    .sort({ createdAt: -1, _id: -1 })
    .explain('queryPlanner');
  const winning = JSON.stringify(plan.queryPlanner.winningPlan);
  assert.ok(winning.includes('IXSCAN'), `the inbox must use userId_1_createdAt_-1__id_-1, got ${winning}`);
  assert.ok(!winning.includes('COLLSCAN'));
});

test('G4.2 the unread count is index-backed rather than a scan (IXSCAN)', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  const plan = await Notification.find({ userId: account.id, readAt: null }).explain('queryPlanner');
  const winning = JSON.stringify(plan.queryPlanner.winningPlan);
  assert.ok(winning.includes('IXSCAN'), `the unread query must use userId_1_readAt_1, got ${winning}`);
});

test('G4.3 no notification embeds a profile or message document', async (t) => {
  if (!requireDb(t)) return;
  const sender = await publishedAccount();
  const receiver = await publishedAccount();
  await sendInterest(sender.token, { toUserId: receiver.id });
  const row = await waitFor(async () =>
    (await rowsFor(receiver.id)).find((n) => n.type === 'interest_received')
  );
  assert.ok(row);
  // The whole document is small and flat: title + body + identifier strings.
  const json = JSON.stringify(row);
  assert.ok(json.length < 1200, `the row must stay small, got ${json.length} bytes`);
  assert.ok(!json.includes('dateOfBirth'), 'no profile field is copied in');
  assert.ok(!json.includes('email'));
  assert.ok(!json.includes('phone'));
});

test('G4.4 a notification failure never blocks the originating request (decisions §16)', async (t) => {
  if (!requireDb(t)) return;
  // The handlers run detached (a microtask after the emit), so a handler that
  // throws cannot fail or delay the write that produced the event. Register a
  // throwing handler for `like` — a type with no default mapping — emit, and
  // prove both that the emit returned synchronously and that nothing crashed.
  let ran = false;
  const boom = async () => {
    ran = true;
    throw new Error('handler exploded');
  };
  notificationEvents.registerActionHandler('like', boom);

  let unhandled = 0;
  const onUnhandled = () => {
    unhandled += 1;
  };
  process.on('unhandledRejection', onUnhandled);
  try {
    const event = {
      type: 'like',
      fromUserId: new mongoose.Types.ObjectId(),
      toUserId: new mongoose.Types.ObjectId(),
      at: new Date(),
      created: true
    };
    actionService.events.emit('action', event);
    // The emit is synchronous and the handler has not run yet: the originating
    // request is never extended by notification work.
    assert.equal(ran, false, 'the handler must be detached from the emit');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(ran, true, 'the handler still runs, just not inline');
    assert.equal(unhandled, 0, 'a throwing handler must be swallowed and logged, never crash the process');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    notificationEvents.actionHandlers.delete('like');
  }
});

// ---------------------------------------------------------------------------
// Gate 5 — spec conformance
// ---------------------------------------------------------------------------

test('G5.1 §24 — the schema type set is exactly the specification’s nine types', () => {
  const enumValues = Notification.schema.path('type').enumValues;
  assert.deepEqual([...enumValues].sort(), [...NOTIFICATION_TYPES].sort());
  assert.equal(NOTIFICATION_TYPES.length, 9);
});

test('G5.1 the default copy renders every type with no undefined text', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  for (const type of NOTIFICATION_TYPES) {
    const { title, body } = notificationService.renderCopy(type, {});
    assert.ok(title && body, `${type} must have copy`);
    assert.ok(!body.includes('undefined'), `${type} body must not render "undefined": ${body}`);
  }
  // A named actor is substituted once and bounded.
  const named = notificationService.renderCopy('profile_view', { name: 'Aarohi' });
  assert.ok(named.body.includes('Aarohi'));
  const long = notificationService.renderCopy('profile_view', { name: 'x'.repeat(200) });
  assert.ok(!long.body.includes('x'.repeat(61)), 'a name substitution is capped');
  assert.ok(account);
});

test('G5.3 §22 — the suppression hook is the block service itself, consulted before every peer write', async (t) => {
  if (!requireDb(t)) return;
  // Structural: the mapping calls create() with an actorId for every peer type,
  // and create() consults canNotify. Here we verify the observable contract for
  // each peer type against a blocked pair, so a future type added without the
  // actor cannot silently bypass the rule.
  const a = await publishedAccount();
  const b = await publishedAccount();
  const blockRes = await api('/api/v1/blocks', {
    method: 'POST',
    token: a.token,
    body: { publicProfileId: b.publicProfileId }
  });
  assert.equal(blockRes.status, 201, `block: ${JSON.stringify(blockRes.json)}`);

  for (const type of NOTIFICATION_TYPES) {
    if (!NOTIFICATION_TYPE_SET.has(type)) continue;
    const result = await notificationService.create({
      userId: b.id,
      actorId: a.id,
      type,
      data: { connectionId: String(new mongoose.Types.ObjectId()) }
    });
    // Peer types are suppressed; admin types (no peer actor) still deliver.
    const isPeer = [
      'interest_received',
      'interest_accepted',
      'interest_rejected',
      'new_match',
      'new_message',
      'profile_view',
      'shortlisted'
    ].includes(type);
    if (isPeer) {
      assert.equal(result.notification, null, `${type} must be suppressed between a blocked pair`);
      assert.equal(result.suppressed, true);
    }
  }
  // Everything delivered to the blocked recipient is admin-originated: the two
  // types with no peer actor. No peer type left a row.
  const rows = await rowsFor(b.id);
  assert.deepEqual(
    rows.map((row) => row.type).sort(),
    ['admin_alert', 'verification_completed'],
    'a blocked recipient gets nothing from the blocking peer; admin-originated types still deliver'
  );
});

test('G5.2 §24 — the list is never unbounded even with no cursor and no limit', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  for (let i = 0; i < 6; i += 1) {
    await notificationService.create({ userId: account.id, type: 'admin_alert', data: { seq: i } });
  }
  const res = await inbox(account.token);
  assert.equal(res.json.data.items.length, 2, 'the default limit applies without a query');
  assert.ok(res.json.data.nextCursor);
});

test('G5.1 the subscription is active on load and registering a new mapping works without editing the core (task 4)', async (t) => {
  if (!requireDb(t)) return;
  assert.equal(notificationEvents.isSubscribed(), true, 'app.js subscribes on load');

  // Step 16's shape: register a handler for a type the core does not map, emit
  // the domain event, and the notification lands — no edit to this step's files.
  const account = await freshAccount();
  const verificationId = String(new mongoose.Types.ObjectId());
  notificationEvents.registerConnectionHandler('verification_completed', async (event) => {
    await notificationService.create({
      userId: event.userId,
      type: 'verification_completed',
      data: { verificationId: event.verificationId }
    });
  });
  try {
    connectionService.events.emit('connection', {
      type: 'verification_completed',
      userId: account.id,
      verificationId
    });
    const row = await waitFor(async () =>
      (await rowsFor(account.id)).find((n) => n.type === 'verification_completed')
    );
    assert.ok(row, 'an externally registered mapping must deliver');
    assert.equal(row.data.verificationId, verificationId);
  } finally {
    notificationEvents.connectionHandlers.delete('verification_completed');
  }
});
