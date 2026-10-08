---
step: 18
title: Security Review
status: not_started
build: not_started
audit: not_run
depends_on: [17]
unblocks: []
spec_refs: ["§2", "§30", "§31", "§34", "§35", "§36", "§37", "§38", "§39", "§40", "§41", "§42", "§43", "§44", "§45", "§51", "§59", "§64", "§77", "§78", "§79", "§80", "§91", "§110", "§111", "§112", "§113", "§121", "§126"]
---

# Step 18 — Security Review

## Goal

Verify the whole system against the specification's security model end to end, rather than trusting each step's own
audit. The specification describes ten layers in which no single layer is sufficient (spec §110), so this step tests
every layer and, critically, re-tests the earlier steps whose passes this review could invalidate.

This step produces a written review with evidence and a findings list. It does not add features.

## Scope

**In scope**

- Full-surface negative testing across every route.
- Object-level authorization matrix (every resource × every relationship).
- Data-exposure verification of every response shape.
- Injection, validation, and rate-limit testing.
- Secrets, headers, CORS, HTTPS, and log-hygiene verification.
- Dependency and configuration review.
- Re-verification of earlier steps (regression per the tracker watchlist).
- A written findings report with severity and owners.

**Out of scope (do not build now)**

- Third-party penetration testing or compliance certification.
- Fixing findings beyond recording them; fixes belong to the owning step and must be re-audited there.
- Provider-specific payment security, since no provider exists yet (spec §89).

**Later**

- External penetration test before public launch.
- Automated security scanning in CI once a baseline exists.

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| All functionality built and performance-verified | 17 | `audited_passed` |
| A staging environment with representative data | — | available |

## Deliverables

```text
server/security/authorization-matrix.md     # resource x relationship expectations and results
server/security/findings.md                 # findings with severity, evidence, owner
server/security/checklist.md                # the completed layered checklist below
server/tests/security/*.test.js             # automated negative tests where practical
```

## Data model

No new collection. This step reads the existing surface and may add automated tests under `tests/security/`.

## API surface

None. This step creates no route and changes no response shape; it reviews the surface built in steps 01–17. Any
finding that requires a route change belongs to the owning step and must be fixed and re-audited there.

## Business rules & security

The rules that govern how this review itself is conducted:

- **Review, do not change.** This step adds tests and reports only. A finding is recorded and assigned to the owning
  step; it is never silently patched here, so the fix can be re-audited against its own acceptance criteria.
- **Evidence or it did not happen.** Every "verified" item cites the request sent and the response observed. Untested
  areas are listed as untested (spec §121, §123).
- **Test through the interface the user uses.** Authorization and exposure checks are made against the HTTP API with
  real tokens, not by reading the code (spec §31, §44, §91).
- **Negatives over positives.** The review's value comes from the checks that must fail: anonymous access, wrong owner,
  wrong role, malformed input, injected filters, and restricted-field absence (spec §34, §35, §112).
- **A finding downgrades a pass.** Any finding touching an earlier step removes that step's `audited_passed` verdict
  until the fix is re-audited, and the tracker's audit log records the re-run (spec §110 — no single layer suffices).
- **No production testing.** The review runs against staging with representative data; no destructive test is run
  against production data (spec §98).
- **No secrets in the report.** Findings quote redacted evidence where the original value is sensitive (spec §78, §79).

## The layered model to verify (spec §110)

```text
HTTPS
 ↓  CORS / origin controls
 ↓  Rate limiting
 ↓  Authentication
 ↓  Role authorization
 ↓  Request validation
 ↓  Business-rule authorization
 ↓  Allowlisted MongoDB query construction
 ↓  MongoDB Atlas network controls
 ↓  Least-privilege database user
```

Each layer is verified independently **and** the combination is tested, because a request can pass one layer and be
stopped by the next by design.

## Authorization matrix (spec §44)

For every resource, test the four relationships. Expected results are fixed before testing; deviations are findings.

