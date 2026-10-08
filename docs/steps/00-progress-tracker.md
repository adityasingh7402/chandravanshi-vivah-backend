# Build & Audit Progress Tracker

Central record for the 18 backend steps. Each step file also carries its own front-matter status; this file is the roll-up. When a step's status changes, update **both** the step front matter and the row here.

**Legend:** `—` not started · `IP` in progress · `B` built (verification commands pass, audit not run) · `P` audited passed · `N` audited with notes · `F` failed audit

## Tracker

| # | Step | Depends on | Build | Audit | Verdict | Auditor | Date | Regressed by | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 01 | [Project Setup & Configuration](01-project-setup-and-config.md) | — | B | P | PASS WITH NOTES | Buffy (automated) | 2026-10-08 | | lint 0; 34/34 tests; 11/11 live checks; not a git repo |
| 02 | [MongoDB Connection](02-mongodb-connection.md) | 01 | B | F | FAIL | Buffy (automated) | 2026-10-08 | 03 | G3.2 FAILS: the app connects to Atlas as an `atlasAdmin` (cluster admin) user, violating the least-privilege rule (spec §39). Discovered while verifying step 03. |
| 03 | [User & Authentication](03-user-authentication.md) | 02 | B | P | PASS WITH NOTES | Buffy (automated) | 2026-10-08 | | 94/94 tests, 12/12 live checks; partial-index COLLSCAN defect found and fixed; inherits the step 02 G3.2 blocker. |
| 04 | [Session / Token Handling](04-session-token-handling.md) | 03 | B | N | PASS WITH NOTES | Buffy (automated) | 2026-10-08 | | 119/119 tests; 26/26 live checks; step 01 regression 11/11, step 03 regression 12/12; typed 401/403 `code` missing from the error envelope — found and fixed; inherits the step 02 G3.2 blocker. |
| 05 | [Master Data](05-master-data.md) | 04 | — | — | — | | | | |
| 06 | [Matrimonial Profile](06-matrimonial-profile.md) | 05 | — | — | — | | | | |
| 07 | [Partner Preferences](07-partner-preferences.md) | 06 | — | — | — | | | | |
| 08 | [Photos & Cloudinary](08-photos-cloudinary.md) | 06 | — | — | — | | | | |
| 09 | [Discover / Search](09-discover-search.md) | 07, 08 | — | — | — | | | | |
| 10 | [Profile Actions](10-profile-actions.md) | 09 | — | — | — | | | | |
| 11 | [Interests / Connections](11-interests-connections.md) | 10 | — | — | — | | | | |
| 12 | [Block & Report](12-block-report.md) | 11 | — | — | — | | | | |
| 13 | [Notifications](13-notifications.md) | 12 | — | — | — | | | | |
| 14 | [Chat (Future Plan)](14-chat.md) | 11 | — | — | — | | | | Future phase; do not implement in the current scope |
| 15 | [Subscription / Entitlement](15-subscription-entitlement.md) | 04 | — | — | — | | | | |
| 16 | [Admin & Moderation](16-admin-moderation.md) | 12, 13, 14, 15 | — | — | — | | | | |
| 17 | [Performance Testing](17-performance-testing.md) | 16 | — | — | — | | | | |
| 18 | [Security Review](18-security-review.md) | 17 | — | — | — | | | | |

## Gate detail

Per-gate results, so a partial audit is visible rather than hidden behind one verdict.

| # | G1 Build | G2 Functional | G3 Security | G4 Perf/Data | G5 Spec | Result |
|---|---|---|---|---|---|---|
| 01 | ☑ | ☑ | ☑ | ☑ | ☑ | PASS WITH NOTES |
| 02 | ☑ | ☑ | ☒ | ☑ | ☑ | FAIL |
| 03 | ☑ | ☑ | ☑ | ☑ | ☑ | PASS WITH NOTES |
| 04 | ☑ | ☑ | ☑ | ☑ | ☑ | PASS WITH NOTES |
| 05 | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 06 | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 07 | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 08 | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 09 | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 10 | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 11 | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 12 | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 13 | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 14 | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 15 | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 16 | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 17 | ☐ | ☐ | ☐ | ☐ | ☐ | |
| 18 | ☐ | ☐ | ☐ | ☐ | ☐ | |

## Audit log

Append-only. One row per audit run, including re-runs triggered by the regression rule.

