# Chandravanshi Vivah — Express API (`server/`)

Backend for the Chandravanshi matrimonial platform. This package currently contains **steps 01–13 and 15** (step 14, chat, remains a future plan): project setup
and configuration, the MongoDB connection, user & authentication, session / token handling, the master-data
vocabulary, the **matrimonial profile**, **partner preferences**, **photos & Kundli documents**,
**discover / search**, **profile actions**, and **interests / connections**. Concretely: the
app object, config validation, response envelope, centralised errors, security headers, CORS, body/rate limits,
request logging, the health endpoint, the single MongoDB connection helper, shared schema conventions, the
collection-name registry, account registration / login verification / change-password with Argon2id hashing, the
short-lived access token + rotating opaque refresh token session model with `requireAuth` / `optionalAuth` /
`requireRole`, 18 seeded master collections with scope-aware search plus the user-contributed option path, the
profile create / read / partial-update / soft-delete surface with its own DTOs, completion scoring and status rules,
the owner-only preference document with partial-save merges, scoped master-reference validation and an effective-
filter builder for Discover, the signed-upload photo and Kundli surfaces with ownership, moderation state,
per-photo visibility and transformed delivery URLs, and the performance-critical read path — `discover`, `search`
and `recommendations` — with an allowlisted filter builder, age → date-of-birth conversion, `2dsphere` distance
search, a small card projection, cursor pagination and deterministic scoring on a bounded candidate window, and the
**profile actions** log — idempotent view / like / shortlist / pass writes in their own collection, a shortlist
listing served from the shared card projection, the `pass` exclusion wired into discovery without changing its query
shape, per-type rate limiting and a throttled activity signal, and the **interest / connection** handshake — a
server-enforced state machine (send → pending → accept / reject / withdraw / expire, plus `close`) over a
`connections` collection whose partial unique active-pair index makes a duplicate or crossing interest impossible,
with a derived `canChat` gate, an index-backed lazy expiry sweep, per-account rate limiting and domain events for
step 13, the **safety layer** — `blocks` that sever every interaction path both ways (discovery exclusion,
interest and action prevention, derived `canChat`, a notification-suppression hook for step 13) plus `reports`,
moderation-ready cases that never reveal the reporter to the reported user — the **notification layer** — a
`notifications` inbox fed by the domain events steps 10–12 already emit, with block suppression, per-actor
coalescing of high-frequency types, keyset-paginated reads, an unread badge and idempotent mark-read writes — and
the **entitlement layer** — an indefinite free subscription granted at registration, one centralised
`hasFeatureAccess()` gate that grants every implemented feature (nothing is gated in this phase), an indexed
expiry sweep that cannot touch the free plan, and a documented provider seam with no payment code.

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
| `npm run verify` | `node scripts/verify-all.mjs` | One command: scratch database, a fresh server per harness, every step harness + the index check |
| `npm run check:db-privileges` | `node scripts/check-db-privileges.js` | Asserts the MongoDB credential is least-privilege (step 02 gate G3.2) |
| — | `node scripts/backfill-entitlements.js` | One-pass, idempotent migration granting the free entitlement to row-less accounts (step 15) |

