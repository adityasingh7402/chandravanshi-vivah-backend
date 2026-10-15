'use strict';

/**
 * Local asset store — the deterministic Cloudinary stand-in (step 08).
 *
 * It reports exactly what the provider would report: the asset's folder,
 * format, byte count and secure URL, plus a destroy result. Everything step 08
 * does *with* that information — folder scoping, format and size rejection, the
 * photo cap, the primary invariant, visibility rules and the recoverable delete
 * — is real service code running against the real route. Only the network hop is
 * replaced.
 *
 * **When it is used.** Two callers need the same behaviour:
 *
 *  - The **test suites** inject it through `config/cloudinary.js`'s gateway
 *    (`tests/helpers/fakeCloudinary.js` drives the exports below), because the
 *    suite boots the app in-process.
 *  - The **gate runner** (`npm run verify`) starts the API as a child process,
 *    so it sets `CLOUDINARY_MOCK=true` and this module is installed at config load
 *    instead. `config/env.js` refuses that flag in production, so a shipped
 *    server can never accept an upload it never actually stored.
 *
 * **What it cannot express.** A real provider can answer "I have never seen that
 * id", which is the half of verification command 6 that stops a *fabricated*
 * reference from being stored. The local store reports existence for any id
 * inside a signed folder, because with no upload endpoint there is nothing to
 * observe a write through. That behaviour is therefore asserted only in the
 * live block of `verify-step08.mjs`, and the offline run reports it as SKIP —
 * it is never counted as passing.
 *
 * **Why it exists.** Without credentials there is no way to verify an asset, so
 * registration answers 503 rather than storing an unverified reference — which
 * in turn means no profile can be published (spec §15 requires a photo) and the
 * step 06/07/08 harnesses could not run at all. This keeps the whole flow
 * exercisable offline, while `verify-step08.mjs` reports the live provider
 * boundary as SKIPPED when there are no credentials rather than passing it.
 */

const DEFAULTS = Object.freeze({
  format: 'jpg',
  bytes: 250_000,
  exists: true,
  folderOverride: null,
  describeThrows: null,
  destroyResult: 'ok',
  destroyThrows: null,
  privateUrl: null
});

const state = { ...DEFAULTS };

/** Every call the services made, so a harness can assert what was asked. */
const calls = { describe: [], destroy: [] };

function reset(overrides = {}) {
  Object.assign(state, DEFAULTS, overrides);
  calls.describe.length = 0;
  calls.destroy.length = 0;
  return state;
}

const gateway = {
  async describe({ publicId, type = 'upload' }) {
    calls.describe.push({ publicId, type });
    if (state.describeThrows) throw state.describeThrows;
    if (!state.exists) {
      const error = new Error('Resource not found');
      error.http_code = 404;
      throw error;
    }
    const folder =
      state.folderOverride !== null ? state.folderOverride : publicId.slice(0, publicId.lastIndexOf('/'));
    return {
      exists: true,
      format: state.format,
      bytes: state.bytes,
      folder,
      secureUrl: `https://res.cloudinary.com/local/image/${type}/${publicId}`
    };
  },

  async destroy({ publicId, type = 'upload' }) {
    calls.destroy.push({ publicId, type });
    if (state.destroyThrows) throw state.destroyThrows;
    return { result: state.destroyResult };
  },

  async privateUrl({ publicId, format, ttlSeconds }) {
    if (state.privateUrl) return state.privateUrl;
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `https://res.cloudinary.com/local/image/authenticated/local-signature/${publicId}.${format}?expires_at=${expiresAt}`;
  }
};

module.exports = { gateway, state, calls, reset, DEFAULTS };
