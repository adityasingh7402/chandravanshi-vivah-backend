'use strict';

const express = require('express');
const { ok } = require('../utils/apiResponse');
const config = require('../config/env');
const { API_PREFIX } = require('../config/constants');
const { version } = require('../../package.json');

/**
 * API router (spec §32, §33).
 *
 * Mounted at the configured API prefix. Health is the only route in step 01;
 * later steps add their routers here and nothing else touches app.js.
 */
const router = express.Router();

router.get('/health', (req, res) =>
  ok(res, {
    status: 'ok',
    env: config.nodeEnv,
    version,
    // Seconds the process has been up; useful as a liveness signal.
    uptime: Math.round(process.uptime()),
    timestamp: new Date().toISOString()
  })
);

module.exports = router;
module.exports.API_PREFIX = API_PREFIX;
