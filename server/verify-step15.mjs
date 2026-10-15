// Step 15 scripted verification — drives the doc's seven verification commands
// against a live server, plus the index, sweep, seam and privacy checks.
//
// Seed + boot the server with the test database first, then run with the SAME
// database:
//   MONGODB_DB_NAME=chandravanshi_vivah_test AUTH_RATE_LIMIT_MAX=1000 \
//     node verify-step15.mjs
//
// The raised login budget is for the harness's own account volume (each fixture
// is a register + login pair against the shared brute-force limiter). No other
// limit is touched, and no media surface is exercised, so Cloudinary state is
// irrelevant to this step.
//
// Exit code 0 means every check that ran passed.
import mongoose from 'mongoose';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const config = require('./src/config/env');
const User = require('./src/models/User');
const Subscription = require('./src/models/Subscription');
const entitlementService = require('./src/services/entitlementService');
const subscriptionService = require('./src/services/subscriptionService');
const { FEATURE_VALUES, FEATURES } = require('./src/constants/features');
const {
  PLANS,
  PLAN_VALUES,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_SOURCES,
  SUBSCRIPTION_STATUS_VALUES,
  SUBSCRIPTION_SOURCE_VALUES
} = require('./src/constants/plans');
const { COLLECTIONS, FUTURE_COLLECTIONS, ALL_COLLECTIONS } = require('./src/config/collections');
const backfill = require('./scripts/backfill-entitlements');

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

let accountSeq = 0;
async function account() {
  accountSeq += 1;
  const identifier = `s15-${RUN}-${accountSeq}@example.com`;
  const created = await post('/api/v1/auth/register', { identifierType: 'email', identifier, password: PASSWORD });
  if (created.status !== 201) throw new Error(`register failed: ${created.status} ${created.text?.slice(0, 200)}`);
  const loggedIn = await post('/api/v1/auth/login', {
    identifierType: 'email',
    identifier,
    password: PASSWORD,
    deviceType: 'android'
  });
  if (loggedIn.status !== 200) throw new Error(`login failed: ${loggedIn.status} ${loggedIn.text?.slice(0, 200)}`);
  return { id: created.json.data.user.id, token: loggedIn.json.data.accessToken, identifier };
}

const subscription = (token, query = '') => req(`/api/v1/subscription${query}`, { headers: auth(token) });
const rowsFor = (userId) => Subscription.find({ userId }).sort({ createdAt: -1 }).lean();

await mongoose.connect(config.mongodbUri, { dbName: config.mongodbDbName, serverSelectionTimeoutMS: 5000 });

// ---------------------------------------------------------------------------
// Command 1 — registration grants a free entitlement
// ---------------------------------------------------------------------------
const a = await account();
let aRow = null;
{
  const res = await subscription(a.token);
  const e = res.json?.data?.entitlement;
  aRow = (await rowsFor(a.id))[0];
  check(
    'command 1: registration grants plan "free", source "free_trial", status "active"',
    res.status === 200 && e?.plan === 'free' && e?.source === 'free_trial' && e?.status === 'active' && e?.isActive === true,
    `status=${res.status} entitlement=${JSON.stringify(e)}`
  );
  check(
    'command 1: the free entitlement is indefinite — expiresAt is null',
    aRow?.expiresAt === null && e?.expiresAt === null,
    `expiresAt=${aRow?.expiresAt}`
  );
  check(
    'command 1: the DTO is exactly the documented field set (no account id, no row id)',
    e && Object.keys(e).sort().join(',') === 'expiresAt,features,isActive,plan,source,startedAt,status' && !res.text.includes(a.id),
    `keys=${Object.keys(e || {}).sort().join(',')}`
  );
  check(
    'command 1: the response resolves every declared feature for the free plan',
    Array.isArray(e?.features) && [...e.features].sort().join(',') === [...FEATURE_VALUES].sort().join(','),
    `features=${(e?.features || []).length}/${FEATURE_VALUES.length}`
  );
}

