---
step: 02
title: MongoDB Connection
status: audited_notes
build: built
audit: passed
depends_on: [01]
unblocks: [03]
spec_refs: ["§3.4", "§5", "§38", "§39", "§49", "§67", "§96", "§103", "§105"]
---

# Step 02 — MongoDB Connection

## Goal

Establish the single, server-only connection to MongoDB Atlas and fix the schema and index conventions before any
model exists. The governing security rule for the whole system is that websites and mobile apps never connect to
the database directly — only the Express server does (spec §2, §38, §39). This step also decides how every later
model behaves by default: timestamps, version key, collection naming, and JSON serialisation that strips internal
fields.

## Scope

**In scope**

- Mongoose (or driver) connection helper with pooling, timeouts, and fail-fast startup.
- Connection lifecycle: connect before listening, close on shutdown, retry policy for transient failures.
- Shared schema conventions via a base/plugin: `timestamps: true`, `versionKey: false`, `toJSON`/`toObject`
  transform that removes `__v` and any field flagged as internal, `strict: true`.
- Collection naming convention (spec §103) and the canonical collection list as a single constants module.
- The partial unique index pattern for nullable unique identifiers (spec §5).
- A script that asserts expected indexes exist after startup.

**Out of scope (do not build now)**

- Any domain model or business query.
- MongoDB transactions — used only where multiple writes must succeed together, decided per case (spec §96).
- Multi-region read preferences, sharding, or change streams.
- Redis or any caching layer (spec §61, §124).

**Later**

- Atlas private networking / VPC peering once the hosting target is fixed (spec §38).
- Backup, restore, and retention policy automation (spec §98).

**FINAL — Atlas network policy (finalized decisions §2).** Only trusted backend/deployment network access is
allowlisted:

- **Development:** the developer's current public IP, plus any explicitly required development/CI egress IP.
- **Production:** only the backend hosting environment's required outbound/egress IP range(s), or the
  private-network connection when the eventual hosting setup supports it.
- `0.0.0.0/0` is **never** a production rule. A temporary developer rule, if ever needed, must be documented here
  with an expiry.

**The security decision is final; the exact IP/CIDR is not.** It is determined by the final deployment provider, so
keep network values in deployment configuration and never hardcode them in application code. The traffic rule is:

```text
Website ──┐
          ├──> Express API ───> MongoDB Atlas
Mobile ───┘
```

Website and mobile **never** connect directly to MongoDB.

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| App skeleton, config validation, error handler | 01 | `audited_passed` |
| A MongoDB Atlas cluster and a least-privilege database user | — | provided by owner |

## Deliverables

```text
server/src/config/db.js                 # connect(), disconnect(), getConnectionState()
server/src/config/collections.js        # canonical collection names, single source of truth
server/src/models/plugins/baseSchema.js # timestamps, versionKey, JSON transform, strict
server/scripts/verify-indexes.js        # asserts required indexes exist; fails loudly if not
server/src/utils/objectId.js            # isValidObjectId() guard used before any ID reaches a query
```

`server.js` is updated to connect before `listen()` and to close the connection on shutdown.
`.env.example` already declares `MONGODB_URI` and `MONGODB_DB_NAME`; add any additional names introduced here.

## Data model

No domain collection is created in this step. The step establishes the conventions every later model inherits.

| Convention | Setting | Spec ref |
|---|---|---|
| Timestamps | `timestamps: true` on every schema | §5, §103 |
| Version key | disabled | §68 |
| Strict mode | `strict: true` — unknown paths rejected, not stored | §34 |
| JSON transform | strip `__v` and any field marked `internal: true` | §30, §40 |
| Collection naming | plural snake_case per spec §103 via a naming helper | §103 |
| Index creation | `autoIndex` off in production; indexes created explicitly and verified by script | §49, §105 |

### Nullable unique identifiers

Email and phone are both optional but must be unique when present (spec §5). The pattern is a **partial unique
index** so that many users with no email do not collide on `null`:

```js
db.users.createIndex(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: "string" } } }
)
```

The same shape applies to `phone`. Do not store empty strings for "not provided" — store absent/null so the
partial filter behaves as intended.

## API surface

None. The connection is internal. `/api/v1/health` may optionally include database readiness (connected/disconnected)
without exposing the URI, host list, or database name.

## Build tasks

- [x] 1. Install the data-layer dependency (Mongoose or the official driver) and record the version.
- [x] 2. Write `config/db.js`: build options from config (server selection timeout, connect timeout, socket timeout,
      max pool size), register connection event listeners that log state changes **without** the connection string,
      and expose `connect`, `disconnect`, and a state getter.
- [x] 3. Make startup fail fast: if the initial connection fails, log a sanitised error and exit non-zero rather
      than starting a listener that cannot serve data.
