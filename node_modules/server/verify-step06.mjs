// Step 06 scripted verification — runs the doc's verification commands against a live server.
// Seed + boot the server with the test database first, then run with the SAME database:
//   MONGODB_DB_NAME=chandravanshi_vivah_test node verify-step06.mjs
// The harness drives the API end to end (create -> read -> patch -> publish ->
// hide -> delete -> recreate), inspects the database for the §105 indexes and
// the denormalised copies, and re-runs scripts/verify-indexes.js as the final
// index gate. Exit code 0 means every check passed.
import mongoose from 'mongoose';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const config = require('./src/config/env');
const User = require('./src/models/User');
const MatrimonialProfile = require('./src/models/MatrimonialProfile');
const { getMasterModel } = require('./src/models/masterData/MasterItem');
const { COMPLETION_WEIGHTS } = require('./src/constants/profile');

const BASE = `http://localhost:${config.port}`;
const PASSWORD = 'correct-horse-battery';
const RUN = Date.now();

const results = [];
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
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

const post = (path, body, token) => req(path, { method: 'POST', body, headers: auth(token) });
const patch = (path, body, token) => req(path, { method: 'PATCH', body, headers: auth(token) });
const auth = (token) => (token ? { authorization: `Bearer ${token}` } : {});

async function register(identifier) {
  return post('/api/v1/auth/register', { identifierType: 'email', identifier, password: PASSWORD });
}

async function login(identifier) {
  const r = await post('/api/v1/auth/login',
    { identifierType: 'email', identifier, password: PASSWORD, deviceType: 'android' });
  return r.json?.data?.accessToken;
}

/**
 * Register a primary profile photo through the documented sign -> register flow
 * (step 08). Publishing now requires one: the platform setting
 * `community_configs.settings.requireProfilePhoto` is on (spec §15), and the
 * photo is 10 of the §57 completion weight. The API process runs with
 * `CLOUDINARY_MOCK=true` under the gate runner, so the asset gateway is local.
 */
async function addPrimaryPhoto(token) {
  const sign = await post('/api/v1/photos/sign', {}, token);
  const folder = sign.json?.data?.upload?.folder;
  if (!folder) return null;
  photoSeq += 1;
  const res = await post('/api/v1/photos', { publicId: `${folder}/s6-${photoSeq}`, type: 'profile' }, token);
  return res.status === 201 ? res.json?.data?.photo : null;
}

let photoSeq = 0;

/** Fields the public DTO must never contain (fields dictionary §26, §112). */
const RESTRICTED = ['coordinates', 'birthTime', 'birthPlace', 'passwordHash', '"email"', '"phone"', 'userId', 'completionPercentage'];

// ---------------------------------------------------------------------------
// Database inspection setup + real master rows
// ---------------------------------------------------------------------------

await mongoose.connect(config.mongodbUri, { dbName: config.mongodbDbName, serverSelectionTimeoutMS: 5000 });

const communities = await getMasterModel('communities').find({ isActive: true })
  .sort({ sortOrder: 1, name: 1 }).select('_id slug name').lean();
let community = null;
let surname = null;
let gotra = null;
for (const candidate of communities) {
  const s = await getMasterModel('surnames').findOne({ communityId: candidate._id, isActive: true }).select('_id name').lean();
  const g = await getMasterModel('gotras').findOne({ communityId: candidate._id, isActive: true }).select('_id name').lean();
  if (s && g) { community = candidate; surname = s; gotra = g; break; }
}
const city = await getMasterModel('cities').findOne({ isActive: true }).sort({ sortOrder: 1 }).select('_id name coordinates').lean();
const degree = await getMasterModel('degrees').findOne({ isActive: true }).sort({ sortOrder: 1 }).select('_id name').lean();
const occupation = await getMasterModel('occupations').findOne({ isActive: true }).sort({ sortOrder: 1 }).select('_id name').lean();

if (!community || !surname || !gotra || !city || !degree || !occupation) {
  // Throw rather than `process.exit()`: the process still exits non-zero, and
  // any pending stdout writes flush first (see the summary at the end).
  throw new Error('Seed is incomplete — run `node scripts/seed-master-data.js` against this database first.');
}

