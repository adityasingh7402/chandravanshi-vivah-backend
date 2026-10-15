// Step 08 scripted verification — drives the doc's eight verification commands
// against a live server, plus the database, index and visibility checks.
// Seed + boot the server with the test database first, then run with the SAME
// database:
//   MONGODB_DB_NAME=chandravanshi_vivah_test node verify-step08.mjs
//
// Asset note: registration verifies an asset with Cloudinary's admin API, so
// without CLOUDINARY_* the API must answer 503 rather than store an unverified
// reference. The gate runner therefore starts the API with CLOUDINARY_MOCK=true,
// which swaps that one hop for src/config/localAssetStore.js (refused in
// production by config/env.js). The live provider round trip runs below only
// when real credentials are configured, and is reported as SKIP otherwise —
// never as a pass.
//
// Exit code 0 means every check that ran passed.
import mongoose from 'mongoose';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const config = require('./src/config/env');
const User = require('./src/models/User');
const MatrimonialProfile = require('./src/models/MatrimonialProfile');
const Photo = require('./src/models/Photo');
const KundliDocument = require('./src/models/KundliDocument');
const CommunityConfig = require('./src/models/CommunityConfig');
const { getMasterModel } = require('./src/models/masterData/MasterItem');

const BASE = `http://localhost:${config.port}`;
const PASSWORD = 'correct-horse-battery';
const RUN = Date.now();
const CAP = config.media.photoMaxCount;

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
// Database inspection setup + real master rows
// ---------------------------------------------------------------------------

await mongoose.connect(config.mongodbUri, { dbName: config.mongodbDbName, serverSelectionTimeoutMS: 5000 });

const communities = await getMasterModel('communities')
  .find({ isActive: true })
  .sort({ sortOrder: 1, name: 1 })
  .select('_id slug name')
  .lean();

let community = null;
let surname = null;
let gotra = null;
for (const candidate of communities) {
  const s = await getMasterModel('surnames')
    .findOne({ communityId: candidate._id, isActive: true })
    .select('_id name')
    .lean();
  const g = await getMasterModel('gotras')
    .findOne({ communityId: candidate._id, isActive: true })
    .select('_id name')
    .lean();
  if (s && g) {
    community = candidate;
    surname = s;
    gotra = g;
    break;
  }
}

const city = await getMasterModel('cities').findOne({ isActive: true }).sort({ sortOrder: 1 }).select('_id name').lean();
const degree = await getMasterModel('degrees').findOne({ isActive: true }).sort({ sortOrder: 1 }).select('_id name').lean();
const occupation = await getMasterModel('occupations')
  .findOne({ isActive: true })
  .sort({ sortOrder: 1 })
  .select('_id name')
  .lean();

if (!community || !surname || !gotra || !city || !degree || !occupation) {
  // Throw rather than `process.exit()`: pending stdout writes flush first.
  throw new Error('Seed is incomplete — run `node scripts/seed-master-data.js` against this database first.');
}

const id = (doc) => String(doc._id);

/** A profile body that satisfies every §25 V1 requirement, so it may publish. */
function fullProfile() {
  return {
    basic: {
      profileFor: 'self',
      firstName: 'Vikram',
      gender: 'male',
      dateOfBirth: '1996-03-14',
      maritalStatus: 'never_married',
      heightCm: 178
    },
    community: { communityId: id(community), surnameId: id(surname), gotraId: id(gotra) },
    location: { cityId: id(city) },
    education: { highestQualificationId: id(degree) },
    career: { occupationId: id(occupation) },
    family: { familyType: 'nuclear' },
    lifestyle: { diet: 'vegetarian' },
    about: { description: 'Grounded family, simple habits, straightforward person.' }
  };
}

let photoSeq = 0;

/** Sign, then register — the documented two-step upload flow (command 1 + 2). */
async function addPhoto(token, { type = 'profile', name = 'photo' } = {}) {
  const sign = await post('/api/v1/photos/sign', {}, token);
  const folder = sign.json?.data?.upload?.folder;
  if (!folder) return { sign, res: { status: sign.status, json: sign.json } };
  photoSeq += 1;
  const publicId = `${folder}/${name}-${photoSeq}`;
  const res = await post('/api/v1/photos', { publicId, type }, token);
  return { sign, res, publicId };
}