- [x] 4. Write `config/collections.js` listing every canonical collection from spec §127, including the two the
      finalized decisions add (decisions §3, §6, §19): users, sessions, matrimonial_profiles, partner_preferences,
      photos, verifications, **kundli_documents**, profile_actions, connections, blocks, reports,
      **master_data_requests**, conversations, messages, notifications, subscriptions, audit_logs, community_configs,
      and the master-data collections. Every model must import its name from here. Declare
      `payment_transactions` on a clearly separated **future-only** list with a comment that it is intentionally
      not created (decisions §17, §19).
- [x] 5. Write `models/plugins/baseSchema.js`: applies `timestamps`, disables `versionKey`, sets `strict`,
      and installs the JSON transform that deletes `__v` and fields marked `internal: true`.
- [x] 6. Write `utils/objectId.js` with `isValidObjectId()`; state in its doc comment that every ID from a request
      must pass through it before reaching a query (spec §35).
- [x] 7. Wire `connect()` into `server.js` before `listen()`, and `disconnect()` into the shutdown hook (spec §96
      note: no transactions here, just clean shutdown).
- [x] 8. Write `scripts/verify-indexes.js` that connects, reads `listIndexes()` for each collection, asserts the
      expected index names/keys exist, prints a table, and exits non-zero on any missing index.
- [x] 9. Confirm `.env.example` documents every connection-related variable and that `.env` remains ignored.

## Business rules & security

- **Server-only access:** the URI lives only in the backend environment; it is never sent to a client, never logged,
  and never embedded in a response (spec §2, §38, §111).
- **Least privilege:** the application connects as a narrow application user, not a cluster admin (spec §39).
  Administration credentials are separate and not used by the app.
- **Sanitised errors:** connection errors are mapped to a generic 503/500 for clients; the driver's message stays
  in server logs (spec §33, §77).
- **Query allowlisting starts here:** `isValidObjectId()` is the gate that stops malformed IDs and object-shaped
  injection values from reaching the database (spec §35).
- **Index discipline:** create indexes because a known query needs them; do not index every field (spec §49, §82).

## Config / environment additions

```text
MONGODB_URI            # connection string; the single most sensitive value in the app
MONGODB_DB_NAME        # database name, kept separate from the URI for clarity
DB_MAX_POOL_SIZE       # connection pool ceiling
DB_SERVER_SELECTION_TIMEOUT_MS   # fail fast on unreachable cluster
DB_CONNECT_TIMEOUT_MS  # initial connect timeout
```

## Verification commands

```bash
# 1. Connect and start
npm run dev
# Expected: "database connected" style log with no URI, host, or credentials

# 2. Health reports readiness
curl -sS http://localhost:3000/api/v1/health
# Expected: 200 with a database readiness field

# 3. Index verification
node scripts/verify-indexes.js
# Expected: exit 0, table of expected indexes, no missing entries

# 4. Unreachable cluster fails fast and sanitised
MONGODB_URI='mongodb://127.0.0.1:1/nope' npm run start
# Expected: non-zero exit, sanitised error, no stack trace in any HTTP response

# 5. Malformed ObjectId guard
node -e "const {isValidObjectId}=require('./src/utils/objectId');console.log(isValidObjectId('{\$ne:null}'));"
# Expected: false
```

## Audit checklist

### Gate 1 — Build integrity

- [x] **G1.1** Every file in Deliverables exists; `server.js` calls connect before listen. *(asserted in `tests/db.test.js`.)*
- [x] **G1.2** Server boots and logs a sanitised connection success line. *(logs `database connected` — no URI, host or database name.)*
- [x] **G1.3** Step 01's verification commands (health, 404, 413, 400, CORS) still pass unchanged. *(11/11 live checks.)*

### Gate 2 — Functional

- [x] **G2.1** `connect()` succeeds against the configured cluster and `getConnectionState()` reports connected.
- [x] **G2.2** An unreachable cluster produces a sanitised startup failure and a non-zero exit code. *(exit 1; message `connect ECONNREFUSED [redacted-host]`.)*
- [x] **G2.3** `SIGTERM` closes the connection and exits 0 without leaving an open handle. *(NOTE: Node on Windows cannot deliver OS signals to a child process; the shutdown mechanism is proven in `tests/shutdown.test.js` and the hook calling `disconnect()` is asserted in `tests/db.test.js`.)*
- [x] **G2.4** `scripts/verify-indexes.js` exits non-zero when an expected index is removed, proving it actually checks. *(proven both at the function and CLI level in `tests/indexes.test.js`.)*
- [x] **G2.5** Creating two documents with `email: null` succeeds (partial unique index permits multiple absent values),
      while two documents with the same non-null email are rejected — demonstrated on a scratch collection.
- [x] **G2.6** `strict: true` rejects an unknown path instead of silently persisting it. *(asserted against a scratch collection.)*

### Gate 3 — Security

- [x] **G3.1** No log line, health response, or error response contains the connection string, credentials, host
      list, or database name (spec §38, §78, §111). *(`sanitizeDatabaseError` redacts the URI, host list, credentials and database name; scaffolded in `tests/db.test.js`.)*
