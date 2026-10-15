'use strict';

/**
 * Report service (spec §23, §34, §44, §101, §105, §112; step 12 tasks 8–10).
 *
 * Filing a report opens a moderation case. This module owns exactly two
 * operations — create and the caller's own list — because **step 16 owns every
 * moderation transition** (spec §32, §101): `status`, `reviewedBy` and
 * `reviewedAt` are never writable from a user route, and no user route may read
 * another account's report.
 *
 * Two decisions worth naming:
 *
 *   - **The duplicate rule is a refusal, not a counter** (task 8). A second
 *     report for the same `(reporter, reported, category)` is refused with a
 *     `409` while an `open`/`reviewing` report exists for it (gate G2.9). The
 *     alternative — accepting duplicates and counting them — would let one account
 *     inflate a moderation queue with the same complaint, which is precisely the
 *     review-flooding abuse the step asks to bound. Once the case reaches
 *     `resolved` or `dismissed`, the pair may be reported again: a dismissed case
 *     followed by new evidence is legitimate.
 *   - **The reporter is unreachable from a response.** `reporterId` and
 *     `reviewedBy` are `select: false` on the model, the serialiser names every
 *     field it returns, and `listOwn` only ever queries the caller's own reports —
 *     so the reported account can never see who reported them (spec §112).
 */

const config = require('../config/env');
const Report = require('../models/Report');
const MatrimonialProfile = require('../models/MatrimonialProfile');
const blockService = require('./blockService');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/AppError');
const { REPORT_STATUS, ACTIVE_REPORT_STATUSES } = require('../constants/safety');

/**
 * Clamp a requested page size into the configured range (spec §80).
 *
 * @param {number|undefined} limit
 * @param {{defaultLimit: number, maxLimit: number}} bounds
 */
function clampLimit(limit, bounds) {
  const requested = Number(limit);
  if (!Number.isInteger(requested) || requested < 1) return bounds.defaultLimit;
  return Math.min(requested, bounds.maxLimit);
}

/**
 * File a report (task 8).
 *
 * Order: self → target exists → duplicate → write. Self is refused before any
 * query; the target must be a real profile (**any** status — reporting an account
 * that has since been suspended is exactly when a report matters most); an
 * already-active case for the same pair and category is a 409; otherwise an `open`
 * report is created.
 *
 * The target check deliberately does **not** consult blocks: reporting someone you
 * have blocked is a legitimate and common flow, and refusing it would force a user
 * to unblock in order to report.
 *
 * @param {string} reporterId from `req.auth.userId`
 * @param {{reportedUserId?: string, publicProfileId?: string, category: string, description?: string|null, evidence?: string[]}} input validated body
 * @returns {Promise<{ report: object, created: boolean }>}
 */
async function create(reporterId, input) {
  const reportedId = await resolveTarget(input);

  if (String(reportedId) === String(reporterId)) {
    throw new BadRequestError('You cannot report your own profile.', {
      details: { reportedUserId: 'Choose another profile.' }
    });
  }

  const profile = await MatrimonialProfile.findOne({ userId: reportedId }).select('_id').lean();
  if (!profile) throw new NotFoundError('The requested resource does not exist.');

  const duplicate = await Report.exists({
    reporterId,
    reportedUserId: reportedId,
    category: input.category,
    status: { $in: ACTIVE_REPORT_STATUSES }
  });
  if (duplicate) {
    throw new ConflictError('You have already reported this profile for the same reason.', {
      details: { category: input.category, status: REPORT_STATUS.OPEN }
    });
  }

  const report = await Report.create({
    reporterId,
    reportedUserId: reportedId,
    category: input.category,
    description: input.description ?? null,
    evidence: input.evidence ?? [],
    status: REPORT_STATUS.OPEN,
    reviewedBy: null,
    reviewedAt: null
  });

  // Re-read with the default projection so the admin-only fields stay out of the
  // returned document even internally (`create` returns the full doc in memory,
  // `reporterId` included).
  const stored = await Report.findById(report._id).lean();
  return { report: stored, created: true };
}

/**
 * The caller's own reports, newest first, paginated (task 9).
 *
 * Scoped to `reporterId`, so a caller can only ever read their own cases. Each row
 * carries its status and the reported account's *public* identity — never the
 * account ids, never a reviewer, and of course never a reporter (the caller is the
 * reporter). A reported profile that has since been removed resolves to `null`
 * rather than dropping the row: the caller's own history must stay complete.
 *
 * @param {string} reporterId
 * @param {{status?: string, limit?: number, cursor?: string}} query validated query
 */
async function listOwn(reporterId, query = {}) {
  const limit = clampLimit(query.limit, config.safety.reports);
  const filter = { reporterId };
  if (query.status) filter.status = query.status;
  if (query.cursor) filter._id = { $lt: query.cursor };

  const rows = await Report.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const profiles = await MatrimonialProfile.find({
    userId: { $in: page.map((row) => row.reportedUserId) }
  })
    .select('userId publicProfileId basic.firstName profile.status')
    .lean();
  const byUser = new Map(profiles.map((profile) => [String(profile.userId), profile]));

  const items = page.map((row) => {
    const profile = byUser.get(String(row.reportedUserId));
    return {
      id: String(row._id),
      category: row.category,
      description: row.description ?? null,
      evidence: row.evidence ?? [],
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      reported: {
        profileId: profile ? profile.publicProfileId : null,
        name: profile ? profile.basic?.firstName || null : null,
        profileStatus: profile ? profile.profile?.status || null : null
      }
    };
  });

  const last = page[page.length - 1];
  return { items, nextCursor: hasMore && last ? String(last._id) : null };
}

/**
 * The step-13 notification hook, re-exported so the moderation surface and the
 * notification surface answer "may these two accounts be told about each other?"
 * through one function.
 *
 * @param {string} fromUserId
 * @param {string} toUserId
 * @returns {Promise<boolean>}
 */
async function notificationsAllowed(fromUserId, toUserId) {
  return blockService.canNotify(fromUserId, toUserId);
}

/**
 * Resolve a request's target to an account id (same contract as the action and
 * connection services): the client may name it by account id or by the public,
 * non-sequential id, and a `publicProfileId` is resolved **server-side**
 * (spec §44, §113).
 *
 * @param {{reportedUserId?: string, publicProfileId?: string}} input
 * @returns {Promise<string>}
 */
async function resolveTarget(input) {
  if (input.reportedUserId) return String(input.reportedUserId);
  const profile = await MatrimonialProfile.findOne({ publicProfileId: input.publicProfileId })
    .select('userId')
    .lean();
  if (!profile) throw new NotFoundError('The requested resource does not exist.');
  return String(profile.userId);
}

module.exports = {
  create,
  listOwn,
  notificationsAllowed,
  resolveTarget,
  clampLimit
};
