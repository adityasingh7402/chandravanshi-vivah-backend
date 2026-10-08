---
step: 13
title: Notifications
status: not_started
build: not_started
audit: not_run
depends_on: [12]
unblocks: [16]
spec_refs: ["§22", "§24", "§30", "§36", "§44", "§105", "§112"]
---

# Step 13 — Notifications

## Goal

Deliver in-app notifications for the events the product already produces: interest received, interest accepted or
rejected, a new match, a new message, a profile view, a shortlist, and admin alerts (spec §24). Notifications are
paginated, owner-scoped, and suppressed between blocked users (spec §22). This step consumes the events emitted by
steps 10–12 rather than re-deriving them, so the notification path stays decoupled from business logic.

## Scope

**In scope**

- `notifications` schema per spec §24 with the documented `type` set.
- Creation from internal events, with block-based suppression.
- Paginated listing, unread filtering, and an unread count.
- Mark-single-read and mark-all-read.
- Ownership enforcement and rate limiting on the write-and-read-read paths.

**Out of scope (do not build now)**

- Push notification delivery (FCM/APNs) and transactional email. The specification does not require them for V1 and
  no provider is chosen; if added later, they hook onto the same creation service.
- Notification preferences/muting UI (only the block rule is enforced now).
- Realtime delivery — that arrives with step 14's socket layer if the product wants it.

**Later**

- Web push / FCM / APNs once the mobile release requires it.
- Digest emails.

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| Events emitted by actions, connections, and blocks | 10, 11, 12 | `audited_passed` |
| Block suppression hook | 12 | `audited_passed` |

## Deliverables

```text
server/src/models/Notification.js             # spec §24 schema + indexes
server/src/services/notificationService.js    # create, list, markRead, markAllRead, unreadCount
server/src/services/notificationEvents.js     # event -> notification mapping and subscribers
server/src/controllers/notification.controller.js
server/src/routes/notification.routes.js
server/src/validators/notification.validators.js
server/src/constants/notifications.js         # types, titles, pagination defaults
```

## Data model

### `notifications` (spec §24)

```js
{
  _id: ObjectId,
  userId: ObjectId,           // recipient
  type: "interest_received" | "interest_accepted" | "interest_rejected" | "new_match" |
        "new_message" | "profile_view" | "shortlisted" | "verification_completed" | "admin_alert",
  title: String,
  body: String,
  data: Object,               // small payload, e.g. { connectionId, conversationId, profileId }
  readAt: Date | null,
  createdAt: Date
}
```

| Index | Definition | Purpose |
|---|---|---|
| inbox | `{ userId: 1, createdAt: -1 }` | Paginated inbox |
| unread | `{ userId: 1, readAt: 1 }` | Unread filter and count |
| dedupe (optional) | `{ userId: 1, type: 1, "data.entityId": 1, createdAt: -1 }` | Throttle repeated view/shortlist spam |

### Event-to-notification mapping

| Event source | `type` | `data` payload | Notes |
|---|---|---|---|
| Step 11 send | `interest_received` | `{ connectionId, fromProfileId }` | Suppressed if blocked |
| Step 11 accept (`interest_accepted` event) | `new_match` | `{ connectionId }` | **Exactly one** row. The message conveys that the interest was accepted and a match/connection now exists (decisions §9) |
| Step 11 reject | `interest_rejected` | `{ connectionId }` | Sent to the sender, one row; no private information (decisions §10) |
| Step 14 message | `new_message` | `{ conversationId, messageId }` | Coalesce rapid messages per conversation |
| Step 10 view/shortlist | `profile_view` / `shortlisted` | `{ fromProfileId }` | Throttled; may be entitlement-gated in step 15 |
| Step 16 verification | `verification_completed` | `{ verificationId }` | Admin-triggered |
| Step 16 admin | `admin_alert` | `{}` | Manual administrative message |

**FINAL — one acceptance notification, and rejection notifies the sender (decisions §9, §10).**

- Accepting an interest creates **one** notification with `type = "new_match"`; its wording communicates the
  acceptance and the new match. Do **not** create two inbox rows for a single acceptance.
- The connection service may still emit the `interest_accepted` **domain event**; the notification layer maps that
  event to `new_match`. Keeping the domain event name separate from the user-facing type is deliberate, so wording can
  change without touching the connection flow.
