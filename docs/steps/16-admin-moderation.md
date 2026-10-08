---
step: 16
title: Admin & Moderation
status: not_started
build: not_started
audit: not_run
depends_on: [12, 13, 14, 15]
unblocks: [17]
spec_refs: ["§5", "§14", "§28", "§29", "§30", "§36", "§44", "§51", "§74", "§75", "§78", "§98", "§101", "§105", "§112", "§10"]
---

# Step 16 — Admin & Moderation

## Goal

Deliver the back-office surface: user administration, profile suspension and deactivation, photo and report
moderation, master-data management including Gotra/Surname approvals, administrative notifications, and subscription
inspection (spec §28, §101). Every privileged action writes an audit log entry (spec §29). Roles are resolved from the
server-side session, never from the request (spec §31, §44).

## Scope

**In scope**

- Admin/moderator-only route group, protected by `requireRole`.
- User search and lookup with a safe projection (never hashes or credentials).
- Suspend / reactivate / deactivate users and profiles (soft deletion preferred, spec §98).
- Report queue: list, assign, resolve, dismiss (spec §101).
- Photo moderation: approve/reject, with the effect on discovery eligibility (spec §17, §101).
- Master-data management: create, edit, deactivate, reorder, and review pending Gotra/Surname requests (spec §74, §75).
- **Verifying (promoting) or rejecting user-contributed options** that users added through the "can't find it?" path,
  and merging spelling variants into one option (step 05).
- **Inline refresh of denormalised display names on rename** — targeted by the renamed master-data ID (decisions §14).
- Administrative notification sending via the step 13 service.
- Subscription inspection.
- `audit_logs` collection and a writer used by every privileged action (spec §29).

**Out of scope (do not build now)**

- A separate admin web UI — this is the API surface only.
- Permanent hard deletion of user data; soft delete is the current strategy (spec §98).
- Bulk data migrations and reporting/analytics dashboards.
- A background job/queue for renaming — the update is inline, not deferred (decisions §14).

**Later**

- Hard-deletion tooling once retention and support requirements are defined (spec §98).
- Admin action analytics on top of `audit_logs`.

**FINAL — denormalised names update inline on rename (decisions §14).** When an admin renames a master item, the
rename operation itself also updates the denormalised display-name copies in affected profiles, **targeted via the
master-data ID** rather than scanning every profile:

```text
Admin renames master occupation
        ↓
Update master record
        ↓
Update denormalised occupationName in affected profiles   e.g. career.occupationId == renamedOccupationId
        ↓
Complete admin operation
        ↓
Audit the change
```

This is not a background job, and it never runs on a profile read. It runs on the rare admin *write*, so the
performance requirement in this step (which applies to repeated reads) is not affected.

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| Reports and blocks | 12 | `audited_passed` |
| Notifications service | 13 | `audited_passed` |
| Photos with moderation status | 08 | `audited_passed` |
| Entitlement service for subscription inspection | 15 | `audited_passed` |
| Roles middleware | 04 | `audited_passed` |

## Deliverables

```text
server/src/models/AuditLog.js                     # spec §29 schema + indexes
server/src/services/auditService.js               # log() used by every privileged action
server/src/services/adminUserService.js           # search, get, suspend, reactivate, deactivate
server/src/services/moderationService.js          # report queue transitions, photo approve/reject
server/src/services/adminMasterDataService.js     # create/edit/deactivate/reorder/approve
server/src/services/adminNotificationService.js   # admin_alert / verification_completed sending
server/src/controllers/admin/*.controller.js
server/src/routes/admin.routes.js
server/src/validators/admin.validators.js
server/src/constants/adminActions.js              # audit action names
server/scripts/grant-admin.js                     # controlled way to set a role; never a public endpoint
```

## Data model

### `audit_logs` (spec §29)

```js
{
  _id: ObjectId,
  actorUserId: ObjectId,
  action: String,             // e.g. admin_suspended_user
  targetType: String,         // "user" | "profile" | "photo" | "report" | "gotra" | ...
  targetId: ObjectId | null,
  metadata: Object | null,    // small, non-sensitive context
  createdAt: Date
}
```

