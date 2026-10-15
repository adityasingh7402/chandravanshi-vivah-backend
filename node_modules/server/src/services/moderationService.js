'use strict';

/**
 * Moderation service (spec §17, §23, §101, §112; step 16 tasks 6, 7).
 *
 * Step 12 opened reports and left every transition here; this module owns the
 * review half of the safety surface plus photo moderation:
 *
 *   - **Report transitions follow one map** (`REPORT_TRANSITIONS`): `open →
 *     reviewing → resolved | dismissed`, with `open` allowed to go straight
 *     to a terminal state. Terminal states transition nowhere — reopening
 *     would discard the reviewer record, and a case with new evidence after
 *     closure is a *new* report (step 12's duplicate rule already scopes
 *     itself to open/reviewing). Every transition stamps `reviewedBy` /
 *     `reviewedBy` and writes its own audit action (spec §29, §101).
 *   - **The queue is admin-only and shows the reporter.** `reporterId` and
 *     `reviewedBy` are `select: false` on the model; the queue reads them
 *     with an explicit `+select`, which is the one place they may surface
 *     (spec §112). A user's own report list (step 12) never sees them.
 *   - **Photo moderation is a discovery gate.** A photo starts `pending` and
 *     becomes discoverable only on approval (spec §17, §101); rejecting an
 *     already-approved photo must also flip the profile's denormalised
 *     `hasPrimaryPhoto` flag, or Discover would keep showing a card image
 *     that moderation just removed. `profileScoreService.syncDiscoveryPhotoFlag`
 *     is that seam, and this module calls it after every decision (task 7).
 *
 * Both surfaces audit each decision with the actor and the target (gate G3.3).
 */

const Photo = require('../models/Photo');
const Report = require('../models/Report');
const MatrimonialProfile = require('../models/MatrimonialProfile');
const auditService = require('./auditService');
const profileScoreService = require('./profileScoreService');
const config = require('../config/env');
const { ADMIN_ACTIONS, REPORT_TRANSITIONS, REPORT_TRANSITION_ACTIONS } = require('../constants/adminActions');
const { REPORT_STATUS, REPORT_STATUSES } = require('../constants/safety');
const { MODERATION_STATUS } = require('../constants/photo');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/AppError');
const { isValidObjectId } = require('../utils/objectId');

/** Clamp a requested page size into the configured range (spec §80). */
function clampLimit(limit, bounds) {
  const requested = Number(limit);
  if (!Number.isInteger(requested) || requested < 1) return bounds.defaultLimit;
  return Math.min(requested, bounds.maxLimit);
}

/**
 * The moderation queue (task 6, spec §101).
 *
 * Ordered by the `{ status, createdAt }` index (gate G4.2): `status` first
 * when supplied, newest first within it, so a moderator works the queue in a
 * stable order. The reporter is read with an explicit `+select` — the only
 * place the field ever leaves the database (spec §112).
 *
 * @param {{status?: string, limit?: number, cursor?: string}} query
 * @returns {Promise<{items: object[], nextCursor: string|null}>}
 */
async function listReports(query = {}) {
  const filter = {};
  if (query.status) {
    if (!REPORT_STATUSES.includes(query.status)) {
      throw new BadRequestError('Invalid request.', { details: { status: 'Unknown report status.' } });
    }
    filter.status = query.status;
  }
  if (query.cursor) {
    if (!isValidObjectId(query.cursor)) {
      throw new BadRequestError('Invalid request.', { details: { cursor: 'Not a valid identifier.' } });
    }
    filter._id = { $lt: query.cursor };
  }

  const limit = clampLimit(query.limit, config.safety.reports);
  const rows = await Report.find(filter)
    .select('+reporterId +reviewedBy')
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  // Resolve the reported accounts' public identity so the queue names people,
  // not raw ids — and a deleted profile resolves to null instead of dropping
  // the case (the queue must stay complete).
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
      // Admin-only fields, read via the explicit `+select` above (spec §112).
      reporterId: row.reporterId ? String(row.reporterId) : null,
      reviewedBy: row.reviewedBy ? String(row.reviewedBy) : null,
      reviewedAt: row.reviewedAt ?? null,
      reported: {
        userId: String(row.reportedUserId),
        profileId: profile ? profile.publicProfileId : null,
        name: profile ? profile.basic?.firstName || null : null,
        profileStatus: profile ? profile.profile?.status || null : null
      },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  });

  return { items, nextCursor: hasMore && last ? String(last._id) : null };
}

/**
 * Move a report through the queue (task 6, spec §101).
 *
 * The transition map is the whole rule: an illegal target (including
 * reopening a closed case, or re-resolving a resolved one) is a 409, and the
 * request never touches the database. Each legal move stamps the reviewer and
 * writes its own audit action.
 *
 * @param {string} actorUserId the moderator performing the action
 * @param {string} reportId
 * @param {{status: string}} input validated body
 * @returns {Promise<{report: object}>} the updated row (lean, with reviewer fields)
 */
