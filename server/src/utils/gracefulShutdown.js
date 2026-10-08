'use strict';

/**
 * Graceful shutdown (spec §96).
 *
 * Kept out of server.js so it can be exercised directly. That matters because
 * Node on Windows does not deliver SIGINT/SIGTERM to a handler when the signal
 * is sent with child.kill(), so a child process can never prove this path works
 * — driving it here can.
 */

/**
 * @param {object} options
 * @param {import('node:http').Server} options.server
 * @param {() => Promise<void>} [options.closeResources] teardown hook (step 02 closes the DB here)
 * @param {{info: Function, error: Function}} [options.logger]
 * @param {(code: number) => void} [options.exit] injected for tests
 * @param {number} [options.timeoutMs] force-exit deadline
 */
function createShutdown({
  server,
  closeResources,
  logger,
  exit = (code) => process.exit(code),
  timeoutMs = 10000,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  if (!server || typeof server.close !== 'function') {
    throw new Error('createShutdown: an http.Server is required.');
  }

  let shuttingDown = false;

  return function shutdown(signal) {
    // Repeated signals must not start a second teardown.
    if (shuttingDown) return false;
    shuttingDown = true;

    if (logger) logger.info({ signal }, 'shutdown requested');

    const forceTimer = setTimer(() => {
      if (logger) logger.error('shutdown timed out, forcing exit');
      exit(1);
    }, timeoutMs);
    if (forceTimer && typeof forceTimer.unref === 'function') forceTimer.unref();

    let finished = false;
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimer(forceTimer);
      exit(code);
    };

    server.close((closeError) => {
      Promise.resolve()
        .then(() => (typeof closeResources === 'function' ? closeResources() : undefined))
        .catch((err) => {
          if (logger) logger.error({ errName: err && err.name }, 'error while closing resources');
        })
        .finally(() => {
          if (closeError) {
            if (logger) logger.error({ errName: closeError.name }, 'error while closing the listener');
            finish(1);
            return;
          }
          if (logger) logger.info('shutdown complete');
          finish(0);
        });
    });

    // Keep-alive sockets would otherwise hold the process open until the timeout.
    if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();

    return true;
  };
}

module.exports = { createShutdown };
