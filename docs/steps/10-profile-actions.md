---
step: 10
title: Profile Actions
status: not_started
build: not_started
audit: not_run
depends_on: [09]
unblocks: [11]
spec_refs: ["§20", "§36", "§44", "§46", "§56", "§99", "§100", "§105", "§21"]
---

# Step 10 — Profile Actions

## Goal

Record lightweight interactions — view, like, shortlist, pass — in a dedicated collection so they do not bloat the
profile document (spec §20). These actions feed shortlist screens, feed the `pass` exclusion in discovery (spec §56),
and provide the signal that later steps use to gate interests and chat (spec §100).

## Scope

**In scope**

- `profile_actions` schema per spec §20 with the four action types.
- Idempotent action recording (repeating a like/shortlist/pass does not create duplicates).
- A view-recording path that also updates the target's activity signal.
- Shortlist listing and removal.
- Wiring `pass` into `exclusionService` from step 09 (spec §56).
- Rate limiting on action writes (spec §36).

**Out of scope (do not build now)**

- The formal interest/connection handshake — step 11.
- Notification fan-out on like/shortlist — step 13 consumes these events (spec §24).
- View-retention strategy for very high volume; noted as a later optimisation (spec §20).

**Later**

- Aggregated "who viewed me" analytics with retention limits.
- Separate cold storage for views if volume demands it (spec §20).

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| Discover/search with the exclusion interface | 09 | `audited_passed` |
| Profile ownership and DTO patterns | 06 | `audited_passed` |

## Deliverables

```text
server/src/models/ProfileAction.js            # spec §20 schema + indexes
server/src/services/actionService.js          # record (idempotent), listShortlisted, remove, listViews
server/src/controllers/action.controller.js
server/src/routes/interaction.routes.js       # spec §32 interaction routes
server/src/validators/action.validators.js
server/src/constants/actions.js               # action types, rate-limit windows
```

## Data model

### `profile_actions` (spec §20)

```js
{
  _id: ObjectId,
  fromUserId: ObjectId,
  toUserId: ObjectId,
  type: "view" | "like" | "shortlist" | "pass",
  createdAt: Date
}
```

| Index | Definition | Purpose |
|---|---|---|
| pair + type | `{ fromUserId: 1, toUserId: 1, type: 1 }` unique | Idempotent like/shortlist/pass **and** one-row-per-pair for views (decisions §15) |
| target + type | `{ toUserId: 1, type: 1, createdAt: -1 }` | "Who viewed/liked me" and moderation context |
| actor + type | `{ fromUserId: 1, type: 1, createdAt: -1 }` | Shortlist listing, pass exclusion |

**FINAL — one view record per viewer/target pair (finalized decisions §15).** When the same user views the same
profile again, do **not** insert another row; update the existing record's timestamp. So:

```text
User A → User B   =  one current view record, timestamp refreshed on each repeat view
```

This prevents unbounded growth in `profile_actions` and avoids a write-heavy history collection for a high-volume
action. Because a view is now a single upserted row per pair, the `{ fromUserId, toUserId, type }` unique index
applies to `view` as well as to like/shortlist/pass — the index is what enforces the one-row rule under concurrency.
`createdAt` is updated on repeat views, so the model must explicitly allow that write (Mongoose's default immutable
`createdAt` has to be overridden, or a dedicated `viewedAt` timestamp used and documented). View *notifications* are
handled separately by step 13, which throttles/coalesces `profile_view`.

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/v1/interactions` | authenticated | Record a like, shortlist, pass, or view |
| GET | `/api/v1/interactions` | authenticated | List the caller's actions, filterable by type |
| DELETE | `/api/v1/interactions/:interactionId` | authenticated, owner | Remove an action (for example, un-shortlist) |

## Build tasks

- [ ] 1. Write `models/ProfileAction.js` with the schema, base plugin, and the indexes above. Views use the finalized
      one-row-per-pair rule: upsert, updating the timestamp instead of inserting (decisions §15). Configure the
      timestamp field so that write is legal.
- [ ] 2. Write `constants/actions.js`: the action type enum, which types are idempotent, and the per-type rate-limit windows.
- [ ] 3. Write `validators/action.validators.js`: validate `toUserId` (or `publicProfileId`), the action type, and
      reject unknown fields. Convert a `publicProfileId` to a `userId` server-side only.
- [ ] 4. Write `actionService.record()`: reject self-actions, verify the target profile exists and is `active`
      (spec §58), verify no block exists either way, then upsert idempotently for **all four types**, including `view`
      (one row per pair, timestamp refreshed — decisions §15).
- [ ] 5. Write `actionService.remove()`: ownership-checked delete; return 404 for another user's action.
- [ ] 6. Write `actionService.listShortlisted()`: return shortlisted profiles using the **card projection** from
      step 09, paginated — never the full profile document.
- [ ] 7. Extend `exclusionService` so `pass` actions (and, if the product requires it, already-liked targets) are
      excluded from discovery (spec §56). Confirm step 09's query shape needs no change.
- [ ] 8. Wire the view action so it updates the target's `profile.lastActiveAt` signal on a throttled basis, without
      creating a write storm per render.
- [ ] 9. Apply per-action rate limits (spec §36) and record an event that step 13 can later consume for
      `profile_view` / `shortlisted` notifications (spec §24). Do not send notifications in this step.
- [ ] 10. Write controller and routes with `requireAuth`; resolve the actor from `req.auth.userId` only (spec §44).

## Business rules & security

- **No self-actions:** liking, shortlisting, or passing yourself is rejected.
- **Blocked pairs cannot interact:** a blocked relationship prevents actions and views (spec §22, §99). Step 12
  formalises the block collection; until then the check reads the same exclusion interface.
- **Idempotency:** repeating a like or shortlist must not create a second row; only one row per pair and type.
- **Ownership:** removing an action requires that the action belongs to the caller; otherwise 404 (spec §44).
- **Rate limiting:** without it, likes and views are an obvious spam vector (spec §36).
- **Privacy:** an action list is private to its owner; "who viewed me" is never exposed to the target in this step
  (spec §112) — step 13 may notify, but the raw list is the owner's.
- **No profile mutation from this step:** actions live in their own collection (spec §20, §69).
- **Views do not accumulate history:** one row per viewer/target pair; a repeat view updates the timestamp rather
  than adding a row, so a hot profile cannot grow `profile_actions` without bound (decisions §15).

## Config / environment additions

```text
ACTION_RATE_LIMIT_WINDOW   # window for action writes
ACTION_RATE_LIMIT_MAX      # writes per window
INTERACTIONS_DEFAULT_LIMIT # page size for action lists
VIEW_TOUCH_THROTTLE_MIN    # minimum gap before updating lastActiveAt again
```

## Verification commands

```bash
ACCESS=...        # actor token
OTHER_ACCESS=...  # a second account's token

