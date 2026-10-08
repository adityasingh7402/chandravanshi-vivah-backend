---
step: 12
title: Block & Report
status: not_started
build: not_started
audit: not_run
depends_on: [11]
unblocks: [13, 16]
spec_refs: ["§22", "§23", "§24", "§36", "§44", "§56", "§91", "§99", "§101", "§105", "§112"]
---

# Step 12 — Block & Report

## Goal

Give users two safety mechanisms: a block that immediately severs every interaction path both ways, and a report
that opens a moderation case for an admin (spec §22, §23). Blocking is not a UI preference — it must change discovery,
interest eligibility, chat access, and notifications (spec §22). Reporting must capture enough context for a
moderator without exposing the reporter to the reported user (spec §23, §101).

## Scope

**In scope**

- `blocks` and `reports` schemas per spec §22 and §23.
- Block creation/removal and the full effect set: discovery exclusion, interest prevention, chat prevention,
  notification suppression.
- Report creation with category, description, evidence references, and `open` status.
- Reporter privacy: the reported user never learns who reported them.
- A `GET /reports/me` view of the caller's own reports and their statuses.
- Rate limiting on block and report writes.

**Out of scope (do not build now)**

- Admin review actions — step 16 owns the moderation queue and status transitions (spec §101).
- Automatic enforcement (auto-suspend on N reports); any such rule must be explicit product policy.
- Evidence file upload — if needed, it reuses the step 08 upload path.

**Later**

- Block-list growth optimisation in discovery if measurements show the `$nin` set becomes large (spec §99).
- Appeal workflow for reported users.

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| Connections and `canChat` | 11 | `audited_passed` |
| Discover exclusion interface | 09 | `audited_passed` |

## Deliverables

```text
server/src/models/Block.js                  # spec §22 schema + indexes
server/src/models/Report.js                 # spec §23 schema + indexes
server/src/services/blockService.js         # block, unblock, isBlockedEitherWay, excludeIds
server/src/services/reportService.js        # create, listOwn, (admin transitions deferred to step 16)
server/src/controllers/block.controller.js
server/src/controllers/report.controller.js
server/src/routes/block.routes.js
server/src/routes/report.routes.js
server/src/validators/safety.validators.js
server/src/constants/safety.js              # report categories, statuses, limits
```

## Data model

### `blocks` (spec §22)

```js
{ _id: ObjectId, blockerId: ObjectId, blockedUserId: ObjectId, reason: String | null, createdAt: Date }
```

| Index | Definition | Purpose |
|---|---|---|
| blocker | `{ blockerId: 1 }` | Fast "who did I block" |
| blocked | `{ blockedUserId: 1 }` | Fast "who blocked me" |
| pair | `{ blockerId: 1, blockedUserId: 1 }` unique | Idempotent block |

### `reports` (spec §23)

```js
{
  _id: ObjectId,
  reporterId: ObjectId,
  reportedUserId: ObjectId,
  category: "fake_profile" | "spam" | "harassment" | "fraud" |
            "inappropriate_photo" | "wrong_information" | "already_married" | "other",
  description: String | null,
  evidence: [String],
  status: "open" | "reviewing" | "resolved" | "dismissed",
  reviewedBy: ObjectId | null,
  reviewedAt: Date | null,
  createdAt: Date,
  updatedAt: Date
}
```

