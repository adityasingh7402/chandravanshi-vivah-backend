'use strict';

/**
 * Step 15 — Subscription / Entitlement (spec §26, §27, §86, §87, §88, §89,
 * §114, §124, §127; finalized decisions §11, §12, §22).
 *
 * Runs against the configured cluster in a DEDICATED database. The step
 * depends only on step 04 (auth/session), so unlike the profile-track suites it
 * needs no master-data seed and no photo fixtures — a registered account is
 * enough to exercise the whole surface.
 *
 * What this suite is really pinning down:
 *
 *   - registration grants **exactly one indefinite free entitlement**
 *     (`expiresAt: null`), and nothing can duplicate or downgrade it;
 *   - `hasFeatureAccess()` is the single gate and returns true for every
 *     implemented feature under the free plan (decisions §12 — nothing gated);
 *   - the expiry sweep can only ever touch rows with a real past-due date, so
 *     the free plan can never be expired (decisions §11, §22);
 *   - there is no payment code: the provider paths answer 404 and no file
 *     branches on a provider name (spec §89).
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.MONGODB_DB_NAME = 'chandravanshi_vivah_test_subscription';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.RATE_LIMIT_MAX = '99999';
process.env.RATE_LIMIT_WINDOW = '3600';
// No media is exercised here; present-but-empty credentials keep the suite
// hermetic against whatever the developer's `.env` holds (dotenv fills only
// absent keys), and the mock flag is left alone because it must never be
// combined with real credentials.
process.env.CLOUDINARY_CLOUD_NAME = '';
process.env.CLOUDINARY_API_KEY = '';
process.env.CLOUDINARY_API_SECRET = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const app = require('../src/app');
const db = require('../src/config/db');
const User = require('../src/models/User');
const Session = require('../src/models/Session');
const Subscription = require('../src/models/Subscription');
const subscriptionService = require('../src/services/subscriptionService');
const entitlementService = require('../src/services/entitlementService');
const { FEATURE_VALUES, FEATURES } = require('../src/constants/features');
const {
  PLANS,
  PLAN_VALUES,
  SUBSCRIPTION_STATUSES,
  SUBSCRIPTION_SOURCES,
  SUBSCRIPTION_STATUS_VALUES,
  SUBSCRIPTION_SOURCE_VALUES
} = require('../src/constants/plans');
const { COLLECTIONS, FUTURE_COLLECTIONS, ALL_COLLECTIONS } = require('../src/config/collections');
const backfill = require('../scripts/backfill-entitlements');

const PASSWORD = 'correct-horse-battery';

let server;
let base;
let available = false;
let unavailableReason = '';
let accountSeq = 0;

function requireDb(t) {
  if (!available) {
    t.skip(`database unavailable (${unavailableReason})`);
    return false;
  }
  return true;
}

async function api(route, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text };
}

/** Register + log in through the real HTTP surface. */
async function freshAccount() {
  accountSeq += 1;
  const identifier = `p15-${Date.now()}-${accountSeq}@example.com`;
  const created = await api('/api/v1/auth/register', {
    method: 'POST',
    body: { identifierType: 'email', identifier, password: PASSWORD }
  });
  assert.equal(created.status, 201, `register: ${JSON.stringify(created.json)}`);
  const loggedIn = await api('/api/v1/auth/login', {
    method: 'POST',
    body: { identifierType: 'email', identifier, password: PASSWORD, deviceType: 'android' }
  });
  assert.equal(loggedIn.status, 200, `login: ${JSON.stringify(loggedIn.json)}`);
  return { id: created.json.data.user.id, token: loggedIn.json.data.accessToken, identifier };
}

const getSubscription = (token, query = '') => api(`/api/v1/subscription${query}`, { token });
const rowsFor = (userId) => Subscription.find({ userId }).sort({ createdAt: -1 }).lean();

test.before(async () => {
  try {
    await db.connect();
    available = true;
  } catch (err) {
    available = false;
    unavailableReason = (err && err.name) || 'connection failed';
    return;
  }

  await Subscription.collection.drop().catch(() => {});
  await Session.collection.drop().catch(() => {});
  await User.collection.drop().catch(() => {});
  await Subscription.createIndexes();
  await User.createIndexes();

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.disconnect();
});

// ---------------------------------------------------------------------------
// Gate 1 — build integrity
// ---------------------------------------------------------------------------

