---
step: 14
title: Chat
status: not_started
build: not_started
audit: not_run
depends_on: [11]
unblocks: [16]
spec_refs: ["§21", "§22", "§24", "§25", "§44", "§52", "§91", "§100", "§105", "§112", "§115"]
---

# Step 14 — Chat (Future Plan)

> **Future plan only:** Chat is not part of the current implementation scope. Do not build or integrate the
> models, services, routes, notifications, or realtime transport described in this document until chat is
> explicitly scheduled for a future phase.

## Goal

When this feature is scheduled, provide text messaging between connected users only. MongoDB remains the persistence
layer; the backend decides whether communication is allowed, and the client is never the authority (spec §25, §100).
The planned first version is deliberately text-only — no attachments or media (spec §25) — with realtime delivery
left as an optional layer on top of a correct persistence model.

## Scope

**Planned scope for a future phase (not current implementation)**

- `conversations` and `messages` schemas per spec §25.
- Conversation creation from an accepted connection, with an idempotent one-conversation-per-pair rule.
- Message send and paginated history.
- The eligibility gate: `canChat` from step 11, plus the block check from step 12.
- Read receipts via `readAt`, conversation list ordering by `lastMessageAt`.
- Message length limits and rate limiting on send.

**Out of scope (do not build now)**

- Attachments, images in chat, or media messages (spec §25).
- Message editing, deletion-for-everyone, reactions, typing indicators.
- Realtime transport. Build the persistence and REST surface first; add a socket layer later if the product wants it
  (spec §25, §32).

**Later**

- WebSocket (or equivalent) delivery with authenticated sockets reusing `requireAuth` logic.
- Push notification delivery for `new_message` — step 13 already produces the notification row.
- Moderation tooling for reported message content (step 16).

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| Connections and `canChat` policy | 11 | `audited_passed` |
| Blocks that sever chat | 12 | `audited_passed` |
| Notifications for `new_message` | 13 | `audited_passed` |

## Deliverables

```text
server/src/models/Conversation.js             # spec §25 schema + indexes
server/src/models/Message.js                  # spec §25 schema + indexes
server/src/services/conversationService.js    # ensureConversation, list, markRead
server/src/services/messageService.js         # send, history
server/src/services/chatPolicy.js             # canChat wrapper: connection + block + status
server/src/controllers/chat.controller.js
server/src/routes/chat.routes.js
server/src/validators/chat.validators.js
server/src/constants/chat.js                  # message length cap, page sizes
```

## Data model

### `conversations` (spec §25)

```js
{
  _id: ObjectId,
  participantIds: [ObjectId],
  lastMessage: String | null,
  lastMessageAt: Date | null,
  createdAt: Date,
  updatedAt: Date
}
```

| Index | Definition | Purpose |
|---|---|---|
| participants | `{ participantIds: 1 }` | List a user's conversations |
| pair uniqueness | `{ participantIds: 1 }` unique with a normalised, sorted pair | One conversation per pair |

**Pair normalisation:** store `participantIds` in a deterministic order (for example, sorted ascending) so the unique
index prevents two conversations for the same pair regardless of who opens the chat first. Document the rule in the
model.

### `messages` (spec §25)

```js
{
  _id: ObjectId,
  conversationId: ObjectId,
  senderId: ObjectId,
  message: String,
  type: "text",
  readAt: Date | null,
  createdAt: Date
}
```

