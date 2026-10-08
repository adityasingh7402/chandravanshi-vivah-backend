---
step: 05
title: Master Data
status: not_started
build: not_started
audit: not_run
depends_on: [04]
unblocks: [06]
spec_refs: ["§3.1", "§3.2", "§12", "§13", "§14", "§15", "§32", "§60", "§73", "§74", "§75", "§76", "§97", "§102", "§105"]
---

# Step 05 — Master Data

## Goal

Build the shared selectable data every profile form depends on. Master data lives in MongoDB, not duplicated inside
the website and mobile codebases, so both clients call this one API (spec §12, §31 of the fields dictionary). This
step also establishes the single collection pattern, the search endpoint, the deactivate-don't-delete rule, and the
seeding script, so that profile creation in step 06 has a stable vocabulary of IDs to reference.

## Scope

**In scope**

- One generic master-data schema (spec §13) reused across the required collections (spec §127).
- The read API with search, limit, and parent filter (spec §73, fields dictionary §28).
- `community_configs` for the Chandravanshi-specific settings (spec §15).
- `scripts/seed-master-data.js`: idempotent seeding by stable slug (spec §102).
- Active/inactive handling and deactivation instead of deletion (spec §74).
- The Gotra/Surname "request addition" flow's data model (spec §14, §75), extended so a value a user cannot find
  can be submitted **and immediately reused by the next user**.
- The *community context* categories — community, sub-community, surname, gotra, **clan**, **aaspad** — each scoped
  to its parent and never cross-merged (see [`_master-data-community-format.md`](_master-data-community-format.md)).

**Out of scope (do not build now)**

- Admin write endpoints — step 16 owns create/edit/reorder/approve.
- Redis as a shared cache; the client caches instead for now (spec §60, §61).
- Any profile, preference, or matching logic.

**Later**

- Redis cache keys such as `master:occupations` with invalidation on admin update (spec §61, §62).
- Full-text or Atlas Search relevance ranking if prefix search proves insufficient.

**FINAL — addition requests get their own collection (finalized decisions §3).** `master_data_requests` is a
dedicated collection, not an unrelated feature: it is the data store the already-defined Gotra/Surname approval
workflow requires (spec §14, §75). The canonical collection list is therefore extended by it (decisions §19).

**FINAL — a missing value is recorded under the submitting user and becomes an option for everyone (this update).**
This refines decision §3: users still never create an *official* master record, but a value a user cannot find is
**not blocked on admin review before other users can pick it**. The rule:

```text
User cannot find Sub-community / Surname / Gotra / Clan / Aaspad
        ↓
User types the missing value
        ↓
Recorded in the master collection with source = "user" and submittedBy = <userId>
        ↓
The value is immediately selectable by every other user,
flagged in the API as user-contributed (unverified)
        ↓
A master_data_requests row is opened for admin review
        ↓
Admin verifies/promotes  → the value becomes official (verifiedBy/verifiedAt set)
Admin rejects            → the value is deactivated, existing profile references stay valid
```

Two tiers, one collection:

| Tier | `source` | `submittedBy` | `verifiedAt` | How clients treat it |
|---|---|---|---|---|
| Official (seeded or admin-created) | `seed` / `admin` | `null` | set | Normal option |
| User-contributed (unverified) | `user` | the submitter's `userId` | `null` | Selectable, labelled as member-added |

The submitter's `userId` is always stored, so an admin can see who contributed a value. A user can never set
`source`, `submittedBy`, `verifiedBy`, or `verifiedAt` themselves — the server stamps them from the session.

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| Authentication middleware available for protected admin routes later | 04 | `audited_passed` |
| Database connection, base schema, collection constants | 02 | `audited_passed` |

## Deliverables

