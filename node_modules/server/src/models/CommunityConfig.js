'use strict';

/**
 * `community_configs` model (spec §15; step 05 task 6).
 *
 * The product is Chandravanshi-focused, so the community is platform-controlled
 * and configured centrally rather than hardcoded through the application.
 *
 * The seeded rule values are PRODUCT DECISIONS TO CONFIRM, not assumptions:
 * they are defaults that express the current intent and are meant to be changed
 * by the product owner without a code change (spec §15).
 */

const mongoose = require('mongoose');
const { baseSchema } = require('./plugins/baseSchema');
const { COLLECTIONS } = require('../config/collections');

const communityConfigSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, unique: true },
    isActive: { type: Boolean, default: true },

    settings: {
      requireProfilePhoto: { type: Boolean, default: true },
      // Kept for step 03's auth model, which still allows password login.
      requirePhoneLogin: { type: Boolean, default: false }
    },

    rules: {
      // TO CONFIRM with the product owner/community stakeholders (spec §15).
      sameGotraAllowed: { type: Boolean, default: false }
    }
  },
  { collection: COLLECTIONS.COMMUNITY_CONFIGS }
);

communityConfigSchema.plugin(baseSchema);

const CommunityConfig = mongoose.models.CommunityConfig || mongoose.model('CommunityConfig', communityConfigSchema);

module.exports = CommunityConfig;
