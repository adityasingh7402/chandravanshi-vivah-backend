---
step: 09
title: Discover / Search
status: not_started
build: not_started
audit: not_run
depends_on: [07, 08]
unblocks: [10]
spec_refs: ["§3.2", "§3.3", "§9", "§18", "§35", "§45", "§46", "§47", "§48", "§49", "§50", "§51", "§52", "§53", "§54", "§55", "§56", "§59", "§65", "§66", "§70", "§82", "§83", "§99", "§105", "§106", "§108", "§109", "§119", "§120"]
---

# Step 09 — Discover / Search

## Goal

Build the performance-critical read path: candidate discovery driven entirely by the `matrimonial_profiles`
collection with an allowlisted filter builder, date-of-birth range conversion, optional distance search, a small
projection, bounded cursor pagination, a controlled sort set, and system exclusions. This is where the specification's
speed strategy concentrates (spec §65, §82, §108), so the step's audit focuses on measured query plans rather than
appearance.

## Scope

**In scope**

- `GET /discover` with explicit filters plus mandatory system filters and exclusions (spec §56, §83, §99).
- `GET /search` as the explicit-filter query without preference merging.
- `GET /recommendations` with the deterministic scoring model (spec §54, §55).
- Allowlisted filter construction (spec §35, §46, §119).
- Age → date-of-birth range conversion (spec §47).
- Geo `$near` distance filter with a `2dsphere` index (spec §48).
- Projection limited to the card fields (spec §51, §108).
- Cursor pagination (spec §52) and an allowlisted sort map (spec §53).
- Compound indexes justified by measured query patterns (spec §49, §50).
- Exclusion of self, blocked pairs, and ineligible profiles (spec §56, §99).

**Out of scope (do not build now)**

- Any AI ranking; deterministic weights only (spec §54, §115).
- Caching the result set server-side; Redis is deferred (spec §61).
- Saving searches or alerts.

**Later**

- Redis caching for master data and hot filters once measurements justify it (spec §61, §62).
- Atlas Search if the deterministic index strategy stops meeting the measured target (spec §50, §123).

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| Partner preferences and `effectiveFilters()` | 07 | `audited_passed` |
| Photos with a primary, approved, transformed card URL | 08 | `audited_passed` |
| Profile indexes and DTO layer | 06 | `audited_passed` |

> Steps 10–12 do not exist yet. Until they do, the block/report and pass exclusions are implemented against an empty
> exclusion set via a small interface (`exclusionService.getExcludedUserIds(userId)`), so steps 10 and 12 can extend
> it without rewriting the query builder. The regression watchlist in the tracker requires re-running this step's
> G1/G3 checks after those steps are audited.

## Deliverables

```text
server/src/services/searchService.js          # orchestrates the discover/search/recommendations flows
server/src/services/queryBuilder.js           # allowlisted filter construction (spec §46, §119)
server/src/services/exclusionService.js       # self, blocked, ineligible exclusions (spec §56, §99)
server/src/services/recommendationService.js  # deterministic scoring + ranking (spec §54, §55)
server/src/services/dateRange.js              # age -> DOB range conversion (spec §47)
server/src/services/geoSearch.js              # distance filter builder (spec §48)
server/src/services/cursor.js                 # opaque cursor encode/decode (spec §52)
server/src/controllers/discover.controller.js
server/src/routes/discover.routes.js
server/src/validators/search.validators.js    # filter, sort, limit, cursor allowlists
server/src/constants/search.js                # allowed filters, allowed sorts, page sizes, score weights
server/src/utils/projections.js               # the card projection reused everywhere (spec §51, §108)
```

## Data model

No new collection. This step adds **indexes to `matrimonial_profiles`** (and reads `partner_preferences`,
`photos`, and the exclusion collections).

### Query shape (spec §46, §119)

