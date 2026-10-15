'use strict';

/**
 * Admin master-data service (spec §74, §75, §10, §102; decisions §14; step 16
 * task 8, 9).
 *
 * The back-office half of the master-data surface, layered on step 05's
 * read-only service. Four groups of behaviour:
 *
 *   - **Item management** — create, edit, deactivate, reorder. Deactivation
 *     is the only removal: `isActive: false` hides a value from new
 *     selections while every profile that already references it keeps a valid
 *     reference and a valid denormalised name (spec §74, §97; gate G2.6).
 *     There is no hard delete anywhere in this module (spec §98).
 *   - **Rename fan-out, inline and targeted** (decisions §14, task 9, gate
 *     G2.11/G4.4/G5.6). When a rename actually changes the name, the same
 *     operation updates the denormalised `*Name` copies in
 *     `matrimonial_profiles`, matched by the master-data **ID** —
 *     `career.occupationId == renamedId` sets `career.occupationName` — never
 *     a scan of every profile and never a background job. It runs on this
 *     rare admin write, so the read-path performance requirement (which is
 *     about repeated reads) is untouched. `MASTER_REFERENCES` in
 *     `profileService.js` is the single source of the id→nameField mapping,
 *     so a field added to the profile schema is fanned out here without a
 *     second list to keep in sync.
 *   - **User-contributed review** — verify / reject / merge (task 8, gates
 *     G2.12–G2.14). Verify promotes (`verifiedBy`/`verifiedAt`, source
 *     becomes `admin`), reject deactivates, and merge folds a duplicate or
 *     spelling variant into the survivor as a lower-cased `alias` before
 *     deactivating the merged row — so searching either spelling resolves to
 *     ONE selectable option (fields dictionary §4.4, gate G2.13).
 *   - **Request queue** — step 05's `masterDataRequestService` owns the
 *     pending-row transitions; this module is the route-facing wrapper that
 *     audits each decision.
 *
 * Every write here audits (spec §29, §101; gate G3.3).
 */

const mongoose = require('mongoose');
const { getMasterModel, buildMasterIdentity } = require('../models/masterData/MasterItem');
const { getMasterDescriptor, isMasterType } = require('../constants/masterData');
const { MASTER_REFERENCES } = require('./profileService');
const MatrimonialProfile = require('../models/MatrimonialProfile');
const masterDataService = require('./masterDataService');
const masterDataRequestService = require('./masterDataRequestService');
const auditService = require('./auditService');
const { ADMIN_ACTIONS } = require('../constants/adminActions');
const { maskIdentifier } = require('./adminUserService');
const User = require('../models/User');
const { normaliseName } = require('../utils/slug');
const { BadRequestError, ConflictError, NotFoundError } = require('../utils/AppError');
const { isValidObjectId } = require('../utils/objectId');

/** Resolve a known `:type`, or 404 (the allowlist rule, gate G3.1). */
function resolveType(type) {
  const descriptor = getMasterDescriptor(type);
  const model = descriptor ? getMasterModel(type) : null;
  if (!descriptor || !model) throw new NotFoundError('The requested resource does not exist.');
  return { descriptor, model };
}

/** Load one item of a known type, or 404. */
async function findItem(type, id) {
  const { descriptor, model } = resolveType(type);
  if (!isValidObjectId(id)) throw new NotFoundError('The requested resource does not exist.');
  const item = await model.findById(id).lean();
  if (!item) throw new NotFoundError('The requested resource does not exist.');
  return { descriptor, model, item };
}

/** True when the driver reports a duplicate-key violation. */
function isDuplicateKey(err) {
  return Boolean(err && (err.code === 11000 || err.code === 11001));
}

/**
 * Create an admin-tier master item (task 8, spec §74).
 *
 * `source` is stamped `admin` here, never accepted from the body (spec §35,
 * §75). Scope fields are validated against their own collections, so an
 * occupation can never be filed under a community and a Kahar clan can never
 * be attached to a Yadav gotra (spec §97).
 *
 * @param {string} actorUserId
 * @param {string} type a known master `:type`
 * @param {{name: string, category?: string|null, sortOrder?: number,
 *          communityId?: string, subCommunityId?: string, clanId?: string,
 *          degreeId?: string, countryId?: string, stateId?: string,
 *          districtId?: string}} input validated body
 * @returns {Promise<{item: object}>}
 */
