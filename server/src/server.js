'use strict';

/**
 * Server entry point (spec §79, §96).
 *
 * Loads and validates configuration first: a bad environment must stop the
 * process here, before any module that depends on it is required.
 */

let config;
try {
  config = require('./config/env');
} catch (err) {
  // A ConfigurationError is the fail-fast path: field name and reason only,
  // never the offending value. Anything else is a bug in this file and needs
  // its stack.
  if (err.name === 'ConfigurationError') {
    process.stderr.write(`${err.message}\n`);
  } else {
    process.stderr.write(`[boot] ${err.stack || err.message}\n`);
  }
  process.exit(1);
}

const app = require('./app');
const { logger, sanitize } = require('./middleware/requestLogger');
const { createShutdown } = require('./utils/gracefulShutdown');
const { connect, disconnect, sanitizeDatabaseError } = require('./config/db');

let server;

/**
 * Boot sequence (step 02).
 *
 * Connect to MongoDB BEFORE listening: a server that cannot read or write data
 * must not start (spec §39). A connection failure is logged sanitised — never
 * the URI — and the process exits non-zero.
 */
async function start() {
  try {
    await connect();
  } catch (err) {
    const errName = err && err.name ? err.name : 'DatabaseError';
    // sanitizeDatabaseError strips the connection string, host list, credentials
    // and database name the driver might otherwise echo (spec §38, §111).
    logger.fatal(
      { errName },
      sanitizeDatabaseError(err && err.message ? err.message : 'database connection failed')
    );
    process.exit(1);
    return;
  }

  server = app.listen(config.port, () => {
    // `env` already comes from the logger's static bindings; do not repeat it here.
    logger.info({ port: config.port, apiPrefix: config.apiPrefix }, `server listening on port ${config.port}`);
  });

  // A bind failure (port already in use, permission denied) is a deployment
  // problem, not a crash: report it clearly and exit non-zero.
  server.on('error', (err) => {
    const code = err && err.code ? err.code : 'UNKNOWN';
    logger.fatal({ code, port: config.port }, `unable to listen on port ${config.port}`);
    process.exit(1);
  });

  /**
   * Resource teardown hook: close the single MongoDB connection.
   * No transactions are used here — just a clean close (spec §96).
   */
  async function closeResources() {
    await disconnect();
  }

  const shutdown = createShutdown({ server, closeResources, logger });

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

process.on('unhandledRejection', (reason) => {
  const errName = reason instanceof Error ? reason.name : 'RejectedPromise';
  const errMessage = sanitize(reason instanceof Error ? reason.message : String(reason));
  logger.fatal({ errName }, errMessage);
  process.exit(1);
});

start();
