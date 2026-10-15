'use strict';

/**
 * Step 05 — Master Data tests (spec §12-15, §73-76, §82, §97, §102, §105, §127;
 * community format reference).
 *
 * Runs against the configured cluster in a DEDICATED database that is seeded
 * from `src/data/master/*.json` in the before hook, so the tests exercise the
 * same seeder the operator runs.
 *
 * Each test file is its own process, so the env overrides below cannot leak.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.MONGODB_DB_NAME = 'chandravanshi_vivah_test_master';
// Never let a functional case trip the brute-force or global limiter; the
// master-data limiter itself is proven in the last test of this file.
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.RATE_LIMIT_MAX = '99999';
process.env.RATE_LIMIT_WINDOW = '3600';
// Deterministic bounds so clamp assertions are stable.
process.env.MASTER_SEARCH_MIN_LEN = '2';
process.env.MASTER_SEARCH_MAX_LIMIT = '50';
process.env.MASTER_DEFAULT_LIMIT = '20';
process.env.MASTER_MISSING_MAX_LEN = '60';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const config = require('../src/config/env');
const app = require('../src/app');
const db = require('../src/config/db');
const {
  MASTER_COLLECTIONS,
  MASTER_TYPE_VALUES,
  allowedFilterParams
} = require('../src/constants/masterData');
const { USER_INPUTTABLE_TYPES, REQUEST_TYPES } = require('../src/constants/masterCategories');
const { getMasterModel } = require('../src/models/masterData/MasterItem');
const MasterDataRequest = require('../src/models/MasterDataRequest');
const CommunityConfig = require('../src/models/CommunityConfig');
const masterDataService = require('../src/services/masterDataService');
const masterOptionService = require('../src/services/masterOptionService');
const seeder = require('../scripts/seed-master-data');

const SERVER_ROOT = path.join(__dirname, '..');
const PASSWORD = 'correct-horse-battery';

let server;
let base;
let available = false;
let unavailableReason = '';
/** A seeded official gotra id, for the missing-value tests. */
let kaharCommunityId;
/** Two independent signed-in accounts. */
let accountA;
let accountB;

/** Skip a test when the cluster is unreachable, instead of failing misleadingly. */
function requireDb(t) {
  if (!available) {
    t.skip(`database unavailable (${unavailableReason})`);
    return false;
  }
  return true;
}

async function api(route, { method = 'GET', body, token, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, headers: res.headers };
}

async function registerAndLogin(identifier) {
  const created = await api('/api/v1/auth/register', {
    method: 'POST',
    body: { identifierType: 'email', identifier, password: PASSWORD }
  });
  assert.equal(created.status, 201, `register ${identifier}: ${JSON.stringify(created.json)}`);
  const loggedIn = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { identifierType: 'email', identifier, password: PASSWORD, deviceType: 'android' }
  });
  assert.equal(loggedIn.status, 200, `login ${identifier}: ${JSON.stringify(loggedIn.json)}`);
  return { id: created.json.data.user.id, token: loggedIn.json.data.accessToken };
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

  const User = require('../src/models/User');
  const Session = require('../src/models/Session');

  // Drop rather than empty: dropping also clears the server-side query-plan
  // cache, so a plan cached while a collection held a handful of documents
  // cannot mask an index that only matters at scale. Indexes are rebuilt
  // explicitly because autoIndex is off outside development (spec §49).
  const allModels = [
    ...MASTER_TYPE_VALUES.map((type) => getMasterModel(type)),
    MasterDataRequest,
    CommunityConfig,
    User,
    Session
  ];
  for (const model of allModels) {
    await model.collection.drop().catch(() => {});
    await model.createIndexes();
  }

  await seeder.main();

  // A probe corpus so index usage is measurable: a 40-document collection is
  // legitimately served better by a collection scan than by an index.
  await getMasterModel('occupations').insertMany(
    Array.from({ length: 3000 }, (_, index) => ({
      name: `Zz Search Probe ${index}`,
      nameLower: `zz search probe ${index}`,
      slug: `zz-search-probe-${index}`,
      sortOrder: 0,
      isActive: true
    })),
    { ordered: false }
  );

  const kahar = await getMasterModel('communities').findOne({ slug: 'kahar-chandravanshi-kshatriya' });
  kaharCommunityId = kahar ? kahar._id : null;

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  accountA = await registerAndLogin('master-a@example.com');
  accountB = await registerAndLogin('master-b@example.com');
});

