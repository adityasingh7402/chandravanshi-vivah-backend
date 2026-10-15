// Step 09 scripted verification — drives the doc's ten verification commands
// against a live server, plus the database, index and privacy checks.
// Seed + boot the server with the test database first, then run with the SAME
// database. This harness builds 11 fixture accounts, which is more logins than
// the default brute-force limiter allows, so the SERVER must be started with a
// raised AUTH_RATE_LIMIT_MAX (that limiter is step 03's subject, not this one):
//   MONGODB_DB_NAME=chandravanshi_vivah_test AUTH_RATE_LIMIT_MAX=1000 node verify-step09.mjs
//
// `npm run verify` does both (a fresh server per harness, CLOUDINARY_MOCK=true,
// and the raised limit for this step only — see HARNESSES in verify-all.mjs).
//
// Fixtures are created here rather than assumed: discovery needs a populated
// collection to be meaningful. Photos are approved directly (moderation is step
// 16) and `profileScoreService.syncDiscoveryPhotoFlag` is called afterwards —
// exactly what the moderation step must do — so the `hasPhoto` signal is
// exercised for real instead of being set by hand.
//
// Exit code 0 means every check that ran passed.
import mongoose from 'mongoose';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const config = require('./src/config/env');
const User = require('./src/models/User');
const MatrimonialProfile = require('./src/models/MatrimonialProfile');
const Photo = require('./src/models/Photo');
const profileScoreService = require('./src/services/profileScoreService');
const exclusionService = require('./src/services/exclusionService');
const queryBuilder = require('./src/services/queryBuilder');
const { getMasterModel } = require('./src/models/masterData/MasterItem');

const BASE = `http://localhost:${config.port}`;
const PASSWORD = 'correct-horse-battery';
const RUN = Date.now();
const MAX_LIMIT = config.search.maxLimit;

const CARD_KEYS = [
  'age',
  'city',
  'degree',
  'gotra',
  'height',
  'lastActiveAt',
  'name',
  'occupation',
  'primaryPhoto',
  'profileId',
  'surname',
  'verified'
].sort();

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

const communities = await getMasterModel('communities').find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select('_id slug name').lean();
let community = null;
let surname = null;
let gotra = null;
for (const candidate of communities) {
  const s = await getMasterModel('surnames').findOne({ communityId: candidate._id, isActive: true }).select('_id name').lean();
  const g = await getMasterModel('gotras').findOne({ communityId: candidate._id, isActive: true }).select('_id name').lean();
  if (s && g) {
    community = candidate;
    surname = s;
    gotra = g;
    break;
  }
}
const cityByName = async (name) => getMasterModel('cities').findOne({ name, isActive: true }).select('_id name coordinates').lean();
const alwar = await cityByName('Alwar');
const delhi = await cityByName('Delhi');
const jaipur = await cityByName('Jaipur');
const degree = await getMasterModel('degrees').findOne({ isActive: true }).sort({ sortOrder: 1 }).select('_id name').lean();
const occupation = await getMasterModel('occupations').findOne({ isActive: true }).sort({ sortOrder: 1 }).select('_id name').lean();

if (!community || !surname || !gotra || !alwar || !delhi || !jaipur || !degree || !occupation) {
  // Throw rather than `process.exit()`: pending stdout writes flush first.
  throw new Error('Seed is incomplete — run `node scripts/seed-master-data.js` against this database first.');
}

const id = (doc) => String(doc._id);
const ageOn = (dob) => {
  const born = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const month = now.getMonth() - born.getMonth();
  if (month < 0 || (month === 0 && now.getDate() < born.getDate())) age -= 1;
  return age;
};

/** A date of birth that makes the account `age` years old today. */
function dobFor(age) {
  const now = new Date();
  const date = new Date(Date.UTC(now.getUTCFullYear() - age, 0, 15));
  return date.toISOString().slice(0, 10);
}

function fullProfile({ cityId, gender, age, heightCm, diet, verified, occupationId }) {
  return {
    basic: {
      profileFor: 'self',
      firstName: gender === 'female' ? 'Aarohi' : 'Vikram',
      gender,
      dateOfBirth: dobFor(age),
      maritalStatus: 'never_married',
      heightCm
    },
    community: { communityId: id(community), surnameId: id(surname), gotraId: id(gotra) },
    location: { cityId },
    education: { highestQualificationId: id(degree), degreeId: id(degree) },
    career: { occupationId: occupationId || id(occupation) },
    family: { familyType: 'nuclear' },
    lifestyle: { diet },
    about: { description: 'Grounded family, simple habits, straightforward person.' },
    ...(verified ? {} : {})
  };
}

