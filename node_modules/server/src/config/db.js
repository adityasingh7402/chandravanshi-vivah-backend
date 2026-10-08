'use strict';

/**
 * MongoDB connection helper (spec §2, §38, §39, §49, §96, §103).
 *
 * The server is the ONLY component that connects to MongoDB; websites and
 * mobile apps never do. This module is the single place a connection is
 * created, so pooling, timeouts and event logging are configured once.
 *
 * Hard rules:
 *   - The connection string is never logged, returned, or included in an
 *     error message (spec §38, §111). Free-text driver messages are scrubbed.
 *   - Startup fails fast: if the initial connect fails the caller must exit
 *     non-zero rather than serve traffic that cannot read data (spec §39).
 */

const mongoose = require('mongoose');
const config = require('./env');
const { logger, sanitize } = require('../middleware/requestLogger');

/** mongoose.connection.readyState -> human-readable state. */
const READY_STATE = Object.freeze({
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting'
});

// Host / host-list patterns the driver embeds in connection errors. Atlas SRV
// failures in particular echo the cluster hostnames (spec §38, §111).
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?/g;
const HOSTNAME_RE = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?/gi;
const CREDENTIALS_RE = /\b[a-z0-9._%-]+:[^@\s/]+@/gi;

/**
 * Sanitise a MongoDB driver message before it is logged (spec §38, §78, §111).
 *
 * `sanitize` already scrubs connection strings and key=value credentials; this
 * additionally removes host lists, bare host:port pairs and the configured
 * database name, so a connection failure can be logged without leaking any
 * part of the deployment topology.
 *
 * @param {unknown} message
 * @returns {string}
 */
function sanitizeDatabaseError(message) {
  if (message === undefined || message === null) return '';
  let out = String(sanitize(String(message)));
  out = out.replace(IPV4_RE, '[redacted-host]').replace(HOSTNAME_RE, '[redacted-host]');
  out = out.replace(CREDENTIALS_RE, '[redacted-credentials]@');
  if (config.mongodbDbName) out = out.split(config.mongodbDbName).join('[redacted-db]');
  return out;
}

// `error` must always have a listener, otherwise EventEmitter throws on the
// next driver error. Register once, before the first connect.
let listenersRegistered = false;

/**
 * Driver options built entirely from config — nothing is hardcoded (spec §49).
 * Exported so a test can assert the values track config rather than literals.
 */
function buildOptions() {
  return Object.freeze({
    dbName: config.mongodbDbName,
    maxPoolSize: config.db.maxPoolSize,
    serverSelectionTimeoutMS: config.db.serverSelectionTimeoutMs,
    connectTimeoutMS: config.db.connectTimeoutMs,
    socketTimeoutMS: config.db.socketTimeoutMs,
    // Never let startup silently build indexes outside development (§49, §105).
    autoIndex: config.db.autoIndex
  });
}

function registerConnectionListeners() {
  if (listenersRegistered) return;
  listenersRegistered = true;

  const connection = mongoose.connection;

  connection.on('connected', () => {
    // No URI, host, or database name here (spec §111).
    logger.info('database connected');
  });
  connection.on('disconnected', () => logger.warn('database disconnected'));
  connection.on('reconnected', () => logger.info('database reconnected'));
  connection.on('error', (err) => {
    // Scrub any connection string, host list, credentials or database name the
    // driver may have embedded in its message (spec §38, §78, §111).
    logger.error({ errName: err && err.name }, sanitizeDatabaseError(err && err.message ? err.message : 'database error'));
  });
}

/**
 * Open the single application connection.
 * Resolves with the mongoose connection, rejects if the server is unreachable.
 *
 * @param {string} [uri] defaults to the configured MONGODB_URI
 */
async function connect(uri = config.mongodbUri) {
  registerConnectionListeners();

  if (mongoose.connection.readyState === 1) return mongoose.connection;

  await mongoose.connect(uri, buildOptions());
  return mongoose.connection;
}

/** Close the connection and release the pool. Safe to call when already closed. */
async function disconnect() {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.connection.close(false);
}

/** @returns {'disconnected'|'connected'|'connecting'|'disconnecting'|'unknown'} */
function getConnectionState() {
  return READY_STATE[mongoose.connection.readyState] || 'unknown';
}

/** @returns {boolean} true only when the connection is ready to serve queries */
function isConnected() {
  return mongoose.connection.readyState === 1;
}

module.exports = {
  connect,
  disconnect,
  getConnectionState,
  isConnected,
  buildOptions,
  sanitizeDatabaseError
};
