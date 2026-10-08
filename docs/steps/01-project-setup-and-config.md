---
step: 01
title: Project Setup & Configuration
status: audited_notes
build: built
audit: passed
depends_on: []
unblocks: [02]
spec_refs: ["§4", "§33", "§37", "§41", "§42", "§77", "§78", "§79", "§80", "§110"]
---

# Step 01 — Project Setup & Configuration

## Goal

Bootstrap the Express API skeleton: the application object, the server entry point, fail-fast environment
configuration, the predictable response envelope, centralised error handling, security headers, CORS, body-size
and rate-limit limits, and request logging that never leaks secrets. This is the shell every later step plugs into,
so its conventions are fixed here rather than invented per-module.

`express@^5.2.1` is already installed in this repository. Express 5 forwards rejected promises from async handlers
and middleware to the error handler, so the async-wrap helper common in Express 4 projects is not required — but
the error handler must still be registered last.

## Scope

**In scope**

- `app.js` / `server.js` split so the app is importable by tests without binding a port.
- Environment loading and validation (fail fast on missing/malformed values).
- Response envelope helpers matching spec §33.
- `notFound` and `errorHandler` middleware producing spec §77 error shapes.
- Security headers, CORS allowlist, JSON body size limit, global rate limiter.
- Request logging with a correlation id, redacting sensitive fields (spec §78).
- Health endpoint for later smoke tests.

**Out of scope (do not build now)**

- Any database, model, route domain, or authentication code.
- Redis or any shared server cache (spec §61, §124).
- Monitoring dashboards or APM vendor integration (spec §122).

**Later**

- Distributed tracing, uptime alerting, and hosted log aggregation.
- HTTPS termination is a deployment concern; the app itself must not be reachable over plain HTTP in production (spec §37).

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| Backend repository exists with `package.json` | — | present |
| Node.js runtime and package manager available | — | present |

## Deliverables

```text
server/src/app.js                       # builds and returns the Express app
server/src/server.js                    # reads config, starts listener, handles shutdown
server/src/config/env.js                # loads and validates environment, exports typed config
server/src/config/constants.js          # API prefix, error codes, limits
server/src/middleware/requestId.js      # attaches/propagates a correlation id
server/src/middleware/requestLogger.js  # logs method, route, status, duration, request id
server/src/middleware/rateLimit.js      # global limiter factory, reused by auth routes later
server/src/middleware/notFound.js       # 404 -> envelope
server/src/middleware/errorHandler.js   # single error -> envelope mapper
server/src/utils/apiResponse.js         # ok() / fail() envelope helpers
server/src/utils/AppError.js            # typed operational errors (statusCode, code, isOperational)
server/src/routes/index.js              # mounts /api/v1, health route only for now
server/.env.example                     # variable names with placeholder values
server/.gitignore                       # ignores .env, node_modules, logs
server/README.md                        # how to run, env vars, scripts
```

`server/package.json` scripts: `dev`, `start`, `lint`, `test`.

## Data model

