'use strict';

/**
 * Refresh-cookie transport (spec §7, §41).
 *
 * Web clients keep the refresh token in an HttpOnly cookie so JavaScript can
 * never read it (an XSS bug cannot exfiltrate the session). Mobile clients hold
 * tokens in platform secure storage and send the bearer header instead.
 *
 * The cookie is scoped to the refresh endpoint only, so it is not attached to
 * ordinary API calls where it has no purpose.
 */

const config = require('../config/env');

const REFRESH_COOKIE_NAME = 'refreshToken';

/** Path scope: only the refresh endpoint receives the cookie. */
const REFRESH_COOKIE_PATH = `${config.apiPrefix}/auth/refresh`;

/** Attributes shared by set and clear, so clearing always matches the stored cookie. */
function baseOptions() {
  const options = {
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    path: REFRESH_COOKIE_PATH
  };
  if (config.cookie.domain) options.domain = config.cookie.domain;
  return options;
}

/**
 * Set the refresh cookie.
 * @param {import('express').Response} res
 * @param {string} rawToken the opaque refresh token (never stored in plaintext server-side)
 */
function setRefreshCookie(res, rawToken) {
  res.cookie(REFRESH_COOKIE_NAME, rawToken, { ...baseOptions(), maxAge: config.session.ttlMs });
}

/** Clear the refresh cookie. `secure`/`sameSite` are omitted deliberately. */
function clearRefreshCookie(res) {
  const { domain, path } = baseOptions();
  const options = { httpOnly: true, path };
  if (domain) options.domain = domain;
  // A Secure cookie is only stored/cleared over HTTPS; outside production the
  // cookie was set without Secure, so clearing must match.
  if (config.cookie.secure) options.secure = true;
  res.clearCookie(REFRESH_COOKIE_NAME, options);
}

/**
 * Read the raw refresh token from the request, if cookie parsing is installed.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function readRefreshCookie(req) {
  const value = req && req.cookies ? req.cookies[REFRESH_COOKIE_NAME] : undefined;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

module.exports = {
  REFRESH_COOKIE_NAME,
  REFRESH_COOKIE_PATH,
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshCookie
};
