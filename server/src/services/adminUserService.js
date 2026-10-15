'use strict';

/**
 * Admin user service (spec §28, §30, §51, §98, §112; step 16 task 5).
 *
 * The back-office view of an account. Three rules shape every function here:
 *
 *   - **Safe projection by construction.** Every read names the fields it
 *     returns. `passwordHash` is `select: false` on the model *and* absent
 *     from these projections *and* stripped by the base plugin's internal
 *     transform — three independent layers, because an admin export is the
 *     most likely place a credential leak becomes a breach (spec §30, §51;
 *     gate G3.2). Identifiers are masked in list results: support staff need
 *     to *find* an account, not to collect its contact details.
 *   - **Status changes take effect through the existing gates.** Suspending
 *     sets `users.status`; step 04's `requireAuth` rejects any non-active
 *     account on the very next request, and step 09's discover filter reads
 *     `profile.status` — so this module writes the flags and the already
 *     built gates do the enforcing (task 5, gate G2.3). Sessions are revoked
 *     too, so a stolen access token dies with the suspension rather than
 *     waiting out its TTL.
 *   - **Deactivation is soft** (spec §98): the account status becomes
 *     `deleted` and its profile is soft-deleted through the profile service's
 *     own strategy. Nothing is removed from the database, so references in
 *     connections, reports and audit rows all stay resolvable.
 */

const mongoose = require('mongoose');
const User = require('../models/User');
const Session = require('../models/Session');
const MatrimonialProfile = require('../models/MatrimonialProfile');
const auditService = require('./auditService');
const { ADMIN_ACTIONS } = require('../constants/adminActions');
const { ROLES, STATUSES, STATUS_VALUES } = require('../constants/auth');
const { PROFILE_STATUS } = require('../constants/profile');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/AppError');
const { isValidObjectId } = require('../utils/objectId');
const { logger } = require('../middleware/requestLogger');

/** Escape a user string so it can only ever be a literal prefix. */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Hard cap on a search term, independent of the configured minimum. */
const SEARCH_MAX_LEN = 64;

/**
 * The fields an admin list may ever see (spec §30, §51, §112).
 *
 * Deliberately explicit rather than a `$ne` blacklist: a new sensitive column
 * added to `users` later is invisible here until someone consciously adds it,
 * which is the direction of safety.
 */
const ADMIN_USER_PROJECTION = Object.freeze({
  _id: 1,
  email: 1,
  phone: 1,
  role: 1,
  status: 1,
  profileCreated: 1,
  onboardingCompleted: 1,
  lastLoginAt: 1,
  createdAt: 1,
  updatedAt: 1
});

/** Mask an identifier for list views: `ra***@example.com`, `+91*****8901`. */
function maskIdentifier(value) {
  if (!value || typeof value !== 'string') return null;
  const at = value.indexOf('@');
  if (at > 0) {
    const local = value.slice(0, at);
    return `${local.slice(0, 2)}***${value.slice(at)}`;
  }
  const visible = value.slice(-4);
  return `${'*'.repeat(Math.max(value.length - 4, 2))}${visible}`;
}

/** One row of the admin user list — masked, never raw credentials. */
function serializeListRow(doc) {
  return {
    id: String(doc._id),
    email: maskIdentifier(doc.email),
    phone: maskIdentifier(doc.phone),
    role: doc.role,
    status: doc.status,
    profileCreated: doc.profileCreated,
    onboardingCompleted: doc.onboardingCompleted,
    lastLoginAt: doc.lastLoginAt || null,
    createdAt: doc.createdAt
  };
}

/**
 * Search accounts (task 5, spec §28 "View users / Search users").
 *
 * The term matches an email prefix or a phone suffix — both anchored, both
 * served by the partial unique indexes on `users` (spec §105), so a search is
 * an IXSCAN rather than a collection scan (gate G4.1). Filters are
 * allowlisted: `role` and `status` are enum-checked by the validator, and the
 * filter object is built here field by field, never from `req.query`
 * wholesale (spec §35).
 *
 * @param {{query?: string, role?: string, status?: string, limit?: number, cursor?: string}} params
 * @returns {Promise<{items: object[], nextCursor: string|null}>}
 */
