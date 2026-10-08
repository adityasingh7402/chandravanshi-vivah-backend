---
step: 11
title: Interests / Connections
status: not_started
build: not_started
audit: not_run
depends_on: [10]
unblocks: [12, 14]
spec_refs: ["§21", "§36", "§44", "§46", "§91", "§96", "§99", "§100", "§105", "§121"]
---

# Step 11 — Interests / Connections

## Goal

Implement the formal handshake that turns a one-sided signal into a mutual match: send interest, accept, reject,
withdraw, expire (spec §21). The accepted connection is what authorises chat (spec §21, §100), so the state machine
here is the source of truth for a matching relationship and must be enforced entirely server-side.

## Scope

**In scope**

- `connections` schema per spec §21, extended with the finalized `closed` status — six statuses in total
  (decisions §7).
- Send / accept / reject / withdraw / expire / close transitions with legal-transition enforcement.
- Duplicate-handling and reversal rules (for example, accepting an inbound interest from someone you were about to
  interest).
- Blocking interaction: a blocked pair cannot send, accept, or respond (spec §22, §99).
- A `canChat(userA, userB)` helper consumed by step 14 (spec §21, §100).
- Events for step 13 notifications (`interest_received`, `interest_accepted`, `interest_rejected`, `new_match`).
- Rate limiting and expiry sweeping.

**Out of scope (do not build now)**

- Chat itself — step 14.
- Notification delivery — step 13 subscribes to the events produced here.
- Any entitlement gate on sending interests; step 15 decides feature access.

**Later**

- Expiry policy refinement (auto-expire durations) if the product sets one.
- Mutual-interest auto-accept rules if the product asks for them.

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| Profile actions and the exclusion interface | 10 | `audited_passed` |
| Profile status rules and DTOs | 06 | `audited_passed` |

## Deliverables

```text
server/src/models/Connection.js             # spec §21 schema + indexes
server/src/services/connectionService.js    # send, accept, reject, withdraw, expire, list
server/src/services/connectionPolicy.js     # legal transitions + canChat()
server/src/controllers/connection.controller.js
server/src/routes/connection.routes.js
server/src/validators/connection.validators.js
server/src/constants/connection.js          # statuses, legal transition matrix, expiry default
```

## Data model

### `connections` (spec §21)

```js
{
  _id: ObjectId,
  senderId: ObjectId,
  receiverId: ObjectId,
  status: "pending" | "accepted" | "rejected" | "withdrawn" | "expired" | "closed",
  message: String | null,
  createdAt: Date,
  respondedAt: Date | null
}
```

| Index | Definition | Purpose |
|---|---|---|
| sender | `{ senderId: 1, status: 1 }` | Sent interests |
| receiver | `{ receiverId: 1, status: 1 }` | Received interests |
| active pair | `{ senderId: 1, receiverId: 1 }` **partial** unique where `status ∈ { pending, accepted, closed }` | One *active* relationship per pair; terminal rows are kept as history (decisions §8) |
| expiry | `{ status: 1, createdAt: 1 }` | Sweep pending rows that have expired |

### State machine (FINAL — decisions §7, §8)

```text
(none) --send--> pending
pending --accept--> accepted     (mutual match; canChat = true)
pending --reject--> rejected
pending --withdraw(sender)--> withdrawn
pending --timeout--> expired
accepted --close(either participant)--> closed   (canChat = false)
```

**FINAL — `closed` is the sixth status (decisions §7).** There is a documented state for ending an already accepted
connection: `closed`. Either participant may close. After closure the backend rejects new message sends and the client
does not control `canChat`.

An accepted connection that becomes unusable because of a **block or an administrative action** is treated as
**closed for access purposes** — `canChat` becomes false and new sends are refused — while the database preserves the
historical connection record (decisions §7; step 12 wires the block path).

Legal transitions (reject everything else):