const id = (doc) => String(doc._id);

/** A profile body that satisfies every §25 V1 requirement, so it may publish. */
function fullProfile(overrides = {}) {
  return {
    basic: {
      profileFor: 'self',
      firstName: 'Vikram',
      gender: 'male',
      dateOfBirth: '1996-03-14',
      maritalStatus: 'never_married',
      heightCm: 178,
      ...(overrides.basic || {})
    },
    community: { communityId: id(community), surnameId: id(surname), gotraId: id(gotra), ...(overrides.community || {}) },
    location: { cityId: id(city), ...(overrides.location || {}) },
    education: { highestQualificationId: id(degree), ...(overrides.education || {}) },
    career: { occupationId: id(occupation), ...(overrides.career || {}) },
    family: { familyType: 'nuclear', ...(overrides.family || {}) },
    lifestyle: { diet: 'vegetarian', ...(overrides.lifestyle || {}) },
    about: { description: 'Grounded family, simple habits, straightforward person.', ...(overrides.about || {}) },
    ...(overrides.extra || {})
  };
}

// ---------------------------------------------------------------------------
// 1. Health (step 01 regression) + authentication still works
// ---------------------------------------------------------------------------
const emailA = `s6a${RUN}@example.com`;
const emailB = `s6b${RUN}@example.com`;
const emailC = `s6c${RUN}@example.com`;
let tokenA;
let tokenB;
let tokenC;
let userA;
let userB;
let userC;

{
  const res = await req('/api/v1/health');
  const body = res.json;
  check('health 200 + database.connected', res.status === 200 && body.data?.database?.connected === true,
    `status=${res.status}`);
}

{
  await register(emailA);
  await register(emailB);
  await register(emailC);
  tokenA = await login(emailA);
  tokenB = await login(emailB);
  tokenC = await login(emailC);
  userA = await User.findOne({ email: emailA }).lean();
  userB = await User.findOne({ email: emailB }).lean();
  userC = await User.findOne({ email: emailC }).lean();
  check('three accounts registered and logged in', Boolean(tokenA && tokenB && tokenC && userA && userB && userC),
    `tokens=${[tokenA, tokenB, tokenC].filter(Boolean).length}/3`);
}