```text
server/src/models/masterData/MasterItem.js        # generic factory used by every master collection
server/src/models/CommunityConfig.js              # spec §15
server/src/models/MasterDataRequest.js            # dedicated master_data_requests collection (decisions §3)
server/src/services/masterDataRequestService.js   # submitMissing, createRequest, listPending, verify, reject
server/src/services/masterOptionService.js        # findOrCreateUserOption(), normalizeSlug(), mergeAliases()
server/src/services/masterDataService.js          # list(), search(), validateIds(), resolveNames()
server/src/controllers/masterData.controller.js
server/src/routes/masterData.routes.js
server/src/validators/masterData.validators.js
server/scripts/seed-master-data.js
server/src/data/master/*.json                     # seed payloads, one file per collection
server/src/data/master/community.json             # seed payloads from _master-data-community-format.md
server/src/constants/masterData.js                # collection slug -> model mapping, sort defaults, scope rules
server/src/constants/masterCategories.js          # the six community-context categories + which allow user input
```

The name lists in [`_master-data-community-format.md`](_master-data-community-format.md) are the seed input for
`community.json`. Do not hand-copy them into another file.

## Data model

### Generic master item (spec §13)

```js
{
  _id: ObjectId,
  name: String,
  slug: String,
  category: String | null,
  isActive: Boolean,
  sortOrder: Number,
  createdAt: Date,
  updatedAt: Date
}
```

### Collections

Per spec §127 and the fields dictionary §30:

```text
communities            sub_communities      clans             gotras            surnames
aaspads
occupations            industries           degrees           specializations
colleges               universities         countries         states
districts              cities               languages         hobbies
interests
```

`clans` and `aaspads` are community-context categories taken from the community-format source: a **clan** (Rajasthan
and Rajput clans) is not a gotra, and an **aaspad** (Chandravanshi Khati lineage) is neither a gotra nor a surname.
Keeping them in their own collections is what stops them being merged into the gotra list.

Several of these need extra fields:

| Collection | Extra fields | Why |
|---|---|---|
| `states` | `countryId` | Cascading country → state select (fields dictionary §23) |
| `districts` | `stateId` | Cascading select |
| `cities` | `districtId`, optional `coordinates` | Cascading select; coordinates support distance search later |
| `specializations` | `degreeId` or `category` | Degree → specialization cascade |
| `sub_communities` | `communityId` | Community-scoped filtering |
| `surnames`, `gotras`, `clans`, `aaspads` | `communityId` | Community-scoped filtering |
| `gotras` | `communityId`, optional `clanId` | A clan may map to specific gotras (community-format reference) |
| `occupations` | `category` | Industry → role cascade where useful |
| every community-context collection | `source`, `submittedBy`, `verifiedBy`, `verifiedAt`, `aliases` | Official vs user-contributed tier (see below) |

### `master_data_requests` (finalized decisions §3)

```js
{
  _id: ObjectId,
  userId: ObjectId,                       // the requester
  type: "gotra" | "surname" | "sub_community",
  requestedName: String,
  status: "pending" | "approved" | "rejected",
  reviewedBy: ObjectId | null,
  reviewedAt: Date | null,
  createdAt: Date,
  updatedAt: Date
}
```

Only the types the existing master-data workflow actually needs should be enabled. Users never write directly to the
official `gotras` / `surnames` / `sub_communities` collections; only an admin approval does that.

| Index | Definition | Purpose |
|---|---|---|
| pending queue | `{ status: 1, createdAt: -1 }` | Admin review queue (step 16) |
| requester | `{ userId: 1, createdAt: -1 }` | A user's own requests |
| duplicate guard | `{ type: 1, requestedName: 1, status: 1 }` | Catch a repeat request for the same pending name |

### Indexes

| Index | Definition | Purpose |
|---|---|---|
| slug | `{ slug: 1 }` unique within its parent scope | Idempotent seeding and stable references |
| name | `{ name: 1 }` | Anchored prefix search, with a minimum query length |
| aliases | `{ aliases: 1 }` | Alternate spellings resolve to the same row (never a second option) |
| active + sort | `{ isActive: 1, sortOrder: 1 }` | Default list ordering |
| parent | e.g. `{ stateId: 1 }`, `{ degreeId: 1 }` | Cascading filters |

