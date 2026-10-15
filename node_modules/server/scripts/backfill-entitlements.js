'use strict';

/**
 * Backfill migration (step 15 task 4; spec §26; finalized decisions §11).
 *
 * Grants the indefinite free entitlement to every account that has **no
 * subscription row at all** — the accounts created before step 15 shipped, or
 * any account whose registration hook failed mid-flight. Idempotent: re-running
 * it is a no-op for everyone already covered, because
 * `subscriptionService.createFreeTrial()` is an upsert against the one-active
 * unique index and only reports `created` when it inserted.
 *
 *   node scripts/backfill-entitlements.js
 *
 * The read path self-heals a row-less account on its first `GET /subscription`
 * too (`subscriptionService.ensureExists`), so this script exists for auditing
 * and for operators who want the whole collection consistent in one pass — it
 * is not a correctness dependency.
 *
 * Accounts whose only rows are `expired`/`cancelled` are deliberately left
 * alone: they had an entitlement that was retired, and re-granting free access
 * is a product decision for a future phase, not a migration default.
 */

const { connect, disconnect } = require('../src/config/db');
const User = require('../src/models/User');
const subscriptionService = require('../src/services/subscriptionService');

async function main() {
  const accounts = await User.find({}).select('_id').lean();
  let created = 0;
  let alreadyCovered = 0;

  for (const account of accounts) {
    // `ensureExists` skips an account that has any row (including retired
    // ones) and grants the free plan to a row-less account.
    const result = await subscriptionService.ensureExists(String(account._id));
    if (result.created) created += 1;
    else alreadyCovered += 1;
  }

  console.log(`entitlement backfill: ${created} created, ${alreadyCovered} already covered, ${accounts.length} accounts checked`);
  return { created, alreadyCovered, checked: accounts.length };
}

async function run() {
  await connect();
  try {
    return await main();
  } finally {
    await disconnect();
  }
}

module.exports = { main, run };

if (require.main === module) {
  run().catch((err) => {
    console.error(`entitlement backfill failed: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
}
