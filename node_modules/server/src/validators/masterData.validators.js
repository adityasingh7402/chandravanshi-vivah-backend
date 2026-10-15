'use strict';

/**
 * Master-data request validation (spec §34, §35, §73, §82; step 05 task 4).
 *
 * Every schema is `.strict()`: an unexpected field or query parameter is
 * REJECTED, not ignored. That is what stops `?query[$ne]=` from ever reaching
 * the service (spec §35, gate G3.2) and what stops `{"source":"admin"}` on the
 * `.missing` path (spec §75, gate G3.5).
 *
 * Note: `app.js` uses the simple query parser, so a nested `?query[$ne]=x`
 * arrives as the literal key `query[$ne]` and fails strict validation.
 */

const { z } = require('zod');
const config = require('../config/env');
const { BadRequestError } = require('../utils/AppError');
const { SEARCH_MAX_LEN } = require('../services/masterDataService');

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Must be a valid identifier.');

/** Query parameters shared by every master-data listing. */
const listQuerySchema = z
  .object({
    query: z
      .string({ message: 'query must be text.' })
      .max(SEARCH_MAX_LEN, `Search text must be at most ${SEARCH_MAX_LEN} characters.`)
      .optional(),
    limit: z.coerce
      .number({ message: 'limit must be a whole number.' })
      .int('limit must be a whole number.')
      .min(1, 'limit must be at least 1.')
      // A sane upper bound only; the SERVICE clamps to MASTER_SEARCH_MAX_LIMIT, so
      // an oversized `limit` still returns a bounded page rather than an error
      // (spec §80, gate G3.3, step 05 verification command 5).
      .max(100000, 'limit is unreasonably large.')
      .optional(),
    page: z.coerce.number({ message: 'page must be a whole number.' }).int('page must be a whole number.').min(1).optional(),
    activeOnly: z.enum(['true', 'false'], { message: 'activeOnly must be true or false.' }).optional(),
    // Generic cascade parent plus the concrete parent field names clients send.
    parentId: objectId.optional(),
    countryId: objectId.optional(),
    stateId: objectId.optional(),
    districtId: objectId.optional(),
    degreeId: objectId.optional(),
    communityId: objectId.optional(),
    clanId: objectId.optional()
  })
  .strict();

/** `POST /master-data/:type/missing` body (server-stamped fields are rejected). */
const missingBodySchema = z
  .object({
    name: z
      .string({ message: 'A name is required.' })
      .min(1, 'A name is required.')
      .max(config.masterData.missingMaxLen, `A name must be at most ${config.masterData.missingMaxLen} characters.`),
    // Scope. `communityName` is deliberately absent — community is
    // platform-controlled and cannot be submitted (fields dictionary §4.1).
    communityId: objectId.optional(),
    clanId: objectId.nullable().optional()
  })
  .strict();

/** Coerce a boolean-ish query flag. */
function parseActiveOnly(value) {
  if (value === 'false') return false;
  return true;
}

/** Turn a Zod schema into query middleware. Validated values land on `req.validatedQuery`. */
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

/** Turn a Zod schema into body middleware (same shape as auth's validateBody). */
function validateBody(schema) {
  return function validate(req, res, next) {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const details = {};
      for (const issue of result.error.issues) {
        const key = issue.path.length ? issue.path.join('.') : '_';
        if (!(key in details)) details[key] = issue.message;
      }
      return next(new BadRequestError('Invalid request.', { details }));
    }
    req.body = result.data;
    return next();
  };
}

module.exports = {
  listQuerySchema,
  missingBodySchema,
  validateQuery,
  validateBody,
  parseActiveOnly
};
