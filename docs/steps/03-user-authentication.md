---
step: 03
title: User & Authentication
status: not_started
build: not_started
audit: not_run
depends_on: [02]
unblocks: [04]
spec_refs: ["§3.4", "§5", "§6", "§30", "§34", "§36", "§40", "§79", "§81", "§84", "§110", "§117", "§121"]
---

# Step 03 — User & Authentication

## Goal

Implement the account layer: the `users` collection, password hashing, and registration. The account controls
authentication only; matchmaking data lives in a separate profile document (spec §3.4). This step deliberately
implements **no** OTP, email verification, or phone verification (spec §6, §84), and **no** self-service password
reset, because an unverified identifier is not a trustworthy identity proof (spec §6).

Login is listed here for completeness but its token issuance depends on step 04. This step is audited on
registration, identifier normalisation, uniqueness, hashing, and validation; the login flow is audited in step 04.

## Scope

**In scope**

- `users` schema per spec §5, with the partial unique indexes from step 02.
- Password hashing service (Argon2id or bcrypt) — never plain text (spec §40).
- Identifier normalisation for email and phone before storage and lookup.
- `POST /api/v1/auth/register` per spec §117: `identifierType` + `identifier` + `password`.
- `POST /api/v1/auth/login`: verify credentials and delegate token issuance to step 04's service.
- `POST /api/v1/auth/change-password`: requires the current password and an authenticated session (spec §6, §40).
- Request validators for the three bodies, rejecting unexpected fields.
- Strict rate limiting on register and login (spec §36).
- Audit-log entries for sensitive account actions, deferring the `audit_logs` model to step 16 if it is not yet built.

**Out of scope (do not build now)**

- Refresh tokens, logout, `GET /me`, session storage — all step 04.
- Forgot-password / self-service reset (spec §6).
- OTP, email verification, phone verification (spec §6, §85).
- Profile creation and onboarding.

**Later**

- Email/phone verification and the verified badge (spec §85).
- Admin-initiated password reset, logged as a support action (spec §6, §29).

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| App skeleton, config, error handler, validators available | 01 | `audited_passed` |
| Database connection and index conventions | 02 | `audited_passed` |

## Deliverables

```text
server/src/models/User.js                        # spec §5 schema
server/src/services/passwordService.js           # hash(), verify(), needsRehash()
server/src/services/authService.js               # register(), verifyCredentials(), changePassword()
server/src/controllers/auth.controller.js        # request/response only
server/src/routes/auth.routes.js                 # register, login, change-password
server/src/validators/auth.validators.js         # body schemas + unknown-field rejection
server/src/utils/identifier.js                   # normaliseEmail(), normalisePhone(), detectType()
server/src/constants/auth.js                     # allowed role/status enum values
```

## Data model

### `users` (spec §5)

```js
{
  _id: ObjectId,
  email: String | null,
  phone: String | null,
  passwordHash: String,
  role: { type: String, enum: ["user", "admin", "moderator"], default: "user" },
  status: { type: String, enum: ["active", "suspended", "blocked", "deleted"], default: "active" },
  profileCreated: { type: Boolean, default: false },
  onboardingCompleted: { type: Boolean, default: false },
  lastLoginAt: Date,
  createdAt: Date,
  updatedAt: Date
}
```

| Index | Definition | Purpose |
|---|---|---|
| `email` partial unique | `{ email: 1 }`, partial on `$type: "string"` | Unique when present, many absences allowed |
| `phone` partial unique | `{ phone: 1 }`, partial on `$type: "string"` | Same |

`passwordHash` is marked `internal: true` so the step-02 JSON transform removes it, and a `select: false`
equivalent is applied so it is not loaded by default.

### Validation matrix

