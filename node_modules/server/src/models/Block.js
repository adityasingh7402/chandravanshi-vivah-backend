'use strict';

/**
 * `blocks` model (spec §22, §99, §105; step 12 task 1).
 *
 * The document is spec §22's exactly — `blockerId`, `blockedUserId`, an optional
 * private `reason`, and the timestamp. It is deliberately tiny: a block carries
 * no state machine and no effect flags, because every effect is *derived* from
 * the row at read time (spec §91 — a client-trusted flag could be forged).
 *
 * The one rule that is a database rule rather than a service convention:
 *
 *   - **`{ blockerId, blockedUserId }` is unique**, so blocking is idempotent by
 *     construction. A double-tap or a retry collapses into the existing row
 *     instead of creating a second one, and the service's upsert cannot race
 *     itself into duplicates.
 *
 * The pair is *directed* in storage — A blocking B is a different row from B
 * blocking A — but every consumer reads it **undirected**: `blockExclusion`
 * returns the union of "who I blocked" and "who blocked me", which is what makes
 * the effect bilateral (spec §22, §99).
 *
 * `reason` is documented as visible only to the blocker; it is never returned to
 * the blocked account, and it is not part of any discovery projection.
 */

const mongoose = require('mongoose');
const { baseSchema } = require('./plugins/baseSchema');
const { COLLECTIONS } = require('../config/collections');

const { ObjectId } = mongoose.Schema.Types;

const blockSchema = new mongoose.Schema(
  {
    // Who is blocking. Always `req.auth.userId` (spec §44) — a body blockerId is
    // rejected by the validator before it can reach here.
    blockerId: { type: ObjectId, ref: 'User', required: true },
    // Who is blocked. Stored as the account id: the exclusion set and the pair
    // lookups are keyed by account (spec §99).
    blockedUserId: { type: ObjectId, ref: 'User', required: true },
    // Optional and private to the blocker. Text only, length-capped by the
    // validator (spec §34, §80).
    reason: { type: String, default: null }
  },
  { collection: COLLECTIONS.BLOCKS }
);

blockSchema.plugin(baseSchema);

// Spec §105 index checklist.
//
// (1) "Who did I block" — the block list and the exclusion union.
blockSchema.index({ blockerId: 1 });
// (2) "Who blocked me" — the other half of the union (spec §99).
blockSchema.index({ blockedUserId: 1 });
// (3) Idempotent blocking, enforced by the database rather than a read-then-write
//     in the service.
blockSchema.index({ blockerId: 1, blockedUserId: 1 }, { unique: true });

const Block = mongoose.models.Block || mongoose.model('Block', blockSchema);

module.exports = Block;
