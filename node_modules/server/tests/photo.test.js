'use strict';

/**
 * Step 08 — Photos, Kundli documents & Cloudinary (spec §15, §17, §18, §30, §43,
 * §44, §80, §101, §105, §112; finalized decisions §6; fields dictionary §11.7).
 *
 * Runs against the configured cluster in a DEDICATED database, seeded with the
 * real step-05 seeder. Cloudinary itself is replaced by a deterministic gateway
 * (`tests/helpers/fakeCloudinary.js`) that reports what the provider would
 * report — folder, format, byte count, secure URL — so the *verification rules*
 * are what these tests exercise. The live provider boundary is covered by
 * `verify-step08.mjs`, which reports it as SKIPPED when there are no credentials
 * rather than pretending it passed.
 *
 * Long-lived identities: `accountA` (a published profile with photos),
 * `accountB` (a second account used as the "other viewer"), and throwaway
 * accounts everywhere ordering could otherwise matter.
 */

process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error';
process.env.MONGODB_DB_NAME = 'chandravanshi_vivah_test_photo';
process.env.AUTH_RATE_LIMIT_MAX = '1000';
process.env.RATE_LIMIT_MAX = '99999';
process.env.RATE_LIMIT_WINDOW = '3600';
// A configured-but-fake Cloudinary: config validation must see all three, and
// the gateway double stands in for the provider's admin API.
process.env.CLOUDINARY_CLOUD_NAME = 'test-cloud';
process.env.CLOUDINARY_API_KEY = 'test-key-1234';
process.env.CLOUDINARY_API_SECRET = 'test-secret-abcdef';
process.env.CLOUDINARY_UPLOAD_FOLDER = 'chandravanshi-vivah-test';
// Small caps so the limits are cheap to reach.
process.env.PHOTO_MAX_COUNT = '3';
process.env.PHOTO_MAX_BYTES = '1mb';
process.env.PHOTO_ALLOWED_FORMATS = 'jpg,png,webp';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const app = require('../src/app');
const db = require('../src/config/db');
const config = require('../src/config/env');
const cloudinaryConfig = require('../src/config/cloudinary');
const User = require('../src/models/User');
const Session = require('../src/models/Session');
const MatrimonialProfile = require('../src/models/MatrimonialProfile');
const PartnerPreference = require('../src/models/PartnerPreference');
const Photo = require('../src/models/Photo');
const KundliDocument = require('../src/models/KundliDocument');
const CommunityConfig = require('../src/models/CommunityConfig');
const { getMasterModel } = require('../src/models/masterData/MasterItem');
const { MASTER_TYPE_VALUES } = require('../src/constants/masterData');
const {
  PHOTO_TYPES,
  PHOTO_VISIBILITY,
  MODERATION_STATUSES,
  TRANSFORMATIONS,
  SAFE_IMAGE_FORMATS
} = require('../src/constants/photo');
const { KUNDLI_VISIBILITY, KUNDLI_ASSET_TYPE } = require('../src/constants/kundli');
const photoService = require('../src/services/photoService');
const uploadSignature = require('../src/services/uploadSignature');
const profileScoreService = require('../src/services/profileScoreService');
const { variantsFor } = require('../src/utils/cloudinaryUrl');
const fakeCloudinary = require('./helpers/fakeCloudinary');
const seeder = require('../scripts/seed-master-data');

const PASSWORD = 'correct-horse-battery';
const CAP = config.media.photoMaxCount;
const SECRET = process.env.CLOUDINARY_API_SECRET;

let server;
let base;
let available = false;
let unavailableReason = '';
let accountA;
let accountB;
let accountSeq = 0;
let photoSeq = 0;

const master = {};

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

async function registerAndLogin(identifier) {
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
  return { id: created.json.data.user.id, token: loggedIn.json.data.accessToken };
}

async function freshAccount() {
  accountSeq += 1;
  return registerAndLogin(`p8-${Date.now()}-${accountSeq}@example.com`);
}

function remember(key, doc) {
  master[`${key}Id`] = String(doc._id);
  master[`${key}Name`] = doc.name;
  return doc;
}

