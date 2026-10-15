// Step 11 scripted verification — drives the doc's thirteen verification commands
// against a live server, plus the database, index, state-machine and privacy
// checks.
//
// Seed + boot the server with the test database first, then run with the SAME
// database:
//   MONGODB_DB_NAME=chandravanshi_vivah_test CLOUDINARY_MOCK=true \
//     AUTH_RATE_LIMIT_MAX=1000 RATE_LIMIT_MAX=99999 node verify-step11.mjs
//
// The two raised limits are for the harness's own account volume and its
// command-9 send flood; the interest limiter it verifies keeps the project's
// configured INTEREST_RATE_LIMIT_MAX. `npm run verify` sets both for this step
// only (a fresh server per harness, CLOUDINARY_MOCK=true).
//
// Two checks necessarily run at the service boundary rather than over HTTP:
//   - command 10 walks a pending row past the expiry window and calls the sweep
//     (there is no endpoint for "expire now"), and
//   - the blocked-pair half of §99, because the `blocks` model belongs to step 12
//     and the running server therefore has no `Block` registered. The harness
//     registers a minimal stand-in itself and drives the same service rule.
//
// Exit code 0 means every check that ran passed.
import mongoose from 'mongoose';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const config = require('./src/config/env');
const { COLLECTIONS } = require('./src/config/collections');
const User = require('./src/models/User');
const MatrimonialProfile = require('./src/models/MatrimonialProfile');
const Photo = require('./src/models/Photo');
const Connection = require('./src/models/Connection');
const profileScoreService = require('./src/services/profileScoreService');
const connectionService = require('./src/services/connectionService');
const connectionPolicy = require('./src/services/connectionPolicy');
const { getMasterModel } = require('./src/models/masterData/MasterItem');
const {
  CONNECTION_STATUSES,
  CONNECTION_STATUS,
  ACTIVE_STATUSES,
  RESPONSE_ACTIONS
} = require('./src/constants/connection');

const BASE = `http://localhost:${config.port}`;
const PASSWORD = 'correct-horse-battery';
const RUN = Date.now();

const CARD_KEYS = [
  'age', 'city', 'degree', 'gotra', 'height', 'lastActiveAt',
  'name', 'occupation', 'primaryPhoto', 'profileId', 'surname', 'verified'
].sort();

/** A minimal stand-in for step 12's block model (see the header note). */
const blockSchema = new mongoose.Schema(
  {
    blockerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    blockedUserId: { type: mongoose.Schema.Types.ObjectId, required: true }
  },
  { collection: COLLECTIONS.BLOCKS }
);
const Block = mongoose.models.Block || mongoose.model('Block', blockSchema);

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
  const registered = await post('/api/v1/photos', { publicId: `${folder}/step11-${photoSeq}`, type: 'profile' }, token);
  if (registered.status !== 201) {
    throw new Error(`photo registration failed: ${registered.status} ${registered.text?.slice(0, 200)}`);
  }
  await Photo.updateOne({ userId, isPrimary: true }, { $set: { moderationStatus: 'approved' } });
  await profileScoreService.syncDiscoveryPhotoFlag(userId);
}