// ---------------------------------------------------------------------------
// Command 2 — no duplicate entitlements
// ---------------------------------------------------------------------------
{
  await subscriptionService.createFreeTrial(a.id);
  await subscriptionService.createFreeTrial(a.id);
  const fresh = await account();
  await Subscription.deleteMany({ userId: fresh.id });
  const racing = await Promise.all(
    Array.from({ length: 5 }, () => subscriptionService.createFreeTrial(fresh.id).catch((err) => ({ error: err })))
  );
  check(
    'command 2: repeated and racing grants leave exactly one active row',
    (await rowsFor(a.id)).length === 1 && (await rowsFor(fresh.id)).length === 1 && racing.every((r) => !r.error),
    `a=${(await rowsFor(a.id)).length} fresh=${(await rowsFor(fresh.id)).length} races=${racing.filter((r) => r.error).length} failed`
  );
  const indexes = await Subscription.collection.indexes();
  const unique = indexes.find((index) => index.name === 'userId_1' && index.unique);
  check(
    '§105: the lookup, expiry and one-active-per-user indexes exist (the unique is partial on active)',
    indexes.some((index) => index.name === 'userId_1_status_1') &&
      indexes.some((index) => index.name === 'status_1_expiresAt_1') &&
      unique?.partialFilterExpression?.status === 'active',
    indexes.map((index) => index.name).join(',')
  );
}

// ---------------------------------------------------------------------------
// Command 3 — feature access resolution
// ---------------------------------------------------------------------------
{
  let allGranted = true;
  for (const feature of FEATURE_VALUES) {
    if ((await entitlementService.hasFeatureAccess(a.id, feature)) !== true) allGranted = false;
  }
  check(
    'command 3: hasFeatureAccess is true for every implemented feature on the free plan (nothing gated)',
    allGranted && (await entitlementService.hasFeatureAccess(a.id, FEATURES.SEND_INTEREST)) === true,
    `features=${FEATURE_VALUES.length}`
  );

  // One gate call must resolve the whole plan with a single lookup, never one
  // query per feature. Instrumented for exactly one call.
  let lookups = 0;
  const original = subscriptionService.getActiveForUser;
  subscriptionService.getActiveForUser = async (...args) => {
    lookups += 1;
    return original.apply(subscriptionService, args);
  };
  try {
    await entitlementService.hasFeatureAccess(a.id, FEATURES.SEND_INTEREST);
    await entitlementService.get(a.id);
  } finally {
    subscriptionService.getActiveForUser = original;
  }
  check(
    'command 3: one gate call resolves the plan with a single indexed lookup — no query per feature',
    lookups === 2,
    `lookups=${lookups} for 2 calls`
  );

  const explained = await entitlementService.explain(a.id, 'definitely_not_a_feature');
  check(
    'command 3: an unknown feature fails closed with a reason (never throws)',
    explained.allowed === false && explained.reason === 'unknown_feature',
    JSON.stringify(explained)
  );
}

// ---------------------------------------------------------------------------
// Command 4 — no payment routes exist
// ---------------------------------------------------------------------------
{
  const paths = [
    '/api/v1/subscription/razorpay/order',
    '/api/v1/subscription/webhook',
    '/api/v1/subscription/google-play/verify',
    '/api/v1/subscription/checkout'
  ];
  const statuses = [];
  for (const path of paths) statuses.push((await post(path, {}, a.token)).status);
  check(
    'command 4: every documented future provider path answers 404 — no payment flow exists',
    statuses.every((status) => status === 404),
    statuses.join(',')
  );
}