async function search(params = {}) {
  const filter = {};

  const term = typeof params.query === 'string' ? params.query.trim() : '';
  if (term) {
    if (term.length > SEARCH_MAX_LEN) {
      throw new BadRequestError('Invalid request.', {
        details: { query: `Search text must be at most ${SEARCH_MAX_LEN} characters.` }
      });
    }
    const escaped = escapeRegex(term.toLowerCase());
    filter.$or = [{ email: { $regex: `^${escaped}` } }, { phone: { $regex: `${escaped}$` } }];
  }
  if (params.role) filter.role = params.role;
  if (params.status) filter.status = params.status;

  const limit = Number.isInteger(Number(params.limit)) && Number(params.limit) > 0
    ? Math.min(Number(params.limit), 100)
    : 20;
  if (params.cursor) {
    if (!isValidObjectId(params.cursor)) {
      throw new BadRequestError('Invalid request.', { details: { cursor: 'Not a valid identifier.' } });
    }
    filter._id = { $lt: params.cursor };
  }

  const rows = await User.find(filter)
    .select(ADMIN_USER_PROJECTION)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map(serializeListRow),
    nextCursor: hasMore && last ? String(last._id) : null
  };
}

/**
 * One account with its profile summary (task 5).
 *
 * The profile part is the *admin* projection — status and completion, never
 * the horoscope's restricted birth data (spec §26, §30): an admin moderating
 * an account does not need its member's birth time.
 *
 * @param {string} userId
 */
async function get(userId) {
  const user = await findOrFail(userId);
  const profile = await MatrimonialProfile.findOne({ userId: user._id })
    .select('publicProfileId basic.firstName basic.gender basic.dateOfBirth profile.status profile.completionPercentage profile.hasPrimaryPhoto createdAt')
    .lean();

  return {
    user: {
      id: String(user._id),
      email: user.email || null,
      phone: user.phone || null,
      role: user.role,
      status: user.status,
      profileCreated: user.profileCreated,
      onboardingCompleted: user.onboardingCompleted,
      lastLoginAt: user.lastLoginAt || null,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    },
    profile: profile
      ? {
          // The internal id is what `PATCH /admin/profiles/:profileId/status`
          // addresses; `publicProfileId` is the member-facing one (spec §113).
          id: String(profile._id),
          publicProfileId: profile.publicProfileId,
          firstName: profile.basic?.firstName || null,
          gender: profile.basic?.gender || null,
          dateOfBirth: profile.basic?.dateOfBirth || null,
          status: profile.profile?.status || null,
          completionPercentage: profile.profile?.completionPercentage ?? 0,
          hasPrimaryPhoto: profile.profile?.hasPrimaryPhoto ?? false,
          createdAt: profile.createdAt
        }
      : null
  };
}

/** Load a user or 404 — the same indistinguishable answer a non-existent id gets (spec §44). */
async function findOrFail(userId) {
  if (!isValidObjectId(userId)) throw new NotFoundError('The requested resource does not exist.');
  const user = await User.findById(userId).lean();
  if (!user) throw new NotFoundError('The requested resource does not exist.');
  return user;
}

/**
 * Kill every live session for an account (task 5).
 *
 * Step 04's status gate already rejects a suspended account with a 403 even
 * while its access token is unexpired; revoking the sessions additionally
 * kills the refresh path, so re-authentication cannot resurrect the account
 * and a stolen refresh token dies with the suspension.
 *
 * @param {string} userId
 * @returns {Promise<number>} sessions revoked
 */
async function revokeSessions(userId) {
  const result = await Session.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
  return result.modifiedCount;
}

/**
 * Suspend an account (task 5, spec §28).
 *
 * Effect, all through gates that already exist: `users.status = suspended`
 * makes `requireAuth` answer 403 on every protected route from the next
 * request (step 04), the profile is marked `suspended` so Discover stops
 * returning it (step 09 filters `profile.status`), and live sessions are
 * revoked. Idempotent on the status itself but audited every time — a
 * moderator re-suspending is an event worth recording.
 *
 * @param {string} actorUserId the admin performing the action
 * @param {string} userId the account to suspend
 * @param {string} [reason] short, non-sensitive justification (audited)
 */