| Resource | Anonymous | Owner | Other authenticated user | Admin | Moderator |
|---|---|---|---|---|---|
| Own profile | 401 | full own view / edit | n/a | permitted | permitted |
| Another profile | 401 | n/a | permitted public view, no private fields | permitted | permitted |
| Profile edit (someone else's) | 401 | n/a | 404/403, no change | permitted, audited | 404/403 unless allowed |
| Preferences | 401 | full | 404/403 | permitted | permitted |
| Photos (list/mutate) | 401 | own only | 404 on another user's photo | permitted, audited | permitted for moderation |
| Interactions | 401 | own only | 404 on another's action | n/a | n/a |
| Connections | 401 | participant only | 404 as non-participant | n/a | n/a |
| Conversations / messages | 401 | participant and eligible | 404 as non-participant | n/a | n/a |
| Blocks / reports | 401 | own only | 404 | permitted | permitted |
| Notifications | 401 | own only | 404 | permitted | permitted |
| Subscription | 401 | own only | 404 | permitted, read-only | 404 |
| Master data (read) | permitted | permitted | permitted | permitted | permitted |
| Master data (write) | 401 | 403 | 403 | permitted, audited | 403 |
| Admin routes | 401 | 403 | 403 | permitted, audited | per-route |

Every cell must be tested and its result recorded.

## Build tasks

- [ ] 1. Write `security/authorization-matrix.md` with the expectations above filled in for this implementation,
      then execute every cell and record the observed result next to it.
- [ ] 2. Write automated negative tests under `tests/security/` for the checks that are cheap to repeat: cross-account
      access, role escalation, object-shaped inputs, malformed ids, and restricted-field absence.
- [ ] 3. Execute the data-exposure suite: for each response type, grep the actual JSON for every restricted field and
      confirm absence (spec §30, §51, §59, §112).
- [ ] 4. Execute the injection suite: object-shaped filter values, `$`-prefixed keys, array-where-string-is-expected,
      and oversized payloads on every route that accepts input (spec §34, §35).
- [ ] 5. Execute the rate-limit suite against every limited route and confirm the limits trigger and recover
      (spec §36).
- [ ] 6. Verify the transport and header layers: HTTPS-only in production, helmet headers present, `X-Powered-By`
      absent, CORS allowlist correct including with credentials (spec §37, §41, §42).
- [ ] 7. Verify secret hygiene: scan the repository for credentials, confirm `.env` is untracked, confirm
      `.env.example` holds only placeholders, and confirm no secret appears in logs (spec §79, §78).
- [ ] 8. Verify the database layers: Atlas network controls reviewed, the application user is least-privilege, and no
      client-visible surface exposes the URI or database name (spec §38, §39, §111).
- [ ] 9. Verify the password and session layers: hashing parameters, no hash leakage, no account enumeration, session
      revocation after password change, and no untrusted reset path (spec §6, §7, §40).
- [ ] 10. Verify the upload layer: signature scoping, type/size validation, ownership, and private-photo visibility
      (spec §43, §112).
- [ ] 11. Run a dependency audit and record any advisory, its severity, and the plan (spec §124 lists required
      technology; keep it current).
- [ ] 12. Re-run the G1 and G3 checks of every step on the tracker regression watchlist, and record the re-run results.
- [ ] 13. Compile `security/findings.md`: each finding with severity, evidence, affected step, and owner. A finding
      that affects an earlier step downgrades that step from `audited_passed` until it is fixed and re-audited.
- [ ] 14. Complete `security/checklist.md` as the layered checklist below is worked through.

## Verification: restricted and public data (spec §30, §112)

**Must never appear in a non-admin, non-owner response**

```text
passwordHash            refreshTokenHash        email (of another user)
phone (of another user) exact coordinates       exact residential address
birthTime               private horoscope details
identity verification data   admin notes       audit information
JWT/refresh tokens      CLOUDINARY_API_SECRET   MONGODB_URI
```

**Expected on public/discovery surfaces**

```text
profileId, firstName, age, height, city, degree, occupation, surname, gotra,
primary photo, verification badge, last-active summary
```

## Verification commands

```bash
# 1. No restricted field appears on a discovery response
curl -sS -H "Authorization: Bearer $ACCESS" 'http://localhost:3000/api/v1/discover?limit=50' \
  | grep -oE '"(passwordHash|email|phone|coordinates|birthTime|refreshTokenHash)"' | sort -u
# Expected: no output

# 2. No restricted field appears on another user's profile
curl -sS -H "Authorization: Bearer $ACCESS" http://localhost:3000/api/v1/profile/<otherPublicId> \
  | grep -oE '"(email|phone|birthTime|coordinates)"' | sort -u
# Expected: no output

# 3. Role escalation
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/admin/users -H "Authorization: Bearer $USER"
# Expected: 403

# 4. Object-shaped injection on a discover filter
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ACCESS" \
  'http://localhost:3000/api/v1/discover?gender[$ne]=male'
# Expected: 400

# 5. Malformed id
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ACCESS" \
  http://localhost:3000/api/v1/profile/not-an-id
# Expected: 400/404, no driver error

# 6. Rate limit
for i in $(seq 1 50); do curl -sS -o /dev/null -w '%{http_code} ' -X POST \
  http://localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"identifierType":"email","identifier":"user@example.com","password":"x"}'; done; echo
# Expected: 401s then 429s

# 7. Headers
curl -sS -D - -o /dev/null https://<api-host>/api/v1/health
# Expected: helmet headers present, no X-Powered-By, HSTS present in production

# 8. Secret scan
git grep -nEi '(mongodb\+srv|api[_-]?secret|jwt[_-]?secret[=:]\s*[A-Za-z0-9])' -- . \
  ':(exclude).env.example' ':(exclude)*.md' || echo 'clean'
# Expected: clean

# 9. Dependency audit
npm audit --production
# Expected: no high/critical advisories, or each recorded with a plan

# 10. Log hygiene
git grep -nE '(console\.(log|error)\(.*(password|token|secret))' -- server/src || echo 'clean'
# Expected: clean
```

## Audit checklist

### Gate 1 — Build integrity

- [ ] **G1.1** The review artifacts exist; automated security tests run.
- [ ] **G1.2** The staging environment matches the documented configuration (env vars present, indexes applied).
- [ ] **G1.3** Steps 01–17 verification commands still pass before the review starts, so findings are attributable.

### Gate 2 — Functional (of the review itself)

- [ ] **G2.1** Every cell of the authorization matrix has a tested, recorded result.
- [ ] **G2.2** Every restricted field is checked against the real response of every relevant endpoint.
- [ ] **G2.3** Every limited route is exercised to confirm the limit triggers and recovers.
- [ ] **G2.4** Injection payloads are tried on every input-accepting route, not a sample.
- [ ] **G2.5** The dependency audit ran and its output is recorded.
- [ ] **G2.6** The report distinguishes verified items from untested ones; nothing is marked verified without evidence.

### Gate 3 — Security

- [ ] **G3.1** Anonymous access is refused on every protected route (401).
- [ ] **G3.2** Wrong-owner access is refused on every resource route (403/404 as designed).
- [ ] **G3.3** Wrong-role access is refused on every admin route, with moderators correctly limited.
- [ ] **G3.4** No restricted field appears in any non-admin, non-owner response.
- [ ] **G3.5** NoSQL injection attempts are rejected across every input surface (spec §35).
- [ ] **G3.6** Rate limits trigger on auth, interaction, connection, block, report, notification, and chat writes (spec §36).
- [ ] **G3.7** Security headers, CORS allowlist, and HTTPS-only behaviour are verified (spec §37, §41, §42).
- [ ] **G3.8** `.env` is untracked, `.env.example` has no real credentials, and no secret appears in logs (spec §78, §79).
- [ ] **G3.9** The Atlas allowlist and least-privilege database user are confirmed (spec §38, §39, §111).
- [ ] **G3.10** Session revocation after password change and rejection of suspended users are verified (spec §7, §40).
- [ ] **G3.11** Upload authorization, type/size limits, ownership, and private-photo visibility are verified (spec §43, §112).
- [ ] **G3.12** No error response leaks a stack trace, collection name, field path, or connection detail (spec §33, §77).

### Gate 4 — Performance & data

- [ ] **G4.1** No security control introduces an unbounded query or an accidental collection scan (compare against
      step 17's plans).
- [ ] **G4.2** Rate limiting is enforced without degrading normal latency beyond the step 17 baseline.
- [ ] **G4.3** Body/upload size limits are enforced at ingress, not after full buffering (spec §80).

### Gate 5 — Spec conformance

- [ ] **G5.1** §31 / §91 — no permission or business rule exists only in the frontend.
- [ ] **G5.2** §34 / §35 / §80 — validation, allowlisting, and size controls are applied everywhere.
- [ ] **G5.3** §44 / §59 — object-level authorization and per-view response construction are verified.
- [ ] **G5.4** §64 — no sensitive data is placed in a shared cache (none exists yet; confirm the rule is respected
      for future work).
- [ ] **G5.5** §110 / §111 — every layer of the protection model is verified, and outsider database access is impossible.
- [ ] **G5.6** §112 — the user-only, matched-only, and admin-only data rules hold in practice.
- [ ] **G5.7** §113 — the public profile id is non-sequential and authorization still applies.
- [ ] **G5.8** §121 — the documented security test list is fully covered.
- [ ] **G5.9** §126 — the final rules (database, search, relationships, responses, pagination, images, cache, security,
      privacy, data quality, payments) each have a corresponding verified item.
- [ ] **G5.10** Regression: every step on the tracker watchlist has a fresh G1/G3 result recorded, and no earlier
      `audited_passed` verdict remains unchallenged by a new finding.

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

- [ ] The authorization matrix is complete, tested, and matches expectations or has recorded findings.
- [ ] No restricted data is reachable from any non-admin, non-owner response.
- [ ] Injection and validation defences hold on every input surface.
- [ ] Rate limits, headers, CORS, secrets, and database-access controls are verified.
- [ ] Every finding is recorded with a severity and an owner, and any affected earlier step is downgraded until fixed
      and re-audited.
- [ ] The report separates verified facts from untested areas.

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence | |
| Findings summary (counts by severity) | |
| Steps downgraded pending fixes | |
| Fixes required | |
