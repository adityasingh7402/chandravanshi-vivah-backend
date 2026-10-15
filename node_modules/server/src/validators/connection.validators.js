'use strict';

/**
 * Connection request validation (spec §21, §34, §44, §46, §80, §91; step 11
 * task 4).
 *
 * Three things this module is careful about:
 *
 *  1. **`.strict()` everywhere.** An unknown field — `senderId`, `receiverId`,
 *     `userId`, `status` — is a 400, not something ignored, so a client can
 *     never name the actor or set a status directly. The actor is
 *     `req.auth.userId` and the status is decided by the state machine
 *     (spec §44, §91).
 *  2. **The target is one of two identifiers, never both** — `toUserId` (an
 *     account id) or `publicProfileId` (the public, non-sequential id,
 *     spec §113). Exactly one is required; the `publicProfileId` is resolved to
 *     an account **server-side** in the service.
 *  3. **The optional message is plain text.** It is trimmed, length-capped
 *     (`INTEREST_MESSAGE_MAX_LEN`) and refuses the two characters that could
 *     begin markup, so the stored note cannot inject HTML into another member's
 *     inbox (spec §34, §80; gate G3.5).
 *
 * The list query accepts a **direction** (`box`, default `received`) and a
 * `status` filter. For convenience the direction may also be given as
 * `status=sent` / `status=received` — the spelling the step's own command 8
 * uses — and it is normalised here into the clean `{ box, status }` pair the
 * service reads, so the service never has to guess.
 */

const { z } = require('zod');
const config = require('../config/env');
const { BadRequestError } = require('../utils/AppError');
const {
  CONNECTION_STATUSES,
  DIRECTIONS,
  DIRECTION,
  RESPONSE_ACTIONS
} = require('../constants/connection');
const { isPublicProfileId } = require('../utils/publicProfileId');

const OID_RE = /^[0-9a-fA-F]{24}$/;
const objectId = z.string({ message: 'Must be a valid identifier.' }).regex(OID_RE, 'Must be a valid identifier.');

/**
 * Bounded, markup-free text. `<` and `>` are refused rather than stripped: a
 * silent edit of what the member typed is worse than a clear 400, and the
 * refusal is what makes "cannot inject markup" a property of the *stored* value
 * (gate G3.5).
 */
const plainText = (max, label) =>
  z
    .string({ message: `${label} must be text.` })
    .trim()
    .max(max, `${label} must be at most ${max} characters.`)
    .refine((value) => !/[<>]/.test(value), `${label} cannot contain "<" or ">".`)
    .nullable()
    .optional();

/** Body of `POST /connections` — send one interest to one target. */
const connectionCreateSchema = z
  .object({
    toUserId: objectId.optional(),
    publicProfileId: z
      .string({ message: 'Must be a public profile id.' })
      .trim()
      .refine(isPublicProfileId, 'Must be a public profile id.')
      .optional(),
    message: plainText(config.connections.messageMaxLen, 'Message')
  })
  .strict()
  .superRefine((value, ctx) => {
    const targets = [value.toUserId, value.publicProfileId].filter((entry) => entry !== undefined);
    if (targets.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['toUserId'], message: 'A target profile is required.' });
    }
    if (targets.length > 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['publicProfileId'],
        message: 'Provide either toUserId or publicProfileId, not both.'
      });
    }
  });

/** Body of `PATCH /connections/:connectionId` — accept, reject, withdraw or close. */
const connectionUpdateSchema = z
  .object({
    action: z.enum(RESPONSE_ACTIONS, {
      message: `action must be one of: ${RESPONSE_ACTIONS.join(', ')}.`
    })
  })
  .strict();

/**
 * Query of `GET /connections`.
 *
 * `box=sent|received` selects the caller's side; `status` filters by one of the
 * six connection statuses. Both direction words are also accepted under
 * `status`, which is normalised to `box` — see the module note.
 */
const connectionListQuerySchema = z
  .object({
    box: z.enum(DIRECTIONS, { message: `box must be one of: ${DIRECTIONS.join(', ')}.` }).optional(),
    status: z
      .enum([...DIRECTIONS, ...CONNECTION_STATUSES], {
        message: `status must be one of: ${[...DIRECTIONS, ...CONNECTION_STATUSES].join(', ')}.`
      })
      .optional(),
    limit: z.coerce
      .number({ message: 'limit must be a whole number.' })
      .int('limit must be a whole number.')
      .min(1, 'limit must be at least 1.')
      .max(100000, 'limit is unreasonably large.')
      .optional(),
    // A plain ObjectId cursor: the last row of the previous page. Connections are
    // insertion-ordered, so an id comparison pages them without an offset.
    cursor: objectId.optional()
  })
  .strict()
  .transform((value) => {
    let box = value.box || DIRECTION.RECEIVED;
    let status;
    if (value.status && DIRECTIONS.includes(value.status)) {
      box = value.status;
    } else {
      status = value.status;
    }
    return { box, status, limit: value.limit, cursor: value.cursor };
  });

/** Param of `PATCH /connections/:connectionId`. */
const connectionIdParamSchema = z.object({ connectionId: objectId }).strict();

/** Turn a schema into express *query* middleware, writing to `req.validatedQuery`. */
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
  connectionCreateSchema,
  connectionUpdateSchema,
  connectionListQuerySchema,
  connectionIdParamSchema,
  validateQuery
};
