'use strict';

/**
 * Age -> date-of-birth conversion (spec §46, §47; step 09 task 3).
 *
 * Age is never stored and never queried: `dateOfBirth` is the source of truth,
 * and a requested age range is converted into inclusive DOB boundaries so the
 * query can use the `basic.dateOfBirth` index (spec §47, §105).
 *
 * The conversion runs against a **fixed reference instant** supplied by the
 * caller. Two consequences, both deliberate:
 *
 *   - the query is index-friendly and reproducible (the tests pin the reference
 *     so a boundary is not a moving target);
 *   - the boundary is accurate to the day, which is what a birth *date* can
 *     express. This is the same local-calendar rule `profileSerializer` uses to
 *     derive an age at read time, so the two never disagree about who is 30.
 */

/** Shift a date by whole years, clamping Feb 29 onto Feb 28 in a non-leap year. */
function shiftYears(base, years) {
  const out = new Date(base.getTime());
  const month = out.getMonth();
  out.setFullYear(out.getFullYear() + years);
  // e.g. 2024-02-29 minus one year would roll to 2023-03-01; keep it in Feb.
  if (out.getMonth() !== month) out.setDate(0);
  return out;
}

function shiftDays(base, days) {
  const out = new Date(base.getTime());
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * The start of the reference's own calendar day.
 *
 * A birth date is a *date*, so a boundary that carried a time of day would
 * wrongly exclude someone born on the boundary day itself (age is computed by
 * calendar date in `profileSerializer.computeAge`, so the two must use the same
 * day convention).
 */
function startOfDay(date) {
  const out = new Date(date.getTime());
  out.setHours(0, 0, 0, 0);
  return out;
}

/**
 * Convert an age range into inclusive DOB boundaries.
 *
 *   age >= minAge   <=>  dateOfBirth <= now - minAge years        (latest DOB)
 *   age <= maxAge   <=>  dateOfBirth >= now - (maxAge + 1) years  (earliest DOB)
 *
 * The earliest boundary is `+1 day` because a birth date exactly
 * `maxAge + 1` years ago is already one day too old.
 *
 * @param {{min?: number|null, max?: number|null}} range
 * @param {Date} [reference] the instant the ages are expressed against
 * @returns {{from: Date|null, to: Date|null}} `from`/`to` are null when that end
 *   of the range is unbounded, so the builder only emits the bounds that exist.
 */
function dateOfBirthRange(range = {}, reference = new Date()) {
  const { min = null, max = null } = range || {};
  const bounds = { from: null, to: null };
  const anchor = startOfDay(reference);

  if (typeof max === 'number') {
    bounds.from = shiftDays(shiftYears(anchor, -(max + 1)), 1);
  }
  if (typeof min === 'number') {
    bounds.to = shiftYears(anchor, -min);
  }

  return bounds;
}

/**
 * The Mongo range document for a DOB range, or null when neither bound is set.
 * Keys are the literal operators `$gte` / `$lte` — never user-supplied.
 */
function dateOfBirthQuery(range, reference) {
  const { from, to } = dateOfBirthRange(range, reference);
  const clause = {};
  if (from) clause.$gte = from;
  if (to) clause.$lte = to;
  return Object.keys(clause).length > 0 ? clause : null;
}

module.exports = { dateOfBirthRange, dateOfBirthQuery, shiftYears, shiftDays, startOfDay };
