'use strict';

/**
 * Allowlisted Mongo query construction (spec §35, §46, §47, §48, §56, §82, §83,
 * §99, §119; step 09 task 2).
 *
 * The one rule this module exists to enforce: **no user-supplied key ever becomes
 * a query key**. The builder never iterates the incoming filter object — it walks
 * the constant tables and copies a key only when it finds the canonical name it
 * expects, writing the dotted path it was compiled with. A client cannot reach
 * `passwordHash`, `$where`, `$regex` or any collection the query was not written
 * for (spec §35, §82 items 7 and 9).
 *
 * Order is part of the contract (spec §83, §99):
 *
 *   1. the allowlisted user filters,
 *   2. then the mandatory predicate (`status: active`),
 *   3. then the exclusion set.
 *
 * Steps 2 and 3 are applied *after* user input, so a crafted request cannot
 * override or remove them — a `status` parameter is not in the allowlist at all,
 * and `userId` is not either.
 */

const {
  SCALAR_FILTERS,
  ARRAY_FILTERS,
  BOOLEAN_FILTERS,
  RANGE_FILTERS,
  MANDATORY_FILTER,
  SORT_KEYS,
  SORT_SPECS,
  CANDIDATE_WINDOW_SORT
} = require('../constants/search');
const { dateOfBirthQuery } = require('./dateRange');
const { buildGeoClause, normalizeGeo } = require('./geoSearch');

/**
 * Build the filter document for a validated filter object.
 *
 * @param {object} filters canonical filter keys (see `constants/search.js`)
 * @param {{reference?: Date}} [options] fixed "now" for the age conversion
 * @returns {object} a Mongo filter with the mandatory predicate already applied
 */
function buildFilter(filters = {}, options = {}) {
  const query = {};

  for (const [key, path] of Object.entries(SCALAR_FILTERS)) {
    const value = filters[key];
    if (typeof value === 'string' && value.length > 0) query[path] = value;
  }

  for (const [key, path] of Object.entries(ARRAY_FILTERS)) {
    const value = filters[key];
    if (Array.isArray(value) && value.length > 0) {
      // Always ids/enum strings, never objects: the validator coerced them.
      query[path] = { $in: value.map((entry) => String(entry)) };
    }
  }

  for (const [key, path] of Object.entries(BOOLEAN_FILTERS)) {
    // `false` means "do not filter" (spec §46 `if (verifiedOnly)`).
    if (filters[key] === true) query[path] = true;
  }

  const ageRange = filters.age;
  if (ageRange && (ageRange.min != null || ageRange.max != null)) {
    const clause = dateOfBirthQuery(ageRange, options.reference);
    if (clause) query[RANGE_FILTERS.age.path] = clause;
  }

  const heightRange = filters.heightCm;
  if (heightRange && (heightRange.min != null || heightRange.max != null)) {
    const clause = {};
    if (typeof heightRange.min === 'number') clause.$gte = heightRange.min;
    if (typeof heightRange.max === 'number') clause.$lte = heightRange.max;
    if (Object.keys(clause).length > 0) query[RANGE_FILTERS.heightCm.path] = clause;
  }

  // Distance search (spec §48). `normalizeGeo` returns null when no coordinate
  // was sent and throws a field-level 400 when one is malformed.
  const geo = normalizeGeo(filters.geo);
  const geoClause = buildGeoClause(geo);
  if (geoClause) Object.assign(query, geoClause);

  // MANDATORY — written last, so nothing a client sent can replace it.
  query[MANDATORY_FILTER.path] = MANDATORY_FILTER.value;

  return query;
}

/**
 * Add the exclusion set. `$nin` on the top-level `userId` — the profile's owner —
 * so self, blocked pairs and (later) passed profiles are removed by the database
 * rather than by a post-filter (spec §99, gate G2.7).
 *
 * @param {object} query built by `buildFilter`
 * @param {Array<string>} excludedUserIds
 */
function applyExclusions(query, excludedUserIds = []) {
  const ids = excludedUserIds.filter(Boolean).map((id) => String(id));
  if (ids.length === 0) return { ...query };
  return { ...query, userId: { $nin: ids } };
}

/**
 * Continue after a cursor. The sort key is compared first and the `_id` tiebreak
 * second, which is what makes paging exact even when many rows share a timestamp
 * (spec §52, gate G2.4).
 *
 * Only the date-ordered sorts have a database key; `recommended` is ordered in
 * the application (spec §54), so a cursor for it is applied by the ranking step
 * and this function leaves the query alone.
 *
 * @param {object} query
 * @param {string} sort an allowed sort value
 * @param {{key: number, id: string}|null} cursor
 */
function applyCursor(query, sort, cursor) {
  const spec = SORT_KEYS[sort];
  if (!cursor || !spec || spec.kind !== 'date') return { ...query };

  const field = spec.field;
  const bound = new Date(cursor.key);
  const conditions = [{ [field]: { $lt: bound } }, { [field]: bound, _id: { $lt: cursor.id } }];
  // A row that has never been active sorts last with a null key; the cursor
  // encodes that as epoch 0, so the tail of the ordering is paged by `_id`.
  if (cursor.key === 0) conditions.push({ [field]: null, _id: { $lt: cursor.id } });

  return { $and: [{ ...query }, { $or: conditions }] };
}

/** The Mongo sort document for an allowed sort value. */
function sortSpecFor(sort) {
  return { ...(SORT_SPECS[sort] || CANDIDATE_WINDOW_SORT) };
}

/**
 * The sort key a cursor must remember for a returned document.
 *
 * @param {object} document lean projected profile
 * @param {string} sort
 * @returns {number} epoch milliseconds (0 when the field is null)
 */
function cursorKeyFor(document, sort) {
  const spec = SORT_KEYS[sort];
  if (!spec || spec.kind !== 'date') return 0;
  const value = spec.field.split('.').reduce((node, key) => (node == null ? undefined : node[key]), document);
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
}

module.exports = { buildFilter, applyExclusions, applyCursor, sortSpecFor, cursorKeyFor };