// ---------------------------------------------------------------------------
// Command 5 — cross-account access
// ---------------------------------------------------------------------------
{
  const b = await account();
  await Subscription.deleteMany({ userId: b.id });
  await Subscription.collection.insertOne({
    userId: new mongoose.Types.ObjectId(b.id),
    plan: PLANS.PREMIUM_PLUS,
    status: SUBSCRIPTION_STATUSES.ACTIVE,
    source: SUBSCRIPTION_SOURCES.RAZORPAY,
    startedAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000 * 30),
    createdAt: new Date(),
    updatedAt: new Date()
  });

  const mine = await subscription(a.token);
  const theirs = await subscription(b.token);
  check(
    'command 5: each account sees its own subscription only — A stays free while B is premium_plus',
    mine.json?.data?.entitlement?.plan === 'free' && theirs.json?.data?.entitlement?.plan === 'premium_plus',
    `a=${mine.json?.data?.entitlement?.plan} b=${theirs.json?.data?.entitlement?.plan}`
  );
  const named = await subscription(a.token, `?userId=${b.id}`);
  const spoof = await patch('/api/v1/subscription', { plan: 'premium' }, a.token);
  check(
    'command 5: a client cannot name a subject or claim a plan (400 on query, 404 on write)',
    named.status === 400 && spoof.status === 404,
    `query=${named.status} write=${spoof.status}`
  );
}

// ---------------------------------------------------------------------------
// Command 6 — unauthenticated
// ---------------------------------------------------------------------------
{
  const res = await req('/api/v1/subscription');
  check('command 6: an unauthenticated read answers 401', res.status === 401, `status=${res.status}`);
}

// ---------------------------------------------------------------------------
// Command 7 — expiry sweep
// ---------------------------------------------------------------------------
{
  const pastAccount = await account();
  const futureAccount = await account();
  await Subscription.deleteMany({ userId: { $in: [pastAccount.id, futureAccount.id] } });
  await Subscription.collection.insertOne({
    userId: new mongoose.Types.ObjectId(pastAccount.id),
    plan: PLANS.PREMIUM,
    status: SUBSCRIPTION_STATUSES.ACTIVE,
    source: SUBSCRIPTION_SOURCES.RAZORPAY,
    startedAt: new Date(Date.now() - 86400000 * 30),
    expiresAt: new Date(Date.now() - 3600000),
    createdAt: new Date(),
    updatedAt: new Date()
  });
  await Subscription.collection.insertOne({
    userId: new mongoose.Types.ObjectId(futureAccount.id),
    plan: PLANS.PREMIUM,
    status: SUBSCRIPTION_STATUSES.ACTIVE,
    source: SUBSCRIPTION_SOURCES.GOOGLE_PLAY,
    startedAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
    createdAt: new Date(),
    updatedAt: new Date()
  });

  const { expired } = await entitlementService.expirePastDue();
  const past = await Subscription.findOne({ userId: pastAccount.id }).lean();
  const future = await Subscription.findOne({ userId: futureAccount.id }).lean();
  const free = await Subscription.findById(aRow._id).lean();
  check(
    'command 7: the sweep retires exactly the past-due row and never a non-null-free one',
    expired === 1 &&
      past.status === SUBSCRIPTION_STATUSES.EXPIRED &&
      future.status === SUBSCRIPTION_STATUSES.ACTIVE &&
      free.status === SUBSCRIPTION_STATUSES.ACTIVE &&
      free.expiresAt === null,
    `expired=${expired} past=${past.status} future=${future.status} free=${free.status}`
  );

  // Run it again: nothing more moves, and the retired account is not re-granted.
  const again = await entitlementService.expirePastDue();
  const regenerated = await subscriptionService.ensureExists(pastAccount.id);
  check(
    'command 7: a second sweep is a no-op and a retired account is not resurrected',
    again.expired === 0 &&
      regenerated.created === false &&
      (await rowsFor(pastAccount.id)).length === 1 &&
      (await subscription(pastAccount.token)).json?.data?.entitlement === null,
    `expired=${again.expired} recreated=${regenerated.created}`
  );

  const lookupPlan = await Subscription.find({ userId: a.id, status: 'active' }).explain('queryPlanner');
  const sweepPlan = await Subscription.find({
    status: 'active',
    expiresAt: { $ne: null, $lte: new Date() }
  }).explain('queryPlanner');
  check(
    '§49: the entitlement lookup and the expiry sweep are index-backed (IXSCAN)',
    JSON.stringify(lookupPlan).includes('IXSCAN') && JSON.stringify(sweepPlan).includes('IXSCAN'),
    'queryPlanner'
  );
}