async function suspend(actorUserId, userId, reason) {
  const user = await findOrFail(userId);
  if (user.status === STATUSES.SUSPENDED) {
    throw new ConflictError('This account is already suspended.');
  }
  if (user.status === STATUSES.DELETED) {
    throw new ConflictError('This account is deactivated.');
  }

  await User.updateOne({ _id: user._id }, { $set: { status: STATUSES.SUSPENDED } });
  const profile = await MatrimonialProfile.findOneAndUpdate(
    { userId: user._id, 'profile.status': PROFILE_STATUS.ACTIVE },
    { $set: { 'profile.status': PROFILE_STATUS.SUSPENDED } }
  );
  const revoked = await revokeSessions(user._id);

  await auditService.log({
    actorUserId,
    action: ADMIN_ACTIONS.SUSPENDED_USER,
    targetType: 'user',
    targetId: user._id,
    metadata: {
      previousStatus: user.status,
      profileSuspended: Boolean(profile),
      sessionsRevoked: revoked,
      ...(reason ? { reason } : {})
    }
  });

  return { userId: String(user._id), status: STATUSES.SUSPENDED, sessionsRevoked: revoked };
}

/**
 * Reactivate a suspended account (task 5).
 *
 * Returns the account to `active` and its profile to `active` **only if the
 * profile is currently `suspended`** — a profile an admin separately hid or
 * deactivated keeps that state, because suspension and moderation are
 * independent reasons for a profile to be invisible.
 *
 * @param {string} actorUserId
 * @param {string} userId
 */
async function reactivate(actorUserId, userId) {
  const user = await findOrFail(userId);
  if (user.status === STATUSES.ACTIVE) {
    throw new ConflictError('This account is already active.');
  }
  if (user.status === STATUSES.DELETED) {
    throw new ConflictError('A deactivated account cannot be reactivated; restore it from a backup.');
  }

  await User.updateOne({ _id: user._id }, { $set: { status: STATUSES.ACTIVE } });
  const profile = await MatrimonialProfile.findOneAndUpdate(
    { userId: user._id, 'profile.status': PROFILE_STATUS.SUSPENDED },
    { $set: { 'profile.status': PROFILE_STATUS.ACTIVE } }
  );

  await auditService.log({
    actorUserId,
    action: ADMIN_ACTIONS.REACTIVATED_USER,
    targetType: 'user',
    targetId: user._id,
    metadata: { previousStatus: user.status, profileRestored: Boolean(profile) }
  });

  return { userId: String(user._id), status: STATUSES.ACTIVE };
}

/**
 * Deactivate an account (task 5, spec §98 soft deletion).
 *
 * `users.status` becomes `deleted` — a tombstone, not a removal: connections,
 * reports, blocks and audit rows that reference the account all stay
 * resolvable. The profile follows the same soft-delete strategy the member
 * profile service uses (`profile.status = deleted`), so Discover stops
 * returning it and every foreign key keeps resolving. The identifier stays on
 * the row so a re-registration attempt is refused as a duplicate rather than
 * silently creating a second identity (spec §5).
 *
 * @param {string} actorUserId
 * @param {string} userId
 * @param {string} [reason]
 */
async function deactivate(actorUserId, userId, reason) {
  const user = await findOrFail(userId);
  if (user.status === STATUSES.DELETED) {
    throw new ConflictError('This account is already deactivated.');
  }

  await User.updateOne({ _id: user._id }, { $set: { status: STATUSES.DELETED } });
  const profile = await MatrimonialProfile.findOneAndUpdate(
    { userId: user._id },
    { $set: { 'profile.status': PROFILE_STATUS.DELETED } }
  );
  const revoked = await revokeSessions(user._id);

  logger.warn({ userId: String(user._id), actorUserId }, 'admin deactivated an account');
  await auditService.log({
    actorUserId,
    action: ADMIN_ACTIONS.DEACTIVATED_USER,
    targetType: 'user',
    targetId: user._id,
    metadata: {
      previousStatus: user.status,
      profileDeactivated: Boolean(profile),
      sessionsRevoked: revoked,
      ...(reason ? { reason } : {})
    }
  });

  return { userId: String(user._id), status: STATUSES.DELETED, sessionsRevoked: revoked };
}