test.after(async () => {
  if (available) await getMasterModel('occupations').deleteMany({ slug: /^zz-search-probe-/ });
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.disconnect();
});

// ---------------------------------------------------------------------------
// Gate 1 — build integrity
// ---------------------------------------------------------------------------

test('G1.1 every step-05 deliverable exists', () => {
  const files = [
    'src/models/masterData/MasterItem.js',
    'src/models/CommunityConfig.js',
    'src/models/MasterDataRequest.js',
    'src/services/masterDataRequestService.js',
    'src/services/masterOptionService.js',
    'src/services/masterDataService.js',
    'src/controllers/masterData.controller.js',
    'src/routes/masterData.routes.js',
    'src/validators/masterData.validators.js',
    'scripts/seed-master-data.js',
    'src/data/master/community.json',
    'src/constants/masterData.js',
    'src/constants/masterCategories.js'
  ];
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(SERVER_ROOT, file)), `${file} is missing`);
  }
});

test('G1.1 all 18 canonical master collections are registered', () => {
  const registered = Object.values(MASTER_COLLECTIONS).map((entry) => entry.collection).sort();
  const expected = [
    'communities', 'sub_communities', 'clans', 'gotras', 'surnames', 'aaspads',
    'occupations', 'industries', 'degrees', 'specializations', 'colleges', 'universities',
    'countries', 'states', 'districts', 'cities', 'languages', 'hobbies', 'interests'
  ].sort();
  // `communities`, `clans` and `aaspads` extend the §127 list (community format).
  assert.deepEqual(registered, expected);
  assert.equal(MASTER_TYPE_VALUES.length, Object.keys(MASTER_COLLECTIONS).length);
});

// ---------------------------------------------------------------------------
// Gate 2 — functional
// ---------------------------------------------------------------------------

test('G2.1 every registered collection is reachable and returns items', async (t) => {
  if (!requireDb(t)) return;
  for (const type of MASTER_TYPE_VALUES) {
    const res = await api(`/api/v1/master-data/${type}?limit=50`);
    assert.equal(res.status, 200, `${type} returned ${res.status}`);
    assert.ok(Array.isArray(res.json.data.items), `${type} has no items array`);
    assert.ok(res.json.data.items.length > 0, `${type} returned no items`);
  }
});

test('G2.2 search matches expected terms and only active items by default', async (t) => {
  if (!requireDb(t)) return;
  const res = await api('/api/v1/master-data/occupations?query=software&limit=20');
  assert.equal(res.status, 200);
  const names = res.json.data.items.map((item) => item.name);
  assert.ok(names.length >= 2, `expected several software occupations, got ${names.length}`);
  assert.ok(names.every((name) => name.toLowerCase().startsWith('soft')), `unexpected match: ${names.join(', ')}`);
  assert.ok(res.json.data.items.every((item) => item.isActive === true));
});

test('G2.3 + G2.4 cascading filters return only children of the parent, chain intact', async (t) => {
  if (!requireDb(t)) return;
  const District = getMasterModel('districts');
  const State = getMasterModel('states');
  const Country = getMasterModel('countries');

  const country = await Country.findOne({ slug: 'india' });
  const state = await State.findOne({ slug: 'rajasthan' });
  const district = await District.findOne({ slug: 'sikar' });
  assert.ok(country && state && district, 'the location seed is incomplete');

  // The chain city -> district -> state -> country is wired correctly.
  assert.equal(String(state.countryId), String(country._id));
  assert.equal(String(district.stateId), String(state._id));

  const districts = await api(`/api/v1/master-data/districts?parentId=${state._id}&limit=50`);
  assert.equal(districts.status, 200);
  assert.ok(districts.json.data.items.length > 5, 'Rajasthan should have many districts');
  assert.ok(districts.json.data.items.every((item) => String(item.stateId) === String(state._id)));

  const cities = await api(`/api/v1/master-data/cities?parentId=${district._id}`);
  assert.equal(cities.status, 200);
  assert.ok(cities.json.data.items.length > 0);
  assert.ok(cities.json.data.items.every((item) => String(item.districtId) === String(district._id)));

  // The concrete parent field name works too, not only the generic `parentId`.
  const byState = await api(`/api/v1/master-data/states?countryId=${country._id}`);
  assert.equal(byState.status, 200);
  assert.ok(byState.json.data.items.every((item) => String(item.countryId) === String(country._id)));
});

