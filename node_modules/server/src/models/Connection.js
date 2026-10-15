'use strict';

/**
 * `connections` model (spec §21, §100, §105; finalized decisions §7, §8;
 * step 11 task 1).
 *
 * One document per interest handshake. The document shape is spec §21's exactly
 * (`senderId`, `receiverId`, `status`, `message`, `createdAt`, `respondedAt`),
 * with `closed` added to the status enum by decisions §7 and `updatedAt` coming
 * from the shared base plugin.
 *
 * Three rules are database rules rather than service conventions:
 *
 *  1. **One active relationship per directed pair** — the partial unique index
 *     below, restricted to the *open* statuses (`pending`, `accepted`). Terminal
 *     rows (`rejected`, `withdrawn`, `expired`, `closed`) are history and do not
 *     occupy the slot, which is what makes the documented re-send-after-close
 *     rule possible (decisions §8; see `constants/connection.js` for the
 *     resolved §7/§8 ambiguity).
 *  2. **`status` is an enum at the schema level too**, from the same constant the
 *     policy and validator read, so a service bug cannot persist a value no
 *     client can interpret (spec §34, §81).
 *  3. **`message` is nullable text**, matching the §21 `String | null` — absent
 *     reads back as `null`, never as `""`.
 *
 * The partial index is the concurrency guarantee for task 11: two identical
 * sends racing each other cannot both insert, and the loser is translated to a
 * 409 by the service rather than surfacing as a 500.
 */

const mongoose = require('mongoose');
const { baseSchema } = require('./plugins/baseSchema');
const { COLLECTIONS } = require('../config/collections');
const { CONNECTION_STATUSES, CONNECTION_STATUS, ACTIVE_STATUSES } = require('../constants/connection');

const { ObjectId } = mongoose.Schema.Types;

const connectionSchema = new mongoose.Schema(
  {
    // Who sent the interest. Always `req.auth.userId` (spec §44) — a body userId
    // is rejected by the validator before it can reach here.
    senderId: { type: ObjectId, ref: 'User', required: true },
    // Who received it. The pair is directed: a crossing interest is a different
    // row (and refused while an active one exists, see the service).
    receiverId: { type: ObjectId, ref: 'User', required: true },
    status: {
      type: String,
      enum: CONNECTION_STATUSES,
      required: true,
      default: CONNECTION_STATUS.PENDING
    },
    // The optional accompanying note. Text only, length-capped by the validator
    // (spec §34, §80); `null` when the sender wrote nothing.
    message: { type: String, default: null },
    // When the relationship reached a terminal status (a response, a withdrawal
    // or a closure). null while `pending` or `accepted` (spec §21).
    respondedAt: { type: Date, default: null }
  },
  { collection: COLLECTIONS.CONNECTIONS }
);

connectionSchema.plugin(baseSchema);

// Spec §105 index checklist.
//
// (1) Sent interests, filtered by status.
connectionSchema.index({ senderId: 1, status: 1 });
// (2) Received interests, filtered by status.
connectionSchema.index({ receiverId: 1, status: 1 });
// (3) One *open* relationship per directed pair (decisions §8). A partial index
//     over the active statuses, so terminal history can accumulate. This is the
//     index that turns a concurrent duplicate send into error 11000 — which the
//     service maps to 409 Conflict.
connectionSchema.index(
  { senderId: 1, receiverId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ACTIVE_STATUSES } } }
);
// (4) The expiry sweep: stale `pending` rows only, by age.
connectionSchema.index({ status: 1, createdAt: 1 });

const Connection = mongoose.models.Connection || mongoose.model('Connection', connectionSchema);

module.exports = Connection;