async function pick(key, type, slug) {
  const model = getMasterModel(type);
  const preferred = slug ? await model.findOne({ slug }).select('_id name').lean() : null;
  const doc =
    preferred || (await model.findOne({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select('_id name').lean());
  assert.ok(doc, `step-05 seed has no active ${type} row`);
  return remember(key, doc);
}

/** The dictionary §25 required set, filled with real seeded master ids. */
function fullProfile(overrides = {}) {
  return {
    basic: {
      profileFor: 'self',
      firstName: 'Rahul',
      gender: 'male',
      dateOfBirth: '1998-05-01',
      maritalStatus: 'never_married',
      heightCm: 175,
      ...(overrides.basic || {})
    },
    community: {
      communityId: master.communityId,
      surnameId: master.surnameId,
      gotraId: master.gotraId,
      ...(overrides.community || {})
    },
    location: { cityId: master.cityId, ...(overrides.location || {}) },
    education: { highestQualificationId: master.degreeId, ...(overrides.education || {}) },
    career: { occupationId: master.occupationId, ...(overrides.career || {}) },
    family: { familyType: 'nuclear', ...(overrides.family || {}) },
    lifestyle: { diet: 'vegetarian', ...(overrides.lifestyle || {}) },
    about: { description: 'Simple family, straightforward person.', ...(overrides.about || {}) }
  };
}

/** The documented upload flow: sign, then register the asset that lands there. */
async function signedFolder(token) {
  const sign = await api('/api/v1/photos/sign', { method: 'POST', token, body: {} });
  assert.equal(sign.status, 200, `sign: ${JSON.stringify(sign.json)}`);
  return sign.json.data.upload;
}

async function addPhoto(token, { type = 'profile', name = 'photo', isPrimary } = {}) {
  const upload = await signedFolder(token);
  photoSeq += 1;
  const publicId = `${upload.folder}/${name}-${photoSeq}`;
  const body = { publicId, type };
  if (isPrimary !== undefined) body.isPrimary = isPrimary;
  const res = await api('/api/v1/photos', { method: 'POST', token, body });
  return { upload, publicId, res };
}

/** A complete profile with no photo yet, so the publish gate can be tested. */
async function accountWithProfile(profileOverrides) {
  const account = await freshAccount();
  const created = await api('/api/v1/profile', {
    method: 'POST',
    token: account.token,
    body: fullProfile(profileOverrides)
  });
  assert.equal(created.status, 201, `create profile: ${JSON.stringify(created.json)}`);
  return { ...account, profile: created.json.data.profile };
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

  for (const model of [
    ...MASTER_TYPE_VALUES.map((type) => getMasterModel(type)),
    KundliDocument,
    Photo,
    PartnerPreference,
    MatrimonialProfile,
    CommunityConfig,
    User,
    Session
  ]) {
    await model.collection.drop().catch(() => {});
    await model.createIndexes();
  }
  await seeder.main();

  const chosen = await (async () => {
    const communities = await getMasterModel('communities')
      .find({ isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .select('_id slug name')
      .lean();
    for (const community of communities) {
      const surname = await getMasterModel('surnames')
        .findOne({ communityId: community._id, isActive: true })
        .select('_id name')
        .lean();
      const gotra = await getMasterModel('gotras')
        .findOne({ communityId: community._id, isActive: true })
        .select('_id name')
        .lean();
      if (surname && gotra) return { community, surname, gotra };
    }
    return null;
  })();
  assert.ok(chosen, 'step-05 seed has no community with both a surname and a gotra');
  remember('community', chosen.community);
  remember('surname', chosen.surname);
  remember('gotra', chosen.gotra);
  await pick('city', 'cities', 'sikar');
  await pick('degree', 'degrees', 'mca');
  await pick('occupation', 'occupations', 'software-engineer');

  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  fakeCloudinary.install();

  accountA = await accountWithProfile();
  await addPhoto(accountA.token, { type: 'profile', name: 'primary' });
  const published = await api('/api/v1/profile', {
    method: 'PATCH',
    token: accountA.token,
    body: { status: 'active' }
  });
  assert.equal(published.status, 200, `publish A: ${JSON.stringify(published.json)}`);

  accountB = await registerAndLogin(`p8b-${Date.now()}@example.com`);
});

/**
 * Every test starts from a gateway that describes a *valid* upload. Tests that
 * need the provider to say something else (wrong format, oversized, missing)
 * call `fakeCloudinary.install({...})` themselves, so a rejection case can never
 * leak into the next test's happy path.
 */
test.beforeEach(() => {
  if (available) fakeCloudinary.install();
});

test.after(async () => {
  fakeCloudinary.uninstall();
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.disconnect();
});

// ---------------------------------------------------------------------------
// Gate 1 — build integrity
// ---------------------------------------------------------------------------

test('G1.1 every step-08 deliverable exists', () => {
  const files = [
    'src/config/cloudinary.js',
    'src/models/Photo.js',
    'src/models/KundliDocument.js',
    'src/services/photoService.js',
    'src/services/kundliService.js',
    'src/services/uploadSignature.js',
    'src/controllers/photo.controller.js',
    'src/controllers/kundli.controller.js',
    'src/routes/photo.routes.js',
    'src/routes/kundli.routes.js',
    'src/validators/photo.validators.js',
    'src/validators/kundli.validators.js',
    'src/utils/cloudinaryUrl.js',
    'src/constants/photo.js',
    'src/constants/kundli.js'
  ];
  const fs = require('node:fs');
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', file)), `${file} is missing`);
  }
});

test('G1.1 every photo and kundli route is mounted and requires auth (command 8)', async (t) => {
  if (!requireDb(t)) return;

  const cases = [
    ['GET', '/api/v1/photos'],
    ['POST', '/api/v1/photos/sign'],
    ['POST', '/api/v1/photos'],
    ['PATCH', '/api/v1/photos'],
    ['PATCH', `/api/v1/photos/${String(accountA.id)}`],
    ['DELETE', `/api/v1/photos/${String(accountA.id)}`],
    ['GET', '/api/v1/kundli'],
    ['POST', '/api/v1/kundli'],
    ['PATCH', `/api/v1/kundli/${String(accountA.id)}`],
    ['DELETE', `/api/v1/kundli/${String(accountA.id)}`]
  ];

  for (const [method, route] of cases) {
    const anonymous = await api(route, { method, body: method === 'GET' || method === 'DELETE' ? undefined : {} });
    assert.equal(anonymous.status, 401, `${method} ${route} must require auth, got ${anonymous.status}`);
  }
});

test('G1.2 the server boots with Cloudinary configured and never exposes the secret', async () => {
  assert.equal(config.cloudinary.configured, true, 'all three Cloudinary values must be present');
  assert.equal(cloudinaryConfig.isConfigured(), true);
  // The secret is reachable only through the config object the SDK needs.
  assert.equal(config.cloudinary.apiSecret, SECRET);
  assert.equal(uploadSignature.uploadUrl(), `https://api.cloudinary.com/v1_1/${config.cloudinary.cloudName}/image/upload`);

  // A missing secret fails fast at boot (G1.2), and a *partial* set is refused
  // rather than quietly running without uploads. Proven in a child process:
  // config validation runs at require time, so this cannot be re-run in-process.
  const result = spawnSync(process.execPath, ['-e', "require('./src/config/env')"], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLOUDINARY_CLOUD_NAME: 'only-the-cloud-name',
      CLOUDINARY_API_KEY: '',
      CLOUDINARY_API_SECRET: ''
    }
  });
  assert.notEqual(result.status, 0, 'a partial Cloudinary set must stop the process');
  assert.match(`${result.stderr}`, /CLOUDINARY_CLOUD_NAME must be set together with/, 'the message names the field, never the value');
  assert.ok(!result.stderr.includes('only-the-cloud-name'), 'the offending value is never echoed');
});

// ---------------------------------------------------------------------------
// Gate 2 — functional
// ---------------------------------------------------------------------------