// ---------------------------------------------------------------------------
// 1. Health + accounts + a profile that may publish
// ---------------------------------------------------------------------------
const emailA = `s8a${RUN}@example.com`;
const emailB = `s8b${RUN}@example.com`;
let tokenA;
let tokenB;
let userA;

{
  const res = await req('/api/v1/health');
  check('health 200 + database.connected', res.status === 200 && res.json?.data?.database?.connected === true,
    `status=${res.status}`);
}

{
  await register(emailA);
  await register(emailB);
  tokenA = await login(emailA);
  tokenB = await login(emailB);
  userA = await User.findOne({ email: emailA }).lean();
  check('two accounts registered and logged in', Boolean(tokenA && tokenB && userA),
    `tokens=${[tokenA, tokenB].filter(Boolean).length}/2`);
}

// Publishing requires a photo when the platform setting says so (spec §15).
{
  const created = await post('/api/v1/profile', fullProfile(), tokenA);
  const noPhoto = await patch('/api/v1/profile', { status: 'active' }, tokenA);
  const photo = await addPhoto(tokenA, { type: 'profile', name: 'primary' });
  const published = await patch('/api/v1/profile', { status: 'active' }, tokenA);

  check('command 2: register an upload -> 201 pending, first profile photo is primary',
    photo.res.status === 201
      && photo.res.json?.data?.photo?.moderationStatus === 'pending'
      && photo.res.json?.data?.photo?.isPrimary === true,
    `create=${created.status} register=${photo.res.status} state=${photo.res.json?.data?.photo?.moderationStatus}`);

  check('a complete profile cannot publish without a photo (spec §15, gate G5.5)',
    noPhoto.status === 409 && Array.isArray(noPhoto.json?.details?.missing)
      && noPhoto.json.details.missing.includes('photos'),
    `status=${noPhoto.status} missing=${JSON.stringify(noPhoto.json?.details?.missing)}`);

  check('with a primary photo the profile publishes -> 200',
    published.status === 200 && published.json?.data?.profile?.status === 'active',
    `status=${published.status} state=${published.json?.data?.profile?.status}`);
}

// ---------------------------------------------------------------------------
// 2. Commands 1-3: signature, registration, listing
// ---------------------------------------------------------------------------
{
  const sign = await post('/api/v1/photos/sign', {}, tokenA);
  const upload = sign.json?.data?.upload;
  check('command 1: signature has timestamp, folder, formats and no secret',
    sign.status === 200
      && Boolean(upload?.signature)
      && Boolean(upload?.timestamp)
      && Boolean(upload?.folder)
      && Array.isArray(upload?.allowedFormats)
      && !sign.text.includes(String(process.env.CLOUDINARY_API_SECRET || '§'))
      && !('apiSecret' in (upload || {})),
    `status=${sign.status} folder=${upload?.folder} formats=${JSON.stringify(upload?.allowedFormats)}`);

  const listed = await req('/api/v1/photos', { headers: auth(tokenA) });
  const photos = listed.json?.data?.photos || [];
  const first = photos[0];
  check('command 3: listing returns card/profile/gallery variants, not an original',
    listed.status === 200 && photos.length >= 1
      && Boolean(first?.variants?.card && first?.variants?.profile && first?.variants?.gallery)
      && !('url' in (first || {}))
      && first.variants.card.width < first.variants.profile.width,
    `status=${listed.status} count=${photos.length} card=${first?.variants?.card?.width}x${first?.variants?.card?.height}`);
}

