'use strict';

/**
 * Master-data request service (spec §14, §75; decisions §3; step 05 task 9).
 *
 * The admin half of the "can't find it?" flow. Submitting a missing value
 * creates a user-contributed option AND opens a review row; an admin (step 16)
 * later verifies/promotes it, rejects it, or merges it. Admin write ROUTES are
 * deliberately out of scope here — these service functions are what step 16
 * wires up.
 */

const MasterDataRequest = require('../models/MasterDataRequest');
const { getMasterModel } = require('../models/masterData/MasterItem');
const { getMasterDescriptor } = require('../constants/masterData');
const { getCategoryByType } = require('../constants/masterCategories');
const { BadRequestError, NotFoundError } = require('../utils/AppError');
const { isValidObjectId } = require('../utils/objectId');
const masterOptionService = require('./masterOptionService');

/** Open a review row for a user-contributed option. */
async function createRequest({
  userId,
  type,
  requestedName,
  masterItemId,
  masterCollection,
  communityId = null,
  clanId = null
}) {
  if (!isValidObjectId(userId)) throw new BadRequestError('Invalid request.', { details: { userId: 'A user is required.' } });
  return MasterDataRequest.create({
    userId,
    type,
    requestedName,
    masterItemId,
    masterCollection,
    communityId,
    clanId,
    status: 'pending'
  });
}

/**
 * The `POST /master-data/:type/missing` flow.
 *
 * @param {{type: string, name: string, communityId?: string, clanId?: string}} input
 * @param {string} userId the authenticated caller (never from the body)
 * @returns {Promise<{option: object, request: object}>}
 */
async function submitMissing(input, userId) {
  const descriptor = getMasterDescriptor(input.type);
  // An unknown type is a 404; a KNOWN collection that simply does not accept
  // user-submitted values is a 400 with the reason (gate G3.7).
  if (!descriptor) throw new NotFoundError('The requested resource does not exist.');
  const category = getCategoryByType(input.type);
  if (!category || !category.userInputtable) {
    throw new BadRequestError('Invalid request.', {
      details: {
        type: category ? category.missingReason : 'This collection does not accept user-submitted values.'
      }
    });
  }

  const option = await masterOptionService.findOrCreateUserOption(input, userId);

  const request = await createRequest({
    userId,
    type: category.requestType,
    requestedName: option.name,
    masterItemId: option._id,
    masterCollection: descriptor.collection,
    communityId: option.communityId || null,
    clanId: option.clanId || null
  });

  return { option, request };
}

/** The admin review queue, newest first (step 16). */
async function listPending({ type, limit = 20, page = 1 } = {}) {
  const filter = { status: 'pending' };
  if (type) filter.type = type;
  const bounded = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const current = Math.max(Number(page) || 1, 1);
  const items = await MasterDataRequest.find(filter)
    .sort({ createdAt: -1 })
    .skip((current - 1) * bounded)
    .limit(bounded)
    .lean();
  const total = await MasterDataRequest.countDocuments(filter);
  return { items, total, page: current, limit: bounded };
}

/** Load a request for review, or 404. */
async function loadForReview(requestId) {
  if (!isValidObjectId(requestId)) throw new NotFoundError('The requested resource does not exist.');
  const request = await MasterDataRequest.findById(requestId);
  if (!request) throw new NotFoundError('The requested resource does not exist.');
  return request;
}

/**
 * Promote a user-contributed value to official (spec §75).
 *
 * Sets `verifiedBy`/`verifiedAt` on the master row and marks the request
 * approved. Only an admin action may do this — no user path reaches here.
 */
async function verify({ requestId, reviewedBy, note = null }) {
  const request = await loadForReview(requestId);
  const descriptor = getMasterDescriptor(request.masterCollection) || null;
  const model = descriptor ? getMasterModel(request.masterCollection) : null;
  if (!model) throw new NotFoundError('The requested resource does not exist.');

  const item = await model.findById(request.masterItemId);
  if (!item) throw new NotFoundError('The requested resource does not exist.');

  item.source = 'admin';
  item.verifiedBy = reviewedBy;
  item.verifiedAt = new Date();
  await item.save();

  request.status = 'approved';
  request.reviewedBy = reviewedBy;
  request.reviewedAt = new Date();
  request.reviewNote = note;
  await request.save();

  return { item, request };
}

/**
 * Reject a user-contributed value by DEACTIVATING it: existing profile
 * references stay valid, new selections no longer show it (spec §74, §97).
 */
async function reject({ requestId, reviewedBy, note = null }) {
  const request = await loadForReview(requestId);
  const descriptor = getMasterDescriptor(request.masterCollection);
  const model = descriptor ? getMasterModel(request.masterCollection) : null;
  if (!model) throw new NotFoundError('The requested resource does not exist.');

  const item = await model.findById(request.masterItemId);
  if (item) {
    item.isActive = false;
    await item.save();
  }

  request.status = 'rejected';
  request.reviewedBy = reviewedBy;
  request.reviewedAt = new Date();
  request.reviewNote = note;
  await request.save();

  return { item: item || null, request };
}

module.exports = { createRequest, submitMissing, listPending, verify, reject };
