'use strict';

/**
 * Canonical collection names (spec §103, §127; finalized decisions §18, §19).
 *
 * This is the single source of truth. Every model must import its collection
 * name from here rather than writing a string literal, so a rename happens in
 * exactly one place and `scripts/verify-indexes.js` can enumerate what exists.
 *
 * Naming convention: plural snake_case (§103).
 */

/** Collections that exist in the current phase. */
const COLLECTIONS = Object.freeze({
  // Identity & sessions
  USERS: 'users',
  SESSIONS: 'sessions',

  // Matrimonial domain
  MATRIMONIAL_PROFILES: 'matrimonial_profiles',
  PARTNER_PREFERENCES: 'partner_preferences',
  PHOTOS: 'photos',
  VERIFICATIONS: 'verifications',
  KUNDLI_DOCUMENTS: 'kundli_documents',

  // Actions, relationships & safety
  PROFILE_ACTIONS: 'profile_actions',
  CONNECTIONS: 'connections',
  BLOCKS: 'blocks',
  REPORTS: 'reports',
  // Required by the Gotra/Surname approval workflow (decisions §3).
  MASTER_DATA_REQUESTS: 'master_data_requests',

  // Messaging
  CONVERSATIONS: 'conversations',
  MESSAGES: 'messages',
  NOTIFICATIONS: 'notifications',

  // Billing boundary (free in the current phase)
  SUBSCRIPTIONS: 'subscriptions',

  // Platform
  AUDIT_LOGS: 'audit_logs',
  COMMUNITY_CONFIGS: 'community_configs',

  // Master data — community
  COMMUNITIES: 'communities',
  SUB_COMMUNITIES: 'sub_communities',
  GOTRAS: 'gotras',
  SURNAMES: 'surnames',

  // Master data — education & career
  OCCUPATIONS: 'occupations',
  INDUSTRIES: 'industries',
  DEGREES: 'degrees',
  SPECIALIZATIONS: 'specializations',
  COLLEGES: 'colleges',
  UNIVERSITIES: 'universities',

  // Master data — geography
  COUNTRIES: 'countries',
  STATES: 'states',
  DISTRICTS: 'districts',
  CITIES: 'cities',

  // Master data — lifestyle & interests
  LANGUAGES: 'languages',
  HOBBIES: 'hobbies',
  INTERESTS: 'interests'
});

/**
 * Collections that are intentionally NOT created yet.
 *
 * `payment_transactions` is future-only: payments (Razorpay, Google Play
 * Billing) are not in the current phase, so no collection is created and no
 * model may reference this name (decisions §17, §19). When payments start,
 * move the entry into COLLECTIONS and add its model — do not use it before.
 */
const FUTURE_COLLECTIONS = Object.freeze({
  PAYMENT_TRANSACTIONS: 'payment_transactions'
});

/** Every current collection name, de-duplicated, in declaration order. */
const ALL_COLLECTIONS = Object.freeze([...new Set(Object.values(COLLECTIONS))]);

/** Names that must never be created in the current phase. */
const FUTURE_COLLECTION_NAMES = Object.freeze([...new Set(Object.values(FUTURE_COLLECTIONS))]);

function snakeCase(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function pluralize(word) {
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  return `${word}s`;
}

/**
 * Convert a model name to its collection name: plural snake_case (§103).
 *
 *   toCollectionName('MatrimonialProfile') === 'matrimonial_profiles'
 *   toCollectionName('SubCommunity')       === 'sub_communities'
 *   toCollectionName('AuditLog')           === 'audit_logs'
 *
 * @param {string} modelName
 * @returns {string}
 */
function toCollectionName(modelName) {
  const snake = snakeCase(modelName);
  if (!snake) return snake;
  const parts = snake.split('_');
  parts[parts.length - 1] = pluralize(parts[parts.length - 1]);
  return parts.join('_');
}

/** True when `name` is a current collection or a reserved future-only name. */
function isKnownCollection(name) {
  return ALL_COLLECTIONS.includes(name) || FUTURE_COLLECTION_NAMES.includes(name);
}

module.exports = {
  COLLECTIONS,
  FUTURE_COLLECTIONS,
  ALL_COLLECTIONS,
  FUTURE_COLLECTION_NAMES,
  toCollectionName,
  isKnownCollection
};
