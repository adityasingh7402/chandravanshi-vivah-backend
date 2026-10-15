'use strict';

/**
 * Cloudinary integration boundary (spec §17, §18, §43, §79; step 08 task 2).
 *
 * Two rules shape this module:
 *
 *  1. **The API secret never leaves the server.** Only `cloud_name`, `api_key`
 *     and a signature are ever returned to a client (spec §43). Nothing here
 *     logs a credential: the boot log line carries the cloud name only, which is
 *     public information (it appears in every delivery URL).
 *  2. **Every Cloudinary call goes through a gateway.** The admin API is the one
 *     boundary a test cannot exercise without a real account, and it is exactly
 *     where the security-relevant logic lives (does this asset exist, is it in
 *     *this* user's folder, is its format allowed, is it small enough). So the
 *     gateway is an interface: the production implementation talks to the SDK,
 *     and a test may install a deterministic double via `setAssetGateway()`.
 *     The verification rules themselves then run in the suite, and the real
 *     gateway is exercised by the live harness when credentials exist.
 *
 * When the integration is not configured (test/development without a Cloudinary
 * account), `ensureConfigured()` throws a 503 rather than pretending to succeed:
 * an unverifiable upload must never be stored as if it were verified.
 */

const cloudinary = require('cloudinary').v2;
const config = require('./env');
const { gateway: localGateway } = require('./localAssetStore');
const { ServiceUnavailableError } = require('../utils/AppError');

let configured = false;
let assetGateway = null;

if (config.cloudinary.configured) {
  cloudinary.config({
    cloud_name: config.cloudinary.cloudName,
    api_key: config.cloudinary.apiKey,
    api_secret: config.cloudinary.apiSecret,
    secure: true
  });
  configured = true;
}

/**
 * `CLOUDINARY_MOCK=true` (development / the gate runner only — `config/env.js`
 * refuses it in production) swaps the provider's admin API for the local store.
 * Without it an unconfigured server cannot verify an upload and must answer 503
 * rather than store an unverified reference.
 */
const usingLocalStore = !configured && config.cloudinary.mock === true;

/**
 * The production gateway: the real Cloudinary admin API.
 *
 * `type` is `upload` for photos and `authenticated` for Kundli documents, so a
 * Kundli asset is never fetchable from a plain delivery URL (decisions §6).
 */
const sdkGateway = {
  /**
   * Describe an uploaded asset. Throws `notFound` for an id Cloudinary does not
   * know, which the caller turns into a 400 — never into a stored reference.
   */
  async describe({ publicId, type = 'upload' }) {
    const resource = await cloudinary.api.resource(publicId, {
      type,
      resource_type: 'image',
      colors: false
    });
    return {
      exists: true,
      format: resource.format ? String(resource.format).toLowerCase() : null,
      bytes: typeof resource.bytes === 'number' ? resource.bytes : null,
      folder: resource.folder ? String(resource.folder) : null,
      secureUrl: resource.secure_url ? String(resource.secure_url) : null
    };
  },

  /** Destroy the asset. Returns Cloudinary's own `result` string. */
  async destroy({ publicId, type = 'upload' }) {
    const result = await cloudinary.uploader.destroy(publicId, { type, invalidate: true });
    return { result: result && result.result ? String(result.result) : 'unknown' };
  },

  /**
   * A short-lived signed delivery URL for an authenticated asset. This is the
   * only way a Kundli document is ever handed to a client (spec §112).
   */
  async privateUrl({ publicId, format, type = 'authenticated', ttlSeconds }) {
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    return cloudinary.utils.private_download_url(publicId, format, {
      type,
      expires_at: expiresAt
    });
  }
};

/**
 * True when uploads can be verified: real credentials, or the local store the
 * gate runner explicitly opted into. A partial credential set is a boot error,
 * so there is no third state.
 */
function isConfigured() {
  return configured || usingLocalStore;
}

/** The active gateway: an injected double, the local store, or the SDK. */
function getAssetGateway() {
  if (assetGateway) return assetGateway;
  if (usingLocalStore) return localGateway;
  return sdkGateway;
}

/**
 * Install a replacement gateway. Intended for tests and for a future provider
 * swap; pass `null` to go back to the SDK.
 */
function setAssetGateway(gateway) {
  assetGateway = gateway || null;
}

/** 503 rather than a silent no-op: an unverified upload must not be stored. */
function ensureConfigured() {
  if (!isConfigured()) {
    throw new ServiceUnavailableError(
      'Image storage is not configured on this server. Please try again later.'
    );
  }
}

module.exports = {
  isConfigured,
  ensureConfigured,
  getAssetGateway,
  setAssetGateway,
  sdkGateway,
  cloudinary,
  uploadFolder: config.cloudinary.uploadFolder
};