test('G2.1 a signature is issued and registering the uploaded asset succeeds (commands 1-2)', async (t) => {
  if (!requireDb(t)) return;

  const sign = await api('/api/v1/photos/sign', { method: 'POST', token: accountA.token, body: {} });
  assert.equal(sign.status, 200, JSON.stringify(sign.json));
  const upload = sign.json.data.upload;

  assert.ok(upload.signature && upload.signature.length > 20, 'a real signature is returned');
  assert.equal(upload.apiKey, process.env.CLOUDINARY_API_KEY, 'the public API key is returned');
  assert.equal(upload.cloudName, process.env.CLOUDINARY_CLOUD_NAME);
  assert.equal(upload.assetType, 'upload');
  assert.ok(upload.expiresAt, 'the signature states when it stops being accepted');
  assert.deepEqual(upload.allowedFormats, config.media.photoAllowedFormats);
  assert.equal(upload.maxBytes, config.media.photoMaxBytes);
  assert.ok(!('apiSecret' in upload) && !('api_secret' in upload), 'the secret is never part of the response');

  const account = await accountWithProfile();
  const created = await addPhoto(account.token, { type: 'profile', name: 'first' });
  assert.equal(created.res.status, 201, JSON.stringify(created.res.json));
  assert.equal(created.res.json.data.photo.moderationStatus, 'pending', 'a new photo is pending');
  assert.equal(created.res.json.data.photo.isPrimary, true, 'the first profile photo becomes primary');
  assert.equal(created.res.json.data.photo.type, 'profile');
});

test('G2.2 listing returns three transformation variants and no original URL', async (t) => {
  if (!requireDb(t)) return;

  const listed = await api('/api/v1/photos', { token: accountA.token });
  assert.equal(listed.status, 200);
  assert.ok(listed.json.data.photos.length >= 1);

  const photo = listed.json.data.photos[0];
  assert.deepEqual(Object.keys(photo.variants).sort(), ['card', 'gallery', 'profile']);

  for (const variant of ['card', 'profile', 'gallery']) {
    const expected = TRANSFORMATIONS[variant];
    assert.equal(photo.variants[variant].width, expected.width, `${variant} width`);
    assert.equal(photo.variants[variant].height, expected.height, `${variant} height`);
    assert.match(photo.variants[variant].url, /\/image\/upload\/c_fill,g_face,/);
  }

  // The card variant is the small one, and it is what a card receives.
  assert.ok(photo.variants.card.width < photo.variants.profile.width, 'the card variant is smaller than the profile one');

  // No original asset address, and no asset identifier, anywhere in the body.
  assert.ok(!('url' in photo), 'the stored original URL is not returned');
  assert.ok(!('publicId' in photo), 'the public id is not returned');
  const stored = await Photo.findOne({ userId: accountA.id }).lean();
  assert.ok(!listed.text.includes(stored.url), 'the original URL never appears in the listing');
});

test('G2.3 the first profile photo is primary and there is only ever one primary (command 7)', async (t) => {
  if (!requireDb(t)) return;

  const account = await accountWithProfile();
  const first = await addPhoto(account.token, { type: 'profile', name: 'one' });
  const second = await addPhoto(account.token, { type: 'profile', name: 'two' });
  assert.equal(first.res.json.data.photo.isPrimary, true, 'the first profile photo is primary');
  assert.equal(second.res.json.data.photo.isPrimary, false, 'the second is not');

  const promoted = await api(`/api/v1/photos/${second.res.json.data.photo.id}`, {
    method: 'PATCH',
    token: account.token,
    body: { isPrimary: true }
  });
  assert.equal(promoted.status, 200, JSON.stringify(promoted.json));
  assert.equal(promoted.json.data.photo.isPrimary, true);

  const listed = await api('/api/v1/photos', { token: account.token });
  const primaries = listed.json.data.photos.filter((photo) => photo.isPrimary);
  assert.equal(primaries.length, 1, 'exactly one primary survives a promotion');
  assert.equal(primaries[0].id, second.res.json.data.photo.id, 'the promoted photo is the primary one');

  // The database enforces it too, not just the service: a second primary for the
  // same (user, type) is refused by the partial unique index.
  await assert.rejects(
    () =>
      Photo.create({
        userId: account.id,
        url: 'https://res.cloudinary.com/test-cloud/image/upload/x',
        publicId: `duplicate-primary-${Date.now()}`,
        type: 'profile',
        isPrimary: true
      }),
    (err) => err.code === 11000,
    'a second primary profile photo must violate the unique index'
  );
});

test('G2.4 reordering persists and the list reflects it (command 4)', async (t) => {
  if (!requireDb(t)) return;

  const account = await accountWithProfile();
  const one = await addPhoto(account.token, { type: 'gallery', name: 'a' });
  const two = await addPhoto(account.token, { type: 'gallery', name: 'b' });
  const three = await addPhoto(account.token, { type: 'gallery', name: 'c' });

  const ids = [one, two, three].map((photo) => photo.res.json.data.photo.id);
  const reversed = [ids[2], ids[0], ids[1]];

  const reordered = await api('/api/v1/photos', { method: 'PATCH', token: account.token, body: { order: reversed } });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.json));

  const listed = await api('/api/v1/photos', { token: account.token });
  const gallery = listed.json.data.photos.filter((photo) => photo.type === 'gallery').map((photo) => photo.id);
  assert.deepEqual(gallery, reversed, 'the stored order matches the submitted order');

  // The service and the API agree about the ordering.
  const serviceOrder = (await photoService.listOwn(account.id)).filter((photo) => photo.type === 'gallery');
  assert.deepEqual(serviceOrder.map((photo) => photo.id), reversed);

  // A foreign id in the order is a 404, never a silent partial write.
  const foreign = await api('/api/v1/photos', {
    method: 'PATCH',
    token: account.token,
    body: { order: [ids[0], String(accountB.id)] }
  });
  assert.equal(foreign.status, 404, 'an order naming an id you do not own is refused');
});

test('G2.5 deleting a photo destroys the asset and then the reference', async (t) => {
  if (!requireDb(t)) return;

  const account = await accountWithProfile();
  const added = await addPhoto(account.token, { type: 'gallery', name: 'gone' });
  const { id } = added.res.json.data.photo;

  fakeCloudinary.reset();
  const removed = await api(`/api/v1/photos/${id}`, { method: 'DELETE', token: account.token });
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.deepEqual(
    fakeCloudinary.calls.destroy.map((call) => call.publicId),
    [added.publicId],
    'the exact asset was destroyed'
  );
  assert.equal(await Photo.countDocuments({ _id: id }), 0, 'the reference is gone');
});

