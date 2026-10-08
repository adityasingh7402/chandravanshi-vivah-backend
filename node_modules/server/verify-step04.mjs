// Step 04 scripted verification — runs the doc's verification commands against a live server.
// Boot the server first with the test database, then run:
//   MONGODB_DB_NAME=chandravanshi_vivah_test node verify-step04.mjs "C:/Users/adity/AppData/Local/Temp/step04.log"
// The optional second argument is the server log file, scanned for token leaks (gate G3.3).
import mongoose from 'mongoose';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const config = require('./src/config/env');
const jwt = require('jsonwebtoken');
const Session = require('./src/models/Session');
const tokenService = require('./src/services/tokenService');
const { COLLECTIONS } = require('./src/config/collections');

const BASE = `http://localhost:${config.port}`;
const PASSWORD = 'correct-horse-battery';
const RUN = Date.now();

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

async function req(path, { method = 'GET', body, headers = {}, ...rest } = {}) {
  // `rest` lets callers pass bearer(...) / cookie options at the top level.
  const init = { method, headers: { ...headers, ...rest } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, setCookie: res.headers.getSetCookie(), headers: res.headers };
}

const post = (path, body, headers) => req(path, { method: 'POST', body, headers });
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const cookieOf = (setCookie) => setCookie.find((c) => c.startsWith('refreshToken=')) || null;
const cookieValue = (line) => (line ? line.split(';')[0].slice('refreshToken='.length) : null);

async function register(email) {
  return post('/api/v1/auth/register', { identifierType: 'email', identifier: email, password: PASSWORD });
}

const emailA = `s4a${RUN}@example.com`;   // main web session (cookie flow)
const emailKeeper = `s4b${RUN}@example.com`; // password-change keeper
const emailOther = `s4c${RUN}@example.com`;  // password-change other device
const emailSuspend = `s4d${RUN}@example.com`; // suspension check

const seenTokens = []; // every credential we mint, scanned against the log at the end

// Direct database inspection (checks 1c, 4b, 8, 9, 11) runs against the same
// database the server uses.
await mongoose.connect(config.mongodbUri, { dbName: config.mongodbDbName, serverSelectionTimeoutMS: 5000 });

// ---------------------------------------------------------------------------
// 1. Login: access token + hardened HttpOnly refresh cookie, no token in body
// ---------------------------------------------------------------------------
let webAccessToken;
let webRefreshRaw;
{
  await register(emailA);
  const r = await post('/api/v1/auth/login',
    { identifierType: 'email', identifier: emailA, password: PASSWORD },
    { 'user-agent': 'verify-step04/1.0' });
  const line = cookieOf(r.setCookie);
  webAccessToken = r.json?.data?.accessToken;
  webRefreshRaw = cookieValue(line);
  if (webAccessToken) seenTokens.push(webAccessToken);
  if (webRefreshRaw) seenTokens.push(webRefreshRaw);

  const ok = r.status === 200
    && typeof webAccessToken === 'string'
    && r.json?.data?.refreshToken === undefined   // web: cookie only, never the body
    && line !== null
    && /HttpOnly/i.test(line)
    && line.includes(`Path=${config.apiPrefix}/auth/refresh`)
    && /SameSite=Lax/i.test(line);
  check('1 login -> 200 accessToken + HttpOnly refresh cookie (none in body)', ok,
    `status=${r.status} cookie=${line ? line.replace(webRefreshRaw ?? '', '<token>') : 'MISSING'} inBody=${r.json?.data?.refreshToken !== undefined}`);

  // Production-only Secure flag is driven by config, not by luck of the env.
  check('1b cookie Secure flag tracks NODE_ENV (Secure iff production)',
    config.cookie.secure === config.isProduction,
    `secure=${config.cookie.secure} isProduction=${config.isProduction}`);
}