// ---------------------------------------------------------------------------
// Cross-cutting: backfill, self-heal, spec shape, future-only collection
// ---------------------------------------------------------------------------
{
  // A legacy account: a real user document with no subscription row at all.
  const legacy = await User.create({
    email: `s15-legacy-${RUN}@example.com`,
    phone: null,
    passwordHash: 'x'.repeat(20),
    role: 'user',
    status: 'active'
  });
  const legacyId = String(legacy._id);
  const summary = await backfill.main();
  const first = await rowsFor(legacyId);
  const second = await backfill.main();
  check(
    'the backfill migration provisions a row-less account exactly once and is idempotent',
    summary.created >= 1 &&
      first.length === 1 &&
      first[0].plan === 'free' &&
      first[0].expiresAt === null &&
      second.created === 0,
    `created=${summary.created} rows=${first.length} second=${second.created}`
  );

  // Read-path self-heal for an account that lost its row (same invariant, from
  // the API side).
  const healed = await account();
  await Subscription.deleteMany({ userId: healed.id });
  const healedRes = await subscription(healed.token);
  check(
    'GET /subscription recreates the missing free grant for an undelivered account',
    healedRes.status === 200 &&
      healedRes.json?.data?.entitlement?.plan === 'free' &&
      (await rowsFor(healed.id)).length === 1,
    `status=${healedRes.status} rows=${(await rowsFor(healed.id)).length}`
  );
}

{
  const fields = ['userId', 'plan', 'status', 'source', 'startedAt', 'expiresAt'];
  check(
    '§26: the document and its enums match the specification',
    fields.every((field) => Subscription.schema.path(field)) &&
      JSON.stringify(Subscription.schema.path('plan').enumValues) === JSON.stringify(PLAN_VALUES) &&
      JSON.stringify(Subscription.schema.path('status').enumValues) === JSON.stringify(SUBSCRIPTION_STATUS_VALUES) &&
      JSON.stringify(Subscription.schema.path('source').enumValues) === JSON.stringify(SUBSCRIPTION_SOURCE_VALUES),
    `plans=${PLAN_VALUES.length}`
  );
  check(
    '§127: payment_transactions is future-only and was never created',
    FUTURE_COLLECTIONS.PAYMENT_TRANSACTIONS === 'payment_transactions' &&
      !ALL_COLLECTIONS.includes('payment_transactions') &&
      COLLECTIONS.SUBSCRIPTIONS === 'subscriptions' &&
      !(await mongoose.connection.db.listCollections({ name: 'payment_transactions' }).hasNext()),
    'future-only'
  );
}

{
  // The provider seam is callable but has no caller: a grant updates the single
  // active row in place, and the read surface cannot mint a plan.
  const seamed = await account();
  const { subscription: granted } = await entitlementService.grant({
    userId: seamed.id,
    plan: PLANS.PREMIUM,
    source: SUBSCRIPTION_SOURCES.RAZORPAY,
    expiresAt: new Date(Date.now() + 86400000 * 30)
  });
  const rowCount = await Subscription.countDocuments({ userId: seamed.id });
  const read = await subscription(seamed.token);
  check(
    'the documented provider seam updates in place and never leaks into a client write path',
    granted.plan === 'premium' && rowCount === 1 && read.json?.data?.entitlement?.plan === 'premium',
    `plan=${granted.plan} rows=${rowCount} read=${read.json?.data?.entitlement?.plan}`
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