async function createItem(actorUserId, type, input) {
  const { descriptor, model } = resolveType(type);

  const name = normaliseName(input.name);
  if (!name) throw new BadRequestError('Invalid request.', { details: { name: 'A name is required.' } });
  const identity = buildMasterIdentity(type, { name });
  if (!identity.slug) {
    throw new BadRequestError('Invalid request.', { details: { name: 'Enter a name containing letters or numbers.' } });
  }

  // Validate the scope parents that apply to this collection (spec §97).
  const scope = {};
  if (descriptor.scoped) {
    if (!input.communityId) {
      throw new BadRequestError('Invalid request.', {
        details: { communityId: `A community is required for a ${descriptor.label.toLowerCase()}.` }
      });
    }
    await masterDataService.assertIds('communities', [input.communityId]);
    scope.communityId = input.communityId;
    if (descriptor.filters.includes('clanId') && input.clanId) {
      await masterDataService.assertIds('clans', [input.clanId], { scope: { communityId: input.communityId } });
      scope.clanId = input.clanId;
    }
  }
  // Parent links for the cascading collections (spec §76).
  const parentTypes = {
    subCommunityId: 'communities',
    degreeId: 'degrees',
    countryId: 'countries',
    stateId: 'states',
    districtId: 'districts'
  };
  for (const [field, parentType] of Object.entries(parentTypes)) {
    if (input[field]) {
      await masterDataService.assertIds(parentType, [input[field]]);
      scope[field] = input[field];
    }
  }

  try {
    const created = await model.create({
      ...identity,
      ...scope,
      category: input.category ?? null,
      sortOrder: input.sortOrder ?? 0,
      // Server-stamped tier, never from a body (spec §75).
      source: 'admin',
      isActive: true
    });
    await auditService.log({
      actorUserId,
      action: ADMIN_ACTIONS.CREATED_MASTER_ITEM,
      targetType: 'master_item',
      targetId: created._id,
      metadata: { type, name: created.name, slug: created.slug }
    });
    return { item: created.toObject() };
  } catch (err) {
    if (isDuplicateKey(err)) {
      throw new ConflictError('An option with this name already exists in this scope.', {
        details: { name: 'Pick a different name, or merge into the existing option.' }
      });
    }
    throw err;
  }
}

/**
 * Edit a master item's display fields (task 8).
 *
 * A **name change** is the rename path: it additionally fans the new name out
 * to every denormalised copy in `matrimonial_profiles`, targeted by this
 * item's id (decisions §14; see {@link fanOutRename}), and audits
 * `admin_renamed_master_item` rather than the generic update. Nothing else
 * about the row changes, and no read path ever triggers the fan-out.
 *
 * @param {string} actorUserId
 * @param {string} type
 * @param {string} id
 * @param {{name?: string, category?: string|null, sortOrder?: number}} input
 * @returns {Promise<{item: object, renamed: boolean, profilesUpdated: number}>}
 */
async function updateItem(actorUserId, type, id, input) {
  const { descriptor, model, item } = await findItem(type, id);

  const patch = {};
  let newName = null;
  if (input.name !== undefined) {
    newName = normaliseName(input.name);
    if (!newName) throw new BadRequestError('Invalid request.', { details: { name: 'A name is required.' } });
    const identity = buildMasterIdentity(type, { name: newName });
    if (!identity.slug) {
      throw new BadRequestError('Invalid request.', {
        details: { name: 'Enter a name containing letters or numbers.' }
      });
    }
    patch.name = identity.name;
    // `nameLower` drives the anchored search (spec §82); it must mirror `name`.
    patch.nameLower = identity.nameLower;
  }
  if (input.category !== undefined) patch.category = input.category;
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;

  if (Object.keys(patch).length === 0) {
    throw new BadRequestError('Invalid request.', { details: { _: 'Nothing to update.' } });
  }

  const isRename = newName !== null && newName !== item.name;

  try {
    await model.updateOne({ _id: item._id }, { $set: patch });
  } catch (err) {
    if (isDuplicateKey(err)) {
      throw new ConflictError('An option with this name already exists in this scope.', {
        details: { name: 'Pick a different name, or merge into the existing option.' }
      });
    }
    throw err;
  }

  // Inline fan-out, only on an actual rename, only by id (decisions §14).
  let profilesUpdated = 0;
  if (isRename) {
    profilesUpdated = await fanOutRename(type, item._id, newName);
    await auditService.log({
      actorUserId,
      action: ADMIN_ACTIONS.RENAMED_MASTER_ITEM,
      targetType: 'master_item',
      targetId: item._id,
      metadata: { type, from: item.name, to: newName, profilesUpdated }
    });
  } else {
    await auditService.log({
      actorUserId,
      action: ADMIN_ACTIONS.UPDATED_MASTER_ITEM,
      targetType: 'master_item',
      targetId: item._id,
      metadata: { type, fields: Object.keys(patch) }
    });
  }

  const updated = await model.findById(item._id).lean();
  return { item: updated, renamed: isRename, profilesUpdated };
}