```js
const query = { "profile.status": "active" };

if (gender)            query["basic.gender"] = gender;
if (maritalStatus)     query["basic.maritalStatus"] = { $in: maritalStatus };
if (dobRange)          query["basic.dateOfBirth"] = { $gte: dobRange.from, $lte: dobRange.to };
if (heightRange)       query["basic.heightCm"] = { $gte: heightRange.min, $lte: heightRange.max };
if (communityId)       query["community.communityId"] = communityId;
if (gotraIds?.length)  query["community.gotraId"] = { $in: gotraIds };
if (surnameIds?.length) query["community.surnameId"] = { $in: surnameIds };
if (cityIds?.length)   query["location.cityId"] = { $in: cityIds };
if (stateIds?.length)  query["location.stateId"] = { $in: stateIds };
if (occupationIds?.length) query["career.occupationId"] = { $in: occupationIds };
if (degreeIds?.length) query["education.degreeId"] = { $in: degreeIds };
if (diet?.length)      query["lifestyle.diet"] = { $in: diet };
if (employmentType?.length) query["career.employmentType"] = { $in: employmentType };
if (incomeRanges?.length) query["career.incomeRange"] = { $in: incomeRanges };
if (familyTypes?.length) query["family.familyType"] = { $in: familyTypes };
if (verifiedOnly)      query["profile.isVerified"] = true;
if (hasPhotoOnly)      query["profile.hasPrimaryPhoto"] = true;
if (excludedUserIds.length) query["userId"] = { $nin: excludedUserIds };
```

Every key above is written literally in the builder. **No user-supplied key ever becomes a query key** (spec §35, §46).

### Sorting (spec §53)

| Allowed value | Maps to |
|---|---|
| `recently_active` | `{ "profile.lastActiveAt": -1, _id: -1 }` |
| `newly_joined` | `{ createdAt: -1, _id: -1 }` |
| `recommended` | computed ranking stage, then a stable tiebreak by `_id` |

Any other `sort` value is rejected.

### Projection (spec §51, §70, §108)

```js
{
  publicProfileId: 1,
  "basic.firstName": 1, "basic.dateOfBirth": 1, "basic.heightCm": 1,
  "community.surnameName": 1, "community.gotraName": 1,
  "location.cityName": 1,
  "education.degreeName": 1,
  "career.occupationName": 1,
  "profile.isVerified": 1, "profile.lastActiveAt": 1
}
```

`age` is computed from `dateOfBirth` at serialisation; never stored.

### Index plan

Create indexes only where a measured query plans to use them (spec §49, §50). Starting candidates:

| Index | Justification |
|---|---|
| `{ "profile.status": 1, "basic.gender": 1, "basic.dateOfBirth": 1 }` | Default discover filter: active + gender + age range |
| `{ "profile.status": 1, "basic.gender": 1, "location.cityId": 1 }` | Common location-filtered discover |
| `{ "profile.status": 1, "basic.gender": 1, "career.occupationId": 1 }` | Occupation filter |
| `{ "profile.status": 1, "community.gotraId": 1 }` | Community filter |
| `{ "profile.status": 1, "profile.lastActiveAt": -1 }` | Recency sort without a full scan |
| `{ "location.coordinates": "2dsphere" }` | Distance search (spec §48) |

