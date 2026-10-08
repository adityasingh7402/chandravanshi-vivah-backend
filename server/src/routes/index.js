'use strict';

const express = require('express');
const { ok } = require('../utils/apiResponse');
const config = require('../config/env');
const { API_PREFIX } = require('../config/constants');
const { getConnectionState, isConnected } = require('../config/db');
const { version } = require('../../package.json');

/**
 * API router (spec §32, §33).
 *
 * Mounted at the configured API prefix. Health is the only route in step 01;
 * later steps add their routers here and nothing else touches app.js.
 */
const authRoutes = require('./auth.routes');
const sessionRoutes = require('./session.routes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/auth', sessionRoutes);

router.get('/health', (req, res) =>
  ok(res, {
    status: 'ok',
    env: config.nodeEnv,
    version,
    // Seconds the process has been up; useful as a liveness signal.
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
    // Database readiness only — never the URI, host list or database name
    // (spec §38, §111).
    database: {
      state: getConnectionState(),
      connected: isConnected()
    }
  })
);

module.exports = router;
module.exports.API_PREFIX = API_PREFIX;
