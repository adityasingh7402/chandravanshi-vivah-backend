'use strict';

/**
 * Report controller (spec §23, §33, §44, §101, §112; step 12 API surface).
 *
 * Two user-facing routes only — file a report, read your own reports. Every
 * moderation action (`status`, `reviewedBy`, `reviewedAt`) is step 16's and is
 * deliberately absent here (spec §32).
 *
 * The serialiser names every field: no `reporterId` (the caller *is* the
 * reporter, and nobody else may learn it), no `reviewedBy`/`reviewedAt` (admin
 * bookkeeping), no account ids. A report response is therefore safe to hand to
 * anybody who was allowed to make the request in the first place (spec §112).
 */

const reportService = require('../services/reportService');
const { ok } = require('../utils/apiResponse');
const { HTTP_STATUS } = require('../config/constants');

/** A safe projection of one report row, for its own reporter. */
function serializeReport(report) {
  return {
    id: String(report._id),
    category: report.category,
    description: report.description ?? null,
    evidence: report.evidence ?? [],
    status: report.status,
    createdAt: report.createdAt,
    updatedAt: report.updatedAt
  };
}

/** POST /api/v1/reports — open a moderation case. */
async function create(req, res) {
  const { report } = await reportService.create(req.auth.userId, req.body);
  return ok(res, { report: serializeReport(report) }, 'Report submitted.', HTTP_STATUS.CREATED);
}

/** GET /api/v1/reports/me — the caller's own reports and their statuses. */
async function listMine(req, res) {
  const result = await reportService.listOwn(req.auth.userId, req.validatedQuery);
  return ok(res, result, 'OK');
}

module.exports = { create, listMine, serializeReport };