async function transitionReport(actorUserId, reportId, input) {
  if (!isValidObjectId(reportId)) throw new NotFoundError('The requested resource does not exist.');
  const report = await Report.findById(reportId).select('+reporterId').lean();
  if (!report) throw new NotFoundError('The requested resource does not exist.');

  const allowed = REPORT_TRANSITIONS[report.status] || [];
  if (!allowed.includes(input.status)) {
    throw new ConflictError(
      `A report that is "${report.status}" cannot become "${input.status}".`,
      {
        details: {
          status: `Allowed next: ${allowed.length ? allowed.join(', ') : 'none (the case is closed)'}`
        }
      }
    );
  }

  const updated = await Report.findOneAndUpdate(
    { _id: report._id, status: report.status },
    { $set: { status: input.status, reviewedBy: actorUserId, reviewedAt: new Date() } },
    { new: true }
  )
    .select('+reviewedBy')
    .lean();

  await auditService.log({
    actorUserId,
    action: REPORT_TRANSITION_ACTIONS[input.status],
    targetType: 'report',
    targetId: report._id,
    metadata: {
      from: report.status,
      to: input.status,
      category: report.category,
      reportedUserId: String(report.reportedUserId)
    }
  });

  return { report: serializeReport(updated) };
}

/** Admin queue shape of one report. */
function serializeReport(row) {
  return {
    id: String(row._id),
    category: row.category,
    description: row.description ?? null,
    evidence: row.evidence ?? [],
    status: row.status,
    reporterId: row.reporterId ? String(row.reporterId) : null,
    reportedUserId: String(row.reportedUserId),
    reviewedBy: row.reviewedBy ? String(row.reviewedBy) : null,
    reviewedAt: row.reviewedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

/**
 * The photo moderation queue (task 7, spec §101).
 *
 * Pending photos with their owner's public identity, oldest first — a queue,
 * not a gallery. Bounded like every other list (spec §80).
 *
 * @param {{limit?: number, cursor?: string}} query
 * @returns {Promise<{items: object[], nextCursor: string|null}>}
 */
async function listPendingPhotos(query = {}) {
  const filter = { moderationStatus: MODERATION_STATUS.PENDING };
  if (query.cursor) {
    if (!isValidObjectId(query.cursor)) {
      throw new BadRequestError('Invalid request.', { details: { cursor: 'Not a valid identifier.' } });
    }
    filter._id = { $gt: query.cursor };
  }

  // The photo queue is its own bounded list; its own small bounds rather than
  // the report ones, since a page of images costs more than a page of rows.
  const limit = clampLimit(query.limit, { defaultLimit: 20, maxLimit: 100 });
  const rows = await Photo.find(filter).sort({ _id: 1 }).limit(limit + 1).lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  const profiles = await MatrimonialProfile.find({ userId: { $in: page.map((row) => row.userId) } })
    .select('userId publicProfileId basic.firstName')
    .lean();
  const byUser = new Map(profiles.map((profile) => [String(profile.userId), profile]));

  return {
    items: page.map((row) => {
      const profile = byUser.get(String(row.userId));
      return {
        id: String(row._id),
        publicId: row.publicId,
        type: row.type,
        isPrimary: row.isPrimary,
        moderationStatus: row.moderationStatus,
        owner: {
          userId: String(row.userId),
          profileId: profile ? profile.publicProfileId : null,
          name: profile ? profile.basic?.firstName || null : null
        },
        createdAt: row.createdAt
      };
    }),
    nextCursor: hasMore && last ? String(last._id) : null
  };
}

/**
 * Approve or reject one photo (task 7, spec §17, §101).
 *
 * The decision writes `moderationStatus` and then re-syncs the owner
 * profile's `hasPrimaryPhoto` flag — the denormalised signal Discover filters
 * on (spec §10, step 09). Approving a gallery photo changes nothing there;
 * rejecting an *approved primary* flips the flag to false, so the card image
 * disappears from discovery in the same request rather than at some later
 * write (gate G2.5).
 *
 * @param {string} actorUserId the moderator performing the action
 * @param {string} photoId
 * @param {{moderationStatus: string}} input validated body (`approved` | `rejected`)
 * @returns {Promise<{photo: object, discoverable: boolean}>}
 */
async function moderatePhoto(actorUserId, photoId, input) {
  if (!isValidObjectId(photoId)) throw new NotFoundError('The requested resource does not exist.');
  const photo = await Photo.findById(photoId).lean();
  if (!photo) throw new NotFoundError('The requested resource does not exist.');

  if (photo.moderationStatus === input.moderationStatus) {
    throw new ConflictError(`This photo is already "${input.moderationStatus}".`);
  }

  await Photo.updateOne({ _id: photo._id }, { $set: { moderationStatus: input.moderationStatus } });
  // The seam that keeps Discover honest: recompute the owner's denormalised
  // discovery flag after a decision that can change it (task 7, gate G2.5).
  const discoverable = await profileScoreService.syncDiscoveryPhotoFlag(String(photo.userId));

  await auditService.log({
    actorUserId,
    action:
      input.moderationStatus === MODERATION_STATUS.APPROVED
        ? ADMIN_ACTIONS.APPROVED_PHOTO
        : ADMIN_ACTIONS.REJECTED_PHOTO,
    targetType: 'photo',
    targetId: photo._id,
    metadata: {
      ownerUserId: String(photo.userId),
      from: photo.moderationStatus,
      to: input.moderationStatus,
      wasPrimary: Boolean(photo.isPrimary),
      ownerStillDiscoverable: discoverable
    }
  });

  return {
    photo: {
      id: String(photo._id),
      publicId: photo.publicId,
      type: photo.type,
      isPrimary: Boolean(photo.isPrimary),
      moderationStatus: input.moderationStatus
    },
    discoverable
  };
}

module.exports = {
  listReports,
  transitionReport,
  listPendingPhotos,
  moderatePhoto,
  clampLimit,
  REPORT_STATUS
};