- Rejecting a pending interest sends **one** `interest_rejected` notification to the **sender**, exposing no private
  information.

This is the complete mapping for the acceptance/rejection path; there is no duplicate acceptance notification.

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/notifications` | authenticated | Paginated inbox, optional `unreadOnly` |
| GET | `/api/v1/notifications/unread-count` | authenticated | Badge count |
| PATCH | `/api/v1/notifications/:notificationId/read` | authenticated, owner | Mark one read |
| PATCH | `/api/v1/notifications/read-all` | authenticated | Mark all read |

## Build tasks

- [ ] 1. Write `models/Notification.js` with the schema, base plugin, and the inbox/unread indexes. Keep `data`
      small — it is a payload, not a document copy.
- [ ] 2. Write `constants/notifications.js`: the type enum, default titles/bodies per type, and pagination defaults.
- [ ] 3. Write `notificationService.create()`: validate the type against the enum, verify the recipient exists and is
      not blocked relative to the actor, apply throttling/coalescing for high-frequency types, and insert.
- [ ] 4. Write `notificationEvents.js`: subscribe to the events emitted in steps 10–12 and map them to notifications.
      Map the `interest_accepted` domain event to **one** `new_match` notification (decisions §9) and `interest_rejected`
      to one `interest_rejected` notification for the sender (decisions §10). Keep the mapping data-driven so step 16 can
      add `verification_completed` and `admin_alert` without editing the core service.
- [ ] 5. Implement block suppression by consulting `blockService.isBlockedEitherWay()` before insert (spec §22).
- [ ] 6. Implement throttling/coalescing so repeated profile views by one user do not produce an unbounded inbox
      (for example, collapse per actor and type within a window, or update the existing row's `createdAt` and reset
      `readAt` for `profile_view`).
- [ ] 7. Write `list()` with cursor or bounded offset pagination, `unreadCount()`, `markRead()` (owner-only, idempotent),
      and `markAllRead()` (scoped to the caller, never another user's rows).
- [ ] 8. Reject a `userId` supplied by the client on every route; the recipient is always `req.auth.userId` (spec §44).
- [ ] 9. Apply rate limits to the mark-read endpoints so a client cannot hammer them (spec §36).
- [ ] 10. Write controller, routes, and validators. Ensure the serialiser exposes only `type`, `title`, `body`, a
      minimal `data`, `readAt`, and `createdAt` — no internal ids of other collections beyond what the client needs
      (spec §30, §112).

## Business rules & security

- **Owner-only access:** a notification belongs to exactly one recipient; no other account can read or mark it
  (spec §44).
- **Block suppression:** notifications between blocked users are never created (spec §22).
- **Bounded growth:** high-frequency types are throttled or coalesced so the inbox cannot be flooded (spec §36).
- **Small payload:** `data` carries identifiers, not copies of profiles or messages (spec §24).
- **No private leakage:** the serialiser must not expose reporter identity, admin notes, or another user's contact
  details (spec §112).
- **Pagination always:** the inbox is never returned unbounded (spec §24).

## Config / environment additions

```text
NOTIFICATIONS_DEFAULT_LIMIT   # page size
NOTIFICATIONS_MAX_LIMIT       # hard cap
NOTIFY_VIEW_THROTTLE_MIN      # window for collapsing profile_view
NOTIFY_MESSAGE_COALESCE_MIN   # window for coalescing new_message
```

## Verification commands

```bash
A=...   # actor
B=...   # recipient

# 1. An interest produces a notification for the receiver
curl -sS -X POST http://localhost:3000/api/v1/connections -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' -d '{"toUserId":"<bUserId>"}'
curl -sS -H "Authorization: Bearer $B" http://localhost:3000/api/v1/notifications
# Expected: an interest_received row for B

# 2. Accept produces the accepted / new_match notification(s)
curl -sS -X PATCH http://localhost:3000/api/v1/connections/<id> -H "Authorization: Bearer $B" \
  -H 'Content-Type: application/json' -d '{"action":"accept"}'
curl -sS -H "Authorization: Bearer $A" http://localhost:3000/api/v1/notifications
# Expected: exactly ONE notification of type "new_match" for A (decisions §9) — not two rows

# 2b. Rejection notifies the sender once
curl -sS -X PATCH http://localhost:3000/api/v1/connections/<pendingId> -H "Authorization: Bearer $B" \
  -H 'Content-Type: application/json' -d '{"action":"reject"}'
