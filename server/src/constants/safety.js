'use strict';

/**
 * Block & report constants (spec §22, §23, §101, §112; step 12 tasks 2, 9).
 *
 * Two safety surfaces, one module, because they share a vocabulary of "what a
 * user may tell the platform about another user":
 *
 *   - **Blocks** are bilateral in effect (spec §22): the pair is cut out of
 *     discovery, interests, actions, chat and notifications in *both* directions,
 *     regardless of who blocked whom.
 *   - **Reports** open a moderation case (spec §23, §101). The category set and
 *     the moderation status set are the enum the model and the validator both
 *     read, so a value can never drift between them.
 *
 * `reviewedBy` / `reviewedAt` deliberately live here too: they are the
 * *admin-only* fields, and listing them by name in one place is what lets the
 * validators and the serialisers assert that a user route never writes or returns
 * them (spec §32, §44).
 *
 * Everything mutable (caps, rate windows, page sizes) lives in `config/env.js`.
 */

/** Spec §23 — the eight report categories, in the order the spec lists them. */
const REPORT_CATEGORIES = Object.freeze([
  'fake_profile',
  'spam',
  'harassment',
  'fraud',
  'inappropriate_photo',
  'wrong_information',
  'already_married',
  'other'
]);

/** Spec §23 — the moderation lifecycle. Step 16 owns every transition. */
const REPORT_STATUSES = Object.freeze(['open', 'reviewing', 'resolved', 'dismissed']);
const REPORT_STATUS = Object.freeze({
  OPEN: 'open',
  REVIEWING: 'reviewing',
  RESOLVED: 'resolved',
  DISMISSED: 'dismissed'
});

/**
 * Statuses that mean "a moderator still has this".
 *
 * The duplicate rule for a report is scoped to these: a second report for the
 * same pair and category is refused while one is still open or being reviewed
 * (gate G2.9), which stops a report button from becoming a review-flood vector.
 * Once a report is `resolved` or `dismissed` the pair may be reported again.
 */
const ACTIVE_REPORT_STATUSES = Object.freeze([REPORT_STATUS.OPEN, REPORT_STATUS.REVIEWING]);

/** Statuses a caller may never set on their own report (spec §32, §44). */
const ADMIN_ONLY_REPORT_FIELDS = Object.freeze(['status', 'reviewedBy', 'reviewedAt']);

/** True when `value` is one of the eight §23 categories. */
function isReportCategory(value) {
  return REPORT_CATEGORIES.includes(value);
}

/** True when `value` is one of the four §23 statuses. */
function isReportStatus(value) {
  return REPORT_STATUSES.includes(value);
}

/** True when a report in this status still needs a moderator. */
function isActiveReportStatus(value) {
  return ACTIVE_REPORT_STATUSES.includes(value);
}

module.exports = {
  REPORT_CATEGORIES,
  REPORT_STATUSES,
  REPORT_STATUS,
  ACTIVE_REPORT_STATUSES,
  ADMIN_ONLY_REPORT_FIELDS,
  isReportCategory,
  isReportStatus,
  isActiveReportStatus
};
