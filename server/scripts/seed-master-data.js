'use strict';

/**
 * Master-data seeder (spec §102; step 05 tasks 7, 8, 12).
 *
 * Run:  node scripts/seed-master-data.js [--type <type>]
 *
 * Idempotent by stable slug: re-running creates nothing new and reports the
 * same totals. The seed payloads live in `src/data/master/*.json`; the community
 * payload is the raw tuple list extracted verbatim from the community-format
 * appendix, so the names cannot drift by hand.
 *
 *   countries  states  districts  cities
 *   degrees    specializations
 *   occupations industries colleges universities languages hobbies interests
 *   community            (communities, sub-communities, surnames, gotras,
 *                         clans, aaspads + the documented clan -> gotra links)
 *   community_config     (the single Chandravanshi record, spec §15)
 *
 * An admin-edited row (source "admin") or a user-contributed row (source
 * "user") is never overwritten by a re-seed — only rows whose source is "seed"
 * are refreshed.
 */

const fs = require('fs');
const path = require('path');
const { connect, disconnect } = require('../src/config/db');
const { getMasterModel, buildMasterIdentity } = require('../src/models/masterData/MasterItem');
const { getMasterDescriptor } = require('../src/constants/masterData');
const CommunityConfig = require('../src/models/CommunityConfig');
const { normaliseName } = require('../src/utils/slug');
const { logger } = require('../src/middleware/requestLogger');

const DATA_DIR = path.join(__dirname, '..', 'src', 'data', 'master');

/** Which master collection resolves a cascade/parent field. */
const PARENT_FIELD_TYPES = Object.freeze({
  countryId: 'countries',
  stateId: 'states',
  districtId: 'districts',
  degreeId: 'degrees',
  communityId: 'communities',
  clanId: 'clans'
});

/**
 * Seeding order matters: a parent collection is seeded before the children that
 * reference its slugs, so an unknown parent slug is a hard error rather than a
 * silently dropped row.
 */
const SIMPLE_SEED_ORDER = Object.freeze([
  'countries',
  'states',
  'districts',
  'cities',
  'degrees',
  'specializations',
  'occupations',
  'industries',
  'colleges',
  'universities',
  'languages',
  'hobbies',
  'interests'
]);

/**
 * The single Chandravanshi configuration (spec §15).
 *
 * `rules.sameGotraAllowed` and `settings.requireProfilePhoto` are PRODUCT
 * DECISIONS TO CONFIRM with the community stakeholders — they are seeded
 * defaults, deliberately configurable rather than hardcoded.
 */
const COMMUNITY_CONFIG_SEED = Object.freeze({
  name: 'Chandravanshi',
  slug: 'chandravanshi',
  isActive: true,
  settings: { requireProfilePhoto: true, requirePhoneLogin: false },
  rules: { sameGotraAllowed: false }
});