| From | Action | To | Actor |
|---|---|---|---|
| — | send | `pending` | sender |
| `pending` | accept | `accepted` | receiver |
| `pending` | reject | `rejected` | receiver |
| `pending` | withdraw | `withdrawn` | sender |
| `pending` | timeout | `expired` | system |
| `accepted` | close | `closed` | either participant |
| `accepted` | block/admin | `closed` (for access) | system |

### Re-sending an interest (FINAL — decisions §8)

A new interest **is** allowed after the previous relationship reaches a terminal state:

```text
rejected  |  withdrawn  |  expired  |  closed
```

An old record is **never** changed back to `pending`. A new send creates a **new connection record**. Only **one
active relationship** may exist between the same sender and receiver at a time; the active states are:

```text
pending  |  accepted  |  closed
```

Consequently the simple permanent `{ senderId: 1, receiverId: 1 }` unique index is replaced by a **partial unique
index covering the active states only**, so history is preserved while duplicate active interests stay impossible.

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/v1/connections` | authenticated | Send interest to a target profile |
| GET | `/api/v1/connections` | authenticated | List sent/received by status |
| PATCH | `/api/v1/connections/:connectionId` | authenticated, participant | Accept / reject / withdraw |

## Build tasks

- [ ] 1. Write `models/Connection.js` with the schema, base plugin, and indexes.
- [ ] 2. Write `connectionPolicy.js`: the transition matrix above as data, `canTransition(from, action, actorRole)`,
      and `canChat(userA, userB)` returning true only for an `accepted` connection (spec §21, §100).
- [ ] 3. Write `constants/connection.js`: statuses, the matrix, the default expiry duration, and the re-send rule.
- [ ] 4. Write `validators/connection.validators.js`: validate the target identifier, a bounded optional message
      (length cap, no HTML), the action, and reject unknown fields.
- [ ] 5. Write `connectionService.send()`: reject self, verify the target is `active`, verify no block either way,
      enforce the duplicate rule, apply a per-user send rate limit, then create a `pending` row and emit an
      `interest_received` event (spec §100).
- [ ] 6. Write `connectionService.respond()`: only the receiver may accept or reject; only `pending` may transition;
      set `respondedAt`; emit the `interest_accepted` **domain event** on accept or `interest_rejected` on reject.
      Emit the domain event only — the notification layer (step 13) maps `interest_accepted` to a single `new_match`
      notification (decisions §9). Do not create two notifications for one acceptance.
- [ ] 7. Implement `close()`: `accepted → closed`, permitted for either participant, available only from `accepted`;
      after closure `canChat` returns false and new sends are refused. Also implement the internal
      "close-for-access" path a block or admin action uses, which preserves the row (decisions §7).
- [ ] 8. Write `connectionService.withdraw()`: only the sender, only from `pending`.
- [ ] 9. Write the expiry sweep: move stale `pending` rows to `expired`, run on a schedule or lazily on read, and log
      the count. Do not scan the whole collection without the `{ status: 1, createdAt: 1 }` index.
- [ ] 10. Write `connectionService.list()`: return sent/received lists by status using the **card projection** and
      pagination; never load full profile documents or private fields.
- [ ] 11. Implement duplicate handling for the race where two identical sends arrive concurrently: rely on the
      **partial unique active-pair index** and translate the duplicate-key error into a clear **409 Conflict**
      (decisions §8). Re-sending after a terminal state must succeed because the old row is not in the active set.
- [ ] 12. Do **not** use a MongoDB transaction between the connection status update and the notification write
      (decisions §16, FINAL). The connection status update is the authoritative operation; the notification is a side
      effect that must not block or roll back the acceptance. Log notification errors server-side instead.
- [ ] 13. Emit events through a small internal event bus/queue that step 13 consumes, rather than writing notification
      documents directly, so the two steps stay decoupled.

## Business rules & security

- **Transitions are enforced server-side** from the state machine; the client's requested action is validated against
  the current status, never trusted (spec §91).
- **Actor identity comes from the session.** The request cannot nominate itself as the receiver when it is the sender,
  and vice versa (spec §44).
- **Blocks win:** a blocked relationship prevents sending and responding in both directions (spec §22, §99).
- **Chat is derived, not stored as a flag on the client:** `canChat` is the only gate, and step 14 must call it
  (spec §21, §100).
- **One active relationship per pair:** enforced by the partial unique index on `{ senderId, receiverId }` restricted
  to `pending`/`accepted`/`closed`, so duplicates are impossible while history survives (decisions §8).
- **Closure is explicit and reversible only by a new send:** `closed` ends chat access; re-sending creates a fresh
  record rather than mutating the closed one (decisions §7, §8).
- **Accept is authoritative over its notification:** the connection status is the source of truth; a missing or failed
  notification never rolls back an accepted connection (decisions §16).
- **Message safety:** the optional interest message is length-capped and treated as text (spec §34, §80).
- **Rate limiting:** sending interests is an abuse vector (spec §36).
- **Privacy:** connection lists show card-level data only; private fields are never included (spec §112).

## Config / environment additions

```text
INTEREST_MESSAGE_MAX_LEN    # cap for the optional message
INTEREST_RATE_LIMIT_WINDOW  # send window
INTEREST_RATE_LIMIT_MAX     # sends per window
INTEREST_EXPIRY_DAYS        # pending -> expired after this many days
CONNECTIONS_DEFAULT_LIMIT   # page size for connection lists
```

## Verification commands

```bash
A=...   # first account token
B=...   # second account token