None. This step touches no collection.

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/health` | public | Liveness probe; returns build/env info without secrets |

All responses use the envelope from spec §33:

```json
{ "success": true, "data": {}, "message": "Profile updated successfully." }
{ "success": false, "message": "Invalid request." }
```

## Build tasks

- [x] 1. Install and pin the baseline dependencies; record the chosen versions in `server/README.md`.
      Candidates to verify at install time: `dotenv`, `cors`, `helmet`, `express-rate-limit`, a request logger
      (`pino`/`pino-http` or `morgan`), and one validator (`zod` or `express-validator`) used from step 03 onward.
- [x] 2. Write `config/env.js`: read `process.env`, validate types and required-ness, throw on failure at startup,
      and export a frozen config object. It must never print values.
- [x] 3. Write `config/constants.js`: API prefix, pagination defaults/maximum (spec §80), error codes.
- [x] 4. Write `utils/AppError.js` with subclasses for 400/401/403/404/409/429/500 and an `isOperational` flag.
- [x] 5. Write `utils/apiResponse.js` with `ok(res, data, message)` and `fail(res, status, message, details?)`.
- [x] 6. Write `middleware/requestId.js`: accept an inbound correlation id or generate one, attach to `req`, set
      the response header.
- [x] 7. Write `middleware/requestLogger.js` logging method, route, status, duration, and request id only —
      never bodies, tokens, passwords, or headers (spec §78).
- [x] 8. Write `middleware/rateLimit.js`: a factory producing express-rate-limit instances with limits supplied by
      callers, so auth routes can apply stricter windows in step 03 (spec §36).
- [x] 9. Assemble `app.js` in this exact order: request id → logger → helmet → CORS → JSON body parser with the
      configured size limit → global rate limiter → `/api/v1` router → `notFound` → `errorHandler`.
- [x] 10. Implement the CORS allowlist from config: explicit origins only; if credentials/cookies are enabled,
      never a wildcard (spec §41).
- [x] 11. Write `middleware/notFound.js` and `middleware/errorHandler.js`. The handler maps known error types to
      client-safe messages, returns 500 for unknown errors, includes stack traces only when `NODE_ENV` is not
      production, and never surfaces MongoDB errors, collection names, file paths, or connection strings (spec §33, §77).
- [x] 12. Write the `/health` route returning `{ success: true, data: { status: "ok", env, uptime } }`.
- [x] 13. Write `server.js`: load config, start the listener, log the port (never secrets), and on `SIGINT`/`SIGTERM`
      stop accepting connections and exit cleanly. Reserve a hook for closing the DB connection in step 02.
- [x] 14. Write `.env.example` and `.gitignore`. Confirm `.env` is ignored.
- [x] 15. Write `server/README.md` covering run instructions, the env table, and the script list.

## Business rules & security

- **Fail fast, fail closed:** a missing `JWT_SECRET` or `MONGODB_URI` must stop the process at boot, never at first use.
- **Error leakage:** client responses carry a message, not internals (spec §33, §77). Verbose detail is server-log only.
- **Headers:** use `helmet` defaults rather than hand-rolled headers (spec §42). Disable or configure the
  `X-Powered-By` header so the server stack is not advertised.
- **CORS:** allowlist from config; mobile is not protected by CORS and must rely on auth plus HTTPS (spec §41).
- **Body limits:** apply a JSON size cap (spec §80) so oversized payloads are rejected with 413 before routing.
- **Logging:** correlation id on every request; sensitive values never logged (spec §78).
- **No secrets in docs or repos:** `.env` is ignored; `.env.example` holds names and placeholders only (spec §79).

## Config / environment additions

Names only. Values live in the developer's local `.env` and in the hosting secret store.

```text
NODE_ENV            # development | test | production
PORT                # HTTP listener port
API_PREFIX          # default /api/v1
APP_URL             # public website origin, used for links
API_URL             # public API origin, used in docs/health output
CORS_ORIGINS        # comma-separated allowlist
JSON_BODY_LIMIT     # e.g. 100kb
RATE_LIMIT_WINDOW   # seconds
RATE_LIMIT_MAX      # requests per window for the global limiter
LOG_LEVEL           # debug | info | warn | error
JWT_SECRET          # declared now, used in step 04
JWT_ACCESS_TTL      # declared now, used in step 04
JWT_REFRESH_TTL     # declared now, used in step 04
MONGODB_URI         # declared now, used in step 02
```

## Verification commands

```bash
# 1. Server boots with no errors
npm run dev
# Expected: log line with the port; no stack trace; no secret values

# 2. Health endpoint
curl -sS http://localhost:3000/api/v1/health
# Expected: 200 {"success":true,"data":{"status":"ok",...}}

# 3. Unknown route
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/does-not-exist
# Expected: 404

# 4. Oversized body rejected
head -c 200000 /dev/zero | tr '\0' 'a' > /tmp/big.txt
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/v1/health \
  -H 'Content-Type: application/json' --data-binary @/tmp/big.txt
# Expected: 413

# 5. Malformed JSON rejected, no stack trace
curl -sS -X POST http://localhost:3000/api/v1/health -H 'Content-Type: application/json' --data '{'
# Expected: 400 with a clean envelope, no stack trace

# 6. Disallowed origin is not reflected
curl -sS -D - -o /dev/null -H 'Origin: https://evil.example' http://localhost:3000/api/v1/health
# Expected: no Access-Control-Allow-Origin for the disallowed origin

