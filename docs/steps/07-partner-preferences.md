---
step: 07
title: Partner Preferences
status: not_started
build: not_started
audit: not_run
depends_on: [06]
unblocks: [09]
spec_refs: ["§16", "§34", "§35", "§44", "§54", "§57", "§72", "§81", "§97", "§105"]
---

# Step 07 — Partner Preferences

## Goal

Build the document that answers "who am I looking for?" as a distinct record from "who am I?" (spec §16). Discover
and recommendations consume it as the default candidate filter, and profile completion counts it. Preferences must
be savable in part, because a user might set an age range now and locations later (spec §16).

## Scope

**In scope**

- `partner_preferences` schema per spec §16, with partial-save support.
- Validators for ranges and multi-select ID arrays.
- Ownership enforcement identical to step 06.
- A merged "effective filters" helper that step 09 reuses.
- Wiring the preference section into profile completion (spec §57).

**Out of scope (do not build now)**

- Discover/search execution — step 09.
- Recommendation scoring weights — step 09 owns ranking (spec §54, §55).
- Any premium restriction on preferences; entitlement is step 15.

**Later**

- Preference presets or saved search sets, if the product asks for them.
- Preference-based notifications.

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| Matrimonial profile with validation and ownership patterns | 06 | `audited_passed` |
| Master data ID validation | 05 | `audited_passed` |

## Deliverables

```text
server/src/models/PartnerPreference.js        # spec §16 schema + indexes
server/src/services/preferenceService.js      # create, update partial, get, effectiveFilters
server/src/controllers/preference.controller.js
server/src/routes/preference.routes.js
server/src/validators/preference.validators.js
server/src/constants/preference.js            # enum mirrors, default ranges, array caps
```

## Data model

### `partner_preferences` (spec §16)

```js
{
  _id: ObjectId,
  userId: ObjectId,
  age: { min: Number, max: Number },
  heightCm: { min: Number | null, max: Number | null },
  gender: String | null,
  maritalStatus: [String],
  childrenPreference: String | null,
  educationIds: [ObjectId],
  occupationIds: [ObjectId],
  industryIds: [ObjectId],
  incomeRanges: [String],
  countryIds: [ObjectId],
  stateIds: [ObjectId],
  cityIds: [ObjectId],
  motherTongueIds: [ObjectId],
  communityIds: [ObjectId],
  subCommunityIds: [ObjectId],
  surnameIds: [ObjectId],
  gotraIds: [ObjectId],
  diet: [String],
  smoking: [String],
  drinking: [String],
  familyTypes: [String],
  workingPreference: String | null,
  horoscopeRequired: String | null,   // 3-value enum, not a boolean (finalized decisions §4)
  manglikPreference: [String],
  relocationPreference: String | null,
  createdAt: Date,
  updatedAt: Date
}
```

| Index | Definition | Purpose |
|---|---|---|
| `userId` | unique | One preference document per account |

Every field is optional so partial saves succeed (spec §16). Absent means "no preference on this dimension",
which step 09 must treat as "do not filter", not as "match nothing".

### Defaults and validation

| Item | Rule | Source |
|---|---|---|
| `age.min` / `age.max` | Integer, within the platform's overall allowed age range, `min <= max` | Spec §81 |
| `heightCm.min` / `heightCm.max` | Within configured bounds, `min <= max` when both present | Spec §81 |
| `gender` | When absent, default to the opposite of the profile gender. Locked as a **default only** — the user can still change it | Finalized decisions §5 |
| `maritalStatus`, `diet`, `smoking`, `drinking`, `familyTypes`, `manglikPreference` | Values from the documented enum sets | Fields dictionary §15.4, §15.17–15.23 |
| `incomeRanges` | Values from the documented income set | Fields dictionary §15.8 |
| `workingPreference` | FINAL: Working / Not Working / Either → stored `"working"` / `"not_working"` / `"either"` | Finalized decisions §4 |
| `horoscopeRequired` | FINAL: Required / Preferred / Not Important → stored `"required"` / `"preferred"` / `"not_important"`. **Not a boolean** | Finalized decisions §4 |
| `relocationPreference` | FINAL: Yes / No / Maybe → stored `"yes"` / `"no"` / `"maybe"` | Finalized decisions §4 |
| All `*Ids` arrays | Each element validated via step 05 `validateIds()`; array length capped | Spec §97, §80 |
| `communityIds` / `subCommunityIds` / `gotraIds` / `surnameIds` | Scoped validation: a value is accepted only in its own parent context, so a Kahar clan can never be stored as a Yadav gotra | Community-format scoping |

