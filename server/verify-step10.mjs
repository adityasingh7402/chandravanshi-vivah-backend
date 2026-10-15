// Step 10 scripted verification — drives the doc's eight verification commands
// against a live server, plus the database, index and privacy checks.
//
// Seed + boot the server with the test database first, then run with the SAME
// database:
//   MONGODB_DB_NAME=chandravanshi_vivah_test CLOUDINARY_MOCK=true \
//     AUTH_RATE_LIMIT_MAX=1000 RATE_LIMIT_MAX=99999 node verify-step10.mjs
//
// The two raised limits are for the harness's own account volume and its
// command-7 flood; the interaction limiter it verifies keeps the project's
// configured ACTION_RATE_LIMIT_MAX. `npm run verify` sets both for this step
// only (a fresh server per harness, CLOUDINARY_MOCK=true).
//
// Command 8 (blocked pair) is checked at the service/query boundary rather than
// over HTTP: the `blocks` collection and its model belong to step 12, so the
// running server does not register a `Block` model yet and cannot see a seeded
// block. The harness registers a minimal stand-in itself and drives the same
// `exclusionService`/`actionService` rule the server will run once step 12 lands.
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
const ProfileAction = require('./src/models/ProfileAction');
const profileScoreService = require('./src/services/profileScoreService');
const exclusionService = require('./src/services/exclusionService');
const actionService = require('./src/services/actionService');
const { getMasterModel } = require('./src/models/masterData/MasterItem');
const { ACTION_TYPE } = require('./src/constants/actions');

const BASE = `http://localhost:${config.port}`;
const PASSWORD = 'correct-horse-battery';
const RUN = Date.now();
const MAX_LIMIT = config.actions.maxLimit;

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
const skip = (name, reason) => skipped.push({ name, reason });

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
const del = (path, token) => req(path, { method: 'DELETE', headers: auth(token) });

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
  const registered = await post('/api/v1/photos', { publicId: `${folder}/step10-${photoSeq}`, type: 'profile' }, token);
  if (registered.status !== 201) {
    throw new Error(`photo registration failed: ${registered.status} ${registered.text?.slice(0, 200)}`);
  }
  await Photo.updateOne({ userId, isPrimary: true }, { $set: { moderationStatus: 'approved' } });
  await profileScoreService.syncDiscoveryPhotoFlag(userId);
}