/**
 * Push a new display name into every denormalised copy in profiles
 * (decisions §14, task 9).
 *
 * `MASTER_REFERENCES` lists each profile field that carries a master id and —
 * where the schema keeps one — the denormalised name beside it. For the
 * renamed collection, each matching reference is updated with a single
 * `updateMany` keyed on the **id**: `career.occupationId == renamedId` sets
 * `career.occupationName`, and the same applies to `community.clanName` and
 * `community.aaspadName` (and every other pair). Targeted by id, so the
 * affected count is exact and unrelated profiles are untouched (gate G2.11);
 * inline in this admin write, so there is no job to run, retry or reconcile
 * (gate G4.4).
 *
 * @param {string} type the renamed master `:type`
 * @param {import('mongoose').Types.ObjectId} itemId
 * @param {string} newName the new display name
 * @returns {Promise<number>} total profile rows updated
 */
async function fanOutRename(type, itemId, newName) {
  const pairs = MASTER_REFERENCES.filter((ref) => ref.type === type && ref.nameField);
  let total = 0;
  for (const ref of pairs) {
    const result = await MatrimonialProfile.updateMany(
      { [ref.field]: itemId },
      { $set: { [ref.nameField]: newName } }
    );
    total += result.modifiedCount;
  }
  return total;
}

/**
 * Deactivate a master item (task 8, spec §74, §98).
 *
 * Soft by design: `isActive: false` removes the value from new selections
 * (every list filters `isActive`, and `validateIds` refuses inactive ids for
 * a new profile), while profiles already referencing it keep a valid id and a
 * valid denormalised name. There is no hard delete.
 *
 * @param {string} actorUserId
 * @param {string} type
 * @param {string} id
 * @returns {Promise<{item: object}>}
 */
async function deactivateItem(actorUserId, type, id) {
  const { model, item } = await findItem(type, id);
  if (item.isActive === false) {
    throw new ConflictError('This option is already deactivated.');
  }
  await model.updateOne({ _id: item._id }, { $set: { isActive: false } });
  await auditService.log({
    actorUserId,
    action: ADMIN_ACTIONS.DEACTIVATED_MASTER_ITEM,
    targetType: 'master_item',
    targetId: item._id,
    metadata: { type, name: item.name }
  });
  const updated = await model.findById(item._id).lean();
  return { item: updated };
}

/**
 * Reorder one item within its collection (task 8, spec §73 ordering).
 *
 * `sortOrder` is the curated ordering every list sorts by; reordering writes
 * only that field and never touches names, scope or tier.
 *
 * @param {string} actorUserId
 * @param {string} type
 * @param {string} id
 * @param {number} sortOrder
 */
async function reorderItem(actorUserId, type, id, sortOrder) {
  const { model, item } = await findItem(type, id);
  await model.updateOne({ _id: item._id }, { $set: { sortOrder } });
  await auditService.log({
    actorUserId,
    action: ADMIN_ACTIONS.REORDERED_MASTER_ITEM,
    targetType: 'master_item',
    targetId: item._id,
    metadata: { type, from: item.sortOrder, to: sortOrder }
  });
  const updated = await model.findById(item._id).lean();
  return { item: updated };
}

/**
 * Verify (promote) a user-contributed option **without** a request row
 * (task 8, gate G2.12).
 *
 * Step 05's `verify()` works through a `master_data_requests` row; this
 * variant targets the master row directly, for the admin surface that reviews
 * the option itself. Same effect: `verifiedBy`/`verifiedAt` are set, the
 * source becomes `admin` so it stops rendering as member-added, and existing
 * profile references are untouched.
 *
 * @param {string} actorUserId
 * @param {string} type only a scoped (community-context) collection has tiers
 * @param {string} id
 * @returns {Promise<{item: object}>}
 */