Do not put a leading-wildcard regex against these collections: it cannot use an index and is called out as an
anti-pattern (spec §82). Require a minimum query length and use an anchored prefix match, or a text index.

Indexes must be **scope-aware**, because the same name legitimately exists in more than one context (`Kashyap` is a
Kahar gotra, a Yadav gotra, a Rajput gotra, and a Kahar clan). Uniqueness is therefore per parent scope, not global:

| Index | Definition | Purpose |
|---|---|---|
| scoped slug | `{ communityId: 1, subCommunityId: 1, clanId: 1, slug: 1 }` unique | One row per name per context |
| alias search | `{ aliases: 1 }` | Spelling variants resolve to the existing row (§4.3 surname variants) |
| official first | `{ communityId: 1, verifiedAt: 1, sortOrder: 1 }` | List verified values ahead of user-contributed ones |

### Community context object

Every community-context row and every seed reference is expressed in the six-key shape the community-format source
uses. Keys that do not apply are absent, never empty strings:

```js
community: {
  communityName: String | null,      // "Kahar Chandravanshi Kshatriya"
  subCommunityName: String | null,   // "Batham"
  surnameName: String | null,        // "Prasad"
  gotraName: String | null,          // "Bharadwaj"
  clanName: String | null,           // "Pindwal"
  aaspadName: String | null          // "अजनावद्या"
}
```

**Each context is kept separate, with no cross-merging.** The reference appendix lists every context the source
document provides, and the seeder consumes it directly.

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/master-data/:type` | public or authenticated (decide once) | List/search a master collection |
| GET | `/api/v1/master-data/:type/:id` | same | Single item, for label resolution |
| POST | `/api/v1/master-data/:type/missing` | authenticated | Submit a value the user cannot find; returns the selectable option |

Query parameters: `query` (minimum length enforced), `limit` (capped), `page`/`cursor`, `parentId` where applicable,
`activeOnly` defaulting to true.

Every community-context option carries its origin so a client can label it:

```json
{ "_id": "...", "name": "Batham", "isUserContributed": true, "verifiedAt": null }
```

```http
GET  /api/v1/master-data/occupations?query=software&limit=20
GET  /api/v1/master-data/cities?stateId=...&query=delhi&limit=20
POST /api/v1/master-data/gotras/missing
     { "name": "Kashyappa", "communityId": "...", "clanId": null }