// 1c. DB: exactly one session, stored only as a sha256 hash
let sessionDoc;
{
  const user = await mongoose.connection.db.collection(COLLECTIONS.USERS).findOne({ email: emailA });
  const sessions = await mongoose.connection.db.collection(COLLECTIONS.SESSIONS).find({ userId: user._id }).toArray();
  sessionDoc = sessions[0];
  const hashOnly = sessions.length === 1
    && /^[a-f0-9]{64}$/.test(sessionDoc.refreshTokenHash)
    && sessionDoc.refreshTokenHash === tokenService.hashRefreshToken(webRefreshRaw)
    && !JSON.stringify(sessionDoc).includes(webRefreshRaw)
    && sessionDoc.deviceType === 'web'
    && sessionDoc.deviceName === 'verify-step04/1.0'
    && sessionDoc.revokedAt === null
    && sessionDoc.expiresAt instanceof Date;
  check('1c DB: one session row, sha256 hash only, raw token never stored', hashOnly,
    `rows=${sessions.length} hashPrefix=${sessionDoc.refreshTokenHash?.slice(0, 12)} device=${sessionDoc.deviceType}`);
}

// ---------------------------------------------------------------------------
// 2. Protected route without a token -> 401
// ---------------------------------------------------------------------------
{
  const r = await req('/api/v1/auth/me');
  check('2 /me no token -> 401 AUTHENTICATION_REQUIRED',
    r.status === 401 && r.json?.code === 'AUTHENTICATION_REQUIRED',
    `status=${r.status} code=${r.json?.code}`);
}

// ---------------------------------------------------------------------------
// 3. Protected route with a token -> own summary only
// ---------------------------------------------------------------------------
{
  const r = await req('/api/v1/auth/me', bearer(webAccessToken));
  const u = r.json?.data?.user;
  const ok = r.status === 200
    && u?.email === emailA
    && u?.role === 'user'
    && u?.status === 'active'
    && u?.profileCreated === false
    && u?.onboardingCompleted === false
    && !/passwordHash|refreshTokenHash|\$argon2/.test(r.text);
  check('3 /me with token -> 200 own summary, no hash/internal fields', ok,
    `status=${r.status} email=${u?.email} role=${u?.role}`);
}

// ---------------------------------------------------------------------------
// 4. Tampered token -> 401 TOKEN_INVALID
// ---------------------------------------------------------------------------
{
  const r = await req('/api/v1/auth/me', bearer(`${webAccessToken}x`));
  check('4 tampered token -> 401 TOKEN_INVALID',
    r.status === 401 && r.json?.code === 'TOKEN_INVALID',
    `status=${r.status} code=${r.json?.code}`);
}

// ---------------------------------------------------------------------------
// 4b. Expired vs invalid are distinguishable (gate G2.7)
// ---------------------------------------------------------------------------
{
  const user = await mongoose.connection.db.collection(COLLECTIONS.USERS).findOne({ email: emailA });
  const expired = jwt.sign(
    { sub: String(user._id), role: 'user', sid: String(sessionDoc._id) },
    config.jwt.secret,
    { algorithm: 'HS256', expiresIn: -10, issuer: config.jwt.issuer, audience: config.jwt.audience }
  );
  const e = await req('/api/v1/auth/me', bearer(expired));
  const i = await req('/api/v1/auth/me', bearer('not-a-jwt'));
  seenTokens.push(expired);
  check('4b expired -> TOKEN_EXPIRED, invalid -> TOKEN_INVALID (distinguishable)',
    e.status === 401 && e.json?.code === 'TOKEN_EXPIRED'
    && i.status === 401 && i.json?.code === 'TOKEN_INVALID',
    `expired=${e.status}:${e.json?.code} invalid=${i.status}:${i.json?.code}`);
}

// ---------------------------------------------------------------------------
// 5. Refresh rotation: new access token, old refresh token rejected
// ---------------------------------------------------------------------------
let rotatedAccessToken;
{
  const r1 = await post('/api/v1/auth/refresh', {}, { cookie: `refreshToken=${webRefreshRaw}` });
  const newLine = cookieOf(r1.setCookie);
  const newRaw = cookieValue(newLine);
  if (r1.json?.data?.accessToken) seenTokens.push(r1.json.data.accessToken);
  if (newRaw) seenTokens.push(newRaw);
  rotatedAccessToken = r1.json?.data?.accessToken;

  check('5a refresh (cookie) -> 200 new access token + new cookie, body token withheld',
    r1.status === 200 && typeof rotatedAccessToken === 'string'
    && r1.json?.data?.refreshToken === undefined && newRaw && newRaw !== webRefreshRaw,
    `status=${r1.status} rotated=${newRaw && newRaw !== webRefreshRaw} inBody=${r1.json?.data?.refreshToken !== undefined}`);

  // Old token now points at a revoked row.
  const replay = await post('/api/v1/auth/refresh', {}, { cookie: `refreshToken=${webRefreshRaw}` });
  check('5b replay of rotated token -> 401 (reuse rejected)',
    replay.status === 401 && ['SESSION_REVOKED', 'REFRESH_TOKEN_INVALID'].includes(replay.json?.code),
    `status=${replay.status} code=${replay.json?.code}`);

  // The rotated access token works on a protected route.
  const me = await req('/api/v1/auth/me', bearer(rotatedAccessToken));
  check('5c access token from refresh -> /me 200', me.status === 200, `status=${me.status}`);

  // Keep the new cookie for the logout step below.
  webRefreshRaw = newRaw;
  webAccessToken = rotatedAccessToken;
}

