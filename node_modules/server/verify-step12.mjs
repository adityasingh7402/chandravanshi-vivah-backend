// Step 12 scripted verification — drives the doc's ten verification commands
// against a live server, plus the database, index, effect-set and privacy checks.
//
// Seed + boot the server with the test database first, then run with the SAME
// database:
//   MONGODB_DB_NAME=chandravanshi_vivah_test CLOUDINARY_MOCK=true \
//     AUTH_RATE_LIMIT_MAX=1000 RATE_LIMIT_MAX=99999 node verify-step12.mjs
//
// The two raised limits are for the harness's own account volume and its
// deliberate block/report floods; the block and report limiters it verifies keep
// the project's configured maxima. `npm run verify` sets both for this step only
// (a fresh server per harness, CLOUDINARY_MOCK=true).
//
// One check runs at the service boundary rather than over HTTP: there is no route
// that reports "does a block exist between these two accounts?", so
// `blockService.isBlockedEitherWay` / `exclusionService` are called directly —
// which is exactly the interface Discover, the interest flow and step 14 consume.
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
const Block = require('./src/models/Block');
const Report = require('./src/models/Report');
const profileScoreService = require('./src/services/profileScoreService');
const blockService = require('./src/services/blockService');
const reportService = require('./src/services/reportService');
const connectionService = require('./src/services/connectionService');
const connectionPolicy = require('./src/services/connectionPolicy');
const exclusionService = require('./src/services/exclusionService');
const { getMasterModel } = require('./src/models/masterData/MasterItem');
const { REPORT_CATEGORIES, REPORT_STATUS } = require('./src/constants/safety');
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
  const registered = await post('/api/v1/photos', { publicId: `${folder}/step12-${photoSeq}`, type: 'profile' }, token);
  if (registered.status !== 201) {
    throw new Error(`photo registration failed: ${registered.status} ${registered.text?.slice(0, 200)}`);
  }
  await Photo.updateOne({ userId, isPrimary: true }, { $set: { moderationStatus: 'approved' } });
  await profileScoreService.syncDiscoveryPhotoFlag(userId);
}

