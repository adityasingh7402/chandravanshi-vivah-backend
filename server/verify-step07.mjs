// Step 07 scripted verification — runs the doc's verification commands against a live server.
// Seed + boot the server with the test database first, then run with the SAME database:
//   MONGODB_DB_NAME=chandravanshi_vivah_test node verify-step07.mjs
// The harness drives the API end to end (create partial -> duplicate -> patch ->
// invalid range/id/cap -> unauthenticated -> completion), inspects the database
// for the §105 unique index, the index-backed lookup and the §47 "no stored age"
// rule, and re-runs scripts/verify-indexes.js as the final index gate.
// Exit code 0 means every check passed.
import mongoose from 'mongoose';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const config = require('./src/config/env');
const User = require('./src/models/User');
const MatrimonialProfile = require('./src/models/MatrimonialProfile');
const PartnerPreference = require('./src/models/PartnerPreference');
const preferenceService = require('./src/services/preferenceService');
const { COMPLETION_WEIGHTS } = require('./src/constants/profile');
const { getMasterModel } = require('./src/models/masterData/MasterItem');

const BASE = `http://localhost:${config.port}`;
const PASSWORD = 'correct-horse-battery';
const RUN = Date.now();
const CAP = config.preference.maxMultiSelect;

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

let photoSeq = 0;

/**
 * Register a primary photo (step 08). It carries 10 of the §57 weight, so the
 * "full profile, no preferences" figure is 85 rather than 75. The API process
 * runs with `CLOUDINARY_MOCK=true` under the gate runner, so the asset gateway is
 * local and no account is needed.
 */
async function addPrimaryPhoto(token) {
  const sign = await post('/api/v1/photos/sign', {}, token);
  const folder = sign.json?.data?.upload?.folder;
  if (!folder) return null;
  photoSeq += 1;
  const res = await post('/api/v1/photos', { publicId: `${folder}/s7-${photoSeq}`, type: 'profile' }, token);
  return res.status === 201 ? res.json?.data?.photo : null;
}

async function register(identifier) {
  return post('/api/v1/auth/register', { identifierType: 'email', identifier, password: PASSWORD });
}

async function login(identifier) {
  const r = await post('/api/v1/auth/login',
    { identifierType: 'email', identifier, password: PASSWORD, deviceType: 'android' });
  return r.json?.data?.accessToken;
}

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

const otherCommunity = communities.find((entry) => String(entry._id) !== String(community?._id));
const foreignGotra = otherCommunity
  ? await getMasterModel('gotras').findOne({ communityId: otherCommunity._id, isActive: true }).select('_id name').lean()
  : null;

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
    about: { description: 'Grounded family, simple habits, straightforward person.', ...(overrides.about || {}) }
  };
}

/** Preferences filling every §57-scored dimension. */
function fullPreferences(overrides = {}) {
  return {
    age: { min: 24, max: 30 },
    heightCm: { min: 160, max: 180 },
    gender: 'female',
    maritalStatus: ['never_married', 'divorced'],
    educationIds: [id(degree)],
    occupationIds: [id(occupation)],
    incomeRanges: ['5_10_lpa'],
    cityIds: [id(city)],
    communityIds: [id(community)],
    diet: ['vegetarian'],
    ...(overrides || {})
  };
}

/** The §57 score of a full profile that has no preferences yet. */
const enabledWeight = COMPLETION_WEIGHTS.filter((entry) => entry.enabled).reduce((sum, entry) => sum + entry.weight, 0);
const preferenceWeight = COMPLETION_WEIGHTS.find((entry) => entry.key === 'partnerPreferences').weight;
const WITHOUT_PREFERENCES = Math.round(((enabledWeight - preferenceWeight) / enabledWeight) * 100);

// ---------------------------------------------------------------------------
// 1. Health (step 01 regression) + accounts
// ---------------------------------------------------------------------------
const emailA = `s7a${RUN}@example.com`;
const emailB = `s7b${RUN}@example.com`;
const emailC = `s7c${RUN}@example.com`;
let tokenA;
let tokenB;
let tokenC;
let userA;
let userB;
let userC;