| Index | Definition | Purpose |
|---|---|---|
| reported + status | `{ reportedUserId: 1, status: 1 }` | Moderation queue and duplicate detection |
| reporter | `{ reporterId: 1, createdAt: -1 }` | The caller's own report history |
| status + created | `{ status: 1, createdAt: -1 }` | Admin queue ordering (step 16) |

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/v1/blocks` | authenticated | Block a user |
| DELETE | `/api/v1/blocks/:userId` | authenticated | Unblock |
| GET | `/api/v1/blocks` | authenticated | The caller's block list |
| POST | `/api/v1/reports` | authenticated | File a report |
| GET | `/api/v1/reports/me` | authenticated | The caller's own reports |

Admin report routes are separate and protected; they are built in step 16 and must not be added here (spec §32).

## Build tasks

- [ ] 1. Write `models/Block.js` and `models/Report.js` with the schemas, base plugin, and indexes. Mark
      `reporterId` appropriately so a report serialiser never accidentally exposes it to the reported user.
- [ ] 2. Write `constants/safety.js`: report categories, report statuses, description length cap, evidence array cap,
      and rate-limit windows.
- [ ] 3. Write `blockService.block()`: reject self-block, upsert idempotently, and record the reason (optional and
      private to the blocker).
- [ ] 4. Write `blockService.unblock()` and `list()`.
- [ ] 5. Write `blockService.isBlockedEitherWay(a, b)` and `excludeIds(userId)`: return the union of users the caller
      blocked and users who blocked the caller, for discover (spec §56, §99).
- [ ] 6. Wire the block check into every interaction path: discovery exclusion, interest send/respond, profile
      actions, and the `canChat` helper from step 11 (spec §22). A block must make an accepted connection
      **closed for access** — `canChat` false and new sends refused — without rewriting the stored status
      (decisions §7). Re-verify each of those steps after wiring.
- [ ] 7. Suppress notifications from a blocked user (spec §22) by consulting the block service in the notification
      creation path — step 13 depends on this hook.
- [ ] 8. Write `reportService.create()`: validate the category and bounded description, verify the target exists,
      refuse self-reports, prevent duplicate open reports for the same pair and category (or allow with a
      documented counter — state the choice), and create an `open` report.
- [ ] 9. Write `reportService.listOwn()`: return the caller's reports with status only. The `reportedUserId` may be
      shown to the reporter; the reporter is never shown to the reported user.
- [ ] 10. Bound the `evidence` array and validate each entry as a string/reference; do not accept arbitrary objects
      (spec §34, §80).
- [ ] 11. Apply rate limits to block and report writes (spec §36).
- [ ] 12. Write controllers, routes, and validators with `requireAuth`; resolve the actor from the session only.

## Business rules & security

- **Blocking is bilateral in effect:** discovery, interests, actions, chat, and notifications are all cut, in both
  directions, regardless of who blocked whom (spec §22).
- **Block does not delete history:** existing connections and messages remain for audit; they simply become
  inaccessible (spec §98 spirit — prefer soft effects over destructive deletes).
- **A block closes an accepted connection for access (decisions §7):** when a block makes an accepted connection
  unusable, it is treated as `closed` — `canChat` becomes false, new message sends are refused — while the historical
  connection and message rows are preserved. The block never rewrites the stored status.
- **Reporter privacy:** the reported user must never see the reporter's identity (spec §112). Only admins see it,
  and only in the moderation view.
- **Report content is bounded** and stored as text; no arbitrary objects into `evidence` (spec §34).
- **No client-trusted enforcement:** block effects are enforced on read and write server-side (spec §91).
- **Rate limiting:** both block and report can be abused for harassment or review flooding (spec §36).
- **Admin-only transitions:** report `status`, `reviewedBy`, and `reviewedAt` are never writable from a user route
  (spec §32, §44).

## Config / environment additions

```text
REPORT_DESCRIPTION_MAX_LEN   # cap for the description
REPORT_EVIDENCE_MAX_ITEMS    # cap for the evidence array
BLOCK_RATE_LIMIT_WINDOW      # block window
BLOCK_RATE_LIMIT_MAX         # blocks per window
REPORT_RATE_LIMIT_WINDOW     # report window
REPORT_RATE_LIMIT_MAX        # reports per window
```

## Verification commands

```bash
A=...   # account A token
B=...   # account B token

# 1. Block
curl -sS -X POST http://localhost:3000/api/v1/blocks -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' -d '{"userId":"<bUserId>","reason":"Not interested"}'
# Expected: 201

# 2. Block is idempotent
#   Re-run command 1. Expected: no duplicate row

# 3. Self-block
curl -sS -X POST http://localhost:3000/api/v1/blocks -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' -d '{"userId":"<aUserId>"}'
# Expected: 400

# 4. Discovery excludes the pair in both directions
curl -sS -H "Authorization: Bearer $A" 'http://localhost:3000/api/v1/discover?limit=100' | grep -c '<bPublicId>'
curl -sS -H "Authorization: Bearer $B" 'http://localhost:3000/api/v1/discover?limit=100' | grep -c '<aPublicId>'
# Expected: 0 and 0

# 5. Interactions are cut
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/v1/connections \
  -H "Authorization: Bearer $B" -H 'Content-Type: application/json' -d '{"toUserId":"<aUserId>"}'