| Rule | Detail | Spec ref |
|---|---|---|
| Identifier presence | At least one of email/phone, and exactly one per spec §117 request | §5, §117 |
| Email format | Validated and lowercased/trimmed before storage | §34 |
| Phone format | Normalised to E.164 before storage | §34 |
| Password length | Minimum length from config; reject clearly too-short values | §40, §81 |
| Unknown fields | Rejected, not ignored | §34 |

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/v1/auth/register` | public | Create a `users` document |
| POST | `/api/v1/auth/login` | public | Verify credentials; issues tokens via step 04 |
| POST | `/api/v1/auth/change-password` | authenticated | Requires current password |

## Build tasks

- [ ] 1. Install the password-hashing library (Argon2id preferred, bcrypt acceptable) and record the version and
      chosen cost parameters in the README.
- [ ] 2. Write `models/User.js`: schema per spec §5, apply the base plugin, mark `passwordHash` internal and
      non-selected by default, and declare the partial unique indexes.
- [ ] 3. Write `utils/identifier.js`: trim + lowercase email; normalise phone to E.164 using a country default from
      config; return a normalised value plus the resolved type; throw a typed error on unusable input.
- [ ] 4. Write `services/passwordService.js` with `hash()`, `verify()` (constant-time), and `needsRehash()` so the
      cost can be raised later without a data migration.
- [ ] 5. Write `services/authService.js` `register()`: normalise identifier → check existence → hash password →
      create the user with defaults → return a sanitised user object. Handle duplicate-key errors as a 409 with the
      message from spec §77's example ("A profile with this email already exists.").
- [ ] 6. Write `authService.verifyCredentials()`: find by normalised identifier, compare with the hash, and return a
      single generic "Invalid credentials" error for both unknown identifier and wrong password (no account
      enumeration on the login path). Update `lastLoginAt` on success.
- [ ] 7. Write `authService.changePassword()`: require the current password to verify, store the new hash, and record
      an audit entry. Note in a comment that step 04 revokes other sessions here (spec §40).
- [ ] 8. Write `validators/auth.validators.js`: register (identifierType enum, identifier, password rules),
      login, change-password (current + new, new must differ). Reject unknown fields.
- [ ] 9. Write `middleware/rateLimit.js` instances for register and login with tighter limits than the global one
      (spec §36) and apply them to the routes.
- [ ] 10. Write `controllers/auth.controller.js` and `routes/auth.routes.js`. Controllers orchestrate; services hold
      the logic (spec §94, §95).
- [ ] 11. Mount the auth router under `/api/v1`.

## Business rules & security

- **Never store or return plain passwords or hashes** (spec §40, §5). The response body for a created user contains
  `id`, `role`, `status`, `profileCreated` — never `passwordHash`.
- **No account enumeration on login:** one generic error for both failure modes. Registration necessarily reveals a
  duplicate, which is acceptable and expected (spec §77).
- **No unverified recovery:** do not add any reset flow that trusts an unverified email or phone (spec §6).
- **Rate limiting is mandatory here** because there is no OTP (spec §36).
- **Identifier normalisation before storage and lookup** prevents `User@x.com` and `user@x.com` becoming two accounts.
- **Role is server-decided.** A `role` in the request body is rejected by the validator, never honoured (spec §31, §44).
- **Sensitive logging:** passwords and hashes never appear in logs (spec §78, §40).

## Config / environment additions

```text
PASSWORD_MIN_LENGTH        # minimum accepted password length
ARGON2_MEMORY/ITERATIONS   # or BCRYPT_COST, depending on the chosen algorithm
DEFAULT_PHONE_COUNTRY      # ISO country code used when normalising phone identifiers
AUTH_RATE_LIMIT_WINDOW     # login/register window, seconds
AUTH_RATE_LIMIT_MAX        # attempts per window
```

## Verification commands

```bash
# 1. Register with email
curl -sS -X POST http://localhost:3000/api/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"identifierType":"email","identifier":"user@example.com","password":"correct-horse-battery"}'
# Expected: 201 success envelope, no passwordHash in data

# 2. Register with phone
curl -sS -X POST http://localhost:3000/api/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"identifierType":"phone","identifier":"+919999999999","password":"correct-horse-battery"}'
# Expected: 201

# 3. Duplicate email
#   Re-run command 1. Expected: 409 with a clear duplicate message, no driver/stack detail

# 4. Neither email nor phone
curl -sS -X POST http://localhost:3000/api/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"password":"correct-horse-battery"}'
# Expected: 400 validation error

# 5. Unknown field / attempted privilege escalation
curl -sS -X POST http://localhost:3000/api/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"identifierType":"email","identifier":"a@b.com","password":"correct-horse-battery","role":"admin"}'
# Expected: 400 unknown field rejected; no admin created