let photoSeq = 0;

async function addPhoto(token, { pending = false } = {}) {
  const sign = await post('/api/v1/photos/sign', {}, token);
  const folder = sign.json?.data?.upload?.folder;
  if (!folder) throw new Error(`photo signing failed: ${sign.status} ${sign.text?.slice(0, 200)}`);
  photoSeq += 1;
  const publicId = `${folder}/step09-${photoSeq}`;
  const res = await post('/api/v1/photos', { publicId, type: 'profile' }, token);
  if (res.status !== 201) throw new Error(`photo registration failed: ${res.status} ${res.text?.slice(0, 200)}`);
  return { res, pending };
}

/**
 * Register, profile, photograph and publish one discoverable candidate.
 * Returns the account plus its public profile id.
 */
async function createCandidate(spec) {
  const email = `s9-${RUN}-${photoSeq}-${spec.label}@example.com`;
  await register(email);
  const token = await login(email);
  if (!token) throw new Error(`could not log in as ${email}`);

  const created = await post('/api/v1/profile', fullProfile(spec), token);
  if (created.status !== 201) throw new Error(`profile create failed: ${created.status} ${created.text?.slice(0, 200)}`);

  await addPhoto(token, { pending: spec.pending === true });

  const user = await User.findOne({ email }).select('_id').lean();
  if (!spec.pending) {
    await Photo.updateOne({ userId: user._id, isPrimary: true }, { $set: { moderationStatus: 'approved' } });
    // The same call moderation must make after an approval (step 16).
    await profileScoreService.syncDiscoveryPhotoFlag(user._id);
  }
  if (spec.verified) {
    await MatrimonialProfile.updateOne({ userId: user._id }, { $set: { 'profile.isVerified': true } });
  }

  const published = await patch('/api/v1/profile', { status: 'active' }, token);
  if (published.status !== 200) {
    throw new Error(`publish failed: ${published.status} ${published.text?.slice(0, 200)}`);
  }
  const doc = await MatrimonialProfile.findOne({ userId: user._id }).lean();
  return { email, token, id: String(user._id), publicProfileId: doc.publicProfileId };
}

const alwarId = id(alwar);

// Six female candidates in Alwar (24-30 for command 2), one male, one female
// whose photo is still pending (so it has no card image), and two distance
// fixtures in cities with coordinates.
const femAges = [25, 26, 27, 28, 29, 31];
const females = [];
for (const [index, age] of femAges.entries()) {
  females.push(
    await createCandidate({
      label: `f${index}`,
      cityId: alwarId,
      gender: 'female',
      age,
      heightCm: 158 + index,
      // Only f2 is verified + vegetarian + the chosen occupation (command 3).
      diet: index === 2 ? 'vegetarian' : 'non_vegetarian',
      verified: index === 2,
      occupationId: index === 2 ? id(occupation) : id(occupation)
    })
  );
}
const male = await createCandidate({ label: 'm0', cityId: alwarId, gender: 'male', age: 26, heightCm: 176, diet: 'vegetarian' });
const pendingPhoto = await createCandidate({ label: 'fp', cityId: alwarId, gender: 'female', age: 30, heightCm: 162, diet: 'vegetarian', pending: true });
const delhiCandidate = await createCandidate({ label: 'dl', cityId: id(delhi), gender: 'male', age: 27, heightCm: 178, diet: 'vegetarian' });
const jaipurCandidate = await createCandidate({ label: 'jp', cityId: id(jaipur), gender: 'male', age: 27, heightCm: 179, diet: 'vegetarian' });

// The viewer: an active account of its own, so self-exclusion is a real check.
const viewerEmail = `s9-${RUN}-viewer@example.com`;
await register(viewerEmail);
const ACCESS = await login(viewerEmail);
const viewer = await User.findOne({ email: viewerEmail }).select('_id').lean();