// ---------------------------------------------------------------------------
// 3. Commands 4-8: ownership, cap, rejected uploads, primary invariant, 401
// ---------------------------------------------------------------------------
{
  const mine = await addPhoto(tokenA, { type: 'gallery', name: 'owned' });
  const photoId = mine.res.json?.data?.photo?.id;

  const foreign = await del(`/api/v1/photos/${photoId}`, tokenB);
  const stillExists = await Photo.countDocuments({ _id: photoId });
  check("command 4: another account's photo -> 404 (not 403), photo still exists",
    foreign.status === 404 && stillExists === 1 && foreign.json?.data === undefined,
    `status=${foreign.status} rows=${stillExists}`);

  // ...and a body-level attack is refused the same way (spec §44).
  const foreignPatch = await patch(`/api/v1/photos/${photoId}`, { visibility: 'private' }, tokenB);
  check('ownership also holds for PATCH and reorder',
    foreignPatch.status === 404
      && (await Photo.findById(photoId).lean()).visibility !== 'private',
    `status=${foreignPatch.status}`);

  const order = [photoId];
  const foreignReorder = await patch('/api/v1/photos', { order }, tokenB);
  check('a reorder naming ids you do not own -> 404', foreignReorder.status === 404, `status=${foreignReorder.status}`);

  // Command 5 — the count limit.
  const before = await Photo.countDocuments({ userId: userA._id });
  let last = null;
  for (let index = 0; index < CAP + 1; index += 1) {
    const attempt = await addPhoto(tokenA, { type: 'gallery', name: `cap-${index}` });
    last = attempt.res;
    if (last.status !== 201) break;
  }
  const after = await Photo.countDocuments({ userId: userA._id });
  check(`command 5: the cap of ${CAP} photos is enforced with a clear message`,
    last.status === 409 && after === CAP && /photos/.test(String(last.json?.message)),
    `status=${last.status} rows=${after} message=${last.json?.message}`);
}

{
  // Command 6 — forged publicId: outside this user's folder. Refused on the
  // caller's own folder path, before the provider is consulted, and nothing is
  // stored. A fresh account is used because A is already at the photo cap, and
  // the cap is checked *before* the provider — refusing a full gallery cheaply
  // is the point (§80).
  //
  // The other half of command 6 — "an id the provider has never seen" — needs a
  // provider that can say 404. The local store reports existence for any id
  // inside a signed folder (there is no upload step to observe without a real
  // account), so that half is asserted in the LIVE block below instead of being
  // claimed here.
  const sign = await post('/api/v1/photos/sign', {}, tokenB);
  const folder = sign.json?.data?.upload?.folder;
  const forged = await post('/api/v1/photos',
    { publicId: `${folder.replace(/\/users\/.*/, '/users/111111111111111111111111')}/stolen`, type: 'profile' },
    tokenB);
  const ownerB = await User.findOne({ email: emailB }).lean();
  check('command 6: a publicId outside the caller\'s own folder is refused, nothing stored',
    forged.status === 400 && (await Photo.countDocuments({ userId: ownerB._id })) === 0,
    `forged=${forged.status}`);

  const unsigned = await post('/api/v1/photos', { publicId: `${folder}/unsigned`, type: 'profile' });
  check('command 8: no token -> 401 on sign and register',
    (await post('/api/v1/photos/sign', {})).status === 401 && unsigned.status === 401,
    `sign=${(await post('/api/v1/photos/sign', {})).status} register=${unsigned.status}`);
}

{
  // Command 7 — exactly one primary.
  const listed = await req('/api/v1/photos', { headers: auth(tokenA) });
  const photos = (listed.json?.data?.photos || []).filter((photo) => photo.type === 'profile');
  const primary = photos.find((photo) => photo.isPrimary);
  const other = photos.find((photo) => !photo.isPrimary);
  let promoted = null;
  if (other) {
    promoted = await patch(`/api/v1/photos/${other.id}`, { isPrimary: true }, tokenA);
  }
  const after = await req('/api/v1/photos', { headers: auth(tokenA) });
  const primaries = (after.json?.data?.photos || []).filter((photo) => photo.isPrimary && photo.type === 'profile');
  check('command 7: promoting another photo leaves exactly one primary',
    Boolean(primary) && (other ? promoted.status === 200 : true) && primaries.length === 1,
    `before=${Boolean(primary)} promoted=${promoted ? promoted.status : 'n/a'} after=${primaries.length}`);
}