Do not assume one giant compound index covers every combination (spec §49). Validate each with `explain("executionStats")`
and record the outcome in this step's sign-off.

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/discover` | authenticated | Preference-driven candidate list |
| GET | `/api/v1/search` | authenticated | Explicit-filter search, no preference merge |
| GET | `/api/v1/recommendations` | authenticated | Ranked candidate list |

Query parameters (allowlisted, bounded): `gender`, `minAge`, `maxAge`, `minHeightCm`, `maxHeightCm`, `maritalStatus`,
`communityId`, `subCommunityId`, `surnameId`, `gotraId`, `countryId`, `stateId`, `districtId`, `cityId`, `lat`, `lng`,
`maxDistanceKm`, `degreeId`, `specializationId`, `occupationId`, `industryId`, `employmentType`, `incomeRange`,
`diet`, `smoking`, `drinking`, `familyType`, `verified`, `hasPhoto`, `sort`, `limit`, `cursor`.

Response (spec §120):

```json
{
  "success": true,
  "data": { "items": [ { "profileId": "CHV-82A91", "name": "...", "age": 27, "height": "5'7\"",
             "city": "Delhi", "degree": "MCA", "occupation": "Software Engineer", "surname": "...",
             "gotra": "...", "verified": true, "primaryPhoto": "<optimized-url>" } ],
            "nextCursor": "<opaque-value>" }
}
```

## Build tasks

- [ ] 1. Write `constants/search.js`: the allowed filter names, allowed sort values, page size default/maximum, and
      the recommendation weights from spec §54 as configurable constants.
- [ ] 2. Write `services/queryBuilder.js`: a single function that takes a validated filter object and returns the
      literal-flattened Mongo query from the table above. No dynamic key assignment from user input, no `$where`,
      no raw `find(req.query)` (spec §35, §82).
- [ ] 3. Write `services/dateRange.js`: convert `minAge`/`maxAge` into inclusive DOB boundaries using a fixed
      reference "now", so the query on `dateOfBirth` is index-friendly (spec §47).
- [ ] 4. Write `services/geoSearch.js`: build the `$near`/`$geoWithin` clause, validate `lat`/`lng` ranges, cap
      `maxDistanceKm`, and ensure coordinates are never returned in the response (spec §48, §112).
- [ ] 5. Write `services/exclusionService.js`: return the excluded user id set for self, blocked pairs, and
      ineligible profiles; keep the interface stable so steps 10 and 12 extend it. Note the query-strategy limit for
      very large block lists (spec §99) as a follow-up rather than pre-optimising.
- [ ] 6. Write `services/cursor.js`: encode/decode an opaque cursor over the active sort key plus a stable `_id`
      tiebreak, validate it, and reject malformed cursors (spec §52). Never expose an offset or a raw sort field.
- [ ] 7. Write `utils/projections.js` with the card projection, plus a `serializeCard()` that computes `age`, formats
      height, and picks the primary approved transformed photo URL.
- [ ] 8. Write `validators/search.validators.js`: allowlist every parameter, coerce numbers, validate ObjectIds,
      clamp `limit` to the configured maximum, validate the cursor, and reject unknown parameters (spec §34, §53, §80).
- [ ] 9. Write `searchService.discover()`: load the caller's `effectiveFilters()` (step 07), merge explicit query
      parameters over them, add mandatory system filters (`status: active`), apply exclusions, execute the indexed
      query with the projection, sort, and limit (spec §83).
- [ ] 10. Write `searchService.search()`: identical pipeline without the preference merge, so an explicit filter set
      is honoured exactly.
- [ ] 11. Write `searchService.recommendations()`: take a bounded candidate set from the hard-filter query, score it
      with the deterministic model, sort, and return the page (spec §54, §55). **Never score the entire collection.**
- [ ] 12. Write `recommendationService.score()`: age 20, location 20, education 15, occupation 15, community 10,
      lifestyle 10, completeness 10 — weights from constants, each sub-score documented and unit-testable.
- [ ] 13. Create the step's compound indexes after measuring; record for each index the query it serves and the
      `explain` plan before and after (spec §49, §50).
- [ ] 14. Confirm no read path performs a `populate()` chain across users, community, occupation, education, city, and
      photo (spec §66). Names must come from denormalised fields.
- [ ] 15. Return `nextCursor` only when a further page exists; never return an unbounded result set (spec §52).

## Business rules & security

- **Allowlist everything.** Unknown filters, sorts, and parameters are rejected, not ignored (spec §34, §53).
- **Mandatory filters cannot be overridden.** `status: active` and the exclusions are appended after user input, so a
  crafted request cannot surface drafts, suspended, deleted, blocked, or hidden profiles (spec §56, §99).
- **Privacy in projection.** Email, phone, exact address, exact coordinates, birth time, and identity data are never
  projected or serialised (spec §51, §112).
- **Age is derived, not stored** (spec §47).
- **Bounded page sizes** with a hard maximum (spec §52, §80).
- **No arbitrary query objects** from the client, no regex filters, no `$where` (spec §35, §82).
- **Distance search does not leak coordinates:** the filter uses the stored point; the response shows only city
  (spec §48, §112).

## Config / environment additions

```text
SEARCH_DEFAULT_LIMIT     # default page size
SEARCH_MAX_LIMIT         # hard maximum page size
SEARCH_MAX_DISTANCE_KM   # cap for distance search
RECOMMENDATION_WEIGHTS   # overridable weights, or keep in constants if not env-driven
EXCLUSION_MAX_IDS        # guard for very large block lists (spec §99)
```

## Verification commands

```bash
ACCESS=...   # access token from step 04

