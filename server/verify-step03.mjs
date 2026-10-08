// Step 03 scripted verification — runs the doc's verification commands against a live server.
// Run with the same MONGODB_DB_NAME as the server, e.g.
//   MONGODB_DB_NAME=chandravanshi_vivah_test node verify-step03.mjs
import mongoose from 'mongoose';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const config = require('./src/config/env');
const User = require('./src/models/User');
const { COLLECTIONS } = require('./src/config/collections');

const BASE = `http://localhost:${config.port}`;
const PASSWORD = 'correct-horse-battery';
const RUN = Date.now();

const results = [];
const check = (name, pass, detail) => results.push({ name, pass, detail });

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}

// 1. Health (step 01 regression)
{
  const res = await fetch(`${BASE}/api/v1/health`);
  const body = await res.json();
  check('health 200 + database.connected', res.status === 200 && body.data?.database?.connected === true,
    `status=${res.status} db=${body.data?.database?.state}`);
}

// 2. Register with email
const email = `verify${RUN}@example.com`;
let registerEmail;
{
  registerEmail = await post('/api/v1/auth/register', { identifierType: 'email', identifier: email, password: PASSWORD });
  const ok = registerEmail.status === 201
    && registerEmail.json?.success === true
    && registerEmail.json?.data?.user?.role === 'user'
    && registerEmail.json?.data?.user?.status === 'active'
    && !/passwordHash|\$argon2/.test(registerEmail.text);
  check('register email -> 201, defaults, no hash', ok,
    `status=${registerEmail.status} role=${registerEmail.json?.data?.user?.role}`);
}

// 3. Register with phone (normalised)
{
  const phone = `9${String(RUN).slice(-9)}`;
  const res = await post('/api/v1/auth/register', { identifierType: 'phone', identifier: phone, password: PASSWORD });
  check('register phone -> 201 normalised to E.164', res.status === 201 && res.json?.data?.user?.phone === `+91${phone}`,
    `status=${res.status} phone=${res.json?.data?.user?.phone}`);
}

// 4. Duplicate email -> 409 clean
{
  const res = await post('/api/v1/auth/register', { identifierType: 'email', identifier: email, password: PASSWORD });
  const ok = res.status === 409
    && res.json?.message === 'A profile with this email already exists.'
    && res.json?.stack === undefined
    && !/E11000|duplicate key/i.test(res.text);
  check('duplicate email -> 409 clean message', ok, `status=${res.status} message=${JSON.stringify(res.json?.message)}`);
}

// 5. Neither identifier -> 400
{
  const res = await post('/api/v1/auth/register', { password: PASSWORD });
  check('no identifier -> 400 with field details', res.status === 400 && !!res.json?.details,
    `status=${res.status} details=${JSON.stringify(res.json?.details)}`);
}

// 6. Attempted privilege escalation -> 400, no admin created
{
  const res = await post('/api/v1/auth/register', {
    identifierType: 'email', identifier: `admin${RUN}@example.com`, password: PASSWORD, role: 'admin'
  });
  check('role:admin in body -> 400', res.status === 400 && res.json?.success === false, `status=${res.status}`);
}

// 7. Login success
{
  const res = await post('/api/v1/auth/login', { identifierType: 'email', identifier: email, password: PASSWORD });
  check('login correct -> 200', res.status === 200 && res.json?.data?.user?.email === email, `status=${res.status}`);
}

// 8. Login failures are indistinguishable
{
  const wrong = await post('/api/v1/auth/login', { identifierType: 'email', identifier: email, password: 'wrong-password' });
  const unknown = await post('/api/v1/auth/login', { identifierType: 'email', identifier: `nobody${RUN}@example.com`, password: 'wrong-password' });
  const ok = wrong.status === 401 && unknown.status === 401 && wrong.json?.message === unknown.json?.message;
  check('wrong password and unknown identifier share one 401', ok,
    `wrong=${wrong.status}:${JSON.stringify(wrong.json?.message)} unknown=${unknown.status}:${JSON.stringify(unknown.json?.message)}`);
}

// 9. Change-password requires a session
{
  const res = await post('/api/v1/auth/change-password', { currentPassword: PASSWORD, newPassword: 'another-password-1' });
  check('change-password unauthenticated -> 401', res.status === 401, `status=${res.status}`);
}

// 10. No self-service reset route
{
  const res = await post('/api/v1/auth/forgot-password', { identifier: email });
  check('no forgot-password route -> 404', res.status === 404, `status=${res.status}`);
}

// 11. Login rate limit -> 429
{
  const statuses = [];
  for (let i = 0; i < 30; i += 1) {
    const res = await post('/api/v1/auth/login', { identifierType: 'email', identifier: email, password: 'wrong-password' });
    statuses.push(res.status);
  }
  check('login rate limit -> 429 within the window', statuses.includes(429),
    `first=${statuses[0]} last=${statuses[statuses.length - 1]} distinct=${[...new Set(statuses)].join(',')}`);
}

// 12. Direct database inspection: only a strong hash is stored
{
  await mongoose.connect(config.mongodbUri, { dbName: config.mongodbDbName, serverSelectionTimeoutMS: 5000 });
  const stored = await mongoose.connection.db.collection(COLLECTIONS.USERS).findOne({ email });
  const ok = stored
    && typeof stored.passwordHash === 'string'
    && stored.passwordHash.startsWith('$argon2id$')
    && stored.password === undefined
    && stored.passwordHash !== PASSWORD;
  check('DB stores an Argon2id hash, never the plaintext', !!ok,
    `hashPrefix=${stored?.passwordHash?.slice(0, 10)} hasPlainPasswordField=${stored ? 'password' in stored : 'n/a'}`);
  await mongoose.disconnect();
}

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${r.detail})`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
