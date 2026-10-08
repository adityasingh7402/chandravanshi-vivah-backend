# Chandravanshi Vivah — Express API (`server/`)

Backend for the Chandravanshi matrimonial platform. This package currently contains **step 01 — project setup and
configuration**, **step 02 — MongoDB connection**, **step 03 — user & authentication** and **step 04 — session /
token handling**: the app object, config validation, response envelope, centralised errors, security headers, CORS,
body/rate limits, request logging, the health endpoint, the single MongoDB connection helper, shared schema
conventions, the collection-name registry, account registration / login verification / change-password with Argon2id
hashing, and the short-lived access token + rotating opaque refresh token session model with `requireAuth` /
`optionalAuth` / `requireRole` middleware. No profile or other domain route exists yet.

Source of truth for behaviour: the step files under `../docs/steps/`, which cite the backend specification and the
profile fields dictionary.

## Requirements

| | |
|---|---|
| Node.js | >= 20 (verified on v24.16.0) |
| npm | 11.x (verified on 11.13.0) |

The package is **CommonJS** (`"type": "commonjs"`), so later steps can be invoked with `node -e "require('./src/...')"`.

## Setup

```bash
cd server
npm install
cp .env.example .env
```

Then put a real secret in `.env` (never commit it — `.env` is gitignored):

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Paste the output as `JWT_SECRET`. Starting the server with the `.env.example` placeholder fails fast on purpose.

## Scripts

| Script | Command | Purpose |
|---|---|---|
| `npm run dev` | `node --watch src/server.js` | Auto-restart on file change |
| `npm start` | `node src/server.js` | Run once |
| `npm run lint` | `eslint .` | Flat-config lint (CommonJS, Node globals) |
| `npm test` | `node --test` | Node's built-in test runner over `tests/*.test.js` |

From the repository root the same four commands delegate into this package (`npm --prefix server run …`).

## Environment variables

Names only — values live in your local `.env` and in the host's secret store (spec §79). Every variable below is
read **and validated** by `src/config/env.js`; anything missing or malformed stops the process at boot.

| Name | Required | Default | Used from | Purpose |
|---|---|---|---|---|
| `NODE_ENV` | no | `development` | 01 | `development` \| `test` \| `production` |
| `PORT` | no | `3000` | 01 | HTTP listener port (1–65535) |
| `API_PREFIX` | no | `/api/v1` | 01 | Mount point for the versioned router |
| `APP_URL` | **yes** | — | 01 | Public website origin (no path) |
| `API_URL` | **yes** | — | 01 | Public API origin (no path) |
| `CORS_ORIGINS` | **yes** | — | 01 | Comma-separated explicit origins; wildcards rejected |
| `JSON_BODY_LIMIT` | no | `100kb` | 01 | JSON body cap, rejected with 413 |
| `RATE_LIMIT_WINDOW` | no | `60` | 01 | Global rate-limit window, seconds |
| `RATE_LIMIT_MAX` | no | `100` | 01 | Requests per window |
| `LOG_LEVEL` | no | `info` | 01 | `debug` \| `info` \| `warn` \| `error` |
| `JWT_SECRET` | **yes** | — | 04 | ≥ 32 chars; placeholder values rejected |
| `JWT_ACCESS_TTL` | **yes** | — | 04 | e.g. `15m` |
| `JWT_REFRESH_TTL` | **yes** | — | 04 | e.g. `7d`; must be longer than the access TTL |
| `MONGODB_URI` | **yes** | — | 02 | `mongodb://` or `mongodb+srv://`; the most sensitive value in the app |
| `MONGODB_DB_NAME` | **yes** | — | 02 | Database name, kept out of the URI |
| `DB_MAX_POOL_SIZE` | no | `10` | 02 | Connection pool ceiling (1–500) |
| `DB_SERVER_SELECTION_TIMEOUT_MS` | no | `5000` | 02 | Fail fast when the cluster is unreachable |
| `DB_CONNECT_TIMEOUT_MS` | no | `10000` | 02 | Initial connect timeout |
| `DB_SOCKET_TIMEOUT_MS` | no | `45000` | 02 | Socket timeout; `0` disables it |
| `PASSWORD_MIN_LENGTH` | no | `8` | 03 | Minimum accepted password length |
| `ARGON2_MEMORY` | no | `19456` | 03 | Argon2id memory cost, KiB (OWASP minimum) |
| `ARGON2_ITERATIONS` | no | `2` | 03 | Argon2id time cost |
| `ARGON2_PARALLELISM` | no | `1` | 03 | Argon2id lanes |
| `DEFAULT_PHONE_COUNTRY` | no | `IN` | 03 | ISO code used when a phone has no country code |
| `AUTH_RATE_LIMIT_WINDOW` | no | `900` | 03 | Register/login window, seconds |
| `AUTH_RATE_LIMIT_MAX` | no | `10` | 03 | Register/login attempts per window |
| `JWT_ISSUER` | no | `chandravanshi-vivah-api` | 04 | `iss` claim, checked on every verification |
| `JWT_AUDIENCE` | no | `chandravanshi-vivah-clients` | 04 | `aud` claim, checked on every verification |
| `REFRESH_TOKEN_BYTES` | no | `32` | 04 | Entropy of the opaque refresh token (16–128 bytes) |
| `COOKIE_DOMAIN` | no | *(empty)* | 04 | Cookie `Domain`; empty = host-only cookie |
| `COOKIE_SAME_SITE` | no | `lax` | 04 | `lax` \| `strict` \| `none`; `none` requires production |