test('G2.5 activeOnly=false returns deactivated items, the default excludes them', async (t) => {
  if (!requireDb(t)) return;
  const model = getMasterModel('occupations');
  const created = await model.create({
    name: 'Deactivated Test Occupation',
    nameLower: 'deactivated test occupation',
    slug: 'deactivated-test-occupation',
    isActive: false
  });
  try {
    const excluded = await api('/api/v1/master-data/occupations?query=deactivated');
    assert.ok(!excluded.json.data.items.some((item) => item._id === String(created._id)));

    const included = await api('/api/v1/master-data/occupations?query=deactivated&activeOnly=false');
    assert.ok(included.json.data.items.some((item) => item._id === String(created._id)));
    assert.equal(included.headers.get('cache-control'), 'no-store');
  } finally {
    await model.deleteOne({ _id: created._id });
  }
});

test('G2.6 validateIds rejects a missing id, a wrong-collection id and an inactive id distinctly', async (t) => {
  if (!requireDb(t)) return;
  const gotra = await getMasterModel('gotras').findOne({ communityId: kaharCommunityId });
  const surname = await getMasterModel('surnames').findOne({});
  const inactive = await getMasterModel('gotras').create({
    name: 'Inactive Gotra For Test',
    nameLower: 'inactive gotra for test',
    slug: 'inactive-gotra-for-test',
    communityId: kaharCommunityId,
    isActive: false
  });

  try {
    const report = await masterDataService.validateIds('gotras', [
      String(surname._id),
      String(new mongoose.Types.ObjectId()),
      String(inactive._id),
      String(gotra._id)
    ]);

    const byReason = Object.fromEntries(report.invalid.map((entry) => [entry.reason, entry.message]));
    assert.equal(report.invalid.length, 3);
    assert.ok(byReason.WRONG_TYPE, 'a wrong-collection id is reported as WRONG_TYPE');
    assert.ok(byReason.NOT_FOUND, 'an unknown id is reported as NOT_FOUND');
    assert.ok(byReason.INACTIVE, 'an inactive id is reported as INACTIVE');
    assert.equal(new Set(Object.values(byReason)).size, 3, 'the three messages must differ');
    assert.deepEqual(report.valid, [String(gotra._id)]);

    await assert.rejects(
      () => masterDataService.assertIds('gotras', [String(inactive._id)]),
      /Invalid request/
    );
  } finally {
    await getMasterModel('gotras').deleteOne({ _id: inactive._id });
  }
});

test('G2.7 re-running the seeder creates no duplicates and preserves _id', async (t) => {
  if (!requireDb(t)) return;
  const model = getMasterModel('occupations');
  const before = await model.findOne({ slug: 'software-engineer' });
  const totalBefore = await model.countDocuments({});

  await seeder.main();

  const after = await model.findOne({ slug: 'software-engineer' });
  assert.equal(String(after._id), String(before._id), 'the seeder must not replace a row');
  assert.equal(await model.countDocuments({}), totalBefore, 'the seeder must not add duplicates');
});

test('G2.8 the Chandravanshi community_configs record exists and exposes its settings', async (t) => {
  if (!requireDb(t)) return;
  const record = await CommunityConfig.findOne({ slug: 'chandravanshi' });
  assert.ok(record, 'the community config was not seeded');
  assert.equal(record.settings.requireProfilePhoto, true);
  assert.equal(typeof record.rules.sameGotraAllowed, 'boolean');
});

