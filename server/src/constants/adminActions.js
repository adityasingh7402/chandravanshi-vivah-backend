'use strict';

/**
 * Admin action vocabulary (spec §29, §101; step 16 tasks 3, 6).
 *
 * Every audit row's `action` must be one of these names — call sites never
 * pass free text, so a typo is a test failure rather than a silently
 * unqueryable audit trail. The documented names from spec §29 come first;
 * the rest are extensions the step's own flows need (report review,
 * profile hide/restore, reorder, role change) and are equally frozen.
 */

/** Spec §29's examples plus the step-16 flows, in documentation order. */
const ADMIN_ACTIONS = Object.freeze({
  // Users (task 5)
  SUSPENDED_USER: 'admin_suspended_user',
  REACTIVATED_USER: 'admin_reactivated_user',
  DEACTIVATED_USER: 'admin_deactivated_user',
  // Profiles (task 5)
  HIDDEN_PROFILE: 'admin_hidden_profile',
  RESTORED_PROFILE: 'admin_restored_profile',
  DEACTIVATED_PROFILE: 'admin_deactivated_profile',
  // Report queue (task 6; step 12 left every transition to this step)
  REVIEWED_REPORT: 'admin_reviewed_report',
  RESOLVED_REPORT: 'admin_resolved_report',
  DISMISSED_REPORT: 'admin_dismissed_report',
  // Photo moderation (task 7)
  APPROVED_PHOTO: 'admin_approved_photo',
  REJECTED_PHOTO: 'admin_rejected_photo',
  // Master data — Gotra/Surname approvals (spec §75) and generic management
  APPROVED_GOTRA: 'admin_approved_gotra',
  APPROVED_SURNAME: 'admin_approved_surname',
  CREATED_MASTER_ITEM: 'admin_created_master_item',
  UPDATED_MASTER_ITEM: 'admin_updated_master_item',
  RENAMED_MASTER_ITEM: 'admin_renamed_master_item',
  REORDERED_MASTER_ITEM: 'admin_reordered_master_item',
  DEACTIVATED_MASTER_ITEM: 'admin_deactivated_master_item',
  VERIFIED_MASTER_ITEM: 'admin_verified_master_item',
  REJECTED_MASTER_ITEM: 'admin_rejected_master_item',
  MERGED_MASTER_ITEM: 'admin_merged_master_item',
  // Notifications & billing inspection (tasks 10, 11)
  SENT_NOTIFICATION: 'admin_sent_notification',
  VIEWED_SUBSCRIPTION: 'admin_viewed_subscription',
  // Reserved: a password reset, if ever added, is an audited support action
  // (spec §6) — never a self-service path. No route writes this today.
  RESET_PASSWORD: 'admin_reset_password',
  // `scripts/grant-admin.js` (task 12). No request path may change a role.
  ROLE_UPDATED: 'admin_role_updated'
});

/** Fast membership check used by `auditService.log()`. */
const ADMIN_ACTION_VALUES = Object.freeze(Object.values(ADMIN_ACTIONS));
const ADMIN_ACTION_SET = new Set(ADMIN_ACTION_VALUES);

/**
 * What an action touched. `targetType` is one of these, so an audit query can
 * filter by kind without prefix-matching free text.
 */
const AUDIT_TARGET_TYPES = Object.freeze([
  'user',
  'profile',
  'photo',
  'report',
  'master_item',
  'master_data_request',
  'notification',
  'subscription',
  'role'
]);
const AUDIT_TARGET_TYPE_SET = new Set(AUDIT_TARGET_TYPES);

/**
 * Legal report-queue transitions (task 6, spec §101).
 *
 * `open → reviewing → resolved | dismissed`, and `open` may go straight to a
 * terminal state (a moderator who can dispose of a case on sight should not
 * be forced through an intermediate step). Terminal states transition
 * nowhere: reopening would discard the reviewer record, and a resolved case
 * with new evidence is a NEW report (step 12's duplicate rule already scopes
 * itself to open/reviewing cases).
 */
const REPORT_TRANSITIONS = Object.freeze({
  open: Object.freeze(['reviewing', 'resolved', 'dismissed']),
  reviewing: Object.freeze(['resolved', 'dismissed']),
  resolved: Object.freeze([]),
  dismissed: Object.freeze([])
});

/** The audit action each report transition writes. */
const REPORT_TRANSITION_ACTIONS = Object.freeze({
  reviewing: ADMIN_ACTIONS.REVIEWED_REPORT,
  resolved: ADMIN_ACTIONS.RESOLVED_REPORT,
  dismissed: ADMIN_ACTIONS.DISMISSED_REPORT
});

/** The notification types an admin may originate (task 10, spec §24). */
const ADMIN_NOTIFICATION_TYPES = Object.freeze(['admin_alert', 'verification_completed']);

/** The user-status values an admin may set (task 5; spec §5, §98). */
const ADMIN_USER_STATUSES = Object.freeze(['suspended', 'active', 'deleted']);

/** The profile-status values an admin may set (task 5; spec §58, §98). */
const ADMIN_PROFILE_STATUSES = Object.freeze(['hidden', 'active', 'deleted']);

module.exports = {
  ADMIN_ACTIONS,
  ADMIN_ACTION_VALUES,
  ADMIN_ACTION_SET,
  AUDIT_TARGET_TYPES,
  AUDIT_TARGET_TYPE_SET,
  REPORT_TRANSITIONS,
  REPORT_TRANSITION_ACTIONS,
  ADMIN_NOTIFICATION_TYPES,
  ADMIN_USER_STATUSES,
  ADMIN_PROFILE_STATUSES
};