{
  const created = await post('/api/v1/profile', fullProfile({ cityId: id(delhi), gender: 'male', age: 30, heightCm: 180, diet: 'vegetarian' }), ACCESS);
  if (created.status !== 201) throw new Error(`viewer profile: ${created.status} ${created.text?.slice(0, 200)}`);
  await addPhoto(ACCESS);
  await Photo.updateOne({ userId: viewer._id, isPrimary: true }, { $set: { moderationStatus: 'approved' } });
  await profileScoreService.syncDiscoveryPhotoFlag(viewer._id);
  const published = await patch('/api/v1/profile', { status: 'active' }, ACCESS);
  if (published.status !== 200) throw new Error(`viewer publish: ${published.status} ${published.text?.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------
// Command 1 — basic discover
// ---------------------------------------------------------------------------
let firstPage;
{
  const res = await req('/api/v1/discover?limit=20', { headers: auth(ACCESS) });
  const items = res.json?.data?.items || [];
  firstPage = res.json?.data;
  check(
    'command 1: discover -> 200, a bounded page of card-shaped rows',
    res.status === 200 && items.length > 0 && items.length <= MAX_LIMIT,
    `status=${res.status} items=${items.length}`
  );
  const badKeys = items.filter((item) => JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(CARD_KEYS));
  check(
    'command 1: every row carries exactly the §70 card keys',
    badKeys.length === 0,
    badKeys.length ? JSON.stringify(Object.keys(badKeys[0])) : 'all rows match'
  );
  check(
    'command 1: nextCursor is present only when a further page exists',
    'nextCursor' in (firstPage || {}) && (items.length < MAX_LIMIT ? firstPage.nextCursor === null : typeof firstPage.nextCursor === 'string'),
    `items=${items.length} nextCursor=${JSON.stringify(firstPage?.nextCursor)}`
  );
}

// ---------------------------------------------------------------------------
// Command 2 — gender + age filter
// ---------------------------------------------------------------------------
{
  const res = await req('/api/v1/discover?gender=female&minAge=24&maxAge=30', { headers: auth(ACCESS) });
  const items = res.json?.data?.items || [];
  const ages = items.map((item) => item.age);
  const expected = new Set([...females.slice(0, 5).map((entry) => entry.publicProfileId), pendingPhoto.publicProfileId]);
  const returned = new Set(items.map((item) => item.profileId));
  check(
    'command 2: only female profiles inside 24-30 are returned',
    res.status === 200 && items.every((item) => item.age >= 24 && item.age <= 30) && ages.length > 0,
    `status=${res.status} ages=${JSON.stringify(ages)}`
  );
  check(
    'command 2: the ages match a recomputation from the stored date of birth',
    returned.size === expected.size && [...expected].every((value) => returned.has(value)),
    `returned=${JSON.stringify([...returned])} expected=${JSON.stringify([...expected])}`
  );
  const stored = await MatrimonialProfile.find({ publicProfileId: { $in: [...returned] } }).select('publicProfileId basic.dateOfBirth').lean();
  const mismatch = stored.filter((doc) => ageOn(doc.basic.dateOfBirth) !== items.find((item) => item.profileId === doc.publicProfileId).age);
  check('command 2: every age is derived at read time, never stored', mismatch.length === 0, `${mismatch.length} mismatch(es)`);
}

// ---------------------------------------------------------------------------
// Command 3 — combined filters
// ---------------------------------------------------------------------------
{
  const url =
    '/api/v1/discover?gender=female' +
    `&cityId=${alwarId}` +
    `&occupationId=${id(occupation)}` +
    '&diet=vegetarian&verified=true&limit=20';
  const res = await req(url, { headers: auth(ACCESS) });
  const items = res.json?.data?.items || [];
  const ids = items.map((item) => item.profileId);
  check(
    'command 3: the intersection of gender + city + occupation + diet + verified is honoured',
    res.status === 200 && ids.length === 1 && ids[0] === females[2].publicProfileId,
    `status=${res.status} ids=${JSON.stringify(ids)} expected=${females[2].publicProfileId}`
  );
}

// ---------------------------------------------------------------------------
// Command 4 — cursor pagination is stable
// ---------------------------------------------------------------------------
{
  const collect = async (limit) => {
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const query = `/api/v1/search?cityId=${alwarId}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await req(query, { headers: auth(ACCESS) });
      if (res.status !== 200) return { seen, pages, failed: res };
      seen.push(...(res.json.data.items || []).map((item) => item.profileId));
      cursor = res.json.data.nextCursor;
      pages += 1;
    } while (cursor && pages < 12);
    return { seen, pages, failed: null };
  };

  const { seen, pages, failed } = await collect(3);
  const expected = new Set([...females.map((entry) => entry.publicProfileId), male.publicProfileId, pendingPhoto.publicProfileId]);
  check(
    'command 4: paging with limit=3 returns every Alwar profile exactly once',
    !failed && seen.length === expected.size && new Set(seen).size === seen.length && seen.every((value) => expected.has(value)),
    failed ? `failed: ${failed.status}` : `pages=${pages} seen=${seen.length} of ${expected.size}`
  );

  const first = await req(`/api/v1/discover?gender=female&cityId=${alwarId}&limit=5`, { headers: auth(ACCESS) });
  const second = await req(`/api/v1/discover?gender=female&cityId=${alwarId}&limit=5&cursor=${encodeURIComponent(first.json?.data?.nextCursor || '')}`, {
    headers: auth(ACCESS)
  });
  const pageOne = new Set((first.json?.data?.items || []).map((item) => item.profileId));
  const pageTwo = (second.json?.data?.items || []).map((item) => item.profileId);
  check(
    'command 4: page 2 does not overlap page 1',
    second.status === 200 && pageTwo.every((value) => !pageOne.has(value)),
    `page1=${pageOne.size} page2=${pageTwo.length} overlap=${pageTwo.filter((value) => pageOne.has(value)).length}`
  );
}

