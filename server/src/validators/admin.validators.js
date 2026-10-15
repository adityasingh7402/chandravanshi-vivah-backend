'use strict';

/**
 * Admin request validation (spec §34, §44, §80; step 16 task 13).
 *
 * The same three disciplines the action, connection and safety validators
 * apply, on the most privileged surface in the API:
 *
 *  1. **`.strict()` everywhere.** An unknown field is a 400, not something
 *     ignored. On an admin route that is what stops a body from carrying a
 *     `reviewedBy`, an `actorUserId` or a `role` into a service that would
 *     otherwise have to remember to ignore it (spec §34, §44; gate G3.6,
 *     G3.8). The actor is always `req.auth.userId`, set by `requireAuth` from
 *     the session — never a body field (spec §31).
 *  2. **Ids are ObjectIds, validated before the service runs** (spec §35).
 *     A malformed `:userId` / `:reportId` / `:photoId` is a field-level 400
 *     rather than a cast error after a database round trip.
 *  3. **Free text is bounded and markup-free**, and pagination is bounded on
 *     both ends — the service clamps to the configured maximum, so an
 *     oversized `limit` yields a bounded page rather than an error (spec §80,
 *     §91; the step-12 convention).
 *
 * Role/status/type enums come from `constants/`, so a value can never be
 * accepted by the validator and rejected by the model, or vice versa.
 */

const { z } = require('zod');
const { validateQuery } = require('./validate');
const { ROLE_VALUES } = require('../constants/auth');
const { REPORT_STATUSES } = require('../constants/safety');
const { MODERATION_STATUSES } = require('../constants/photo');
const { MASTER_TYPE_VALUES } = require('../constants/masterData');
const { REQUEST_TYPES } = require('../constants/masterCategories');
const { ADMIN_ACTIONS, ADMIN_NOTIFICATION_TYPES, ADMIN_USER_STATUSES, ADMIN_PROFILE_STATUSES } = require('../constants/adminActions');
const { SEARCH_MAX_LEN } = require('../services/adminUserService');
const { SEARCH_MAX_LEN: MASTER_SEARCH_MAX_LEN } = require('../services/masterDataService');

const OID_RE = /^[0-9a-fA-F]{24}$/;
const objectId = z.string({ message: 'Must be a valid identifier.' }).regex(OID_RE, 'Must be a valid identifier.');

/** Bounded, markup-free text — the step-12 `plainText` rule, restated here. */
const plainText = (max, label) =>
  z
    .string({ message: `${label} must be text.` })
    .trim()
    .max(max, `${label} must be at most ${max} characters.`)
    .refine((value) => !/[<>]/.test(value), `${label} cannot contain "<" or ">".`)
    .optional();

/** Shared bounded pagination for the cursor-style admin lists. */
const cursorPage = z.object({
  limit: z.coerce
    .number({ message: 'limit must be a whole number.' })
    .int('limit must be a whole number.')
    .min(1, 'limit must be at least 1.')
    // A sane upper bound only; the SERVICE clamps to ADMIN_MAX_LIMIT, so an
    // oversized `limit` still returns a bounded page (spec §80).
    .max(100000, 'limit is unreasonably large.')
    .optional(),
  cursor: objectId.optional()
});

// --- Users (task 5) ---------------------------------------------------------

/** Query of `GET /admin/users`. */
const userListQuerySchema = cursorPage
  .extend({
    query: plainText(SEARCH_MAX_LEN, 'Search text'),
    role: z.enum(ROLE_VALUES, { message: 'Unknown role.' }).optional(),
    status: z.enum(['active', 'suspended', 'blocked', 'deleted'], { message: 'Unknown status.' }).optional()
  })
  .strict();

/** Param of the user routes. */
const userIdParamSchema = z.object({ userId: objectId }).strict();

/**
 * Body of `PATCH /admin/users/:userId/status`.
 *
 * `role` is absent by design: there is no request path to change a role
 * (spec §31, §44). `reason` is free text, audited, never rendered to the
 * target account.
 */
