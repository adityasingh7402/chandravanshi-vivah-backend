'use strict';

/**
 * Photo request validation (spec §17, §34, §43, §80; step 08 task 11).
 *
 * Every schema is `.strict()`: an unknown field — including `userId`,
 * `moderationStatus` or `url` — is rejected rather than ignored, so a client
 * cannot hand the server a value it is not allowed to choose (spec §34, §44).
 *
 * What validation deliberately does NOT decide: whether the asset exists, whose
 * folder it is in, its format or its size. Those are facts about an uploaded
 * file, and they are answered by the storage provider during registration
 * (spec §43) — never by a request body.
 */

const { z } = require('zod');
const {
  PHOTO_TYPES,
  PHOTO_VISIBILITY,
  MODERATION_STATUSES
} = require('../constants/photo');

const OID_RE = /^[0-9a-fA-F]{24}$/;
const objectId = z.string({ message: 'This field must be a valid identifier.' }).regex(OID_RE, 'This field must be a valid identifier.');

/** The object id in a URL parameter (`:photoId`). */
const photoIdParamSchema = z.object({ photoId: objectId }).strict();

/**
 * Body of `POST /photos` (command 2).
 *
 * `url` is accepted for compatibility with the documented request body but is
 * never stored: the row's URL comes from the provider's own record of the asset
 * (see `photoService.createFromUpload`).
 */
const photoCreateSchema = z
  .object({
    publicId: z
      .string({ message: 'An uploaded asset reference is required.' })
      .trim()
      .min(1, 'An uploaded asset reference is required.')
      .max(512, 'An uploaded asset reference is too long.'),
    type: z.enum(PHOTO_TYPES, { message: 'A photo type must be profile or gallery.' }).optional(),
    isPrimary: z.boolean({ message: 'The primary flag must be true or false.' }).optional(),
    url: z.string().trim().max(1024).optional()
  })
  .strict();

/**
 * Body of `PATCH /photos/:photoId`.
 *
 * At least one changeable field is required: a PATCH that changes nothing is a
 * client bug, and accepting it would make the response meaningless.
 * `moderationStatus` is absent on purpose — only a moderator may set it, and
 * that surface is step 16 (spec §101).
 */
const photoPatchSchema = z
  .object({
    visibility: z
      .enum(PHOTO_VISIBILITY, { message: 'This value is not one of the allowed options.' })
      .optional(),
    sortOrder: z
      .coerce.number({ message: 'The sort order must be a whole number.' })
      .int('The sort order must be a whole number.')
      .min(0, 'The sort order must be at least 0.')
      .max(1000, 'The sort order must be at most 1000.')
      .optional(),
    isPrimary: z.boolean({ message: 'The primary flag must be true or false.' }).optional()
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one of visibility, sortOrder or isPrimary.'
  });

/** Body of `PATCH /photos` — a full gallery order. */
const photoReorderSchema = z
  .object({
    order: z
      .array(objectId, { message: 'The order must be a list of photo identifiers.' })
      .min(1, 'The order must not be empty.')
      .max(100, 'The order is too long.')
  })
  .strict();

/** Only `pending | approved | rejected` exist; re-exported for tests and step 16. */
const MODERATION_STATES = MODERATION_STATUSES;

module.exports = {
  photoIdParamSchema,
  photoCreateSchema,
  photoPatchSchema,
  photoReorderSchema,
  MODERATION_STATES
};