```

`POST :type/missing` is the "can't find it?" path. It is available only for the community-context categories that
allow user input, it is idempotent against the scoped slug, and it returns a normal selectable option so the client
can immediately put it on the profile.

## Build tasks

- [ ] 1. Write `models/masterData/MasterItem.js` exporting a factory that builds a model per collection from the
      generic schema plus a per-collection extra-field spec, all applying the base plugin.
- [ ] 2. Write `constants/masterData.js`: the slug → model map, allowed query parameters, default sort, and a
      numeric cap for `limit`.
- [ ] 3. Write `services/masterDataService.js`:
      `list({ type, query, limit, parentId, activeOnly })` using an allowlisted query object —
      never `Model.find(req.query)` (spec §35) — plus `validateIds(type, ids)` and `resolveNames()`.
- [ ] 4. Write the validators: type must be a known slug; `query` has a minimum and maximum length; `limit` is a
      bounded integer; `parentId` is a valid ObjectId.
- [ ] 5. Write controller and routes. Apply caching headers (`Cache-Control`) suitable for slowly changing public
      data, and note that the client cache is the primary layer (spec §60).
- [ ] 6. Write `models/CommunityConfig.js` per spec §15 and seed the single Chandravanshi record, including
      `settings.requireProfilePhoto` and `rules.sameGotraAllowed`, with a comment that the rule values are product
      decisions to confirm, not assumptions (spec §15).
- [ ] 7. Create `data/master/*.json` seed payloads. Use the starter lists from the fields dictionary (§4–§10, §15)
      for gotras, surnames, occupations, industries, degrees, specializations, languages, hobbies, and interests,
      and a real location hierarchy for countries/states/districts/cities.
- [ ] 8. Write `scripts/seed-master-data.js`: upsert by `slug`, never duplicate on re-run; report created vs updated
      counts; support `--type` to seed one collection; exit non-zero on error (spec §102).
- [ ] 9. Implement `MasterDataRequest` (dedicated `master_data_requests` collection, decisions §3) and its service
      functions (`createRequest`, `listPending`, `verify`, `reject`) for the Gotra/Surname flow (spec §14, §75).
      The requester is taken from the session.
- [ ] 9b. Implement `masterOptionService.findOrCreateUserOption({ type, name, communityId, subCommunityId, clanId }, userId)`:
      normalise the name to a slug, look it up **within the parent scope**, and either return the existing row (so a
      second user submitting the same name gets the existing option and no duplicate is created) or insert a new row
      with `source: "user"`, `submittedBy: userId`, `verifiedAt: null`, `isActive: true`. Always open the matching
      `master_data_requests` row for admin review, and return the option so the caller can select it immediately.
- [ ] 10. Implement `validateIds()` so step 06 can reject a profile referencing a missing, wrong-type, or inactive
      master record (spec §97).
- [ ] 11. Run the seeder and confirm re-running it changes nothing but timestamps.
- [ ] 12. Implement the community-context seed from [`_master-data-community-format.md`](_master-data-community-format.md):
      create the communities, sub-communities, surnames, gotras, clans, and aaspads in the right parent scopes, with
      the documented clan → gotra mappings, and register the Chandravanshi surname spelling variants as `aliases`
      rather than as separate options.
- [ ] 13. Write `constants/masterCategories.js`: which of the six categories allow user input, and the `.missing`
      path for each. Community itself is **not** user-inputtable — the platform controls it (fields dictionary §4.1).
- [ ] 14. Make every list/search response include `isUserContributed` and `verifiedAt`, and sort verified values
      ahead of user-contributed ones at equal relevance.

## Business rules & security

- **Allowlisted inputs only:** `type` is matched against a known slug map; unknown types 404 rather than touching an
  arbitrary collection (spec §35).
- **Bounded search:** minimum query length, capped `limit`, no leading-wildcard regex against large collections
  (spec §73, §82).
- **Deactivate, never hard-delete** where profiles may still reference a value; deactivated items stay valid for old
  records and disappear from new selections (spec §74, §97).
- **Official vs user-contributed is a server-stamped flag, never a client field.** A request body cannot set
  `source`, `submittedBy`, `verifiedBy`, or `verifiedAt`; the server derives them from the session (spec §35).
- **A user-contributed value is attributable:** it always carries `submittedBy` = the submitting user's `userId`, so
  an admin can see who added it. It is never anonymous.
- **Users never create *official* records.** Submitting a missing value creates a user-contributed option and an admin
  review row; promoting it to official (setting `verifiedBy`/`verifiedAt`) is an admin action (spec §75, fields
  dictionary §21).
- **Allowing a missing value is not the same as allowing an unbounded list.** The `.missing` path is authenticated,
  rate limited, scoped to a known category and parent, deduplicated by scoped slug, and length-capped.
- **Spelling variants must not fork the list.** `Kashyap`/`Kasyapa`, `गुन्घोडिया`/`गुनघोड़ना`, and the Chandravanshi
  surname spellings are stored as `aliases` on one row, never as competing options (fields dictionary §4.4).
- **Community is platform-controlled:** the accepted community is not user-created (fields dictionary §4.1).
- **Scope is part of identity:** the same name in two contexts is two rows; searches and `validateIds()` are always
  scoped by parent so a Kahar clan can never be selected as a Yadav gotra.
- **No sensitive data in master data:** these collections are lookup vocabulary only (spec §64).

## Config / environment additions

```text
MASTER_SEARCH_MIN_LEN    # minimum query length before a search runs
MASTER_SEARCH_MAX_LIMIT  # hard cap on returned rows
MASTER_DEFAULT_LIMIT     # default page size
MASTER_MISSING_MAX_LEN   # cap on a user-submitted value
MASTER_MISSING_ENABLED   # per-category switch for the user-contributed option path
```

## Verification commands

```bash
# 1. List occupations (default page)
curl -sS 'http://localhost:3000/api/v1/master-data/occupations'
# Expected: 200, bounded list, ignored inactive items by default

# 2. Search
curl -sS 'http://localhost:3000/api/v1/master-data/occupations?query=software&limit=20'
# Expected: matching subset only

# 3. Cascading location
curl -sS 'http://localhost:3000/api/v1/master-data/states?parentId=<countryId>'
curl -sS 'http://localhost:3000/api/v1/master-data/cities?parentId=<districtId>&query=del'
# Expected: only children of the given parent

# 4. Unknown collection
curl -sS -o /dev/null -w '%{http_code}\n' 'http://localhost:3000/api/v1/master-data/users'
# Expected: 404, no data leak

# 5. Limit cap honoured
curl -sS 'http://localhost:3000/api/v1/master-data/cities?limit=100000'
# Expected: returns at most the configured maximum

# 6. Seeder idempotency
node scripts/seed-master-data.js && node scripts/seed-master-data.js
# Expected: second run reports 0 created, same total; no duplicate slugs

# 7. Unbounded query rejection
curl -sS -o /dev/null -w '%{http_code}\n' 'http://localhost:3000/api/v1/master-data/occupations?query=a'
# Expected: 400 (below minimum query length), not a full collection scan

# 8. A value the user cannot find is recorded under that user and becomes selectable
curl -sS -X POST http://localhost:3000/api/v1/master-data/gotras/missing \
  -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -d '{"name":"Kashyappa","communityId":"<kaharId>"}'
# Expected: 201 with isUserContributed true, verifiedAt null, and an _id the profile can reference

# 9. The next user sees the option the first user added
curl -sS -H "Authorization: Bearer $OTHER_ACCESS" \
  'http://localhost:3000/api/v1/master-data/gotras?query=Kashyappa&parentId=<kaharId>'
# Expected: the contributed option is returned, flagged, without any admin action

# 10. The same missing value twice does not duplicate
#   Re-run command 8 with the same name and parent scope.
# Expected: the same _id is returned; exactly one row and two review requests

# 11. A user cannot mark their own value official
curl -sS -X POST http://localhost:3000/api/v1/master-data/gotras/missing \
  -H "Authorization: Bearer $ACCESS" -H 'Content-Type: application/json' \
  -d '{"name":"Forged","communityId":"<kaharId>","verifiedAt":"2026-01-01","source":"admin"}'
# Expected: 400 (unknown/forbidden fields rejected)

# 12. The submitter is recorded
#   Inspect the created row.
# Expected: submittedBy equals the submitting account's userId

# 13. Seeded community contexts stay separate
#   Query a name that exists in two contexts (e.g. "Kashyap").
curl -sS 'http://localhost:3000/api/v1/master-data/gotras?query=Kashyap'
# Expected: the Kahar, Yadav, and Rajput rows are distinct records, not one merged option
```

## Audit checklist

### Gate 1 — Build integrity

- [ ] **G1.1** Every deliverable exists; all required collections are registered in `constants/masterData.js`.
- [ ] **G1.2** Server boots; the seeder runs standalone with no app boot required beyond the DB connection.
- [ ] **G1.3** Steps 01–04 verification commands still pass.

### Gate 2 — Functional

- [ ] **G2.1** Every collection in the canonical list is reachable through `GET /master-data/:type` and returns items.
- [ ] **G2.2** Search matches expected terms and returns only active items by default.
- [ ] **G2.3** Cascading filters return only children of the supplied parent.
- [ ] **G2.4** Each cascade's parent chain is correct (city → district → state → country), verified against a small
      sample of real rows.
- [ ] **G2.5** `activeOnly=false` returns deactivated items for admin/back-office use, while the default excludes them.
- [ ] **G2.6** `validateIds()` rejects a missing ID, an ID from the wrong collection, and an inactive ID, each with a
      distinct message.
- [ ] **G2.7** Re-running the seeder creates no duplicates and preserves `_id` for existing slugs.
- [ ] **G2.8** The Chandravanshi `community_configs` record exists and exposes its settings.
- [ ] **G2.9** `POST /master-data/:type/missing` creates a selectable option for a value that does not exist, and the
      next user's list query returns it without any admin action.
- [ ] **G2.10** Submitting the same missing name twice returns the same option `_id`; no duplicate row is created.
- [ ] **G2.11** The seeded community contexts match the appendix: sub-communities under their community, clans in
      `clans`, aaspads in `aaspads`, and the documented clan → gotra mappings present.
- [ ] **G2.12** A name that exists in two contexts returns two scoped options and selecting the wrong scope is
      rejected by `validateIds()`.

### Gate 3 — Security

- [ ] **G3.1** An unknown `:type` cannot reach any collection outside the allowlist, including `users` and `sessions`.
- [ ] **G3.2** Query-shaped values (for example `query[$ne]=`) are rejected or coerced to a string, never passed as an
      object (spec §35).
- [ ] **G3.3** `limit` cannot exceed the configured maximum; an oversized `limit` is clamped or rejected.
- [ ] **G3.4** No error from a master-data route reveals a collection name or driver detail.
- [ ] **G3.5** A user cannot create an **official** record: every user-submitted option has `source: "user"` and
      `submittedBy` set from the session, and a request body cannot set `source`, `submittedBy`, `verifiedBy`,
      `verifiedAt`, `status`, `reviewedBy`, or `reviewedAt` (spec §75, decisions §3).
- [ ] **G3.6** `submittedBy` on every user-contributed row equals the authenticated caller, verified by submitting
      from two accounts and comparing.
- [ ] **G3.7** The `.missing` path is rate limited, length capped, restricted to categories that allow user input,
      and refuses a `communityName` (the platform-controlled category, fields dictionary §4.1).

### Gate 4 — Performance & data

- [ ] **G4.1** `explain("executionStats")` on the search query shows `IXSCAN` on the name or slug index, not `COLLSCAN`.
- [ ] **G4.2** A sub-minimum-length search is refused before querying, and a maximum-length search is still bounded.
- [ ] **G4.3** Listing response payloads are small (no unnecessary fields), supporting the client-cache strategy.

### Gate 5 — Spec conformance

- [ ] **G5.1** §13 — the generic document shape is used consistently; extra fields appear only where justified.
- [ ] **G5.2** §73 / §74 — search parameters and the deactivate-don't-delete rule are implemented.
- [ ] **G5.3** §75 / §14 — Gotra/Surname additions go through review, not direct creation.
- [ ] **G5.4** §76 — the country/state/district/city hierarchy is structured, and no exact address is stored here.
- [ ] **G5.5** §97 — referenced master IDs are validated before use by other steps.
- [ ] **G5.6** §102 — seeding is idempotent and slug-stable.
- [ ] **G5.7** §60 — no server-side cache is introduced; the client caches.
- [ ] **G5.8** fields dictionary §4.2–§4.4 — the sub-community, surname (including the "can't find it?" path), and
      gotra rules are honoured, and standardised gotra values are not forked by spelling variants.
- [ ] **G5.9** community format — clan and aaspad are their own categories, contexts are not cross-merged, and the
      submitted `userId` is retained on every user-contributed value.

### Verdict

| | |
|---|---|
| Gate 1 | ☐ pass ☐ fail |
| Gate 2 | ☐ pass ☐ fail |
| Gate 3 | ☐ pass ☐ fail |
| Gate 4 | ☐ pass ☐ fail |
| Gate 5 | ☐ pass ☐ fail |
| **Result** | ☐ PASS ☐ PASS WITH NOTES ☐ FAIL |

## Acceptance criteria

- [ ] Both clients can populate every selectable field from this one API.
- [ ] Search is bounded and index-backed.
- [ ] Seeding is idempotent and reproducible.
- [ ] Deactivation preserves old references while hiding values from new selections.
- [ ] Step 06 can validate every ID a profile submits.

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence | |
| Fixes required | |