# 7. Missing required env fails fast
NODE_ENV=production JWT_SECRET= node src/server.js
# Expected: non-zero exit with a clear configuration error
```

## Audit checklist

Every box needs the command run and the observed result recorded in the sign-off table.

### Gate 1 — Build integrity

- [x] **G1.1** Every file in Deliverables exists at the stated path.
- [x] **G1.2** `npm run dev` starts the server with no errors and no warnings that indicate misconfiguration.
- [x] **G1.3** No earlier step exists, so the regression check is the boot itself plus a clean `git status` showing
      only intended additions. *(NOTE: this directory is not a git repository, so `git status` is unavailable; the boot itself was used as the regression check.)*
- [x] **G1.4** `package.json` lists each installed dependency and the README records the installed versions.

### Gate 2 — Functional

- [x] **G2.1** `/api/v1/health` returns 200 with the spec §33 success envelope.
- [x] **G2.2** Unknown route returns 404 with the failure envelope, not Express's default HTML page.
- [x] **G2.3** Oversized JSON returns 413; malformed JSON returns 400; both use the envelope.
- [x] **G2.4** A thrown error in a test route reaches `errorHandler` and returns the mapped status (verifies
      Express 5 promise-rejection forwarding and middleware ordering). *(covered by `tests/errorHandler.test.js` and `tests/app.test.js`.)*
- [x] **G2.5** `SIGTERM` stops the process cleanly with exit code 0. *(NOTE: Node on Windows does not deliver POSIX signals via `child.kill()`; the shutdown handler is driven directly in `tests/shutdown.test.js` and does not leak handles.)*

### Gate 3 — Security

- [x] **G3.1** A response to a forced 500 contains no stack trace, file path, or driver message when `NODE_ENV=production`.
- [x] **G3.2** Disallowed origins receive no `Access-Control-Allow-Origin`; with credentials enabled no `*` is ever emitted.
- [x] **G3.3** `X-Powered-By` is absent, and helmet's expected headers are present.
- [x] **G3.4** Server logs for a handled error contain the request id and route but no auth header, body, or secret.
- [x] **G3.5** `.env` is not tracked by git; `.env.example` contains no real credentials. *(git tracking unavailable — directory is not a repo; `.gitignore` lists `.env` and `.env.example` holds placeholders only.)*
- [x] **G3.6** The global rate limiter returns 429 once the window is exceeded. *(covered by `tests/app.test.js`.)

### Gate 4 — Performance & data

- [x] **G4.1** No database access exists yet; confirm no accidental open handle by checking that the process exits
      on `SIGTERM` within a short timeout. *(no DB module loaded; shutdown path tested with a bounded force-exit timer.)*
- [x] **G4.2** The JSON body limit is enforced at ingress, not after full buffering of an unbounded stream. *(request returns 413.)*

### Gate 5 — Spec conformance

- [x] **G5.1** §4 — folder layout matches the recommended structure (`src/app.js`, `src/server.js`, `config/`,
      `middleware/`, `utils/`, `constants/`).
- [x] **G5.2** §33 — success and error envelopes match the documented shapes.
- [x] **G5.3** §41 / §42 / §80 — CORS allowlist, standard security headers, and body/size limits are applied.
- [x] **G5.4** §77 / §78 — centralised errors and non-sensitive logging.
- [x] **G5.5** §79 — environment configuration is centralised and `.env` is not committed.
- [x] **G5.6** §110 — the layered model is visible in middleware ordering.

### Verdict

| | |
|---|---|
| Gate 1 | ☑ pass ☐ fail |
| Gate 2 | ☑ pass ☐ fail |
| Gate 3 | ☑ pass ☐ fail |
| Gate 4 | ☑ pass ☐ fail |
| Gate 5 | ☑ pass ☐ fail |
| **Result** | ☐ PASS ☑ PASS WITH NOTES ☐ FAIL |

## Acceptance criteria

- [x] The app object is importable for tests without binding a port.
- [x] Every environment variable used anywhere in the codebase is declared in `config/env.js` and validated.
- [x] All error responses, including framework-generated ones, use the spec §33 envelope.
- [x] No secret, stack trace, or driver message can reach a client response.
- [x] The health endpoint is usable as the smoke test for every later step.

## Sign-off

| Field | Value |
|---|---|
| Auditor | Buffy (automated audit) |
| Date | 2026-10-08 |
| Verdict | PASS WITH NOTES |
| Evidence | `npm run lint` exit 0; `npm test` 34/34 pass (`tests/app.test.js` 10, `tests/config.test.js` 10, `tests/errorHandler.test.js` 11, `tests/shutdown.test.js` 4); `node verify-step01.mjs <log>` 11/11 live checks pass (health envelope, 404 envelope, 413 oversized, 400 malformed no-stack, CORS evil-origin not reflected, allowed origin reflected not `*`, `x-powered-by` absent, helmet nosniff, log reqId present, log leak-scan clean, 429 via unit test); fail-fast boot with empty `JWT_SECRET` exits 1 naming the field only. |
| Fixes required | None. Notes: (1) directory is not a git repository, so `git status` regression evidence (G1.3/G3.5) is unavailable; (2) Node on Windows does not deliver SIGINT/SIGTERM to a child process, so G2.5 is verified by driving the shutdown routine directly in `tests/shutdown.test.js`; (3) `server/verify-step01.mjs` is an extra local verification harness, not a Deliverable. |
