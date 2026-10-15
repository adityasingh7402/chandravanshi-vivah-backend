'use strict';

/**
 * Discover / search query validation (spec §34, §35, §45, §48, §52, §53, §80,
 * §119; step 09 task 8).
 *
 * The schema is `.strict()`: an unknown parameter is a **400**, not something
 * silently ignored. That is the boundary that stop a NoSQL-injection shape from
 * reaching the service — `app.js` uses the simple query parser, so
 * `?gender[$ne]=male` arrives as the literal key `gender[$ne]` and fails the
 * strict check (spec §35, gate G3.1).
 *
 * The validator's output is not the raw parameter set: it normalises to the
 * canonical filter keys the query builder understands (`cityId` and a repeated
 * `cityId` both become `cityIds`), so the service never has to re-interpret a
 * request shape (spec §46).
 *
 * `limit` is deliberately bounded generously here and clamped by the service, so
 * `?limit=100000` returns the configured maximum page rather than a 400
 * (step 09 verification command 7, gate G3.3).
 */

const { z } = require('zod');
const config = require('../config/env');
const { BadRequestError } = require('../utils/AppError');
const { SORT_VALUES, FILTER_ENUMS } = require('../constants/search');

const OID_RE = /^[0-9a-fA-F]{24}$/;
const CAP = config.preference.maxMultiSelect;

const objectId = z.string({ message: 'Must be a valid identifier.' }).regex(OID_RE, 'Must be a valid identifier.');

/** One id, or the same parameter repeated (a small capped multi-select). */
const idList = z
  .union([
    objectId,
    z.array(objectId, { message: 'Must be one or more identifiers.' }).min(1).max(CAP, `Choose at most ${CAP} options.`)
  ])
  .optional();

/** One enum value, or the same parameter repeated. */
const enumList = (values, label) =>
  z
    .union([
      z.enum(values, { message: `That ${label} value is not allowed.` }),
      z
        .array(z.enum(values, { message: `That ${label} value is not allowed.` }))
        .min(1)
        .max(CAP, `Choose at most ${CAP} options.`)
    ])
    .optional();

/** Whole number inside the configured profile bounds. */
const boundedInt = (min, max, label) =>
  z.coerce
    .number({ message: `${label} must be a whole number.` })
    .int(`${label} must be a whole number.`)
    .min(min, `${label} must be at least ${min}.`)
    .max(max, `${label} must be at most ${max}.`)
    .optional();

const booleanFlag = (label) => z.enum(['true', 'false'], { message: `${label} must be true or false.` }).optional();