async function verifyOption(actorUserId, type, id) {
  const { descriptor, model, item } = await findItem(type, id);
  if (!descriptor.scoped) {
    throw new BadRequestError('Invalid request.', { details: { type: 'This collection has no review tiers.' } });
  }
  if (item.verifiedAt) {
    throw new ConflictError('This option is already verified.');
  }
  if (item.source !== 'user') {
    throw new ConflictError('Only a user-contributed option can be verified.');
  }

  await model.updateOne(
    { _id: item._id },
    { $set: { source: 'admin', verifiedBy: actorUserId, verifiedAt: new Date() } }
  );
  await auditService.log({
    actorUserId,
    action: ADMIN_ACTIONS.VERIFIED_MASTER_ITEM,
    targetType: 'master_item',
    targetId: item._id,
    metadata: { type, name: item.name, submittedBy: item.submittedBy ? String(item.submittedBy) : null }
  });
  const updated = await model.findById(item._id).lean();
  return { item: updated };
}

/**
 * Reject a user-contributed option by deactivating it (task 8, spec §74,
 * gate G2.12).
 *
 * Deactivation, not deletion: profiles that already reference the value keep
 * a valid id and name, and it disappears from new selections because every
 * list filters `isActive`.
 *
 * @param {string} actorUserId
 * @param {string} type
 * @param {string} id
 * @returns {Promise<{item: object}>}
 */
async function rejectOption(actorUserId, type, id) {
  const { descriptor, model, item } = await findItem(type, id);
  if (!descriptor.scoped) {
    throw new BadRequestError('Invalid request.', { details: { type: 'This collection has no review tiers.' } });
  }
  if (item.isActive === false) {
    throw new ConflictError('This option is already deactivated.');
  }

  await model.updateOne({ _id: item._id }, { $set: { isActive: false } });
  await auditService.log({
    actorUserId,
    action: ADMIN_ACTIONS.REJECTED_MASTER_ITEM,
    targetType: 'master_item',
    targetId: item._id,
    metadata: { type, name: item.name, submittedBy: item.submittedBy ? String(item.submittedBy) : null }
  });
  const updated = await model.findById(item._id).lean();
  return { item: updated };
}

/**
 * Merge a duplicate or spelling variant into the surviving row (task 8, gate
 * G2.13).
 *
 * The duplicate's name is folded into the survivor's `aliases` (lower-cased,
 * the shape step 05's search resolves), and the duplicate is deactivated.
 * Both rows must live in the same scope — cross-community merging would
 * silently rewrite a value for members of a different community (spec §97,
 * decisions §3). A self-merge or a merge into a deactivated row is refused.
 *
 * @param {string} actorUserId
 * @param {string} type
 * @param {string} id the duplicate to fold in
 * @param {{intoId: string}} input validated body — the survivor
 * @returns {Promise<{survivor: object, merged: object, aliases: string[]}>}
 */
async function mergeOption(actorUserId, type, id, input) {
  const { descriptor, model, item: duplicate } = await findItem(type, id);
  if (!descriptor.scoped) {
    throw new BadRequestError('Invalid request.', { details: { type: 'This collection has no aliases.' } });
  }
  if (!isValidObjectId(input.intoId)) {
    throw new BadRequestError('Invalid request.', { details: { intoId: 'Not a valid identifier.' } });
  }
  if (String(input.intoId) === String(id)) {
    throw new BadRequestError('Invalid request.', { details: { intoId: 'An option cannot be merged into itself.' } });
  }
  const survivor = await model.findById(input.intoId).lean();
  if (!survivor) throw new NotFoundError('The requested resource does not exist.');
  if (survivor.isActive === false) {
    throw new ConflictError('The surviving option is deactivated; reactivate it before merging.');
  }

  // Same scope, always: a merge never crosses a community boundary (spec §97).
  for (const field of ['communityId', 'subCommunityId', 'clanId']) {
    if (String(duplicate[field] || '') !== String(survivor[field] || '')) {
      throw new BadRequestError('Invalid request.', {
        details: { intoId: `Both options must belong to the same ${field.replace('Id', '')}.` }
      });
    }
  }

  const alias = normaliseName(duplicate.name).toLowerCase();
  const aliases = [...new Set([...(survivor.aliases || []), alias])].filter(
    (entry) => entry && entry !== normaliseName(survivor.name).toLowerCase()
  );

  await model.updateOne({ _id: survivor._id }, { $set: { aliases } });
  await model.updateOne({ _id: duplicate._id }, { $set: { isActive: false } });

  await auditService.log({
    actorUserId,
    action: ADMIN_ACTIONS.MERGED_MASTER_ITEM,
    targetType: 'master_item',
    targetId: duplicate._id,
    metadata: {
      type,
      mergedName: duplicate.name,
      intoId: String(survivor._id),
      intoName: survivor.name
    }
  });

  const updatedSurvivor = await model.findById(survivor._id).lean();
  const updatedDuplicate = await model.findById(duplicate._id).lean();
  return { survivor: updatedSurvivor, merged: updatedDuplicate, aliases };
}

