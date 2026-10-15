'use strict';

/**
 * Profile request validation (spec §34, §80, §81, §97; fields dictionary
 * cross-field table; step 06 task 4).
 *
 * Two layers, both strict:
 *
 *  1. **Shape.** One schema per section. Every schema is `.strict()`, so an
 *     unknown field (including `userId`, `role`) is rejected rather than silently
 *     ignored (spec §34, §44).
 *  2. **Cross-field.** The same schema carries `superRefine` rules, and the
 *     service validates the *merged* document with it — so a partial update that
 *     would break a rule against the stored state is rejected, not stored
 *     (task 6).
 *
 * Denormalised `*Name` copies are accepted for round-tripping but are always
 * recomputed server-side from the referenced master record; the one exception is
 * `community.surnameName`, which the fields dictionary permits as a
 * profile-local custom value when `surnameId` is null (§4.3).
 */

const { z } = require('zod');
const config = require('../config/env');
const { BadRequestError } = require('../utils/AppError');
const { ENUMS } = require('../constants/profile');

const OID_RE = /^[0-9a-fA-F]{24}$/;
const objectId = z.string({ message: 'This field must be a valid identifier.' }).regex(OID_RE, 'This field must be a valid identifier.');
// Every id is nullable: an unfilled draft stores the schema default `null`, and
// a patch must be able to round-trip that state instead of rejecting it.
const optionalId = objectId.nullable().optional();

const nameText = (max, label) =>
  z.string({ message: `${label} is required.` }).trim().min(1, `${label} cannot be empty.`).max(max, `${label} must be at most ${max} characters.`);

/** Optional text that may be explicitly cleared with `null`. */
const optionalText = (max, label) =>
  z.string({ message: `${label} must be text.` }).trim().max(max, `${label} must be at most ${max} characters.`).nullable().optional();

const enumField = (values) => z.enum(values, { message: 'This value is not one of the allowed options.' }).nullable().optional();

/** Whole number within bounds, or null/absent. */
const boundedInt = (min, max, label) =>
  z
    .coerce.number({ message: `${label} must be a whole number.` })
    .int(`${label} must be a whole number.`)
    .min(min, `${label} must be at least ${min}.`)
    .max(max, `${label} must be at most ${max}.`)
    .nullable()
    .optional();

/** A count field: spec §8 types these as a plain `Number`, defaulting to 0. */
const countField = (min, max, label) =>
  z
    .coerce.number({ message: `${label} must be a whole number.` })
    .int(`${label} must be a whole number.`)
    .min(min, `${label} must be at least ${min}.`)
    .max(max, `${label} must be at most ${max}.`)
    .optional()
    .default(0);

/** Accepts an ISO date or `YYYY-MM-DD`; `null` clears it. */
const dateField = z
  .string({ message: 'A valid date is required.' })
  .refine((value) => !Number.isNaN(new Date(value).getTime()), { message: 'A valid date is required.' })
  .nullable()
  .optional();

