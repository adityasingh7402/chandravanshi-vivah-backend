'use strict';

/**
 * Database privilege check (spec §39; step 02 gate G3.2).
 *
 * The application's credential must be a least-privilege *application* user:
 * the built-in `readWrite` role scoped to the application database. A cluster
 * administrator (`atlasAdmin`, `root`, `readWriteAnyDatabase`, …) hands the API
 * process the ability to administer or drop any database on the cluster, which
 * is exactly what §39 forbids.
 *
 * The app itself needs nothing more than read/write on its own database: no
 * module under `src/` issues an administrative command (`listDatabases`,
 * `connectionStatus`, `serverStatus`, `currentOp`), and index creation is part
 * of `readWrite`. So this check is a configuration gate, not a code gate.
 *
 * Run:  node scripts/check-db-privileges.js
 *
 * Exit codes: 0 = least privilege, 1 = over-privileged or unable to determine.
 * The credential and the connection string are never printed (§38, §111).
 */

const mongoose = require('mongoose');
const db = require('../src/config/db');
const config = require('../src/config/env');
const { logger } = require('../src/middleware/requestLogger');

/**
 * Roles that must never appear on the application credential. `atlasAdmin`,
 * `root` and the `*AnyDatabase` roles are cluster-wide by definition; the
 * database-scoped admin roles (`dbAdmin`, `userAdmin`) are no better.
 */
const ADMINISTRATIVE_ROLES = Object.freeze([
  'root',
  'atlasAdmin',
  'readWriteAnyDatabase',
  'readAnyDatabase',
  'dbAdminAnyDatabase',
  'userAdminAnyDatabase',
  'clusterMonitor',
  'clusterManager',
  'backup',
  'restore',
  'dbAdmin',
  'userAdmin',
  'hostManager',
  'enableSharding'
]);

/** Databases an application user has no reason to hold a role on. */
const SYSTEM_DATABASES = Object.freeze(['admin', 'local', 'config']);

/** The role the application is expected to hold, on its own database only. */
const APPLICATION_WRITE_ROLE = 'readWrite';

/**
 * Classify a set of roles against the application database.
 *
 * @param {Array<{role: string, db: string}>} roles from `connectionStatus`
 * @param {string} appDatabase
 * @returns {{leastPrivilege: boolean, problems: string[], granted: string[]}}
 */
function classifyRoles(roles, appDatabase) {
  const problems = [];
  const granted = [];

  for (const entry of roles || []) {
    const role = entry && entry.role;
    const onDb = entry && entry.db;
    if (!role) continue;

    if (ADMINISTRATIVE_ROLES.includes(role)) {
      problems.push(`"${role}" on "${onDb}" is an administrative role`);
      continue;
    }
    if (SYSTEM_DATABASES.includes(onDb)) {
      problems.push(`"${role}" is granted on the system database "${onDb}"`);
      continue;
    }
    if (onDb !== appDatabase) {
      problems.push(`"${role}" is scoped to "${onDb}", not the application database "${appDatabase}"`);
      continue;
    }
    granted.push(role);
  }

  if (!granted.includes(APPLICATION_WRITE_ROLE)) {
    problems.push(
      `the application database "${appDatabase}" does not grant the built-in "${APPLICATION_WRITE_ROLE}" role`
    );
  }

  return { leastPrivilege: problems.length === 0, problems, granted };
}

/**
 * Read the roles the connected credential actually holds. `connectionStatus`
 * reports only the caller's own auth info and needs no special privilege, so
 * this check runs under the same credential the application uses.
 */
async function readRoles() {
  const status = await mongoose.connection.getClient().db('admin').command({ connectionStatus: 1 });
  const authenticated = status.authInfo && status.authInfo.authenticatedUsers;
  const user = authenticated && authenticated[0] ? authenticated[0].user : '(unknown)';
  const roles = (status.authInfo && status.authInfo.authenticatedUserRoles) || [];
  return { user, roles };
}

function remediation(appDatabase) {
  return [
    `Create a dedicated Atlas database user with the built-in "${APPLICATION_WRITE_ROLE}" role scoped to`,
    `"${appDatabase}" (Atlas → Database Access → Add New Database User → Built-in Role → Read and write to any`,
    'database, then restrict the database to the application database). Keep the cluster-admin credential out of',
    'the application environment entirely, put the new URI in MONGODB_URI, restart, and re-run this script.'
  ].join(' ');
}

async function main() {
  try {
    await db.connect();
  } catch (err) {
    logger.error({ errName: err && err.name }, 'check-db-privileges: could not connect');
    console.error('Could not connect to MongoDB — privilege check not run.');
    process.exitCode = 1;
    return;
  }

  try {
    const { user, roles } = await readRoles();
    const { leastPrivilege, problems, granted } = classifyRoles(roles, config.mongodbDbName);

    console.log(`Connected as: ${user}`);
    console.log(`Roles:        ${granted.length > 0 ? granted.join(', ') : '(none on the application database)'}`);
    console.log(`Database:     ${config.mongodbDbName}`);

    if (leastPrivilege) {
      console.log('\nVERDICT: LEAST PRIVILEGE — the application credential holds only readWrite on its own database.');
      console.log(`No module under src/ issues an administrative command, so "${APPLICATION_WRITE_ROLE}" is sufficient.`);
      return;
    }

    console.error('\nVERDICT: OVER-PRIVILEGED — step 02 gate G3.2 FAILS (spec §39).');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`\nRemediation: ${remediation(config.mongodbDbName)}`);
    process.exitCode = 1;
  } finally {
    await db.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ errName: err && err.name }, 'check-db-privileges failed');
    console.error('check-db-privileges failed.');
    process.exitCode = 1;
  });
}

module.exports = { classifyRoles, ADMINISTRATIVE_ROLES, APPLICATION_WRITE_ROLE };