curl -sS -H "Authorization: Bearer $A" 'http://localhost:3000/api/v1/notifications?type=interest_rejected'
# Expected: exactly one interest_rejected row for A, with no private data (decisions §10)

# 3. Unread count
curl -sS -H "Authorization: Bearer $B" http://localhost:3000/api/v1/notifications/unread-count
# Expected: 200 with a count matching the unread rows

# 4. Mark one read
curl -sS -X PATCH http://localhost:3000/api/v1/notifications/<id>/read -H "Authorization: Bearer $B"
# Expected: 200, readAt set, unread count decreases by one

# 5. Mark all read
curl -sS -X PATCH http://localhost:3000/api/v1/notifications/read-all -H "Authorization: Bearer $B"
curl -sS -H "Authorization: Bearer $B" http://localhost:3000/api/v1/notifications/unread-count
# Expected: count 0

# 6. Cross-account access
curl -sS -o /dev/null -w '%{http_code}\n' -X PATCH \
  http://localhost:3000/api/v1/notifications/<bNotificationId>/read -H "Authorization: Bearer $A"
# Expected: 404

# 7. Blocking suppresses notifications
#   Block A from B, then have A trigger an event toward B.
# Expected: no new notification row for B
```

## Audit checklist

### Gate 1 — Build integrity

- [ ] **G1.1** Every deliverable exists; notification routes mounted and protected.
- [ ] **G1.2** Server boots with the model and indexes in place.
- [ ] **G1.3** Steps 01–12 verification commands still pass, including block effects.

### Gate 2 — Functional

- [ ] **G2.1** Each documented notification type can be produced by its triggering event.
- [ ] **G2.2** The inbox lists a recipient's notifications in reverse chronological order, paginated.
- [ ] **G2.3** `unreadOnly` filters correctly and the unread count matches.
- [ ] **G2.4** Mark-one and mark-all behave correctly; marking is idempotent.
- [ ] **G2.5** Blocked pairs produce no notifications in either direction.
- [ ] **G2.6** Repeated profile views/shortlists do not produce an unbounded number of rows (throttle/coalesce observed).
- [ ] **G2.7** Accepting produces exactly **one** `new_match` notification for the sender and rejecting produces
      exactly **one** `interest_rejected` notification for the sender (decisions §9, §10). No second row is created for
      one acceptance, verified by counting rows.

### Gate 3 — Security

- [ ] **G3.1** No account can read or modify another account's notifications (404 on cross-access).
- [ ] **G3.2** A client-supplied `userId` cannot redirect a notification or its read state.
- [ ] **G3.3** The serialiser exposes no reporter identity, admin note, or contact detail.
- [ ] **G3.4** `data` payloads contain identifiers only, never copied private content.
- [ ] **G3.5** Malformed ObjectIds are rejected before any query.
- [ ] **G3.6** Mark-read rate limits trigger.
- [ ] **G3.7** Unauthenticated requests return 401.

### Gate 4 — Performance & data

- [ ] **G4.1** The inbox query uses the `{ userId, createdAt }` index (`IXSCAN`).
- [ ] **G4.2** The unread count uses the `{ userId, readAt }` index rather than scanning.
- [ ] **G4.3** The `data` object stays small; no notification embeds a profile or message document.
- [ ] **G4.4** Notification creation never blocks the originating request in a way that multiplies latency (record
      the observed impact on the interest-send latency).

### Gate 5 — Spec conformance

- [ ] **G5.1** §24 — the document and the full type set match the specification.
- [ ] **G5.2** §24 — notifications are paginated.
- [ ] **G5.3** §22 — blocked users generate and receive nothing.
- [ ] **G5.4** §105 — the notification indexes exist.
- [ ] **G5.5** §112 — no restricted data leaks through a notification.
- [ ] **G5.6** §36 — the write paths are rate limited.

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

- [ ] Every documented event type produces a correctly shaped notification.
- [ ] Notifications are owner-scoped, paginated, and readable/unreadable only by their recipient.
- [ ] Blocked users cannot notify each other.
- [ ] High-frequency types cannot flood an inbox.
- [ ] Step 16 can add admin-originated types without touching the core service.

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence | |
| Fixes required | |