# 1. Like a profile
curl -sS -X POST http://localhost:3000/api/v1/interactions -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"toUserId":"<id>","type":"like"}'
# Expected: 201

# 2. Repeat the like (idempotent)
#   Re-run command 1, then confirm only one row exists for that pair and type.

# 3. Self-action
curl -sS -X POST http://localhost:3000/api/v1/interactions -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"toUserId":"<ownUserId>","type":"like"}'
# Expected: 400

# 4. Shortlist listing uses the card projection
curl -sS -H "Authorization: Bearer $ACCESS" 'http://localhost:3000/api/v1/interactions?type=shortlist'
# Expected: card-shaped items only, no private fields

# 5. Removing another user's action
curl -sS -o /dev/null -w '%{http_code}\n' -X DELETE \
  http://localhost:3000/api/v1/interactions/<otherUsersActionId> -H "Authorization: Bearer $ACCESS"
# Expected: 404

# 6. Pass excludes from discover
curl -sS -X POST http://localhost:3000/api/v1/interactions -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"toUserId":"<targetId>","type":"pass"}'
curl -sS -H "Authorization: Bearer $ACCESS" 'http://localhost:3000/api/v1/discover?limit=100' | grep -c '<targetPublicId>'
# Expected: 0

# 7. Rate limit
for i in $(seq 1 200); do curl -sS -o /dev/null -X POST http://localhost:3000/api/v1/interactions \
  -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -d '{"toUserId":"<id>","type":"view"}'; done
# Expected: 429s after the configured threshold

# 8. Blocked pair cannot act (after step 12, or with a seeded block)
# Expected: 403/404, no action row created
```

## Audit checklist

### Gate 1 — Build integrity

- [ ] **G1.1** Every deliverable exists; interaction routes mounted and protected.
- [ ] **G1.2** Server boots with the model and unique index in place.
- [ ] **G1.3** Steps 01–09 verification commands still pass, especially discover filters and privacy.

### Gate 2 — Functional

- [ ] **G2.1** Each of the four action types can be recorded and read back.
- [ ] **G2.2** Repeated like/shortlist/pass writes produce exactly one row.
- [ ] **G2.3** Self-actions are rejected.
- [ ] **G2.4** Shortlist listing returns card-shaped, paginated items in a sensible order.
- [ ] **G2.5** Removing an action works for the owner and changes subsequent listings.
- [ ] **G2.6** A `pass` action removes the target from discover results.
- [ ] **G2.7** Action lists are paginated and bounded.
- [ ] **G2.8** Recording a view updates the target's activity signal at most once per throttle window.
- [ ] **G2.9** Viewing the same profile twice leaves exactly one `view` row for that pair, with the timestamp updated
      (decisions §15).

### Gate 3 — Security

- [ ] **G3.1** A `userId` supplied in the body cannot act on behalf of another account.
- [ ] **G3.2** Another user's action cannot be read or deleted.
- [ ] **G3.3** A blocked pair cannot record an action in either direction.
- [ ] **G3.4** Malformed ObjectIds and object-shaped values are rejected before any query.
- [ ] **G3.5** Rate limits demonstrably trigger on action writes.
- [ ] **G3.6** No action listing exposes another user's private profile fields.
- [ ] **G3.7** Unauthenticated requests return 401.

### Gate 4 — Performance & data

- [ ] **G4.1** Pair lookups and shortlist listings use the designed indexes (`IXSCAN`).
- [ ] **G4.2** Shortlist listing uses the shared card projection and does not load full profile documents.
- [ ] **G4.3** The unique index prevents duplicate rows on concurrent identical writes, including two concurrent
      view upserts for the same pair (decisions §15).
- [ ] **G4.4** Repeated views by the same viewer do not grow the collection: record the row count for one pair before
      and after a burst of views (expected: unchanged).

### Gate 5 — Spec conformance

- [ ] **G5.1** §20 — the action document matches the documented shape and types.
- [ ] **G5.2** §56 / §99 — pass (and any product-required) exclusions feed discovery without changing its query shape.
- [ ] **G5.3** §100 — view/like/shortlist rules are enforced server-side.
- [ ] **G5.4** §36 — action writes are rate limited.
- [ ] **G5.5** §105 — the `profile_actions` indexes are present.
- [ ] **G5.6** §91 — no business logic lives only in the frontend.

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

- [ ] The four action types are recorded idempotently and safely.
- [ ] Shortlists render from the card projection with no private data.
- [ ] Passing a profile removes it from discovery.
- [ ] No user can act on, view, or delete another user's action record.
- [ ] Step 11 can build the interest flow on top of a consistent action vocabulary.

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence | |
| Fixes required | |
