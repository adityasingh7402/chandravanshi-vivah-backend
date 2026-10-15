// Step 05 scripted verification — runs the doc's 13 verification commands against a live server,
// plus the security/data checks the audit gates require.
//
// Boot the API first, then run:
//   MONGODB_DB_NAME=chandravanshi_vivah_test node verify-step05.mjs
//
// The harness connects to the same database the server uses, so it can inspect
// the row a user-contributed value actually created (command 12).
import mongoose from 'mongoose';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const config = require('./src/config/env');
const CommunityConfig = require('./src/models/CommunityConfig');
const { getMasterModel } = require('./src/models/masterData/MasterItem');
const masterDataService = require('./src/services/masterDataService');

const execFileAsync = promisify(execFile);

const BASE = `http://localhost:${config.port}`;
const PASSWORD = 'correct-horse-battery';
const RUN = Date.now();

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });
const fail = (name, detail) => results.push({ name, pass: false, detail });

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
  return { status: res.status, json, text, headers: res.headers };
}

const post = (path, body, headers) => req(path, { method: 'POST', body, headers });
const bearer = (token) => ({ authorization: `Bearer ${token}` });

async function account(tag) {
  const email = `s5${tag}${RUN}@example.com`;
  const created = await post('/api/v1/auth/register', { identifierType: 'email', identifier: email, password: PASSWORD });
  if (created.status !== 201) throw new Error(`register ${email} -> ${created.status}`);
  const loggedIn = await post('/api/v1/auth/login', {
    identifierType: 'email',
    identifier: email,
    password: PASSWORD,
    deviceType: 'android'
  });
  if (loggedIn.status !== 200) throw new Error(`login ${email} -> ${loggedIn.status}`);
  return { id: created.json.data.user.id, token: loggedIn.json.data.accessToken };
}

await mongoose.connect(config.mongodbUri, { dbName: config.mongodbDbName, serverSelectionTimeoutMS: 5000 });

const userA = await account('a');
const userB = await account('b');

// --- command 1: list occupations (default page) ---------------------------
{
  const res = await req('/api/v1/master-data/occupations');
  const data = res.json && res.json.data;
  check(
    '1. list occupations (default page)',
    res.status === 200 && Array.isArray(data?.items) && data.items.length > 0 && data.items.length <= config.masterData.maxLimit,
    `status=${res.status} items=${data?.items?.length} limit=${data?.limit}`
  );
  check(
    '1b. default listing excludes inactive items',
    Boolean(data) && data.items.every((item) => item.isActive === true),
    `inactive in page: ${data ? data.items.filter((item) => !item.isActive).length : 'n/a'}`
  );
  check(
    '1c. getOne resolves a single item',
    await (async () => {
      const one = await req(`/api/v1/master-data/occupations/${data.items[0]._id}`);
      return one.status === 200 && one.json.data.item.name === data.items[0].name;
    })(),
    'single-item lookup'
  );
}

// --- command 2: search ----------------------------------------------------
{
  const res = await req('/api/v1/master-data/occupations?query=software&limit=20');
  const items = res.json?.data?.items || [];
  check(
    '2. search returns only matching occupations',
    res.status === 200 && items.length > 0 && items.every((item) => item.name.toLowerCase().startsWith('soft')),
    `status=${res.status} items=${items.map((i) => i.name).join(', ')}`
  );
}

// --- command 3: cascading location ---------------------------------------
{
  const country = await getMasterModel('countries').findOne({ slug: 'india' }).lean();
  const district = await getMasterModel('districts').findOne({ slug: 'sikar' }).lean();
  const states = country ? await req(`/api/v1/master-data/states?parentId=${country._id}`) : { status: 0, json: null };
  const stateItems = states.json?.data?.items || [];
  check(
    '3. states are filtered by their country',
    states.status === 200 && stateItems.length > 0 && stateItems.every((item) => item.countryId === String(country._id)),
    `status=${states.status} states=${stateItems.length}`
  );

  const cities = district ? await req(`/api/v1/master-data/cities?parentId=${district._id}&query=Sik`) : { status: 0, json: null };
  const cityItems = cities.json?.data?.items || [];
  check(
    '3b. cities are filtered by their district and the query',
    cities.status === 200 && cityItems.length > 0 && cityItems.every((item) => item.districtId === String(district._id)),
    `status=${cities.status} cities=${cityItems.map((i) => i.name).join(', ')}`
  );
}