// ---------------------------------------------------------------------------
// 5d. Mobile transport: refresh token in the body, no cookie
// ---------------------------------------------------------------------------
{
  const r = await post('/api/v1/auth/login',
    { identifierType: 'email', identifier: emailA, password: PASSWORD, deviceType: 'android' });
  const mobileRefresh = r.json?.data?.refreshToken;
  if (r.json?.data?.accessToken) seenTokens.push(r.json.data.accessToken);
  if (mobileRefresh) seenTokens.push(mobileRefresh);

  const ok = r.status === 200 && typeof mobileRefresh === 'string' && cookieOf(r.setCookie) === null;
  check('5d mobile login -> refreshToken in body, no Set-Cookie', ok,
    `status=${r.status} bodyToken=${typeof mobileRefresh === 'string'} cookie=${cookieOf(r.setCookie) !== null}`);

  // Mobile refresh round-trip: token in body, token out in body.
  const rf = await post('/api/v1/auth/refresh', { refreshToken: mobileRefresh, deviceType: 'android' });
  if (rf.json?.data?.refreshToken) seenTokens.push(rf.json.data.refreshToken);
  check('5e mobile refresh -> 200 with rotated token in body',
    rf.status === 200 && typeof rf.json?.data?.refreshToken === 'string'
    && rf.json.data.refreshToken !== mobileRefresh,
    `status=${rf.status} rotated=${rf.json?.data?.refreshToken !== mobileRefresh}`);

  // The pre-rotation mobile token must now be dead.
  const replay = await post('/api/v1/auth/refresh', { refreshToken: mobileRefresh });
  check('5f replay of mobile refresh token -> 401', replay.status === 401,
    `status=${replay.status} code=${replay.json?.code}`);
}

// ---------------------------------------------------------------------------
// 6. Logout revokes the session
// ---------------------------------------------------------------------------
{
  const r = await post('/api/v1/auth/logout', {}, bearer(webAccessToken));
  const cleared = cookieOf(r.setCookie);
  const me = await req('/api/v1/auth/me', bearer(webAccessToken));
  check('6a logout -> 200 and the refresh cookie is cleared',
    r.status === 200 && cleared !== null && /refreshToken=;/.test(cleared),
    `status=${r.status} clearCookie=${cleared?.slice(0, 40)}`);
  check('6b after logout the access token -> 401 SESSION_REVOKED',
    me.status === 401 && me.json?.code === 'SESSION_REVOKED',
    `status=${me.status} code=${me.json?.code}`);
}

// 6c. Logout revokes ONLY the current session (gate G2.5): the 5d mobile
//     session for the same account must still work.
{
  const stillAlive = await post('/api/v1/auth/login',
    { identifierType: 'email', identifier: emailA, password: PASSWORD, deviceType: 'ios' });
  const iosToken = stillAlive.json?.data?.accessToken;
  if (iosToken) seenTokens.push(iosToken);

  const second = await post('/api/v1/auth/login',
    { identifierType: 'email', identifier: emailA, password: PASSWORD, deviceType: 'android' });
  const androidToken = second.json?.data?.accessToken;
  if (androidToken) seenTokens.push(androidToken);

  await post('/api/v1/auth/logout', {}, bearer(iosToken));
  const survivor = await req('/api/v1/auth/me', bearer(androidToken));
  const dead = await req('/api/v1/auth/me', bearer(iosToken));
  check('6c logout kills only its own session; sibling session still 200',
    survivor.status === 200 && dead.status === 401,
    `sibling=${survivor.status} loggedOut=${dead.status}`);
}