test('G2.9 a missing value becomes immediately selectable for the next user', async (t) => {
  if (!requireDb(t)) return;
  const created = await api('/api/v1/master-data/gotras/missing', {
    method: 'POST',
    token: accountA.token,
    body: { name: 'Kashyappa', communityId: String(kaharCommunityId) }
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const option = created.json.data.option;
  assert.equal(option.isUserContributed, true);
  assert.equal(option.verifiedAt, null);
  assert.ok(option._id);

  // The SECOND user sees it with no admin action.
  const seenByOther = await api(`/api/v1/master-data/gotras?query=Kashyappa&parentId=${kaharCommunityId}`, {
    token: accountB.token
  });
  assert.equal(seenByOther.status, 200);
  assert.ok(
    seenByOther.json.data.items.some((item) => item._id === option._id),
    'the contributed option must be visible to another user'
  );
});

test('G2.10 the same missing value twice returns the same option and opens two review rows', async (t) => {
  if (!requireDb(t)) return;
  const first = await api('/api/v1/master-data/gotras/missing', {
    method: 'POST',
    token: accountA.token,
    body: { name: 'Dupabble', communityId: String(kaharCommunityId) }
  });
  const second = await api('/api/v1/master-data/gotras/missing', {
    method: 'POST',
    token: accountB.token,
    body: { name: 'Dupabble', communityId: String(kaharCommunityId) }
  });

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(first.json.data.option._id, second.json.data.option._id, 'one row, one id');

  const rows = await getMasterModel('gotras').countDocuments({
    communityId: kaharCommunityId,
    slug: 'dupabble'
  });
  assert.equal(rows, 1, 'exactly one option row');

  const requests = await MasterDataRequest.countDocuments({
    requestedName: 'Dupabble',
    status: 'pending'
  });
  assert.equal(requests, 2, 'each submission opens its own review row');
});

test('G2.11 the seeded community contexts match the appendix and stay separate', async (t) => {
  if (!requireDb(t)) return;
  const kahar = String(kaharCommunityId);
  const clans = await getMasterModel('clans').find({ communityId: kahar }).lean();
  const clanNames = clans.map((clan) => clan.name);
  assert.ok(clanNames.includes('Pindwal'), 'Kahar clans are seeded into `clans`');
  assert.ok(clanNames.includes('Kashyap'), 'a clan named Kashyap exists separately from the gotra');

  const aaspads = await getMasterModel('aaspads').countDocuments({});
  assert.equal(aaspads, 105, 'the 105 Chandravanshi Khati aaspads are seeded');

  // Documented clan -> gotra links only (never inferred).
  const chandel = await getMasterModel('clans')
    .findOne({ communityId: await communityIdOf('rajput-chandravanshi-branch'), slug: 'chandel' })
    .populate('gotraIds', 'name');
  assert.ok(chandel, 'the Chandel clan exists');
  const linkedGotras = chandel.gotraIds.map((gotra) => gotra.name);
  assert.ok(linkedGotras.includes('Chandatreya (Chandrayan)'));
  assert.ok(linkedGotras.includes('Sheshdhar'));
  assert.ok(linkedGotras.includes('Parashar'));

  // Clans and gotras are different collections, never merged.
  const kaharGotras = await getMasterModel('gotras').countDocuments({ communityId: kahar });
  assert.ok(kaharGotras >= 3, 'Kahar gotras are in `gotras`');
});

async function communityIdOf(slug) {
  const community = await getMasterModel('communities').findOne({ slug });
  return community ? community._id : null;
}

test('G2.12 the same name in two contexts is two rows, and a wrong scope is rejected', async (t) => {
  if (!requireDb(t)) return;
  const yadav = await communityIdOf('yadav-yaduvanshi');
  const kahar = kaharCommunityId;

  const res = await api('/api/v1/master-data/gotras?query=Kashyap&limit=50');
  assert.equal(res.status, 200);
  const kashyaps = res.json.data.items.filter((item) => item.name === 'Kashyap');
  assert.ok(kashyaps.length >= 3, `expected several scoped Kashyap rows, got ${kashyaps.length}`);
  assert.equal(new Set(kashyaps.map((item) => item.communityId)).size, kashyaps.length, 'each row is its own scope');

  const kaharKashyap = kashyaps.find((item) => item.communityId === String(kahar));
  assert.ok(kaharKashyap);
  const report = await masterDataService.validateIds('gotras', [kaharKashyap._id], { scope: { communityId: yadav } });
  assert.equal(report.ok, false);
  assert.equal(report.invalid[0].reason, 'OUT_OF_SCOPE');
});

// ---------------------------------------------------------------------------
// Gate 3 — security
// ---------------------------------------------------------------------------

test('G3.1 an unknown :type cannot reach any other collection', async (t) => {
  if (!requireDb(t)) return;
  for (const type of ['users', 'sessions', 'master_data_requests', 'payment_transactions']) {
    const res = await api(`/api/v1/master-data/${type}`);
    assert.equal(res.status, 404, `${type} must not be reachable`);
    assert.ok(!JSON.stringify(res.json).includes('passwordHash'));
  }
});

test('G3.2 query-shaped values are rejected, never passed as an object', async (t) => {
  if (!requireDb(t)) return;
  const shaped = await api('/api/v1/master-data/occupations?query[$ne]=x');
  assert.equal(shaped.status, 400, `query[$ne] must be rejected: ${JSON.stringify(shaped.json)}`);

  const bogus = await api('/api/v1/master-data/occupations?limit=abc');
  assert.equal(bogus.status, 400);

  const unknown = await api('/api/v1/master-data/occupations?role=admin');
  assert.equal(unknown.status, 400, 'unknown query parameters are rejected');
});

test('G3.3 an oversized limit is clamped to the configured maximum', async (t) => {
  if (!requireDb(t)) return;
  const res = await api('/api/v1/master-data/cities?limit=100000');
  assert.equal(res.status, 200);
  assert.ok(res.json.data.items.length <= config.masterData.maxLimit);
  assert.equal(res.json.data.limit, config.masterData.maxLimit);
});

test('G3.4 no master-data error reveals a collection name or driver detail', async (t) => {
  if (!requireDb(t)) return;
  const res = await api('/api/v1/master-data/nope');
  assert.equal(res.status, 404);
  const body = JSON.stringify(res.json);
  for (const leak of ['mongodb', 'MongoError', 'CastError', 'stack', 'collection']) {
    assert.ok(!body.includes(leak), `response leaked "${leak}": ${body}`);
  }
});

test('G3.5 a request body cannot create an official record or set server fields', async (t) => {
  if (!requireDb(t)) return;

  const forgedOfficial = await api('/api/v1/master-data/gotras/missing', {
    method: 'POST',
    token: accountA.token,
    body: { name: 'Forged', communityId: String(kaharCommunityId), verifiedAt: '2026-01-01', source: 'admin' }
  });
  assert.equal(forgedOfficial.status, 400, `forged fields must be rejected: ${JSON.stringify(forgedOfficial.json)}`);

  const forgedAuthor = await api('/api/v1/master-data/gotras/missing', {
    method: 'POST',
    token: accountA.token,
    body: { name: 'ForgedTwo', communityId: String(kaharCommunityId), submittedBy: accountB.id }
  });
  assert.equal(forgedAuthor.status, 400, 'submittedBy can never come from the body');

  const forgedCommunityName = await api('/api/v1/master-data/sub_communities/missing', {
    method: 'POST',
    token: accountA.token,
    body: { name: 'Somewhere', communityName: 'Invented' }
  });
  assert.equal(forgedCommunityName.status, 400, 'communityName is platform-controlled');

  // Nothing was written by any of the rejected attempts.
  assert.equal(await getMasterModel('gotras').countDocuments({ slug: 'forged' }), 0);
  assert.equal(await getMasterModel('gotras').countDocuments({ slug: 'forgedtwo' }), 0);
});

test('G3.6 submittedBy is always the authenticated caller', async (t) => {
  if (!requireDb(t)) return;
  const one = await api('/api/v1/master-data/surnames/missing', {
    method: 'POST',
    token: accountA.token,
    body: { name: 'ContributorOne', communityId: String(kaharCommunityId) }
  });
  const two = await api('/api/v1/master-data/surnames/missing', {
    method: 'POST',
    token: accountB.token,
    body: { name: 'ContributorTwo', communityId: String(kaharCommunityId) }
  });
  assert.equal(one.status, 201);
  assert.equal(two.status, 201);

  const rowOne = await getMasterModel('surnames').findById(one.json.data.option._id).lean();
  const rowTwo = await getMasterModel('surnames').findById(two.json.data.option._id).lean();
  assert.equal(String(rowOne.submittedBy), accountA.id);
  assert.equal(String(rowTwo.submittedBy), accountB.id);
  assert.equal(rowOne.source, 'user');
  assert.equal(rowTwo.source, 'user');
});

// ---------------------------------------------------------------------------
// Gate 4 — performance & data
// ---------------------------------------------------------------------------

test('G4.1 the search query is served by an IXSCAN on the name index', async (t) => {
  if (!requireDb(t)) return;
  const model = getMasterModel('occupations');
  const filter = masterDataService.buildFilter('occupations', { query: 'zz search probe 2999', activeOnly: true });

  // Warm the query plan cache, then inspect the plan MongoDB actually used. The
  // probe corpus inserted in the before hook keeps this honest: with only a
  // handful of documents the planner rightly prefers a collection scan.
  await model.find(filter).limit(1);
  const plan = await model.find(filter).explain('executionStats');
  const planText = JSON.stringify(plan);
  assert.ok(planText.includes('nameLower_1'), `the nameLower index must be used: ${planText.slice(0, 300)}`);
  assert.ok(planText.includes('IXSCAN'), 'the search must be index-backed, not a COLLSCAN');
  assert.ok(!planText.includes('COLLSCAN'), 'no collection scan may be planned');
});

test('G4.2 a sub-minimum search is refused before any query runs', async (t) => {
  if (!requireDb(t)) return;
  const res = await api('/api/v1/master-data/occupations?query=a');
  assert.equal(res.status, 400);
  assert.match(res.json.details.query, /at least 2 characters/);
});

test('G4.3 listing payloads are small and leak no internal fields', async (t) => {
  if (!requireDb(t)) return;
  const res = await api('/api/v1/master-data/gotras?limit=50');
  assert.equal(res.status, 200);
  for (const item of res.json.data.items) {
    for (const internal of ['source', 'submittedBy', 'verifiedBy', 'nameLower', '__v']) {
      assert.ok(!(internal in item), `option leaked ${internal}`);
    }
    assert.ok(item.isUserContributed === true || item.isUserContributed === false);
  }
});

// ---------------------------------------------------------------------------
// Gate 5 — spec conformance
// ---------------------------------------------------------------------------

test('G5.2/G5.4 the official tier is server-stamped and aliases never fork the list', async (t) => {
  if (!requireDb(t)) return;
  const seeded = await getMasterModel('gotras').findOne({ communityId: kaharCommunityId, slug: 'kashyap' }).lean();
  assert.equal(seeded.source, 'seed');
  assert.ok(seeded.verifiedAt instanceof Date, 'a seeded value is official');

  // Merging an alias never creates a second option.
  const before = await getMasterModel('gotras').countDocuments({ communityId: kaharCommunityId });
  await masterOptionService.mergeAliases('gotras', seeded._id, ['Kasyap']);
  const after = await getMasterModel('gotras').countDocuments({ communityId: kaharCommunityId });
  assert.equal(after, before, 'an alias must not add a row');
  const reloaded = await getMasterModel('gotras').findById(seeded._id).lean();
  assert.ok(reloaded.aliases.includes('kasyap'));
});

test('G5.7 no server-side cache is introduced', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8'));
  const dependencies = Object.keys(pkg.dependencies || {});
  assert.ok(!dependencies.includes('redis'), 'Redis caching is explicitly out of scope (spec §60)');
  assert.ok(!dependencies.includes('ioredis'));
});

test('G3.7 the .missing path is limited to user-inputtable categories and capped in length', async (t) => {
  if (!requireDb(t)) return;

  // Community is platform-controlled: it can never be user-submitted.
  const community = await api('/api/v1/master-data/communities/missing', {
    method: 'POST',
    token: accountA.token,
    body: { name: 'New Community' }
  });
  assert.equal(community.status, 400);

  // An over-long value is rejected before insert.
  const long = await api('/api/v1/master-data/gotras/missing', {
    method: 'POST',
    token: accountA.token,
    body: { name: 'x'.repeat(config.masterData.missingMaxLen + 1), communityId: String(kaharCommunityId) }
  });
  assert.equal(long.status, 400);

  // A non-user-inputtable collection has no .missing path at all.
  const occupation = await api('/api/v1/master-data/occupations/missing', {
    method: 'POST',
    token: accountA.token,
    body: { name: 'Astronaut' }
  });
  assert.equal(occupation.status, 400);

  assert.deepEqual(USER_INPUTTABLE_TYPES, ['sub_communities', 'surnames', 'gotras', 'clans', 'aaspads']);
  assert.ok(REQUEST_TYPES.includes('clan') && REQUEST_TYPES.includes('aaspad'));
});

test('G3.7 the .missing path is rate limited', async (t) => {
  if (!requireDb(t)) return;
  let sawTooMany = false;
  for (let index = 0; index < 40 && !sawTooMany; index += 1) {
    const res = await api('/api/v1/master-data/clans/missing', {
      method: 'POST',
      token: accountA.token,
      body: { name: `RateLimitProbe${index}`, communityId: String(kaharCommunityId) }
    });
    if (res.status === 429) sawTooMany = true;
    else assert.equal(res.status, 201);
  }
  assert.ok(sawTooMany, 'the .missing path must return 429 within the window');
});

test('G2.13 validateIds enforces the allowlisted type too', async (t) => {
  if (!requireDb(t)) return;
  await assert.rejects(() => masterDataService.validateIds('users', ['x']), /does not exist/);
  assert.deepEqual(allowedFilterParams('cities'), ['districtId', 'parentId']);
  assert.ok(allowedFilterParams('gotras').includes('clanId'));
  assert.ok(allowedFilterParams('gotras').includes('communityId'));
});