| Index | Definition | Purpose |
|---|---|---|
| history | `{ conversationId: 1, createdAt: -1 }` | Paginated history in reverse order |
| unread | `{ conversationId: 1, senderId: 1, readAt: 1 }` | Unread counting / read receipts |

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/conversations` | authenticated | The caller's conversations, ordered by `lastMessageAt` |
| GET | `/api/v1/conversations/:conversationId/messages` | authenticated, participant | Paginated history |
| POST | `/api/v1/conversations/:conversationId/messages` | authenticated, participant and eligible | Send a text message |

## Future implementation plan

- [ ] 1. When chat is scheduled, write `models/Conversation.js` and `models/Message.js` with the schemas, base
      plugin, and indexes, including
      the normalised-pair unique index.
- [ ] 2. Write `chatPolicy.canChat(a, b)`: return true only when an `accepted` connection exists (not `closed`,
      `rejected`, `withdrawn`, or `expired`) **and** no block exists either way **and** both accounts are `active`
      (spec §21, §22, §100; the `closed` status and the block-means-closed-for-access rule are finalized in
      decisions §7).
- [ ] 3. Write `conversationService.ensureConversation(a, b)`: create or return the single conversation for a pair,
      refusing if `canChat` is false; handle the concurrent-create race via the unique index.
- [ ] 4. Create the conversation on connection acceptance: hook into step 11's accept path (or create lazily on first
      message — pick one and document it; lazily is simpler and avoids empty conversations).
- [ ] 5. Write `messageService.send()`: verify the caller is a participant, verify `canChat` still holds at send time
      (a block after acceptance must stop new messages), validate the message length, insert the message, and update
      the conversation's `lastMessage`/`lastMessageAt` in the same logical operation.
- [ ] 6. Emit a `new_message` event for step 13's notification path, coalesced per conversation.
- [ ] 7. Write `messageService.history()`: cursor-paginated reverse-chronological history scoped to the conversation,
      with a bounded page size (spec §52).
- [ ] 8. Implement read receipts: mark messages `readAt` when the recipient loads them, and expose unread counts per
      conversation in the list.
- [ ] 9. Reject all non-text types; `type` is fixed to `text` in this version (spec §25).
- [ ] 10. Rate-limit message sends per user and per conversation (spec §36) and cap message length (spec §80).
- [ ] 11. Sanitise/escape message text on render-side contract: store exactly what was sent, but never render it as
      HTML. Document that the API returns plain text only.
- [ ] 12. Write controller, routes, and validators with `requireAuth` and a participant check that returns 404 for a
      non-participant (do not confirm the conversation's existence).

## Business rules & security

- **Backend decides chat access.** Not the client, not a stored flag, and not the presence of a conversation row
  (spec §25, §91, §100).
- **Blocking stops chat immediately,** including for an already-accepted connection (spec §22); such a connection is
  treated as closed for access (decisions §7).
- **A closed connection is read-only:** when the connection status becomes `closed` (either participant closed it, or
  a block/admin action made it unusable), `canChat` returns false and the backend refuses new sends, while existing
  messages remain readable for history. The client never decides this (decisions §7).
- **Participant-only access:** a non-participant gets 404 on history and on send (spec §44, §112).
- **Text only:** no attachments and no media in this version (spec §25, §115).
- **Bounded messages:** length cap, page caps, and send rate limits (spec §36, §80).
- **No message content in logs** (spec §78).
- **Denormalised last message:** only the last message preview is stored on the conversation; the full history lives
  in `messages` (spec §25).

## Config / environment additions

```text
MESSAGE_MAX_LEN            # maximum characters per message
CHAT_PAGE_SIZE             # messages per page
CHAT_DEFAULT_LIMIT         # conversations per page
CHAT_RATE_LIMIT_WINDOW     # send window
CHAT_RATE_LIMIT_MAX        # sends per window (per user)
```

## Future verification commands

Run these commands only after chat has been explicitly scheduled and implemented:

```bash
A=...   # account A (in an accepted connection with B)
B=...   # account B
C=...   # account C (no connection)

# 1. Conversations list
curl -sS -H "Authorization: Bearer $A" http://localhost:3000/api/v1/conversations
# Expected: the pair's conversation, ordered by lastMessageAt

# 2. Send a message
curl -sS -X POST http://localhost:3000/api/v1/conversations/<id>/messages -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' -d '{"message":"Hello there"}'
# Expected: 201; conversation lastMessage updated

# 3. History
curl -sS -H "Authorization: Bearer $B" http://localhost:3000/api/v1/conversations/<id>/messages
# Expected: 200 with the message, newest first, paginated

# 4. Non-participant access
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/conversations/<id>/messages \
  -H "Authorization: Bearer $C"
# Expected: 404

# 5. Not-connected pair cannot chat
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  http://localhost:3000/api/v1/conversations/<newPairId>/messages -H "Authorization: Bearer $C" \
  -H 'Content-Type: application/json' -d '{"message":"Hi"}'
# Expected: 403/404; no conversation created

# 6. Block after acceptance stops new messages
curl -sS -X POST http://localhost:3000/api/v1/blocks -H "Authorization: Bearer $B" \
  -H 'Content-Type: application/json' -d '{"userId":"<aUserId>"}'
curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
  http://localhost:3000/api/v1/conversations/<id>/messages -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' -d '{"message":"Still here?"}'
# Expected: 403; existing history remains readable per the product rule

