'use strict';

/**
 * `users` model (spec §5, §3.4).
 *
 * This document is for ACCOUNT/AUTHENTICATION only. Matchmaking data lives in a
 * separate profile document — the identity-vs-profile separation is deliberate
 * (spec §3.4).
 *
 * Conventions come from the step-02 base plugin: timestamps on, `versionKey`
 * off, `strict: true`, and a JSON transform that strips `internal` fields —
 * which is how `passwordHash` can never appear in a response (spec §30, §40).
 */

const mongoose = require('mongoose');
const { baseSchema } = require('./plugins/baseSchema');
const { COLLECTIONS } = require('../config/collections');
const { ROLE_VALUES, STATUS_VALUES } = require('../constants/auth');

const userSchema = new mongoose.Schema(
  {
    // Both are optional individually; together at least one is required.
    // Absent stays null (never an empty string) so the partial unique indexes
    // permit many documents with no email / no phone (spec §5).
    email: { type: String, default: null, trim: true, lowercase: true },
    phone: { type: String, default: null, trim: true },

    // Never selected by default and never serialised (internal: true).
    passwordHash: { type: String, required: true, select: false, internal: true },

    role: { type: String, enum: ROLE_VALUES, default: 'user' },
    status: { type: String, enum: STATUS_VALUES, default: 'active' },

    profileCreated: { type: Boolean, default: false },
    onboardingCompleted: { type: Boolean, default: false },

    lastLoginAt: { type: Date, default: null }
  },
  { collection: COLLECTIONS.USERS }
);

userSchema.plugin(baseSchema);

// Partial unique indexes: unique only when the value is actually a string
// (spec §5). Many nulls are allowed; two identical emails are not.
userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phone: { $type: 'string' } } });

// At least one identifier must be present (spec §5: "no email + no phone" is invalid).
// Expressed as a path validator rather than a `pre('validate')` hook because
// Mongoose 9's document middleware no longer receives a `next` callback.
userSchema.path('email').validate(function requireIdentifier(value) {
  return Boolean(value || this.phone);
}, 'At least one of email or phone is required.');

/**
 * The client-facing shape of a user. Only ever built from a real document.
 * `passwordHash` is excluded here AND by the schema's `internal` flag, so it
 * cannot leak even if this helper is bypassed (spec §40, §31).
 */
userSchema.methods.toPublic = function toPublic() {
  return {
    id: this._id.toString(),
    email: this.email || null,
    phone: this.phone || null,
    role: this.role,
    status: this.status,
    profileCreated: this.profileCreated,
    onboardingCompleted: this.onboardingCompleted,
    lastLoginAt: this.lastLoginAt || null,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt
  };
};

// Reuse the compiled model when hot-reloaded so re-require cannot throw
// OverwriteModelError. The schema is reachable as `User.schema`.
const User = mongoose.models.User || mongoose.model('User', userSchema);

module.exports = User;
