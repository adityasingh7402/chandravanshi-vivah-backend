'use strict';

/**
 * Profile-action request validation (spec §20, §34, §44, §46; step 10 task 3).
 *
 * Two things this module is careful about:
 *
 *  1. **`.strict()` everywhere.** An unknown field — `fromUserId`, `userId`,
 *     `createdAt` — is a 400, not something ignored, so a client can never name
 *     the actor. The actor is `req.auth.userId` only (spec §44).
 *  2. **The target is one of two identifiers, never both.** A request names the
 *     target either by account id (`toUserId`) or by the public, non-sequential
 *     id (`publicProfileId`, spec §113). Exactly one is required, and the
 *     `publicProfileId` is resolved to an account **server-side** in the service
 *     — the validator only checks the shape.
 *
 * `limit` is bounded generously here and clamped by the service, matching step 09
 * (spec §80), so `?limit=100000` returns the configured maximum rather than a 400.
 */

const { z } = require('zod');
const { BadRequestError } = require('../utils/AppError');
const { ACTION_TYPES } = require('../constants/actions');
const { isPublicProfileId } = require('../utils/publicProfileId');

const OID_RE = /^[0-9a-fA-F]{24}$/;
const objectId = z.string({ message: 'Must be a valid identifier.' }).regex(OID_RE, 'Must be a valid identifier.');

/** Body of `POST /interactions` — record one action against one target. */
const actionCreateSchema = z
  .object({
    toUserId: objectId.optional(),
    publicProfileId: z
      .string({ message: 'Must be a public profile id.' })
      .trim()
      .refine(isPublicProfileId, 'Must be a public profile id.')
      .optional(),
    type: z.enum(ACTION_TYPES, { message: `type must be one of: ${ACTION_TYPES.join(', ')}.` })
  })
  .strict()
  .superRefine((value, ctx) => {
    const targets = [value.toUserId, value.publicProfileId].filter((entry) => entry !== undefined);
    if (targets.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['toUserId'], message: 'A target profile is required.' });
    }
    if (targets.length > 1) {
      ctx.addIssue({ code: 'custom', path: ['publicProfileId'], message: 'Provide either toUserId or publicProfileId, not both.' });
    }
  });

/** Query of `GET /interactions` — the caller's own list, optionally typed. */
const actionListQuerySchema = z
  .object({
    type: z.enum(ACTION_TYPES, { message: `type must be one of: ${ACTION_TYPES.join(', ')}.` }).optional(),
    limit: z.coerce
      .number({ message: 'limit must be a whole number.' })
      .int('limit must be a whole number.')
      .min(1, 'limit must be at least 1.')
      .max(100000, 'limit is unreasonably large.')
      .optional(),
    // A plain ObjectId cursor: the last row of the previous page. Actions are
    // insertion-ordered, so an id comparison pages them without an offset.
    cursor: objectId.optional()
  })
  .strict();

/** Param of `DELETE /interactions/:interactionId`. */
const interactionIdParamSchema = z.object({ interactionId: objectId }).strict();

/**
 * Turn a schema into express *query* middleware, writing the parsed value to
 * `req.validatedQuery` (the same contract step 09 established) so the controller
 * never reads a raw query object.
 */
function validateQuery(schema) {
  return function validate(req, res, next) {
    const result = schema.safeParse(req.query ?? {});
    if (!result.success) {
      const details = {};
      for (const issue of result.error.issues) {
        const key = issue.path.length ? issue.path.join('.') : '_';
        if (!(key in details)) details[key] = issue.message;
      }
      return next(new BadRequestError('Invalid request.', { details }));
    }
    req.validatedQuery = result.data;
    return next();
  };
}

module.exports = {
  actionCreateSchema,
  actionListQuerySchema,
  interactionIdParamSchema,
  validateQuery
};
