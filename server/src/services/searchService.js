'use strict';

/**
 * Discover / search orchestration (spec §46, §51, §52, §53, §54, §55, §56, §70,
 * §83, §99, §108, §119, §120; step 09 tasks 9, 10, 11, 14, 15).
 *
 * One pipeline serves all three endpoints, which is why they live in one module:
 *
 *   load effective filters (discover/recommendations only)
 *        ↓
 *   overlay the request's explicit filters
 *        ↓
 *   build the allowlisted query + the mandatory predicate
 *        ↓
 *   apply exclusions (self, blocks)
 *        ↓
 *   execute with the card projection, one sort, one bounded page
 *        ↓
 *   attach one transformed photo URL per row (one query for the whole page)
 *
 * `/search` is the same pipeline with the preference merge removed, so an
 * explicit filter set is honoured exactly (step 09 task 10).
 *
 * `recommended` is the one branch that cannot be expressed as a database sort:
 * it fetches a **bounded candidate window** by recency and ranks it in the
 * application (spec §54, §55). It never scores the collection.
 */

const MatrimonialProfile = require('../models/MatrimonialProfile');
const Photo = require('../models/Photo');
const preferenceService = require('./preferenceService');
const exclusionService = require('./exclusionService');
const queryBuilder = require('./queryBuilder');
const cursorCodec = require('./cursor');
const recommendationService = require('./recommendationService');
const projections = require('../utils/projections');
const { variantsFor } = require('../utils/cloudinaryUrl');
const { MODERATION_STATUS } = require('../constants/photo');
const {
  SORT,
  SORT_VALUES,
  DEFAULT_SORT,
  PAGE,
  PREFERENCE_FILTER_MAP,
  recommendationWindow
} = require('../constants/search');

/** Clamp a requested page size into the configured range (spec §52, §80). */
function clampLimit(limit) {
  const requested = Number(limit);
  if (!Number.isInteger(requested) || requested < 1) return PAGE.defaultLimit;
  return Math.min(requested, PAGE.maxLimit);
}

/** Only an allowed sort value reaches the database (spec §53). */
function normalizeSort(sort) {
  return SORT_VALUES.includes(sort) ? sort : DEFAULT_SORT;
}

/**
 * Translate the viewer's saved preferences into this step's canonical filter
 * keys (see `PREFERENCE_FILTER_MAP`). Only the mapped dimensions survive: a
 * preference the profile has no search path for never becomes a query key.
 *
 * @param {object} effective `preferenceService.effectiveFilters()` output
 */
function fromEffectiveFilters(effective = {}) {
  const filters = {};
  for (const [preferenceKey, filterKey] of Object.entries(PREFERENCE_FILTER_MAP)) {
    const value = effective[preferenceKey];
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      if (value.length > 0) filters[filterKey] = value.map((entry) => String(entry));
      continue;
    }
    if (typeof value === 'object') {
      filters[filterKey] = { ...value };
      continue;
    }
    filters[filterKey] = value;
  }
  return filters;
}

/**
 * Overlay explicit filters on the viewer's saved preferences.
 *
 * Explicit input always wins: a request that names a gender must not be silently
 * combined with the stored default. Ranges merge bound-wise, so `?minAge=26`
 * narrows the stored maximum rather than discarding it.
 *
 * @param {object} preferred `preferenceService.effectiveFilters()` output
 * @param {object} explicit validated query filters
 */
function mergeFilters(preferred = {}, explicit = {}) {
  const merged = { ...preferred };
  for (const [key, value] of Object.entries(explicit)) {
    if (value === undefined) continue;
    if ((key === 'age' || key === 'heightCm') && value && typeof value === 'object') {
      merged[key] = { ...(merged[key] || {}), ...value };
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

/**
 * The card URL for every primary, **approved** photo in a page — one query, not
 * one per row (spec §18, §82 item 4). A row with no eligible photo simply has no
 * entry, and its card carries `primaryPhoto: null`.
 *
 * @param {Array<string|import('mongoose').Types.ObjectId>} userIds
 * @returns {Promise<Map<string, string>>}
 */
async function primaryCardUrls(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean).map((id) => String(id)))];
  if (ids.length === 0) return new Map();

  const photos = await Photo.find({
    userId: { $in: ids },
    isPrimary: true,
    moderationStatus: MODERATION_STATUS.APPROVED
  })
    .select('userId publicId')
    .lean();

  const urls = new Map();
  for (const photo of photos) {
    urls.set(String(photo.userId), variantsFor(photo.publicId).card.url);
  }
  return urls;
}

/** A page of cards from lean projected documents. */
async function toItems(documents) {
  const urls = await primaryCardUrls(documents.map((document) => document.userId));
  return documents.map((document) =>
    projections.serializeCard(document, { primaryPhoto: urls.get(String(document.userId)) || null })
  );
}