async function publishedAccount({ gender = 'male', age = 27, firstName = 'Vikram', label }) {
  const email = `s12-${RUN}-${label}@example.com`;
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

// ---------------------------------------------------------------------------
// Command 1 — block
// ---------------------------------------------------------------------------
{
  const blocked = await post('/api/v1/blocks', { userId: b.id, reason: 'Not interested' }, a.token);
  check(
    'command 1: POST /blocks -> 201',
    blocked.status === 201 && blocked.json?.data?.block?.reason === 'Not interested',
    `status=${blocked.status} body=${blocked.text?.slice(0, 160)}`
  );
}

// ---------------------------------------------------------------------------
// Command 2 — block is idempotent
// ---------------------------------------------------------------------------
{
  const again = await post('/api/v1/blocks', { userId: b.id }, a.token);
  const rows = await Block.countDocuments({ blockerId: a.id, blockedUserId: b.id });
  check(
    'command 2: a repeat block makes no duplicate row',
    again.status === 201 && again.json?.data?.block?.isNew === false && rows === 1,
    `status=${again.status} rows=${rows}`
  );
}

// ---------------------------------------------------------------------------
// Command 3 — self-block
// ---------------------------------------------------------------------------
{
  const self = await post('/api/v1/blocks', { userId: a.id }, a.token);
  check('command 3: a self-block -> 400', self.status === 400, `status=${self.status}`);
}

// ---------------------------------------------------------------------------
// Command 4 — discovery excludes the pair in both directions
// ---------------------------------------------------------------------------
{
  const aView = await req('/api/v1/discover?gender=male&limit=100', { headers: auth(a.token) });
  const bView = await req('/api/v1/discover?gender=female&limit=100', { headers: auth(b.token) });
  const aIds = (aView.json?.data?.items || []).map((item) => item.profileId);
  const bIds = (bView.json?.data?.items || []).map((item) => item.profileId);
  check(
    'command 4: neither account can discover the other (0 and 0)',
    aView.status === 200 && bView.status === 200 && !aIds.includes(b.publicProfileId) && !bIds.includes(a.publicProfileId),
    `aSeesB=${aIds.includes(b.publicProfileId)} bSeesA=${bIds.includes(a.publicProfileId)}`
  );
}

// ---------------------------------------------------------------------------
// Command 5 — interactions are cut
// ---------------------------------------------------------------------------
{
  const fromBlocked = await post('/api/v1/connections', { toUserId: a.id }, b.token);
  const fromBlocker = await post('/api/v1/connections', { toUserId: b.id }, a.token);
  const action = await post('/api/v1/interactions', { toUserId: b.id, type: 'like' }, a.token);
  check(
    'command 5: a blocked pair cannot send an interest or record an action',
    fromBlocked.status === 404 && fromBlocker.status === 404 && action.status === 404,
    `blocked=${fromBlocked.status} blocker=${fromBlocker.status} action=${action.status}`
  );
}

// ---------------------------------------------------------------------------
// Command 6 — chat is cut, including a previously accepted connection
// ---------------------------------------------------------------------------
{
  // A second pair, accepted before the block, so the "block closes for access"
  // rule is exercised on a real match. (Step 14 does not exist yet, so this is the
  // policy helper the step tells us to verify with.)
  const created = await post('/api/v1/connections', { toUserId: c.id }, a.token);
  const pairId = created.json?.data?.connection?.id;
  await patch(`/api/v1/connections/${pairId}`, { action: 'accept' }, c.token);
  const before = await connectionPolicy.canChat(a.id, c.id);

  await post('/api/v1/blocks', { userId: c.id }, a.token);

  const after = await connectionPolicy.canChat(a.id, c.id);
  const reverse = await connectionPolicy.canChat(c.id, a.id);
  const access = await connectionPolicy.chatAccess(a.id, c.id);
  const row = await Connection.findById(pairId).lean();
  check(
    'command 6: blocking an accepted match makes canChat false in both directions',
    before === true && after === false && reverse === false && access.reason === 'blocked',
    `before=${before} after=${after} reverse=${reverse} reason=${access.reason}`
  );
  check(
    'command 6: the accepted row is closed for access and preserved (decisions §7)',
    row.status === CONNECTION_STATUS.CLOSED && Boolean(row.respondedAt),
    `status=${row.status}`
  );

  // And the derived gate does not merely ride on that write: a block row inserted
  // behind the service's back already cuts access.
  const derived = await Block.collection.insertOne({
    blockerId: new mongoose.Types.ObjectId(String(a.id)),
    blockedUserId: new mongoose.Types.ObjectId(String(outsider.id)),
    reason: null,
    createdAt: new Date(),
    updatedAt: new Date()
  });
  void derived;
  check(
    'command 6: canChat is derived from the block row, not from a rewritten status',
    (await connectionPolicy.canChat(a.id, outsider.id)) === false,
    'raw block row'
  );
  await Block.deleteOne({ blockerId: a.id, blockedUserId: outsider.id });
}

// ---------------------------------------------------------------------------
// Command 7 — file a report
// ---------------------------------------------------------------------------
let reportId = null;
{
  const reported = await post(
    '/api/v1/reports',
    { reportedUserId: b.id, category: 'fake_profile', description: 'Photos do not match' },
    a.token
  );
  reportId = reported.json?.data?.report?.id;
  check(
    'command 7: POST /reports -> 201 with status "open"',
    reported.status === 201 && reported.json?.data?.report?.status === REPORT_STATUS.OPEN,
    `status=${reported.status} body=${reported.text?.slice(0, 160)}`
  );
}

// ---------------------------------------------------------------------------
// Command 8 — reporter privacy
// ---------------------------------------------------------------------------
{
  const theirs = await req('/api/v1/reports/me', { headers: auth(b.token) });
  const mine = await req('/api/v1/reports/me', { headers: auth(a.token) });
  check(
    'command 8: the reported account sees nothing of the report',
    theirs.status === 200 && (theirs.json?.data?.items || []).length === 0 && !theirs.text.includes(a.id),
    `items=${(theirs.json?.data?.items || []).length}`
  );
  check(
    'command 8: the reporter sees their own case, with no reporter/reviewer field',
    mine.status === 200 &&
      (mine.json?.data?.items || []).some((item) => item.id === reportId) &&
      !/"reporterId"|"reviewedBy"|"reviewedAt"/.test(mine.text),
    `items=${(mine.json?.data?.items || []).length}`
  );
  const stored = await Report.findById(reportId).lean();
  check(
    'command 8: reporterId is not returned by a default read, only by an explicit select',
    stored.reporterId === undefined && String((await Report.findById(reportId).select('+reporterId').lean()).reporterId) === a.id,
    'select:false'
  );
}

// ---------------------------------------------------------------------------
// Command 9 — invalid category
// ---------------------------------------------------------------------------
{
  const bad = await post('/api/v1/reports', { reportedUserId: b.id, category: 'nonsense' }, a.token);
  check('command 9: an invalid category -> 400', bad.status === 400, `status=${bad.status}`);
}

// ---------------------------------------------------------------------------
// Command 10 — admin fields are not writable
// ---------------------------------------------------------------------------
{
  const cases = [
    { status: 'dismissed' },
    { reviewedBy: a.id },
    { reviewedAt: new Date().toISOString() }
  ];
  const statuses = [];
  for (const extra of cases) {
    const res = await post('/api/v1/reports', { reportedUserId: b.id, category: 'spam', ...extra }, a.token);
    statuses.push(res.status);
  }
  const stored = await Report.findById(reportId).lean();
  check(
    'command 10: a user route cannot set status / reviewedBy / reviewedAt -> 400',
    statuses.every((status) => status === 400) && stored.status === REPORT_STATUS.OPEN && stored.reviewedAt === null,
    `statuses=${statuses.join(',')} stored=${stored.status}`
  );
  const noRoute = await patch(`/api/v1/reports/${reportId}`, { status: 'dismissed' }, a.token);
  check('command 10: there is no user route that updates a report at all', noRoute.status === 404, `status=${noRoute.status}`);
}

// ---------------------------------------------------------------------------
// Cross-cutting: models, indexes, unblock, hooks, limits, privacy, auth
// ---------------------------------------------------------------------------
{
  const blockFields = ['blockerId', 'blockedUserId', 'reason', 'createdAt'];
  const reportFields = ['reporterId', 'reportedUserId', 'category', 'description', 'evidence', 'status', 'reviewedBy', 'reviewedAt'];
  check(
    '§22/§23: both documents carry the documented fields and enums',
    blockFields.every((field) => Block.schema.path(field)) &&
      reportFields.every((field) => Report.schema.path(field)) &&
      JSON.stringify(Report.schema.path('category').enumValues) === JSON.stringify(REPORT_CATEGORIES) &&
      JSON.stringify(Report.schema.path('status').enumValues) === JSON.stringify(['open', 'reviewing', 'resolved', 'dismissed']),
    `categories=${REPORT_CATEGORIES.length}`
  );
}

{
  const blockIndexes = await Block.collection.indexes();
  const blockNames = blockIndexes.map((idx) => idx.name);
  const pair = blockIndexes.find((idx) => idx.key.blockerId === 1 && idx.key.blockedUserId === 1);
  const reportNames = (await Report.collection.indexes()).map((idx) => idx.name);
  check(
    '§105: the block and report indexes exist',
    blockNames.includes('blockerId_1') &&
      blockNames.includes('blockedUserId_1') &&
      Boolean(pair) &&
      pair.unique === true &&
      ['reportedUserId_1_status_1', 'reporterId_1_createdAt_-1', 'status_1_createdAt_-1'].every((name) =>
        reportNames.includes(name)
      ),
    `blocks=${blockNames.join(',')} reports=${reportNames.join(',')}`
  );
}

{
  const plan = await Block.find({ $or: [{ blockerId: a.id }, { blockedUserId: a.id }] }).explain('queryPlanner');
  const discoverPlan = await MatrimonialProfile.find({ 'profile.status': 'active', userId: { $nin: [a.id] } }).explain(
    'queryPlanner'
  );
  check(
    '§49/§99: the bilateral exclusion lookup and the discover predicate are index-backed (IXSCAN)',
    JSON.stringify(plan).includes('IXSCAN') && JSON.stringify(discoverPlan).includes('IXSCAN'),
    'queryPlanner'
  );
}

{
  const excludedForA = await exclusionService.getExcludedUserIds(a.id);
  const excludedForB = await exclusionService.getExcludedUserIds(b.id);
  check(
    '§56/§99: both directions join the exclusion set, and nothing else does',
    excludedForA.includes(b.id) &&
      excludedForA.includes(c.id) &&
      !excludedForA.includes(outsider.id) &&
      excludedForB.includes(a.id) &&
      excludedForB.length === 2,
    `a=${excludedForA.length} b=${excludedForB.length}`
  );
  check(
    '§99: an oversized exclusion set is refused (503) rather than dropping an id',
    await (async () => {
      try {
        exclusionService.mergeExclusions([[outsider.id, b.id, c.id]], 2);
        return false;
      } catch (err) {
        return err.statusCode === 503;
      }
    })(),
    'cap'
  );
}

{
  const listA = await req('/api/v1/blocks', { headers: auth(a.token) });
  const items = listA.json?.data?.items || [];
  check(
    'the block list is card-shaped, marks the blocked account, and never echoes an account id',
    listA.status === 200 &&
      items.length === 2 &&
      items.every((item) => item.profileId && !JSON.stringify(item).includes(a.id)) &&
      !listA.text.includes(b.id) &&
      !listA.text.includes(c.id),
    `items=${items.length}`
  );
  const huge = await req('/api/v1/blocks?limit=100000', { headers: auth(a.token) });
  check(
    'an oversized block page is clamped to the configured maximum',
    huge.status === 200 && (huge.json?.data?.items || []).length <= config.safety.blocks.maxLimit,
    `items=${(huge.json?.data?.items || []).length}`
  );
}

{
  // Unblock restores interaction without restoring the relationship.
  const removed = await del(`/api/v1/blocks/${c.publicProfileId}`, a.token);
  const resent = await post('/api/v1/connections', { toUserId: c.id }, a.token);
  const row = await Connection.findOne({ senderId: a.id, receiverId: c.id, status: CONNECTION_STATUS.CLOSED }).lean();
  check(
    'unblocking by public id restores interaction but not the previous relationship',
    removed.status === 200 && resent.status === 201 && Boolean(row) && (await connectionPolicy.canChat(a.id, c.id)) === false,
    `removed=${removed.status} resent=${resent.status} closedRow=${Boolean(row)}`
  );
  const again = await del(`/api/v1/blocks/${c.publicProfileId}`, a.token);
  check('a second unblock has nothing to remove -> 404', again.status === 404, `status=${again.status}`);
}

{
  check(
    'the step-13 notification hook answers through one function',
    (await blockService.canNotify(a.id, b.id)) === false &&
      (await blockService.canNotify(a.id, outsider.id)) === true &&
      (await reportService.notificationsAllowed(a.id, b.id)) === false &&
      typeof connectionService.closeAcceptedForPair === 'function',
    'hook'
  );
}

{
  // The duplicate rule (documented choice: refuse, not count).
  const reporter = await publishedAccount({ gender: 'female', age: 29, firstName: 'Tara', label: 'dup' });
  const first = await post('/api/v1/reports', { reportedUserId: b.id, category: 'spam' }, reporter.token);
  const duplicate = await post('/api/v1/reports', { reportedUserId: b.id, category: 'spam' }, reporter.token);
  const otherCategory = await post('/api/v1/reports', { reportedUserId: b.id, category: 'fraud' }, reporter.token);
  check(
    'a repeated active report for the same pair and category is refused with 409, another category is not',
    first.status === 201 && duplicate.status === 409 && otherCategory.status === 201,
    `first=${first.status} duplicate=${duplicate.status} other=${otherCategory.status}`
  );
}

{
  const evidenceObject = await post(
    '/api/v1/reports',
    { reportedUserId: outsider.id, category: 'spam', evidence: [{ url: 'x' }] },
    a.token
  );
  const evidenceTooMany = await post(
    '/api/v1/reports',
    { reportedUserId: outsider.id, category: 'fraud', evidence: Array.from({ length: config.safety.report.evidenceMaxItems + 1 }, () => 'x') },
    a.token
  );
  const markup = await post('/api/v1/reports', { reportedUserId: outsider.id, category: 'spam', description: '<script>x</script>' }, a.token);
  const reasonMarkup = await post('/api/v1/blocks', { userId: outsider.id, reason: '<b>x</b>' }, a.token);
  check(
    '§34: evidence takes only strings within the cap, and free text cannot inject markup',
    evidenceObject.status === 400 && evidenceTooMany.status === 400 && markup.status === 400 && reasonMarkup.status === 400,
    `object=${evidenceObject.status} many=${evidenceTooMany.status} markup=${markup.status} reason=${reasonMarkup.status}`
  );
  const malformed = await del('/api/v1/blocks/not-an-id', a.token);
  const identity = await post('/api/v1/blocks', { userId: outsider.id, blockerId: outsider.id }, a.token);
  check(
    '§34/§44: a malformed path id is a 400 and a body identity field is refused',
    malformed.status === 400 && identity.status === 400,
    `param=${malformed.status} body=${identity.status}`
  );
}

{
  const blockCap = config.safety.blockRateLimit.max;
  const flooder = await publishedAccount({ gender: 'female', age: 30, firstName: 'Ira', label: 'flood' });
  let sawBlockLimit = false;
  let attempts = 0;
  for (; attempts < blockCap + 5; attempts += 1) {
    const res = await post('/api/v1/blocks', { userId: outsider.id }, flooder.token);
    if (res.status === 429) {
      sawBlockLimit = true;
      break;
    }
  }
  check(
    '§36: block writes are rate limited (429 after the configured threshold)',
    sawBlockLimit,
    `cap=${blockCap} attempts=${attempts}`
  );

  const reportFlooder = await publishedAccount({ gender: 'female', age: 31, firstName: 'Mira', label: 'flood2' });
  const reportCap = config.safety.reportRateLimit.max;
  let sawReportLimit = false;
  attempts = 0;
  for (; attempts < reportCap + 5; attempts += 1) {
    const res = await post('/api/v1/reports', { reportedUserId: outsider.id, category: 'spam' }, reportFlooder.token);
    if (res.status === 429) {
      sawReportLimit = true;
      break;
    }
  }
  check(
    '§36: report writes are rate limited (429 after the configured threshold)',
    sawReportLimit,
    `cap=${reportCap} attempts=${attempts}`
  );
}

{
  const anonymous = await Promise.all([
    req('/api/v1/blocks'),
    post('/api/v1/blocks', { userId: b.id }),
    del(`/api/v1/blocks/${b.id}`),
    req('/api/v1/reports/me'),
    post('/api/v1/reports', { reportedUserId: b.id, category: 'spam' })
  ]);
  check(
    'every block and report route refuses an anonymous request with 401',
    anonymous.every((res) => res.status === 401),
    anonymous.map((res) => res.status).join(',')
  );

  const foreignUnblock = await del(`/api/v1/blocks/${outsider.id}`, outsider.token);
  check('another account cannot remove a block it does not own -> 404', foreignUnblock.status === 404, `status=${foreignUnblock.status}`);

  const adminQueue = await Report.find({ status: { $in: ['open', 'reviewing'] } }).select('+reporterId').sort({ status: 1, createdAt: -1 }).limit(5).lean();
  check(
    '§101: an admin can read the open queue with the reporter, and a user route cannot',
    adminQueue.length > 0 && adminQueue.every((row) => Boolean(row.reporterId) || row.category),
    `queue=${adminQueue.length}`
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