/**
 * Set a profile's status directly (task 5, spec §58, §98).
 *
 * Separate from the account status on purpose: moderation acts on the *profile*
 * (hide it from discovery, deactivate it) without suspending the account — the
 * member keeps their login, their messages and their history, and a moderator
 * can restore visibility without an account-level event. Only the three
 * moderation statuses are writable; `suspended` is written by account-level
 * suspension and `draft` is the member's own pre-publish state, so neither is
 * reachable from here (spec §58).
 *
 * @param {string} actorUserId
 * @param {string} profileId the profile's internal id
 * @param {{status: string, reason?: string}} input validated body
 * @returns {Promise<{profileId: string, status: string}>}
 */
async function setProfileStatus(actorUserId, profileId, input) {
  if (!isValidObjectId(profileId)) throw new NotFoundError('The requested resource does not exist.');
  const profile = await MatrimonialProfile.findById(profileId)
    .select('_id userId publicProfileId profile.status')
    .lean();
  if (!profile) throw new NotFoundError('The requested resource does not exist.');

  const current = profile.profile?.status;
  if (current === input.status) {
    throw new ConflictError(`This profile is already "${input.status}".`);
  }

  await MatrimonialProfile.updateOne(
    { _id: profile._id },
    { $set: { 'profile.status': input.status } }
  );

  const action =
    input.status === PROFILE_STATUS.DELETED
      ? ADMIN_ACTIONS.DEACTIVATED_PROFILE
      : input.status === PROFILE_STATUS.HIDDEN
        ? ADMIN_ACTIONS.HIDDEN_PROFILE
        : ADMIN_ACTIONS.RESTORED_PROFILE;

  await auditService.log({
    actorUserId,
    action,
    targetType: 'profile',
    targetId: profile._id,
    metadata: {
      ownerUserId: String(profile.userId),
      publicProfileId: profile.publicProfileId,
      from: current,
      to: input.status,
      ...(input.reason ? { reason: input.reason } : {})
    }
  });

  return { profileId: String(profile._id), status: input.status };
}

/**
 * Change an account's role (task 12, spec §31).
 *
 * **There is no request path to this function.** It exists so
 * `scripts/grant-admin.js` and the tests share one implementation; the only
 * HTTP surface for roles is... none. A role is promoted from the CLI or by
 * another admin through a future, explicitly audited route — never from a
 * body the client controls (spec §31, §44; gate G3.1).
 *
 * @param {string} actorUserId the operator on whose behalf the change is made
 * @param {string} userId the account to change
 * @param {string} role one of `user` / `moderator` / `admin`
 * @returns {Promise<{userId: string, role: string, previousRole: string, changed: boolean}>}
 */
async function updateRole(actorUserId, userId, role) {
  if (!Object.values(ROLES).includes(role)) {
    throw new BadRequestError('Invalid request.', { details: { role: 'Unknown role.' } });
  }
  const user = await findOrFail(userId);
  const previousRole = user.role;
  const changed = previousRole !== role;

  if (changed) {
    await User.updateOne({ _id: user._id }, { $set: { role } });
    await auditService.log({
      actorUserId,
      action: ADMIN_ACTIONS.ROLE_UPDATED,
      targetType: 'role',
      targetId: user._id,
      metadata: { previousRole, newRole: role }
    });
  }

  return { userId: String(user._id), role, previousRole, changed };
}

module.exports = {
  search,
  get,
  suspend,
  reactivate,
  deactivate,
  setProfileStatus,
  updateRole,
  revokeSessions,
  maskIdentifier,
  serializeListRow,
  ADMIN_USER_PROJECTION,
  SEARCH_MAX_LEN,
  STATUS_VALUES
};