/**
 * The key-ordered page path (spec §52): ask for one row more than the page so
 * `nextCursor` is returned only when a further page really exists.
 */
async function keyedPage({ filters, excluded, sort, limit, cursor, reference }) {
  const base = queryBuilder.applyExclusions(queryBuilder.buildFilter(filters, { reference }), excluded);
  const query = queryBuilder.applyCursor(base, sort, cursor);

  const documents = await MatrimonialProfile.find(query)
    .select(projections.CARD_PROJECTION)
    .sort(queryBuilder.sortSpecFor(sort))
    .limit(limit + 1)
    .lean();

  const hasMore = documents.length > limit;
  const page = hasMore ? documents.slice(0, limit) : documents;
  const last = page[page.length - 1];

  return {
    items: await toItems(page),
    nextCursor: hasMore
      ? cursorCodec.encodeCursor({ sort, key: queryBuilder.cursorKeyFor(last, sort), id: last._id })
      : null
  };
}

/**
 * The ranked path: fetch a bounded window, score it, order it, page it.
 *
 * The window is capped by `SEARCH_CANDIDATE_CAP` and by a multiple of the page
 * size, so a client cannot ask for a bigger `limit` to make the server score the
 * whole base (spec §54, §55). Deep pagination beyond the window is intentionally
 * unsupported for a ranking; the cursor still makes page-to-page continuation
 * exact inside the window.
 */
async function rankedPage({ filters, excluded, limit, cursor, reference }) {
  const window = recommendationWindow(limit);
  const query = queryBuilder.applyExclusions(queryBuilder.buildFilter(filters, { reference }), excluded);

  const documents = await MatrimonialProfile.find(query)
    .select(projections.RECOMMENDATION_PROJECTION)
    .sort({ 'profile.lastActiveAt': -1, _id: -1 })
    .limit(window)
    .lean();

  const scored = recommendationService.afterCursor(
    recommendationService.rank(documents, { filters }),
    cursor
  );

  const hasMore = scored.length > limit;
  const page = scored.slice(0, limit);
  const last = page[page.length - 1];

  return {
    items: await toItems(page.map((entry) => entry.document)),
    nextCursor:
      hasMore && last
        ? cursorCodec.encodeCursor({ sort: SORT.RECOMMENDED, key: last.score, id: last.document._id })
        : null
  };
}

/**
 * Shared entry point for the three endpoints.
 *
 * @param {{userId: string, filters: object, sort?: string, limit?: number, cursor?: string, reference?: Date}} request
 */
async function page({ userId, filters, sort, limit, cursor, reference }) {
  const resolvedLimit = clampLimit(limit);
  const sortValue = normalizeSort(sort);
  const excluded = await exclusionService.getExcludedUserIds(userId);
  const cursorValue = cursor ? cursorCodec.decodeCursorFor(cursor, sortValue) : null;

  if (sortValue === SORT.RECOMMENDED) {
    return rankedPage({ filters, excluded, limit: resolvedLimit, cursor: cursorValue, reference });
  }

  return keyedPage({ filters, excluded, sort: sortValue, limit: resolvedLimit, cursor: cursorValue, reference });
}

/**
 * GET /discover — the viewer's preferences with explicit filters on top.
 *
 * @param {string} userId from `req.auth` only
 * @param {{filters?: object, sort?: string, limit?: number, cursor?: string}} query validated request
 */
async function discover(userId, query = {}) {
  const preferred = await preferenceService.effectiveFilters(userId);
  return page({
    userId,
    filters: mergeFilters(fromEffectiveFilters(preferred), query.filters),
    sort: query.sort,
    limit: query.limit,
    cursor: query.cursor
  });
}

/**
 * GET /search — explicit filters only: no preference merge, so what the client
 * asked for is exactly what is filtered on (step 09 task 10).
 */
async function search(userId, query = {}) {
  return page({
    userId,
    filters: query.filters || {},
    sort: query.sort,
    limit: query.limit,
    cursor: query.cursor
  });
}

/**
 * GET /recommendations — preferences drive both the candidate query and the
 * scoring context; explicit filters narrow it further (spec §55).
 */
async function recommendations(userId, query = {}) {
  const preferred = await preferenceService.effectiveFilters(userId);
  return page({
    userId,
    filters: mergeFilters(fromEffectiveFilters(preferred), query.filters),
    sort: SORT.RECOMMENDED,
    limit: query.limit,
    cursor: query.cursor
  });
}

module.exports = {
  discover,
  search,
  recommendations,
  page,
  mergeFilters,
  fromEffectiveFilters,
  clampLimit,
  normalizeSort,
  primaryCardUrls,
  toItems
};
