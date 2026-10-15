---
step: 11
title: Interests / Connections
status: audited_notes
build: built
audit: passed
depends_on: [10]
unblocks: [12, 14]
spec_refs: ["§21", "§22", "§36", "§44", "§46", "§91", "§96", "§99", "§100", "§105", "§112", "§121"]
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
| active pair | `{ senderId: 1, receiverId: 1 }` **partial** unique where `status ∈ { pending, accepted }` | One *open* relationship per pair; terminal rows are kept as history (decisions §8 — see the note below) |
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
historical connection record (decisions §7; `closeForAccess()` is the seam step 12's block path and step 16's
moderation path call).

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

## Resolved ambiguities

Two places where the source documents contradict themselves, and the reading this build implements. Both are decided
by the step's own verification commands, which are the executable contract.

1. **Is `closed` part of the partial unique index?** Decisions §8 lists `closed` among the *active* states the pair
   index covers, yet the same section allows a new interest after `closed`. Those cannot both hold: if `closed`
   remained in the index, a new `pending` row for the same directed pair would collide with the preserved `closed`
   row. Commands 11–12 decide it — command 11 closes an accepted connection, command 12 re-sends and expects
   **201 with a NEW pending row while the closed row is unchanged** (gates G2.10, G2.11). The partial unique index
   therefore covers the two genuinely **open** states, `pending` and `accepted`, and `closed` is terminal history
   alongside `rejected` / `withdrawn` / `expired`. `constants/connection.js` documents this at the constant.

2. **"New sends are refused" after a closure.** Command 11's wording and task 7's say new sends are refused after
   `closed`, while command 12 requires an interest re-send to succeed. The reading this build implements is
   decisions §7's: the refusal applies to **messages sent through the closed connection** (step 14, gated by
   `canChat`), not to a *new interest*, which commands 12 and G2.11 require to succeed as a fresh row.

## Deliberate non-changes

- **Discover's exclusion set is unchanged.** The regression watchlist anticipated that "exclusions in Discover depend
  on action and connection state", but neither the finalized decisions nor spec §99 asks Discover to hide a pair with
  an interest pending, accepted or closed — §99 lists exactly self, blocked-by-me and blocked-me. Adding a connection
  source would silently change the results steps 09 and 10 verify, so step 11 adds **no** exclusion source; the
  `exclusionService` interface is untouched.