Preferences may reference **user-contributed** options too (step 05): a value one user added to make their own profile
complete is selectable by everyone else, so a preference can target it. It carries the same `isUserContributed` flag in
the response. The fields dictionary defines preferred Community/Sub-community/Surname/Gotra (§15.13–§15.16) but no
preferred **clan** or **aaspad** field, so no `clanIds`/`aaspadIds` are added here; if the product wants those filters
later they follow the identical scoped-option pattern rather than a new mechanism.

These three sets were the only ones the fields dictionary had left open. They are now closed, so `constants/preference.js`
stores them as declared enum mirrors rather than flagged placeholders:

```js
// constants/preference.js
export const WORKING_PREFERENCE = ["working", "not_working", "either"];
export const HOROSCOPE_REQUIRED = ["required", "preferred", "not_important"];
export const RELOCATION_PREFERENCE = ["yes", "no", "maybe"];
```

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/preferences` | authenticated | Caller's preferences |
| POST | `/api/v1/preferences` | authenticated | Create the caller's preferences |
| PATCH | `/api/v1/preferences` | authenticated | Partial update |

## Build tasks

- [ ] 1. Write `models/PartnerPreference.js` with the schema, base plugin, and unique `userId` index.
- [ ] 2. Write `constants/preference.js`: enum mirrors from the fields dictionary **including the three finalized sets
      above** (decisions §4), configured default age/height ranges, and array caps. Do not leave a placeholder for a
      set that is now FINAL.
- [ ] 3. Write `validators/preference.validators.js`: range sanity (`min <= max`), integer coercion, enum membership,
      ObjectId validity, array caps, and unknown-field rejection.
- [ ] 4. Write `preferenceService.create()`: derive `userId` from `req.auth`, refuse a duplicate document, allow an
      empty or partial body.
- [ ] 5. Write `preferenceService.update()`: merge partial input onto the existing document, then validate the merged
      result so a partial change cannot leave an invalid range.
- [ ] 6. Write `preferenceService.effectiveFilters()`: return the filter object step 09 will use, with a documented
      convention for absent values (omit the filter) and a derived gender default.
- [ ] 7. Hook the preference section into `profileCompletion` so saving preferences updates the profile's percentage
      (spec §57) without a full profile rewrite.
- [ ] 8. Write the controller and routes; apply `requireAuth` and resolve identity from the session only (spec §72).
- [ ] 9. Do **not** add an `age` field — store the range and let step 09 convert it to a date-of-birth range
      (spec §47).

## Business rules & security

- **Ownership:** one preference document per account; identity comes from the session, never the body (spec §44, §72).
- **Partial save is a feature:** a missing field means "no preference", never "no match" (spec §16).
- **No leakage:** preferences are private to the owner; there is no public read path (spec §112).
- **Validated references:** every preference ID must resolve to an active master record at write time (spec §97),
  **within its parent scope** — the same name in another community is a different record and is rejected.
- **Bounded arrays:** caps prevent oversized documents and expensive candidate queries (spec §80).
- **No client-trusted filters:** the API stores preferences; the client cannot inject extra filter keys (spec §35).

## Config / environment additions

```text
PREF_MIN_AGE_DEFAULT     # default lower age when creating preferences
PREF_MAX_AGE_DEFAULT     # default upper age
PREF_MAX_MULTI_SELECT    # cap for each *Ids / enum array
```

## Verification commands

```bash
ACCESS=...   # access token from step 04

# 1. Create partial preferences
curl -sS -X POST http://localhost:3000/api/v1/preferences -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"age":{"min":24,"max":30}}'
# Expected: 201; all other fields defaulted/empty

