'use strict';

/**
 * Kundli document request validation (finalized decisions §6; fields dictionary
 * §11.7; spec §34, §112; step 08 task 12).
 *
 * The visibility enum is the reduced one — `private | matches_only` — so a
 * request to make a Kundli public is rejected as an invalid value rather than
 * being silently downgraded. That is the point: the stricter set is the rule,
 * not a convention (decisions §6).
 */

const { z } = require('zod');
const { KUNDLI_VISIBILITY } = require('../constants/kundli');

const OID_RE = /^[0-9a-fA-F]{24}$/;
const objectId = z.string({ message: 'This field must be a valid identifier.' }).regex(OID_RE, 'This field must be a valid identifier.');

const kundliIdParamSchema = z.object({ kundliId: objectId }).strict();

/**
 * Body of `POST /kundli`.
 *
 * One document per account, and no client-chosen visibility or moderation
 * state: a new document is always private (decisions §6) and pending (spec §101).
 */
const kundliCreateSchema = z
  .object({
    publicId: z
      .string({ message: 'An uploaded document reference is required.' })
      .trim()
      .min(1, 'An uploaded document reference is required.')
      .max(512, 'An uploaded document reference is too long.'),
    url: z.string().trim().max(1024).optional()
  })
  .strict();

/** Body of `PATCH /kundli/:kundliId` — visibility only. */
const kundliPatchSchema = z
  .object({
    visibility: z.enum(KUNDLI_VISIBILITY, { message: 'Visibility must be private or matches_only.' })
  })
  .strict();

module.exports = {
  kundliIdParamSchema,
  kundliCreateSchema,
  kundliPatchSchema
};