// ---------------------------------------------------------------------------
// 2. Create -> read -> partial update -> hard delete (verification command 3)
// ---------------------------------------------------------------------------
let publicProfileId;
{
  const created = await post('/api/v1/profile', fullProfile(), tokenA);
  const profile = created.json?.data?.profile;
  publicProfileId = profile?.publicProfileId;

  check('A creates a profile -> 201 draft with a CHV- id',
    created.status === 201 && profile?.status === 'draft' && /^CHV-[2-9A-HJKMNP-Z]{5}$/.test(publicProfileId || ''),
    `status=${created.status} id=${publicProfileId} state=${profile?.status}`);

  const user = await User.findById(userA._id).lean();
  check('users.profileCreated flips on create',
    user.profileCreated === true && user.onboardingCompleted === true,
    `profileCreated=${user.profileCreated} onboarding=${user.onboardingCompleted}`);

  const dup = await post('/api/v1/profile', fullProfile(), tokenA);
  check('a second profile for the same account -> 409', dup.status === 409, `status=${dup.status}`);

  const own = await req('/api/v1/profile/me', { headers: auth(tokenA) });
  check('GET /profile/me -> 200 own profile',
    own.status === 200 && own.json?.data?.profile?.publicProfileId === publicProfileId,
    `status=${own.status} id=${own.json?.data?.profile?.publicProfileId}`);

  const patched = await patch('/api/v1/profile', { career: { occupationId: id(occupation), designation: 'Tech Lead' } }, tokenA);
  const patchedProfile = patched.json?.data?.profile;
  check('partial PATCH -> 200, untouched sections survive',
    patched.status === 200
      && patchedProfile?.career?.designation === 'Tech Lead'
      && patchedProfile?.basic?.firstName === 'Vikram'
      && patchedProfile?.status === 'draft',
    `status=${patched.status} designation=${patchedProfile?.career?.designation} first=${patchedProfile?.basic?.firstName}`);

  // Denormalised copies are written from the master row (spec §10, §97).
  // Step 07 turned the partner-preference section of the §57 score on and step
  // 08 turned the photo section on, so a profile that is complete in every
  // profile section but has neither yet scores the enabled weight minus both —
  // hence the computed expectation rather than a literal 100. At this point A
  // has no preferences and no photo, so the score is the profile sections only.
  const row = await MatrimonialProfile.findOne({ publicProfileId }).lean();
  const enabledWeight = COMPLETION_WEIGHTS.filter((entry) => entry.enabled).reduce((sum, entry) => sum + entry.weight, 0);
  const offDocumentWeight = COMPLETION_WEIGHTS.filter(
    (entry) => entry.enabled && (entry.key === 'partnerPreferences' || entry.key === 'photo')
  ).reduce((sum, entry) => sum + entry.weight, 0);
  const expectedCompletion = Math.round(((enabledWeight - offDocumentWeight) / enabledWeight) * 100);
  check('DB row carries the denormalised names and the completion score',
    row?.community?.gotraName === gotra.name
      && row?.community?.surnameName === surname.name
      && row?.location?.cityName === city.name
      && row?.career?.occupationName === occupation.name
      && Number.isInteger(row?.profile?.completionPercentage)
      && row?.profile?.completionPercentage === expectedCompletion,
    `gotra=${row?.community?.gotraName} city=${row?.location?.cityName} completion=${row?.profile?.completionPercentage} expected=${expectedCompletion}`);

  if (city.coordinates && city.coordinates.lat != null) {
    check('server derives coordinates from the selected city (never from the body)',
      row?.location?.coordinates?.type === 'Point' && Array.isArray(row?.location?.coordinates?.coordinates),
      `coordinates=${JSON.stringify(row?.location?.coordinates)}`);
  }

  check('the owner sees their own restricted fields (§112: user only)',
    JSON.stringify(own.json?.data?.profile?.location || {}).includes('coordinates')
      && JSON.stringify(own.json?.data?.profile?.horoscope || {}).includes('birthTime'),
    `ownKeys=${Object.keys(own.json?.data?.profile?.location || {}).join(',')}`);
}

// ---------------------------------------------------------------------------
// 3. Empty account: null profile, not a phantom (verification command 4)
// ---------------------------------------------------------------------------
{
  const own = await req('/api/v1/profile/me', { headers: auth(tokenB) });
  check('B GET /profile/me -> 200 profile:null before onboarding',
    own.status === 200 && own.json?.data?.profile === null,
    `status=${own.status} profile=${JSON.stringify(own.json?.data?.profile)}`);

  const patched = await patch('/api/v1/profile', { about: { headline: 'nope' } }, tokenB);
  check('B PATCH without a profile -> 404', patched.status === 404, `status=${patched.status}`);

  const removed = await req('/api/v1/profile', { method: 'DELETE', headers: auth(tokenB) });
  check('B DELETE without a profile -> 404', removed.status === 404, `status=${removed.status}`);
}

// ---------------------------------------------------------------------------
// 4. Status lifecycle: draft invisible -> active visible -> hidden invisible
// ---------------------------------------------------------------------------
{
  const draft = await req(`/api/v1/profile/${publicProfileId}`, { headers: auth(tokenB) });
  check('B reads A\'s draft -> 404 (drafts are not public)', draft.status === 404, `status=${draft.status}`);

  // A primary photo is required before publishing (spec §15, step 08): without
  // one this PATCH is a 409 naming `photos` as the missing requirement.
  const beforePhoto = await patch('/api/v1/profile', { status: 'active' }, tokenA);
  const photo = await addPrimaryPhoto(tokenA);

  const activate = await patch('/api/v1/profile', { status: 'active' }, tokenA);
  check('A publishes: draft -> active -> 200', activate.status === 200 && activate.json?.data?.profile?.status === 'active',
    `status=${activate.status} state=${activate.json?.data?.profile?.status} withoutPhoto=${beforePhoto.status} photo=${photo ? 'yes' : 'no'}`);

  const visible = await req(`/api/v1/profile/${publicProfileId}`, { headers: auth(tokenB) });
  const raw = JSON.stringify(visible.json);
  const leaks = RESTRICTED.filter((field) => raw.includes(field));
  check('B reads A\'s active profile -> 200 with every restricted field absent',
    visible.status === 200 && leaks.length === 0,
    `status=${visible.status} leaks=${leaks.join(',') || 'none'}`);

  check('the public view still carries display fields (age/height/city)',
    visible.json?.data?.profile?.age >= 18
      && typeof visible.json?.data?.profile?.height?.display === 'string'
      && visible.json?.data?.profile?.location?.cityName === city.name,
    `age=${visible.json?.data?.profile?.age} height=${JSON.stringify(visible.json?.data?.profile?.height)}`);

  const hide = await patch('/api/v1/profile', { status: 'hidden' }, tokenA);
  const hidden = await req(`/api/v1/profile/${publicProfileId}`, { headers: auth(tokenB) });
  check('A hides the profile -> 200 and it disappears from public reads',
    hide.status === 200 && hidden.status === 404,
    `patch=${hide.status} read=${hidden.status}`);

  // Republish for the security checks below.
  await patch('/api/v1/profile', { status: 'active' }, tokenA);
}