// --- command 4: unknown collection ---------------------------------------
{
  const res = await req('/api/v1/master-data/users');
  const body = JSON.stringify(res.json || {});
  check(
    '4. unknown collection is 404 with no data leak',
    res.status === 404 && !body.includes('passwordHash') && !body.includes('mongodb'),
    `status=${res.status} body=${body.slice(0, 80)}`
  );
}

// --- command 5: limit cap -------------------------------------------------
{
  const res = await req('/api/v1/master-data/cities?limit=100000');
  const items = res.json?.data?.items || [];
  check(
    '5. an oversized limit is bounded by the configured maximum',
    res.status === 200 && items.length <= config.masterData.maxLimit,
    `status=${res.status} items=${items.length} max=${config.masterData.maxLimit}`
  );
}

// --- command 6: seeder idempotency ---------------------------------------
{
  try {
    const first = await execFileAsync(process.execPath, ['scripts/seed-master-data.js'], { cwd: process.cwd() });
    const second = await execFileAsync(process.execPath, ['scripts/seed-master-data.js'], { cwd: process.cwd() });
    const firstDone = /Done\. (\d+) created/.exec(first.stdout);
    const secondDone = /Done\. (\d+) created/.exec(second.stdout);
    check(
      '6. seeder is idempotent (second run creates nothing)',
      Boolean(secondDone) && secondDone[1] === '0',
      `run1=${firstDone ? firstDone[1] : '?'} created, run2=${secondDone ? secondDone[1] : '?'} created`
    );
  } catch (err) {
    fail('6. seeder is idempotent (second run creates nothing)', `seeder failed: ${err && err.message}`);
  }
}

// --- command 7: unbounded query rejection --------------------------------
{
  const res = await req('/api/v1/master-data/occupations?query=a');
  check(
    '7. a sub-minimum search is rejected instead of scanning',
    res.status === 400,
    `status=${res.status} details=${JSON.stringify(res.json?.details)}`
  );
}

// --- commands 8-12: the user-contributed path ----------------------------
let contributedOptionId = null;
{
  const kahar = await getMasterModel('communities').findOne({ slug: 'kahar-chandravanshi-kshatriya' }).lean();
  const communityId = String(kahar._id);
  const name = 'Kashyappa';

  const created = await post('/api/v1/master-data/gotras/missing', { name, communityId }, bearer(userA.token));
  const option = created.json?.data?.option;
  contributedOptionId = option?._id ?? null;
  check(
    '8. a missing value is recorded and is immediately selectable',
    created.status === 201 &&
      option?.isUserContributed === true &&
      option?.verifiedAt === null &&
      typeof option?._id === 'string',
    `status=${created.status} option=${JSON.stringify(option)}`
  );

  const seenByOther = await req(
    `/api/v1/master-data/gotras?query=${name}&parentId=${communityId}`,
    { headers: bearer(userB.token) }
  );
  const visible = (seenByOther.json?.data?.items || []).some((item) => item._id === contributedOptionId);
  check(
    '9. the next user sees the contributed option without admin action',
    seenByOther.status === 200 && visible,
    `status=${seenByOther.status} visible=${visible}`
  );

  const again = await post('/api/v1/master-data/gotras/missing', { name, communityId }, bearer(userB.token));
  const sameId = again.json?.data?.option?._id === contributedOptionId;
  const rowCount = await getMasterModel('gotras').countDocuments({ communityId: kahar._id, slug: 'kashyappa' });
  const requestCount = await getMasterModel('gotras').db
    .collection('master_data_requests')
    .countDocuments({ requestedName: name, status: 'pending' });
  check(
    '10. the same value twice returns the same option, one row, two review rows',
    again.status === 201 && sameId && rowCount === 1 && requestCount === 2,
    `sameId=${sameId} rows=${rowCount} requests=${requestCount}`
  );

  const forged = await post(
    '/api/v1/master-data/gotras/missing',
    { name: 'Forged', communityId, verifiedAt: '2026-01-01', source: 'admin' },
    bearer(userA.token)
  );
  check(
    '11. a user cannot mark their own value official',
    forged.status === 400,
    `status=${forged.status} message=${forged.json?.message}`
  );

  const row = await getMasterModel('gotras').findById(contributedOptionId).lean();
  check(
    '12. the submitter is recorded on the row',
    String(row.submittedBy) === userA.id && row.source === 'user',
    `submittedBy=${row.submittedBy} caller=${userA.id} source=${row.source}`
  );
}