function toList(value) {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/** Drop keys whose value is undefined, so a range only carries the bounds sent. */
function pruneRange(range) {
  const out = {};
  if (range.min !== undefined) out.min = range.min;
  if (range.max !== undefined) out.max = range.max;
  return Object.keys(out).length > 0 ? out : undefined;
}

const rawSearchSchema = z
  .object({
    // --- Basic ---------------------------------------------------------
    gender: z.enum(FILTER_ENUMS.gender, { message: 'gender must be male or female.' }).optional(),
    minAge: boundedInt(config.profile.minAge, config.profile.maxAge, 'minAge'),
    maxAge: boundedInt(config.profile.minAge, config.profile.maxAge, 'maxAge'),
    minHeightCm: boundedInt(config.profile.minHeightCm, config.profile.maxHeightCm, 'minHeightCm'),
    maxHeightCm: boundedInt(config.profile.minHeightCm, config.profile.maxHeightCm, 'maxHeightCm'),
    maritalStatus: enumList(FILTER_ENUMS.maritalStatus, 'marital status'),

    // --- Community -----------------------------------------------------
    communityId: idList,
    subCommunityId: idList,
    surnameId: idList,
    gotraId: idList,
    clanId: idList,
    aaspadId: idList,

    // --- Location ------------------------------------------------------
    countryId: idList,
    stateId: idList,
    districtId: idList,
    cityId: idList,
    lat: z.coerce.number({ message: 'lat must be a number.' }).min(-90, 'lat must be between -90 and 90.').max(90, 'lat must be between -90 and 90.').optional(),
    lng: z.coerce.number({ message: 'lng must be a number.' }).min(-180, 'lng must be between -180 and 180.').max(180, 'lng must be between -180 and 180.').optional(),
    maxDistanceKm: z.coerce
      .number({ message: 'maxDistanceKm must be a number.' })
      .positive('maxDistanceKm must be greater than zero.')
      .max(config.search.maxDistanceKm, `maxDistanceKm must be at most ${config.search.maxDistanceKm}.`)
      .optional(),

    // --- Education -----------------------------------------------------
    degreeId: idList,
    specializationId: idList,
    universityId: idList,

    // --- Career --------------------------------------------------------
    occupationId: idList,
    industryId: idList,
    employmentType: enumList(FILTER_ENUMS.employmentType, 'employment type'),
    incomeRange: enumList(FILTER_ENUMS.incomeRange, 'income range'),

    // --- Lifestyle & family --------------------------------------------
    diet: enumList(FILTER_ENUMS.diet, 'diet'),
    smoking: enumList(FILTER_ENUMS.smoking, 'smoking'),
    drinking: enumList(FILTER_ENUMS.drinking, 'drinking'),
    familyType: enumList(FILTER_ENUMS.familyType, 'family type'),
    familyStatus: enumList(FILTER_ENUMS.familyStatus, 'family status'),

    // --- Verification / activity ---------------------------------------
    verified: booleanFlag('verified'),
    hasPhoto: booleanFlag('hasPhoto'),

    // --- Pagination & ordering -----------------------------------------
    sort: z.enum(SORT_VALUES, { message: `sort must be one of: ${SORT_VALUES.join(', ')}.` }).optional(),
    limit: z.coerce.number({ message: 'limit must be a whole number.' }).int('limit must be a whole number.').min(1, 'limit must be at least 1.').max(100000, 'limit is unreasonably large.').optional(),
    cursor: z.string({ message: 'cursor must be text.' }).max(512, 'That cursor is not valid.').optional()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.minAge !== undefined && value.maxAge !== undefined && value.minAge > value.maxAge) {
      ctx.addIssue({ code: 'custom', path: ['maxAge'], message: 'maxAge must be greater than or equal to minAge.' });
    }
    if (value.minHeightCm !== undefined && value.maxHeightCm !== undefined && value.minHeightCm > value.maxHeightCm) {
      ctx.addIssue({
        code: 'custom',
        path: ['maxHeightCm'],
        message: 'maxHeightCm must be greater than or equal to minHeightCm.'
      });
    }
    // A radius needs a point: one of the pair alone is a client bug, not a query.
    if ((value.lat === undefined) !== (value.lng === undefined)) {
      ctx.addIssue({ code: 'custom', path: [value.lat === undefined ? 'lat' : 'lng'], message: 'Supply both lat and lng.' });
    }
    if (value.maxDistanceKm !== undefined && value.lat === undefined) {
      ctx.addIssue({ code: 'custom', path: ['maxDistanceKm'], message: 'Supply lat and lng to use a distance filter.' });
    }
  })
  .transform((raw) => {
    const filters = {
      gender: raw.gender,
      maritalStatus: toList(raw.maritalStatus),
      age: pruneRange({ min: raw.minAge, max: raw.maxAge }),
      heightCm: pruneRange({ min: raw.minHeightCm, max: raw.maxHeightCm }),
      communityIds: toList(raw.communityId),
      subCommunityIds: toList(raw.subCommunityId),
      surnameIds: toList(raw.surnameId),
      gotraIds: toList(raw.gotraId),
      clanIds: toList(raw.clanId),
      aaspadIds: toList(raw.aaspadId),
      countryIds: toList(raw.countryId),
      stateIds: toList(raw.stateId),
      districtIds: toList(raw.districtId),
      cityIds: toList(raw.cityId),
      degreeIds: toList(raw.degreeId),
      specializationIds: toList(raw.specializationId),
      universityIds: toList(raw.universityId),
      occupationIds: toList(raw.occupationId),
      industryIds: toList(raw.industryId),
      employmentTypes: toList(raw.employmentType),
      incomeRanges: toList(raw.incomeRange),
      diets: toList(raw.diet),
      smoking: toList(raw.smoking),
      drinking: toList(raw.drinking),
      familyTypes: toList(raw.familyType),
      familyStatuses: toList(raw.familyStatus),
      // Only an explicit `true` narrows the result set (spec §46).
      verified: raw.verified === 'true' ? true : undefined,
      hasPhoto: raw.hasPhoto === 'true' ? true : undefined
    };
    if (raw.lat !== undefined) {
      filters.geo = { lat: raw.lat, lng: raw.lng, maxDistanceKm: raw.maxDistanceKm };
    }

    // Strip the keys the validator left `undefined` so the merger never treats an
    // absent dimension as an explicit one.
    for (const key of Object.keys(filters)) {
      if (filters[key] === undefined) delete filters[key];
    }

    return { filters, sort: raw.sort, limit: raw.limit, cursor: raw.cursor };
  });

/** Turn the schema into express query middleware. Validated values land on `req.validatedQuery`. */
function validateQuery(schema = rawSearchSchema) {
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

module.exports = { rawSearchSchema, validateQuery, objectId };