**Precedence:** an environment variable already present in the shell overrides `.env` — that is standard `dotenv`
behaviour and is what lets a host inject real configuration. Two consequences worth knowing:

- This project's shell exports `PORT=0`. `PORT=0` is treated as *unset* so the value from `.env` applies; the
  resolved port is still range-checked.
- To run on a different port, set it in `.env` or prefix the command (`PORT=4000 npm start`).

## Installed versions

Recorded at install time; verify again if the lockfile changes.

| Package | Version | Role |
|---|---|---|
| `express` | 5.2.1 | HTTP framework (async errors are forwarded to the error handler) |
| `cors` | 2.8.6 | Origin allowlist (spec §41) |
| `helmet` | 8.3.0 | Standard security headers (spec §42) |
| `express-rate-limit` | 8.7.1 | Rate-limit factory (spec §36, §80) |
| `pino` | 10.4.0 | Structured logging with redaction (spec §78) |
| `pino-http` | 11.0.0 | Per-request logging |
| `dotenv` | 18.0.6 | `.env` loading (spec §79) |
| `zod` | 4.6.5 | Request validation, used from step 03 |
| `mongoose` | 9.11.1 | MongoDB driver + ODM (spec §38, §39) |
| `@node-rs/argon2` | 2.2.2 | Argon2id password hashing (prebuilt binary) |
| `jsonwebtoken` | 9.0.3 | HS256 access tokens, pinned algorithm + issuer/audience (step 04) |
| `cookie-parser` | 1.4.7 | Reads the HttpOnly refresh cookie (step 04) |
| `eslint` | 10.12.0 | Lint (dev) |

Password hashing uses **Argon2id** with parameters from config (defaults `m=19456, t=2, p=1`, the OWASP minimum).
`passwordService.needsRehash()` upgrades a weaker stored hash on the next successful login, so raising the cost needs
no data migration.

## Layout

