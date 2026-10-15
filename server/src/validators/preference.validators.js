'use strict';

/**
 * Partner-preference request validation (spec §16, §34, §80, §81, §97; step 07
 * task 3).
 *
 * Same two-layer shape as the profile validators, for the same reasons:
 *
 *  1. **Shape** — one `.strict()` object, so an unknown field (including `userId`
 *     or `role`) is a 400 rather than silently dropped (spec §34, §44, §35).
 *  2. **Cross-field** — `min <= max` lives in a `superRefine`, and the service
 *     validates the *merged* document, so a patch that inverts a stored range is
 *     refused instead of stored (gate G2.4).
 *
 * Every field is optional: partial preferences are the documented behaviour, and
 * a partial save must never be rejected just for being partial.
 */

const { z } = require('zod');
const config = require('../config/env');
const { BadRequestError } = require('../utils/AppError');
const {
  PREFERENCE_ENUM_FIELDS,
  AGE_BOUNDS,
  HEIGHT_BOUNDS,
  maxMultiSelect
} = require('../constants/preference');

const OID_RE = /^[0-9a-fA-F]{24}$/;
const objectId = z.string({ message: 'This field must be a valid identifier.' }).regex(OID_RE, 'This field must be a valid identifier.');

/** Whole number within bounds, or null (an unset range bound). */
const boundedInt = (min, max, label) =>
  z
    .coerce.number({ message: `${label} must be a whole number.` })
    .int(`${label} must be a whole number.`)
    .min(min, `${label} must be at least ${min}.`)
    .max(max, `${label} must be at most ${max}.`)
    .nullable()
    .optional();

/** A capped array of master ids; `[]` clears the dimension. */
const idArray = (label) =>
  z.array(objectId, { message: `${label} must be a list of options.` }).max(maxMultiSelect(), `Choose at most ${maxMultiSelect()} options for ${label}.`).optional();

/** A capped array of fixed enum values; `[]` clears the dimension. */
const enumArray = (field, label) =>
  z
    .array(z.enum(PREFERENCE_ENUM_FIELDS[field].values, { message: `One of the chosen ${label} values is not allowed.` }))
    .max(maxMultiSelect(), `Choose at most ${maxMultiSelect()} options for ${label}.`)
    .optional();

/**
 * A single-value enum, nullable so the user can clear it.
 *
 * A boolean is NOT coerced into a value: `horoscopeRequired` is a 3-value enum
 * by final decision (decisions §4), so `true` is a 400, not "required"
 * (gate G2.9).
 */
const enumScalar = (field) =>
  z.enum(PREFERENCE_ENUM_FIELDS[field].values, { message: 'This value is not one of the allowed options.' }).nullable().optional();

/** A `min <= max` range section. Both bounds are optional and independently clearable. */
const rangeSchema = (bounds, label) =>
  z
    .object({
      min: boundedInt(bounds.min, bounds.max, `${label} minimum`),
      max: boundedInt(bounds.min, bounds.max, `${label} maximum`)
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.min == null || value.max == null) return;
      if (value.min > value.max) {
        ctx.addIssue({
          code: 'custom',
          path: ['max'],
          message: `${label} maximum must be greater than or equal to the minimum.`
        });
      }
    });

/** The whole preference document, every field optional. */
const preferenceShape = Object.freeze({
  // Both ranges accept `null`: an unset range is stored as null by the schema, so
  // a round-trip through merge must be able to pass that state back through
  // validation instead of rejecting the user's own stored document.
  age: rangeSchema(AGE_BOUNDS, 'Age').nullable().optional(),
  heightCm: rangeSchema(HEIGHT_BOUNDS, 'Height').nullable().optional(),

  gender: enumScalar('gender'),
  maritalStatus: enumArray('maritalStatus', 'marital status'),
  childrenPreference: enumScalar('childrenPreference'),

  educationIds: idArray('education'),
  occupationIds: idArray('occupation'),
  industryIds: idArray('industry'),

  incomeRanges: enumArray('incomeRanges', 'income'),

  countryIds: idArray('country'),
  stateIds: idArray('state'),
  cityIds: idArray('city'),

  motherTongueIds: idArray('mother tongue'),

  communityIds: idArray('community'),
  subCommunityIds: idArray('sub-community'),
  surnameIds: idArray('surname'),
  gotraIds: idArray('gotra'),

  diet: enumArray('diet', 'diet'),
  smoking: enumArray('smoking', 'smoking'),
  drinking: enumArray('drinking', 'drinking'),
  familyTypes: enumArray('familyTypes', 'family type'),

  workingPreference: enumScalar('workingPreference'),
  horoscopeRequired: enumScalar('horoscopeRequired'),
  manglikPreference: enumArray('manglikPreference', 'manglik'),
  relocationPreference: enumScalar('relocationPreference')
});

/** `POST /api/v1/preferences` — a partial document is expected, not an error. */
const preferenceCreateSchema = z.object(preferenceShape).strict();

/** `PATCH /api/v1/preferences` — same shape; the service merges before validating. */
const preferencePatchSchema = z.object(preferenceShape).strict();

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

/**
 * Validate an already-merged document. The service calls this after overlaying a
 * patch onto the stored preferences, so range rules always see full context.
 *
 * @param {object} sections plain object of preference values
 */
function validateMerged(sections) {
  const result = z.object(preferenceShape).strict().safeParse(sections);
  if (!result.success) throw toBadRequest(result.error);
  return result.data;
}

/** Turn a Zod schema into express body middleware (same shape as the profile's). */
function validateBody(schema) {
  return function validate(req, res, next) {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) return next(toBadRequest(result.error));
    req.body = result.data;
    return next();
  };
}

module.exports = {
  preferenceCreateSchema,
  preferencePatchSchema,
  preferenceShape,
  validateMerged,
  validateBody,
  zodToDetails,
  toBadRequest,
  maxMultiSelect,
  enforcedMultiSelectCap: () => config.preference.maxMultiSelect
};