function ageFrom(dateOfBirth) {
  const dob = new Date(dateOfBirth);
  const now = new Date();
  let age = now.getFullYear() - dob.getFullYear();
  const month = now.getMonth() - dob.getMonth();
  if (month < 0 || (month === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
}

const currentYear = new Date().getFullYear();
const GRADUATION_MIN = 1970;
const GRADUATION_MAX = currentYear + 5;

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

const basicSchema = z
  .object({
    profileFor: z.enum(ENUMS.profileFor, { message: 'Choose who the profile is for.' }).nullable().optional(),
    firstName: nameText(60, 'First name').nullable().optional(),
    middleName: optionalText(60, 'Middle name'),
    lastName: optionalText(60, 'Last name'),
    gender: z.enum(ENUMS.gender, { message: 'Choose a gender.' }).nullable().optional(),
    dateOfBirth: dateField,
    maritalStatus: z.enum(ENUMS.maritalStatus, { message: 'Choose a marital status.' }).nullable().optional(),
    heightCm: boundedInt(config.profile.minHeightCm, config.profile.maxHeightCm, 'Height')
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dateOfBirth === undefined || value.dateOfBirth === null) return;
    // An unparseable date is already reported by the field itself; don't stack a
    // bogus age error on top of it.
    if (Number.isNaN(new Date(value.dateOfBirth).getTime())) return;
    const age = ageFrom(value.dateOfBirth);
    if (!Number.isFinite(age) || age < config.profile.minAge || age > config.profile.maxAge) {
      ctx.addIssue({
        code: 'custom',
        path: ['dateOfBirth'],
        message: `Age must be between ${config.profile.minAge} and ${config.profile.maxAge}.`
      });
    }
  });

const communitySchema = z
  .object({
    communityId: optionalId,
    subCommunityId: optionalId,
    surnameId: optionalId,
    // Profile-local custom surname, allowed only when surnameId is null (§4.3).
    surnameName: optionalText(60, 'Surname'),
    gotraId: optionalId,
    gotraName: optionalText(80, 'Gotra'),
    clanId: optionalId,
    clanName: optionalText(80, 'Clan'),
    aaspadId: optionalId,
    aaspadName: optionalText(80, 'Aaspad'),
    motherTongueId: optionalId,
    motherTongueName: optionalText(60, 'Mother tongue'),
    religion: enumField(ENUMS.religion)
  })
  .strict();

const locationSchema = z
  .object({
    countryId: optionalId,
    stateId: optionalId,
    districtId: optionalId,
    cityId: optionalId,
    countryName: optionalText(80, 'Country'),
    stateName: optionalText(80, 'State'),
    districtName: optionalText(80, 'District'),
    cityName: optionalText(80, 'City')
    // `coordinates` is server-derived from the selected city — a client never
    // supplies a location (spec §48, §76).
  })
  .strict();

const educationSchema = z
  .object({
    highestQualificationId: optionalId,
    degreeId: optionalId,
    degreeName: optionalText(80, 'Degree'),
    specializationId: optionalId,
    specializationName: optionalText(80, 'Specialization'),
    collegeId: optionalId,
    universityId: optionalId,
    universityName: optionalText(100, 'University'),
    graduationYear: boundedInt(GRADUATION_MIN, GRADUATION_MAX, 'Graduation year')
  })
  .strict();

const careerSchema = z
  .object({
    occupationId: optionalId,
    occupationName: optionalText(80, 'Occupation'),
    industryId: optionalId,
    industryName: optionalText(80, 'Industry'),
    employmentType: enumField(ENUMS.employmentType),
    company: optionalText(120, 'Company'),
    designation: optionalText(80, 'Designation'),
    workLocation: optionalText(80, 'Work location'),
    experienceYears: boundedInt(0, 50, 'Experience'),
    incomeRange: enumField(ENUMS.incomeRange)
  })
  .strict();

const familySchema = z
  .object({
    familyType: enumField(ENUMS.familyType),
    familyStatus: enumField(ENUMS.familyStatus),
    fatherOccupation: optionalText(80, 'Father occupation'),
    motherOccupation: optionalText(80, 'Mother occupation'),
    brothersCount: countField(0, 20, 'Brothers'),
    marriedBrothersCount: countField(0, 20, 'Married brothers'),
    sistersCount: countField(0, 20, 'Sisters'),
    marriedSistersCount: countField(0, 20, 'Married sisters'),
    familyLocation: optionalText(80, 'Family location')
  })
  .strict()
  .superRefine((value, ctx) => {
    // Fields dictionary §8.6 / §8.8.
    if ((value.marriedBrothersCount ?? 0) > (value.brothersCount ?? 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['marriedBrothersCount'],
        message: 'Married brothers cannot exceed the total number of brothers.'
      });
    }
    if ((value.marriedSistersCount ?? 0) > (value.sistersCount ?? 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['marriedSistersCount'],
        message: 'Married sisters cannot exceed the total number of sisters.'
      });
    }
  });

const lifestyleSchema = z
  .object({
    diet: enumField(ENUMS.diet),
    dietOther: optionalText(60, 'Custom diet'),
    smoking: enumField(ENUMS.smoking),
    drinking: enumField(ENUMS.drinking),
    fitness: enumField(ENUMS.fitness),
    pets: enumField(ENUMS.pets)
  })
  .strict()
  .superRefine((value, ctx) => {
    // Fields dictionary §9.1: `dietOther` exists only to carry the "other" choice.
    if (value.dietOther !== null && value.dietOther !== undefined && value.dietOther !== '' && value.diet !== 'other') {
      ctx.addIssue({
        code: 'custom',
        path: ['dietOther'],
        message: 'A custom diet description is only accepted when diet is "other".'
      });
    }
  });