// ---------------------------------------------------------------------------
// 5. Ownership + validation + injection (verification command 7)
// ---------------------------------------------------------------------------
{
  const before = await MatrimonialProfile.findOne({ userId: userB._id }).lean();
  const attack = await patch('/api/v1/profile', { userId: id(userB), basic: { firstName: 'Hacked' } }, tokenA);
  const after = await MatrimonialProfile.findOne({ userId: userB._id }).lean();
  check('a userId in the body -> 400 and the other account is untouched',
    attack.status === 400 && JSON.stringify(after) === JSON.stringify(before),
    `status=${attack.status} changed=${JSON.stringify(after) !== JSON.stringify(before)}`);

  const unknown = await patch('/api/v1/profile', { basic: { isAdmin: true } }, tokenA);
  check('an unknown field -> 400 with a field-level message',
    unknown.status === 400 && /Unrecognized/i.test(JSON.stringify(unknown.json?.details || {})),
    `status=${unknown.status} details=${JSON.stringify(unknown.json?.details)}`);

  const badHeight = await patch('/api/v1/profile', { basic: { heightCm: 50 } }, tokenA);
  check('an out-of-range height -> 400', badHeight.status === 400, `status=${badHeight.status}`);

  const badBrothers = await patch('/api/v1/profile', { family: { brothersCount: 1, marriedBrothersCount: 3 } }, tokenA);
  check('married > total siblings -> 400', badBrothers.status === 400, `status=${badBrothers.status}`);

  const injected = await patch('/api/v1/profile', { community: { gotraId: { $ne: 1 } } }, tokenA);
  check('an object-shaped filter value -> 400, not a query', injected.status === 400, `status=${injected.status}`);

  const junk = await req('/api/v1/profile?publicProfileId[$ne]=x', { headers: auth(tokenA) });
  check('a junk query string matches no route and returns no data',
    junk.status === 404 && junk.json?.data === undefined,
    `status=${junk.status} data=${JSON.stringify(junk.json?.data)}`);

  const anon = await req('/api/v1/profile/me');
  check('no token -> 401', anon.status === 401 && anon.json?.code === 'AUTHENTICATION_REQUIRED',
    `status=${anon.status}`);
}

// ---------------------------------------------------------------------------
// 6. Suspended account cannot touch its profile (spec §44)
// ---------------------------------------------------------------------------
{
  await User.updateOne({ _id: userC._id }, { $set: { status: 'suspended' } });
  try {
    await post('/api/v1/profile', fullProfile(), tokenC);
    const read = await req('/api/v1/profile/me', { headers: auth(tokenC) });
    const write = await patch('/api/v1/profile', { about: { headline: 'x' } }, tokenC);
    check('a suspended account is refused reads and writes -> 403',
      read.status === 403 && write.status === 403 && read.json?.code === 'ACCOUNT_INACTIVE',
      `read=${read.status} write=${write.status} code=${read.json?.code}`);
  } finally {
    await User.updateOne({ _id: userC._id }, { $set: { status: 'active' } });
  }
}

