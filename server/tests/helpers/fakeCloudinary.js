'use strict';

/**
 * Test-facing wrapper around the **same** asset store the server uses in gate
 * mode (`src/config/localAssetStore.js`) — one implementation, two entry points.
 *
 *  - The API process installs the store itself when `CLOUDINARY_MOCK=1`, because
 *    the gate runner starts the server as a child process.
 *  - The test suites boot the app in-process, so they install it explicitly
 *    through `config/cloudinary.js`'s gateway injection instead.
 *
 * Everything else in step 08 runs for real: the routes, validators, ownership
 * filters, caps, primary invariant, visibility rules and completion re-scoring
 * are the production code. Only the hop to Cloudinary's admin API is replaced,
 * which is the one thing a suite cannot do without an account — `verify-step08.mjs`
 * exercises that live boundary and reports it as SKIPPED when there are none.
 *
 * Not an auto-discovered test file: it is not named `*.test.js`.
 */

const cloudinaryConfig = require('../../src/config/cloudinary');
const store = require('../../src/config/localAssetStore');

/** Reset the store, apply overrides, and inject it as the active gateway. */
function install(overrides = {}) {
  store.reset(overrides);
  cloudinaryConfig.setAssetGateway(store.gateway);
  return store.state;
}

/** Reset and fall back to the production gateway. */
function uninstall() {
  store.reset();
  cloudinaryConfig.setAssetGateway(null);
}

module.exports = {
  install,
  uninstall,
  reset: store.reset,
  state: store.state,
  calls: store.calls,
  gateway: store.gateway,
  DEFAULTS: store.DEFAULTS
};
