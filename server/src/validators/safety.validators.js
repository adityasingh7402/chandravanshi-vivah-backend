'use strict';

/**
 * Block & report request validation (spec §22, §23, §34, §44, §80, §91;
 * step 12 tasks 10, 12).
 *
 * The same three disciplines the action and connection validators apply, for the
 * same reasons:
 *
 *  1. **`.strict()` everywhere.** An unknown field is a 400, not something
 *     ignored. That is what makes gate G3.3 structural: a body carrying
 *     `status`, `reviewedBy` or `reviewedAt` is refused by the schema before the
 *     service is ever reached, so no user route can write moderation state
 *     (spec §32, §44).
 *  2. **The target is one of two identifiers, never both.** `userId` /
 *     `reportedUserId` name an account id; `publicProfileId` names the public,
 *     non-sequential id (spec §113). Exactly one is required, and a
 *     `publicProfileId` is resolved to an account **server-side**. The unblock
 *     path accepts either spelling too, so a client that only holds a public id
 *     can still undo its own block.
 *  3. **Free text is bounded and markup-free.** Descriptions, reasons and
 *     evidence entries are trimmed, length-capped and refuse `<`/`>` rather than
 *     silently rewriting what someone typed (spec §34, §80; gates G3.4, G3.5).
 *     An evidence entry is a **string** — an object is a 400, so the array can
 *     never carry structured data into a moderation screen.
 */

const { z } = require('zod');
const config = require('../config/env');
// The shared query middleware (step 15): this file used to carry its own copy.
const { validateQuery } = require('./validate');
const { REPORT_CATEGORIES, REPORT_STATUSES } = require('../constants/safety');
const { isPublicProfileId } = require('../utils/publicProfileId');

const OID_RE = /^[0-9a-fA-F]{24}$/;
const objectId = z.string({ message: 'Must be a valid identifier.' }).regex(OID_RE, 'Must be a valid identifier.');

const publicProfileId = z
  .string({ message: 'Must be a public profile id.' })
  .trim()
  .refine(isPublicProfileId, 'Must be a public profile id.');

/** Bounded, markup-free text (see the module note). */
const plainText = (max, label) =>
  z
    .string({ message: `${label} must be text.` })
    .trim()
    .max(max, `${label} must be at most ${max} characters.`)
    .refine((value) => !/[<>]/.test(value), `${label} cannot contain "<" or ">".`)
    .nullable()
    .optional();

/** Exactly one target spelling, or a field-level 400. */
function exactlyOneTarget(value, ctx, targetKey) {
  const targets = [value[targetKey], value.publicProfileId].filter((entry) => entry !== undefined);
  if (targets.length === 0) {
    ctx.addIssue({ code: 'custom', path: [targetKey], message: 'A target profile is required.' });
  }
  if (targets.length > 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['publicProfileId'],
      message: `Provide either ${targetKey} or publicProfileId, not both.`
    });
  }
}

/** Body of `POST /blocks` — block one account. */
const blockCreateSchema = z
  .object({
    userId: objectId.optional(),
    publicProfileId: publicProfileId.optional(),
    reason: plainText(config.safety.blockReasonMaxLen, 'Reason')
  })
  .strict()
  .superRefine((value, ctx) => exactlyOneTarget(value, ctx, 'userId'));

/** Param of `DELETE /blocks/:userId` — an account id or a public profile id. */
const blockTargetParamSchema = z
  .object({
    userId: z
      .string({ message: 'Must be a valid identifier.' })
      .trim()
      .refine((value) => OID_RE.test(value) || isPublicProfileId(value), 'Must be a valid identifier.')
  })
  .strict();

/** Query of `GET /blocks` — the caller's own list. */
const blockListQuerySchema = z
  .object({
    limit: z.coerce
      .number({ message: 'limit must be a whole number.' })
      .int('limit must be a whole number.')
      .min(1, 'limit must be at least 1.')
      .max(100000, 'limit is unreasonably large.')
      .optional(),
    cursor: objectId.optional()
  })
  .strict();

/**
 * One evidence entry: a bounded, markup-free **string** (spec §23 types the array
 * `[String]`; an object is a 400, so nothing structured can ride along).
 */
const evidenceEntry = z
  .string({ message: 'An evidence entry must be text.' })
  .trim()
  .max(
    config.safety.report.evidenceMaxLen,
    `An evidence entry must be at most ${config.safety.report.evidenceMaxLen} characters.`
  )
  .refine((value) => !/[<>]/.test(value), 'An evidence entry cannot contain "<" or ">".');

/** Body of `POST /reports` — open a moderation case. */
const reportCreateSchema = z
  .object({
    reportedUserId: objectId.optional(),
    publicProfileId: publicProfileId.optional(),
    category: z.enum(REPORT_CATEGORIES, {
      message: `category must be one of: ${REPORT_CATEGORIES.join(', ')}.`
    }),
    description: plainText(config.safety.report.descriptionMaxLen, 'Description'),
    evidence: z
      .array(evidenceEntry, { message: 'evidence must be a list of text entries.' })
      .max(
        config.safety.report.evidenceMaxItems,
        `evidence must contain at most ${config.safety.report.evidenceMaxItems} entries.`
      )
      .optional()
  })
  .strict()
  .superRefine((value, ctx) => exactlyOneTarget(value, ctx, 'reportedUserId'));

/** Query of `GET /reports/me` — the caller's own reports. */
const reportListQuerySchema = z
  .object({
    status: z
      .enum(REPORT_STATUSES, { message: `status must be one of: ${REPORT_STATUSES.join(', ')}.` })
      .optional(),
    limit: z.coerce
      .number({ message: 'limit must be a whole number.' })
      .int('limit must be a whole number.')
      .min(1, 'limit must be at least 1.')
      .max(100000, 'limit is unreasonably large.')
      .optional(),
    cursor: objectId.optional()
  })
  .strict();

module.exports = {
  blockCreateSchema,
  blockTargetParamSchema,
  blockListQuerySchema,
  reportCreateSchema,
  reportListQuerySchema,
  validateQuery
};