# 1. Send interest
curl -sS -X POST http://localhost:3000/api/v1/connections -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' -d '{"toUserId":"<bUserId>","message":"Hello"}'
# Expected: 201, status "pending"

# 2. Duplicate send
#   Re-run command 1. Expected: 409, one row only

# 3. Self-interest
curl -sS -X POST http://localhost:3000/api/v1/connections -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' -d '{"toUserId":"<aUserId>"}'
# Expected: 400

# 4. Sender cannot accept their own interest
curl -sS -o /dev/null -w '%{http_code}\n' -X PATCH \
  http://localhost:3000/api/v1/connections/<connectionId> -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' -d '{"action":"accept"}'
# Expected: 403/404

# 5. Receiver accepts -> chat becomes possible
curl -sS -X PATCH http://localhost:3000/api/v1/connections/<connectionId> -H "Authorization: Bearer $B" \
  -H 'Content-Type: application/json' -d '{"action":"accept"}'
# Expected: 200 with status "accepted" and respondedAt set

# 6. Illegal transition
curl -sS -X PATCH http://localhost:3000/api/v1/connections/<connectionId> -H "Authorization: Bearer $B" \
  -H 'Content-Type: application/json' -d '{"action":"reject"}'
# Expected: 409/400, status unchanged

# 7. Withdraw from pending (separate pair)
curl -sS -X PATCH http://localhost:3000/api/v1/connections/<pendingId> -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' -d '{"action":"withdraw"}'
# Expected: 200 with status "withdrawn"

# 8. Connection list privacy
curl -sS -H "Authorization: Bearer $A" 'http://localhost:3000/api/v1/connections?status=received' \
  | grep -E '"email"|"phone"'
# Expected: no matches

# 9. Send rate limit
for i in $(seq 1 100); do curl -sS -o /dev/null -X POST http://localhost:3000/api/v1/connections \
  -H "Authorization: Bearer $A" -H 'Content-Type: application/json' -d '{"toUserId":"<id>"}'; done
# Expected: 429s after the threshold

# 10. Expiry
#   Seed a pending row with an old createdAt, run the sweep.
# Expected: status becomes "expired"

# 11. Close an accepted connection
curl -sS -X PATCH http://localhost:3000/api/v1/connections/<acceptedId> -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' -d '{"action":"close"}'
# Expected: 200 with status "closed"; canChat(A,B) now false and a new send is refused

# 12. Re-send after a terminal state creates a new record
curl -sS -X POST http://localhost:3000/api/v1/connections -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' -d '{"toUserId":"<bUserId>"}'
# Expected: 201 with a NEW pending row; the earlier closed row is unchanged

