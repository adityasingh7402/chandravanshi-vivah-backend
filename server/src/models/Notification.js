'use strict';

/**
 * `notifications` model (spec §24, §30, §105; step 13 task 1).
 *
 * The document is spec §24's exactly: the recipient, one of the nine types, a
 * title, a body, a small `data` payload and `readAt`. Two conventions are
 * deliberate:
 *
 *   - **`data` is a payload, not a document copy.** It carries identifiers the
 *     client needs to navigate (`connectionId`, `fromProfileId`, later
 *     `conversationId`) — never a profile, a message body, or another user's
 *     private fields (spec §24, §30, §112). The gate G3.4/G4.3 assertion is that
 *     the object stays small by construction: every producer names its keys.
 *   - **`type` is the spec enum**, enforced here so a typo in a future event
 *     mapping fails at insert rather than shipping an unknown type to a client.
 *
 * `userId` is the *recipient* — always `req.auth.userId` on the read side, and
 * always a server-derived id on the write side (spec §44). No client-supplied
 * value ever becomes this field.
 *
 * Indexes (spec §105):
 *   (1) `{ userId: 1, createdAt: -1, _id: -1 }` — the paginated inbox, newest
 *       first. The `_id` suffix is a tiebreaker: two rows can share a
 *       millisecond, the keyset cursor breaks ties on `_id`, and the sort must
 *       be *fully* index-provided or MongoDB falls back to a blocking sort of
 *       every row the filter matched.
 *   (2) `{ userId: 1, readAt: 1 }`     — the unread filter and the badge count.
 *
 * The optional dedupe index from the step file is **not** created: throttling
 * matches on `{ userId, type, createdAt }` inside a small window, which the
 * inbox index already covers by its `userId` prefix, so a third index would
 * cost a write on every notification to save a bounded range scan of one user's
 * recent rows.
 */

const mongoose = require('mongoose');
const { baseSchema } = require('./plugins/baseSchema');
const { COLLECTIONS } = require('../config/collections');
const { NOTIFICATION_TYPES } = require('../constants/notifications');

const { ObjectId } = mongoose.Schema.Types;

const notificationSchema = new mongoose.Schema(
  {
    // The recipient. Server-derived, never client-supplied (spec §44).
    userId: { type: ObjectId, ref: 'User', required: true },
    // Spec §24's nine values, enforced by the schema itself.
    type: {
      type: String,
      required: true,
      enum: { values: NOTIFICATION_TYPES, message: 'Unknown notification type.' }
    },
    title: { type: String, required: true },
    body: { type: String, required: true },
    // Small payload of identifiers only (see the module note). Mixed is used
    // because the key set differs per type; producers are responsible for
    // naming keys, and `strict: true` drops anything undeclared elsewhere.
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    // `null` = unread. Set on read; reset to `null` when a coalesced repeat
    // re-surfaces the row (task 6), so the badge count reflects the newest
    // signal rather than a row the user already cleared.
    readAt: { type: Date, default: null }
  },
  { collection: COLLECTIONS.NOTIFICATIONS }
);

notificationSchema.plugin(baseSchema);

// Spec §105 index checklist.
//
// (1) The paginated inbox: one recipient's rows, newest first. `_id` completes
//     the sort so the keyset cursor's tiebreaker is index-provided too (see the
//     module note).
notificationSchema.index({ userId: 1, createdAt: -1, _id: -1 });
// (2) The unread filter and the badge count. Kept as the plain `{ userId,
//     readAt }` shape the step file specifies rather than a partial index:
//     `readAt: null` on the query side matches missing *and* null, so a partial
//     predicate would not be implied by every read path and MongoDB could fall
//     back to a collection scan on a predicate it does not recognise.
notificationSchema.index({ userId: 1, readAt: 1 });

const Notification = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);

module.exports = Notification;
