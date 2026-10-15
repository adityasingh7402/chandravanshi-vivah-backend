'use strict';

/**
 * `profile_actions` model (spec §20, §56, §99, §100, §105; finalized decisions
 * §15; step 10 task 1).
 *
 * One collection for the four lightweight interactions a member has with another
 * member's profile — `view`, `like`, `shortlist`, `pass` — so they never grow
 * the `matrimonial_profiles` document (spec §20, §69). It answers a narrow
 * question: *what has this account done to that one?*
 *
 * Three rules are database rules rather than service conventions:
 *
 *  1. **One row per (from, to, type)** — the unique index below. Repeating a
 *     like or a shortlist is an upsert, not a second row, and, because a view is
 *     *also* one row per pair (decisions §15), a hot profile cannot grow this
 *     collection without bound.
 *  2. **`createdAt` is the "last time" stamp for a pair.** For a non-view action
 *     it is simply when the action happened. For a view the row is refreshed on
 *     every repeat view, so `createdAt` means *most recent* view (decisions §15)
 *     — which is why it is explicitly made writable below: Mongoose marks
 *     `createdAt` immutable under `timestamps: true`, and leaving that on would
 *     make the documented "refresh the view timestamp" write impossible.
 *  3. **`type` is an enum at the schema level too**, from the same constant the
 *     validator reads, so a service bug cannot persist a value no client can
 *     interpret (spec §34, §81).
 *
 * `updatedAt` comes from the shared base plugin and is the row's own audit
 * stamp; the discovery recency signal lives on the profile and is written by the
 * action service, not here.
 */

const mongoose = require('mongoose');
const { baseSchema } = require('./plugins/baseSchema');
const { COLLECTIONS } = require('../config/collections');
const { ACTION_TYPES } = require('../constants/actions');

const { ObjectId } = mongoose.Schema.Types;

const profileActionSchema = new mongoose.Schema(
  {
    // The actor, always `req.auth.userId` (spec §44) — a body userId is rejected
    // by the validator before it can reach here.
    fromUserId: { type: ObjectId, ref: 'User', required: true },
    // The target profile's owner. Stored as the account id, never the
    // `publicProfileId`, because the exclusion set and the listings are keyed by
    // account (spec §99).
    toUserId: { type: ObjectId, ref: 'User', required: true },
    type: { type: String, enum: ACTION_TYPES, required: true }
  },
  { collection: COLLECTIONS.PROFILE_ACTIONS }
);

profileActionSchema.plugin(baseSchema);

// Decisions §15: a repeat view *updates* the row's timestamp instead of adding a
// row. Mongoose sets `createdAt` immutable under timestamps, so allow the
// documented refresh explicitly rather than relying on a second timestamp field
// that would deviate from the §20 document shape.
profileActionSchema.path('createdAt').immutable(false);

// Spec §105 index checklist.
//
// (1) One row per pair and type — the idempotency guarantee *and* the one-row
//     view rule, enforced by the database under concurrency.
profileActionSchema.index({ fromUserId: 1, toUserId: 1, type: 1 }, { unique: true });
// (2) "Who viewed/liked me" and moderation context (target, newest first).
profileActionSchema.index({ toUserId: 1, type: 1, createdAt: -1 });
// (3) The caller's own shortlist / view history and the pass exclusion set.
profileActionSchema.index({ fromUserId: 1, type: 1, createdAt: -1 });

const ProfileAction =
  mongoose.models.ProfileAction || mongoose.model('ProfileAction', profileActionSchema);

module.exports = ProfileAction;
