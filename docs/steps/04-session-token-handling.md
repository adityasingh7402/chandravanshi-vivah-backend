---
step: 04
title: Session / Token Handling
status: audited_notes
build: built
audit: passed
depends_on: [03]
unblocks: [05, 15]
spec_refs: ["§7", "§30", "§31", "§37", "§40", "§41", "§44", "§79", "§105", "§110", "§121"]
---

# Step 04 — Session / Token Handling

## Goal

Give the API a verifiable identity for every protected request. The design is a short-lived access token plus a
longer-lived refresh/session mechanism (spec §7), with the refresh token stored only as a hash so a database leak
cannot be replayed. This step also introduces the authentication and role middleware that every later step depends
on, plus the `authenticatedUserId` source of truth that replaces any client-supplied user id (spec §31, §44).

## Scope

**In scope**

- `sessions` collection per spec §7.
- `tokenService`: sign access token, issue opaque refresh token, hash and store it, verify, rotate, revoke.
- Endpoints: `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`.
- Completing `POST /auth/login` to return an access token and set/return the refresh token.
- `middleware/auth.js` (requireAuth, optionalAuth) and `middleware/roles.js` (requireRole).
- Session revocation on password change (hooking into step 03).
- Transport rules: HttpOnly secure cookie for web, bearer header for mobile (spec §7, §41).

**Out of scope (do not build now)**

- Any profile, preference, or discovery route.
- WebSocket/chat authentication — the same middleware will be reused in step 14, but the socket layer is not built here.
- Device management UI (list/revoke individual sessions) — the data supports it, the UI is a later concern.

**Later**

- Refresh-token reuse detection with automatic family revocation.
- SSO / social login (not mentioned in the specification and not planned).

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| User model, hashing, register/login/change-password | 03 | `audited_passed` |
| Database connection and index conventions | 02 | `audited_passed` |

## Deliverables

```text
server/src/models/Session.js                     # spec §7 schema
server/src/services/tokenService.js              # sign/verify access, issue/rotate/revoke refresh
server/src/services/sessionService.js            # create, find, touch lastUsedAt, revoke, revokeAllForUser
server/src/middleware/auth.js                    # requireAuth, optionalAuth
server/src/middleware/roles.js                   # requireRole("admin","moderator")
server/src/controllers/session.controller.js     # refresh, logout, me
server/src/routes/session.routes.js              # mounted with auth.routes
server/src/utils/cookies.js                      # set/clear refresh cookie with correct flags
server/src/constants/errors.js                   # 401/403 codes reused by later steps
```

## Data model

### `sessions` (spec §7)

```js
{
  _id: ObjectId,
  userId: ObjectId,
  refreshTokenHash: String,
  deviceType: "web" | "android" | "ios",
  deviceName: String | null,
  createdAt: Date,
  lastUsedAt: Date,
  expiresAt: Date,
  revokedAt: Date | null
}
```

| Index | Definition | Purpose |
|---|---|---|
| `userId` | `{ userId: 1 }` | Load/revoke all sessions for a user |
| `refreshTokenHash` | `{ refreshTokenHash: 1 }`, unique | Look a session up by the presented token |
| `expiresAt` | `{ expiresAt: 1 }` | TTL or sweep query for expired sessions |