| Index | Definition | Purpose |
|---|---|---|
| actor + time | `{ actorUserId: 1, createdAt: -1 }` | Review an admin's actions |
| target | `{ targetType: 1, targetId: 1, createdAt: -1 }` | Review a record's history |
| action + time | `{ action: 1, createdAt: -1 }` | Audit by action type |

Documented action names (extend as needed, never free text at call sites):

```text
admin_suspended_user      admin_reactivated_user   admin_deactivated_profile
admin_rejected_photo      admin_approved_photo     admin_resolved_report
admin_dismissed_report    admin_approved_gotra     admin_approved_surname
admin_created_master_item admin_updated_master_item admin_renamed_master_item admin_deactivated_master_item
admin_verified_master_item admin_rejected_master_item admin_merged_master_item
admin_sent_notification   admin_reset_password     admin_viewed_subscription
```

### Reviewing user-contributed master data

Every community-context collection can contain two tiers (step 05): official rows (`source: seed`/`admin`,
`verifiedAt` set) and **user-contributed** rows (`source: "user"`, `submittedBy` = the contributing user,
`verifiedAt: null`) created by the "can't find it?" path.

| Admin action | Effect |
|---|---|
| Verify / promote | Set `verifiedBy` and `verifiedAt` — the value becomes official and stops rendering as member-added |
| Reject | Deactivate the row; existing profile references stay valid (spec §74) |
| Merge | Fold a duplicate or a spelling variant into the surviving row as an `alias`, then deactivate the merged row |

Every action is audited, and the contributing `submittedBy` user is shown in the review queue so provenance is visible.
The review queue is a data-quality queue, not a gate: a user-contributed value is already selectable before review.

### Role handling (FINAL — decisions §13)

Roles are `user` / `moderator` / `admin` on the existing `User` document (spec §5, §28). **There is no separate
`AdminUser` collection** — the role on `User` is the final model (decisions §13).

```text
user       → normal product access
moderator  → moderation capabilities explicitly granted to moderators
admin      → full administrative capabilities
```

Role checks come from the authenticated session. The client cannot change its own role, and there is no public
`POST /role` self-promotion endpoint. Role changes are made only through the controlled script or an admin route that
itself writes an audit log — never from a request body (spec §31).

## API surface

All routes under `/api/v1/admin`, protected by `requireRole("admin", "moderator")`. The exact allowed role per route
is stated in the route definition, so a moderator cannot perform admin-only actions.

| Method | Path | Role | Purpose |
|---|---|---|---|
| GET | `/api/v1/admin/users` | admin, moderator | Search users, safe projection |
| GET | `/api/v1/admin/users/:userId` | admin, moderator | User + profile summary |
| PATCH | `/api/v1/admin/users/:userId/status` | admin | Suspend / reactivate |
| PATCH | `/api/v1/admin/profiles/:profileId/status` | admin, moderator | Deactivate / hide a profile |
| GET | `/api/v1/admin/reports` | admin, moderator | Moderation queue |
| PATCH | `/api/v1/admin/reports/:reportId` | admin, moderator | Reviewing / resolved / dismissed |
| GET | `/api/v1/admin/photos/pending` | admin, moderator | Photo moderation queue |
| PATCH | `/api/v1/admin/photos/:photoId/moderation` | admin, moderator | Approve / reject |
| GET/POST/PATCH/DELETE | `/api/v1/admin/master-data/:type[/:id]` | admin | Manage master data |
| GET | `/api/v1/admin/master-data-requests` | admin | Pending Gotra/Surname requests |
| PATCH | `/api/v1/admin/master-data-requests/:id` | admin | Approve / reject a request |
| PATCH | `/api/v1/admin/master-data/:type/:id/review` | admin | Verify (promote) or reject a user-contributed option |
| POST | `/api/v1/admin/master-data/:type/:id/merge` | admin | Merge a duplicate/variant into a surviving row as an alias |
| POST | `/api/v1/admin/notifications` | admin | Send an administrative notification |
| GET | `/api/v1/admin/subscriptions/:userId` | admin | Inspect entitlement |