test('G2.6 a failed asset deletion keeps the reference and answers retryably (503)', async (t) => {
  if (!requireDb(t)) return;

  const account = await accountWithProfile();
  const added = await addPhoto(account.token, { type: 'gallery', name: 'stuck' });
  const { id } = added.res.json.data.photo;

  // A transport failure: the asset may still exist, so the row must survive or
  // the file becomes an orphan nobody can address.
  fakeCloudinary.install({ destroyThrows: Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }) });
  const failed = await api(`/api/v1/photos/${id}`, { method: 'DELETE', token: account.token });
  assert.equal(failed.status, 503, `a transport failure is retryable: ${JSON.stringify(failed.json)}`);
  assert.equal(failed.json.code, 'SERVICE_UNAVAILABLE');
  assert.equal(await Photo.countDocuments({ _id: id }), 1, 'the reference survives a failed destroy');

  // Cloudinary reporting a non-ok outcome is also retryable.
  fakeCloudinary.install({ destroyResult: 'rate limited' });
  const rejected = await api(`/api/v1/photos/${id}`, { method: 'DELETE', token: account.token });
  assert.equal(rejected.status, 503);
  assert.equal(await Photo.countDocuments({ _id: id }), 1, 'still recoverable');

  // And a retry after the provider recovers succeeds — no orphan is left behind.
  fakeCloudinary.install({ destroyResult: 'ok' });
  const retried = await api(`/api/v1/photos/${id}`, { method: 'DELETE', token: account.token });
  assert.equal(retried.status, 200);
  assert.equal(await Photo.countDocuments({ _id: id }), 0);

  // "Already gone" is success: the row is removed so nothing is orphaned.
  const twice = await addPhoto(account.token, { type: 'gallery', name: 'already-gone' });
  fakeCloudinary.install({ destroyResult: 'not found' });
  const gone = await api(`/api/v1/photos/${twice.res.json.data.photo.id}`, { method: 'DELETE', token: account.token });
  assert.equal(gone.status, 200, 'a missing asset still clears the reference');
});

test('G2.7 the photo count limit is enforced with a clear message (command 5)', async (t) => {
  if (!requireDb(t)) return;

  const account = await accountWithProfile();
  for (let index = 0; index < CAP; index += 1) {
    const added = await addPhoto(account.token, { type: 'gallery', name: `cap-${index}` });
    assert.equal(added.res.status, 201, `photo ${index + 1} of ${CAP} should be accepted`);
  }

  const overflow = await addPhoto(account.token, { type: 'gallery', name: 'cap-overflow' });
  assert.equal(overflow.res.status, 409, JSON.stringify(overflow.res.json));
  assert.match(overflow.res.json.message, new RegExp(`${CAP} photos`), 'the message states the limit');
  assert.equal(await Photo.countDocuments({ userId: account.id }), CAP, 'no row was written past the cap');
});

test('G2.8 new photos are pending and only approved ones are discovery-eligible', async (t) => {
  if (!requireDb(t)) return;

  const account = await accountWithProfile();
  const added = await addPhoto(account.token, { type: 'profile', name: 'moderated' });
  const { id } = added.res.json.data.photo;

  assert.equal((await Photo.findById(id).lean()).moderationStatus, MODERATION_STATUSES[0]);
  assert.equal(await photoService.primaryCard(account.id), null, 'a pending photo is not discovery-eligible');

  // Step 16 owns the moderation route; the state change is made directly here.
  await Photo.updateOne({ _id: id }, { $set: { moderationStatus: 'approved' } });
  const card = await photoService.primaryCard(account.id);
  assert.ok(card, 'an approved primary photo is eligible');
  assert.equal(card.width, TRANSFORMATIONS.card.width, 'and it is the small card transform');
  assert.match(card.url, /c_fill,g_face,h_200,w_200/);

  await Photo.updateOne({ _id: id }, { $set: { moderationStatus: 'rejected' } });
  assert.equal(await photoService.primaryCard(account.id), null, 'a rejected photo is not eligible');
});

// ---------------------------------------------------------------------------
// Gate 3 — security
// ---------------------------------------------------------------------------

test('G3.1 no response or log line carries the Cloudinary secret (spec §43, §78)', async (t) => {
  if (!requireDb(t)) return;

  const bodies = [];
  const sign = await api('/api/v1/photos/sign', { method: 'POST', token: accountA.token, body: {} });
  bodies.push(sign.text);
  const listed = await api('/api/v1/photos', { token: accountA.token });
  bodies.push(listed.text);
  const profile = await api('/api/v1/profile/me', { token: accountA.token });
  bodies.push(profile.text);
  const failed = await api('/api/v1/photos', { method: 'POST', token: accountA.token, body: { publicId: 'nope/nope' } });
  bodies.push(failed.text);

  for (const body of bodies) {
    assert.ok(!body.includes(SECRET), 'the API secret must never appear in a response');
  }
  // The signature proves knowledge of the secret without disclosing it.
  assert.ok(sign.json.data.upload.signature.length > 20);
});

test('G3.2 another account\'s photo cannot be read, updated, reordered or deleted (command 4)', async (t) => {
  if (!requireDb(t)) return;

  const owner = await accountWithProfile();
  const added = await addPhoto(owner.token, { type: 'gallery', name: 'mine' });
  const { id } = added.res.json.data.photo;

  const patch = await api(`/api/v1/photos/${id}`, { method: 'PATCH', token: accountB.token, body: { visibility: 'public' } });
  assert.equal(patch.status, 404, 'not 403: existence is not confirmed');

  const del = await api(`/api/v1/photos/${id}`, { method: 'DELETE', token: accountB.token });
  assert.equal(del.status, 404);

  const reorder = await api('/api/v1/photos', { method: 'PATCH', token: accountB.token, body: { order: [id] } });
  assert.equal(reorder.status, 404);

  // The attacker's own listing never shows it, and the row is untouched.
  const listed = await api('/api/v1/photos', { token: accountB.token });
  assert.equal(listed.json.data.photos.length, 0);
  const stored = await Photo.findById(id).lean();
  assert.ok(stored, 'the photo still exists');
  assert.notEqual(stored.visibility, 'public');
});