# 1. Basic discover
curl -sS -H "Authorization: Bearer $ACCESS" 'http://localhost:3000/api/v1/discover?limit=20'
# Expected: 200 with <= 20 items, a nextCursor when more exist, and only card fields

# 2. Gender + age filter
curl -sS -H "Authorization: Bearer $ACCESS" 'http://localhost:3000/api/v1/discover?gender=female&minAge=24&maxAge=30'
# Expected: only matching profiles; ages verified by recomputing from DOB

# 3. Combined filters
curl -sS -H "Authorization: Bearer $ACCESS" \
  'http://localhost:3000/api/v1/discover?gender=female&cityId=<id>&occupationId=<id>&diet=vegetarian&verified=true&limit=20'
# Expected: intersection honoured

# 4. Cursor pagination is stable
C1=$(curl -sS -H "Authorization: Bearer $ACCESS" 'http://localhost:3000/api/v1/discover?limit=5' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.nextCursor))")
curl -sS -H "Authorization: Bearer $ACCESS" "http://localhost:3000/api/v1/discover?limit=5&cursor=$C1"
# Expected: page 2 with no overlap or gap versus page 1

# 5. XSS/NoSQL injection attempts are ignored
curl -sS -H "Authorization: Bearer $ACCESS" \
  'http://localhost:3000/api/v1/discover?gender[$ne]=male&limit=20'
# Expected: 400 rejected, not a filter bypass

# 6. Unknown sort rejected
curl -sS -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $ACCESS" \
  'http://localhost:3000/api/v1/discover?sort=passwordHash'
# Expected: 400

# 7. Limit cap
curl -sS -H "Authorization: Bearer $ACCESS" 'http://localhost:3000/api/v1/discover?limit=100000'
# Expected: returns at most the configured maximum

# 8. Privacy check
curl -sS -H "Authorization: Bearer $ACCESS" 'http://localhost:3000/api/v1/discover?limit=1' | grep -E '"email"|"phone"|"coordinates"|"birthTime"'
# Expected: no matches

# 9. Query plan
#   Run explain("executionStats") on the default discover filter.
# Expected: IXSCAN on a designed index, small totalKeysExamined and totalDocsExamined