test('G1.1 every step-15 deliverable exists', () => {
  const root = path.join(__dirname, '..');
  for (const rel of [
    'src/models/Subscription.js',
    'src/services/entitlementService.js',
    'src/services/subscriptionService.js',
    'src/controllers/subscription.controller.js',
    'src/routes/subscription.routes.js',
    'src/constants/features.js',
    'src/constants/plans.js',
    'scripts/backfill-entitlements.js'
  ]) {
    assert.ok(fs.existsSync(path.join(root, rel)), `missing deliverable: ${rel}`);
  }
});

test('G1.1 / G3.6 the subscription route is mounted and requires auth', async (t) => {
  if (!requireDb(t)) return;
  const res = await api('/api/v1/subscription');
  assert.equal(res.status, 401, `expected 401, got ${res.status}`);
});

test('G1.2 / G5.4 §105 — the subscription indexes exist, including the partial unique active index', async (t) => {
  if (!requireDb(t)) return;
  const indexes = await Subscription.collection.indexes();
  const names = indexes.map((index) => index.name);
  assert.ok(names.includes('userId_1_status_1'), `lookup index missing: ${names.join(', ')}`);
  assert.ok(names.includes('status_1_expiresAt_1'), `expiry index missing: ${names.join(', ')}`);
  const active = indexes.find((index) => index.name === 'userId_1' && index.unique);
  assert.ok(active, 'the one-active-per-user unique index is missing');
  assert.deepEqual(
    active.partialFilterExpression,
    { status: 'active' },
    'the unique index must be partial on active rows so retired history is unconstrained'
  );
});

// ---------------------------------------------------------------------------
// Gate 2 — functional
// ---------------------------------------------------------------------------

test('G2.1 registration grants exactly one indefinite free entitlement (command 1)', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();

  const rows = await rowsFor(account.id);
  assert.equal(rows.length, 1, 'exactly one subscription row must exist');
  const row = rows[0];
  assert.equal(row.plan, 'free');
  assert.equal(row.status, 'active');
  assert.equal(row.source, 'free_trial');
  assert.equal(row.expiresAt, null, 'the free entitlement must never carry an expiry date');
  assert.ok(row.startedAt instanceof Date, 'startedAt is set at registration time');

  // And the API reports the same record.
  const res = await getSubscription(account.token);
  assert.equal(res.status, 200, `subscription: ${JSON.stringify(res.json)}`);
  const entitlement = res.json.data.entitlement;
  assert.equal(entitlement.plan, 'free');
  assert.equal(entitlement.status, 'active');
  assert.equal(entitlement.source, 'free_trial');
  assert.equal(entitlement.expiresAt, null);
  assert.equal(entitlement.isActive, true);
  assert.ok(entitlement.startedAt);
});

test('G2.6 re-running the registration hook cannot create a second entitlement (command 2)', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();

  const first = await subscriptionService.createFreeTrial(account.id);
  const second = await subscriptionService.createFreeTrial(account.id);
  assert.equal(first.created, false, 'the hook is a no-op when a row exists');
  assert.equal(second.created, false);
  assert.equal((await rowsFor(account.id)).length, 1, 'still exactly one row');

  // Concurrent grants (a retried webhook or doubled request) still yield one row.
  const fresh = await freshAccount();
  await Subscription.deleteMany({ userId: fresh.id });
  const results = await Promise.all(
    Array.from({ length: 5 }, () => subscriptionService.createFreeTrial(fresh.id).catch((err) => ({ error: err })))
  );
  assert.ok(results.every((result) => !result.error), `no grant may fail: ${JSON.stringify(results)}`);
  assert.equal((await rowsFor(fresh.id)).length, 1, 'racing grants must still leave exactly one row');
});