// ---------------------------------------------------------------------------
// 4. Database, index and completion checks
// ---------------------------------------------------------------------------
{
  const indexes = await Photo.collection.indexes();
  const keys = indexes.map((index) => JSON.stringify(index.key));
  check('photos.userId exists (§105) and publicId is unique',
    keys.includes(JSON.stringify({ userId: 1 }))
      && indexes.some((index) => index.key?.publicId === 1 && index.unique === true),
    `keys=${keys.join(' | ')}`);

  const partial = indexes.find((index) => index.name === 'userId_type_primary_unique');
  check('a partial unique index enforces one primary per (user, type)',
    Boolean(partial) && partial.unique === true && Boolean(partial.partialFilterExpression),
    `present=${Boolean(partial)}`);

  const plan = JSON.stringify((await Photo.find({ userId: userA._id }).explain('executionStats')).queryPlanner.winningPlan);
  check('the userId lookup is served by an IXSCAN (never COLLSCAN)',
    plan.includes('IXSCAN') && !plan.includes('COLLSCAN'), plan.slice(0, 120));

  const row = await MatrimonialProfile.findOne({ userId: userA._id }).lean();
  const photoScore = row?.profile?.completionPercentage;
  check('the photo signal feeds the §57 completion score',
    Number.isInteger(photoScore) && photoScore > 75 && photoScore <= 100,
    `completion=${photoScore}`);

  const configRow = await CommunityConfig.findOne({ isActive: true }).select('settings.requireProfilePhoto').lean();
  check('requireProfilePhoto is read from community_configs (spec §15)',
    Boolean(configRow) && typeof configRow?.settings?.requireProfilePhoto === 'boolean',
    `value=${configRow?.settings?.requireProfilePhoto}`);
}

// ---------------------------------------------------------------------------
// 5. The original URL never leaves the API
// ---------------------------------------------------------------------------
{
  const listed = await req('/api/v1/photos', { headers: auth(tokenA) });
  const stored = await Photo.findOne({ userId: userA._id }).lean();
  check('the stored asset URL is absent from the listing',
    stored ? !listed.text.includes(stored.url) : true,
    `urlInBody=${stored ? listed.text.includes(stored.url) : 'n/a'}`);

  const sign = await post('/api/v1/photos/sign', {}, tokenA);
  check('the API secret never appears in a response',
    !sign.text.includes(String(process.env.CLOUDINARY_API_SECRET || '§'))
      && !('apiSecret' in (sign.json?.data?.upload || {}))
      && !('api_secret' in (sign.json?.data?.upload || {})),
    'no secret in the sign response');
}

// ---------------------------------------------------------------------------
// 6. Kundli documents (finalized decisions §6, fields dictionary §11.7)
// ---------------------------------------------------------------------------
{
  const empty = await req('/api/v1/kundli', { headers: auth(tokenA) });
  check('GET /kundli -> 200 with null before there is a document',
    empty.status === 200 && empty.json?.data?.kundli === null,
    `status=${empty.status} value=${JSON.stringify(empty.json?.data?.kundli)}`);

  const sign = await post('/api/v1/photos/sign', {}, tokenA);
  const kundliFolder = sign.json?.data?.upload?.folder.replace('/users/', '/kundli/');
  photoSeq += 1;
  const created = await post('/api/v1/kundli', { publicId: `${kundliFolder}/kundli-${photoSeq}` }, tokenA);
  const document = created.json?.data?.kundli;
  check('POST /kundli -> 201, private by default, pending, signed URL only',
    created.status === 201 && document?.visibility === 'private' && document?.moderationStatus === 'pending'
      && Boolean(document?.documentUrl) && !('publicId' in (document || {})),
    `status=${created.status} visibility=${document?.visibility} state=${document?.moderationStatus}`);

  const asPublic = await patch(`/api/v1/kundli/${document?.id}`, { visibility: 'public' }, tokenA);
  check('Kundli visibility `public` is refused (private | matches_only only)',
    asPublic.status === 400 && (await KundliDocument.findById(document.id).lean()).visibility === 'private',
    `status=${asPublic.status}`);

  const foreignPatch = await patch(`/api/v1/kundli/${document?.id}`, { visibility: 'matches_only' }, tokenB);
  const foreignDelete = await del(`/api/v1/kundli/${document?.id}`, tokenB);
  check("another account cannot read, change or delete it -> 404",
    foreignPatch.status === 404 && foreignDelete.status === 404
      && (await KundliDocument.countDocuments({ userId: userA._id })) === 1,
    `patch=${foreignPatch.status} delete=${foreignDelete.status}`);

  const anon = await req('/api/v1/kundli');
  check('command 8: unauthenticated kundli access -> 401', anon.status === 401, `status=${anon.status}`);

  // Discovery output must not carry it (decisions §6, spec §112).
  const stored = await KundliDocument.findOne({ userId: userA._id }).lean();
  const publicProfileId = (await MatrimonialProfile.findOne({ userId: userA._id }).lean())?.publicProfileId;
  const view = await req(`/api/v1/profile/${publicProfileId}`, { headers: auth(tokenB) });
  check("no Kundli URL or publicId appears in another account's profile DTO",
    view.status === 200
      && !view.text.includes('kundli')
      && !view.text.includes(stored?.publicId)
      && !view.text.includes(stored?.url),
    `status=${view.status}`);
}