# 10. Distance filter
curl -sS -H "Authorization: Bearer $ACCESS" 'http://localhost:3000/api/v1/discover?lat=28.61&lng=77.20&maxDistanceKm=50'
# Expected: results within the distance; no coordinates in the response
```

## Audit checklist

### Gate 1 — Build integrity

- [ ] **G1.1** Every deliverable exists; all three routes mounted and protected.
- [ ] **G1.2** Server boots and the step's indexes are created.
- [ ] **G1.3** Steps 01–08 verification commands still pass, especially profile privacy and photo card URLs.

### Gate 2 — Functional

- [ ] **G2.1** Default discover returns a bounded, correctly projected page for a user with preferences.
- [ ] **G2.2** Gender, age, height, marital status, community, gotra, surname, location, education, occupation,
      industry, employment type, income, diet, smoking, drinking, family type, verified, and has-photo filters each
      work individually.
- [ ] **G2.3** Combined filters return the correct intersection.
- [ ] **G2.4** Cursor pagination returns every profile exactly once across pages, with no overlap or gap, including
      when items share the same `lastActiveAt`.
- [ ] **G2.5** Sorting by each allowed value produces the expected order; results are stable.
- [ ] **G2.6** Draft, hidden, suspended, and deleted profiles never appear.
- [ ] **G2.7** The requesting user never appears in their own results.
- [ ] **G2.8** Exclusion interface removes the ids it is given (verified with a seeded exclusion set before steps 10–12 exist).
- [ ] **G2.9** `recommendations` ranks a bounded candidate set and returns its expected ordering for a fixed fixture.
- [ ] **G2.10** Distance search returns profiles inside the radius and excludes those outside it.

### Gate 3 — Security

- [ ] **G3.1** Object-shaped filter values (`gender[$ne]=male`) are rejected; the boundary is not bypassed (spec §35).
- [ ] **G3.2** Unknown parameters and unknown sort values are rejected.
- [ ] **G3.3** `limit` cannot exceed the configured maximum, and no unbounded query path exists.
- [ ] **G3.4** The response contains no email, phone, exact address, coordinates, birth time, identity data, or admin
      fields (spec §51, §112) — verified against the real JSON for a second account's token.
- [ ] **G3.5** A malformed or tampered cursor is rejected rather than decoded into an arbitrary sort.
- [ ] **G3.6** Unauthenticated requests to all three routes return 401.
- [ ] **G3.7** No error leaks a collection name, field path, or driver detail.

### Gate 4 — Performance & data

- [ ] **G4.1** The default discover query plan shows `IXSCAN`, not `COLLSCAN`, with an index designed in this step.
- [ ] **G4.2** Each created index has a recorded justification and a before/after `explain` comparison.
- [ ] **G4.3** `executionTimeMillis`, `totalKeysExamined`, `totalDocsExamined`, and `nReturned` are recorded for the
      representative queries at the dataset size used in step 17.
- [ ] **G4.4** The card payload stays small: only projected fields, one transformed photo URL, no populate chain
      (spec §66, §108).
- [ ] **G4.5** No index exists without a query that needs it (spec §49, §82 item 6).

### Gate 5 — Spec conformance

- [ ] **G5.1** §45 / §46 / §119 — every filter group is supported and built allowlist-only.
- [ ] **G5.2** §47 — age ranges convert to DOB ranges and index on `dateOfBirth`.
- [ ] **G5.3** §48 — GeoJSON `2dsphere` distance search works and coordinates are not exposed.
- [ ] **G5.4** §49 / §50 — indexes are query-driven and validated with query plans (`IXSCAN`, examined counts).
- [ ] **G5.5** §51 / §70 / §108 / §120 — the projection and response shape match the documented card.
- [ ] **G5.6** §52 / §53 — cursor pagination and the controlled sort set are implemented.
- [ ] **G5.7** §54 / §55 — deterministic scoring on a bounded candidate set, never a full-collection scan.
- [ ] **G5.8** §56 / §83 / §99 — exclusions and mandatory filters are applied after user input.
- [ ] **G5.9** §82 — every listed anti-pattern is demonstrably absent.
- [ ] **G5.10** §109 — filtering and display both use values already inside the profile document.

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

- [ ] Discover returns a correct, bounded, projected page driven by preferences plus explicit filters.
- [ ] No combination of parameters can surface an ineligible, private, or excluded profile.
- [ ] Pagination is stable and complete across pages.
- [ ] The main query is index-backed, with the plan and examined counts recorded.
- [ ] Adding steps 10 and 12 exclusions requires no change to the query shape.

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence (query plans, payload sizes) | |
| Fixes required | |
