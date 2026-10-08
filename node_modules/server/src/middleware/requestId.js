'use strict';

const crypto = require('crypto');
const { REQUEST_ID_HEADER } = require('../config/constants');

const HEADER = REQUEST_ID_HEADER.toLowerCase();
// Accept only a conservative charset and length so an inbound id cannot inject content into logs.
const SAFE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Attach a correlation id to every request (spec §78).
 *
 * An inbound `X-Request-Id` is reused when it is well formed, so a client or a
 * proxy can correlate its own request with a server log line. Anything that is
 * missing or malformed is replaced with a generated UUID rather than trusted.
 */
function requestId(req, res, next) {
  const inbound = req.headers[HEADER];
  const isValid = typeof inbound === 'string' && SAFE_ID_RE.test(inbound.trim());

  const id = isValid ? inbound.trim() : crypto.randomUUID();

  req.id = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  next();
}

module.exports = requestId;