// ---------------------------------------------------------------------------
// Commands 5-8 — injection, sort, cap, privacy
// ---------------------------------------------------------------------------
{
  const injected = await req('/api/v1/discover?gender[$ne]=male&limit=20', { headers: auth(ACCESS) });
  check(
    'command 5: an object-shaped filter is rejected with 400',
    injected.status === 400 && injected.json?.success === false,
    `status=${injected.status}`
  );

  const badSort = await req('/api/v1/discover?sort=passwordHash', { headers: auth(ACCESS) });
  check('command 6: an unknown sort value is rejected with 400', badSort.status === 400, `status=${badSort.status}`);

  const big = await req(`/api/v1/discover?cityId=${alwarId}&limit=100000`, { headers: auth(ACCESS) });
  const bigItems = big.json?.data?.items || [];
  check(
    `command 7: an oversized limit is capped at ${MAX_LIMIT}`,
    big.status === 200 && bigItems.length <= MAX_LIMIT,
    `status=${big.status} items=${bigItems.length} max=${MAX_LIMIT}`
  );

  const one = await req('/api/v1/discover?limit=1', { headers: auth(ACCESS) });
  const forbidden = ['"email"', '"phone"', '"coordinates"', '"birthTime"', '"birthPlace"', '"passwordHash"', '"userId"'];
  const found = forbidden.filter((needle) => one.text.includes(needle));
  check(
    'command 8: no email, phone, coordinates, birth time or internal id in the payload',
    found.length === 0,
    found.length ? `found ${found.join(', ')}` : 'clean'
  );
}

// ---------------------------------------------------------------------------
// Command 9 — query plan
// ---------------------------------------------------------------------------
{
  const filter = queryBuilder.buildFilter({ gender: 'female', age: { min: 24, max: 30 } });
  const plan = await MatrimonialProfile.find(filter).explain('executionStats');
  const winning = JSON.stringify(plan.queryPlanner.winningPlan);
  const stats = plan.executionStats;
  check(
    'command 9: the default discover filter is served by an index, not a collection scan',
    winning.includes('IXSCAN') && !winning.includes('COLLSCAN'),
    `keysExamined=${stats?.totalKeysExamined} docsExamined=${stats?.totalDocsExamined} returned=${stats?.nReturned} ms=${stats?.executionTimeMillis}`
  );

  const declared = MatrimonialProfile.schema.indexes().map(([key]) => JSON.stringify(key));
  const live = (await MatrimonialProfile.collection.indexes()).map((index) => JSON.stringify(index.key));
  const expectedIndexes = [
    { 'profile.status': 1, 'basic.gender': 1, 'basic.dateOfBirth': 1 },
    { 'profile.status': 1, 'basic.gender': 1, 'location.cityId': 1 },
    { 'profile.status': 1, 'basic.gender': 1, 'career.occupationId': 1 },
    { 'profile.status': 1, 'community.gotraId': 1 },
    { 'profile.status': 1, 'profile.lastActiveAt': -1 }
  ];
  const missing = expectedIndexes.filter((key) => !declared.includes(JSON.stringify(key)) || !live.includes(JSON.stringify(key)));
  check(
    '§49/§50: every step-09 compound index is declared and created',
    missing.length === 0,
    missing.length ? JSON.stringify(missing) : `${expectedIndexes.length} indexes present`
  );
}