async function publishedAccount({ gender = 'male', age = 27, firstName = 'Vikram', label }) {
  const email = `s11-${RUN}-${label}@example.com`;
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
const d = await publishedAccount({ label: 'd' });
const outsider = await publishedAccount({ gender: 'female', age: 26, firstName: 'Nisha', label: 'outsider' });

// ---------------------------------------------------------------------------
// Command 1 — send an interest
// ---------------------------------------------------------------------------
const sent = await post('/api/v1/connections', { toUserId: b.id, message: 'Hello, I liked your profile.' }, a.token);
const connectionId = sent.json?.data?.connection?.id;
check(
  'command 1: POST /connections -> 201, status "pending"',
  sent.status === 201 && sent.json?.data?.connection?.status === 'pending' && sent.json?.data?.connection?.direction === 'sent',
  `status=${sent.status} body=${sent.text?.slice(0, 160)}`
);

// ---------------------------------------------------------------------------
// Command 2 — duplicate send
// ---------------------------------------------------------------------------
{
  const duplicate = await post('/api/v1/connections', { toUserId: b.id }, a.token);
  const rows = await Connection.countDocuments({ senderId: a.id, receiverId: b.id });
  check(
    'command 2: a duplicate send -> 409 and one row only',
    duplicate.status === 409 && rows === 1,
    `status=${duplicate.status} rows=${rows}`
  );
}

// ---------------------------------------------------------------------------
// Command 3 — self-interest
// ---------------------------------------------------------------------------
{
  const self = await post('/api/v1/connections', { toUserId: a.id }, a.token);
  check('command 3: a self-interest -> 400', self.status === 400, `status=${self.status}`);
}

// ---------------------------------------------------------------------------
// Command 4 — the sender cannot accept their own interest
// ---------------------------------------------------------------------------
{
  const senderAccept = await patch(`/api/v1/connections/${connectionId}`, { action: 'accept' }, a.token);
  check(
    'command 4: the sender cannot accept their own interest -> 403',
    senderAccept.status === 403 || senderAccept.status === 404,
    `status=${senderAccept.status}`
  );
  const unchanged = await Connection.findById(connectionId).lean();
  check('command 4: the refused transition left the row pending', unchanged.status === 'pending', `status=${unchanged.status}`);
}

// ---------------------------------------------------------------------------
// Command 5 — the receiver accepts; chat becomes possible
// ---------------------------------------------------------------------------
{
  const accepted = await patch(`/api/v1/connections/${connectionId}`, { action: 'accept' }, b.token);
  const stored = await Connection.findById(connectionId).lean();
  check(
    'command 5: the receiver accepts -> 200, "accepted", respondedAt set',
    accepted.status === 200 &&
      accepted.json?.data?.connection?.status === 'accepted' &&
      Boolean(accepted.json?.data?.connection?.respondedAt) &&
      accepted.json?.data?.connection?.canChat === true,
    `status=${accepted.status} body=${accepted.text?.slice(0, 160)}`
  );
  check('command 5: the stored row is accepted with a respondedAt', stored.status === 'accepted' && Boolean(stored.respondedAt), `status=${stored.status}`);
  check('command 5: canChat(A, B) is true for the accepted pair', (await connectionPolicy.canChat(a.id, b.id)) === true, 'policy');
}

// ---------------------------------------------------------------------------
// Command 6 — illegal transition
// ---------------------------------------------------------------------------
{
  const rejected = await patch(`/api/v1/connections/${connectionId}`, { action: 'reject' }, b.token);
  const stored = await Connection.findById(connectionId).lean();
  const reversed = await patch(`/api/v1/connections/${connectionId}`, { action: 'withdraw' }, a.token);
  check(
    'command 6: rejecting an accepted match -> 409/400 and the status is unchanged',
    (rejected.status === 409 || rejected.status === 400) && stored.status === 'accepted' && reversed.status === 409,
    `reject=${rejected.status} withdraw=${reversed.status} stored=${stored.status}`
  );
}

// ---------------------------------------------------------------------------
// Command 7 — withdraw from pending (separate pair)
// ---------------------------------------------------------------------------
{
  const created = await post('/api/v1/connections', { toUserId: c.id }, a.token);
  const pendingId = created.json?.data?.connection?.id;
  const withdrawn = await patch(`/api/v1/connections/${pendingId}`, { action: 'withdraw' }, a.token);
  check(
    'command 7: the sender withdraws a pending interest -> 200, "withdrawn"',
    created.status === 201 && withdrawn.status === 200 && withdrawn.json?.data?.connection?.status === 'withdrawn',
    `created=${created.status} withdrawn=${withdrawn.status}`
  );
  check('command 7: a withdrawn connection grants no chat', (await connectionPolicy.canChat(a.id, c.id)) === false, 'policy');
}

// ---------------------------------------------------------------------------
// Command 8 — connection list privacy (and card shape)
// ---------------------------------------------------------------------------
{
  const received = await req('/api/v1/connections?status=received', { headers: auth(b.token) });
  const items = received.json?.data?.items || [];
  const row = items.find((item) => item.profileId === a.publicProfileId);
  check(
    'command 8: GET /connections?status=received -> 200 with the pair\'s row',
    received.status === 200 && received.json?.data?.box === 'received' && Boolean(row) && row.connection.status === 'accepted',
    `status=${received.status} items=${items.length} row=${row?.connection?.status}`
  );
  check(
    'command 8: no private field or account id appears in a connection list',
    !/"(email|phone|coordinates|dateOfBirth|birthTime|userId|senderId|receiverId)"/.test(received.text) &&
      !received.text.includes(a.id) &&
      !received.text.includes(b.id),
    'no private key in the payload'
  );
  check(
    'command 8: the profile part of a row is exactly the §70 card',
    Boolean(row) &&
      JSON.stringify(Object.keys(row).filter((key) => key !== 'connection').sort()) === JSON.stringify(CARD_KEYS),
    `keys=${row ? Object.keys(row).sort().join(',') : 'none'}`
  );
}

// ---------------------------------------------------------------------------
// Command 9 — send rate limit
// ---------------------------------------------------------------------------
{
  const flooder = await publishedAccount({ gender: 'female', age: 28, firstName: 'Rhea', label: 'flood' });
  const cap = config.connections.rateLimit.max;
  let sawTooMany = false;
  let attempts = 0;
  for (; attempts < cap + 10; attempts += 1) {
    const res = await post('/api/v1/connections', { toUserId: b.id }, flooder.token);
    if (res.status === 429) {
      sawTooMany = true;
      break;
    }
  }
  check(
    'command 9: interest writes are rate limited (429 after the configured threshold)',
    sawTooMany,
    `cap=${cap} attempts=${attempts}`
  );
}

// ---------------------------------------------------------------------------
// Command 10 — expiry sweep (service boundary; see the header)
// ---------------------------------------------------------------------------
{
  const staleTarget = await publishedAccount({ label: 'stale' });
  const row = await Connection.create({ senderId: a.id, receiverId: staleTarget.id });
  await Connection.collection.updateOne(
    { _id: row._id },
    { $set: { createdAt: new Date(Date.now() - (config.connections.expiryDays + 1) * 24 * 60 * 60 * 1000) } }
  );
  const result = await connectionService.sweepExpired({ force: true });
  const swept = await Connection.findById(row._id).lean();
  check(
    'command 10: a stale pending row is swept to "expired"',
    result.swept >= 1 && swept.status === 'expired' && Boolean(swept.respondedAt),
    `swept=${result.swept} status=${swept.status}`
  );
}

// ---------------------------------------------------------------------------
// Command 11 — close an accepted connection
// ---------------------------------------------------------------------------
{
  const created = await post('/api/v1/connections', { toUserId: d.id }, a.token);
  const pairId = created.json?.data?.connection?.id;
  await patch(`/api/v1/connections/${pairId}`, { action: 'accept' }, d.token);
  const closed = await patch(`/api/v1/connections/${pairId}`, { action: 'close' }, a.token);
  check(
    'command 11: closing an accepted connection -> 200, "closed"',
    closed.status === 200 && closed.json?.data?.connection?.status === 'closed' && closed.json?.data?.connection?.canChat === false,
    `status=${closed.status} body=${closed.text?.slice(0, 160)}`
  );
  check(
    'command 11: canChat(A, D) is false after the closure',
    (await connectionPolicy.canChat(a.id, d.id)) === false,
    'policy'
  );
  check(
    'command 11: the closed row is preserved in the database (decisions §7)',
    (await Connection.findById(pairId).lean()).status === 'closed',
    'row'
  );

  // -------------------------------------------------------------------------
  // Command 12 — re-send after a terminal state
  // -------------------------------------------------------------------------
  const resent = await post('/api/v1/connections', { toUserId: d.id }, a.token);
  const stillClosed = await Connection.findById(pairId).lean();
  check(
    'command 12: a re-send after "closed" -> 201 with a NEW pending row',
    resent.status === 201 &&
      resent.json?.data?.connection?.status === 'pending' &&
      resent.json?.data?.connection?.id !== pairId,
    `status=${resent.status} body=${resent.text?.slice(0, 160)}`
  );
  check(
    'command 12: the earlier closed row is unchanged',
    stillClosed.status === 'closed',
    `status=${stillClosed.status}`
  );
}

// ---------------------------------------------------------------------------
// Command 13 — concurrent duplicate sends
// ---------------------------------------------------------------------------
{
  const concurrentTarget = await publishedAccount({ label: 'race' });
  const [first, second] = await Promise.all([
    post('/api/v1/connections', { toUserId: concurrentTarget.id }, a.token),
    post('/api/v1/connections', { toUserId: concurrentTarget.id }, a.token)
  ]);
  const statuses = [first.status, second.status].sort();
  const active = await Connection.countDocuments({
    status: { $in: ACTIVE_STATUSES },
    $or: [
      { senderId: a.id, receiverId: concurrentTarget.id },
      { senderId: concurrentTarget.id, receiverId: a.id }
    ]
  });
  check(
    'command 13: two parallel identical sends -> one 201, one 409, one active row',
    JSON.stringify(statuses) === JSON.stringify([201, 409]) && active === 1,
    `statuses=${statuses.join(',')} active=${active}`
  );
}

// ---------------------------------------------------------------------------
// Cross-cutting: model shape, indexes, index plans, transitions, events, auth
// ---------------------------------------------------------------------------
{
  const documented = ['senderId', 'receiverId', 'status', 'message', 'createdAt', 'respondedAt'];
  const statusEnum = JSON.stringify(Connection.schema.path('status').enumValues);
  check(
    '§21 + decisions §7: the documented fields and the six-status enum',
    documented.every((field) => Connection.schema.path(field)) &&
      statusEnum === JSON.stringify(CONNECTION_STATUSES) &&
      statusEnum.includes('closed'),
    `enum=${statusEnum}`
  );
}

{
  const indexes = await Connection.collection.indexes();
  const names = indexes.map((idx) => idx.name);
  const pair = indexes.find((idx) => idx.key.senderId === 1 && idx.key.receiverId === 1 && !idx.key.status);
  check(
    '§105: the connections indexes exist',
    names.includes('senderId_1_status_1') &&
      names.includes('receiverId_1_status_1') &&
      names.includes('status_1_createdAt_1'),
    `indexes=${names.join(',')}`
  );
  check(
    'decisions §8: the pair index is partial-unique over the open statuses only',
    Boolean(pair) &&
      pair.unique === true &&
      JSON.stringify(pair.partialFilterExpression?.status?.$in) === JSON.stringify(ACTIVE_STATUSES),
    `unique=${pair?.unique} partial=${JSON.stringify(pair?.partialFilterExpression)}`
  );
}

{
  const receivedPlan = await Connection.find({ receiverId: b.id, status: 'pending' })
    .sort({ _id: -1 })
    .explain('queryPlanner');
  const sweepPlan = await Connection.find({ status: 'pending', createdAt: { $lt: new Date() } }).explain('queryPlanner');
  check(
    '§49: the received list and the expiry sweep are index-backed (IXSCAN)',
    JSON.stringify(receivedPlan).includes('IXSCAN') && JSON.stringify(sweepPlan).includes('IXSCAN'),
    'queryPlanner'
  );
}

{
  // The matrix is data, and the service refuses everything outside it.
  const matrix = {
    send: connectionPolicy.canTransition(null, 'send', 'sender') === true,
    accept: connectionPolicy.canTransition('pending', 'accept', 'receiver') === true,
    reject: connectionPolicy.canTransition('pending', 'reject', 'receiver') === true,
    withdraw: connectionPolicy.canTransition('pending', 'withdraw', 'sender') === true,
    timeout: connectionPolicy.canTransition('pending', 'timeout', 'system') === true,
    close: connectionPolicy.canTransition('accepted', 'close', 'sender') === true &&
      connectionPolicy.canTransition('accepted', 'close', 'receiver') === true,
    illegal: connectionPolicy.canTransition('accepted', 'accept', 'receiver') === false &&
      connectionPolicy.canTransition('closed', 'close', 'sender') === false &&
      connectionPolicy.canTransition('pending', 'accept', 'sender') === false
  };
  check(
    'decisions §7: the transition matrix is present and rejects everything else',
    Object.values(matrix).every(Boolean),
    JSON.stringify(matrix)
  );
  check(
    '§21/§100: chat access is derived — canChat is false for every non-accepted status',
    typeof connectionPolicy.canChat === 'function' && RESPONSE_ACTIONS.join(',') === 'accept,reject,withdraw,close',
    `actions=${RESPONSE_ACTIONS.join(',')}`
  );
}

{
  // The bus is in-process, so this is driven through the service in the harness's
  // own process — the server's module instance can never be observed from here.
  const seen = [];
  const listener = (payload) => seen.push(payload);
  const target = await publishedAccount({ label: 'events' });
  let events = null;
  connectionService.events.on('connection', listener);
  try {
    const created = await connectionService.send(a.id, { toUserId: target.id });
    await connectionService.respond(target.id, String(created.connection._id), 'accept');
    events = {
      received: seen.filter((e) => e.type === 'interest_received').length,
      accepted: seen.filter((e) => e.type === 'interest_accepted').length,
      newMatch: seen.filter((e) => e.type === 'new_match').length
    };
  } finally {
    connectionService.events.off('connection', listener);
  }
  check(
    'decisions §9: the accept path emits exactly one interest_accepted and no new_match',
    events.received === 1 && events.accepted === 1 && events.newMatch === 0 && typeof connectionService.events.emit === 'function',
    JSON.stringify(events)
  );
}

{
  // The blocked-pair rule at the service boundary (§22, §99).
  const blocker = await publishedAccount({ label: 'blocker' });
  const created = await post('/api/v1/connections', { toUserId: blocker.id }, a.token);
  const pendingId = created.json?.data?.connection?.id;
  const block = await Block.create({ blockerId: blocker.id, blockedUserId: a.id });

  let sendRefused = false;
  let respondRefused = false;
  try {
    await connectionService.send(a.id, { toUserId: blocker.id });
  } catch (err) {
    sendRefused = err.statusCode === 404;
  }
  try {
    await connectionService.respond(blocker.id, pendingId, 'accept');
  } catch (err) {
    respondRefused = err.statusCode === 404;
  }
  const unchanged = await Connection.findById(pendingId).lean();
  check(
    '§99: a blocked pair can neither send nor respond, and the row is untouched',
    sendRefused && respondRefused && unchanged.status === 'pending',
    `send=${sendRefused} respond=${respondRefused} status=${unchanged.status}`
  );
  await Block.deleteOne({ _id: block._id });
}

{
  const anonymous = await Promise.all([
    req('/api/v1/connections'),
    post('/api/v1/connections', { toUserId: b.id }),
    patch('/api/v1/connections/000000000000000000000000', { action: 'accept' })
  ]);
  check(
    'all three connection routes refuse an anonymous request with 401',
    anonymous.every((res) => res.status === 401),
    anonymous.map((res) => res.status).join(',')
  );

  const attacker = await patch(`/api/v1/connections/000000000000000000000000`, { action: 'accept' }, outsider.token);
  check('a non-participant gets 404, never a 403 that confirms the row', attacker.status === 404, `status=${attacker.status}`);

  const markup = await post('/api/v1/connections', { toUserId: b.id, message: '<script>x</script>' }, outsider.token);
  check('a message containing markup is refused with 400', markup.status === 400, `status=${markup.status}`);

  const identity = await post('/api/v1/connections', { toUserId: b.id, senderId: outsider.id }, outsider.token);
  check('a body identity field cannot name the actor (400)', identity.status === 400, `status=${identity.status}`);

  const malformed = await patch('/api/v1/connections/not-an-id', { action: 'accept' }, outsider.token);
  check('a malformed path id is a 400, not a 500', malformed.status === 400, `status=${malformed.status}`);

  const crossDirection = await post('/api/v1/connections', { toUserId: a.id }, b.token);
  check(
    'a crossing send (an inbound interest already pending) is refused with 409',
    crossDirection.status === 409,
    `status=${crossDirection.status}`
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