// ---------------------------------------------------------------------------
// 7. Hard delete removes the profile, and a fresh profile can be created
// ---------------------------------------------------------------------------
{
  const removed = await req('/api/v1/profile', { method: 'DELETE', headers: auth(tokenA) });
  const row = await MatrimonialProfile.findOne({ publicProfileId }).lean();
  const publicRead = await req(`/api/v1/profile/${publicProfileId}`, { headers: auth(tokenB) });
  const own = await req('/api/v1/profile/me', { headers: auth(tokenA) });
  check('hard delete -> row removed, public read 404, owner has no profile',
    removed.status === 200 && row === null && publicRead.status === 404
      && own.status === 200 && own.json?.data?.profile === null,
    `delete=${removed.status} db=${row?.profile?.status} public=${publicRead.status} own=${own.status}`);

  const edit = await patch('/api/v1/profile', { about: { headline: 'deleted' } }, tokenA);
  check('a deleted profile is not writable -> 404', edit.status === 404, `status=${edit.status}`);

  const again = await post('/api/v1/profile', fullProfile(), tokenA);
  check('create after delete -> 201 with a new publicProfileId, as a draft',
    again.status === 201
      && again.json?.data?.profile?.publicProfileId !== publicProfileId
      && again.json?.data?.profile?.status === 'draft',
    `status=${again.status} id=${again.json?.data?.profile?.publicProfileId} state=${again.json?.data?.profile?.status}`);
}

// ---------------------------------------------------------------------------
// 8. Indexes: §105 checklist + the uniqueness guarantees, then the script gate
// ---------------------------------------------------------------------------
{
  const indexes = await MatrimonialProfile.collection.indexes();
  const names = new Set(indexes.map((entry) => entry.name));
  const expected = [
    'userId_1', 'publicProfileId_1', 'profile.status_1', 'profile.lastActiveAt_-1',
    'basic.gender_1_basic.dateOfBirth_-1', 'basic.maritalStatus_1',
    'community.communityId_1', 'community.gotraId_1', 'community.surnameId_1',
    'community.clanId_1', 'community.aaspadId_1',
    'location.stateId_1_location.cityId_1', 'career.occupationId_1',
    'education.degreeId_1', 'location_2dsphere'
  ];
  const missing = expected.filter((name) => !names.has(name));
  check('every §105 index exists on matrimonial_profiles', missing.length === 0,
    `missing=${missing.join(',') || 'none'}`);

  const userIdIndex = indexes.find((entry) => entry.name === 'userId_1');
  const publicIndex = indexes.find((entry) => entry.name === 'publicProfileId_1');
  check('userId and publicProfileId are both unique in the database',
    userIdIndex?.unique === true && publicIndex?.unique === true,
    `userId_unique=${userIdIndex?.unique} public_unique=${publicIndex?.unique}`);

  // Prove the public id is not derived from the ObjectId.
  const row = await MatrimonialProfile.findOne({ publicProfileId }).lean();
  check('publicProfileId is not an ObjectId and embeds none of it',
    /^CHV-/.test(publicProfileId) && !publicProfileId.includes(String(row._id)) && String(row._id).length === 24,
    `id=${publicProfileId} oid=${row._id}`);
}

{
  let scriptPass = false;
  let detail = '';
  try {
    execFileSync(process.execPath, ['scripts/verify-indexes.js'], { stdio: 'pipe' });
    scriptPass = true;
  } catch (err) {
    detail = (err.stdout ? String(err.stdout) : '') + (err.stderr ? String(err.stderr) : '');
    detail = detail.split('\n').filter(Boolean).slice(-4).join(' | ');
  }
  check('scripts/verify-indexes.js exits 0 for this database', scriptPass, detail || 'exit 0');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
await mongoose.disconnect();

const failed = results.filter((entry) => !entry.pass);
for (const entry of results) {
  console.log(`${entry.pass ? 'PASS' : 'FAIL'}  ${entry.name}${entry.detail ? ` — ${entry.detail}` : ''}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length > 0) {
  console.error(`FAILED: ${failed.map((entry) => entry.name).join(' | ')}`);
  // exitCode, not process.exit(): same status, but stdout flushes first.
  process.exitCode = 1;
}