`refreshTokenHash` is marked `internal: true` so it can never be serialised into a response.

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/v1/auth/login` | public | Returns an access token; issues a refresh session |
| POST | `/api/v1/auth/refresh` | valid refresh token | Rotates the session and returns a new access token |
| POST | `/api/v1/auth/logout` | authenticated | Revokes the current session |
| GET | `/api/v1/auth/me` | authenticated | Returns the caller's account summary |

All protected routes resolve the user from the presented credential, never from a body or query parameter (spec §31, §44).

## Build tasks

- [x] 1. Install the JWT library and a secure random generator for the opaque refresh token; record the versions.
      *(jsonwebtoken 9.0.3; the opaque token uses Node's built-in `crypto.randomBytes`.)*
- [x] 2. Write `models/Session.js` with the schema and indexes above, applying the base plugin.
- [x] 3. Write `tokenService.signAccessToken(user)`: payload contains `sub` (user id), `role`, and a session id;
      expiry from `JWT_ACCESS_TTL`; the secret from `JWT_SECRET`. Never put profile or contact data in the payload.
- [x] 4. Write `tokenService.issueRefreshToken()`: generate a high-entropy opaque token, return the raw token to the
      caller once, and store only its hash.
- [x] 5. Write `tokenService.verifyAccessToken()`: verify signature, expiry, and issuer/audience; return a typed
      error for expired vs invalid so the client can distinguish them.
- [x] 6. Write `sessionService.create()`, `findByToken()` (hash the presented token, then look up), `touch()`
      (update `lastUsedAt`), `revoke()`, and `revokeAllForUser()`.
      *(`create` is named `startSession`; both exist as specified.)*
- [x] 7. Write `middleware/auth.js` `requireAuth`: extract the bearer token or the refresh cookie, verify, load the
      user, reject if the user is not `active` or if the session is revoked/expired, then attach
      `req.auth = { userId, role, sessionId }`.
- [x] 8. Write `middleware/roles.js` `requireRole(...roles)`: 403 when the authenticated role is not allowed
      (spec §28, §44). This is the only place role decisions are made.
- [x] 9. Write `utils/cookies.js`: `httpOnly`, `secure` in production, `sameSite` appropriate for the web origin,
      path scoped to the refresh endpoint. Never readable by JavaScript.
- [x] 10. Complete login to return the access token and issue a session; record `deviceType` from a validated
      request field and `deviceName` from a user-agent summary, never from a free-form trusted string.
- [x] 11. Implement `POST /auth/refresh` with rotation: verify the presented token, revoke the old session row, issue
      a new one, and return a fresh access token. Reuse of a rotated token is rejected.
- [x] 12. Implement `POST /auth/logout` (revoke current session) and `GET /auth/me` (sanitised account summary
      including `role`, `status`, `profileCreated`, `onboardingCompleted`).
- [x] 13. Hook `sessionService.revokeAllForUser()` into change-password so other sessions die on a credential change
      (spec §40).
- [x] 14. Apply `requireAuth` to `/auth/me`, `/auth/logout`, and `/auth/change-password`; leave register/login/refresh public.

## Business rules & security

- **Client-supplied identity is ignored.** Any `userId` in a body or query is rejected, not used (spec §31, §44).
- **Refresh tokens are stored hashed and rotated on every use** so a leaked database row is not a usable credential (spec §7).
- **No token in logs.** Access tokens, refresh tokens, cookies, and auth headers are redacted (spec §78).
- **Cookie hardening** for web; mobile keeps tokens in platform secure storage and sends the bearer header
  (spec §7).
- **Status gate:** `suspended`, `blocked`, and `deleted` users are rejected even with a valid token (spec §5).
- **Expiry discipline:** access tokens are short-lived; a 401 with an "expired" code tells the client to refresh.
- **CORS with credentials:** the allowlist from step 01 must be explicit, never a wildcard (spec §41).

## Config / environment additions

```text
JWT_ISSUER              # token issuer claim
JWT_AUDIENCE            # token audience claim
REFRESH_TOKEN_BYTES     # entropy size for the opaque refresh token
SESSION_TTL_DAYS        # refresh/session lifetime
                         # IMPLEMENTED AS: JWT_REFRESH_TTL is the single source of truth for the session-row
                         # lifetime, cookie max-age and rotation window (see config/env.js `session.ttlMs`).
                         # A separate SESSION_TTL_DAYS would allow the two lifetimes to disagree, so it was
                         # deliberately not introduced; sessionService uses config.session.ttlMs.
COOKIE_DOMAIN           # web cookie scope
COOKIE_SAME_SITE        # lax | strict | none
```

## Verification commands

```bash
# 1. Login returns an access token and sets/returns a refresh token
curl -sS -c /tmp/cj.txt -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"identifierType":"email","identifier":"user@example.com","password":"correct-horse-battery"}'
# Expected: 200 with an accessToken in data; refresh cookie present

