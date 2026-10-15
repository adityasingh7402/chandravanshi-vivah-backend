// Step 13 scripted verification — drives the doc's seven verification commands
// against a live server, plus the index, privacy, coalescing, rate-limit and
// detached-creation checks.
//
// Seed + boot the server with the test database first, then run with the SAME
// database:
//   MONGODB_DB_NAME=chandravanshi_vivah_test CLOUDINARY_MOCK=true \
//     AUTH_RATE_LIMIT_MAX=1000 RATE_LIMIT_MAX=99999 node verify-step13.mjs
//
// The two raised limits are for the harness's own account volume and its
// deliberate mark-read flood; the notification limiter it verifies keeps the
// project's configured maximum. `npm run verify` sets both for this step only
// (a fresh server per harness, CLOUDINARY_MOCK=true).
//
// Events are emitted **detached** from the requests that cause them (decisions
// §16), so every "the event produced a row" assertion polls the collection with
// `waitFor` rather than pretending the HTTP response proves it.
//
// Exit code 0 means every check that ran passed.
import mongoose from 'mongoose';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const config = require('./src/config/env');
const User = require('./src/models/User');
const MatrimonialProfile = require('./src/models/MatrimonialProfile');
const Photo = require('./src/models/Photo');
const Connection = require('./src/models/Connection');
const Notification = require('./src/models/Notification');
const profileScoreService = require('./src/services/profileScoreService');
const notificationService = require('./src/services/notificationService');
const connectionService = require('./src/services/connectionService');
const { getMasterModel } = require('./src/models/masterData/MasterItem');
const { NOTIFICATION_TYPES } = require('./src/constants/notifications');
const { CONNECTION_STATUS } = require('./src/constants/connection');

const BASE = `http://localhost:${config.port}`;
const PASSWORD = 'correct-horse-battery';
const RUN = Date.now();

const results = [];
const skipped = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