// ---------------------------------------------------------------------------
// 7. Password change revokes other sessions (gate G2.6, spec §40)
// ---------------------------------------------------------------------------
{
  await register(emailKeeper);
  await register(emailOther);

  const keeper = await post('/api/v1/auth/login',
    { identifierType: 'email', identifier: emailKeeper, password: PASSWORD });
  const other = await post('/api/v1/auth/login',
    { identifierType: 'email', identifier: emailKeeper, password: PASSWORD, deviceType: 'ios' });
  const keeperToken = keeper.json?.data?.accessToken;
  const otherToken = other.json?.data?.accessToken;
  const otherRefresh = other.json?.data?.refreshToken;
  if (keeperToken) seenTokens.push(keeperToken);
  if (otherToken) seenTokens.push(otherToken);
  if (otherRefresh) seenTokens.push(otherRefresh);

  const changed = await post('/api/v1/auth/change-password',
    { currentPassword: PASSWORD, newPassword: 'a-brand-new-password-1' }, bearer(keeperToken));

  const keeperMe = await req('/api/v1/auth/me', bearer(keeperToken));
  const otherMe = await req('/api/v1/auth/me', bearer(otherToken));
  const otherReplay = await post('/api/v1/auth/refresh', { refreshToken: otherRefresh });

  check('7 password change -> 200; other session 401 SESSION_REVOKED; own session survives; other refresh dead',
    changed.status === 200
    && keeperMe.status === 200
    && otherMe.status === 401 && otherMe.json?.code === 'SESSION_REVOKED'
    && otherReplay.status === 401,
    `change=${changed.status} keeper=${keeperMe.status} other=${otherMe.status}:${otherMe.json?.code} refresh=${otherReplay.status}`);
}

// ---------------------------------------------------------------------------
// 8. Suspended user rejected on the next protected request (gate G2.8)
// ---------------------------------------------------------------------------
{
  await register(emailSuspend);
  const login = await post('/api/v1/auth/login',
    { identifierType: 'email', identifier: emailSuspend, password: PASSWORD });
  const token = login.json?.data?.accessToken;
  if (token) seenTokens.push(token);

  const before = await req('/api/v1/auth/me', bearer(token));
  await mongoose.connection.db.collection(COLLECTIONS.USERS)
    .updateOne({ email: emailSuspend }, { $set: { status: 'suspended' } });
  const after = await req('/api/v1/auth/me', bearer(token));

  check('8 suspended user -> 403 ACCOUNT_INACTIVE despite unexpired token',
    before.status === 200 && after.status === 403 && after.json?.code === 'ACCOUNT_INACTIVE',
    `before=${before.status} after=${after.status}:${after.json?.code}`);

  // Clean up so a later harness run in the same DB is unaffected.
  await mongoose.connection.db.collection(COLLECTIONS.USERS)
    .updateOne({ email: emailSuspend }, { $set: { status: 'active' } });
}

// ---------------------------------------------------------------------------
// 9. Client-supplied identity is ignored (gate G3.1, spec §31/§44)
// ---------------------------------------------------------------------------
{
  const victim = await register(`s4v${RUN}@example.com`);
  const login = await post('/api/v1/auth/login',
    { identifierType: 'email', identifier: emailOther, password: PASSWORD });
  const token = login.json?.data?.accessToken;
  if (token) seenTokens.push(token);
  const victimId = victim.json?.data?.user?.id;

  const viaQuery = await req(`/api/v1/auth/me?userId=${victimId}`, bearer(token));
  const viaBody = await post('/api/v1/auth/change-password',
    { userId: victimId, currentPassword: 'x', newPassword: 'y' }, bearer(token));

  check('9a ?userId=<other> does not change who /me reports',
    viaQuery.status === 200 && viaQuery.json?.data?.user?.email === emailOther,
    `status=${viaQuery.status} email=${viaQuery.json?.data?.user?.email}`);
  check('9b userId in a body is rejected outright (strict schema), not honoured',
    viaBody.status === 400,
    `status=${viaBody.status} details=${JSON.stringify(viaBody.json?.details)}`);
}