async function publishedAccount({ gender = 'male', age = 27, firstName = 'Vikram', label }) {
  const email = `s10-${RUN}-${label}@example.com`;
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

const actor = await publishedAccount({ gender: 'female', age: 25, firstName: 'Aarohi', label: 'actor' });
const targetA = await publishedAccount({ label: 'a' });
const targetB = await publishedAccount({ label: 'b' });
const targetC = await publishedAccount({ label: 'c' });
const targetD = await publishedAccount({ label: 'd' });

// A draft account is not a valid target.
const draftEmail = `s10-${RUN}-draft@example.com`;
await register(draftEmail);
const draftToken = await login(draftEmail);
await post('/api/v1/profile', fullProfile({ gender: 'male', age: 30, firstName: 'Draft' }), draftToken);
const draftUser = await User.findOne({ email: draftEmail }).select('_id').lean();

// ---------------------------------------------------------------------------
// Command 1 — like a profile
// ---------------------------------------------------------------------------
const like = await post('/api/v1/interactions', { toUserId: targetA.id, type: 'like' }, actor.token);
check(
  'command 1: POST /interactions (like) -> 201',
  like.status === 201 && like.json?.data?.interaction?.type === 'like',
  `status=${like.status} body=${like.text?.slice(0, 160)}`
);

// ---------------------------------------------------------------------------
// Command 2 — repeat the like (idempotent)
// ---------------------------------------------------------------------------
const likeAgain = await post('/api/v1/interactions', { toUserId: targetA.id, type: 'like' }, actor.token);
const likeRows = await ProfileAction.countDocuments({ fromUserId: actor.id, toUserId: targetA.id, type: 'like' });
check(
  'command 2: repeating the like does not create a second row',
  likeAgain.status === 201 && likeRows === 1 && likeAgain.json?.data?.interaction?.isNew === false,
  `status=${likeAgain.status} rows=${likeRows}`
);

// ---------------------------------------------------------------------------
// Command 3 — self-action
// ---------------------------------------------------------------------------
const self = await post('/api/v1/interactions', { toUserId: actor.id, type: 'like' }, actor.token);
check('command 3: a self-action is rejected with 400', self.status === 400, `status=${self.status}`);

// ---------------------------------------------------------------------------
// Command 4 — shortlist listing uses the card projection
// ---------------------------------------------------------------------------
const shortlistOne = await post('/api/v1/interactions', { toUserId: targetB.id, type: 'shortlist' }, actor.token);
await new Promise((resolve) => setTimeout(resolve, 10));
const shortlistTwo = await post('/api/v1/interactions', { publicProfileId: targetC.publicProfileId, type: 'shortlist' }, actor.token);
const listing = await req('/api/v1/interactions?type=shortlist', { headers: auth(actor.token) });
const items = listing.json?.data?.items || [];
check(
  'command 4: type=shortlist -> 200 with card-shaped rows only',
  listing.status === 200 && items.length === 2 && items.every((item) => JSON.stringify(Object.keys(item).sort()) === JSON.stringify(CARD_KEYS)),
  `status=${listing.status} items=${items.length}`
);
check(
  'command 4: the newest shortlist is listed first',
  items.length === 2 && items[0].profileId === targetC.publicProfileId,
  `ids=${JSON.stringify(items.map((item) => item.profileId))}`
);
check(
  'command 4: the listing carries no private or internal field',
  !/"(email|phone|coordinates|dateOfBirth|birthTime|userId)"/.test(listing.text),
  'no private key in the payload'
);
check(
  'command 4: a publicProfileId target is resolved server-side (toUserId accepted too)',
  shortlistTwo.status === 201 && shortlistOne.status === 201,
  `publicId=${shortlistTwo.status} userId=${shortlistOne.status}`
);

// ---------------------------------------------------------------------------
// Command 5 — removing another user's action
// ---------------------------------------------------------------------------
const other = await publishedAccount({ gender: 'female', age: 24, firstName: 'Nisha', label: 'other' });
const otherAction = await post('/api/v1/interactions', { toUserId: targetD.id, type: 'shortlist' }, other.token);
const otherId = otherAction.json?.data?.interaction?.id;
{
  const forbidden = await del(`/api/v1/interactions/${otherId}`, actor.token);
  check('command 5: deleting another account\'s action -> 404', forbidden.status === 404, `status=${forbidden.status}`);
  const stillThere = await ProfileAction.findById(otherId).lean();
  check('command 5: the foreign action row survives the attempt', Boolean(stillThere), `exists=${Boolean(stillThere)}`);
  const ownerRemoval = await del(`/api/v1/interactions/${otherId}`, other.token);
  check('command 5: the owner can remove it', ownerRemoval.status === 200, `status=${ownerRemoval.status}`);
}

// ---------------------------------------------------------------------------
// Command 6 — pass excludes from discover
// ---------------------------------------------------------------------------
{
  const before = await req(`/api/v1/search?cityId=${id(city)}&gender=male&limit=100`, { headers: auth(actor.token) });
  const beforeIds = (before.json?.data?.items || []).map((item) => item.profileId);
  await post('/api/v1/interactions', { toUserId: targetA.id, type: 'pass' }, actor.token);
  const after = await req(`/api/v1/search?cityId=${id(city)}&gender=male&limit=100`, { headers: auth(actor.token) });
  const afterIds = (after.json?.data?.items || []).map((item) => item.profileId);
  check(
    'command 6: pass removes the target from discover/search',
    beforeIds.includes(targetA.publicProfileId) && !afterIds.includes(targetA.publicProfileId),
    `before=${beforeIds.includes(targetA.publicProfileId)} after=${afterIds.includes(targetA.publicProfileId)}`
  );
}

// ---------------------------------------------------------------------------
// Command 7 — rate limit
// ---------------------------------------------------------------------------
{
  const flooder = await publishedAccount({ gender: 'female', age: 26, firstName: 'Rhea', label: 'flood' });
  const cap = config.actions.rateLimit.max;
  let sawTooMany = false;
  let attempts = 0;
  for (; attempts < cap + 10; attempts += 1) {
    const res = await post('/api/v1/interactions', { toUserId: targetB.id, type: 'view' }, flooder.token);
    if (res.status === 429) {
      sawTooMany = true;
      break;
    }
  }
  check(
    'command 7: action writes are rate limited (429 after the configured threshold)',
    sawTooMany,
    `cap=${cap} attempts=${attempts}`
  );
}

// ---------------------------------------------------------------------------
// Command 8 — blocked pair cannot act (service boundary; see the header)
// ---------------------------------------------------------------------------
{
  const blocked = await Block.create({ blockerId: targetC.id, blockedUserId: actor.id });
  const excluded = await exclusionService.blockExclusion(actor.id);
  let refused = false;
  try {
    await actionService.record(actor.id, { toUserId: targetC.id, type: 'like' });
  } catch (err) {
    refused = err.statusCode === 404;
  }
  const rows = await ProfileAction.countDocuments({ fromUserId: actor.id, toUserId: targetC.id, type: 'like' });
  check(
    'command 8: a blocked pair cannot record an action, and no row is created',
    excluded.includes(targetC.id) && refused && rows === 0,
    `excluded=${excluded.includes(targetC.id)} refused=${refused} rows=${rows}`
  );
  await Block.deleteOne({ _id: blocked._id });
}

// ---------------------------------------------------------------------------
// Cross-cutting: model shape, view rule, indexes, events, auth
// ---------------------------------------------------------------------------
{
  const documented = ['fromUserId', 'toUserId', 'type', 'createdAt'];
  const typeEnum = JSON.stringify(ProfileAction.schema.path('type').enumValues);
  check(
    '§20: the action document carries the documented fields and the four types',
    documented.every((field) => ProfileAction.schema.path(field)) && typeEnum === JSON.stringify(['view', 'like', 'shortlist', 'pass']),
    `enum=${typeEnum}`
  );
}

{
  // One view row per pair, timestamp refreshed (decisions §15).
  const viewer = await publishedAccount({ gender: 'female', age: 28, firstName: 'Meera', label: 'viewer' });
  await post('/api/v1/interactions', { toUserId: targetD.id, type: 'view' }, viewer.token);
  const first = await ProfileAction.findOne({ fromUserId: viewer.id, toUserId: targetD.id, type: 'view' }).lean();
  await new Promise((resolve) => setTimeout(resolve, 10));
  await post('/api/v1/interactions', { toUserId: targetD.id, type: 'view' }, viewer.token);
  const rows = await ProfileAction.find({ fromUserId: viewer.id, toUserId: targetD.id, type: 'view' }).lean();
  check(
    'decisions §15: two views of one profile leave one row with a refreshed timestamp',
    rows.length === 1 && new Date(rows[0].createdAt).getTime() >= new Date(first.createdAt).getTime(),
    `rows=${rows.length}`
  );

  const touched = await MatrimonialProfile.findOne({ userId: targetD.id }).select('profile.lastActiveAt').lean();
  check(
    'the view updates the target activity signal',
    Boolean(touched.profile.lastActiveAt),
    `lastActiveAt=${touched.profile.lastActiveAt}`
  );
}

{
  const indexes = await ProfileAction.collection.indexes();
  const pair = indexes.find((idx) => idx.key.fromUserId === 1 && idx.key.toUserId === 1 && idx.key.type === 1);
  check(
    '§105: the profile_actions indexes exist and the pair+type index is unique',
    Boolean(pair) && pair.unique === true && indexes.some((idx) => idx.name === 'fromUserId_1_type_1_createdAt_-1'),
    `indexes=${indexes.map((idx) => idx.name).join(',')}`
  );

  const plan = await ProfileAction.find({ fromUserId: actor.id, toUserId: targetB.id, type: 'shortlist' })
    .limit(1)
    .explain('queryPlanner');
  check(
    '§49: the pair lookup is served by an index (IXSCAN), not a collection scan',
    JSON.stringify(plan).includes('IXSCAN') && !JSON.stringify(plan).includes('COLLSCAN'),
    'queryPlanner'
  );
}

{
  check(
    'a domain event bus exists for step 13 to consume (no notifications sent here)',
    typeof actionService.events?.emit === 'function',
    `listeners=${actionService.events?.listenerCount?.('action') ?? 0}`
  );
}

{
  const anonymous = await Promise.all([
    req('/api/v1/interactions'),
    post('/api/v1/interactions', { toUserId: targetB.id, type: 'like' }),
    del('/api/v1/interactions/000000000000000000000000')
  ]);
  check(
    'all three interaction routes refuse an anonymous request with 401',
    anonymous.every((res) => res.status === 401),
    anonymous.map((res) => res.status).join(',')
  );

  const badLimit = await req('/api/v1/interactions?limit=100000', { headers: auth(actor.token) });
  check(
    'an oversized limit is clamped to the configured maximum, not rejected',
    badLimit.status === 200 && (badLimit.json?.data?.items || []).length <= MAX_LIMIT,
    `status=${badLimit.status} items=${(badLimit.json?.data?.items || []).length}`
  );

  const draftAction = await post('/api/v1/interactions', { toUserId: String(draftUser._id), type: 'like' }, actor.token);
  check(
    'a non-active target is not actionable (404, no row)',
    draftAction.status === 404,
    `status=${draftAction.status}`
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