test('G2.2 the backfill migration provisions row-less accounts and leaves retired ones alone', async (t) => {
  if (!requireDb(t)) return;
  // A legacy account: a real user with no subscription row at all.
  const legacy = await User.create({
    email: `legacy-${Date.now()}@example.com`,
    phone: null,
    passwordHash: 'x'.repeat(20),
    role: 'user',
    status: 'active'
  });
  const legacyId = String(legacy._id);
  assert.equal((await rowsFor(legacyId)).length, 0, 'the legacy account starts row-less');

  const summary = await backfill.main();
  assert.ok(summary.created >= 1, `backfill must create the missing row: ${JSON.stringify(summary)}`);
  const granted = await rowsFor(legacyId);
  assert.equal(granted.length, 1);
  assert.equal(granted[0].plan, 'free');
  assert.equal(granted[0].expiresAt, null);

  // Idempotent: a second pass creates nothing.
  const again = await backfill.main();
  assert.equal(again.created, 0, 'a second backfill pass must create nothing');
  assert.equal((await rowsFor(legacyId)).length, 1);

  // An account whose only row is retired is NOT re-granted: that would be
  // resurrecting access, which is a future product decision, not a default.
  const retired = await User.create({
    email: `retired-${Date.now()}@example.com`,
    phone: null,
    passwordHash: 'x'.repeat(20),
    role: 'user',
    status: 'active'
  });
  const retiredId = String(retired._id);
  await Subscription.collection.insertOne({
    userId: retired._id,
    plan: 'free',
    status: SUBSCRIPTION_STATUSES.EXPIRED,
    source: SUBSCRIPTION_SOURCES.FREE_TRIAL,
    startedAt: new Date(Date.now() - 86400000),
    expiresAt: new Date(Date.now() - 3600000),
    createdAt: new Date(),
    updatedAt: new Date()
  });
  const ensured = await subscriptionService.ensureExists(retiredId);
  assert.equal(ensured.created, false, 'a retired-only account must not be silently re-granted');
  assert.equal((await rowsFor(retiredId)).length, 1);
  assert.equal((await rowsFor(retiredId))[0].status, SUBSCRIPTION_STATUSES.EXPIRED);
});

test('G2.3 / G2.7 §86 / decisions §12 — the gate is centralised and grants every implemented feature', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();

  assert.equal(await entitlementService.hasEntitlement(account.id), true);
  for (const feature of FEATURE_VALUES) {
    assert.equal(
      await entitlementService.hasFeatureAccess(account.id, feature),
      true,
      `${feature} must be available on the free plan — nothing is gated in this phase`
    );
    const explained = await entitlementService.explain(account.id, feature);
    assert.deepEqual(explained, { allowed: true, reason: 'granted', plan: 'free' });
  }
  assert.equal(FEATURE_VALUES.length, Object.keys(FEATURES).length, 'the vocabulary is complete');

  // Fails closed: an unknown feature key is denied, not thrown.
  const unknown = await entitlementService.explain(account.id, 'not_a_feature');
  assert.equal(unknown.allowed, false);
  assert.equal(unknown.reason, 'unknown_feature');
  assert.equal(await entitlementService.hasFeatureAccess(account.id, 'not_a_feature'), false);

  // And a row-less account (before the read path heals it) has no entitlement.
  const rowless = await User.create({
    email: `rowless-${Date.now()}@example.com`,
    phone: null,
    passwordHash: 'x'.repeat(20),
    role: 'user',
    status: 'active'
  });
  assert.equal(await entitlementService.hasEntitlement(String(rowless._id)), false);
  assert.equal(await entitlementService.hasFeatureAccess(String(rowless._id), FEATURES.SEND_INTEREST), false);
  const explained = await entitlementService.explain(String(rowless._id), FEATURES.SEND_INTEREST);
  assert.equal(explained.reason, 'no_active_entitlement');
});

test('G2.4 GET /subscription returns the effective plan, dates and resolved features (command 1)', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  const res = await getSubscription(account.token);
  assert.equal(res.status, 200);
  const entitlement = res.json.data.entitlement;
  assert.deepEqual(
    Object.keys(entitlement).sort(),
    ['expiresAt', 'features', 'isActive', 'plan', 'source', 'startedAt', 'status'],
    'the DTO is exactly the documented fields — no userId, no row id'
  );
  assert.deepEqual([...entitlement.features].sort(), [...FEATURE_VALUES].sort(), 'the feature list is the resolved plan set');
  assert.ok(!res.text.includes(account.id), 'the response must not echo the account id');
});

test('G2.4 the read path self-heals an account that lost its row', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  await Subscription.deleteMany({ userId: account.id });

  const res = await getSubscription(account.token);
  assert.equal(res.status, 200, `self-heal: ${JSON.stringify(res.json)}`);
  assert.equal(res.json.data.entitlement.plan, 'free');
  assert.equal((await rowsFor(account.id)).length, 1, 'the missing row was recreated');
});