test('G3.3 an asset outside the caller\'s own folder is refused (command 6)', async (t) => {
  if (!requireDb(t)) return;

  const account = await accountWithProfile();
  const own = await signedFolder(account.token);
  const otherUserFolder = own.folder.replace(/\/users\/.*$/, '/users/000000000000000000000000');

  const foreign = await api('/api/v1/photos', {
    method: 'POST',
    token: account.token,
    body: { publicId: `${otherUserFolder}/stolen`, type: 'profile' }
  });
  assert.equal(foreign.status, 400, JSON.stringify(foreign.json));
  assert.ok(foreign.json.details.publicId, 'the field-level reason is returned');

  // The folder reported by the provider is checked too, so a publicId that
  // merely *looks* right cannot pass (defence in depth).
  fakeCloudinary.install({ folderOverride: 'somebody-else/users/x' });
  const providerSaysOther = await api('/api/v1/photos', {
    method: 'POST',
    token: account.token,
    body: { publicId: `${own.folder}/provider-mismatch`, type: 'profile' }
  });
  assert.equal(providerSaysOther.status, 400, 'the provider folder must match the signed one');
  assert.equal(await Photo.countDocuments({ userId: account.id }), 0, 'nothing was stored');

  // An asset Cloudinary does not have is refused as well.
  fakeCloudinary.install({ exists: false });
  const missing = await api('/api/v1/photos', {
    method: 'POST',
    token: account.token,
    body: { publicId: `${own.folder}/never-uploaded`, type: 'profile' }
  });
  assert.equal(missing.status, 400);
  assert.equal(await Photo.countDocuments({ userId: account.id }), 0);
});

test('G3.4 an oversized or disallowed upload is refused on content, not extension', async (t) => {
  if (!requireDb(t)) return;

  const account = await accountWithProfile();
  const folder = (await signedFolder(account.token)).folder;

  // Content type is what counts: the publicId's suffix is irrelevant.
  fakeCloudinary.install({ format: 'svg' });
  const disallowed = await api('/api/v1/photos', {
    method: 'POST',
    token: account.token,
    body: { publicId: `${folder}/looks-like-a.jpg`, type: 'profile' }
  });
  assert.equal(disallowed.status, 400, 'a format outside the allowlist is refused');
  assert.ok(disallowed.json.details.file, 'the reason names the file constraint');

  fakeCloudinary.install({ bytes: config.media.photoMaxBytes + 1 });
  const oversized = await api('/api/v1/photos', {
    method: 'POST',
    token: account.token,
    body: { publicId: `${folder}/huge`, type: 'profile' }
  });
  assert.equal(oversized.status, 400, 'an oversized asset is refused');

  // The format allowlist is also signed, so Cloudinary rejects it at the CDN.
  const upload = await signedFolder(account.token);
  assert.deepEqual(upload.allowedFormats, config.media.photoAllowedFormats);
  assert.ok(SAFE_IMAGE_FORMATS.includes('jpg') && !SAFE_IMAGE_FORMATS.includes('svg'), 'svg is not servable');
  assert.equal(await Photo.countDocuments({ userId: account.id }), 0, 'nothing was stored');
});

test('G3.5 a signature is scoped, short-lived and genuinely Cloudinary\'s', async (t) => {
  if (!requireDb(t)) return;

  const account = await accountWithProfile();
  const upload = await signedFolder(account.token);

  // Per-user folder: two accounts can never share one.
  assert.match(upload.folder, /^chandravanshi-vivah-test\/users\/[0-9a-f]{24}$/);
  const other = await signedFolder(accountB.token);
  assert.notEqual(upload.folder, other.folder);
  // The folder segment is a keyed digest, never the account id: a delivery URL
  // carries the public id, and therefore the folder, so `users/<accountId>`
  // would publish the internal account identifier on every card (step 09 G3.4).
  assert.ok(!upload.folder.includes(String(account.id)), 'the folder must not disclose the account id');
  assert.equal(uploadSignature.folderToken(account.id), uploadSignature.folderToken(account.id), 'the token is stable');
  assert.notEqual(uploadSignature.folderToken(account.id), uploadSignature.folderToken(accountB.id));

  // The signature genuinely covers the folder and the format allowlist: cloudinary's
  // own signing routine reproduces it from the public parameters.
  const { cloudinary } = cloudinaryConfig;
  const recomputed = cloudinary.utils.api_sign_request(
    {
      timestamp: upload.timestamp,
      folder: upload.folder,
      allowed_formats: upload.allowedFormats.join(','),
      type: 'upload'
    },
    SECRET
  );
  assert.equal(recomputed, upload.signature, 'the signature must be a real Cloudinary signature');

  // A different secret does not reproduce it, so the signature is bound to ours.
  assert.notEqual(
    cloudinary.utils.api_sign_request(
      { timestamp: upload.timestamp, folder: upload.folder, allowed_formats: upload.allowedFormats.join(','), type: 'upload' },
      'a-different-secret'
    ),
    upload.signature
  );

  // Short-lived, and never longer than Cloudinary itself honours a timestamp.
  const expiresIn = Math.round((new Date(upload.expiresAt).getTime() - upload.timestamp * 1000) / 1000);
  assert.equal(expiresIn, config.media.photoSignTtlSeconds);
  assert.ok(config.media.photoSignTtlSeconds <= 3600, "the TTL never exceeds Cloudinary's one-hour window");

  // A prefix that merely starts with a valid looking segment is still refused.
  const sneaky = `${upload.folder}-evil/asset`;
  assert.equal(uploadSignature.isInsideFolder(sneaky, upload.folder), false, 'the folder check is slash-anchored');
});

