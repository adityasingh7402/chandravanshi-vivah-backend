'use strict';

/**
 * `sessions` model (spec §7).
 *
 * One document per logged-in device. The refresh token is stored ONLY as a
 * hash, so a database leak cannot be replayed as a credential (spec §7). The
 * access token is stateless, but this row is what makes logout and password
 * changes take effect immediately.
 */

const mongoose = require('mongoose');
const { baseSchema } = require('./plugins/baseSchema');
const { COLLECTIONS } = require('../config/collections');
const { DEVICE_TYPE_VALUES } = require('../constants/auth');

const sessionSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // internal:true keeps it out of every JSON serialisation; the unique index
    // is what a presented refresh token is looked up by.
    refreshTokenHash: { type: String, required: true, internal: true },

    deviceType: { type: String, enum: DEVICE_TYPE_VALUES, default: 'web' },
    deviceName: { type: String, default: null },

    lastUsedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null }
  },
  { collection: COLLECTIONS.SESSIONS }
);

sessionSchema.plugin(baseSchema);

// Load/revoke every session for a user (spec §105).
sessionSchema.index({ userId: 1 });
// Look a session up by the presented refresh token, and make the hash unique.
sessionSchema.index({ refreshTokenHash: 1 }, { unique: true });
// Expired sessions expire on their own — no full-collection sweep (gate G4.3).
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

sessionSchema.methods.isActive = function isActive(now = new Date()) {
  return this.revokedAt === null && this.expiresAt > now;
};

// Reuse the compiled model when re-required so hot reload cannot throw.
const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);

module.exports = Session;