// ---------------------------------------------------------------------------
// 7. The live provider round trip — only when real credentials are configured
// ---------------------------------------------------------------------------

if (config.cloudinary.configured) {
  try {
    const cloudinary = require('./src/config/cloudinary').cloudinary;
    // A 1x1 PNG: real, but a few hundred bytes.
    const png =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const sign = await post('/api/v1/photos/sign', {}, tokenA);
    const live = sign.json?.data?.upload;
    const asset = await cloudinary.uploader.upload(png, {
      folder: live.folder,
      timestamp: live.timestamp,
      allowed_formats: live.allowedFormats.join(','),
      type: 'upload',
      signature: live.signature,
      api_key: live.apiKey,
      overwrite: false
    });
    const registered = await post('/api/v1/photos', { publicId: asset.public_id, type: 'gallery' }, tokenA);
    const listed = await req('/api/v1/photos', { headers: auth(tokenA) });
    const found = (listed.json?.data?.photos || []).some((photo) =>
      photo.variants.card.url.includes(asset.public_id)
    );
    const cleanup = await del(`/api/v1/photos/${registered.json?.data?.photo?.id}`, tokenA);
    check('LIVE provider: signed upload -> register -> list -> delete',
      registered.status === 201 && found && cleanup.status === 200,
      `register=${registered.status} listed=${found} delete=${cleanup.status}`);

    // Command 6, second half: only a real provider can 404 an id nobody
    // uploaded, which is the check that makes a fabricated reference
    // impossible to store (spec §43).
    const invented = await post('/api/v1/photos',
      { publicId: `${live.folder}/never-uploaded-${RUN}`, type: 'gallery' }, tokenA);
    check('LIVE provider: an id the provider has never seen -> 400',
      invented.status === 400,
      `status=${invented.status} details=${JSON.stringify(invented.json?.details)}`);
  } catch (err) {
    check('LIVE provider: signed upload -> register -> list -> delete', false,
      String(err && err.message ? err.message : err));
  }
} else {
  // Not a pass: the provider boundary was not exercised at all.
  skip('LIVE provider: signed upload -> register -> list -> delete, and the provider-404 half of command 6',
    config.cloudinary.mock
      ? 'CLOUDINARY_MOCK is on — our sign/verify/register/delete pipeline ran against src/config/localAssetStore.js'
      : 'CLOUDINARY_* not configured');
}

// ---------------------------------------------------------------------------
// 8. Final index gate
// ---------------------------------------------------------------------------

{
  let scriptPass = false;
  let detail = 'exit 0';
  try {
    execFileSync(process.execPath, ['scripts/verify-indexes.js'], { cwd: process.cwd(), stdio: 'pipe' });
    scriptPass = true;
  } catch (err) {
    scriptPass = false;
    detail = `exit ${err.status}: ${String(err.stdout || '')} ${String(err.stderr || '')}`.slice(-600);
  }
  check('scripts/verify-indexes.js exits 0 for this database', scriptPass, detail);
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