function readJson(file) {
  const full = path.join(DATA_DIR, file);
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

/** A stable string for one row's unique (scope + slug) key. */
function keyOf(scopeFields, document) {
  const parts = scopeFields.map((field) => (document[field] ? String(document[field]) : ''));
  return [...parts, document.slug].join('|');
}

/**
 * Insert-or-update a batch of master rows, keyed by scope + slug.
 *
 * @param {import('mongoose').Model} model
 * @param {object} descriptor
 * @param {Array<object>} documents fully-built documents (scope fields included)
 * @param {{created:number, updated:number, skipped:number}} report
 */
async function upsertMany(model, descriptor, documents, report) {
  const scopeFields = descriptor.uniqueWith || [];
  const slugs = [...new Set(documents.map((doc) => doc.slug))];
  const select = ['_id', 'slug', 'source', ...scopeFields].join(' ');
  const existing = await model.find({ slug: { $in: slugs } }).select(select).lean();
  const byKey = new Map(existing.map((doc) => [keyOf(scopeFields, doc), doc]));

  const toInsert = [];
  const toUpdate = [];

  for (const document of documents) {
    const key = keyOf(scopeFields, document);
    const current = byKey.get(key);
    if (!current) {
      toInsert.push(document);
      continue;
    }
    // Never clobber an admin edit or a user-contributed value on a re-seed.
    if (descriptor.scoped && current.source && current.source !== 'seed') {
      report.skipped += 1;
      continue;
    }
    toUpdate.push({ _id: current._id, document });
  }

  if (toInsert.length > 0) {
    await model.insertMany(toInsert, { ordered: false });
    report.created += toInsert.length;
  }
  for (const entry of toUpdate) {
    await model.updateOne({ _id: entry._id }, { $set: entry.document });
    report.updated += 1;
  }
}

/** The seed-defined portion of a row (identity + ordering + extra + scope). */
function buildRow(descriptor, type, item, index, scopeValues = {}) {
  const identity = buildMasterIdentity(type, item);
  const row = {
    ...identity,
    sortOrder: item.sortOrder === undefined ? index + 1 : item.sortOrder,
    category: item.category ?? null
  };
  if (item.coordinates) row.coordinates = item.coordinates;
  for (const key of descriptor.uniqueWith || []) {
    if (scopeValues[key] !== undefined) row[key] = scopeValues[key];
  }
  if (descriptor.scoped) {
    row.source = 'seed';
    row.verifiedAt = item.verifiedAt === undefined ? new Date() : item.verifiedAt;
  }
  return row;
}

/**
 * A parent value can be a single slug, an array of slugs (a name that legitimately
 * exists under several parents) or absent (parent null).
 */
function parentSlugsOf(item, hasParent) {
  if (!hasParent) return [null];
  if (Array.isArray(item.parent)) return item.parent.length ? item.parent : [null];
  return item.parent ? [item.parent] : [null];
}

/** Seed one of the simple (non-community) collections. */
async function seedSimple(type, report) {
  const descriptor = getMasterDescriptor(type);
  const model = getMasterModel(type);
  const items = readJson(`${type}.json`);
  const parentField = descriptor.cascadeParent;
  const parentType = parentField ? PARENT_FIELD_TYPES[parentField] : null;

  let parentIdBySlug = new Map();
  if (parentType) {
    const parentModel = getMasterModel(parentType);
    const parents = await parentModel.find({}).select('slug').lean();
    parentIdBySlug = new Map(parents.map((doc) => [doc.slug, doc._id]));
  }

  const documents = [];
  items.forEach((item, index) => {
    for (const parentSlug of parentSlugsOf(item, Boolean(parentField))) {
      let scopeValue = null;
      if (parentField && parentSlug) {
        const resolved = parentIdBySlug.get(parentSlug);
        if (!resolved) {
          throw new Error(`${type}: "${item.name}" references unknown parent "${parentSlug}".`);
        }
        scopeValue = resolved;
      }
      if (parentField && !scopeValue) {
        throw new Error(`${type}: "${item.name}" has no parent; a parent is required for this collection.`);
      }
      documents.push(buildRow(descriptor, type, item, index, parentField ? { [parentField]: scopeValue } : {}));
    }
  });

  await upsertMany(model, descriptor, documents, report);
  console.log(`  ${type}: ${documents.length} rows (${report.created} created, ${report.updated} updated so far)`);
}

/**
 * Seed the community-context collections from the raw tuple list, keeping every
 * context separate and never cross-merging (step 05 task 12).
 */
async function seedCommunity(report) {
  const tuples = readJson('community.json');

  // --- collect, preserving source order -----------------------------------
  const communities = new Map();
  const subCommunities = new Map();
  const surnames = new Map();
  const gotras = new Map();
  const clans = new Map();
  const aaspads = new Map();
  /** `${communityName}|${clanName}` -> Set(gotraName) */
  const clanGotraLinks = new Map();
  /** Surname spellings with no community: aliases of one row, never options. */
  const surnameVariants = new Set();

  const addTo = (map, key, value) => {
    if (!map.has(key)) map.set(key, value);
  };

  for (const tuple of tuples) {
    const communityName = tuple.communityName ? normaliseName(tuple.communityName) : null;
    if (communityName) addTo(communities, communityName, { name: communityName });
    if (communityName && tuple.subCommunityName) {
      addTo(subCommunities, `${communityName}|${tuple.subCommunityName}`, {
        name: normaliseName(tuple.subCommunityName),
        communityName
      });
    }
    if (communityName && tuple.surnameName) {
      addTo(surnames, `${communityName}|${tuple.surnameName}`, {
        name: normaliseName(tuple.surnameName),
        communityName
      });
    }
    if (!communityName && tuple.surnameName) surnameVariants.add(normaliseName(tuple.surnameName));

    if (communityName && tuple.gotraName) {
      addTo(gotras, `${communityName}|${tuple.gotraName}`, {
        name: normaliseName(tuple.gotraName),
        communityName
      });
    }
    if (communityName && tuple.clanName) {
      addTo(clans, `${communityName}|${tuple.clanName}`, {
        name: normaliseName(tuple.clanName),
        communityName
      });
    }
    if (communityName && tuple.clanName && tuple.gotraName) {
      const key = `${communityName}|${tuple.clanName}`;
      if (!clanGotraLinks.has(key)) clanGotraLinks.set(key, new Set());
      clanGotraLinks.get(key).add(normaliseName(tuple.gotraName));
    }
    if (communityName && tuple.aaspadName) {
      addTo(aaspads, `${communityName}|${tuple.aaspadName}`, {
        name: normaliseName(tuple.aaspadName),
        communityName
      });
    }
  }

  // --- communities (platform-controlled; no parent scope) -----------------
  const communityModel = getMasterModel('communities');
  const communityDescriptor = getMasterDescriptor('communities');
  const communityDocs = [];
  let communityIndex = 0;
  for (const { name } of communities.values()) {
    communityDocs.push(buildRow(communityDescriptor, 'communities', { name }, communityIndex));
    communityIndex += 1;
  }
  await upsertMany(communityModel, communityDescriptor, communityDocs, report);
  console.log(`  communities: ${communityDocs.length} rows (${report.created} created, ${report.updated} updated so far)`);

  const allCommunities = await communityModel.find({}).select('_id name').lean();
  const communityIdByName = new Map(allCommunities.map((doc) => [doc.name, doc._id]));
  const idOfCommunity = (name) => {
    const id = communityIdByName.get(name);
    if (!id) throw new Error(`community: "${name}" was not seeded.`);
    return id;
  };

  // --- sub-communities, surnames, gotras, clans, aaspads ------------------
  const scopedDocs = (entries, type) => {
    const descriptor = getMasterDescriptor(type);
    const docs = [];
    let index = 0;
    for (const entry of entries) {
      const scope = { communityId: idOfCommunity(entry.communityName), subCommunityId: null, clanId: null };
      docs.push(buildRow(descriptor, type, { name: entry.name }, index, scope));
      index += 1;
    }
    return docs;
  };

  const subCommunityDocs = scopedDocs(subCommunities.values(), 'sub_communities');
  await upsertMany(getMasterModel('sub_communities'), getMasterDescriptor('sub_communities'), subCommunityDocs, report);
  console.log(`  sub_communities: ${subCommunityDocs.length} rows`);

  // The Chandravanshi surname spelling variants become `aliases` on one row,
  // never separate options (fields dictionary §4.4).
  const canonicalSurname = 'Chandravanshi';
  const surnameAliasList = [...surnameVariants]
    .map((value) => value.toLowerCase())
    .filter((value) => value !== canonicalSurname.toLowerCase());
  const surnameDocs = scopedDocs(surnames.values(), 'surnames');
  const surnameDescriptor = getMasterDescriptor('surnames');
  surnameDocs.push({
    ...buildRow(surnameDescriptor, 'surnames', { name: canonicalSurname }, surnameDocs.length, {
      communityId: null,
      subCommunityId: null,
      clanId: null
    }),
    aliases: surnameAliasList
  });
  await upsertMany(getMasterModel('surnames'), surnameDescriptor, surnameDocs, report);
  console.log(`  surnames: ${surnameDocs.length} rows (${surnameAliasList.length} spelling aliases)`);

  const gotraDocs = scopedDocs(gotras.values(), 'gotras');
  await upsertMany(getMasterModel('gotras'), getMasterDescriptor('gotras'), gotraDocs, report);
  console.log(`  gotras: ${gotraDocs.length} rows`);

  const clanDocs = scopedDocs(clans.values(), 'clans');
  await upsertMany(getMasterModel('clans'), getMasterDescriptor('clans'), clanDocs, report);
  console.log(`  clans: ${clanDocs.length} rows`);

  const aaspadDocs = scopedDocs(aaspads.values(), 'aaspads');
  await upsertMany(getMasterModel('aaspads'), getMasterDescriptor('aaspads'), aaspadDocs, report);
  console.log(`  aaspads: ${aaspadDocs.length} rows`);

  // --- documented clan -> gotra links (never inferred) ---------------------
  const gotraModel = getMasterModel('gotras');
  const clanModel = getMasterModel('clans');
  let linked = 0;
  for (const [key, gotraNames] of clanGotraLinks) {
    const [communityName, clanName] = key.split('|');
    const communityId = idOfCommunity(communityName);
    const clan = await clanModel.findOne({ communityId, slug: buildMasterIdentity('clans', { name: clanName }).slug });
    if (!clan) continue;
    const gotraIds = [];
    for (const gotraName of gotraNames) {
      const slug = buildMasterIdentity('gotras', { name: gotraName }).slug;
      const gotra = await gotraModel.findOne({ communityId, slug });
      if (gotra) gotraIds.push(gotra._id);
    }
    if (gotraIds.length > 0) {
      clan.gotraIds = gotraIds;
      await clan.save();
      linked += 1;
    }
  }
  console.log(`  clan -> gotra links: ${linked}`);
}

/** Seed the single community configuration record (spec §15). */
async function seedCommunityConfig(report) {
  const existing = await CommunityConfig.findOne({ slug: COMMUNITY_CONFIG_SEED.slug });
  if (!existing) {
    await CommunityConfig.create(COMMUNITY_CONFIG_SEED);
    report.created += 1;
    console.log('  community_config: 1 created');
    return;
  }
  report.skipped += 1;
  console.log('  community_config: already present');
}

/** Which of the simple collections a `--type` value can name. */
function isSimpleType(type) {
  return SIMPLE_SEED_ORDER.includes(type);
}

function parseArgs(argv) {
  const args = { type: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--type') args.type = argv[index + 1];
    else if (arg.startsWith('--type=')) args.type = arg.slice('--type='.length);
  }
  return args;
}

function printHelp() {
  console.log('Usage: node scripts/seed-master-data.js [--type <type>]');
  console.log(`  types: community, community_config, ${SIMPLE_SEED_ORDER.join(', ')}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const report = { created: 0, updated: 0, skipped: 0 };
  const only = args.type;

  if (only && !isSimpleType(only) && only !== 'community' && only !== 'community_config') {
    throw new Error(`Unknown --type "${only}". Use --help to list valid types.`);
  }

  console.log('Seeding master data...');
  if (!only) console.log('  (community contexts and community_config are seeded by default)');

  for (const type of SIMPLE_SEED_ORDER) {
    if (!only || only === type) await seedSimple(type, report);
  }
  if (!only || only === 'community') await seedCommunity(report);
  if (!only || only === 'community_config') await seedCommunityConfig(report);

  console.log(`\nDone. ${report.created} created, ${report.updated} updated, ${report.skipped} left untouched.`);
}

if (require.main === module) {
  (async () => {
    try {
      await connect();
      await main();
    } catch (err) {
      // Never print a connection string; the message is the seed error only.
      console.error(`\nSeed failed: ${err && err.message}`);
      process.exitCode = 1;
    } finally {
      try {
        await disconnect();
      } catch (err) {
        logger.error({ errName: err && err.name }, 'seed-master-data: disconnect failed');
      }
    }
  })();
}

module.exports = { main, SIMPLE_SEED_ORDER, COMMUNITY_CONFIG_SEED, PARENT_FIELD_TYPES };
