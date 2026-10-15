'use strict';

/**
 * Shared request-validation helpers (spec §33, §34, §77).
 *
 * `auth.validators.js` and `profile.validators.js` each carry their own copy of
 * these three functions; new validators use this module instead so step 08 does
 * not add a third copy. The behaviour is identical: a Zod failure becomes a 400
 * envelope whose `details` maps a field path to one message.
 */

const { BadRequestError } = require('../utils/AppError');

/** `{ 'a.b': 'message' }` — first message per path wins, so it is deterministic. */
function zodToDetails(error) {
  const details = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_';
    if (!(key in details)) details[key] = issue.message;
  }
  return details;
}

function toBadRequest(error) {
  return new BadRequestError('Invalid request.', { details: zodToDetails(error) });
}

/** Turn a Zod schema into express body middleware. */
function validateBody(schema) {
  return function validate(req, res, next) {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) return next(toBadRequest(result.error));
    req.body = result.data;
    return next();
  };
}

/**
 * Turn a Zod schema into express params middleware.
 *
 * A malformed id (for example `abc` as a `:photoId`) is answered with a
 * field-level 400 before the service runs. Without this the Mongoose cast error
 * would still end as a 400, but with a generic message and after a needless
 * round trip to the database.
 */
function validateParams(schema) {
  return function validate(req, res, next) {
    const result = schema.safeParse(req.params ?? {});
    if (!result.success) return next(toBadRequest(result.error));
    req.params = result.data;
    return next();
  };
}

/**
 * Turn a Zod schema into express *query* middleware, writing the parsed result
 * to `req.validatedQuery` (never back onto `req.query`, which Express's `simple`
 * parser owns read-only in places).
 *
 * Steps 12 and 13 each carried a private copy of this helper; step 15 moves it
 * here so the fourth copy is never written. `.strict()` schemas make an unknown
 * query field a 400 — which is what turns "a client-supplied `userId`, plan or
 * feature cannot redirect anything" into a structural rule rather than a
 * convention.
 */
function validateQuery(schema) {
  return function validate(req, res, next) {
    const result = schema.safeParse(req.query ?? {});
    if (!result.success) return next(toBadRequest(result.error));
    req.validatedQuery = result.data;
    return next();
  };
}

module.exports = { validateBody, validateParams, validateQuery, toBadRequest, zodToDetails };