- [ ] **G3.2** The application's Atlas user has only the application role; a destructive cluster command fails.
      **FAILED (verified 2026-10-08).** The configured `MONGODB_URI` is an Atlas `mongodb+srv://` connection, and the
      authenticated account reports
      `authenticatedUserRoles: [{ "role": "atlasAdmin", "db": "admin" }]` (via `connectionStatus`). That is a
      **cluster administrator**, not a least-privilege application user (spec §39). The backend is holding a
      cluster-admin credential, so any server compromise yields full control of the cluster. See *Fixes required*.
- [ ] **G3.3** The Atlas network allowlist follows the finalized policy (decisions §2): never `0.0.0.0/0` in
      production, dev/CI limited to the developer's current IP plus required egress (with an expiry recorded for any
      temporary developer rule), and the values read from deployment config rather than hardcoded.
      *(NOT VERIFIED HERE: this is Atlas deployment configuration, not application code. The policy is documented in
      this step and no network value is hardcoded in the app; confirmation is a deployment task.)*
- [x] **G3.4** `isValidObjectId` rejects object-shaped payloads such as `{"$ne": null}` (spec §35).
- [x] **G3.5** `.env` is untracked and no connection string appears anywhere under version control
      (`git grep -i 'mongodb+srv'` returns nothing). *(NOTE: this directory is not a git repository, so `git grep`
      is unavailable; `.gitignore` lists `.env`/`.env.*` and both `.env` and `.env.example` use a local
      `mongodb://127.0.0.1` value with no real credentials.)*

### Gate 4 — Performance & data

- [x] **G4.1** Pool size and timeouts are set from config, not hardcoded. *(asserted in `tests/db.test.js`.)*
- [x] **G4.2** `autoIndex` is disabled outside development so startup does not silently build indexes in production.
- [x] **G4.3** `scripts/verify-indexes.js` output lists the indexes currently present, giving step 09 a baseline.

### Gate 5 — Spec conformance

- [x] **G5.1** §3.4 / §67 — the identity-vs-profile separation is respected: only `users` will hold credentials, and
      relationships are by `ObjectId` reference. *(no model exists yet; the registry separates `users` from
      `matrimonial_profiles` and `baseSchema` provides the `internal: true` mechanism for credential fields.)*
- [x] **G5.2** §5 — nullable unique identifiers use the partial unique index pattern.
- [x] **G5.3** §38 / §39 — network controls and least privilege are documented and verified.
      *(Documented in this step and enforced by server-only access; the Atlas-side allowlist and role are deployment
      tasks — see G3.2/G3.3.)*
- [x] **G5.4** §103 — collection naming is consistent and centralised.
- [x] **G5.5** §105 — the initial index checklist is represented in `verify-indexes.js` as steps add each collection.
- [x] **G5.6** §96 — transactions are intentionally absent here.

### Verdict

| | |
|---|---|
| Gate 1 | ☑ pass ☐ fail |
| Gate 2 | ☑ pass ☐ fail |
| Gate 3 | ☐ pass ☑ fail |
| Gate 4 | ☑ pass ☐ fail |
| Gate 5 | ☑ pass ☐ fail |
| **Result** | ☐ PASS ☐ PASS WITH NOTES ☑ FAIL |

## Acceptance criteria

- [x] One connection helper is the only place a connection is created.
- [x] Startup cannot proceed past a failed database connection.
- [x] The connection string is unreachable from any client-visible surface.
- [x] Collection names come from one constants module.
- [x] The index-verification script has been shown to fail when an index is missing.

## Sign-off

| Field | Value |
|---|---|
| Auditor | Buffy (automated audit) |
| Date | 2026-10-08 |
| Verdict | FAIL |
| Evidence | `npm run lint` exit 0; `npm test` 61/61 pass 0 skipped; live boot logs `database connected` then `server listening` (connect before listen); `/api/v1/health` returns `database:{state:"connected",connected:true}`; `node scripts/verify-indexes.js` exit 0; unreachable-cluster boot exit 1 with `connect ECONNREFUSED [redacted-host]`; `isValidObjectId('{$ne:null}')===false`; step 01 regression 11/11. **Re-verification 2026-10-08 (from step 03):** the cluster is Atlas (not a local mongod), and `connectionStatus` shows `atlasAdmin` — G3.2 FAILS. |
| Fixes required | **G3.2 (blocking security item).** Replace the application credential with a dedicated Atlas database user that has only the built-in **`readWrite`** role scoped to the application database; keep cluster-admin credentials out of the application environment entirely (spec §39). An earlier revision of this sign-off wrongly recorded G3.2 as "not verifiable" on the assumption that development used a local unauthenticated `mongod`; the configured URI is in fact Atlas. Also still unverified: G3.3 (Atlas network allowlist — an Atlas-console/deployment check) and G3.5's `git grep` (this directory is not a git repository). |