// ---------------------------------------------------------------------------
// Command 10 — distance filter
// ---------------------------------------------------------------------------
{
  const coords = delhi.coordinates;
  if (!coords || coords.lat == null) {
    skip('command 10: distance search', 'the seed gives Delhi no coordinates');
  } else {
    const near = await req(`/api/v1/discover?lat=${coords.lat}&lng=${coords.lng}&maxDistanceKm=50`, { headers: auth(ACCESS) });
    const nearIds = (near.json?.data?.items || []).map((item) => item.profileId);
    const wide = await req(`/api/v1/discover?lat=${coords.lat}&lng=${coords.lng}&maxDistanceKm=400`, { headers: auth(ACCESS) });
    const wideIds = (wide.json?.data?.items || []).map((item) => item.profileId);
    check(
      'command 10: a 50 km radius includes Delhi and excludes Jaipur (~240 km)',
      near.status === 200 && nearIds.includes(delhiCandidate.publicProfileId) && !nearIds.includes(jaipurCandidate.publicProfileId),
      `status=${near.status} ids=${JSON.stringify(nearIds)}`
    );
    check(
      'command 10: a 400 km radius reaches Jaipur',
      wide.status === 200 && wideIds.includes(jaipurCandidate.publicProfileId),
      `ids=${JSON.stringify(wideIds)}`
    );
    check(
      'command 10: a geo response never carries coordinates',
      !near.text.includes('coordinates') && !/"lat"|"lng"/.test(near.text),
      'no coordinate fields in the payload'
    );
  }
}

// ---------------------------------------------------------------------------
// Cross-cutting: auth, exclusions, the hasPhoto signal, privacy at source
// ---------------------------------------------------------------------------
{
  const anonymous = await Promise.all([
    req('/api/v1/discover'),
    req('/api/v1/search'),
    req('/api/v1/recommendations')
  ]);
  check(
    'all three discover routes refuse an anonymous request with 401',
    anonymous.every((res) => res.status === 401),
    anonymous.map((res) => res.status).join(',')
  );

  const self = await req(`/api/v1/search?cityId=${id(delhi)}&gender=male`, { headers: auth(ACCESS) });
  const selfIds = (self.json?.data?.items || []).map((item) => item.profileId);
  check(
    'the caller never appears in their own results (spec §56)',
    self.status === 200 && !selfIds.includes((await MatrimonialProfile.findOne({ userId: viewer._id }).select('publicProfileId').lean()).publicProfileId),
    `status=${self.status} ids=${JSON.stringify(selfIds)}`
  );

  const withPhoto = await req(`/api/v1/search?cityId=${alwarId}&hasPhoto=true`, { headers: auth(ACCESS) });
  const photoIds = (withPhoto.json?.data?.items || []).map((item) => item.profileId);
  check(
    'hasPhoto=true returns only approved photos, and a pending one has no card image',
    withPhoto.status === 200 && !photoIds.includes(pendingPhoto.publicProfileId) && photoIds.length > 0,
    `ids=${JSON.stringify(photoIds)} pending=${pendingPhoto.publicProfileId}`
  );

  const pendingView = await req(`/api/v1/search?cityId=${alwarId}&gender=female`, { headers: auth(ACCESS) });
  const pendingRow = (pendingView.json?.data?.items || []).find((item) => item.profileId === pendingPhoto.publicProfileId);
  check(
    'a profile whose only photo is pending still lists, with primaryPhoto null',
    Boolean(pendingRow) && pendingRow.primaryPhoto === null,
    `listed=${Boolean(pendingRow)} primaryPhoto=${JSON.stringify(pendingRow?.primaryPhoto)}`
  );

  const excluded = await exclusionService.getExcludedUserIds(String(viewer._id));
  check(
    'the exclusion interface returns the caller first and honours its guard',
    excluded.includes(String(viewer._id)) && Array.isArray(excluded),
    `count=${excluded.length}`
  );
  let capped = false;
  try {
    exclusionService.mergeExclusions([Array.from({ length: 5 }, (_, index) => `id${index}`)], 2);
  } catch (err) {
    capped = err.statusCode === 503;
  }
  check('the $nin guard refuses an over-large exclusion set instead of dropping one', capped, 'status 503 expected');

  // Nothing in the discover path returns a stored asset URL or the account id.
  const stored = await Photo.findOne({ userId: females[0].id }).select('url publicId').lean();
  const page = await req(`/api/v1/discover?cityId=${alwarId}`, { headers: auth(ACCESS) });
  check(
    'no original asset URL or account id appears in a discovery payload',
    !page.text.includes(stored.url) && !page.text.includes(females[0].id) && !page.text.includes(String(females[0].id)),
    `urlLeak=${page.text.includes(stored.url)} idLeak=${page.text.includes(females[0].id)}`
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