# 7. Non-text type rejected
curl -sS -X POST http://localhost:3000/api/v1/conversations/<id>/messages -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' -d '{"message":"x","type":"image","url":"..."}'
# Expected: 400

# 8. Oversized message rejected
curl -sS -X POST http://localhost:3000/api/v1/conversations/<id>/messages -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' -d "{\"message\":\"$(head -c 100000 /dev/zero | tr '\0' 'a')\"}"
# Expected: 400

# 9. Read receipts
#   B loads history; A's unread count for that conversation drops.
# Expected: readAt set; unread count 0

# 10. Rate limit
for i in $(seq 1 200); do curl -sS -o /dev/null -X POST \
  http://localhost:3000/api/v1/conversations/<id>/messages -H "Authorization: Bearer $A" \
  -H 'Content-Type: application/json' -d '{"message":"spam"}'; done
# Expected: 429s after the threshold
```

## Future audit checklist

Apply this checklist only after chat has been scheduled and implemented:

### Gate 1 — Build integrity

- [ ] **G1.1** Every deliverable exists; chat routes mounted and protected.
- [ ] **G1.2** Server boots with both models and their indexes, including the normalised-pair unique index.
- [ ] **G1.3** Steps 01–13 verification commands still pass.

### Gate 2 — Functional

- [ ] **G2.1** A conversation exists for an accepted pair and is listed for both participants.
- [ ] **G2.2** Sending and reading history work, newest first, paginated.
- [ ] **G2.3** Only one conversation exists per pair, including under concurrent creation.
- [ ] **G2.4** `lastMessage` and `lastMessageAt` update on send and drive list ordering.
- [ ] **G2.5** Read receipts set `readAt` and reduce unread counts.
- [ ] **G2.6** A pair without an accepted connection cannot chat.
- [ ] **G2.7** A block after acceptance stops new messages in both directions while leaving history readable per the
      documented rule.
- [ ] **G2.8** Non-text message types are refused.
- [ ] **G2.9** History pagination is stable and complete.

### Gate 3 — Security

- [ ] **G3.1** A non-participant gets 404 on both history and send.
- [ ] **G3.2** A client-supplied `senderId` cannot impersonate another user.
- [ ] **G3.3** Chat is refused for a blocked pair and for non-accepted pairs, verified by direct API calls rather
      than the UI.
- [ ] **G3.4** Message text is never rendered or returned as executable markup; the API returns plain text.
- [ ] **G3.5** Malformed ObjectIds are rejected before any query.
- [ ] **G3.6** Rate limits and length caps trigger.
- [ ] **G3.7** Message content does not appear in logs.
- [ ] **G3.8** Unauthenticated requests return 401.

### Gate 4 — Performance & data

- [ ] **G4.1** History and conversation listing use their designed indexes (`IXSCAN`).
- [ ] **G4.2** History is cursor-paginated with a bounded page size; there is no unbounded message fetch.
- [ ] **G4.3** The conversation list does not load message documents or profile documents per row.
- [ ] **G4.4** Updating `lastMessage` on send does not cause an extra full-document read-modify-write per message.

### Gate 5 — Spec conformance

- [ ] **G5.1** §25 — the conversation and message documents match the specification, text-only.
- [ ] **G5.2** §100 — the backend determines when chat is allowed.
- [ ] **G5.3** §22 — blocking severs chat.
- [ ] **G5.4** §24 — `new_message` notifications are produced (via step 13).
- [ ] **G5.5** §52 — history is paginated with an opaque cursor.
- [ ] **G5.6** §105 — the conversation and message indexes exist.
- [ ] **G5.7** §115 — no media/attachment system was added prematurely.

### Verdict

| | |
|---|---|
| Gate 1 | ☐ pass ☐ fail |
| Gate 2 | ☐ pass ☐ fail |
| Gate 3 | ☐ pass ☐ fail |
| Gate 4 | ☐ pass ☐ fail |
| Gate 5 | ☐ pass ☐ fail |
| **Result** | ☐ PASS ☐ PASS WITH NOTES ☐ FAIL |

## Future acceptance criteria

These criteria apply only when chat is implemented in a later phase:

- [ ] Only connected, unblocked, active users can exchange messages.
- [ ] Conversations are unique per pair and correct for both participants.
- [ ] History is paginated and readable, and read receipts work.
- [ ] Blocking stops new messages immediately.
- [ ] A later realtime layer can reuse this persistence model unchanged.

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence | |
| Fixes required | |