/**
 * The pending Gotra/Surname (and other community-context) request queue
 * (task 8, spec §75, gate G2.14).
 *
 * Wraps step 05's `listPending`, and joins the contributing user so
 * provenance is visible in the queue — the review surface is the one place a
 * `submittedBy`/`userId` may surface (spec §112).
 *
 * @param {{type?: string, limit?: number, page?: number}} query
 */
async function listRequests(query = {}) {
  const { items, total, page, limit } = await masterDataRequestService.listPending(query);
  const userIds = items.map((row) => row.userId).filter(Boolean);
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } }).select('email phone').lean()
    : [];
  const byId = new Map(users.map((user) => [String(user._id), user]));

  return {
    items: items.map((row) => {
      const user = byId.get(String(row.userId));
      return {
        id: String(row._id),
        type: row.type,
        requestedName: row.requestedName,
        status: row.status,
        communityId: row.communityId ? String(row.communityId) : null,
        clanId: row.clanId ? String(row.clanId) : null,
        // The contributing account, masked — provenance for the reviewer, not
        // a contact list (spec §112, gate G2.14).
        submittedBy: row.userId
          ? {
              userId: String(row.userId),
              email: user ? maskIdentifier(user.email) : null,
              phone: user ? maskIdentifier(user.phone) : null
            }
          : null,
        createdAt: row.createdAt
      };
    }),
    total,
    page,
    limit
  };
}

/**
 * Approve a pending request — the user-contributed value becomes official
 * (task 8, spec §75, gate G2.7).
 *
 * Wraps step 05's `verify()`, then audits with the type-appropriate action:
 * the documented `admin_approved_gotra` / `admin_approved_surname` for those
 * two categories, the generic `admin_verified_master_item` for the rest
 * (sub-community, clan, aaspad).
 *
 * @param {string} actorUserId
 * @param {string} requestId
 * @param {{note?: string|null}} [input]
 */
async function approveRequest(actorUserId, requestId, input = {}) {
  const { request } = await masterDataRequestService.verify({
    requestId,
    reviewedBy: actorUserId,
    note: input.note ?? null
  });
  const action =
    request.type === 'gotra'
      ? ADMIN_ACTIONS.APPROVED_GOTRA
      : request.type === 'surname'
        ? ADMIN_ACTIONS.APPROVED_SURNAME
        : ADMIN_ACTIONS.VERIFIED_MASTER_ITEM;
  await auditService.log({
    actorUserId,
    action,
    targetType: 'master_data_request',
    targetId: request._id,
    metadata: { type: request.type, requestedName: request.requestedName, masterItemId: String(request.masterItemId) }
  });
  return { request };
}

/**
 * Reject a pending request — the user-contributed value is deactivated, and
 * existing profile references stay valid (task 8, spec §74, §75, gate G2.7).
 *
 * @param {string} actorUserId
 * @param {string} requestId
 * @param {{note?: string|null}} [input]
 */
async function rejectRequest(actorUserId, requestId, input = {}) {
  const { request } = await masterDataRequestService.reject({
    requestId,
    reviewedBy: actorUserId,
    note: input.note ?? null
  });
  await auditService.log({
    actorUserId,
    action: ADMIN_ACTIONS.REJECTED_MASTER_ITEM,
    targetType: 'master_data_request',
    targetId: request._id,
    metadata: { type: request.type, requestedName: request.requestedName, masterItemId: String(request.masterItemId) }
  });
  return { request };
}

module.exports = {
  createItem,
  updateItem,
  deactivateItem,
  reorderItem,
  verifyOption,
  rejectOption,
  mergeOption,
  listRequests,
  approveRequest,
  rejectRequest,
  fanOutRename,
  resolveType
};
