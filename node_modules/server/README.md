# Chandravanshi Vivah — Express API (`server/`)

Backend for the Chandravanshi matrimonial platform. This package currently contains **step 01 — project setup and
configuration** and **step 02 — MongoDB connection**: the app object, config validation, response envelope,
centralised errors, security headers, CORS, body/rate limits, request logging, the health endpoint, plus the single
MongoDB connection helper, shared schema conventions and the collection-name registry. No auth or domain route
exists yet.

Source of truth for behaviour: `../docs/steps/01-project-setup-and-config.md` and
`../docs/steps/02-mongodb-connection.md`, which cite the backend specification and the profile fields dictionary.

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
| `eslint` | 10.12.0 | Lint (dev) |

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
│   ├── models/
│   │   └── plugins/baseSchema.js  # timestamps, versionKey off, strict, JSON transform
│   ├── middleware/
│   │   ├── requestId.js       # correlation id
│   │   ├── requestLogger.js   # allowlisted request logging (spec §78)
│   │   ├── rateLimit.js       # limiter factory reused by later steps
│   │   ├── notFound.js        # 404 -> envelope
│   │   └── errorHandler.js    # error -> envelope mapper
│   ├── routes/index.js        # mounts /api/v1; health only for now
│   └── utils/
│       ├── apiResponse.js     # ok() / fail()
│       ├── AppError.js        # typed operational errors
│       ├── objectId.js        # isValidObjectId() guard (spec §35)
│       └── gracefulShutdown.js
├── scripts/
│   └── verify-indexes.js      # asserts required indexes exist
├── tests/                     # node:test suites
├── .env                       # your local values (gitignored)
├── .env.example               # names + placeholders only
└── .gitignore
```

Middleware order in `app.js` is fixed: request id → logger → helmet → CORS → JSON body → rate limit → API router →
404 → error handler.

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

## Notes

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