```text
server/
├── src/
│   ├── app.js                 # builds the Express app; never binds a port
│   ├── server.js              # loads config, listens, shuts down gracefully
│   ├── config/
│   │   ├── env.js             # loads + validates env, exports a frozen config
│   │   ├── constants.js       # prefix, status codes, error codes, pagination
│   │   ├── collections.js     # canonical collection names (single source of truth)
│   │   └── db.js              # the only place a MongoDB connection is created
│   ├── constants/
│   │   ├── auth.js            # role/status/identifier/device enums + client-safe messages
│   │   └── errors.js          # 401/403 machine-readable codes (spec §77)
│   ├── models/
│   │   ├── User.js            # users schema (spec §5)
│   │   ├── Session.js         # sessions schema: hash-only refresh token, TTL (spec §7)
│   │   └── plugins/baseSchema.js  # timestamps, versionKey off, strict, JSON transform
│   ├── middleware/
│   │   ├── requestId.js       # correlation id
│   │   ├── requestLogger.js   # allowlisted request logging (spec §78)
│   │   ├── rateLimit.js       # limiter factory reused by later steps
│   │   ├── auth.js            # requireAuth / optionalAuth — the reusable identity layer
│   │   ├── roles.js           # requireRole(...) — the only place role decisions are made
│   │   ├── notFound.js        # 404 -> envelope
│   │   └── errorHandler.js    # error -> envelope mapper (carries the machine-readable code)
│   ├── services/
│   │   ├── passwordService.js # hash / verify / needsRehash (Argon2id)
│   │   ├── authService.js     # register / verifyCredentials / changePassword
│   │   ├── tokenService.js    # sign/verify access JWT; issue/hash opaque refresh tokens
│   │   └── sessionService.js  # start / find / touch / revoke / rotate sessions
│   ├── controllers/
│   │   ├── auth.controller.js   # register / login / change-password (spec §94, §95)
│   │   └── session.controller.js # refresh / logout / me
│   ├── validators/
│   │   └── auth.validators.js # zod schemas; unknown fields rejected
│   ├── routes/
│   │   ├── index.js           # mounts /api/v1
│   │   ├── auth.routes.js     # register/login/change-password with per-route rate limits
│   │   └── session.routes.js  # refresh (public) / logout / me (requireAuth)
│   └── utils/
│       ├── apiResponse.js     # ok() / fail()
│       ├── AppError.js        # typed operational errors
│       ├── cookies.js         # HttpOnly refresh cookie: set / clear / read
│       ├── identifier.js      # email/phone normalisation + E.164
│       ├── objectId.js        # isValidObjectId() guard (spec §35)
│       └── gracefulShutdown.js
├── scripts/
│   └── verify-indexes.js      # asserts required indexes exist
├── tests/                     # node:test suites
├── .env                       # your local values (gitignored)
├── .env.example               # names + placeholders only
└── .gitignore
```

Middleware order in `app.js` is fixed: request id → logger → helmet → CORS (credentials allowed for the explicit
origin allowlist) → cookie parser → JSON body → rate limit → API router → 404 → error handler.

## Running the checks

```bash
npm run lint               # exit 0
npm test                   # exit 0
node scripts/verify-indexes.js   # exit 0; prints the index baseline

npm start
curl -sS http://localhost:3000/api/v1/health
```

The database-dependent tests connect to the configured cluster; when none is reachable they **skip with an explicit
reason** rather than passing silently.

Expected health payload:

