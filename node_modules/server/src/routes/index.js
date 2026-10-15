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
const masterDataRoutes = require('./masterData.routes');
const profileRoutes = require('./profile.routes');
const preferenceRoutes = require('./preference.routes');
const photoRoutes = require('./photo.routes');
const kundliRoutes = require('./kundli.routes');
const discoverRoutes = require('./discover.routes');
const interactionRoutes = require('./interaction.routes');
const connectionRoutes = require('./connection.routes');
const blockRoutes = require('./block.routes');
const reportRoutes = require('./report.routes');
const notificationRoutes = require('./notification.routes');
const subscriptionRoutes = require('./subscription.routes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/auth', sessionRoutes);
router.use('/master-data', masterDataRoutes);
router.use('/profile', profileRoutes);
router.use('/preferences', preferenceRoutes);
router.use('/photos', photoRoutes);
router.use('/kundli', kundliRoutes);
// Step 09 — the read path. Mounted at the API root because its paths are
// top-level (`/discover`, `/search`, `/recommendations`), not a sub-resource.
router.use(discoverRoutes);
// Step 10 — lightweight profile actions (view / like / shortlist / pass).
router.use('/interactions', interactionRoutes);
// Step 11 — the formal interest handshake (send / accept / reject / withdraw / close).
router.use('/connections', connectionRoutes);
// Step 12 — safety: blocking a member and opening a moderation case.
router.use('/blocks', blockRoutes);
router.use('/reports', reportRoutes);
// Step 13 — in-app notifications (inbox, badge count, mark-read).
router.use('/notifications', notificationRoutes);
// Step 15 — the entitlement gate (one read; no payment routes exist yet).
router.use('/subscription', subscriptionRoutes);

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
