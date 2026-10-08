---
step: 04
title: Session / Token Handling
status: not_started
build: not_started
audit: not_run
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

- [ ] 1. Install the JWT library and a secure random generator for the opaque refresh token; record the versions.
- [ ] 2. Write `models/Session.js` with the schema and indexes above, applying the base plugin.
- [ ] 3. Write `tokenService.signAccessToken(user)`: payload contains `sub` (user id), `role`, and a session id;
      expiry from `JWT_ACCESS_TTL`; the secret from `JWT_SECRET`. Never put profile or contact data in the payload.
- [ ] 4. Write `tokenService.issueRefreshToken()`: generate a high-entropy opaque token, return the raw token to the
      caller once, and store only its hash.
- [ ] 5. Write `tokenService.verifyAccessToken()`: verify signature, expiry, and issuer/audience; return a typed
      error for expired vs invalid so the client can distinguish them.
- [ ] 6. Write `sessionService.create()`, `findByToken()` (hash the presented token, then look up), `touch()`
      (update `lastUsedAt`), `revoke()`, and `revokeAllForUser()`.
- [ ] 7. Write `middleware/auth.js` `requireAuth`: extract the bearer token or the refresh cookie, verify, load the
      user, reject if the user is not `active` or if the session is revoked/expired, then attach
      `req.auth = { userId, role, sessionId }`.
- [ ] 8. Write `middleware/roles.js` `requireRole(...roles)`: 403 when the authenticated role is not allowed
      (spec §28, §44). This is the only place role decisions are made.
- [ ] 9. Write `utils/cookies.js`: `httpOnly`, `secure` in production, `sameSite` appropriate for the web origin,
      path scoped to the refresh endpoint. Never readable by JavaScript.
- [ ] 10. Complete login to return the access token and issue a session; record `deviceType` from a validated
      request field and `deviceName` from a user-agent summary, never from a free-form trusted string.
- [ ] 11. Implement `POST /auth/refresh` with rotation: verify the presented token, revoke the old session row, issue
      a new one, and return a fresh access token. Reuse of a rotated token is rejected.
- [ ] 12. Implement `POST /auth/logout` (revoke current session) and `GET /auth/me` (sanitised account summary
      including `role`, `status`, `profileCreated`, `onboardingCompleted`).
- [ ] 13. Hook `sessionService.revokeAllForUser()` into change-password so other sessions die on a credential change
      (spec §40).
- [ ] 14. Apply `requireAuth` to `/auth/me`, `/auth/logout`, and `/auth/change-password`; leave register/login/refresh public.

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

- [ ] **G1.1** Every deliverable exists; session routes are mounted; auth middleware is applied in the documented order.
- [ ] **G1.2** Server boots with `Session` loaded and indexes created.
- [ ] **G1.3** Steps 01–03 verification commands still pass, including register/login and the rate limit checks.

### Gate 2 — Functional

- [ ] **G2.1** Login returns an access token and creates exactly one session row for the device.
- [ ] **G2.2** `/auth/me` returns the caller's own summary and nothing more.
- [ ] **G2.3** Refresh returns a new access token and rotates the stored refresh token.
- [ ] **G2.4** Reusing a rotated refresh token is rejected.
- [ ] **G2.5** Logout revokes only the current session; other active sessions continue to work.
- [ ] **G2.6** Change-password revokes all other sessions for that user.
- [ ] **G2.7** An expired access token and an invalid access token produce distinguishable, documented responses.
- [ ] **G2.8** A user whose `status` is set to `suspended` is rejected on the next protected request even with a
      previously valid token.

### Gate 3 — Security

- [ ] **G3.1** No protected route accepts a `userId` from the body or query; supplying one changes nothing.
- [ ] **G3.2** `requireRole` returns 403 for a `user` hitting an admin-only path, and the role is read from the
      token/server, never the request body.
- [ ] **G3.3** Refresh tokens are absent from responses as plaintext where unnecessary, are stored only as hashes,
      and never appear in logs.
- [ ] **G3.4** The web refresh cookie is `HttpOnly` and `Secure` in production and is not readable by client scripts.
- [ ] **G3.5** A token signed with a different secret, a token with a modified role claim, and an unsigned
      `alg: none` token are all rejected.
- [ ] **G3.6** CORS still refuses disallowed origins when credentials are in play (spec §41).

### Gate 4 — Performance & data

- [ ] **G4.1** Refresh lookup uses the unique `refreshTokenHash` index (`IXSCAN`).
- [ ] **G4.2** `requireAuth` performs a bounded lookup: token verify plus one user read, no unbounded populate.
- [ ] **G4.3** Expired sessions are cleaned up by a TTL index or a documented sweep, not by scanning the whole collection.

### Gate 5 — Spec conformance

- [ ] **G5.1** §7 — the session document matches the documented fields; raw refresh tokens are not stored.
- [ ] **G5.2** §7 / §41 — web cookies are secure/HttpOnly; mobile uses secure storage plus bearer tokens.
- [ ] **G5.3** §31 / §44 — identity and role come from server-side session data only.
- [ ] **G5.4** §30 — `/auth/me` omits restricted fields and never returns the hash.
- [ ] **G5.5** §40 — sessions are revoked/restricted after a sensitive account change.
- [ ] **G5.6** §105 — the `sessions.userId` and `sessions.expiresAt` indexes exist.
- [ ] **G5.7** §121 — the logout/revoke and invalid/expired token tests are covered.

### Verdict

| | |
|---|---|
| Gate 1 | ☐ pass ☐ fail |
| Gate 2 | ☐ pass ☐ fail |
| Gate 3 | ☐ pass ☐ fail |
| Gate 4 | ☐ pass ☐ fail |
| Gate 5 | ☐ pass ☐ fail |
| **Result** | ☐ PASS ☐ PASS WITH NOTES ☐ FAIL |

## Acceptance criteria

- [ ] Every protected route can identify the caller without trusting the client.
- [ ] Refresh rotates and old tokens stop working.
- [ ] Session revocation works on logout and on password change.
- [ ] No credential material is retrievable from a response or a log.
- [ ] Downstream steps have a single, reusable `requireAuth` + `requireRole` pair.

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence | |
| Fixes required | |