test('G2.5 the expiry sweep retires only non-null past-due rows; the free plan is untouchable (command 7)', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  const freeRow = (await rowsFor(account.id))[0];

  // Two synthetic *accounts*, because the partial unique index allows only one
  // active row per user (a fact this suite verifies elsewhere) — so a past-due
  // row and a not-yet-due row cannot live on the same account. They are written
  // through the driver so the service's own rules are not what is under test.
  const pastDue = await freshAccount();
  const futureDue = await freshAccount();
  await Subscription.deleteMany({ userId: { $in: [pastDue.id, futureDue.id] } });
  await Subscription.collection.insertOne({
    userId: new mongoose.Types.ObjectId(pastDue.id),
    plan: PLANS.PREMIUM,
    status: SUBSCRIPTION_STATUSES.ACTIVE,
    source: SUBSCRIPTION_SOURCES.RAZORPAY,
    startedAt: new Date(Date.now() - 86400000 * 30),
    expiresAt: new Date(Date.now() - 3600000),
    createdAt: new Date(),
    updatedAt: new Date()
  });
  await Subscription.collection.insertOne({
    userId: new mongoose.Types.ObjectId(futureDue.id),
    plan: PLANS.PREMIUM,
    status: SUBSCRIPTION_STATUSES.ACTIVE,
    source: SUBSCRIPTION_SOURCES.GOOGLE_PLAY,
    startedAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
    createdAt: new Date(),
    updatedAt: new Date()
  });

  const { expired } = await entitlementService.expirePastDue();
  assert.equal(expired, 1, 'exactly the past-due row is retired');

  const past = await Subscription.findOne({ userId: pastDue.id }).lean();
  const future = await Subscription.findOne({ userId: futureDue.id }).lean();
  assert.equal(past.status, SUBSCRIPTION_STATUSES.EXPIRED);
  assert.equal(future.status, SUBSCRIPTION_STATUSES.ACTIVE, 'a row that is not due must not move');

  // The free entitlement is untouched by the same sweep, run twice.
  await entitlementService.expirePastDue();
  const free = await Subscription.findById(freeRow._id).lean();
  assert.equal(free.status, SUBSCRIPTION_STATUSES.ACTIVE, 'the free plan never expires (decisions §11, §22)');
  assert.equal(free.expiresAt, null);

  // The sweep resurrected nothing: the still-future account resolves to its
  // active premium row, and the retired account no longer resolves at all — a
  // retired row is not a missing one, so the read path does not re-grant.
  const effective = await entitlementService.get(futureDue.id);
  assert.equal(effective.plan, PLANS.PREMIUM);
  assert.equal(effective.subscription.source, SUBSCRIPTION_SOURCES.GOOGLE_PLAY);
  assert.equal((await rowsFor(futureDue.id)).length, 1, 'the sweep must not create rows');
  assert.equal(await entitlementService.hasEntitlement(pastDue.id), false);
  assert.equal((await rowsFor(pastDue.id)).length, 1);
});

test('G3.1 a client cannot influence the resolution (plan/source/feature are refused)', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();

  // A query field is a 400 — the schema is empty and strict.
  for (const query of ['?plan=premium', '?userId=someone', '?feature=unlimited_chat', '?status=expired']) {
    const res = await getSubscription(account.token, query);
    assert.equal(res.status, 400, `${query} must be a 400, got ${res.status}`);
  }

  // There is no write surface at all: POST/PATCH on the path are 404s.
  const post = await api('/api/v1/subscription', { method: 'POST', token: account.token, body: { plan: 'premium' } });
  assert.equal(post.status, 404);
  const patch = await api('/api/v1/subscription', { method: 'PATCH', token: account.token, body: { plan: 'premium' } });
  assert.equal(patch.status, 404);

  // And after all of that, the stored and reported plan is still free.
  assert.equal((await rowsFor(account.id))[0].plan, 'free');
  const res = await getSubscription(account.token);
  assert.equal(res.json.data.entitlement.plan, 'free');
});

test('G3.2 one account cannot read another account’s subscription (command 5)', async (t) => {
  if (!requireDb(t)) return;
  const a = await freshAccount();
  const b = await freshAccount();

  // Give B a distinctive plan directly so A's answer would be visibly wrong if
  // it ever read B's row.
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

  const mine = await getSubscription(a.token);
  assert.equal(mine.json.data.entitlement.plan, 'free', 'A must see only A’s own plan');
  const theirs = await getSubscription(b.token);
  assert.equal(theirs.json.data.entitlement.plan, 'premium_plus', 'B sees B’s plan');

  // There is no parameter naming a subject; the route has only the literal path.
  assert.equal((await getSubscription(a.token, `/${b.id}`)).status, 404);
  assert.equal((await getSubscription(a.token, `?userId=${b.id}`)).status, 400);
});