## Build tasks

- [ ] 1. Write `models/AuditLog.js` with the schema, base plugin, and indexes. Treat the collection as append-only:
      no update or delete route exists anywhere.
- [ ] 2. Write `auditService.log({ actorUserId, action, targetType, targetId, metadata })`, validating `action`
      against `constants/adminActions.js` so no free-text action is ever written.
- [ ] 3. Write `constants/adminActions.js` with the documented action names.
- [ ] 4. Build the admin route group and apply `requireRole` per route. Confirm a `user` token receives 403 on every
      admin path and a `moderator` is refused on admin-only actions.
- [ ] 5. Write `adminUserService`: `search()` with a **safe projection** (id, identifier masked appropriately, role,
      status, `profileCreated`, dates — never `passwordHash`), `get()`, `suspend()`, `reactivate()`, `deactivate()`.
      Suspending must immediately block the user's protected requests via the step 04 status gate.
- [ ] 6. Write `moderationService` for the report queue: transitions only through the documented statuses
      (`open → reviewing → resolved | dismissed`), set `reviewedBy`/`reviewedAt`, and audit each transition
      (spec §101).
- [ ] 7. Write photo moderation: approve/reject sets `moderationStatus`, and approve is required before a photo is
      eligible for a discovery card. Audit each decision.
- [ ] 8. Write `adminMasterDataService`: create, edit, deactivate (never hard delete, spec §74), reorder, and review
      a pending Gotra/Surname request (spec §75). Include `verify()` (set `verifiedBy`/`verifiedAt`), `reject()`
      (deactivate), and `merge()` (fold a duplicate or spelling variant into the surviving row as an `alias`, then
      deactivate the merged row) for user-contributed options added via `POST /master-data/:type/missing`.
- [ ] 9. Implement the rename path to update denormalised display names **inline and targeted by the master-data ID**
      (decisions §14): e.g. for a renamed occupation, match `career.occupationId == renamedOccupationId` and update
      `career.occupationName`. No full-collection scan, no background job, and audit the change. The same applies to
      `community.clanName` and `community.aaspadName` when those master records are renamed.
- [ ] 10. Write `adminNotificationService`: send `admin_alert` and `verification_completed` notifications through the
      step 13 service so the same pagination and ownership rules apply.
- [ ] 11. Write the subscription inspection route using the step 15 service, read-only, audited.
- [ ] 12. Write `scripts/grant-admin.js`: a controlled, idempotent, audited way to grant or revoke a role from the
      command line. Do not create a public role-change endpoint.
- [ ] 13. Write validators for every admin body/query: allowlisted filters, bounded pagination, valid ObjectIds,
      unknown-field rejection (spec §34).
- [ ] 14. Apply rate limits where appropriate and ensure admin responses use admin-specific projections rather than
      sharing user DTOs (spec §59).
- [ ] 15. Never expose identity-verification data or admin notes on any non-admin response (spec §30, §112).

## Business rules & security

- **Roles come from the session.** No request body, query string, or header can elevate a role (spec §31, §44).
- **Least privilege per route:** moderators get moderation actions; admin-only actions are refused for moderators.
- **Every privileged action is audited** with a validated action name, actor, target, and non-sensitive metadata
  (spec §29).
- **Soft deletion preferred** over destructive deletes so references stay intact (spec §98).
- **Safe projections:** admin user search never returns `passwordHash`, refresh tokens, or connection strings
  (spec §30, §51).
- **Audit logs are append-only** and never editable through the API.
- **Sensitive data stays admin-only:** identity data, reports, admin notes, and audit information are never returned
  to normal users (spec §112).
- **Master data uses deactivation**, so old profiles referencing a retired value remain valid (spec §74, §97).
- **No credential handling in admin routes:** password resets, if ever added, are an audited support action, not an
  unverified self-service path (spec §6).

## Config / environment additions

```text
ADMIN_ACTION_MAX_METADATA_KEYS   # guard for the metadata object size
ADMIN_DEFAULT_LIMIT              # page size for admin lists
ADMIN_MAX_LIMIT                  # hard cap
MODERATION_SLA_HOURS             # optional reporting threshold, if tracked
```