| Date | Step | Gates run | Verdict | Auditor | Evidence / findings |
|---|---|---|---|---|---|
| 2026-10-08 | 01 | G1–G5 | PASS WITH NOTES | Buffy (automated) | `npm run lint` exit 0; `npm test` 34/34; `node verify-step01.mjs` 11/11 live checks; fail-fast exit 1 on empty `JWT_SECRET`. Notes: not a git repo (G1.3/G3.5 git evidence unavailable); Windows does not deliver POSIX signals to child processes (G2.5 driven directly in tests). |
| 2026-10-08 | 02 | G1–G5 | PASS WITH NOTES | Buffy (automated) | `npm test` 61/61 (0 skipped); boot logs `database connected` before `server listening`; health reports `database.connected=true`; `verify-indexes.js` exit 0 and proven to exit 1 on a removed index; unreachable cluster exits 1 with `[redacted-host]`; `isValidObjectId('{$ne:null}')===false`; step 01 regression 11/11. Notes: G3.2/G3.3 (Atlas user role + network allowlist) not verifiable against a local mongod; G3.5 git evidence unavailable (not a git repo); Windows signal limitation for G2.3. |
| 2026-10-08 | 02 (re-verify) | G3 | **FAIL** | Buffy (automated) | Re-verification triggered by step 03: the cluster is Atlas, not a local mongod. `connectionStatus` reports `authenticatedUserRoles: [{ role: "atlasAdmin", db: "admin" }]` for `adityasingh515999_db_user`. **G3.2 fails** — a cluster-admin credential is used by the application (spec §39). Step 02 verdict changed from PASS WITH NOTES to FAIL. |
| 2026-10-08 | 03 | G1–G5 | PASS WITH NOTES | Buffy (automated) | `npm run lint` exit 0; `npm test` 94/94 (0 skipped); `verify-step03.mjs` 12/12 live checks; step 01 regression 11/11; `verify-indexes.js` exit 0 (`users.email_1`, `users.phone_1`); no submitted password or `$argon2` hash in logs; `explain()` shows `IXSCAN` on `email_1`. Notes: fixed a real defect (partial index was not used by a plain identifier lookup → COLLSCAN); inherits step 02 G3.2; `change-password` HTTP route needs step 04's session middleware. |
| 2026-10-08 | 04 | G1–G5 | PASS WITH NOTES | Buffy (automated) | `npm run lint` exit 0; `npm test` 119/119 (0 skipped); `verify-step04.mjs` 26/26 live checks (twice: raised limits and default `AUTH_RATE_LIMIT_MAX=10`); regressions: step 01 11/11, step 03 12/12; `verify-indexes.js` exit 0 (`sessions.userId_1`, `sessions.refreshTokenHash_1` unique, `sessions.expiresAt_1` TTL); refresh `explain()` → `IXSCAN`; log scan of all 15 minted tokens → 0 matches. **Found and fixed:** the error handler passed `body.code` where `code` sat beside `body`, so no failure envelope carried the machine-readable `code` — the typed 401/403 codes would have been invisible to clients (`middleware/errorHandler.js`). Notes: inherits step 02 G3.2; not a git repo; 14-chat.md externally reframed (validator errors belong to that file, untouched here). |

## Blocking security items

Items that must be closed before the corresponding surface is production-safe. A blocking item invalidates the
affected step's pass until it is resolved and re-verified.

| # | Item | Step | Severity | Required action | Status |
|---|---|---|---|---|---|
| 1 | Application connects to Atlas as an `atlasAdmin` (cluster admin) instead of a least-privilege application user (spec §39). The API process therefore holds a credential that can administer/drop any database on the cluster. | 02 (G3.2) | High | Create a dedicated Atlas database user with the built-in `readWrite` role scoped to the application database; keep admin credentials entirely out of the application environment; then re-verify G3.2. | **OPEN** |

## Regression watchlist

Later steps that touch shared surfaces and therefore require re-verification of earlier steps. Run the G1 and G3 checks for every listed step after the change is audited.

| Change | Re-verify | Why |
|---|---|---|
| 05 Master data (categories + user-contributed options) | 06, 07, 09 | Profiles and preferences reference master IDs that may now be user-contributed and scoped by parent context |
| 09 Discover/Search | 02, 06 | Introduces compound indexes and query projections on `matrimonial_profiles` |
| 11 Connections | 09, 10 | Exclusions in Discover depend on action and connection state |
| 12 Block/Report | 09, 11, 14 | Blocks change discovery visibility, interest eligibility, and chat access |
| 14 Chat | 11, 12 | Chat eligibility is derived from connection state plus blocks |
| 16 Admin/Moderation | 03, 06, 08, 12 | Admin writes cross auth, profile, photo, and report surfaces |
| 18 Security Review | all | Full-surface negative testing; any finding invalidates the affected step's pass |

## Open decisions

Questions raised by the step files. **All nine original questions are now closed** by [`chandravanshi-finalized-backend-decisions.md`](../../../Chandravanshi-Vivah-Documents/chandravanshi-finalized-backend-decisions.md); each affected step file now states the FINAL rule inline. One follow-on product decision (the community-context categories and the user-contributed master-data path) is recorded in the last row below and refines decision §3. Add a new row here only for a question raised after those documents.