test('G3.6 private and matches_only photos are absent for a non-relationship viewer', async (t) => {
  if (!requireDb(t)) return;

  const owner = await accountWithProfile();
  await addPhoto(owner.token, { type: 'profile', name: 'visible' });
  const privatePhoto = await addPhoto(owner.token, { type: 'gallery', name: 'private' });
  const matchPhoto = await addPhoto(owner.token, { type: 'gallery', name: 'matches' });

  await api(`/api/v1/photos/${privatePhoto.res.json.data.photo.id}`, {
    method: 'PATCH',
    token: owner.token,
    body: { visibility: 'private' }
  });
  await api(`/api/v1/photos/${matchPhoto.res.json.data.photo.id}`, {
    method: 'PATCH',
    token: owner.token,
    body: { visibility: 'matches_only' }
  });
  // Moderation would hide them anyway; the test is about visibility, so approve.
  await Photo.updateMany({ userId: owner.id }, { $set: { moderationStatus: 'approved' } });

  const published = await api('/api/v1/profile', { method: 'PATCH', token: owner.token, body: { status: 'active' } });
  assert.equal(published.status, 200, JSON.stringify(published.json));

  const seen = await api(`/api/v1/profile/${published.json.data.profile.publicProfileId}`, { token: accountB.token });
  assert.equal(seen.status, 200);
  assert.equal(seen.json.data.profile.photos.length, 1, 'only the visible photo is exposed');
  assert.equal(seen.json.data.profile.photos[0].visibility, 'registered_users');

  // Neither hidden photo's row is reachable: no id, no asset reference, and no
  // private/matches-only visibility value anywhere in the payload.
  const hiddenIds = [privatePhoto.res.json.data.photo.id, matchPhoto.res.json.data.photo.id];
  for (const id of hiddenIds) assert.ok(!seen.text.includes(id), `photo ${id} must not be exposed`);
  assert.ok(!seen.text.includes(privatePhoto.publicId) && !seen.text.includes(matchPhoto.publicId));
  assert.ok(!seen.text.includes('matches_only'), 'no matches-only photo is exposed to a stranger');

  // The owner still sees all three on their own surface.
  const own = await api('/api/v1/photos', { token: owner.token });
  assert.equal(own.json.data.photos.length, 3);
});

test('G3.7 unauthenticated requests are rejected with 401 (command 8)', async (t) => {
  if (!requireDb(t)) return;
  const anon = await api('/api/v1/photos');
  assert.equal(anon.status, 401);
  assert.equal(anon.json.code, 'AUTHENTICATION_REQUIRED');
});