const userStatusPatchSchema = z
  .object({
    status: z.enum(ADMIN_USER_STATUSES, { message: 'Unknown status.' }),
    reason: plainText(200, 'Reason')
  })
  .strict();

// --- Profiles (task 5) ------------------------------------------------------

/** Param of `PATCH /admin/profiles/:profileId/status`. */
const profileIdParamSchema = z.object({ profileId: objectId }).strict();

/** Body of `PATCH /admin/profiles/:profileId/status`. */
const profileStatusPatchSchema = z
  .object({
    status: z.enum(ADMIN_PROFILE_STATUSES, { message: 'Unknown status.' }),
    reason: plainText(200, 'Reason')
  })
  .strict();

// --- Reports (task 6) -------------------------------------------------------

/** Query of `GET /admin/reports`. */
const reportQueueQuerySchema = cursorPage
  .extend({
    status: z.enum(REPORT_STATUSES, { message: 'Unknown report status.' }).optional()
  })
  .strict();

/** Param of `PATCH /admin/reports/:reportId`. */
const reportIdParamSchema = z.object({ reportId: objectId }).strict();

/**
 * Body of `PATCH /admin/reports/:reportId`.
 *
 * `reviewedBy` / `reviewedAt` are absent: the reviewer is the session's own
 * account and the timestamp is server-set (spec §32, §44).
 */
const reportTransitionSchema = z
  .object({
    status: z.enum(['reviewing', 'resolved', 'dismissed'], {
      message: 'A report can only become reviewing, resolved or dismissed.'
    }),
    note: plainText(500, 'Note')
  })
  .strict();

// --- Photos (task 7) --------------------------------------------------------

/** Query of `GET /admin/photos/pending`. */
const photoQueueQuerySchema = cursorPage.strict();

/** Param of `PATCH /admin/photos/:photoId/moderation`. */
const photoIdParamSchema = z.object({ photoId: objectId }).strict();

/** Body of `PATCH /admin/photos/:photoId/moderation`. `pending` is not a decision. */
const photoModerationSchema = z
  .object({
    moderationStatus: z.enum(MODERATION_STATUSES, { message: 'Unknown moderation status.' }).refine(
      (value) => value !== 'pending',
      'A moderation decision must approve or reject the photo.'
    )
  })
  .strict();

// --- Master data (task 8) ---------------------------------------------------

/** Param of the master-data item routes. `type` is the collection allowlist. */
const masterTypeParamSchema = z.object({ type: z.enum(MASTER_TYPE_VALUES, { message: 'Unknown collection.' }) }).strict();
const masterItemParamSchema = masterTypeParamSchema.extend({ id: objectId }).strict();

/** Query of `GET /admin/master-data/:type` — the step-05 list, admin-side. */
const masterListQuerySchema = z
  .object({
    query: z.string().max(MASTER_SEARCH_MAX_LEN, `Search text must be at most ${MASTER_SEARCH_MAX_LEN} characters.`).optional(),
    limit: z.coerce.number().int().min(1).max(100000).optional(),
    page: z.coerce.number().int().min(1).optional(),
    // Admins may list deactivated rows too — moderation needs to see what was
    // retired and when (spec §74). Absent means "active only", the same
    // default the public list has.
    activeOnly: z.enum(['true', 'false']).optional(),
    // The same allowlisted cascade filters the public list accepts (spec §76).
    parentId: objectId.optional(),
    countryId: objectId.optional(),
    stateId: objectId.optional(),
    districtId: objectId.optional(),
    degreeId: objectId.optional(),
    communityId: objectId.optional(),
    clanId: objectId.optional()
  })
  .strict();

/** Body of `POST /admin/master-data/:type`. Server stamps `source: "admin"`. */
const masterCreateSchema = z
  .object({
    name: z
      .string({ message: 'A name is required.' })
      .trim()
      .min(1, 'A name is required.')
      .max(120, 'A name must be at most 120 characters.')
      .refine((value) => !/[<>]/.test(value), 'A name cannot contain "<" or ">".'),
    category: plainText(80, 'Category'),
    sortOrder: z.number().int().min(0).max(100000).optional(),
    communityId: objectId.optional(),
    subCommunityId: objectId.optional(),
    clanId: objectId.optional(),
    degreeId: objectId.optional(),
    countryId: objectId.optional(),
    stateId: objectId.optional(),
    districtId: objectId.optional()
  })
  .strict();