// ---------------------------------------------------------------------------
// 10. Refresh with no / unknown token (edge of the doc's command 5)
// ---------------------------------------------------------------------------
{
  const none = await post('/api/v1/auth/refresh', {});
  const unknown = await post('/api/v1/auth/refresh', { refreshToken: 'made-up-token-value' });
  check('10 refresh without a token -> 401 REFRESH_TOKEN_INVALID',
    none.status === 401 && none.json?.code === 'REFRESH_TOKEN_INVALID'
    && unknown.status === 401 && unknown.json?.code === 'REFRESH_TOKEN_INVALID',
    `none=${none.status}:${none.json?.code} unknown=${unknown.status}:${unknown.json?.code}`);
}

// ---------------------------------------------------------------------------
// 11. Direct DB inspection: TTL index on sessions (gate G4.3 / spec §105)
// ---------------------------------------------------------------------------
{
  const indexes = await mongoose.connection.db.collection(COLLECTIONS.SESSIONS).indexes();
  const ttl = indexes.find((i) => i.key?.expiresAt === 1);
  const userIdx = indexes.find((i) => i.key?.userId === 1);
  const hashIdx = indexes.find((i) => i.key?.refreshTokenHash === 1);
  check('11 sessions indexes: userId + unique refreshTokenHash + TTL expiresAt',
    !!userIdx && !!hashIdx && hashIdx.unique === true && !!ttl && ttl.expireAfterSeconds === 0,
    `userId=${!!userIdx} hashUnique=${!!hashIdx?.unique} ttl=${ttl?.expireAfterSeconds}`);

  // Refresh lookup plan must be an index scan (gate G4.1).
  const plan = await mongoose.connection.db.collection(COLLECTIONS.SESSIONS)
    .find({ refreshTokenHash: tokenService.hashRefreshToken('explain-probe') })
    .explain('queryPlanner');
  check('11b refresh lookup -> IXSCAN (no COLLSCAN)',
    /IXSCAN/.test(JSON.stringify(plan)) && !/COLLSCAN/.test(JSON.stringify(plan)),
    `ixscan=${/IXSCAN/.test(JSON.stringify(plan))} collscan=${/COLLSCAN/.test(JSON.stringify(plan))}`);
}

// ---------------------------------------------------------------------------
// 12. CORS with credentials: disallowed origin still refused (gate G3.6)
// ---------------------------------------------------------------------------
{
  const evil = await fetch(`${BASE}/api/v1/health`, { headers: { Origin: 'https://evil.example' } });
  const good = await fetch(`${BASE}/api/v1/health`, { headers: { Origin: 'http://localhost:5173' } });
  check('12 CORS: evil origin gets no ACAO; allowed origin gets credentials=true, never wildcard',
    evil.headers.get('access-control-allow-origin') === null
    && good.headers.get('access-control-allow-origin') === 'http://localhost:5173'
    && good.headers.get('access-control-allow-credentials') === 'true'
    && good.headers.get('access-control-allow-origin') !== '*',
    `evil=${evil.headers.get('access-control-allow-origin')} good=${good.headers.get('access-control-allow-origin')} creds=${good.headers.get('access-control-allow-credentials')}`);
}

// ---------------------------------------------------------------------------
// 13. Log scan: no credential material ever reaches the log (gate G3.3)
// ---------------------------------------------------------------------------
{
  const logPath = process.argv[2];
  if (!logPath || !fs.existsSync(logPath)) {
    check('13 log: no access/refresh token in the server log', false, `LOG FILE NOT FOUND: ${logPath || 'not supplied'}`);
  } else {
    const log = fs.readFileSync(logPath, 'utf8');
    const leaked = seenTokens.filter((t) => t && log.includes(t));
    const headerLeak = /"authorization"|"cookie"|"setCookie"|Bearer [A-Za-z0-9._-]{20,}/.test(log);
    check('13 log: none of the minted tokens appear in the server log',
      leaked.length === 0 && !headerLeak,
      `tokensChecked=${seenTokens.length} leaked=${leaked.length} headerLeak=${headerLeak}`);
    check('13b log: request correlation ids present', /"reqId"/.test(log), `hasReqId=${/"reqId"/.test(log)}`);
  }
}

await mongoose.disconnect();

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