// --- command 13: seeded contexts stay separate ---------------------------
{
  const res = await req('/api/v1/master-data/gotras?query=Kashyap&limit=50');
  const kashyaps = (res.json?.data?.items || []).filter((item) => item.name === 'Kashyap');
  const distinctScopes = new Set(kashyaps.map((item) => item.communityId));
  check(
    '13. the same name in different contexts stays as distinct records',
    res.status === 200 && kashyaps.length >= 3 && distinctScopes.size === kashyaps.length,
    `rows=${kashyaps.length} distinct contexts=${distinctScopes.size}`
  );

  const aaspads = await getMasterModel('aaspads').countDocuments({});
  const clans = await getMasterModel('clans').countDocuments({});
  const chandel = await getMasterModel('clans').findOne({ slug: 'chandel' }).lean();
  check(
    '13b. clans and aaspads are their own collections with clan -> gotra links',
    aaspads === 105 && clans > 20 && Array.isArray(chandel?.gotraIds) && chandel.gotraIds.length >= 4,
    `aaspads=${aaspads} clans=${clans} chandelGotras=${chandel?.gotraIds?.length}`
  );
}

// --- additional security / data checks -----------------------------------
{
  const list = await req('/api/v1/master-data/gotras?limit=50');
  const items = list.json?.data?.items || [];
  const leaked = items.some((item) =>
    ['source', 'submittedBy', 'verifiedBy', 'nameLower', '__v'].some((field) => field in item)
  );
  check('S1. option payloads leak no internal fields', items.length > 0 && !leaked, `leaked=${leaked}`);
  check(
    'S2. public listings carry a cache header and admin listings do not',
    (list.headers.get('cache-control') || '').includes('public') &&
      ((await req('/api/v1/master-data/gotras?limit=5&activeOnly=false')).headers.get('cache-control') || '') ===
        'no-store',
    `public=${list.headers.get('cache-control')}`
  );

  const shaped = await req('/api/v1/master-data/occupations?query[$ne]=x');
  check('S3. query-shaped values are rejected', shaped.status === 400, `status=${shaped.status}`);

  const unauth = await post('/api/v1/master-data/gotras/missing', { name: 'Nope' });
  check('S4. the .missing path requires authentication', unauth.status === 401, `status=${unauth.status}`);

  const configRecord = await CommunityConfig.findOne({ slug: 'chandravanshi' }).lean();
  check(
    'S5. the Chandravanshi community_configs record exists with its settings',
    Boolean(configRecord?.settings) && typeof configRecord?.rules?.sameGotraAllowed === 'boolean',
    `settings=${JSON.stringify(configRecord?.settings)} rules=${JSON.stringify(configRecord?.rules)}`
  );

  const plan = await (async () => {
    const filter = masterDataService.buildFilter('gotras', { query: 'kashyap' });
    return getMasterModel('gotras').find(filter).explain('executionStats');
  })();
  check(
    'S6. the search query is index-backed (no collection scan of a large list)',
    JSON.stringify(plan).includes('IXSCAN') || JSON.stringify(plan).includes('nameLower_1'),
    'see explain winningPlan'
  );
}

for (const result of results) {
  console.log(`${result.pass ? 'PASS' : 'FAIL'}  ${result.name}  (${result.detail})`);
}
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

await mongoose.disconnect();
// `process.exit()` can abort before pending stdout writes flush (observed on
// Windows with a piped stdout); exitCode keeps the status and exits cleanly.
process.exitCode = failed.length ? 1 : 0;