- **A crossing send is a 409, not an auto-accept.** If `B` sends to `A` while `A`'s interest to `B` is still open, the
  request is refused with a `409` and a hint naming the inbound interest. A mutual auto-accept is explicitly deferred
  by this step ("Later — mutual-interest auto-accept rules"), so the service never silently converts one into the
  other.

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/v1/connections` | authenticated | Send interest to a target profile |
| GET | `/api/v1/connections` | authenticated | List sent/received by status |
| PATCH | `/api/v1/connections/:connectionId` | authenticated, participant | Accept / reject / withdraw / close |

The list query takes `box=sent\|received` (default `received`) and a `status` filter. For convenience the direction may
also be given as `status=sent` / `status=received` — the spelling the step's own command 8 uses — and the validator
normalises it into the clean `{ box, status }` pair the service reads.

## Build tasks

- [x] 1. Write `models/Connection.js` with the schema, base plugin, and indexes.
- [x] 2. Write `connectionPolicy.js`: the transition matrix above as data, `canTransition(from, action, actorRole)`,
      and `canChat(userA, userB)` returning true only for an `accepted` connection (spec §21, §100).
- [x] 3. Write `constants/connection.js`: statuses, the matrix, the default expiry duration, and the re-send rule.
- [x] 4. Write `validators/connection.validators.js`: validate the target identifier, a bounded optional message
      (length cap, no HTML), the action, and reject unknown fields.
- [x] 5. Write `connectionService.send()`: reject self, verify the target is `active`, verify no block either way,
      enforce the duplicate rule, apply a per-user send rate limit, then create a `pending` row and emit an
      `interest_received` event (spec §100).
- [x] 6. Write `connectionService.respond()`: only the receiver may accept or reject; only `pending` may transition;
      set `respondedAt`; emit the `interest_accepted` **domain event** on accept or `interest_rejected` on reject.
      Emit the domain event only — the notification layer (step 13) maps `interest_accepted` to a single `new_match`
      notification (decisions §9). Do not create two notifications for one acceptance.
- [x] 7. Implement `close()`: `accepted → closed`, permitted for either participant, available only from `accepted`;
      after closure `canChat` returns false and new sends are refused. Also implement the internal
      "close-for-access" path a block or admin action uses, which preserves the row (decisions §7).
- [x] 8. Write `connectionService.withdraw()`: only the sender, only from `pending`.
- [x] 9. Write the expiry sweep: move stale `pending` rows to `expired`, run on a schedule or lazily on read, and log
      the count. Do not scan the whole collection without the `{ status: 1, createdAt: 1 }` index.
- [x] 10. Write `connectionService.list()`: return sent/received lists by status using the **card projection** and
      pagination; never load full profile documents or private fields.
- [x] 11. Implement duplicate handling for the race where two identical sends arrive concurrently: rely on the
      **partial unique active-pair index** and translate the duplicate-key error into a clear **409 Conflict**
      (decisions §8). Re-sending after a terminal state must succeed because the old row is not in the active set.
- [x] 12. Do **not** use a MongoDB transaction between the connection status update and the notification write
      (decisions §16, FINAL). The connection status update is the authoritative operation; the notification is a side
      effect that must not block or roll back the acceptance. Log notification errors server-side instead.
- [x] 13. Emit events through a small internal event bus/queue that step 13 consumes, rather than writing notification
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
  to `pending`/`accepted`, so duplicates are impossible while history survives (decisions §8; see Resolved ambiguities).
- **Closure is explicit and reversible only by a new send:** `closed` ends chat access; re-sending creates a fresh
  record rather than mutating the closed one (decisions §7, §8).
- **Accept is authoritative over its notification:** the connection status is the source of truth; a missing or failed
  notification never rolls back an accepted connection (decisions §16).
- **Message safety:** the optional interest message is length-capped and treated as text (spec §34, §80). `<` and `>`
  are **refused** rather than stripped, so a silent edit never happens and the stored value provably cannot begin
  markup.
- **Authorization has three distinct failure answers:** a non-participant gets **404** (never a 403 that confirms the
  row exists), a participant with the wrong role gets **403**, and a legal actor asking for an illegal transition gets
  **409** with the row unchanged.
- **Rate limiting:** sending interests is an abuse vector (spec §36). The bucket is per account, and `PATCH` shares it,
  because a scripted accept/reject loop is the same vector.
- **Privacy:** connection lists show card-level data only; private fields and both account ids are never included
  (spec §112).

## Config / environment additions

```text
INTEREST_MESSAGE_MAX_LEN           # cap for the optional message
INTEREST_RATE_LIMIT_WINDOW         # send window
INTEREST_RATE_LIMIT_MAX            # sends per window
INTEREST_EXPIRY_DAYS               # pending -> expired after this many days
CONNECTIONS_DEFAULT_LIMIT          # page size for connection lists
CONNECTIONS_MAX_LIMIT              # hard cap for a requested page size
CONNECTIONS_SWEEP_INTERVAL_SECONDS # minimum gap between lazy expiry sweeps
```

`INTEREST_EXPIRY_DAYS` has no published product value; 30 days is the configurable default and is recorded as an open
product decision in the tracker.

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

- [x] **G1.1** Every deliverable exists; connection routes mounted and protected. *(tests G1.1; harness — all three
      routes answer 401 anonymously)*
- [x] **G1.2** Server boots with the model and all indexes in place. *(tests G1.2; harness §105; `verify-indexes.js`)*
- [x] **G1.3** Steps 01–10 verification commands still pass. *(`npm run verify` → **11/11 gates, 242/242 checks**, exit
      0; every regression harness 01, 03–10 re-ran green after the model and the `actionService` export were added)*

### Gate 2 — Functional

- [x] **G2.1** Interest can be sent, listed, accepted, rejected, and withdrawn. *(tests G2.1/G2.2; harness commands
      1, 5, 7)*
- [x] **G2.2** Only `pending` rows transition; every illegal transition is refused. *(tests G2.2 — accept/withdraw
      after accept, close from pending, second withdraw; harness command 6)*
- [x] **G2.3** Only the receiver can accept or reject; only the sender can withdraw. *(tests G2.2/G3.2; harness
      command 4)*
- [x] **G2.4** Duplicate sends are refused and concurrent duplicates resolve to a single row. *(tests G2.3/G2.4/G4.4;
      harness commands 2, 13 — one 201, one 409, one active row)*
- [x] **G2.5** Self-interest is refused. *(tests G2.5; harness command 3)*
- [x] **G2.6** `canChat` is true only for `accepted` connections and false for every other status, including `closed`
      (decisions §7). *(tests G2.6 — all six statuses produced by real transitions; harness command 5/11)*
- [x] **G2.10** Either participant can close an accepted connection; the closed row is preserved and a subsequent
      send creates a new record (decisions §7, §8). *(tests G2.7/G2.10/G2.11; harness commands 11, 12 — the sender
      closes one pair, the receiver would close the other)*
- [x] **G2.11** A second active send for the same pair is refused (409) while a send after a terminal state succeeds.
      *(tests G2.3/G2.11; harness commands 2, 12)*
- [x] **G2.7** The expiry sweep marks stale `pending` rows `expired` and leaves fresh ones alone. *(tests G2.7;
      harness command 10 — driven at the service boundary, as no endpoint exposes "expire now")*
- [x] **G2.8** Connection lists are card-shaped, paginated, and correct for both directions. *(tests G2.1/G2.8;
      harness command 8)*
- [x] **G2.9** The close-after-accept rule is implemented and its chat effect is verified. *(tests G2.7/G2.10; harness
      command 11 — `canChat` flips to false on closure)*

### Gate 3 — Security

- [x] **G3.1** A non-participant cannot read or modify a connection (verified with a third account). *(tests G3.1
      both cases; harness — a non-participant PATCH answers 404 and the list is never another account's rows)*
- [x] **G3.2** A sender cannot accept their own interest, nor a receiver reject on the sender's behalf. *(tests
      G2.2/G3.2; harness command 4 — 403, row still pending)*
- [x] **G3.3** A blocked pair cannot send or respond in either direction. *(tests G3.3 with the step-12 `Block`
      stand-in; harness §99 — both refusals are 404 and the row is untouched)*
- [x] **G3.4** Request-body identity fields do not change the resolved actor. *(tests G3.4 — `senderId`, `receiverId`,
      `userId`, `status` are all 400; harness)*
- [x] **G3.5** The interest message is length-capped and cannot inject markup. *(tests G3.5 — at the cap is 201, over
      the cap and any `<`/`>` are 400, and the stored value is asserted markup-free; harness)*
- [x] **G3.6** Malformed ObjectIds and object-shaped values are rejected before any query. *(tests G3.6 — body,
      query and path, plus both target spellings at once and an unknown action; harness)*
- [x] **G3.7** Send rate limits demonstrably trigger. *(tests G3.7; harness command 9 — 429 after
      `INTEREST_RATE_LIMIT_MAX`)*
- [x] **G3.8** No connection listing exposes private profile fields. *(tests G3.8 — no email/phone/coordinates/
      dateOfBirth/birthTime/userId/senderId/receiverId and neither account id; harness command 8)*
- [x] **G3.9** Unauthenticated requests return 401. *(tests G1.1; harness)*

### Gate 4 — Performance & data

- [x] **G4.1** Sent/received lists use the `senderId`/`receiverId` status indexes (`IXSCAN`). *(tests G4.1; harness
      §49 — both plans assert `IXSCAN`)*
- [x] **G4.2** The expiry sweep uses its index and updates only stale rows. *(tests G4.2; harness — the sweep plan is
      `IXSCAN` on `status_1_createdAt_1`, and a fresh pending row is asserted untouched)*
- [x] **G4.3** Lists use the card projection and perform no populate chain. *(tests G4.3 — the DTO is exactly the card
      plus one nested `connection` object; the list issues one profile `find` and one photo query per page)*
- [x] **G4.4** The partial unique index is confirmed present in `listIndexes()` with its `partialFilterExpression`, and
      duplicate-key errors on concurrent sends resolve to 409 rather than a 500 (decisions §8). *(tests G1.2 and
      G4.4; harness §105 + decisions §8)*

### Gate 5 — Spec conformance

- [x] **G5.1** §21 — the connection document and status set match the specification. *(tests G5.1; harness §21)*
- [x] **G5.2** §21 / §100 — chat access is derived from an accepted connection and enforced by the backend. *(tests
      G2.6 — `canChat` and `chatAccess` are the only gates; harness)*
- [x] **G5.3** §99 / §22 — blocked pairs are excluded from the flow. *(tests G3.3; harness §99)*
- [x] **G5.4** §96 / decisions §16 — no transaction is used for the accept-and-notify pair, and the choice is
      documented with the reason (connection is authoritative; notification is a side effect). *(tests G5.4 — source
      inspection plus one `interest_accepted` and no `new_match` on the bus)*
- [x] **G5.8** decisions §7, §8 — the six-status enum, the close transition, the re-send rule, and the partial unique
      active-pair index are all present. *(tests G5.8; harness decisions §7/§8 — see Resolved ambiguities)*
- [x] **G5.5** §36 — sending interests is rate limited. *(tests G3.7; harness command 9)*
- [x] **G5.6** §105 — the connection indexes exist. *(tests G1.2; harness §105; `scripts/verify-indexes.js`)*
- [x] **G5.7** §121 — the send/accept/reject/withdraw/duplicate/blocked test list is covered. *(tests G2.1–G2.11,
      G3.3; harness commands 1–13)*

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

- [x] The full interest lifecycle works with only legal transitions permitted.
- [x] Only the correct participant can perform each action.
- [x] Chat eligibility is a single server-side check derived from connection state.
- [x] Duplicate and concurrent interests cannot produce two rows.
- [x] Step 14 can call `canChat` without needing to interpret connection internals.

## Sign-off

| Field | Value |
|---|---|
| Auditor | Buffy (automated) |
| Date | 2026-10-11 |
| Verdict | PASS WITH NOTES |
| Evidence | `npm run lint` exit 0; `npm test` **322/322** (0 skipped; 38 new in `tests/connection.test.js`); `node verify-step11.mjs` **36/36** live checks covering all thirteen doc commands plus the §105 index checklist with its `partialFilterExpression`, both `IXSCAN` plans, the transition matrix, the event bus and payload privacy; regressions: steps 01 11/11, 03 12/12, 04 26/26, 05 23/23, 06 33/33, 07 26/26, 08 28/28, 09 25/25, 10 22/22; `scripts/verify-indexes.js` exit 0 (now covering `connections`); `npm run verify` → **11/11 gates, 242/242 checks**, exit 0. |
| Fixes required | None outstanding. **Notes:** commands 10 and the blocked-pair half of §99 are verified at the service boundary rather than over HTTP — there is no endpoint for "expire now", and the `blocks` model belongs to step 12, so the running server registers no `Block` and the harness registers a minimal stand-in for the same rule step 12 will run. The interest limiter is verified against its own configured cap (`INTEREST_RATE_LIMIT_MAX`); the harness's server raises only the login and *global* limits. Two source-document contradictions are resolved and documented above (§7/§8 `closed` vs. the pair index; "new sends are refused" vs. the re-send rule). `INTEREST_EXPIRY_DAYS=30` is a configurable default with no published product value. Inherits the step 02 G3.2 blocking item (over-privileged MongoDB credential). |