## Verification commands

```bash
ADMIN=...    # admin token
MOD=...      # moderator token
USER=...     # normal user token

# 1. User cannot reach admin routes
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/admin/users -H "Authorization: Bearer $USER"
# Expected: 403

# 2. Moderator cannot perform admin-only actions
curl -sS -o /dev/null -w '%{http_code}\n' -X PATCH \
  http://localhost:3000/api/v1/admin/users/<id>/status -H "Authorization: Bearer $MOD" \
  -H 'Content-Type: application/json' -d '{"status":"suspended"}'
# Expected: 403

# 3. Admin suspends a user, who is then locked out
curl -sS -X PATCH http://localhost:3000/api/v1/admin/users/<userId>/status -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"status":"suspended"}'
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/auth/me -H "Authorization: Bearer $USER"
# Expected: 200 then 401/403

# 4. Admin user search leaks nothing
curl -sS -H "Authorization: Bearer $ADMIN" 'http://localhost:3000/api/v1/admin/users?query=rahul&limit=20' \
  | grep -E 'passwordHash|refreshTokenHash|mongodb'
# Expected: no matches

# 5. Report moderation
curl -sS -X PATCH http://localhost:3000/api/v1/admin/reports/<reportId> -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"status":"resolved"}'
# Expected: 200 with reviewedBy and reviewedAt set

# 6. Illegal report transition
curl -sS -X PATCH http://localhost:3000/api/v1/admin/reports/<reportId> -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"status":"open"}'
# Expected: 400/409

# 7. Photo moderation affects discovery eligibility
curl -sS -X PATCH http://localhost:3000/api/v1/admin/photos/<photoId>/moderation -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"moderationStatus":"approved"}'
# Expected: 200; the photo becomes the card image where applicable

# 8. Gotra approval creates the master record
curl -sS -X PATCH http://localhost:3000/api/v1/admin/master-data-requests/<id> -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"decision":"approve"}'
curl -sS 'http://localhost:3000/api/v1/master-data/gotras?query=<newGotra>'
# Expected: request approved and the gotra now selectable

# 9. Every privileged action is audited
curl -sS -H "Authorization: Bearer $ADMIN" 'http://localhost:3000/api/v1/admin/audit-logs?targetId=<userId>'
# Expected: entries for the suspension, with actor and timestamp

# 9b. Verify a user-contributed option
curl -sS -X PATCH http://localhost:3000/api/v1/admin/master-data/gotras/<id>/review \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"decision":"verify"}'
curl -sS 'http://localhost:3000/api/v1/master-data/gotras?query=<name>'
# Expected: verifiedAt is now set and the option no longer reports isUserContributed true

# 9c. Merge a spelling variant
curl -sS -X POST http://localhost:3000/api/v1/admin/master-data/gotras/<dupId>/merge \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"intoId":"<survivorId>"}'
# Expected: one selectable option; searching the merged spelling returns the survivor

# 10. Audit log is append-only
curl -sS -o /dev/null -w '%{http_code}\n' -X DELETE http://localhost:3000/api/v1/admin/audit-logs/<id> \
  -H "Authorization: Bearer $ADMIN"
# Expected: 404/405 — no such route

# 11. Unauthenticated
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/admin/users
# Expected: 401
```

## Audit checklist

### Gate 1 — Build integrity

- [ ] **G1.1** Every deliverable exists; the admin route group is mounted with per-route role guards.
- [ ] **G1.2** Server boots with `AuditLog` and its indexes.
- [ ] **G1.3** Steps 01–15 verification commands still pass, especially suspension effects on auth, block effects,
      chat eligibility, and entitlement resolution.

### Gate 2 — Functional

- [ ] **G2.1** A normal user is refused every admin route; a moderator is refused admin-only actions and allowed
      moderation ones.