const personalSchema = z
  .object({
    hobbies: z.array(objectId).max(config.profile.maxHobbies, `Choose at most ${config.profile.maxHobbies} hobbies.`).optional(),
    interests: z.array(objectId).max(config.profile.maxInterests, `Choose at most ${config.profile.maxInterests} interests.`).optional(),
    languages: z.array(objectId).max(config.profile.maxLanguages, `Choose at most ${config.profile.maxLanguages} languages.`).optional()
  })
  .strict();

const horoscopeSchema = z
  .object({
    available: z.boolean().optional(),
    birthTime: z
      .string({ message: 'Birth time must be a time of day.' })
      .refine((value) => !Number.isNaN(new Date(value).getTime()), { message: 'A valid time is required.' })
      .nullable()
      .optional(),
    birthPlace: optionalText(80, 'Birth place'),
    rashi: optionalText(40, 'Rashi'),
    nakshatra: optionalText(40, 'Nakshatra'),
    manglik: enumField(ENUMS.manglik)
  })
  .strict();

const marriageSchema = z
  .object({
    hasChildren: z.boolean().nullable().optional(),
    childrenCount: boundedInt(0, 20, 'Children'),
    wantsChildren: enumField(ENUMS.wantsChildren)
  })
  .strict()
  .superRefine((value, ctx) => {
    // Fields dictionary §12: a count is meaningless without "has children".
    if ((value.childrenCount ?? 0) > 0 && value.hasChildren !== true) {
      ctx.addIssue({
        code: 'custom',
        path: ['childrenCount'],
        message: 'A children count can only be given when "has children" is yes.'
      });
    }
  });

const aboutSchema = z
  .object({
    headline: optionalText(config.profile.headlineMaxLen, 'Headline'),
    description: optionalText(config.profile.aboutMaxLen, 'About me')
  })
  .strict();

/** Every section a PATCH may touch. All optional — a draft may be partial. */
const CONTENT_SECTIONS = Object.freeze([
  'basic', 'community', 'location', 'education', 'career', 'family',
  'lifestyle', 'personal', 'horoscope', 'marriage', 'about'
]);

const contentShape = {
  basic: basicSchema.optional(),
  community: communitySchema.optional(),
  location: locationSchema.optional(),
  education: educationSchema.optional(),
  career: careerSchema.optional(),
  family: familySchema.optional(),
  lifestyle: lifestyleSchema.optional(),
  personal: personalSchema.optional(),
  horoscope: horoscopeSchema.optional(),
  marriage: marriageSchema.optional(),
  about: aboutSchema.optional()
};

/**
 * `POST /api/v1/profile` — content sections only.
 *
 * `profile.status` is NOT accepted here: a freshly created profile is always a
 * draft (spec §58 privacy default), so `status` would either be ignored or
 * always rejected. Saying so with a 400 is honest; silently dropping it is not.
 */
const profileCreateSchema = z.object(contentShape).strict();

/**
 * `PATCH /api/v1/profile` — content sections plus an explicit intent to publish
 * or unpublish. `suspended` and `deleted` are deliberately absent: those are set
 * by the admin (step 16), while profile deletion is handled by the DELETE route.
 */
const profilePatchSchema = z
  .object({ ...contentShape, status: z.enum(['active', 'hidden'], { message: 'Status must be "active" or "hidden".' }).optional() })
  .strict();

/** `GET /profile/:publicProfileId` has no body; nothing else is validated here. */

/**
 * Validate an already-merged document. The service calls this after overlaying a
 * patch onto the stored profile, so cross-field rules always see full context.
 *
 * @param {object} sections a plain object of the eleven section values
 * @returns {Promise<object>} the parsed sections
 */
function validateMerged(sections) {
  const result = z.object(contentShape).strict().safeParse(sections);
  if (!result.success) throw toBadRequest(result.error);
  return result.data;
}

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

/** Turn a Zod schema into express body middleware (same shape as auth's). */
function validateBody(schema) {
  return function validate(req, res, next) {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) return next(toBadRequest(result.error));
    req.body = result.data;
    return next();
  };
}

module.exports = {
  profileCreateSchema,
  profilePatchSchema,
  CONTENT_SECTIONS,
  validateMerged,
  validateBody,
  zodToDetails,
  toBadRequest,
  ageFrom
};
