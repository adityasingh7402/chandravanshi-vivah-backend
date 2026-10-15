'use strict';

/**
 * `reports` model (spec §23, §101, §105, §112; step 12 task 1).
 *
 * The document is spec §23's exactly. Two fields are the whole point of this
 * file's care:
 *
 *   - **`reporterId` and `reviewedBy` are `select: false`.** The reporter's
 *     identity is the platform's most sensitive moderation field (spec §112): the
 *     reported user must never learn who reported them, and only an admin sees it,
 *     and only in the moderation view (spec §101). Hiding them at the schema
 *     level means a careless query cannot leak them — a serialiser would have to
 *     opt in explicitly. Step 16's admin queue is the one place that does:
 *     `Report.find(...).select('+reporterId +reviewedBy')`.
 *
 *     Filtering by them still works: `select: false` only affects what is
 *     *returned*, not what a query may match on, so the duplicate check can still
 *     count a reporter's own open reports.
 *   - **`evidence` is an array of bounded strings.** Spec §23 types it
 *     `[String]`; the validator enforces the cap and refuses objects, so the
 *     array can never become a place to smuggle structured data into a
 *     moderation screen (spec §34).
 *
 * `status` / `reviewedBy` / `reviewedAt` are never writable from a user route
 * (spec §32, §44) — step 12 creates `open` reports and step 16 owns every
 * transition.
 */

const mongoose = require('mongoose');
const { baseSchema } = require('./plugins/baseSchema');
const { COLLECTIONS } = require('../config/collections');
const { REPORT_CATEGORIES, REPORT_STATUSES, REPORT_STATUS } = require('../constants/safety');

const { ObjectId } = mongoose.Schema.Types;

const reportSchema = new mongoose.Schema(
  {
    // The filer. `select: false` — admin-only (spec §112). Always
    // `req.auth.userId`, never a body field (spec §44).
    reporterId: { type: ObjectId, ref: 'User', required: true, select: false },
    // Who is being reported. A missing or non-visible target is refused by the
    // service, so a report always names a real profile.
    reportedUserId: { type: ObjectId, ref: 'User', required: true },
    category: { type: String, enum: REPORT_CATEGORIES, required: true },
    description: { type: String, default: null },
    // Strings only — a `media` or `photo` reference is represented by its
    // identifier, not by a nested object (spec §34).
    evidence: { type: [String], default: [] },
    status: {
      type: String,
      enum: REPORT_STATUSES,
      required: true,
      default: REPORT_STATUS.OPEN
    },
    // Admin-only bookkeeping; written by step 16's moderation actions.
    reviewedBy: { type: ObjectId, ref: 'User', default: null, select: false },
    reviewedAt: { type: Date, default: null }
  },
  { collection: COLLECTIONS.REPORTS }
);

reportSchema.plugin(baseSchema);

// Spec §105 / step 12 index table.
//
// (1) The moderation queue for one reported account, and the duplicate check.
reportSchema.index({ reportedUserId: 1, status: 1 });
// (2) The caller's own report history, newest first.
reportSchema.index({ reporterId: 1, createdAt: -1 });
// (3) The admin queue ordering (step 16).
reportSchema.index({ status: 1, createdAt: -1 });

const Report = mongoose.models.Report || mongoose.model('Report', reportSchema);

module.exports = Report;