```json
{ "success": true, "data": { "status": "ok", "env": "development", "version": "0.1.0", "uptime": 41, "timestamp": "…", "database": { "state": "connected", "connected": true } }, "message": "OK" }
```

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/v1/auth/register` | public | `{ identifierType, identifier, password }` → 201 |
| POST | `/api/v1/auth/login` | public | Verify credentials → access token; web gets an HttpOnly refresh cookie, mobile the refresh token in the body |
| POST | `/api/v1/auth/refresh` | refresh token | Rotates the session, returns a new access token; replay of a rotated token → 401 |
| POST | `/api/v1/auth/logout` | session | Revokes the caller's own session only; clears the cookie |
| GET | `/api/v1/auth/me` | session | The caller's own account summary (`toPublic()` shape) |
| POST | `/api/v1/auth/change-password` | session | Requires the current password; revokes every other session |
| GET | `/api/v1/health` | public | Liveness + database readiness |

Login returns one generic `401 Invalid credentials.` for both an unknown identifier and a wrong password, so the
endpoint cannot be used to enumerate accounts. Request bodies are `.strict()` — an unexpected field (for example
`role`) is rejected with 400 rather than ignored.

## Session model (step 04)

- **Access token**: short-lived HS256 JWT carrying only `sub`, `role`, `sid` plus `iat`/`exp`/`iss`/`aud` — no
  profile or contact data (spec §30). The algorithm is pinned in both sign and verify, so `alg: none`, a different
  secret, a tampered payload, a wrong issuer/audience and HS512 confusion are all rejected.
- **Refresh token**: opaque `crypto.randomBytes(32)` value. The database stores only its SHA-256 hash, so a leaked
  `sessions` row is not a replayable credential. Every refresh **rotates**: the old row is revoked and a new token
  issued; replaying a rotated token returns `401 SESSION_REVOKED`.
- **Transport**: web receives the token in an `HttpOnly; SameSite=Lax` cookie scoped to
  `<API_PREFIX>/auth/refresh` (plus `Secure` in production), so client JavaScript can never read it. Mobile clients
  (`deviceType: android | ios`) receive it in the response body for platform secure storage.
- **Revocation is immediate**: `requireAuth` checks the session row on every protected request, so logout, rotation
  and password changes take effect even while an access token is still unexpired. A suspended/blocked/deleted user
  is refused with `403 ACCOUNT_INACTIVE` regardless of token validity.
- **Failure codes** (spec §77, in the failure envelope): `AUTHENTICATION_REQUIRED` (no credential), `TOKEN_EXPIRED`
  (refresh), `TOKEN_INVALID` (sign in again), `REFRESH_TOKEN_INVALID`, `SESSION_REVOKED`, `ACCOUNT_INACTIVE`,
  `FORBIDDEN`.
- **Reuse**: `requireAuth` + `requireRole` in `src/middleware/` are the single identity/authorization layer for all
  later steps; identity comes only from the credential, never from a body or query parameter (spec §31, §44).

## Notes

- **Open security item:** the current development environment connects to Atlas with an `atlasAdmin` credential.
  Spec §39 requires a least-privilege application user (built-in `readWrite` scoped to the app database). See
  *Blocking security items* in `../docs/steps/00-progress-tracker.md`.
- **Partial indexes need their predicate in the query.** The `email`/`phone` unique indexes are partial
  (`$type: "string"`), and MongoDB only uses a partial index when the query includes that filter. `authService`
  therefore looks identifiers up with `{ $and: [{ email: value }, { email: { $type: "string" } }] }`, which
  `tests/auth.test.js` asserts is an `IXSCAN`.
- **No secrets in the repo.** `.env` is gitignored, `.env.example` holds placeholders only, and configuration
  errors name the *field* without echoing its value.
- **Logging is an allowlist.** Only method, route, status, duration and the request id are written. Headers, query
  strings, bodies and remote addresses are never serialised; connection strings and key/value pairs are scrubbed
  from free-text error messages.
- **Stack traces** appear in a 500 response only when `NODE_ENV` is not `production`.
- **Database access is server-only** (spec §2, §38): the URI never reaches a client, is never logged, and `db.js`
  scrubs connection strings, host lists, credentials and the database name out of driver error messages before they
  are logged.
- **Schema conventions** come from `models/plugins/baseSchema.js`: `timestamps`, `versionKey: false`, `strict: true`,
  and a JSON transform that strips any path flagged `internal: true`.
- **Collection names** come from `src/config/collections.js` only — no model writes a collection string literal.
- **Indexes** are verified by `scripts/verify-indexes.js`: `autoIndex` is off outside development, so every required
  index is created and checked explicitly (spec §49, §105).
- **Shutdown** is covered by `src/utils/gracefulShutdown.js`. Node on Windows does not deliver `SIGINT`/`SIGTERM` to
  a handler when the signal comes from `child.kill()`, so `tests/shutdown.test.js` drives the function directly
  rather than claiming an OS-level signal test it cannot perform. The shutdown hook closes the MongoDB connection.
