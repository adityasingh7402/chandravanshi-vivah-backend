'use strict';

/**
 * Search exclusions (spec §56, §83, §99; step 09 task 5).
 *
 * Discover must never surface an ineligible profile. Two different mechanisms do
 * that, on purpose:
 *
 *   - **Status** (`profile.status: active`) is a *predicate*, applied by the
 *     query builder to every query. Draft, hidden, suspended and deleted
 *     documents are never candidates at all (spec §56, §58).
 *   - **User ids** are a *set*, assembled here: the caller themselves, and — once
 *     steps 10 and 12 exist — blocked pairs and previously-passed profiles.
 *
 * The interface is deliberately `getExcludedUserIds(userId) -> string[]` so steps
 * 10 and 12 can add a source without touching the query shape (step 09 acceptance
 * criterion). A source is a small async function; the ones in this module are
 * self-exclusion, blocks and previously-passed profiles.
 *
 * The block source now reads the real `models/Block.js` (step 12 owns it); before
 * that step existed it resolved the model lazily from the Mongoose registry so
 * this module needed no forward import. Reading the model directly means the
 * bilateral rule has one definition — `blockService` — and Discover gets it for
 * free (spec §99).
 */

const config = require('../config/env');
const { logger } = require('../middleware/requestLogger');
const { ServiceUnavailableError } = require('../utils/AppError');
const { COLLECTIONS } = require('../config/collections');
const ProfileAction = require('../models/ProfileAction');
const Block = require('../models/Block');
const { DISCOVERY_EXCLUDED_TYPES } = require('../constants/actions');

/** Sources contributed by later steps. Empty in step 09. */
const EXTRA_SOURCES = [];

/**
 * Register an additional exclusion source.
 *
 * @param {string} name short label for diagnostics
 * @param {(userId: string) => Promise<Array<string|import('mongoose').Types.ObjectId>>} source
 */
function registerSource(name, source) {
  EXTRA_SOURCES.push({ name, source });
}

/** The caller is never a candidate in their own results (spec §56, gate G2.7). */
async function selfExclusion(userId) {
  return userId ? [String(userId)] : [];
}

/**
 * Blocked pairs (spec §22, §99): a candidate is excluded when *either* side
 * blocked the other, so the effect is bilateral regardless of who blocked whom.
 *
 * The `$or` is served by the two single-field indexes step 12 declares
 * (`blockerId` and `blockedUserId`), which MongoDB resolves as an index union.
 *
 * @param {string} userId
 */
async function blockExclusion(userId) {
  if (!userId) return [];

  const rows = await Block.find({ $or: [{ blockerId: userId }, { blockedUserId: userId }] })
    .select('blockerId blockedUserId')
    .lean();

  const ids = new Set();
  for (const row of rows) {
    if (row.blockerId) ids.add(String(row.blockerId));
    if (row.blockedUserId) ids.add(String(row.blockedUserId));
  }
  return [...ids];
}

/**
 * Previously-passed profiles (spec §56, §99; step 10 task 7).
 *
 * A `pass` is a decision that the target should not resurface, so the actor's
 * own pass rows are an exclusion source. It fits the same interface as every
 * other source — a list of ids — which is exactly why step 09's query shape
 * needed no change (its acceptance criterion).
 *
 * The set of types that exclude is `DISCOVERY_EXCLUDED_TYPES` (currently just
 * `pass`), so a product decision to also hide already-liked targets is one edit
 * in `constants/actions.js`.
 *
 * @param {string} userId
 */
async function passExclusion(userId) {
  if (!userId || DISCOVERY_EXCLUDED_TYPES.length === 0) return [];
  const rows = await ProfileAction.find({ fromUserId: userId, type: { $in: DISCOVERY_EXCLUDED_TYPES } })
    .select('toUserId')
    .lean();
  return rows.map((row) => (row.toUserId ? String(row.toUserId) : null)).filter(Boolean);
}

/**
 * Merge the id sets from every source into a de-duplicated list, enforcing the
 * `$nin` guard.
 *
 * Exported so the cap can be unit-tested without registering a global source: a
 * block list bigger than `EXCLUSION_MAX_IDS` is a different query shape
 * (spec §99 says so explicitly), and the one thing this must never do is drop an
 * exclusion and show a blocked profile. It therefore refuses loudly instead.
 *
 * @param {Array<Array<string>>} sets
 * @param {number} [cap]
 * @returns {string[]}
 */
function mergeExclusions(sets, cap = config.exclusion.maxIds) {
  const ids = new Set();
  for (const set of sets) {
    for (const id of set || []) {
      if (id) ids.add(String(id));
    }
  }

  if (ids.size > cap) {
    logger.warn({ count: ids.size, cap }, 'exclusion set exceeds the $nin guard (spec §99)');
    throw new ServiceUnavailableError(
      'Search is temporarily unavailable. Please try again later.',
      { cause: new Error(`Exclusion set of ${ids.size} exceeds the configured cap of ${cap}.`) }
    );
  }

  return [...ids];
}

/**
 * Every user id Discover must exclude for this account.
 *
 * @param {string} userId from `req.auth` only
 * @returns {Promise<string[]>}
 */
async function getExcludedUserIds(userId) {
  const sources = [selfExclusion, blockExclusion, passExclusion, ...EXTRA_SOURCES.map((entry) => entry.source)];
  const sets = await Promise.all(sources.map((source) => source(userId)));
  return mergeExclusions(sets);
}

/** The collection the block source reads, re-exported for the docs and tests. */
const BLOCKS_COLLECTION = COLLECTIONS.BLOCKS;

/** Test-only: drop the contributed sources so a suite leaves no global state. */
function resetSources() {
  EXTRA_SOURCES.length = 0;
}

module.exports = {
  getExcludedUserIds,
  selfExclusion,
  blockExclusion,
  passExclusion,
  registerSource,
  resetSources,
  mergeExclusions,
  BLOCKS_COLLECTION
};