# 6. Login, wrong password
curl -sS -X POST http://localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"identifierType":"email","identifier":"user@example.com","password":"wrong"}'
# Expected: 401 generic "Invalid credentials"

# 7. Login attempt rate limit
for i in $(seq 1 30); do curl -sS -o /dev/null -w '%{http_code} ' -X POST \
  http://localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"identifierType":"email","identifier":"user@example.com","password":"x"}'; done; echo
# Expected: 401s then 429s

# 8. Hash is never stored in plain text
#   Inspect the created document directly in MongoDB. Expected: passwordHash present, password absent,
#   and the hash does not equal the submitted password.
```

## Audit checklist

### Gate 1 — Build integrity

- [ ] **G1.1** Every deliverable exists; `auth.routes.js` is mounted under `/api/v1`.
- [ ] **G1.2** Server boots with the new models loaded and no schema warnings.
- [ ] **G1.3** Steps 01 and 02 verification commands still pass (health, 404, 413, boot, index script).

### Gate 2 — Functional

- [ ] **G2.1** Registration with email returns 201 and the document is persisted with the expected defaults.
- [ ] **G2.2** Registration with phone normalises to E.164 and persists the normalised form.
- [ ] **G2.3** Duplicate email and duplicate phone each return 409 with a clean message.
- [ ] **G2.4** Case/whitespace variants of the same email are treated as one account, not two.
- [ ] **G2.5** Requests with neither identifier, both identifiers when only one is expected, a malformed email, a
      malformed phone, or a too-short password each return 400 with a field-level message.
- [ ] **G2.6** Login with a correct password succeeds and updates `lastLoginAt`; wrong password and unknown
      identifier return the **same** 401 message.
- [ ] **G2.7** Change-password fails with a wrong current password and succeeds with the correct one; the new
      password verifies afterwards and the old one no longer does.
- [ ] **G2.8** Rate limits trigger 429 within the configured window on both register and login.

### Gate 3 — Security

- [ ] **G3.1** No response to register, login, or change-password contains `passwordHash` or `password`.
- [ ] **G3.2** A `role: "admin"` supplied in the request body does not produce an admin account.
- [ ] **G3.3** Unknown fields are rejected rather than ignored (spec §34).
- [ ] **G3.4** No log line contains a submitted password or a stored hash (spec §78).
- [ ] **G3.5** Login errors do not distinguish "no such account" from "wrong password" (spec §36, §40).
- [ ] **G3.6** There is no self-service password-reset route anywhere in the router (spec §6).
- [ ] **G3.7** Passwords are stored only as a strong one-way hash; direct inspection confirms no plaintext column
      or field.
- [ ] **G3.8** An ObjectId-shaped or object-shaped identifier is rejected before any query runs (spec §35).

### Gate 4 — Performance & data

- [ ] **G4.1** Login and register lookups use the unique indexes; `explain()` on the identifier lookup shows `IXSCAN`.
- [ ] **G4.2** `passwordHash` is not loaded on paths that never verify it.
- [ ] **G4.3** There is no unbounded `find()` anywhere in the auth service.

### Gate 5 — Spec conformance

- [ ] **G5.1** §5 — schema fields, enums, and defaults match exactly.
- [ ] **G5.2** §6 / §84 — the MVP authentication limitation is honoured: no OTP, no verification, no untrusted reset.
- [ ] **G5.3** §36 — register, login, and change-password are rate limited.
- [ ] **G5.4** §40 — hashing, no plaintext, no hash leakage, current-password requirement.
- [ ] **G5.5** §94 / §95 — controller/service/model separation is respected.
- [ ] **G5.6** §117 — the register request shape matches the documented example.
- [ ] **G5.7** §121 — the authentication test list is covered by the functional checks above.

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

- [ ] A user can register with email or phone and is created with `role: "user"`, `status: "active"`.
- [ ] Identifier normalisation makes duplicate detection reliable.
- [ ] Credentials are verified without enabling account enumeration.
- [ ] No plaintext password or hash is ever persisted in a response or log.
- [ ] Rate limiting is demonstrably active on both register and login.

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence | |
| Fixes required | |