| Step | Question | Owner | Resolution (FINAL) | Status |
|---|---|---|---|---|
| 02 | Which host/IP ranges are allowlisted for MongoDB Atlas access? | deployment | Only trusted backend/deployment network access is allowed. Dev = developer's current public IP + required dev/CI egress IP. Prod = backend egress IP/CIDR or a private-network connection. `0.0.0.0/0` is never a production rule. Exact values live in deployment config, never hardcoded. Clients never connect to MongoDB directly. (decisions §2) | FINAL |
| 05 | `master_data_requests` is not in the canonical collection list but the Gotra/Surname flow needs a store. | architecture | Create a dedicated `master_data_requests` collection (`userId`, `type`, `requestedName`, `status`, `reviewedBy`, `reviewedAt`). Users never create global master records directly. (decisions §3) | FINAL |
| 07 | Confirmed option sets for `workingPreference`, `horoscopeRequired`, `relocationPreference`. | product | `workingPreference` = Working / Not Working / Either; `horoscopeRequired` = Required / Preferred / Not Important (3-value enum, not boolean); `relocationPreference` = Yes / No / Maybe. Stored as lowercase frontend enums. Partner gender default = opposite of profile gender. (decisions §4, §5) | FINAL |
| 08 | Kundli document storage — own collection or reuse `photos`? | architecture | Create a dedicated `kundli_documents` collection; never store Kundli files as ordinary profile photos. `visibility` is `private \| matches_only`; never exposed in discovery. (decisions §6) | FINAL |
| 10 | Profile views — repeated rows or one upserted row per pair? | architecture | One view record per viewer/target pair; a repeat view updates `createdAt`. No unbounded view history in `profile_actions`; the notification layer throttles `profile_view`. (decisions §15) | FINAL |
| 11 | No documented status for closing an accepted connection. | product | Add `closed`. Final enum = pending / accepted / rejected / withdrawn / expired / closed. Either participant may close; `accepted → canChat=true`, `closed → canChat=false`, and the backend rejects new sends. A block/admin action makes an accepted connection unusable and is treated as closed for access while history is preserved. (decisions §7) | FINAL |
| 11 | Can an interest be re-sent after a terminal state, and what does the pair index become? | architecture | Re-send is allowed after rejected / withdrawn / expired / closed; a new record is created and an old one is never returned to `pending`. Only one active relationship per sender/receiver pair (active = pending, accepted, closed), enforced by a **partial unique index on active states**; concurrent identical sends resolve to one success and one **409**. (decisions §8) | FINAL |
| 11 | Is a transaction required between accepting an interest and creating its notification? | architecture | No transaction. The connection status update is authoritative; the notification is a side effect and must never block or roll back the acceptance. Errors are logged server-side. (decisions §16) | FINAL |
| 13 | Does accept produce one notification or two, and does rejection notify the sender? | product | Accept creates exactly **one** `new_match` notification (the connection service may still emit the `interest_accepted` domain event, which the notification layer maps to `new_match`). Rejection sends **one** `interest_rejected` to the sender. No duplicate acceptance rows. (decisions §9, §10) | FINAL |
| 15 | Which features are premium, and what happens when a free trial expires? | product | The current phase is indefinite free access: `expiresAt = null`, `status = active`, no automatic expiry, and **no premium feature restrictions** (`hasFeatureAccess` returns true for available features on an active account). The `source: "free_trial"` value is retained only for schema compatibility. Any future change to existing free entitlements is an explicit product decision. (decisions §11, §12, §22) | FINAL |
| 16 | Final admin role model — `User.role` or a separate `AdminUser` collection? | architecture | Use `User.role = user \| moderator \| admin`; no `AdminUser` collection. Roles come from the authenticated session; no public self-promotion endpoint; changes via the controlled script/backend process and audited. (decisions §13) | FINAL |
| 16 | Who refreshes denormalised display names after a master-data rename? | architecture | Update them **inline during the admin rename operation**, targeted by the master-data ID (e.g. `career.occupationId == renamedId` → update `career.occupationName`). Not a background job, and never on a profile read. (decisions §14) | FINAL |
| 05 | A user cannot find their sub-community / surname / gotra / clan / aaspad; and which categories exist? | product | Categories are community, sub-community, surname, gotra, **clan**, **aaspad** (clan and aaspad are their own categories, never merged into gotra; contexts are never cross-merged). A missing value is submitted by the user, stored with `source: "user"` and `submittedBy = <userId>`, and is **immediately selectable by every other user**, flagged as user-contributed; an admin verifies/promotes, rejects, or merges it. Users never create *official* records. **This refines decisions §3.** (community format; step 05) | FINAL |