{
  const res = await req('/api/v1/health');
  check('health 200 + database.connected', res.status === 200 && res.json?.data?.database?.connected === true,
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

// A needs a profile: it is the gender default source and the completion subject.
// A primary photo comes with it — the §57 score includes the photo section and
// the platform requires one before publishing (spec §15).
let completionBefore = null;
{
  const created = await post('/api/v1/profile', fullProfile(), tokenA);
  const photo = await addPrimaryPhoto(tokenA);
  const reloaded = await req('/api/v1/profile/me', { headers: auth(tokenA) });
  completionBefore = reloaded.json?.data?.profile?.completionPercentage;
  check('A creates a profile for completion + gender checks',
    created.status === 201 && Boolean(photo) && completionBefore === WITHOUT_PREFERENCES,
    `status=${created.status} photo=${photo ? 'yes' : 'no'} completion=${completionBefore} expected=${WITHOUT_PREFERENCES}`);
}

// ---------------------------------------------------------------------------
// 2. Command 1 — create partial preferences
// ---------------------------------------------------------------------------
{
  const created = await post('/api/v1/preferences', { age: { min: 24, max: 30 } }, tokenA);
  const preference = created.json?.data?.preferences;
  const emptyArrays = ['maritalStatus', 'educationIds', 'occupationIds', 'industryIds', 'incomeRanges',
    'countryIds', 'stateIds', 'cityIds', 'motherTongueIds', 'communityIds', 'subCommunityIds', 'surnameIds',
    'gotraIds', 'diet', 'smoking', 'drinking', 'familyTypes', 'manglikPreference'];
  check('command 1: POST partial preferences -> 201, age saved, everything else defaulted/empty',
    created.status === 201
      && preference?.age?.min === 24 && preference?.age?.max === 30
      && preference?.heightCm?.min === null && preference?.heightCm?.max === null
      && preference?.workingPreference === null
      && emptyArrays.every((field) => Array.isArray(preference?.[field]) && preference[field].length === 0),
    `status=${created.status} age=${JSON.stringify(preference?.age)} height=${JSON.stringify(preference?.heightCm)}`);
}

// ---------------------------------------------------------------------------
// 3. Command 2 — duplicate create refused
// ---------------------------------------------------------------------------
{
  const dup = await post('/api/v1/preferences', { age: { min: 24, max: 30 } }, tokenA);
  check('command 2: second POST -> 409', dup.status === 409 && dup.json?.code === 'CONFLICT',
    `status=${dup.status} code=${dup.json?.code}`);
}

// ---------------------------------------------------------------------------
// 4. Command 3 — partial update preserves earlier values
// ---------------------------------------------------------------------------
{
  const patched = await patch('/api/v1/preferences', { cityIds: [id(city)] }, tokenA);
  const read = await req('/api/v1/preferences', { headers: auth(tokenA) });
  const preference = read.json?.data?.preferences;
  check('command 3: PATCH cityIds then GET -> age still 24-30 and cityIds populated',
    patched.status === 200
      && preference?.age?.min === 24 && preference?.age?.max === 30
      && JSON.stringify(preference?.cityIds) === JSON.stringify([id(city)]),
    `status=${patched.status} age=${JSON.stringify(preference?.age)} cityIds=${JSON.stringify(preference?.cityIds)}`);
}

// ---------------------------------------------------------------------------
// 5. Command 4 — invalid range
// ---------------------------------------------------------------------------
{
  const inverted = await patch('/api/v1/preferences', { age: { min: 40, max: 20 } }, tokenA);
  const merged = await patch('/api/v1/preferences', { age: { max: 20 } }, tokenA);
  const after = await req('/api/v1/preferences', { headers: auth(tokenA) });
  check('command 4: inverted range -> 400, and a merged inversion -> 400 with nothing written',
    inverted.status === 400 && merged.status === 400
      && after.json?.data?.preferences?.age?.min === 24 && after.json?.data?.preferences?.age?.max === 30,
    `inverted=${inverted.status} merged=${merged.status} stored=${JSON.stringify(after.json?.data?.preferences?.age)}`);
}

// ---------------------------------------------------------------------------
// 6. Command 5 — invalid master-data id
// ---------------------------------------------------------------------------
{
  const before = await PartnerPreference.findOne({ userId: userA._id }).lean();
  const invalid = await patch('/api/v1/preferences', { gotraIds: ['000000000000000000000000'] }, tokenA);
  const after = await PartnerPreference.findOne({ userId: userA._id }).lean();
  check('command 5: unknown gotra id -> 400 with no write',
    invalid.status === 400
      && JSON.stringify(after.gotraIds) === JSON.stringify(before.gotraIds)
      && after.updatedAt.getTime() === before.updatedAt.getTime(),
    `status=${invalid.status} gotraIds=${JSON.stringify(after.gotraIds)}`);
}

// ---------------------------------------------------------------------------
// 7. Command 6 — array cap
// ---------------------------------------------------------------------------
{
  const overCap = await patch('/api/v1/preferences', {
    cityIds: Array.from({ length: CAP + 1 }, () => id(city))
  }, tokenA);
  const atCap = await patch('/api/v1/preferences', {
    cityIds: Array.from({ length: CAP }, () => id(city))
  }, tokenA);
  check(`command 6: ${CAP + 1} ids -> 400, exactly ${CAP} -> 200`,
    overCap.status === 400 && atCap.status === 200,
    `over=${overCap.status} at=${atCap.status} cap=${CAP}`);
}

// ---------------------------------------------------------------------------
// 8. Command 7 — unauthenticated access
// ---------------------------------------------------------------------------
{
  const anon = await req('/api/v1/preferences');
  const anonPost = await post('/api/v1/preferences', {});
  check('command 7: no token -> 401 on read and write',
    anon.status === 401 && anonPost.status === 401 && anon.json?.code === 'AUTHENTICATION_REQUIRED',
    `read=${anon.status} write=${anonPost.status} code=${anon.json?.code}`);
}

// ---------------------------------------------------------------------------
// 9. Command 8 — completion reflects preferences
// ---------------------------------------------------------------------------
{
  // A arrived here with only the partial preferences set by commands 1-7, so the
  // score rises to the maximum once the full set is saved. The exact
  // "profile with no preferences" figure is asserted below on a fresh account,
  // because A's history is deliberately not empty at this point.
  const before = await req('/api/v1/profile/me', { headers: auth(tokenA) });
  const patchPrefs = await patch('/api/v1/preferences', fullPreferences(), tokenA);
  const after = await req('/api/v1/profile/me', { headers: auth(tokenA) });
  const row = await MatrimonialProfile.findOne({ userId: userA._id }).lean();
  check('command 8: saving the full preference set raises the profile completion score',
    patchPrefs.status === 200
      && before.json?.data?.profile?.completionPercentage < 100
      && after.json?.data?.profile?.completionPercentage > before.json?.data?.profile?.completionPercentage
      && after.json?.data?.profile?.completionPercentage === 100
      && row?.profile?.completionPercentage === after.json?.data?.profile?.completionPercentage,
    `before=${before.json?.data?.profile?.completionPercentage} after=${after.json?.data?.profile?.completionPercentage} stored=${row?.profile?.completionPercentage}`);

  // The same rule from a clean slate: a full profile with its primary photo and
  // no preferences scores exactly the enabled sections other than preferences
  // (85 of 100), and a complete preference set takes it to 100. The figure is
  // derived from the weights, never a literal.
  const emailD = `s7d${RUN}@example.com`;
  await register(emailD);
  const tokenD = await login(emailD);
  const userD = await User.findOne({ email: emailD }).lean();

  const freshProfile = await post('/api/v1/profile', fullProfile(), tokenD);
  await addPrimaryPhoto(tokenD);
  const reloadedProfile = await req('/api/v1/profile/me', { headers: auth(tokenD) });
  const noPreferences = reloadedProfile.json?.data?.profile?.completionPercentage;
  const allPreferences = await post('/api/v1/preferences', fullPreferences(), tokenD);
  const withPreferences = await req('/api/v1/profile/me', { headers: auth(tokenD) });

  check('command 8: a full profile with no preferences scores WITHOUT_PREFERENCES, and the full set scores 100',
    freshProfile.status === 201
      && noPreferences === WITHOUT_PREFERENCES
      && allPreferences.status === 201
      && withPreferences.json?.data?.profile?.completionPercentage === 100
      && (await MatrimonialProfile.findOne({ userId: userD._id }).lean())?.profile?.completionPercentage === 100,
    `profile-only=${noPreferences} expected=${WITHOUT_PREFERENCES} with-preferences=${withPreferences.json?.data?.profile?.completionPercentage}`);
}

// ---------------------------------------------------------------------------
// 10. Security — ownership, enums, scoping, injection
// ---------------------------------------------------------------------------
{
  const attack = await post('/api/v1/preferences', { userId: id(userB) }, tokenC);
  check('a userId in the body -> 400 (never honoured)', attack.status === 400, `status=${attack.status}`);

  const unknown = await patch('/api/v1/preferences', { isAdmin: true }, tokenA);
  check('an unknown field -> 400 with a field-level message',
    unknown.status === 400 && /Unrecognized/i.test(JSON.stringify(unknown.json?.details || {})),
    `status=${unknown.status} details=${JSON.stringify(unknown.json?.details)}`);

  const injected = await patch('/api/v1/preferences', { cityIds: [{ $ne: null }] }, tokenA);
  check('an object-shaped filter value -> 400, not a query', injected.status === 400, `status=${injected.status}`);

  const junk = await req(`/api/v1/preferences/${id(userA._id)}`, { headers: auth(tokenB) });
  check('no route exposes another account\'s preferences -> 404',
    junk.status === 404 && junk.json?.data === undefined,
    `status=${junk.status} data=${JSON.stringify(junk.json?.data)}`);

  const boolean = await patch('/api/v1/preferences', { horoscopeRequired: true }, tokenA);
  const enumOk = await patch('/api/v1/preferences', { horoscopeRequired: 'not_important' }, tokenA);
  check('horoscopeRequired is the finalized 3-value enum, not a boolean (decisions §4)',
    boolean.status === 400 && enumOk.status === 200 && enumOk.json?.data?.preferences?.horoscopeRequired === 'not_important',
    `boolean=${boolean.status} enum=${enumOk.status}`);

  const badEnum = await patch('/api/v1/preferences', { workingPreference: 'Working' }, tokenA);
  check('a non-lowercase / unknown enum value -> 400', badEnum.status === 400, `status=${badEnum.status}`);

  if (foreignGotra && otherCommunity) {
    const foreign = await patch('/api/v1/preferences', { gotraIds: [id(foreignGotra)] }, tokenA);
    const allowed = await patch('/api/v1/preferences', {
      communityIds: [id(community), id(otherCommunity)],
      gotraIds: [id(foreignGotra)]
    }, tokenA);
    check('a gotra from another community is refused until that community is chosen',
      foreign.status === 400 && allowed.status === 200,
      `foreign=${foreign.status} allowed=${allowed.status}`);
  } else {
    check('cross-community gotra scoping', false, 'the seed has only one community with a gotra');
  }
}

// ---------------------------------------------------------------------------
// 11. Suspended account (spec §44)
// ---------------------------------------------------------------------------
{
  await User.updateOne({ _id: userC._id }, { $set: { status: 'suspended' } });
  try {
    const read = await req('/api/v1/preferences', { headers: auth(tokenC) });
    const write = await patch('/api/v1/preferences', { gender: 'female' }, tokenC);
    check('a suspended account is refused reads and writes -> 403',
      read.status === 403 && write.status === 403 && read.json?.code === 'ACCOUNT_INACTIVE',
      `read=${read.status} write=${write.status} code=${read.json?.code}`);
  } finally {
    await User.updateOne({ _id: userC._id }, { $set: { status: 'active' } });
  }
}

// ---------------------------------------------------------------------------
// 12. Data model + effective filters + indexes
// ---------------------------------------------------------------------------
{
  const indexes = await PartnerPreference.collection.indexes();
  const userIdIndex = indexes.find((entry) => entry.name === 'userId_1');
  check('partner_preferences has the unique userId index (spec §105)',
    userIdIndex?.unique === true,
    `indexes=${indexes.map((entry) => entry.name).join(',')}`);

  await PartnerPreference.find({ userId: userA._id }).limit(1);
  const plan = JSON.stringify(await PartnerPreference.find({ userId: userA._id }).explain('executionStats'));
  check('the userId lookup is served by an IXSCAN, never a COLLSCAN',
    plan.includes('IXSCAN') && plan.includes('userId_1') && !plan.includes('"COLLSCAN"'),
    plan.slice(0, 160));

  const raw = await PartnerPreference.findOne({ userId: userA._id }).lean();
  check('no computed age is stored (spec §47)',
    typeof raw.age === 'object' && !Number.isInteger(raw.age) && raw.ageValue === undefined,
    `age=${JSON.stringify(raw.age)}`);

  const filters = await preferenceService.effectiveFilters(id(userA._id));
  const json = JSON.stringify(filters);
  check('effectiveFilters holds only set dimensions, only plain values, no operators',
    filters.gender === 'female'
      && Array.isArray(filters.cityIds) && filters.cityIds.length === 1
      && !('workingPreference' in filters)
      && !json.includes('"$'),
    `gender=${filters.gender} keys=${Object.keys(filters).join(',')}`);

  const noPrefs = await preferenceService.effectiveFilters(id(userB._id));
  check('an account with no preferences yields an empty filter object',
    Object.keys(noPrefs).length === 0,
    `keys=${Object.keys(noPrefs).join(',')}`);
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