- [ ] **G2.2** User search and lookup work with a safe projection and bounded pagination.
- [ ] **G2.3** Suspend/reactivate/deactivate take effect immediately on the affected account and profile.
- [ ] **G2.4** The report queue transitions only through legal statuses and records reviewer data.
- [ ] **G2.5** Photo approve/reject works and changes discovery-card eligibility.
- [ ] **G2.6** Master-data create/edit/deactivate/reorder work; deactivation hides the item from new selections while
      existing references remain valid.
- [ ] **G2.11** Renaming a master item updates the denormalised display names in affected profiles **within the same
      admin operation**, and leaves unrelated profiles untouched (decisions §14).
- [ ] **G2.12** A user-contributed option can be verified — after which it reports `verifiedAt` set and no longer
      renders as member-added — or rejected, after which it disappears from new selections while profiles that
      already reference it stay valid.
- [ ] **G2.13** Merging a duplicate/variant leaves one selectable option, with the merged name present as an `alias`
      so searching either spelling returns the survivor.
- [ ] **G2.14** The review queue shows the contributing user (`submittedBy`) for each user-contributed option.
- [ ] **G2.7** A pending Gotra/Surname request can be approved, and only then does the master record exist.
- [ ] **G2.8** Administrative notifications are delivered through the step 13 service and appear in the recipient's
      inbox.
- [ ] **G2.9** Subscription inspection returns read-only entitlement data.
- [ ] **G2.10** `scripts/grant-admin.js` grants and revokes roles idempotently.

### Gate 3 — Security

- [ ] **G3.1** No request can elevate a role or reach an admin route without a server-verified role.
- [ ] **G3.2** Admin user responses contain no `passwordHash`, refresh token hash, connection string, or secret.
- [ ] **G3.3** Every privileged action in the checklist above produced an audit entry; spot-check at least five.
- [ ] **G3.4** Audit logs cannot be modified or deleted through any route.
- [ ] **G3.5** Identity-verification data and admin notes never appear in a non-admin response.
- [ ] **G3.6** Unknown fields and malformed ObjectIds are rejected on admin routes too.
- [ ] **G3.7** Admin rate limits apply and no admin route allows an unbounded list.
- [ ] **G3.8** A client-supplied `userId` cannot redirect an administrative notification or moderation decision.

### Gate 4 — Performance & data

- [ ] **G4.1** Admin list queries use their indexes and return bounded pages.
- [ ] **G4.2** The report queue and pending-photo queue use `{ status, createdAt }`-style indexes.
- [ ] **G4.3** Audit queries use the actor/target indexes rather than scanning.
- [ ] **G4.4** The rename-time update is targeted by master-data ID and runs only on the admin write, never on a
      profile read (decisions §14). Record the update count for a rename in a seeded collection.

### Gate 5 — Spec conformance

- [ ] **G5.1** §28 — the documented admin capabilities are all present.
- [ ] **G5.2** §29 — the audit log matches the specification and covers the listed example actions.
- [ ] **G5.3** §74 / §75 — deactivation over deletion, and admin-approved Gotra/Surname additions.
- [ ] **G5.4** §101 — the moderation areas and actions are covered, each audited.
- [ ] **G5.5** §98 — soft deletion is the strategy.
- [ ] **G5.6** §10 / decisions §14 — denormalised display-name consistency after a rename is addressed by an inline,
      ID-targeted update.
- [ ] **G5.9** decisions §13 — roles come from `User.role` (`user`/`moderator`/`admin`) with no `AdminUser` collection
      and no public role-change endpoint.
- [ ] **G5.10** Step 05 user-contributed rule — the admin surface can only promote/reject/merge; it never needs to
      create the value first, because the contributing user already did and the value was selectable meanwhile.
- [ ] **G5.7** §30 / §51 / §112 — admin-only data stays admin-only; projections are used.
- [ ] **G5.8** §105 — the audit-log indexes exist.

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

- [ ] All administrative capabilities exist behind server-verified role guards.
- [ ] Every privileged action is audited and the audit log is append-only.
- [ ] Moderation decisions take effect on the user-facing surfaces they control.
- [ ] Master-data changes preserve the validity of existing profile references.
- [ ] No admin response leaks credential, secret, or identity data.

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence | |
| Fixes required | |