# 13. Concurrent duplicate sends
#   Fire two identical sends in parallel.
# Expected: one 201 and one 409 Conflict; exactly one active row for the pair
```

## Audit checklist

### Gate 1 — Build integrity

- [ ] **G1.1** Every deliverable exists; connection routes mounted and protected.
- [ ] **G1.2** Server boots with the model and all indexes in place.
- [ ] **G1.3** Steps 01–10 verification commands still pass.

### Gate 2 — Functional

- [ ] **G2.1** Interest can be sent, listed, accepted, rejected, and withdrawn.
- [ ] **G2.2** Only `pending` rows transition; every illegal transition is refused.
- [ ] **G2.3** Only the receiver can accept or reject; only the sender can withdraw.
- [ ] **G2.4** Duplicate sends are refused and concurrent duplicates resolve to a single row.
- [ ] **G2.5** Self-interest is refused.
- [ ] **G2.6** `canChat` is true only for `accepted` connections and false for every other status, including `closed`
      (decisions §7).
- [ ] **G2.10** Either participant can close an accepted connection; the closed row is preserved and a subsequent
      send creates a new record (decisions §7, §8).
- [ ] **G2.11** A second active send for the same pair is refused (409) while a send after a terminal state succeeds.
- [ ] **G2.7** The expiry sweep marks stale `pending` rows `expired` and leaves fresh ones alone.
- [ ] **G2.8** Connection lists are card-shaped, paginated, and correct for both directions.
- [ ] **G2.9** The close-after-accept rule is implemented and its chat effect is verified.

### Gate 3 — Security

- [ ] **G3.1** A non-participant cannot read or modify a connection (verified with a third account).
- [ ] **G3.2** A sender cannot accept their own interest, nor a receiver reject on the sender's behalf.
- [ ] **G3.3** A blocked pair cannot send or respond in either direction.
- [ ] **G3.4** Request-body identity fields do not change the resolved actor.
- [ ] **G3.5** The interest message is length-capped and cannot inject markup.
- [ ] **G3.6** Malformed ObjectIds and object-shaped values are rejected before any query.
- [ ] **G3.7** Send rate limits demonstrably trigger.
- [ ] **G3.8** No connection listing exposes private profile fields.
- [ ] **G3.9** Unauthenticated requests return 401.

### Gate 4 — Performance & data

- [ ] **G4.1** Sent/received lists use the `senderId`/`receiverId` status indexes (`IXSCAN`).
- [ ] **G4.2** The expiry sweep uses its index and updates only stale rows.
- [ ] **G4.3** Lists use the card projection and perform no populate chain.
- [ ] **G4.4** The partial unique index is confirmed present in `listIndexes()` with its `partialFilterExpression`,
      and duplicate-key errors on concurrent sends resolve to 409 rather than a 500 (decisions §8).

### Gate 5 — Spec conformance

- [ ] **G5.1** §21 — the connection document and status set match the specification.
- [ ] **G5.2** §21 / §100 — chat access is derived from an accepted connection and enforced by the backend.
- [ ] **G5.3** §99 / §22 — blocked pairs are excluded from the flow.
- [ ] **G5.4** §96 / decisions §16 — no transaction is used for the accept-and-notify pair, and the choice is
      documented with the reason (connection is authoritative; notification is a side effect).
- [ ] **G5.8** decisions §7, §8 — the six-status enum, the close transition, the re-send rule, and the partial unique
      active-pair index are all present.
- [ ] **G5.5** §36 — sending interests is rate limited.
- [ ] **G5.6** §105 — the connection indexes exist.
- [ ] **G5.7** §121 — the send/accept/reject/withdraw/duplicate/blocked test list is covered.

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

- [ ] The full interest lifecycle works with only legal transitions permitted.
- [ ] Only the correct participant can perform each action.
- [ ] Chat eligibility is a single server-side check derived from connection state.
- [ ] Duplicate and concurrent interests cannot produce two rows.
- [ ] Step 14 can call `canChat` without needing to interpret connection internals.

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence | |
| Fixes required | |