ACCESS=$(curl -sS -X POST http://localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"identifierType":"email","identifier":"user@example.com","password":"correct-horse-battery"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.accessToken))")

# 2. Protected route without a token
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/auth/me
# Expected: 401

# 3. Protected route with a token
curl -sS -H "Authorization: Bearer $ACCESS" http://localhost:3000/api/v1/auth/me
# Expected: 200 with role/status; no hash, no email unless it is the caller's own

# 4. Tampered token
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer ${ACCESS}x" http://localhost:3000/api/v1/auth/me
# Expected: 401

# 5. Refresh rotation invalidates the old token
curl -sS -b /tmp/cj.txt -c /tmp/cj2.txt -X POST http://localhost:3000/api/v1/auth/refresh
# Expected: 200 with a new access token
curl -sS -o /dev/null -w '%{http_code}\n' -b /tmp/cj.txt -X POST http://localhost:3000/api/v1/auth/refresh
# Expected: 401 (old refresh token already rotated)

# 6. Logout revokes the session
curl -sS -b /tmp/cj2.txt -X POST http://localhost:3000/api/v1/auth/logout
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ACCESS" http://localhost:3000/api/v1/auth/me
# Expected: 401 once the session is revoked

# 7. Password change revokes other sessions
#   Log in twice to create two sessions, change the password with the first, then use the second.
# Expected: second session returns 401
```

## Audit checklist

### Gate 1 — Build integrity

- [x] **G1.1** Every deliverable exists; session routes are mounted; auth middleware is applied in the documented order.
      *(all 9 deliverable files present; `routes/index.js` mounts `auth.routes` then `session.routes` under `/auth`;
      `change-password` chain is limiter → `requireAuth` → `validateBody` → controller.)*
- [x] **G1.2** Server boots with `Session` loaded and indexes created. *(`verify-indexes.js` exit 0 listing
      `sessions.userId_1`, `sessions.refreshTokenHash_1`, `sessions.expiresAt_1`.)*
- [x] **G1.3** Steps 01–03 verification commands still pass, including register/login and the rate limit checks.
      *(step 01 live harness 11/11; step 03 live harness 12/12 including the 429 window check; `npm test` covers
      register/login/change-password. NOTE: step 02's own gate G3.2 still FAILS on the inherited `atlasAdmin`
      credential — see the blocker carried in the sign-off. The repo is not a git checkout, so git-based gate
      variants (e.g. `git grep`) are checked by direct filesystem search instead.)*

### Gate 2 — Functional

- [x] **G2.1** Login returns an access token and creates exactly one session row for the device.
      *(live: 200 + JWT; DB: exactly 1 row with `deviceType=web`, `deviceName` from UA, `revokedAt=null`.)*
- [x] **G2.2** `/auth/me` returns the caller's own summary and nothing more. *(live: own email/role/status/
      profileCreated/onboardingCompleted; no `passwordHash`, no `refreshTokenHash`, no `$argon2` in the body.)*
- [x] **G2.3** Refresh returns a new access token and rotates the stored refresh token.
      *(live: new cookie differs from the old; old hash revoked, new hash active — exactly 1 active row.)*
- [x] **G2.4** Reusing a rotated refresh token is rejected. *(live + tests: 401 `SESSION_REVOKED` for cookie and
      body transports.)*
- [x] **G2.5** Logout revokes only the current session; other active sessions continue to work.
      *(live: logged-out token 401 `SESSION_REVOKED`, sibling device still 200.)*
- [x] **G2.6** Change-password revokes all other sessions for that user.
      *(live: keeper survives, other device 401 `SESSION_REVOKED`, its refresh token dead, exactly 1 active row;
      `tests/session.test.js` repeats with three sessions.)*
- [x] **G2.7** An expired access token and an invalid access token produce distinguishable, documented responses.
      *(live + unit: expired → 401 `TOKEN_EXPIRED`; tampered/garbage/wrong-secret → 401 `TOKEN_INVALID`.)*
- [x] **G2.8** A user whose `status` is set to `suspended` is rejected on the next protected request even with a
      previously valid token. *(live: 200 → suspend → 403 `ACCOUNT_INACTIVE`; refresh and re-login also refused.)*

### Gate 3 — Security

- [x] **G3.1** No protected route accepts a `userId` from the body or query; supplying one changes nothing.
      *(live: `?userId=<other>` still reports the token's owner; a `userId` body field is rejected 400 by the
      strict schema — rejected, not merely ignored.)*
- [x] **G3.2** `requireRole` returns 403 for a `user` hitting an admin-only path, and the role is read from the
      token/server, never the request body. *(tests: 401 anonymous, 403 for `user` even with `?role=admin` and
      `x-role: admin`; the SAME token flips to 200 only after the server grants the role in the database — proving
      the decision is server-side. Note: no admin route exists yet in the live app, so the guard was exercised
      through a purpose-built mount using the documented middleware order.)*
- [x] **G3.3** Refresh tokens are absent from responses as plaintext where unnecessary, are stored only as hashes,
      and never appear in logs. *(live: web login/refresh carry no body token; DB holds only a sha256 hex digest;
      log scan for all 15 tokens minted during the run → 0 matches; mobile transport returns the token in the body
      by design, for platform secure storage.)*
- [x] **G3.4** The web refresh cookie is `HttpOnly` and `Secure` in production and is not readable by client scripts.
      *(live: `HttpOnly; SameSite=Lax; Path=/api/v1/auth/refresh`; `Secure` tracks `NODE_ENV` — asserted via
      `config.cookie.secure === config.isProduction`, so the production path is covered without faking an env.)*
- [x] **G3.5** A token signed with a different secret, a token with a modified role claim, and an unsigned
      `alg: none` token are all rejected. *(tests also cover wrong issuer, wrong audience, and non-HS256 algorithm
      confusion; algorithm pinned to HS256 in both sign and verify.)*
- [x] **G3.6** CORS still refuses disallowed origins when credentials are in play (spec §41).
      *(live: evil origin → no ACAO; allowlisted origin → exact reflection + `Allow-Credentials: true`, never `*`.
      This step changed `credentials: false → true` to carry the cookie; the explicit allowlist keeps it safe.)*

### Gate 4 — Performance & data

- [x] **G4.1** Refresh lookup uses the unique `refreshTokenHash` index (`IXSCAN`).
      *(live `explain('queryPlanner')` on the exact hash query → `IXSCAN`, no `COLLSCAN`.)*
- [x] **G4.2** `requireAuth` performs a bounded lookup: token verify plus one user read, no unbounded populate.
      *(session `findById` + user `findById`, both point lookups; source assertion: no `.populate(`, no bare
      `.find()` in `middleware/auth.js` or `services/sessionService.js`.)*
- [x] **G4.3** Expired sessions are cleaned up by a TTL index or a documented sweep, not by scanning the whole collection.
      *(live: `expiresAt_1` with `expireAfterSeconds: 0`; `verify-indexes.js` exit 0.)*

### Gate 5 — Spec conformance

- [x] **G5.1** §7 — the session document matches the documented fields; raw refresh tokens are not stored.
      *(schema asserted field-for-field including `internal: true` on `refreshTokenHash`; live row contains the
      sha256 hash, never the raw value.)*
- [x] **G5.2** §7 / §41 — web cookies are secure/HttpOnly; mobile uses secure storage plus bearer tokens.
      *(web: HttpOnly cookie scoped to the refresh endpoint; mobile: `deviceType` android/ios gets the token in
      the body for platform storage, and `deviceName` derives from the user-agent, never a trusted free-form field.)*
- [x] **G5.3** §31 / §44 — identity and role come from server-side session data only.
      *(`req.auth` is built from the verified token + DB session + DB user; see G3.1/G3.2.)*
- [x] **G5.4** §30 — `/auth/me` omits restricted fields and never returns the hash.
      *(`toPublic()` is the only shape emitted; asserted no `passwordHash`/`refreshTokenHash`/`$argon2`. The access
      token payload carries only `sub`, `role`, `sid`, `iat`, `exp`, `iss`, `aud` — asserted against the decoded JWT.)
- [x] **G5.5** §40 — sessions are revoked/restricted after a sensitive account change. *(G2.6 live evidence.)*
- [x] **G5.6** §105 — the `sessions.userId` and `sessions.expiresAt` indexes exist. *(`verify-indexes.js` exit 0.)*
- [x] **G5.7** §121 — the logout/revoke and invalid/expired token tests are covered.
      *(`tests/session.test.js` + `tests/token.test.js`; 119/119 total suite.)*

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

- [x] Every protected route can identify the caller without trusting the client.
- [x] Refresh rotates and old tokens stop working.
- [x] Session revocation works on logout and on password change.
- [x] No credential material is retrievable from a response or a log.
- [x] Downstream steps have a single, reusable `requireAuth` + `requireRole` pair.

## Sign-off

| Field | Value |
|---|---|
| Auditor | Buffy (automated audit) |
| Date | 2026-10-08 |
| Verdict | PASS WITH NOTES |
| Evidence | `npm run lint` exit 0; `npm test` 119/119 pass 0 skipped; `node verify-step04.mjs` 26/26 live checks (run twice: once with raised rate limits, once under the default `AUTH_RATE_LIMIT_MAX=10`); step 01 regression 11/11; step 03 regression 12/12; `node scripts/verify-indexes.js` exit 0 with `sessions.userId_1`/`sessions.refreshTokenHash_1`/`sessions.expiresAt_1` present; refresh `explain()` → `IXSCAN`; log scan for all 15 minted tokens → 0 matches. |
| Fixes required | None blocking in step 04 code. **Three notes:** (1) **Inherited blocker** — step 02 gate **G3.2 still FAILS**: the app connects to Atlas as `atlasAdmin`, not a least-privilege application user (spec §39). Every later step inherits this until the credential is replaced; unchanged by this step. (2) The repo is **not a git checkout**, so git-based gate variants (`git grep`) were checked with direct filesystem search instead. (3) Found and fixed during this audit: the error handler passed `body.code` where the machine-readable `code` sat **beside** `body`, so no failure envelope carried a `code` field at all — the typed 401/403 codes (`TOKEN_EXPIRED` vs `TOKEN_INVALID`, `SESSION_REVOKED`, `ACCOUNT_INACTIVE`, `FORBIDDEN`) would have been invisible to clients. Fixed in `middleware/errorHandler.js` and pinned by both the tests and the live harness. |