From the repository root the same commands delegate into this package (`npm --prefix server run …`).

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
| `MASTER_SEARCH_MIN_LEN` | no | `2` | 05 | A shorter search is refused before any query runs |
| `MASTER_SEARCH_MAX_LIMIT` | no | `50` | 05 | Hard cap every master-data listing is clamped to |
| `MASTER_DEFAULT_LIMIT` | no | `20` | 05 | Default page size; must not exceed the cap |
| `MASTER_MISSING_MAX_LEN` | no | `60` | 05 | Longest value accepted by the "can't find it?" path |
| `MASTER_MISSING_ENABLED` | no | `true` | 05 | Global switch for user-contributed options |

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
│   │   ├── cloudinary.js      # SDK config + the injectable asset gateway (secret never logged)
│   │   ├── localAssetStore.js # dev/gate stand-in for the provider (CLOUDINARY_MOCK)
│   │   └── db.js              # the only place a MongoDB connection is created
│   ├── constants/
│   │   ├── auth.js            # role/status/identifier/device enums + client-safe messages
│   │   ├── errors.js          # 401/403 machine-readable codes (spec §77)
│   │   ├── masterData.js      # master-collection descriptors: collection, scope, parents, extra fields
│   │   ├── masterCategories.js # the six community-context categories + user-input rules
│   │   ├── profile.js         # profile statuses, dictionary enums, §57 weights, §25 required set
│   │   ├── preference.js      # preference enum mirrors, finalized sets (decisions §4), default ranges, caps
│   │   ├── photo.js           # photo types, visibility, moderation states, transformation sizes
│   │   ├── kundli.js          # reduced visibility set, formats, authenticated asset type
│   │   ├── search.js          # filter/sort allowlists, page sizes, recommendation weights
│   │   └── actions.js         # action types, discovery-excluded types, idempotency
│   ├── models/
│   │   ├── User.js            # users schema (spec §5)
│   │   ├── Session.js         # sessions schema: hash-only refresh token, TTL (spec §7)
│   │   ├── CommunityConfig.js # community_configs (spec §15)
│   │   ├── MasterDataRequest.js # master_data_requests review queue (decisions §3)
│   │   ├── MatrimonialProfile.js # matrimonial_profiles: §8 sections + §105 indexes
│   │   ├── PartnerPreference.js  # partner_preferences: §16 fields + unique §105 `userId` index
│   │   ├── Photo.js              # photos: §17 fields, §105 indexes, partial unique primary
│   │   ├── KundliDocument.js     # kundli_documents: dedicated collection (decisions §6)
│   │   ├── ProfileAction.js      # profile_actions: view/like/shortlist/pass + §105 indexes
│   │   ├── masterData/MasterItem.js # generic master-item factory + every master model
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
│   │   ├── sessionService.js  # start / find / touch / revoke / rotate sessions
│   │   ├── masterDataService.js    # list / search / validateIds / resolveNames
│   │   ├── masterOptionService.js  # findOrCreateUserOption / normalizeSlug / mergeAliases
│   │   ├── masterDataRequestService.js # submitMissing / listPending / verify / reject
│ │ ├── profileService.js # create / update / getOwn / getPublic / hardDelete
│   │   ├── profileCompletion.js    # §57 scoring + the §25 publish gate
│   │   ├── profileSerializer.js    # DTOs: own | discovery card | public
│   │   ├── profileScoreService.js  # the §57 scoring sources: preferences + primary photo
│   │   ├── preferenceService.js     # create / update (merge) / get / effectiveFilters / re-score
│   │   ├── photoService.js          # sign flow, verified register, primary, reorder, delete
│   │   ├── kundliService.js         # one private document per account, signed delivery URL
│   │   ├── uploadSignature.js       # short-lived scoped signatures (folder + format allowlist)
│   │   ├── queryBuilder.js          # allowlisted filter -> literal Mongo query (no client keys)
│   │   ├── dateRange.js             # age bounds -> inclusive date-of-birth boundaries (spec §47)
│   │   ├── geoSearch.js             # $near distance clause + coordinate validation (spec §48)
│   │   ├── exclusionService.js      # self / blocked / ineligible exclusions (spec §56, §99)
│   │   ├── cursor.js                # opaque cursor encode/decode over the active sort key
│   │   ├── recommendationService.js # deterministic scoring on a bounded candidate window
│   │   ├── searchService.js         # discover / search / recommendations orchestration
│   │   └── actionService.js         # idempotent record/remove, card-projected listings, domain events
│   ├── controllers/
│   │   ├── auth.controller.js   # register / login / change-password (spec §94, §95)
│   │   ├── session.controller.js # refresh / logout / me
│   │   ├── masterData.controller.js # list / getOne / submitMissing
│   │   ├── profile.controller.js # getMe / create / update / remove / getPublic
│   │   ├── preference.controller.js # getOwn / create / update
│   │   ├── photo.controller.js   # list / sign / create / update / reorder / remove
│   │   ├── kundli.controller.js  # get / create / update / remove
│   │   ├── discover.controller.js # discover / search / recommendations
│   │   └── action.controller.js # record / list / remove actions
│   ├── validators/
│   │   ├── auth.validators.js # zod schemas; unknown fields rejected
│   │   ├── masterData.validators.js # allowlisted query + .missing body (strict)
│   │   ├── validate.js           # shared strict body/params middleware
│   │   ├── profile.validators.js # one strict schema per section + cross-field rules
│   │   ├── preference.validators.js # ranges, enums, ids, array caps, merged-document validation
│   │   ├── photo.validators.js   # create / patch / reorder schemas (strict)
│   │   ├── kundli.validators.js  # publicId + the reduced visibility enum
│   │   ├── search.validators.js  # filter/sort/limit/cursor allowlists, unknown keys rejected
│   │   ├── action.validators.js  # target (id or publicProfileId), type, list query (strict)
│   │   └── connection.validators.js # target, bounded markup-free message, action, list query (strict)
│   ├── data/
│   │   └── master/*.json      # seed payloads; community.json is extracted from the appendix
│   ├── routes/
│   │   ├── index.js           # mounts /api/v1
│   │   ├── auth.routes.js     # register/login/change-password with per-route rate limits
│   │   ├── session.routes.js  # refresh (public) / logout / me (requireAuth)
│   │   ├── masterData.routes.js # master-data listing/search + authenticated .missing
│   │   ├── profile.routes.js  # /profile/me, /profile (create/patch/delete), /profile/:id
│   │   ├── preference.routes.js # /preferences (get/create/patch), requireAuth only
│   │   ├── photo.routes.js     # /photos (list/sign/create/reorder/update/delete)
│   │   ├── kundli.routes.js    # /kundli (get/create/update/delete)
│   │   ├── discover.routes.js  # /discover, /search, /recommendations
│   │   ├── interaction.routes.js # /interactions (record/list/remove) with a per-type limiter
│   │   └── connection.routes.js # /connections (send/list/respond) with a per-account limiter
│   └── utils/
│       ├── apiResponse.js     # ok() / fail()
│       ├── AppError.js        # typed operational errors
│       ├── cookies.js         # HttpOnly refresh cookie: set / clear / read
│       ├── identifier.js      # email/phone normalisation + E.164
│       ├── objectId.js        # isValidObjectId() guard (spec §35)
│       ├── slug.js            # name normalisation + stable slug (seeding identity)
│       ├── publicProfileId.js # CHV-XXXXX generation + collision-aware allocation (spec §113)
│       ├── cloudinaryUrl.js   # card / profile / gallery transforms (never the original)
│       ├── projections.js     # card projection + serializeCard (age, height, primary photo)
│       └── gracefulShutdown.js
├── scripts/
│   ├── verify-indexes.js      # asserts required indexes exist
│   ├── verify-all.mjs         # one-command gate runner: scratch DB + a fresh server per harness
│   ├── check-db-privileges.js # least-privilege credential check (step 02 gate G3.2)
│   └── seed-master-data.js    # idempotent master-data seeding (spec §102)
├── verify-step0N.mjs          # scripted verification harnesses, steps 01–13, 15 (run against a booted server)
├── tests/                     # node:test suites
│   └── helpers/fakeCloudinary.js # the asset gateway double shared with the local store
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
npm run verify             # one command: scratch DB + a fresh server per harness + every step harness + indexes
                           # runs offline (local asset store), independent of real CLOUDINARY_*; GATE_LIVE_CLOUDINARY=1 opts into the live provider
npm run check:db-privileges # least-privilege check; exits 1 while step 02 G3.2 is open
node scripts/verify-indexes.js   # exit 0; prints the index baseline
node scripts/seed-master-data.js # idempotent; run twice, the second run creates nothing
node scripts/seed-master-data.js --type occupations   # seed one collection
node verify-step01.mjs /tmp/server.log   # step harnesses; 01 and 04 take the server log path as argv[2]
node verify-step06.mjs                   # profile: all 8 doc commands + DB, index and DTO checks
node verify-step07.mjs                   # preferences: all 8 doc commands + unique index, IXSCAN and filter shape
node verify-step08.mjs                   # photos/kundli: all 8 doc commands + ownership, cap, index and privacy
node verify-step09.mjs                   # discover/search: all 10 doc commands + IXSCAN plans, exclusions and privacy
node verify-step10.mjs                   # profile actions: all 8 doc commands + index/idempotency/privacy checks
                                         # `npm run verify` runs all of the above in one go (see the Scripts table)

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
| GET | `/api/v1/master-data/:type` | public | Bounded list/search of a master collection (`query`, `limit`, `page`, `parentId`, `activeOnly`) |
| GET | `/api/v1/master-data/:type/:id` | public | Single item, for label resolution |
| POST | `/api/v1/master-data/:type/missing` | session | "Can't find it?" — records a user-contributed option, returns it selectable, opens a review row |
| GET | `/api/v1/profile/me` | session | The caller's own profile (own DTO; `null` before onboarding) |
| POST | `/api/v1/profile` | session | Create the caller's profile — always as a `draft` |
| PATCH | `/api/v1/profile` | session | Partial update with merged-document validation; `status: "active" \| "hidden"` publishes/unpublishes |
| DELETE | `/api/v1/profile` | session | Permanently delete the profile and its owned photos, preferences, and kundli document |
| GET | `/api/v1/profile/:publicProfileId` | session | Another user's permitted view — `active` profiles only, restricted fields omitted, plus the photos that viewer may see |
| GET | `/api/v1/preferences` | session | The caller's own preferences (`null` before they save any) |
| POST | `/api/v1/preferences` | session | Create the caller's preferences — partial or empty body accepted (409 if one exists) |
| PATCH | `/api/v1/preferences` | session | Partial merge with merged-document validation; `[]` / `null` clears a dimension |
| GET | `/api/v1/photos` | session | The caller's photos, primary first, with card/profile/gallery transforms (never the original) |
| POST | `/api/v1/photos/sign` | session | Short-lived signature scoped to the caller's own upload folder; no secret in the response |
| POST | `/api/v1/photos` | session | Register an uploaded asset after the server verifies it (folder, format, size, cap) — 409 at the cap |
| PATCH | `/api/v1/photos` | session | Persist a whole-gallery order (`{ order: [...] }`) |
| PATCH | `/api/v1/photos/:photoId` | session | `visibility`, `sortOrder` or `isPrimary` — another account's id is **404** |
| DELETE | `/api/v1/photos/:photoId` | session | Destroy the asset, then the reference; a transport failure keeps the row (503, retryable) |
| GET | `/api/v1/kundli` | session | The caller's Kundli metadata + a short-lived signed URL, or `null` |
| POST | `/api/v1/kundli` | session | Register an uploaded Kundli document — always private, always pending |
| PATCH | `/api/v1/kundli/:kundliId` | session | Visibility only: `private \| matches_only` |
| DELETE | `/api/v1/kundli/:kundliId` | session | Destroy the authenticated asset, then the reference |
| GET | `/api/v1/discover` | session | Preference-driven candidates: explicit filters merged over `effectiveFilters()`, mandatory `status: active`, exclusions, cursor page |
| GET | `/api/v1/search` | session | The same allowlisted pipeline **without** the preference merge, so an explicit filter set is honoured exactly |
| GET | `/api/v1/recommendations` | session | Deterministic ranking over a bounded candidate window (never the whole collection) |
| POST | `/api/v1/interactions` | session | Record a `view` / `like` / `shortlist` / `pass` — idempotent per pair, rate limited per type |
| GET | `/api/v1/interactions` | session | The caller's own actions as cards, filterable by `type`, cursor-paginated |
| DELETE | `/api/v1/interactions/:interactionId` | session | Remove one of the caller's actions; another account's id is **404** |
| POST | `/api/v1/connections` | session | Send an interest (optional plain-text note) — **409** on a duplicate or crossing active interest |
| GET | `/api/v1/connections` | session | The caller's sent/received interests by status, as cards, cursor-paginated |
| PATCH | `/api/v1/connections/:connectionId` | session | `accept` / `reject` / `withdraw` / `close`; **403** for the wrong role, **409** for an illegal transition, **404** for a non-participant |
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

## Master data (step 05)

One generic document shape (spec §13) backs every selectable list, so the website and the mobile app call the same
API instead of duplicating lists. `constants/masterData.js` is the allowlist: an unknown `:type` is a **404** and can
never reach `users`, `sessions` or any other collection.

- **Collections (18):** `communities`, `sub_communities`, `surnames`, `gotras`, `clans`, `aaspads`, `occupations`,
  `industries`, `degrees`, `specializations`, `colleges`, `universities`, `countries`, `states`, `districts`,
  `cities`, `languages`, `hobbies`, `interests`. `communities`, `clans` and `aaspads` extend the §127 list: the
  community-format source defines clan and aaspad as their own categories, never merged into gotra.
- **Scope is part of identity.** Uniqueness is `(parent scope, slug)`, never global — `Kashyap` is a Kahar gotra, a
  Yadav gotra, a Rajput gotra *and* a Kahar clan, and those are four distinct rows. `?parentId=` (or the concrete
  field name, e.g. `?countryId=`) filters the cascade.
- **Search is index-backed.** Each row stores a lower-cased `nameLower`, and search runs an **anchored,
  case-sensitive** prefix regex against its index. A case-insensitive regex or a leading wildcard would be a
  COLLSCAN anti-pattern (spec §82). Search shorter than `MASTER_SEARCH_MIN_LEN` is refused with 400 before any
  query; `limit` is clamped to `MASTER_SEARCH_MAX_LIMIT`.
- **Deactivate, never delete** (spec §74): a deactivated item disappears from new selections but stays valid for
  profiles that already reference it. `activeOnly=false` returns them for admin use and is never cached.
- **Two tiers, one collection.** Seeded/admin rows are official (`verifiedAt` set). A value a user cannot find is
  recorded with `source: "user"` and `submittedBy = <the caller>` and is **immediately selectable by everyone**,
  flagged as `isUserContributed`. Every option exposes `isUserContributed` and `verifiedAt`. An admin approval
  promotes the row (`verifiedBy`/`verifiedAt`); a rejection deactivates it.
- **`source`, `submittedBy`, `verifiedBy` and `verifiedAt` are server-stamped only.** The `.missing` body is
  `.strict()`, so sending any of them (or `communityName`) is a 400. Community itself is platform-controlled and
  has no `.missing` path.
- **Aliases never fork the list.** Spelling variants such as the four other Chandravanshi surname spellings are
  stored as `aliases` on one row, not as competing options (fields dictionary §4.4).
- **`community_configs`** holds the single Chandravanshi record (spec §15). `rules.sameGotraAllowed` and
  `settings.requireProfilePhoto` are **product decisions to confirm**, seeded as defaults rather than hardcoded.
- **Seeding** (`scripts/seed-master-data.js`) upserts by slug: re-running creates nothing and reports the same
  totals. It never overwrites a row an admin edited. `src/data/master/community.json` is extracted verbatim from the
  community-format appendix so the names cannot drift by hand.

## Matrimonial profile (step 06)

`matrimonial_profiles` is the single collection Discover will query (spec §3.3, §9): searchable relationships are
embedded as master-data IDs, with a small `*Name` copy beside each ID so a card renders without a join (spec §10).
The master row stays the source of truth — every write re-derives the copies server-side, so a client cannot store a
name that disagrees with the referenced record.

- **Ownership comes from the session.** `userId` is read from `req.auth` (spec §72, §118); a `userId` in the body is
  rejected as an unknown field, and `GET /profile/me` can only ever return the caller's own document.
- **Drafts are legitimate documents.** Every section is nullable and requiredness is enforced by the §25 gate and the
  completion score rather than `required: true`, so onboarding can save and resume a half-filled profile (spec §92).
- **The merged document is validated.** A patch is overlaid on the stored state (converted to its wire form, since the
  document itself holds ObjectIds, Dates and the server-owned `coordinates`) and the result is re-validated, so a
  partial write cannot break a cross-field rule: `marriedBrothersCount <= brothersCount`, `childrenCount` only with
  `hasChildren`, `dietOther` only with `diet: "other"`, configured age and height bounds (spec §81, §34).
- **Status rules (§58).** New profiles are `draft`; `draft → active` requires the §25 required set and reports exactly
  what is missing; `hidden` is reachable only from `active`; a same-status write is an idempotent no-op; `suspended`
  is admin-only and `deleted` is reserved for legacy records, and both are refused as sources *and* as write targets. Only
  `active` is ever publicly readable.
- **Profile deletion is permanent.** The profile, owned photos and Cloudinary assets, partner preferences, and kundli
  document are removed. The login account remains so the user can start onboarding again.
- **Completion (§57).** Weights live in `constants/profile.js`, and every section the product can ask for today is
  enabled, so the denominator is the full 100: 75 profile sections + 15 partner preferences + 10 primary photo. A
  profile complete in every section but with neither signal scores 75, with a photo 85, and with everything 100.
  Preferences (step 07) and the photo (step 08) live in their own collections and are passed to the scorer as
  signals, so all three writers re-score through `services/profileScoreService.js`. The two save paths re-score the
  profile instead of caching; enabling a section re-scores existing rows, which is intended.
- **A photo is required to publish, when the platform says so.** The `draft -> active` gate additionally reads
  `community_configs.settings.requireProfilePhoto` (spec §15) and appends `photos` to `details.missing` when it is on
  and the account has no primary photo. It is configuration, not a constant: switching the setting off publishes
  without one.
- **Three DTOs, never the document** (spec §30, §59): the owner's view (everything they entered, including their own
  coordinates and birth details), the discovery card (the §70 subset), and the public view (§71 minus restricted
  data). `coordinates`, `birthTime` and `birthPlace` are additionally flagged `internal: true`, so even a careless
  serialisation cannot leak them; public reads use an explicit projection and no `populate` chain (spec §51, §66).
- **`publicProfileId`** is a non-sequential `CHV-XXXXX` value drawn from an unambiguous alphabet, never derived from
  the ObjectId or a counter, and backed by a unique index (spec §113).

## Partner preferences (step 07)

`partner_preferences` answers a different question from `matrimonial_profiles`: *who am I looking for?* rather than
*who am I?* (spec §16). It is the default candidate filter Discover will apply, and one account owns exactly one
document — enforced by a **unique index on `userId`**, not by service convention.

- **Partial save is the feature.** Every field is optional. Absent means "no preference on this dimension", never
  "match nothing", which is why the model stores no sentinel "any" values and why `effectiveFilters()` omits a key
  rather than emitting an empty one. A client that wants to *clear* a dimension says so explicitly (`[]` / `null`);
  omitting the key leaves it untouched.
- **The merged document is validated** (same rule as the profile): a patch valid on its own can still invert a range
  against stored state, so values are overlaid first and parsed again. `{ age: { max: 20 } }` onto a stored
  `{ min: 24 }` is a 400 with nothing written, exactly like `{ min: 40, max: 20 }`.
- **Master references are re-derived, never trusted.** Ids go through step 05's `validateIds()` (right collection,
  active, deduplicated, capped), and the community-context arrays (`subCommunityIds`, `surnameIds`, `gotraIds`) are
  additionally checked against the chosen `communityIds`, so a Yadav gotra can never be stored as a Kahar one. The
  scope check is skipped when no community is chosen — without that context there is nothing to violate.
- **Ownership comes from the session.** `userId` is taken from `req.auth` only; a `userId` in the body is rejected as
  an unknown field (400), and there is no route that reads another account's preferences.
- **No stored `age`.** The preference is a range, kept as-is; step 09 converts it to a date-of-birth range at query
  time (spec §47). The API never stores or returns a computed age.
- **Three previously open option sets are now FINAL** (decisions §4): `workingPreference` = Working / Not Working /
  Either, `horoscopeRequired` = Required / Preferred / Not Important (**not a boolean** — a boolean is a 400), and
  `relocationPreference` = Yes / No / Maybe. `gender` defaults to the opposite of the owner's own gender as a
  **default only**, so the user can still override it.
- **`effectiveFilters()` is step 09's contract.** It is built key by key from an allowlist (never a spread of the
  document), contains only plain values — strings and `{ min, max }` numbers, no `$` operators — and omits absent
  dimensions, so Discover can embed it in a query without re-validating or escaping it again.
- **Saving preferences re-scores the profile** (§57) without rewriting it: only `profile.completionPercentage` is
  written with a targeted `updateOne`, so a preference save can never overwrite or race a profile edit.

## Photos & Kundli documents (step 08)

`photos` holds references, never binaries (spec §17), and every image a client sees is a Cloudinary *transformation*
so a discovery grid never receives an original multi-megabyte file (spec §18).

- **The upload is browser → Cloudinary, the authorization is server-side.** `POST /photos/sign` returns a
  signature, the public API key, a per-user folder and the format allowlist; the secret stays on the server (spec
  §43). The client uploads directly, then calls `POST /photos` to register the asset.
- **A registration is verified, not trusted.** The server asks Cloudinary what the asset actually is and refuses it
  unless it sits in the caller's own folder, is an allowed format and is inside the size cap. The byte count comes
  from the provider, so a client-declared size is irrelevant (spec §43). `url` in the request body is accepted for
  the documented shape but never stored — the row's URL is the provider's own `secure_url`.
- **Ownership is a filter.** Every mutation looks the row up by `{ _id, userId }`, so another account's photo is
  **404**, not 403: the response must not confirm that an asset exists (spec §44).
- **One primary per (user, type)**, enforced by a partial unique index; `setPrimary` clears the previous one first.
  New photos are `pending`, and only `approved` ones are eligible for a discovery card (spec §101).
- **Delete order is asset-then-reference.** If Cloudinary fails to destroy the asset the row survives and the API
  answers **503** (retryable); `not found` still clears the row. An orphaned file is never possible (task 10).
- **The public profile DTO carries `photos`**, filtered by the viewer's relationship: `matches_only` and `private`
  are absent for a non-match viewer, and a pending or rejected photo never appears (spec §112). A Kundli document is
  a different collection and is never in that list.
- **Kundli documents are their own collection** (decisions §6): `visibility` accepts only `private | matches_only`,
  the asset is uploaded as `authenticated` (no plain delivery URL), and the API mints a 5-minute signed URL for the
  owner. One document per account.
- **Configuration.** `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` are required
  together in production and refused as a partial set everywhere; `CLOUDINARY_MOCK=true` runs the flow against
  `src/config/localAssetStore.js` for development and the gate runner, and is refused in production and alongside
  real credentials. Without either, the photo and Kundli routes answer **503** rather than storing an upload they
  could not verify. Caps: `PHOTO_MAX_COUNT`, `PHOTO_MAX_BYTES`, `PHOTO_ALLOWED_FORMATS`, `PHOTO_SIGN_TTL_SECONDS`.

## Discover / search (step 09)

The read path the specification optimises for (spec §65, §82, §108): one pipeline serves `GET /discover`,
`GET /search` and `GET /recommendations`, reading only `matrimonial_profiles` with the card projection.

- **One pipeline, one difference.** `discover` loads the caller's `effectiveFilters()` (step 07) and overlays the
  request's explicit filters; `search` is the same pipeline **without** the preference merge, so an explicit filter
  set is honoured exactly. `age`/`heightCm` ranges merge bound-wise, so `?minAge=26` narrows the stored maximum
  rather than discarding it, and explicit input always wins over a stored default (spec §83).
- **No user-supplied key becomes a query key.** The builder never iterates the incoming filter object; it walks the
  constant tables in `constants/search.js` and writes the dotted path it was compiled with, so an object value
  (`gender[$ne]=male`), `$where`, `$regex` or an unknown parameter is rejected as a 400 at the boundary (spec §35,
  §46, §82 items 7 and 9). A `status` or `userId` parameter is not in the allowlist at all.
- **Mandatory predicate and exclusions come last.** `status: active` is written *after* the user filters and the
  exclusion set (`self`, blocked pairs, and — once steps 10/12 land — passed profiles) is applied as a top-level
  `userId: { $nin }`, so no crafted request can surface a draft, hidden, suspended, deleted or blocked profile
  (spec §56, §83, §99). `exclusionService.getExcludedUserIds()` is a stable seam: those steps extend it without
  touching the query shape, and `EXCLUSION_MAX_IDS` refuses an oversized block list rather than silently dropping an
  exclusion.
- **Age is converted, never stored** (spec §47): `minAge`/`maxAge` become inclusive `basic.dateOfBirth` boundaries
  against a fixed reference, so the range stays index-friendly, and `age` is recomputed at serialisation.
- **Distance search does not leak coordinates** (spec §48): a validated `lat`/`lng` builds a `$near` clause over the
  `location_2dsphere` index, `maxDistanceKm` is capped by `SEARCH_MAX_DISTANCE_KM`, and the response shows only the
  city — never the point.
- **Pagination is a key, not an offset** (spec §52): the cursor encodes the active sort key plus the unique `_id`
  tiebreak, so two rows sharing a `lastActiveAt` are still ordered exactly once with no overlap or gap; a tampered or
  wrong-sort cursor is a 400. `nextCursor` is returned only when a further page really exists (the query asks for one
  row more than the page), and `limit` is clamped to `SEARCH_MAX_LIMIT`.
- **Sorts are allowlisted** (spec §53): `recently_active` (`profile.lastActiveAt`), `newly_joined` (`createdAt`) and
  `recommended`. Anything else is a 400.
- **Ranking is deterministic and bounded** (spec §54, §55): the seven sub-scores in `RECOMMENDATION_WEIGHTS` (age 20,
  location 20, education 15, occupation 15, community 10, lifestyle 10, completeness 10 — asserted to sum to 100)
  rank a **candidate window** sized by `limit × 5` and capped by `SEARCH_CANDIDATE_CAP`; the whole collection is never
  scored. Cursor continuation inside that window is exact.
- **The card payload stays small** (spec §51, §66, §108): only the projected fields are read, no `populate()` chain
  runs, and the page's primary photo URLs are resolved in **one** extra query — a `publicId` minus the restricted
  fields, transformed to a card size via `cloudinaryUrl` (never the original). `projections.serializeCard()` computes
  `age`, formats height and carries `primaryPhoto` (`null` when no approved primary exists).
- **Configuration.** `SEARCH_DEFAULT_LIMIT` / `SEARCH_MAX_LIMIT` (default must not exceed max), `SEARCH_MAX_DISTANCE_KM`,
  `SEARCH_CANDIDATE_CAP`, `EXCLUSION_MAX_IDS`.

## Profile actions (step 10)

`profile_actions` records the four lightweight interactions a member has with another profile — `view`, `like`,
`shortlist`, `pass` — in their own collection so they never grow `matrimonial_profiles` (spec §20, §69). It answers
one question: *what has this account done to that one?*

- **One row per `(fromUserId, toUserId, type)`**, enforced by a unique index rather than a service check. Repeating a
  like or a shortlist is an upsert, not a second row, and a view is *also* one row per pair (decisions §15), so a hot
  profile cannot grow this collection without bound. Concurrent identical writes collapse to one row.
- **A view refreshes its timestamp.** `createdAt` is the pair's "last time", so the model explicitly makes it
  writable (Mongoose marks `createdAt` immutable under `timestamps`) and a repeat view updates it in place.
- **The rules are enforced before anything is written.** A self-action is **400**; a target that is not an `active`
  profile is **404** (a missing and a non-active target answer identically, so status cannot be probed); a blocked
  pair — either direction — is **404** and no row is created. The block check reads the same `exclusionService`
  interface Discover uses (spec §99).
- **The actor is never taken from the request.** `POST` rejects a body `userId`/`fromUserId` as an unknown field (spec
  §44); the target is named either by account id or by the public `publicProfileId`, and a `publicProfileId` is
  resolved to an account **server-side** — the response never echoes the internal id (spec §112, §113).
- **Listings are cards, not documents.** `GET /interactions?type=…` resolves the caller's own action rows and projects
  the referenced profiles through step 09's shared **card projection** and serialiser, so a shortlist renders the same
  shape as a discovery card and cannot leak a private field (spec §51, §70, §108, §112). Pagination is by the action
  row's `_id` (opaque, newest first) and `limit` is clamped to `INTERACTIONS_MAX_LIMIT`. "Who viewed me" is **not**
  exposed — the listing is always the caller's own outgoing actions (spec §112).
- **`pass` feeds Discover without changing its query shape** (spec §56, §99): `exclusionService` gained a `pass`
  source that returns ids for the existing `$nin` set, so step 09's builder needed no edit. The excluding type set is
  `DISCOVERY_EXCLUDED_TYPES` in `constants/actions.js` — one edit to also hide already-liked targets if the product
  wants that.
- **The activity signal is throttled.** Recording a view refreshes the target's `profile.lastActiveAt` only once per
  `VIEW_TOUCH_THROTTLE_MIN`, so a re-rendering client cannot cause a write storm (spec §20, §36).
- **Writes are rate limited per `(account, action type)`** (spec §36): a scripted like-burst cannot consume the view
  budget. The limiter runs after `requireAuth`, so the key is the real account, not an address.
- **No notifications are sent** (that is step 13). Recording emits a domain event on an in-process bus
  (`actionService.events`) that step 13 subscribes to for `profile_view` / `shortlisted` (spec §24).
- **Configuration.** `ACTION_RATE_LIMIT_WINDOW`, `ACTION_RATE_LIMIT_MAX`, `INTERACTIONS_DEFAULT_LIMIT`,
  `INTERACTIONS_MAX_LIMIT`, `VIEW_TOUCH_THROTTLE_MIN`.

## Interests / connections (step 11)

`connections` holds the formal handshake that turns a one-sided signal into a mutual match (spec §21). It is the
source of truth for a matching relationship, and the state machine is enforced entirely server-side — the client's
requested action is validated against the row's current status and never trusted (spec §91).

```text
send ──▶ pending ──accept(receiver)──▶ accepted ──close(either)──▶ closed
              │                          (canChat = true)          (canChat = false)
              ├─reject(receiver)──▶ rejected
              ├─withdraw(sender)──▶ withdrawn
              └─timeout(sweep)────▶ expired
```

- **One *open* relationship per pair, enforced by the database.** A **partial unique** `{ senderId, receiverId }`
  index restricted to `pending`/`accepted` is what makes a duplicate impossible under concurrency: the loser of a
  race gets a duplicate-key error the service translates into a clear **409**, never a 500. Terminal rows are
  history, so a **re-send after `rejected` / `withdrawn` / `expired` / `closed` creates a new row** and the old one is
  never mutated back to `pending` (decisions §8). *Note:* decisions §8 also lists `closed` among the index's active
  states, which contradicts its own re-send rule; the step's verification commands decide it (command 12 requires a
  new pending row after a closure), so `closed` is terminal here — see *Resolved ambiguities* in
  `../docs/steps/11-interests-connections.md`.
- **Authorization has three distinct answers.** An account that is neither participant gets **404** (never a 403 that
  would confirm the row exists); a participant with the wrong role — the sender trying to accept their own interest,
  the receiver trying to withdraw it — gets **403**; a legal actor asking for an illegal transition gets **409** with
  the row unchanged. The write itself is a conditional update keyed on the status that was read, so two concurrent
  responses cannot both win.
- **Chat is derived, never a client flag.** `connectionPolicy.canChat(userA, userB)` is true only for an `accepted`
  connection — in either direction, because the accepted row may have been sent by either account — and false for
  every other status, including `closed`. Step 14 calls it; step 14 needs no knowledge of connection internals.
- **A block or an administrative action closes for access without deleting history.** `closeForAccess()` moves an
  `accepted` row to `closed` (decisions §7); it is the seam step 12's block path and step 16's moderation path call,
  and calling it on a row that is already terminal is a no-op. A blocked pair can neither send nor respond in either
  direction (spec §22, §99), checked through the same `exclusionService` interface Discover uses.
- **Expiry runs lazily and is index-backed.** A read triggers a sweep at most once per
  `CONNECTIONS_SWEEP_INTERVAL_SECONDS`, and the sweep query is exactly the shape `{ status: 1, createdAt: 1 }`
  serves (`status: pending` + an age bound), so it never scans the collection. The count is logged, never returned.
- **Listings are cards, not documents.** `GET /connections` resolves the counterpart profiles through step 09's
  shared **card projection** and serialiser and attaches one nested `connection` object per row, so a list renders
  like a discovery card and can never leak a private field (spec §112). Neither account id is ever echoed, and
  pagination is by the connection row's `_id`. `box=sent|received` selects the caller's side — the direction may also
  be written `status=sent|received`, the spelling the step's own command 8 uses.
- **The optional note is bounded, plain text.** It is trimmed and capped by `INTEREST_MESSAGE_MAX_LEN`, and `<`/`>`
  are **refused** rather than stripped, so the stored value provably cannot begin markup (spec §34, §80).
- **Accept is authoritative over its notification.** No MongoDB transaction wraps the status change and the event:
  the connection update is the operation, the domain event is a side effect that can never block or roll back an
  acceptance (decisions §16). The service emits `interest_received` / `interest_accepted` / `interest_rejected` /
  `connection_closed` on `connectionService.events`; step 13 maps `interest_accepted` to exactly one `new_match`.
- **A crossing interest is a 409, not an auto-accept.** If `B` sends to `A` while `A`'s interest to `B` is still
  open, the request is a
  **409** with a hint naming the inbound interest. A mutual auto-accept is explicitly deferred by the step, so the
  service never silently converts one into the other.
- **Configuration.** `INTEREST_MESSAGE_MAX_LEN`, `INTEREST_RATE_LIMIT_WINDOW`, `INTEREST_RATE_LIMIT_MAX`,
  `INTEREST_EXPIRY_DAYS` (default 30 — no product value is published yet), `CONNECTIONS_DEFAULT_LIMIT`,
  `CONNECTIONS_MAX_LIMIT`, `CONNECTIONS_SWEEP_INTERVAL_SECONDS`.

## Safety: blocks & reports (step 12)

Two user-facing safety mechanisms (spec §22, §23). Blocking is not a UI preference — it changes discovery,
interest eligibility, chat access and notifications in **both** directions the moment it is written.

- **One `blocks` collection**, one document per `(blocker, blocked)` pair under a unique index, with an optional
  capped reason (`BLOCK_REASON_MAX_LEN`). Block is idempotent; self-block is a 400; unblock accepts the account id
  or the public profile id. `blockService.isBlockedEitherWay()` is the single predicate every other service asks
  (interests, actions, chat in step 14, notifications in step 13) — no step re-implements the rule.
- **Discovery exclusion** feeds the same `exclusionService` interface step 10's `pass` uses, so the discover query
  shape is unchanged and still plans `IXSCAN`. Both directions are cut (spec §56, §99). A block set larger than
  `EXCLUSION_MAX_IDS` is refused at the exclusion boundary rather than silently truncated.
- **`canChat` under a block is derived, not written.** The connection document is untouched — history is preserved
  and unblocking is a pure removal (decisions §7). The block service also treats an accepted connection as closed
  **for access** without flipping its status.
- **Notification suppression** is a `blockedPair` hook on the block service that step 13's dispatcher consults
  before delivering; the hook exists and is tested now (spec §22, §24).
- **One `reports` collection**, one document per case with the spec §23 category set, a length-capped description,
  bounded string `evidence`, and `open` status. The duplicate rule is a **refusal**: a second report on the same
  target while an earlier one is still `open` is a 409 (a counter would let one account flood the queue); after the
  case is `dismissed`, filing again is allowed.
- **Reporter privacy** (spec §112): the response and the caller's own list never expose admin state, and no user
  route can set `status`, `reviewedBy` or `reviewedAt` — the moderation queue and its transitions belong to step 16.
- **Rate limiting** (spec §36): separate buckets for block writes (`BLOCK_RATE_LIMIT_*`) and report writes
  (`REPORT_RATE_LIMIT_*`).
- **Configuration.** `BLOCK_REASON_MAX_LEN`, `BLOCK_RATE_LIMIT_WINDOW`, `BLOCK_RATE_LIMIT_MAX`,
  `REPORT_DESCRIPTION_MAX_LEN`, `REPORT_EVIDENCE_MAX_ITEMS`, `REPORT_EVIDENCE_MAX_LEN`,
  `REPORT_RATE_LIMIT_WINDOW`, `REPORT_RATE_LIMIT_MAX`.

## Notifications (step 13)

The in-app inbox (spec §24). It consumes the in-process domain events steps 10–12 already emit instead of
re-deriving them, so no business flow knows a notification exists.

- **One `notifications` collection**, one row per delivery: recipient, one of the nine spec §24 types, title,
  body, a small `data` payload of identifiers and `readAt`. `data` is a payload, never a copy of a profile or a
  message (spec §24, §112).
- **Events in, rows out.** `notificationEvents.js` subscribes to `actionService.events` and
  `connectionService.events` on load (wired from `app.js`), maps them data-drivenly, and runs every handler
  **detached** — a notification can never block or roll back an interest send or acceptance (decisions §16).
  `interest_accepted` maps to **exactly one** `new_match` row for the sender, `interest_rejected` to exactly one
  row for the sender with no private data (decisions §9, §10). `registerConnectionHandler` /
  `registerActionHandler` let steps 14/16 add `new_message`, `verification_completed` and `admin_alert` producers
  without touching the core service; `new_message` coalesces per conversation with the same mechanism views use.
- **Block suppression** (spec §22): every peer-type write consults `blockService.canNotify()` first and answers
  `suppressed` rather than storing anything. Admin-originated types have no peer actor and still deliver.
- **Bounded growth** (spec §36): `profile_view`, `shortlisted` and `new_message` coalesce per actor inside a
  configured window — the existing row is re-dated (driver-level update: Mongoose strips an explicit `createdAt`
  write) and un-read, so a re-rendering client cannot flood an inbox. A view outside the window creates one new row.
- **Owner-only reads** (spec §44): list, unread count and both mark-read routes are always scoped to
  `req.auth.userId`; a foreign id is a 404, never a 403. Mark-one is idempotent and keeps the first `readAt`.
- **Indexes** (spec §105): `{ userId, createdAt, _id }` serves the keyset-paginated inbox (the `_id` tiebreaker
  keeps the sort fully index-provided); `{ userId, readAt }` serves the unread filter and badge count. Both plans
  are asserted `IXSCAN`.
- **Configuration.** `NOTIFICATIONS_DEFAULT_LIMIT`, `NOTIFICATIONS_MAX_LIMIT`, `NOTIFY_VIEW_THROTTLE_MIN`,
  `NOTIFY_MESSAGE_COALESCE_MIN`, `NOTIFY_RATE_LIMIT_WINDOW`, `NOTIFY_RATE_LIMIT_MAX`.

## Subscription / entitlement (step 15)

The access-control point, built **before** any payment provider exists so nothing ever branches on one (spec §86,
§89, §114). The current phase is indefinite free access (finalized decisions §11, §12, §22).

- **One `subscriptions` collection**, one document per entitlement: owner, plan, status, source, `startedAt` and
  `expiresAt`. Registration grants `{ plan: "free", status: "active", source: "free_trial", expiresAt: null }` —
  **no expiry date is ever computed**, and `FREE_TRIAL_DAYS` is parsed but provably unused.
- **Exactly one active entitlement per user**, enforced by a **partial unique index** on `{ userId }` where
  `status: "active"`. `createFreeTrial()` is an idempotent upsert, so a retried registration hook, the backfill
  migration or several concurrent grants all leave one row (the five-way race is tested).
- **The one gate:** `entitlementService.hasFeatureAccess(userId, featureKey)` loads the active row once, resolves
  the plan's feature set from `constants/features.js`, and fails closed on an unknown key. Every declared feature
  is currently granted — nothing is gated (decisions §12). One indexed lookup per call, never one per feature.
- **The free plan cannot expire.** `expirePastDue()` transitions only rows with a non-null past-due `expiresAt`,
  served by the `{ status, expiresAt }` index; the sweep has no automatic caller because nothing is expirable in
  this phase. `GET /subscription` never resurrects a retired plan.
- **`GET /api/v1/subscription`** returns the caller's effective plan, status, source, dates and the resolved
  feature list. No input is accepted (`?plan=`, `?userId=` → 400), the account is always the session's, and an
  account with no subscription row at all (created before this step) is self-healed with the free grant.
- **No payment code:** every documented provider path answers 404, no file branches on a provider name, and no
  provider credential exists in the codebase or `.env.example`. The future webhook seam is the documented, callable
  `entitlementService.grant()` — which has no caller in this phase — and `payment_transactions` stays in the
  future-only collection list (spec §127).
- **Configuration.** `DEFAULT_FREE_PLAN`, `FREE_TRIAL_DAYS` (declared for a future explicit payment update only).

## Notes

- **Open security item:** the current development environment connects to Atlas with an `atlasAdmin` credential.
  Spec §39 requires a least-privilege application user (built-in `readWrite` scoped to the app database). See
  *Blocking security items* in `../docs/steps/00-progress-tracker.md`. `npm run check:db-privileges` reports the
  current verdict, prints the exact remediation and exits non-zero until it is fixed; no module under `src/` issues
  an administrative command (`listDatabases`, `connectionStatus`, `serverStatus`, `currentOp`), so `readWrite` on the
  application database is sufficient and the fix is entirely Atlas-side.
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