# Expected: 403/404

# 6. Chat is cut (needs step 14; if not yet built, verify canChat is false via the policy helper)
# Expected: canChat(A,B) === false, including when a previously accepted connection exists (blocked = closed for
#           access, stored status unchanged — decisions §7)

# 7. File a report
curl -sS -X POST http://localhost:3000/api/v1/reports -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' \
  -d '{"reportedUserId":"<id>","category":"fake_profile","description":"Photos do not match"}'
# Expected: 201, status "open"

# 8. Reporter privacy
curl -sS -H "Authorization: Bearer $B" http://localhost:3000/api/v1/reports/me
# Expected: no reference to A as a reporter of B

# 9. Invalid category
curl -sS -X POST http://localhost:3000/api/v1/reports -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' -d '{"reportedUserId":"<id>","category":"nonsense"}'
# Expected: 400

# 10. Admin fields are not writable
curl -sS -X POST http://localhost:3000/api/v1/reports -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' \
  -d '{"reportedUserId":"<id>","category":"spam","status":"dismissed","reviewedBy":"<id>"}'
# Expected: 400 (unknown/forbidden fields rejected)
```

## Audit checklist

### Gate 1 — Build integrity

- [ ] **G1.1** Every deliverable exists; block and report routes mounted and protected.
- [ ] **G1.2** Server boots with both models and their indexes.
- [ ] **G1.3** Steps 01–11 verification commands still pass after the block checks are wired in.

### Gate 2 — Functional

- [ ] **G2.1** Block, unblock, and list work; blocking is idempotent; self-block is refused.
- [ ] **G2.2** A block removes the pair from discovery in both directions.
- [ ] **G2.3** A block prevents interest send and respond in both directions.
- [ ] **G2.4** A block makes `canChat` false in both directions.
- [ ] **G2.5** A block suppresses notifications between the pair once step 13 exists; the hook is in place now.
- [ ] **G2.6** Unblocking restores the ability to interact without restoring any prior relationship.
- [ ] **G2.7** A report can be filed with each category and appears in the caller's own list with status `open`.
- [ ] **G2.8** Self-reports and invalid categories are refused.
- [ ] **G2.9** The duplicate-report rule (chosen behaviour) is implemented and observed.

### Gate 3 — Security

- [ ] **G3.1** A user cannot block or report on behalf of another account.
- [ ] **G3.2** The reported user's view never reveals the reporter's identity (spec §112).
- [ ] **G3.3** User routes cannot set `status`, `reviewedBy`, or `reviewedAt` on a report.
- [ ] **G3.4** `evidence` accepts only strings/references within the cap; arbitrary objects are rejected.
- [ ] **G3.5** Description is length-capped and cannot inject markup.
- [ ] **G3.6** Malformed ObjectIds and object-shaped values are rejected before any query.
- [ ] **G3.7** Block and report rate limits trigger.
- [ ] **G3.8** Unauthenticated requests return 401.

### Gate 4 — Performance & data

- [ ] **G4.1** Exclusion-id lookups use the block indexes; the discover query still plans to `IXSCAN`.
- [ ] **G4.2** The block list and the caller's report list are paginated and bounded.
- [ ] **G4.3** A very large block set does not degrade the discover plan; note the observed behaviour against the
      `$nin` guard from step 09 (spec §99).

### Gate 5 — Spec conformance

- [ ] **G5.1** §22 — the block document and its full effect set match the specification.
- [ ] **G5.2** §23 — the report document, category set, and statuses match.
- [ ] **G5.3** §56 / §99 — both block directions are excluded from discovery.
- [ ] **G5.4** §101 — reports are ready for the admin moderation flow without exposing admin data.
- [ ] **G5.5** §36 — both write paths are rate limited.
- [ ] **G5.6** §105 — the block and report indexes exist.
- [ ] **G5.7** §112 — reporter identity and admin fields are restricted.

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

- [ ] Blocking severs discovery, interests, actions, chat, and notifications in both directions.
- [ ] Reporting opens a moderation-ready case without revealing the reporter.
- [ ] No user route can alter moderation state.
- [ ] Steps 13 and 16 can consume blocks and reports without re-implementing the rules.
- [ ] Earlier steps still pass after the block checks are wired in.

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence | |
| Fixes required | |