# 2. Duplicate create refused
#   Re-run command 1. Expected: 409

# 3. Partial update preserves earlier values
curl -sS -X PATCH http://localhost:3000/api/v1/preferences -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"cityIds":["<cityId>"]}'
curl -sS -H "Authorization: Bearer $ACCESS" http://localhost:3000/api/v1/preferences
# Expected: age range still 24-30 and cityIds populated

# 4. Invalid range
curl -sS -X PATCH http://localhost:3000/api/v1/preferences -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"age":{"min":40,"max":20}}'
# Expected: 400

# 5. Invalid master-data ID
curl -sS -X PATCH http://localhost:3000/api/v1/preferences -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"gotraIds":["000000000000000000000000"]}'
# Expected: 400, no write

# 6. Array cap
curl -sS -X PATCH http://localhost:3000/api/v1/preferences -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"cityIds":["<id>","<id>",...]}'
# Expected: 400 once the cap is exceeded

# 7. Unauthenticated access
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/preferences
# Expected: 401

# 8. Completion reflects preferences
curl -sS -H "Authorization: Bearer $ACCESS" http://localhost:3000/api/v1/profile/me
# Expected: completionPercentage changed after preferences were saved
```

## Audit checklist

### Gate 1 — Build integrity

- [ ] **G1.1** Every deliverable exists; routes mounted and protected.
- [ ] **G1.2** Server boots with the model and unique index in place.
- [ ] **G1.3** Steps 01–06 verification commands still pass (create/read/update profile, privacy checks).

### Gate 2 — Functional

- [ ] **G2.1** Preferences can be created with a partial body and read back.
- [ ] **G2.2** PATCH merges rather than replacing, preserving unspecified fields.
- [ ] **G2.3** A second document for the same account is refused.
- [ ] **G2.4** `min > max` for age and height is rejected, including when the inversion is created by merging a
      partial update onto existing values.
- [ ] **G2.5** Unknown enum values, invalid ObjectIds, and over-cap arrays are rejected.
- [ ] **G2.6** `effectiveFilters()` omits absent dimensions and, when `gender` is absent, derives the opposite of the
      profile gender as a **default** (the user can still override it) (decisions §5).
- [ ] **G2.9** `workingPreference`, `horoscopeRequired`, and `relocationPreference` accept only the finalized enum
      values, and `horoscopeRequired` rejects a boolean (decisions §4).
- [ ] **G2.7** Saving preferences updates the profile completion percentage.
- [ ] **G2.8** No `age` field is stored in the document.

### Gate 3 — Security

- [ ] **G3.1** A `userId` supplied in the body does not address another account's preferences.
- [ ] **G3.2** There is no route that exposes another user's preferences.
- [ ] **G3.3** Unknown or extra filter keys are rejected at validation.
- [ ] **G3.4** Malformed ObjectIds and object-shaped values are rejected before any query (spec §35).
- [ ] **G3.5** A suspended or deleted account cannot read or write preferences.

### Gate 4 — Performance & data

- [ ] **G4.1** The `userId` lookup uses the unique index (`IXSCAN`).
- [ ] **G4.2** The preference document stays small; array caps and bounded fields are enforced.
- [ ] **G4.3** `effectiveFilters()` produces a plain allowlisted object with no nested query operators.

### Gate 5 — Spec conformance

- [ ] **G5.1** §16 — the schema matches the documented fields; partial preferences are permitted.
- [ ] **G5.2** §47 — no age field is stored; the range is retained for later conversion.
- [ ] **G5.3** §57 — preferences contribute to completion as documented.
- [ ] **G5.4** §72 / §44 — ownership is enforced server-side.
- [ ] **G5.5** §97 — referenced master IDs are validated.
- [ ] **G5.6** §105 — the preferences index is present.

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

- [ ] A user can save any subset of preferences and return later to complete them.
- [ ] Invalid ranges and references are refused in every combination, including after a merge.
- [ ] Step 09 can consume `effectiveFilters()` without re-validating or re-interpreting the data.
- [ ] Preferences are never visible to any other account.

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence | |
| Fixes required | |
