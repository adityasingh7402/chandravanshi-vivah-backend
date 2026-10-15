'use strict';

/**
 * Name normalisation helpers (spec §75, §102; step 05).
 *
 * Master data is deduplicated by a stable `slug`, not by the display name, so
 * "Kashyap", "kashyap" and "kashyap " must resolve to the same row. The slug is
 * also what makes seeding idempotent — the same input always produces the same
 * key, so a re-run updates instead of inserting.
 *
 * Scripts other than Latin are preserved rather than stripped: many aaspad and
 * gotra names are Devanagari, and transliterating them by hand is exactly the
 * kind of transcription drift this step is trying to avoid. A Devanagari slug
 * is a perfectly valid stable identifier.
 */

/** Characters removed before a slug is built: /, &, and most punctuation. */
const PUNCTUATION_RE = /[/&,.'"`’“”()\[\]{}<>|\\!?;:*+=~^%$#@]+/g;
/** Anything that is not a unicode letter, mark, number or hyphen. */
const DISALLOWED_RE = /[^\p{L}\p{M}\p{N}-]+/gu;
/** Runs of hyphens. */
const HYPHEN_RUN_RE = /-{2,}/g;

/**
 * Normalise a display name for comparison: Unicode NFC, trimmed, collapsed
 * whitespace. Case is intentionally preserved for storage (the slug carries the
 * case-insensitive identity).
 *
 * @param {unknown} name
 * @returns {string}
 */
function normaliseName(name) {
  return String(name ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Build a stable slug from a name. Never returns an empty string when the input
 * contains at least one letter or number.
 *
 * @param {unknown} name
 * @returns {string}
 */
function toSlug(name) {
  const normalised = normaliseName(name).toLowerCase();
  return normalised
    .replace(PUNCTUATION_RE, '-')
    .replace(DISALLOWED_RE, '-')
    .replace(HYPHEN_RUN_RE, '-')
    .replace(/^-+|-+$/g, '');
}

module.exports = { toSlug, normaliseName };
