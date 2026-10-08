'use strict';

const { fail } = require('../utils/apiResponse');
const { HTTP_STATUS, MESSAGES } = require('../config/constants');

/**
 * Terminal 404 handler (spec §33, §77).
 *
 * Mounted after every router so an unknown path returns the JSON envelope
 * instead of Express's default HTML page.
 */
function notFound(req, res) {
  return fail(res, HTTP_STATUS.NOT_FOUND, MESSAGES.NOT_FOUND);
}

module.exports = notFound;