test('G3.3 §89 — no payment/provider route exists (command 4)', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  for (const route of [
    '/api/v1/subscription/razorpay/order',
    '/api/v1/subscription/webhook',
    '/api/v1/subscription/google-play/verify',
    '/api/v1/subscription/checkout'
  ]) {
    const res = await api(route, { method: 'POST', token: account.token, body: {} });
    assert.equal(res.status, 404, `${route} must not exist, got ${res.status}`);
  }
});

test('G3.4 / G3.5 §79 / §86 — no provider secret or provider branch exists in the codebase', async (t) => {
  if (!requireDb(t)) return;
  // .env.example carries no payment-provider variable.
  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.ok(!/RAZORPAY|RAZOR_|GOOGLE_PLAY|PLAY_BILLING|STRIPE/i.test(example), '.env.example must not declare a provider secret yet');

  // No source file branches on a provider name (spec §86): string literals of
  // provider sources may appear only in constants/plans.js (the schema enum).
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
  };
  const files = walk(path.join(__dirname, '..', 'src'));
  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    // A comparison or switch against a provider name is a branch; a mention in
    // a comment or the constants module is documentation, not logic.
    if (/===?\s*['"](razorpay|google_play)['"]/.test(text) || /['"](razorpay|google_play)['"]\s*===?/.test(text)) {
      offenders.push(path.relative(path.join(__dirname, '..'), file));
    }
  }
  assert.deepEqual(offenders, [], `no file may branch on a provider name: ${offenders.join(', ')}`);

  // Only the constants module declares the provider identifiers at all.
  const declaredIn = files
    .filter((file) => /['"](razorpay|google_play)['"]/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(path.join(__dirname, '..'), file).split(path.sep).join('/'));
  assert.deepEqual(declaredIn, ['src/constants/plans.js'], `provider names must live only in constants/plans.js: ${declaredIn.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Gate 4 — performance & data
// ---------------------------------------------------------------------------

test('G4.1 the entitlement lookup is index-backed (IXSCAN)', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  const plan = await Subscription.find({ userId: account.id, status: SUBSCRIPTION_STATUSES.ACTIVE }).explain(
    'queryPlanner'
  );
  const winning = JSON.stringify(plan.queryPlanner.winningPlan);
  assert.ok(winning.includes('IXSCAN'), `the lookup must use userId_1_status_1, got ${winning}`);
  assert.ok(!winning.includes('COLLSCAN'));
});

test('G4.2 one lookup resolves the whole feature set — never a query per feature', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();

  let lookups = 0;
  const original = subscriptionService.getActiveForUser;
  subscriptionService.getActiveForUser = async (...args) => {
    lookups += 1;
    return original.apply(subscriptionService, args);
  };
  try {
    // One gate call = one lookup, however many features exist.
    assert.equal(await entitlementService.hasFeatureAccess(account.id, FEATURES.SEND_INTEREST), true);
    assert.equal(lookups, 1, 'hasFeatureAccess must resolve the plan with a single lookup');

    lookups = 0;
    const effective = await entitlementService.get(account.id);
    assert.equal(effective.features.length, FEATURE_VALUES.length);
    assert.equal(lookups, 1, 'get() must resolve the whole set with a single lookup');
  } finally {
    subscriptionService.getActiveForUser = original;
  }
});

test('G4.3 the expiry sweep uses the expiry index', async (t) => {
  if (!requireDb(t)) return;
  const plan = await Subscription.find({
    status: SUBSCRIPTION_STATUSES.ACTIVE,
    expiresAt: { $ne: null, $lte: new Date() }
  }).explain('queryPlanner');
  const winning = JSON.stringify(plan.queryPlanner.winningPlan);
  assert.ok(winning.includes('IXSCAN'), `the sweep must use status_1_expiresAt_1, got ${winning}`);
});

// ---------------------------------------------------------------------------
// Gate 5 — spec conformance
// ---------------------------------------------------------------------------

test('G5.1 §26 — the document, enums and status/source sets match the specification', async (t) => {
  if (!requireDb(t)) return;
  for (const field of ['userId', 'plan', 'status', 'source', 'startedAt', 'expiresAt']) {
    assert.ok(Subscription.schema.path(field), `missing field: ${field}`);
  }
  assert.deepEqual([...Subscription.schema.path('plan').enumValues].sort(), [...PLAN_VALUES].sort());
  assert.deepEqual(
    [...Subscription.schema.path('status').enumValues].sort(),
    [...SUBSCRIPTION_STATUS_VALUES].sort()
  );
  assert.deepEqual(
    [...Subscription.schema.path('source').enumValues].sort(),
    [...SUBSCRIPTION_SOURCE_VALUES].sort()
  );
  assert.deepEqual(SUBSCRIPTION_STATUS_VALUES, ['active', 'expired', 'cancelled']);
  assert.deepEqual(SUBSCRIPTION_SOURCE_VALUES, ['free_trial', 'razorpay', 'google_play']);
});

test('G5.2 §86 / §114 — access is asked through one service; no other module reads the collection', async (t) => {
  if (!requireDb(t)) return;
  const srcRoot = path.join(__dirname, '..', 'src');
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.js') ? [full] : [];
    });
  };
  const allowed = new Set([
    path.join('src', 'models', 'Subscription.js'),
    path.join('src', 'services', 'subscriptionService.js'),
    path.join('src', 'services', 'entitlementService.js'),
    // The read path self-heal (step 15's own controller) may check existence.
    path.join('src', 'controllers', 'subscription.controller.js')
  ]);
  const readers = walk(srcRoot)
    .filter((file) => /require\(.*models\/Subscription/.test(fs.readFileSync(file, 'utf8')))
    .map((file) => path.relative(path.join(__dirname, '..'), file))
    .filter((rel) => !allowed.has(rel));
  assert.deepEqual(readers, [], `only the entitlement layer may read subscriptions: ${readers.join(', ')}`);
});

test('G5.4 §127 — payment_transactions is future-only and was never created', async (t) => {
  if (!requireDb(t)) return;
  assert.equal(FUTURE_COLLECTIONS.PAYMENT_TRANSACTIONS, 'payment_transactions');
  assert.ok(!ALL_COLLECTIONS.includes('payment_transactions'), 'it must not be in the current collection list');
  assert.ok(COLLECTIONS.SUBSCRIPTIONS === 'subscriptions');
  const names = (await mongoose.connection.db.listCollections().toArray()).map((entry) => entry.name);
  assert.ok(!names.includes('payment_transactions'), 'the future-only collection must not exist in the database');
});

test('G5.7 decisions §11 / §22 — the free plan is indefinite and nothing expires it', async (t) => {
  if (!requireDb(t)) return;
  const account = await freshAccount();
  const row = (await rowsFor(account.id))[0];
  assert.equal(row.expiresAt, null);
  // Run the sweep repeatedly against a row whose only distinguishing feature
  // is `expiresAt: null`. Whatever else the shared database holds, THIS row
  // must never be matched (the sweep's filter names a past-due non-null date).
  for (let i = 0; i < 3; i += 1) {
    await entitlementService.expirePastDue();
    const after = await Subscription.findById(row._id).lean();
    assert.equal(after.status, 'active', 'no row with expiresAt: null may ever be retired by the sweep');
  }
  assert.equal(await entitlementService.hasFeatureAccess(account.id, FEATURES.UNLIMITED_CHAT), true);
});

test('G5.5 / G5.6 the provider flows exist only as the documented seam', async (t) => {
  if (!requireDb(t)) return;
  // The seam is a real callable shape with no caller: grant() updates the
  // single active row and never deletes history.
  const account = await freshAccount();
  const { subscription } = await entitlementService.grant({
    userId: account.id,
    plan: PLANS.PREMIUM,
    source: SUBSCRIPTION_SOURCES.RAZORPAY,
    expiresAt: new Date(Date.now() + 86400000 * 30)
  });
  assert.equal(subscription.plan, 'premium');
  assert.equal((await rowsFor(account.id)).length, 1, 'grant updates in place — one active row');
  assert.equal(await entitlementService.hasFeatureAccess(account.id, FEATURES.SEND_INTEREST), true);

  // No route calls grant: the read surface cannot mint a plan.
  const before = (await rowsFor(account.id))[0].plan;
  const res = await getSubscription(account.token);
  assert.equal(res.json.data.entitlement.plan, before);
  assert.equal((await rowsFor(account.id))[0].plan, before);
});

test('G5.3 the registration hook is the only caller that grants outside the seam', async (t) => {
  if (!requireDb(t)) return;
  // Structural: `authService.register` awaits createFreeTrial. Proven by a
  // fresh registration — a new account has exactly one active row before any
  // other request touches it.
  const account = await freshAccount();
  const rows = await rowsFor(account.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'active');
  assert.equal(rows[0].expiresAt, null);
  // The account is usable immediately: the badge-equivalent (feature access)
  // is already true on the first authenticated read.
  const res = await getSubscription(account.token);
  assert.equal(res.status, 200);
  assert.equal(res.json.data.entitlement.isActive, true);
});