/** Body of `PATCH /admin/master-data/:type/:id` — every field optional. */
const masterUpdateSchema = z
  .object({
    name: z
      .string({ message: 'A name must be text.' })
      .trim()
      .min(1, 'A name cannot be blank.')
      .max(120, 'A name must be at most 120 characters.')
      .refine((value) => !/[<>]/.test(value), 'A name cannot contain "<" or ">".')
      .optional(),
    category: plainText(80, 'Category'),
    sortOrder: z.number().int().min(0).max(100000).optional()
  })
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    'Provide at least one field to update.'
  );

/** Body of `PATCH /admin/master-data/:type/:id/reorder`. */
const masterReorderSchema = z.object({ sortOrder: z.number().int().min(0).max(100000) }).strict();

/** Body of `POST /admin/master-data/:type/:id/merge`. */
const masterMergeSchema = z.object({ intoId: objectId }).strict();

/** Query of `GET /admin/master-data-requests`. */
const masterRequestQuerySchema = z
  .object({
    type: z.enum(REQUEST_TYPES, { message: 'Unknown request type.' }).optional(),
    limit: z.coerce.number().int().min(1).max(100000).optional(),
    page: z.coerce.number().int().min(1).optional()
  })
  .strict();

/** Param of `PATCH /admin/master-data-requests/:id`. */
const masterRequestIdParamSchema = z.object({ id: objectId }).strict();

/** Body of `PATCH /admin/master-data-requests/:id`. */
const masterRequestReviewSchema = z
  .object({
    decision: z.enum(['approve', 'reject'], { message: 'A decision must approve or reject.' }),
    note: plainText(500, 'Note')
  })
  .strict();

// --- Notifications (task 10) ------------------------------------------------

/**
 * Body of `POST /admin/notifications`.
 *
 * `userId` is the recipient — validated, server-resolved, and audited; a
 * client can pick a recipient but can never redirect the write by smuggling a
 * second id (gate G3.8). `actorId` is absent: admin-originated types carry no
 * peer actor (spec §22).
 */
const adminNotificationSchema = z
  .object({
    userId: objectId,
    type: z.enum(ADMIN_NOTIFICATION_TYPES, { message: 'Unknown notification type.' }),
    title: plainText(120, 'Title'),
    body: plainText(500, 'Body'),
    // Identifiers-only payload (spec §24, §112): a flat object of primitives.
    data: z
      .record(
        z.string().max(64),
        z.union([z.string().max(200), z.number(), z.boolean()])
      )
      .optional()
  })
  .strict();

// --- Subscription inspection (task 11) --------------------------------------

/** Param of `GET /admin/subscriptions/:userId`. */
const subscriptionUserIdParamSchema = z.object({ userId: objectId }).strict();

// --- Audit log (verification command 9) -------------------------------------

/** Query of `GET /admin/audit-logs`. */
const auditLogQuerySchema = cursorPage
  .extend({
    targetId: objectId.optional(),
    actorUserId: objectId.optional(),
    action: z.enum(ADMIN_ACTIONS, { message: 'Unknown audit action.' }).optional()
  })
  .strict();

module.exports = {
  validateQuery,
  userListQuerySchema,
  userIdParamSchema,
  userStatusPatchSchema,
  profileIdParamSchema,
  profileStatusPatchSchema,
  reportQueueQuerySchema,
  reportIdParamSchema,
  reportTransitionSchema,
  photoQueueQuerySchema,
  photoIdParamSchema,
  photoModerationSchema,
  masterTypeParamSchema,
  masterItemParamSchema,
  masterListQuerySchema,
  masterCreateSchema,
  masterUpdateSchema,
  masterReorderSchema,
  masterMergeSchema,
  masterRequestQuerySchema,
  masterRequestIdParamSchema,
  masterRequestReviewSchema,
  adminNotificationSchema,
  subscriptionUserIdParamSchema,
  auditLogQuerySchema
};