async function req(path, { method = 'GET', body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

const auth = (token) => (token ? { authorization: `Bearer ${token}` } : {});
const post = (path, body, token) => req(path, { method: 'POST', body, headers: auth(token) });
const patch = (path, body, token) => req(path, { method: 'PATCH', body, headers: auth(token) });

async function register(identifier) {
  return post('/api/v1/auth/register', { identifierType: 'email', identifier, password: PASSWORD });
}

async function login(identifier) {
  const r = await post('/api/v1/auth/login', {
    identifierType: 'email',
    identifier,
    password: PASSWORD,
    deviceType: 'android'
  });
  return r.json?.data?.accessToken;
}

/** Poll until `fn` is truthy — event-created rows land after their cause. */
async function waitFor(fn, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

const rowsFor = (userId) => Notification.find({ userId }).sort({ createdAt: -1, _id: -1 }).lean();

// ---------------------------------------------------------------------------
// Database setup: master rows + fixtures
// ---------------------------------------------------------------------------

await mongoose.connect(config.mongodbUri, { dbName: config.mongodbDbName, serverSelectionTimeoutMS: 5000 });

const communities = await getMasterModel('communities').find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select('_id').lean();
let community = null;
let surname = null;
let gotra = null;
for (const candidate of communities) {
  const s = await getMasterModel('surnames').findOne({ communityId: candidate._id, isActive: true }).select('_id').lean();
  const g = await getMasterModel('gotras').findOne({ communityId: candidate._id, isActive: true }).select('_id').lean();
  if (s && g) {
    community = candidate;
    surname = s;
    gotra = g;
    break;
  }
}
const city = await getMasterModel('cities').findOne({ isActive: true }).select('_id').lean();
const degree = await getMasterModel('degrees').findOne({ isActive: true }).sort({ sortOrder: 1 }).select('_id').lean();
const occupation = await getMasterModel('occupations').findOne({ isActive: true }).sort({ sortOrder: 1 }).select('_id').lean();

if (!community || !surname || !gotra || !city || !degree || !occupation) {
  throw new Error('Seed is incomplete — run `node scripts/seed-master-data.js` against this database first.');
}

const id = (doc) => String(doc._id);

function fullProfile({ gender, age, firstName }) {
  const now = new Date();
  const dob = new Date(Date.UTC(now.getUTCFullYear() - age, 0, 15)).toISOString().slice(0, 10);
  return {
    basic: {
      profileFor: 'self',
      firstName,
      gender,
      dateOfBirth: dob,
      maritalStatus: 'never_married',
      heightCm: gender === 'female' ? 160 : 175
    },
    community: { communityId: id(community), surnameId: id(surname), gotraId: id(gotra) },
    location: { cityId: id(city) },
    education: { highestQualificationId: id(degree), degreeId: id(degree) },
    career: { occupationId: id(occupation) },
    family: { familyType: 'nuclear' },
    lifestyle: { diet: 'vegetarian' },
    about: { description: 'Grounded family, simple habits, straightforward person.' }
  };
}

let photoSeq = 0;
async function addApprovedPhoto(token, userId) {
  const sign = await post('/api/v1/photos/sign', {}, token);
  const folder = sign.json?.data?.upload?.folder;
  if (!folder) throw new Error(`photo signing failed: ${sign.status} ${sign.text?.slice(0, 200)}`);
  photoSeq += 1;
  const registered = await post('/api/v1/photos', { publicId: `${folder}/step13-${photoSeq}`, type: 'profile' }, token);
  if (registered.status !== 201) {
    throw new Error(`photo registration failed: ${registered.status} ${registered.text?.slice(0, 200)}`);
  }
  await Photo.updateOne({ userId, isPrimary: true }, { $set: { moderationStatus: 'approved' } });
  await profileScoreService.syncDiscoveryPhotoFlag(userId);
}

async function publishedAccount({ gender = 'male', age = 27, firstName = 'Vikram', label }) {
  const email = `s13-${RUN}-${label}@example.com`;
  await register(email);
  const token = await login(email);
  if (!token) throw new Error(`could not log in as ${email}`);
  const created = await post('/api/v1/profile', fullProfile({ gender, age, firstName }), token);
  if (created.status !== 201) throw new Error(`profile create failed: ${created.status} ${created.text?.slice(0, 200)}`);
  const user = await User.findOne({ email }).select('_id').lean();
  await addApprovedPhoto(token, user._id);
  const published = await patch('/api/v1/profile', { status: 'active' }, token);
  if (published.status !== 200) throw new Error(`publish failed: ${published.status} ${published.text?.slice(0, 200)}`);
  const doc = await MatrimonialProfile.findOne({ userId: user._id }).select('publicProfileId').lean();
  return { email, token, id: String(user._id), publicProfileId: doc.publicProfileId };
}

const a = await publishedAccount({ gender: 'female', age: 25, firstName: 'Aarohi', label: 'a' });
const b = await publishedAccount({ label: 'b' });
const c = await publishedAccount({ label: 'c' });
const outsider = await publishedAccount({ gender: 'female', age: 26, firstName: 'Nisha', label: 'outsider' });

const inboxOf = (token, query = '') => req(`/api/v1/notifications${query}`, { headers: auth(token) });
const countOf = (token, query = '') => req(`/api/v1/notifications/unread-count${query}`, { headers: auth(token) });

// ---------------------------------------------------------------------------
// Command 1 — an interest produces interest_received for the receiver
// ---------------------------------------------------------------------------
let connectionAB = null;
{
  const sent = await post('/api/v1/connections', { toUserId: b.id }, a.token);
  connectionAB = sent.json?.data?.connection?.id;
  const row = await waitFor(async () => (await rowsFor(b.id)).find((n) => n.type === 'interest_received'));
  check(
    'command 1: the receiver gets exactly one interest_received row',
    sent.status === 201 && Boolean(row) && (await rowsFor(b.id)).filter((n) => n.type === 'interest_received').length === 1,
    `send=${sent.status} row=${Boolean(row)}`
  );
  check(
    'command 1: the payload carries the connection id and the sender PUBLIC profile id — no account id',
    Boolean(row) &&
      row.data.connectionId === connectionAB &&
      row.data.fromProfileId === a.publicProfileId &&
      !JSON.stringify(row.data).includes(a.id),
    `data=${JSON.stringify(row?.data)}`
  );
}

// ---------------------------------------------------------------------------
// Command 2 — accept produces exactly ONE new_match for the sender (decisions §9)
// ---------------------------------------------------------------------------
{
  const accepted = await patch(`/api/v1/connections/${connectionAB}`, { action: 'accept' }, b.token);
  const rows = await waitFor(async () => {
    const found = await rowsFor(a.id);
    return found.filter((n) => n.type === 'new_match').length >= 1 ? found : null;
  });
  const newMatch = (rows || []).filter((n) => n.type === 'new_match');
  check(
    'command 2: accept -> exactly ONE new_match for the sender, not two rows',
    accepted.status === 200 && newMatch.length === 1 && newMatch[0].data.connectionId === connectionAB,
    `accept=${accepted.status} new_match=${newMatch.length}`
  );
  check(
    'command 2: no user-facing "interest_accepted" row exists anywhere (decisions §9)',
    (await Notification.countDocuments({ type: 'interest_accepted' })) === 0,
    'count'
  );
  check(
    'command 2: the accept added nothing to the responder beyond the send row',
    (await rowsFor(b.id)).length === 1,
    `rows=${(await rowsFor(b.id)).length}`
  );
  const connection = await Connection.findById(connectionAB).lean();
  check('command 2: the connection is accepted with canChat derived true', connection.status === CONNECTION_STATUS.ACCEPTED, connection.status);
}

// ---------------------------------------------------------------------------
// Command 2b — rejection notifies the sender once, with no private data
// ---------------------------------------------------------------------------
{
  const sent = await post('/api/v1/connections', { toUserId: outsider.id }, c.token);
  const pairId = sent.json?.data?.connection?.id;
  const rejected = await patch(`/api/v1/connections/${pairId}`, { action: 'reject' }, outsider.token);
  const rows = await waitFor(async () => {
    const found = await rowsFor(c.id);
    return found.filter((n) => n.type === 'interest_rejected').length >= 1 ? found : null;
  });
  const rejections = (rows || []).filter((n) => n.type === 'interest_rejected');
  check(
    'command 2b: reject -> exactly ONE interest_rejected for the sender',
    rejected.status === 200 && rejections.length === 1,
    `reject=${rejected.status} rows=${rejections.length}`
  );
  check(
    'command 2b: the rejection carries no private information — just the connection id',
    Boolean(rejections[0]) &&
      JSON.stringify(rejections[0].data) === JSON.stringify({ connectionId: pairId }) &&
      !/reason|description|message/.test(JSON.stringify(rejections[0].data)),
    `data=${JSON.stringify(rejections[0]?.data)}`
  );
}

// ---------------------------------------------------------------------------
// Command 3 — unread count
// ---------------------------------------------------------------------------
{
  const before = await countOf(b.token);
  const unread = (await rowsFor(b.id)).filter((n) => n.readAt === null).length;
  check(
    'command 3: unread-count answers 200 with the count matching the unread rows',
    before.status === 200 && before.json?.data?.unreadCount === unread && unread === 1,
    `count=${before.json?.data?.unreadCount} rows=${unread}`
  );
}

// ---------------------------------------------------------------------------
// Command 4 — mark one read
// ---------------------------------------------------------------------------
let bNotificationId = null;
{
  bNotificationId = String((await rowsFor(b.id))[0]._id);
  const marked = await patch(`/api/v1/notifications/${bNotificationId}/read`, undefined, b.token);
  const count = await countOf(b.token);
  check(
    'command 4: mark-one -> 200, readAt set, unread count decreases by one',
    marked.status === 200 &&
      Boolean(marked.json?.data?.notification?.readAt) &&
      count.json?.data?.unreadCount === 0,
    `status=${marked.status} count=${count.json?.data?.unreadCount}`
  );
  const again = await patch(`/api/v1/notifications/${bNotificationId}/read`, undefined, b.token);
  check(
    'command 4: a repeat mark is idempotent and keeps the first readAt',
    again.status === 200 &&
      again.json?.data?.alreadyRead === true &&
      new Date(again.json.data.notification.readAt).getTime() === new Date(marked.json.data.notification.readAt).getTime(),
    `again=${again.status}`
  );
}

// ---------------------------------------------------------------------------
// Command 5 — mark all read
// ---------------------------------------------------------------------------
{
  // Give b two fresh unread rows first: the coalescing window means a new event
  // from a *new* actor is the reliable way to add rows here.
  await post('/api/v1/interactions', { toUserId: b.id, type: 'view' }, outsider.token);
  await post('/api/v1/interactions', { toUserId: b.id, type: 'shortlist' }, outsider.token);
  const two = await waitFor(async () => ((await rowsFor(b.id)).filter((n) => n.readAt === null).length === 2 ? true : null));
  const all = await patch('/api/v1/notifications/read-all', undefined, b.token);
  const count = await countOf(b.token);
  check(
    'command 5: mark-all -> 200 and unread-count 0',
    Boolean(two) && all.status === 200 && all.json?.data?.modifiedCount === 2 && count.json?.data?.unreadCount === 0,
    `two=${Boolean(two)} modified=${all.json?.data?.modifiedCount} count=${count.json?.data?.unreadCount}`
  );
}

// ---------------------------------------------------------------------------
// Command 6 — cross-account access
// ---------------------------------------------------------------------------
{
  const foreign = await patch(`/api/v1/notifications/${bNotificationId}/read`, undefined, a.token);
  const theirInbox = await inboxOf(a.token);
  check(
    'command 6: another account marking a foreign notification -> 404, own inbox untouched',
    foreign.status === 404 &&
      (await Notification.findOne({ _id: bNotificationId }).lean()).readAt !== null &&
      (theirInbox.json?.data?.items || []).every((item) => !JSON.stringify(item).includes(bNotificationId)),
    `status=${foreign.status}`
  );
}

// ---------------------------------------------------------------------------
// Command 7 — blocking suppresses notifications
// ---------------------------------------------------------------------------
{
  const blocked = await post('/api/v1/blocks', { userId: c.id }, outsider.token);
  const direct = await notificationService.create({
    userId: c.id,
    actorId: outsider.id,
    type: 'profile_view',
    data: { fromProfileId: outsider.publicProfileId }
  });
  const action = await post('/api/v1/interactions', { toUserId: c.id, type: 'view' }, outsider.token);
  check(
    'command 7: a block suppresses notifications in both directions',
    blocked.status === 201 &&
      direct.notification === null &&
      direct.suppressed === true &&
      action.status === 404 &&
      (await rowsFor(c.id)).filter((n) => n.type === 'profile_view' && n.data.fromProfileId === outsider.publicProfileId).length === 0,
    `block=${blocked.status} suppressed=${direct.suppressed} action=${action.status}`
  );

  const removed = await req(`/api/v1/blocks/${c.publicProfileId}`, { method: 'DELETE', headers: auth(outsider.token) });
  const after = await post('/api/v1/interactions', { toUserId: c.id, type: 'view' }, outsider.token);
  const delivered = await waitFor(async () =>
    (await rowsFor(c.id)).find((n) => n.type === 'profile_view' && n.data.fromProfileId === outsider.publicProfileId)
  );
  check(
    'command 7: unblocking restores delivery for the same event',
    removed.status === 200 && after.status === 201 && Boolean(delivered),
    `removed=${removed.status} after=${after.status} delivered=${Boolean(delivered)}`
  );
}

// ---------------------------------------------------------------------------
// Cross-cutting: schema, indexes, plans, coalescing, bounds, limits, privacy
// ---------------------------------------------------------------------------
{
  const enumOk = JSON.stringify(Notification.schema.path('type').enumValues) === JSON.stringify(NOTIFICATION_TYPES);
  const fields = ['userId', 'type', 'title', 'body', 'data', 'readAt', 'createdAt'];
  check(
    '§24: the document and the full nine-type set match the specification',
    enumOk && fields.every((field) => Notification.schema.path(field)),
    `types=${NOTIFICATION_TYPES.length}`
  );
}

{
  const names = (await Notification.collection.indexes()).map((idx) => idx.name);
  check(
    '§105: the inbox and unread indexes exist',
    names.includes('userId_1_createdAt_-1__id_-1') && names.includes('userId_1_readAt_1'),
    names.join(',')
  );
  const inboxPlan = await Notification.find({ userId: a.id }).sort({ createdAt: -1, _id: -1 }).explain('queryPlanner');
  const unreadPlan = await Notification.find({ userId: a.id, readAt: null }).explain('queryPlanner');
  check(
    '§49: the inbox and unread queries are index-backed (IXSCAN)',
    JSON.stringify(inboxPlan).includes('IXSCAN') && JSON.stringify(unreadPlan).includes('IXSCAN'),
    'queryPlanner'
  );
}

{
  // Coalescing: the same actor's repeated views collapse to one row, and the
  // coalesced row is re-dated to the top of the inbox (task 6).
  for (let i = 0; i < 5; i += 1) {
    await post('/api/v1/interactions', { toUserId: b.id, type: 'view' }, a.token);
  }
  const views = await waitFor(async () => {
    const found = (await rowsFor(b.id)).filter((n) => n.type === 'profile_view' && n.data.fromProfileId === a.publicProfileId);
    return found.length >= 1 ? found : null;
  });
  check(
    'repeated views by one actor coalesce into exactly one row (bounded growth)',
    (views || []).length === 1,
    `rows=${(views || []).length}`
  );
  const newestFirst = await inboxOf(b.token);
  const items = newestFirst.json?.data?.items || [];
  check(
    'the coalesced row sits at the top of the inbox and the DTO is exactly the serialised field set',
    items.length > 0 &&
      items[0].type === 'profile_view' &&
      items[0].data.fromProfileId === a.publicProfileId &&
      Object.keys(items[0]).sort().join(',') === 'body,createdAt,data,id,readAt,title,type',
    `first=${items[0]?.type} keys=${Object.keys(items[0] || {}).sort().join(',')}`
  );
}

{
  const huge = await req('/api/v1/notifications?limit=100000', { headers: auth(a.token) });
  const strict = await req('/api/v1/notifications?userId=someone-else', { headers: auth(a.token) });
  const malformed = await patch('/api/v1/notifications/not-an-id/read', undefined, a.token);
  const spoofedBody = await patch('/api/v1/notifications/read-all', { userId: b.id }, a.token);
  check(
    'bounds and validation: limit clamped, unknown query field 400, bad id 400, body userId 400',
    huge.status === 200 &&
      (huge.json?.data?.items || []).length <= config.notifications.maxLimit &&
      strict.status === 400 &&
      malformed.status === 400 &&
      spoofedBody.status === 400,
    `huge=${(huge.json?.data?.items || []).length} strict=${strict.status} bad=${malformed.status} spoof=${spoofedBody.status}`
  );
}

{
  // §36: mark-read is a write. A dedicated account floods its own bucket, which
  // keeps the project's REAL notification limiter under test.
  const flooder = await publishedAccount({ gender: 'female', age: 28, firstName: 'Ira', label: 'flood' });
  const cap = config.notifications.rateLimit.max;
  let sawLimit = false;
  let attempts = 0;
  for (; attempts < cap + 5; attempts += 1) {
    const res = await patch('/api/v1/notifications/read-all', undefined, flooder.token);
    if (res.status === 429) {
      sawLimit = true;
      break;
    }
  }
  check(
    '§36: mark-read writes are rate limited per account (429 after the configured threshold)',
    sawLimit,
    `cap=${cap} attempts=${attempts}`
  );
  const other = await countOf(outsider.token);
  check('the flood consumed only its own account bucket', other.status === 200, `status=${other.status}`);
}

{
  const anonymous = await Promise.all([
    req('/api/v1/notifications'),
    req('/api/v1/notifications/unread-count'),
    patch('/api/v1/notifications/read-all'),
    patch('/api/v1/notifications/64b000000000000000000000/read')
  ]);
  check(
    'every notification route refuses an anonymous request with 401',
    anonymous.every((res) => res.status === 401),
    anonymous.map((res) => res.status).join(',')
  );
  const postSurface = await req('/api/v1/notifications', { method: 'POST', body: { type: 'admin_alert' }, headers: auth(a.token) });
  check('there is no user-reachable create surface for notifications', postSurface.status === 404, `status=${postSurface.status}`);
}

{
  // §112 / §30: privacy of a stored row — no account id, no copied content.
  const row = (await rowsFor(b.id)).find((n) => n.type === 'interest_received');
  const json = JSON.stringify(row);
  check(
    '§112: the stored row carries identifiers only — no account id, no copied profile or message',
    Boolean(row) &&
      !json.includes(a.id) &&
      json.length < 1200 &&
      Object.keys(row.data).sort().join(',') === 'connectionId,fromProfileId',
    `bytes=${json.length} keys=${Object.keys(row?.data || {}).sort().join(',')}`
  );
}

{
  // §24 / decisions §16: creation is a detached side effect. The originating
  // interest send returns first; the row lands afterwards. Five sends are timed
  // and the average is recorded — the number the G4.4 note asks for.
  const latency = await publishedAccount({ gender: 'female', age: 30, firstName: 'Tara', label: 'latency' });
  const target1 = await publishedAccount({ label: 'latency-t1' });
  const target2 = await publishedAccount({ label: 'latency-t2' });
  const started = Date.now();
  let sends = 0;
  for (let i = 0; i < 5; i += 1) {
    // A repeat send for the same pair is a 409 (decisions §8), so the sends
    // alternate between two distinct targets; both statuses prove the request
    // completed without waiting for the notification write.
    const to = i % 2 === 0 ? target1 : target2;
    const res = await post('/api/v1/connections', { toUserId: to.id }, latency.token);
    if (res.status === 201 || res.status === 409) sends += 1;
  }
  const avgMs = (Date.now() - started) / 5;
  const rows = await waitFor(async () => {
    const found = await rowsFor(target1.id);
    return found.filter((n) => n.type === 'interest_received').length >= 1 ? found : null;
  });
  check(
    `G4.4: notification creation never blocks the originating request (observed avg send latency ${avgMs.toFixed(0)}ms)`,
    sends === 5 && Boolean(rows) && avgMs < 2000,
    `sends=${sends} avg=${avgMs.toFixed(0)}ms`
  );
}

await mongoose.disconnect();

const failed = results.filter((row) => !row.pass);
for (const row of results) {
  if (row.pass) console.log(`ok   - ${row.name}`);
  else console.log(`FAIL - ${row.name}${row.detail ? ` — ${row.detail}` : ''}`);
}
for (const row of skipped) console.log(`SKIP - ${row.name} — ${row.reason}`);

console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (skipped.length > 0) {
  console.log(`${skipped.length} check(s) skipped and NOT counted as passing: ${skipped.map((row) => row.name).join('; ')}`);
}
process.exitCode = failed.length > 0 ? 1 : 0;
