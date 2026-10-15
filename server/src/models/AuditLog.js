'use strict';

/**
 * `audit_logs` model (spec §29, §101, §105; step 16 task 1).
 *
 * The document is spec §29's exactly: actor, action, target, small metadata,
 * timestamp. Two properties make it an *audit* trail rather than a log:
 *
 *   - **Append-only.** There is no update or delete route anywhere in the API
 *     (gate G3.4), and nothing in `src/` may call `updateOne` on this model.
 *     A future retention prune must be an explicit operator action, never a
 *     request path. The schema therefore declares no mutable surface to reach
 *     for by accident: `metadata` is written once at insert and read forever
 *     after.
 *   - **The action is an enum, not free text** (spec §29, task 2). The
 *     `action` path validates against `constants/adminActions.js`, so an
 *     unknown name fails at the database boundary even if a call site bypasses
 *     `auditService.log()`'s own check. One typo cannot create an audit row
 *     that no query will ever find.
 *
 * `actorUserId` is required: every privileged action has an authenticated
 * actor (spec §31, §44). `targetId` is nullable because a few actions target
 * the collection rather than one row (a bulk role change, a notification
 * fan-out) — the metadata then carries the specifics.
 */

const mongoose = require('mongoose');
const { baseSchema } = require('./plugins/baseSchema');
const { COLLECTIONS } = require('../config/collections');
const { ADMIN_ACTION_VALUES, AUDIT_TARGET_TYPES } = require('../constants/adminActions');

const { ObjectId } = mongoose.Schema.Types;

const auditLogSchema = new mongoose.Schema(
  {
    // The authenticated account that performed the action (spec §29).
    actorUserId: { type: ObjectId, ref: 'User', required: true },

    // Enum, not free text — see the module note (spec §29).
    action: { type: String, enum: ADMIN_ACTION_VALUES, required: true },

    // What kind of thing was acted upon; pairs with `targetId`.
    targetType: { type: String, enum: AUDIT_TARGET_TYPES, required: true },
    // Null only when the action targeted a set of rows rather than one.
    targetId: { type: ObjectId, default: null },

    // Small, non-sensitive context (spec §29): ids, before/after status
    // names, counts. Never a token, a hash, a password, an email or a phone
    // number — `auditService.log()` rejects the sensitive keys by name, and
    // this surface is admin-only anyway (spec §30, §112).
    metadata: { type: Object, default: null }
  },
  { collection: COLLECTIONS.AUDIT_LOGS }
);

auditLogSchema.plugin(baseSchema);

// Spec §105 / step 16 index table: review an admin's actions, review a
// record's history, and audit by action type — each a bounded range scan on
// its own index rather than a collection scan (gate G4.3).
auditLogSchema.index({ actorUserId: 1, createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });

const AuditLog = mongoose.models.AuditLog || mongoose.model('AuditLog', auditLogSchema);

module.exports = AuditLog;