test('G3.8 a Kundli document is owner-only and never in discovery output', async (t) => {
  if (!requireDb(t)) return;

  const owner = await accountWithProfile();
  const sign = await api('/api/v1/kundli', { method: 'GET', token: owner.token });
  assert.equal(sign.status, 200);
  assert.equal(sign.json.data.kundli, null, 'no document yet is null, not an error');

  // The Kundli signature uploads to its own folder as an authenticated asset.
  const upload = await api('/api/v1/photos/sign', { method: 'POST', token: owner.token, body: {} });
  const kundliUpload = {
    folder: upload.json.data.upload.folder.replace('/users/', '/kundli/'),
    assetType: KUNDLI_ASSET_TYPE
  };
  assert.match(kundliUpload.folder, /\/kundli\//);

  photoSeq += 1;
  const publicId = `${kundliUpload.folder}/kundli-${photoSeq}`;
  const created = await api('/api/v1/kundli', { method: 'POST', token: owner.token, body: { publicId } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.data.kundli.visibility, 'private', 'private by default');
  assert.equal(created.json.data.kundli.moderationStatus, 'pending');
  assert.ok(created.json.data.kundli.documentUrl, 'a short-lived signed URL is issued to the owner');
  assert.ok(!created.json.data.kundli.publicId, 'the asset reference stays server-side');

  const kundliId = created.json.data.kundli.id;

  // Another account cannot read, change or delete it.
  const foreignRead = await api('/api/v1/kundli', { token: accountB.token });
  assert.equal(foreignRead.json.data.kundli, null, 'another account sees its own (absent) document');
  const foreignPatch = await api(`/api/v1/kundli/${kundliId}`, { method: 'PATCH', token: accountB.token, body: { visibility: 'matches_only' } });
  assert.equal(foreignPatch.status, 404);
  const foreignDelete = await api(`/api/v1/kundli/${kundliId}`, { method: 'DELETE', token: accountB.token });
  assert.equal(foreignDelete.status, 404);
  assert.equal(await KundliDocument.countDocuments({ userId: owner.id }), 1, 'the document survives');

  // Publishing and viewing the profile exposes no Kundli reference at all.
  await addPhoto(owner.token, { type: 'profile', name: 'for-publish' });
  const published = await api('/api/v1/profile', { method: 'PATCH', token: owner.token, body: { status: 'active' } });
  assert.equal(published.status, 200, JSON.stringify(published.json));
  const seen = await api(`/api/v1/profile/${published.json.data.profile.publicProfileId}`, { token: accountB.token });
  assert.ok(!seen.text.includes(publicId), "no Kundli asset reference in another user's profile DTO");
  assert.ok(!('kundli' in seen.json.data.profile) && !('kundliDocument' in seen.json.data.profile));
  assert.ok(!seen.text.includes('kundli'), 'discovery output never mentions a Kundli');
});

// ---------------------------------------------------------------------------
// Gate 4 — performance & data
// ---------------------------------------------------------------------------

test('G4.1 loading a user\'s photos is index-backed and projected', async (t) => {
  if (!requireDb(t)) return;

  const account = await accountWithProfile();
  await addPhoto(account.token, { type: 'gallery', name: 'index-backed' });

  const explanation = await Photo.find({ userId: account.id }).explain('executionStats');
  const plan = JSON.stringify(explanation.queryPlanner.winningPlan);
  assert.match(plan, /IXSCAN/, 'the userId index must serve this lookup');
  assert.doesNotMatch(plan, /COLLSCAN/);

  const primaryLookup = JSON.stringify(
    (await Photo.find({ userId: account.id, isPrimary: true }).explain('executionStats')).queryPlanner.winningPlan
  );
  assert.match(primaryLookup, /IXSCAN/, 'the primary lookup is index-backed too');
});

test('G4.2 card payloads stay small (spec §18)', async (t) => {
  if (!requireDb(t)) return;

  const card = TRANSFORMATIONS.card;
  assert.ok(card.width <= 400 && card.height <= 400, 'a card is small by construction');
  assert.equal(card.crop, 'fill');
  assert.equal(card.gravity, 'face');

  const variants = variantsFor('chandravanshi-vivah-test/users/x/photo');
  for (const variant of ['card', 'profile', 'gallery']) {
    assert.ok(variants[variant].url.includes(`h_${TRANSFORMATIONS[variant].height},w_${TRANSFORMATIONS[variant].width}`));
  }
  assert.ok(!variants.card.url.includes('h_600'), 'the card URL never requests the profile size');

  // The discovery card carries one small URL and nothing else about photos.
  const { discoveryCard } = require('../src/services/profileSerializer');
  const serialized = discoveryCard(
    { publicProfileId: 'CHV-ABCDE', basic: { firstName: 'A' }, profile: {} },
    { primaryPhoto: variants.card }
  );
  assert.equal(serialized.primaryPhoto.url, variants.card.url);
  assert.equal(serialized.primaryPhoto.width, card.width);
});

test('G4.3 publicId is unique and a failed delete cannot orphan a reference', async (t) => {
  if (!requireDb(t)) return;

  const account = await accountWithProfile();
  const added = await addPhoto(account.token, { type: 'gallery', name: 'unique' });

  const duplicate = await api('/api/v1/photos', {
    method: 'POST',
    token: account.token,
    body: { publicId: added.publicId, type: 'gallery' }
  });
  assert.equal(duplicate.status, 409, 'the same asset cannot be registered twice');

  const indexes = await Photo.collection.indexes();
  const publicIdIndex = indexes.find((index) => index.key && index.key.publicId === 1);
  assert.ok(publicIdIndex, 'the publicId index exists');
  assert.equal(publicIdIndex.unique, true, 'and it is unique');

  const partial = indexes.find((index) => index.name === 'userId_type_primary_unique');
  assert.ok(partial, 'the single-primary index exists');
  assert.ok(partial.unique === true && partial.partialFilterExpression, 'and it is a partial unique index');

  // Every reference addresses an asset that is still reachable: the delete path
  // either removes both or neither (covered by G2.6).
  assert.equal(await Photo.countDocuments({ userId: account.id }), 1);
});

// ---------------------------------------------------------------------------
// Gate 5 — spec conformance
// ---------------------------------------------------------------------------

test('G5.1 §17 — the photo document matches the documented fields and states', () => {
  const paths = Object.keys(Photo.schema.paths);
  for (const field of ['userId', 'url', 'publicId', 'type', 'isPrimary', 'sortOrder', 'visibility', 'moderationStatus', 'createdAt', 'updatedAt']) {
    assert.ok(paths.includes(field), `the schema must expose ${field}`);
  }
  assert.deepEqual(Photo.schema.path('type').enumValues, PHOTO_TYPES);
  assert.deepEqual(Photo.schema.path('visibility').enumValues, PHOTO_VISIBILITY);
  assert.deepEqual(Photo.schema.path('moderationStatus').enumValues, MODERATION_STATUSES);
  assert.equal(config.media.photoMaxCount, CAP);
});

test('G5.2 §18 — three transformation sizes, and the card is never an original', () => {
  const variants = variantsFor('a/b/c');
  assert.ok(variants.card.width < variants.gallery.width);
  assert.ok(variants.gallery.width < variants.profile.width);
  assert.ok(variants.card.url.startsWith('https://res.cloudinary.com/'));
  assert.ok(variants.card.url.includes('f_auto'), 'the format is negotiated by the CDN');
  assert.ok(variants.card.url.includes('q_auto'), 'quality is negotiated by the CDN');
  assert.ok(!variants.card.url.includes('original'), 'no original variant exists to request');
});

test('G5.3 §43 — authorization, validation, caps and ownership are all enforced', async (t) => {
  if (!requireDb(t)) return;
  // Signing requires a configured, authenticated caller (G1.1) and a secret on
  // the server (G3.1); registration re-checks existence, folder, format and size
  // (G3.3, G3.4); the cap is enforced before any write (G2.7); ownership is a
  // filter on every mutation (G3.2). This test pins the *shape* of the flow.
  const account = await accountWithProfile();
  const upload = await signedFolder(account.token);
  assert.ok(upload.signature);
  assert.equal(upload.assetType, 'upload');
  assert.ok(!JSON.stringify(upload).includes(SECRET));
});

test('G5.4 §44 — every mutation is object-scoped', async (t) => {
  if (!requireDb(t)) return;

  const owner = await accountWithProfile();
  const added = await addPhoto(owner.token, { type: 'gallery', name: 'scoped' });
  const { id } = added.res.json.data.photo;

  // A well-formed but foreign id is a 404 on all three mutation verbs.
  const target = String(owner.id);
  for (const [method, route, body] of [
    ['PATCH', `/api/v1/photos/${id}`, { isPrimary: true }],
    ['DELETE', `/api/v1/photos/${id}`, undefined],
    ['PATCH', `/api/v1/photos/${target}`, { isPrimary: true }]
  ]) {
    const res = await api(route, { method, token: accountB.token, body });
    assert.equal(res.status, 404, `${method} ${route}`);
  }
  const still = await Photo.findById(id).lean();
  assert.ok(still && still.isPrimary === false);
});

test('G5.5 §15 — requireProfilePhoto decides whether a photo is needed to publish', async (t) => {
  if (!requireDb(t)) return;

  const blocked = await accountWithProfile();
  const early = await api('/api/v1/profile', { method: 'PATCH', token: blocked.token, body: { status: 'active' } });
  assert.equal(early.status, 409, 'a complete profile without a photo cannot publish while the setting is on');
  assert.ok(early.json.details.missing.includes('photos'), `missing must name photos: ${JSON.stringify(early.json.details)}`);

  const added = await addPhoto(blocked.token, { type: 'profile', name: 'for-activation' });
  assert.equal(added.res.json.data.photo.isPrimary, true);
  const published = await api('/api/v1/profile', { method: 'PATCH', token: blocked.token, body: { status: 'active' } });
  assert.equal(published.status, 200, 'with a primary photo it publishes');

  // The requirement is configuration, not a constant: with the platform setting
  // off, the same profile publishes without a photo.
  const configRow = await CommunityConfig.findOne({ isActive: true });
  assert.ok(configRow, 'the step-05 seeder creates the community config');
  assert.equal(configRow.settings.requireProfilePhoto, true, 'the seeded default');
  await CommunityConfig.updateOne({ _id: configRow._id }, { $set: { 'settings.requireProfilePhoto': false } });

  try {
    const noPhoto = await accountWithProfile();
    const allowed = await api('/api/v1/profile', { method: 'PATCH', token: noPhoto.token, body: { status: 'active' } });
    assert.equal(allowed.status, 200, 'with the requirement off, no photo is needed');
  } finally {
    await CommunityConfig.updateOne({ _id: configRow._id }, { $set: { 'settings.requireProfilePhoto': true } });
  }
});

test('G5.6 §105 — the photos index checklist is present', async (t) => {
  if (!requireDb(t)) return;
  const indexes = await Photo.collection.indexes();
  const keys = indexes.map((index) => JSON.stringify(index.key));
  assert.ok(keys.includes(JSON.stringify({ userId: 1 })), 'photos.userId');
  assert.ok(keys.includes(JSON.stringify({ userId: 1, isPrimary: 1 })), 'the primary lookup');
  assert.ok(keys.includes(JSON.stringify({ userId: 1, sortOrder: 1 })), 'gallery ordering');

  const kundliIndexes = await KundliDocument.collection.indexes();
  const kundliKeys = kundliIndexes.map((index) => JSON.stringify(index.key));
  assert.ok(kundliKeys.includes(JSON.stringify({ userId: 1 })));
  assert.ok(kundliKeys.includes(JSON.stringify({ userId: 1, visibility: 1 })));
});

test('G5.7 §112 — private-photo rules on the collection itself', async (t) => {
  if (!requireDb(t)) return;

  const owner = await accountWithProfile();
  const visible = await addPhoto(owner.token, { type: 'profile', name: 'public-ish' });
  const hidden = await addPhoto(owner.token, { type: 'gallery', name: 'hidden' });
  await Photo.updateMany({ userId: owner.id }, { $set: { moderationStatus: 'approved' } });
  await api(`/api/v1/photos/${hidden.res.json.data.photo.id}`, {
    method: 'PATCH',
    token: owner.token,
    body: { visibility: 'private' }
  });

  const asStranger = await photoService.listForViewer(owner.id, { isMatch: false });
  const asMatch = await photoService.listForViewer(owner.id, { isMatch: true });
  const asOwner = await photoService.listForViewer(owner.id, { isOwner: true });

  assert.equal(asStranger.length, 1);
  assert.equal(asStranger[0].id, visible.res.json.data.photo.id);
  assert.equal(asMatch.length, 2, 'an accepted connection sees the private one too');
  assert.equal(asOwner.length, 2, 'the owner sees everything, including unapproved photos');

  // A rejected photo does not leak through a relationship either.
  await Photo.updateOne({ _id: hidden.res.json.data.photo.id }, { $set: { moderationStatus: 'rejected' } });
  assert.equal((await photoService.listForViewer(owner.id, { isMatch: true })).length, 1);
});

test('G5.8 decisions §6 — the Kundli collection is separate and its visibility is reduced', async (t) => {
  if (!requireDb(t)) return;

  assert.deepEqual(KundliDocument.schema.path('visibility').enumValues, [...KUNDLI_VISIBILITY]);
  assert.deepEqual(KUNDLI_VISIBILITY, ['private', 'matches_only']);
  assert.ok(!KUNDLI_VISIBILITY.includes('public'), 'public is not an expressible state');
  assert.equal(KundliDocument.collection.collectionName, 'kundli_documents');
  assert.ok(!PHOTO_TYPES.includes('kundli'), 'a Kundli is not a photo type');

  const owner = await accountWithProfile();
  const folder = (await signedFolder(owner.token)).folder.replace('/users/', '/kundli/');
  photoSeq += 1;
  const created = await api('/api/v1/kundli', {
    method: 'POST',
    token: owner.token,
    body: { publicId: `${folder}/c6-${photoSeq}` }
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));

  // `public` is refused as an invalid value, never silently downgraded.
  const asPublic = await api(`/api/v1/kundli/${created.json.data.kundli.id}`, {
    method: 'PATCH',
    token: owner.token,
    body: { visibility: 'public' }
  });
  assert.equal(asPublic.status, 400, 'public is not an allowed visibility');
  const asMatch = await api(`/api/v1/kundli/${created.json.data.kundli.id}`, {
    method: 'PATCH',
    token: owner.token,
    body: { visibility: 'matches_only' }
  });
  assert.equal(asMatch.status, 200);
  assert.equal(asMatch.json.data.kundli.visibility, 'matches_only');

  // One document per account.
  const second = await api('/api/v1/kundli', {
    method: 'POST',
    token: owner.token,
    body: { publicId: `${folder}/second` }
  });
  assert.equal(second.status, 409);

  // And deletion removes the authenticated asset and the reference.
  fakeCloudinary.reset();
  const removed = await api(`/api/v1/kundli/${created.json.data.kundli.id}`, { method: 'DELETE', token: owner.token });
  assert.equal(removed.status, 200, JSON.stringify(removed.json));
  assert.equal(fakeCloudinary.calls.destroy[0].type, KUNDLI_ASSET_TYPE, 'the authenticated asset was destroyed');
  assert.equal(await KundliDocument.countDocuments({ userId: owner.id }), 0);
});

test('G5.9 the photo signal feeds profile completion (§57, task 13)', async (t) => {
  if (!requireDb(t)) return;

  const account = await accountWithProfile();
  const before = (await api('/api/v1/profile/me', { token: account.token })).json.data.profile.completionPercentage;

  const added = await addPhoto(account.token, { type: 'profile', name: 'scored' });
  assert.equal(added.res.status, 201);

  const after = (await api('/api/v1/profile/me', { token: account.token })).json.data.profile.completionPercentage;
  assert.ok(after > before, `a primary photo must raise the score (${before} -> ${after})`);

  const stored = (await MatrimonialProfile.findOne({ userId: account.id }).lean()).profile.completionPercentage;
  assert.equal(stored, after, 'the stored score matches the response');

  // The scorer's own view: every enabled section filled, with a primary photo.
  assert.equal(await profileScoreService.hasPrimaryPhoto(account.id), true);
  const signals = await profileScoreService.loadSignals(account.id);
  assert.equal(signals.hasPrimaryPhoto, true);
});
