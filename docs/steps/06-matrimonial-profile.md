---
step: 06
title: Matrimonial Profile
status: not_started
build: not_started
audit: not_run
depends_on: [05]
unblocks: [07, 08]
spec_refs: ["§3.3", "§8", "§9", "§10", "§11", "§30", "§51", "§57", "§58", "§59", "§68", "§69", "§72", "§81", "§92", "§93", "§105", "§113", "§118"]
---

# Step 06 — Matrimonial Profile

## Goal

Build the primary matchmaking document and its write/read surface. This is the single collection Discover queries
(spec §3.3, §9), so its shape determines search performance: master-data IDs embedded for filtering, small
denormalised display names beside them for rendering (spec §10). The step also implements ownership enforcement,
profile status, completion scoring, and the different response shapes for own-profile versus other-user views
(spec §59).

## Scope

**In scope**

- `matrimonial_profiles` schema per spec §8 with all sections: basic, community, location, education, career, family,
  lifestyle, personal, horoscope, marriage, about, profile.
- `publicProfileId` generation in the `CHV-XXXXX` style (spec §113).
- Create/read/update/soft-delete own profile, and read another user's permitted view.
- Field validation sourced from the fields dictionary, including cross-field rules.
- Profile completion calculation (spec §57) and status transitions (spec §58).
- DTOs/serialisers for own profile, discovery card, and full permitted profile (spec §30, §51, §59).
- Draft saving so onboarding can resume (spec §92).

**Out of scope (do not build now)**

- Partner preferences — step 07.
- Photos and `isPrimary` photo wiring — step 08, though the profile holds `isVerified` and completion will accept a
  photo signal once step 08 exists.
- Discover/search queries — step 09.
- Any horoscope engine beyond storing the declared fields (spec §115).

**Later**

- Verified badge driven by step 16/verification model (spec §19, §85).
- Field-level privacy beyond the current visibility buckets.

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| Master data collections, search API, and ID validation | 05 | `audited_passed` |
| Authenticated identity available as `req.auth.userId` | 04 | `audited_passed` |

## Deliverables

```text
server/src/models/MatrimonialProfile.js      # spec §8 schema + indexes
server/src/services/profileService.js        # create, update, getOwn, getPublic, softDelete
server/src/services/profileCompletion.js     # spec §57 scoring
server/src/services/profileSerializer.js     # DTOs: own | card | full (spec §59)
server/src/utils/publicProfileId.js          # CHV-XXXXX generation with collision retry
server/src/controllers/profile.controller.js
server/src/routes/profile.routes.js
server/src/validators/profile.validators.js  # section-wise schemas + cross-field rules
server/src/constants/profile.js              # statuses, enums mirrored from the fields dictionary, section weights
```

## Data model

### `matrimonial_profiles` (spec §8)

The full document is defined in the specification; implement it verbatim. The parts that drive search are:

```js
{
  userId, publicProfileId,
  basic:      { profileFor, firstName, middleName, lastName, gender, dateOfBirth, maritalStatus, heightCm },
  community:  { communityId, subCommunityId, surnameId, surnameName, gotraId, gotraName,
                clanId, clanName, aaspadId, aaspadName, motherTongueId, religion },
  location:   { countryId, stateId, districtId, cityId, *_Name, coordinates },
  education:  { highestQualificationId, degreeId, degreeName, specializationId, specializationName,
                collegeId, universityId, universityName, graduationYear },
  career:     { occupationId, occupationName, industryId, industryName, employmentType, company,
                designation, workLocation, experienceYears, incomeRange },
  family:     { familyType, familyStatus, fatherOccupation, motherOccupation,
                brothersCount, marriedBrothersCount, sistersCount, marriedSistersCount, familyLocation },
  lifestyle:  { diet, dietOther, smoking, drinking, fitness, pets },
  personal:   { hobbies: [ObjectId], interests: [ObjectId], languages: [ObjectId] },
  horoscope:  { available, birthTime, birthPlace, rashi, nakshatra, manglik },
  marriage:   { hasChildren, childrenCount, wantsChildren },
  about:      { headline, description },
  profile:    { status, completionPercentage, isVerified, lastActiveAt },
  createdAt, updatedAt
}
```

### ID versus display name (spec §10)

| Field kind | Stored as | Used for |
|---|---|---|
| `*Id` | `ObjectId` from master data | Filtering and matching |
| `*Name` | String copy | Display without a join |
| Fixed enums | String value from the fields dictionary | Filtering, cheap to compare |
| Free text | String, length-limited | Display only |

An admin rename of a master item refreshes the denormalised copies **inline during the rename**, targeted by the
master-data ID (spec §10, §74; finalized decisions §14). It is not a background job and never runs on a profile read.

The same applies to `clanName` and `aaspadName` when those master records are renamed.

### Indexes

| Index | Purpose |
|---|---|
| `userId` unique | One profile per account |
| `publicProfileId` unique | Public lookup (spec §113) |
| `profile.status` | Discover filters by active status |
| `basic.gender`, `basic.dateOfBirth`, `basic.maritalStatus` | Core filters |
| `community.communityId`, `community.gotraId`, `community.surnameId` | Community filters |
| `community.clanId`, `community.aaspadId` | Community-context filters (clan is not a gotra; aaspad is neither) |
| `location.stateId`, `location.cityId` | Location filters |
| `career.occupationId`, `education.degreeId` | Career/education filters |
| `location.coordinates` 2dsphere | Distance search (spec §48) |
| `profile.lastActiveAt` | Recency sorting |

Compound indexes are deliberately **not** created here; step 09 creates them from measured query patterns
(spec §49, §50).

### Validation and cross-field rules

Sourced from the fields dictionary:

| Rule | Detail |
|---|---|
| `marriedBrothersCount <= brothersCount` | Fields dictionary §8.6 |
| `marriedSistersCount <= sistersCount` | Fields dictionary §8.8 |
| Age within the configured allowed range | Derived from `dateOfBirth`, spec §81 |
| `heightCm` within the configured range | Spec §81, fields dictionary §3.9 |
| `childrenCount` only when `hasChildren` is true | fields dictionary §12 |
| `dietOther` only when `diet === "other"` | fields dictionary §9.1 |
| `headline` / `description` length caps | Fields dictionary §13 |
| Array caps for hobbies/interests/languages | Spec §80 |
| Every `*Id` validated via step 05 `validateIds()` | Spec §97 |
| `clanId` validated within the chosen `communityId`; `aaspadId` valid only for communities that use aaspad | Community-format scoping |
| Required set for V1 | Fields dictionary §25 |

### Missing-value path on the form

Sub-community, surname, gotra, clan, and aaspad are searchable dropdowns backed by step 05. When a user cannot find
their value, the form offers **"Can't find it? Add it"**, which calls `POST /master-data/:type/missing`. The server
records the value with the user's `userId` and returns a selectable option, so the profile can store the `*Id`
immediately and the next user finds it in the dropdown.

- The stored `*Name` copy is written from the option the server returned, not from raw user text.
- A user-added value is flagged `isUserContributed` and is never silently treated as an official value.
- For surnames the fields dictionary also permits a profile-local custom value (`surnameId: null`,
  `surnameName: "Custom Surname"`, fields dictionary §4.3). Prefer the option path so the value is reusable; a
  profile-local custom value stays valid but is not visible to other users.
- `communityId` is **not** user-inputtable — the platform controls the accepted community (fields dictionary §4.1).

`age` is never stored; it is computed from `dateOfBirth` at read time (spec §47, fields dictionary §3.7).

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/profile/me` | authenticated | Own profile, full own DTO |
| POST | `/api/v1/profile` | authenticated | Create the caller's profile |
| PATCH | `/api/v1/profile` | authenticated | Partial update of the caller's profile |
| DELETE | `/api/v1/profile` | authenticated | Soft delete (status → `deleted`) |
| GET | `/api/v1/profile/:publicProfileId` | authenticated | Another user's permitted view |

## Build tasks

- [ ] 1. Write `models/MatrimonialProfile.js` with the spec §8 schema, the base plugin, and the indexes above.
- [ ] 2. Write `constants/profile.js`: statuses (`draft | active | hidden | suspended | deleted`), the enum values
      mirrored from the fields dictionary, the section weights for completion, and the height/age bounds.
- [ ] 3. Write `utils/publicProfileId.js`: generate `CHV-` plus a short random alphanumeric, retry on the unique-index
      collision, and never derive it from the ObjectId or a counter.
- [ ] 4. Write `validators/profile.validators.js`: one schema per section, plus the cross-field rules table. Reject
      unknown fields, unknown enum values, invalid ObjectIds, out-of-range numbers, and over-length strings.
- [ ] 5. Write `services/profileService.create()`: derive `userId` from `req.auth` only (spec §72, §118), refuse a
      second profile for the same account, generate `publicProfileId`, set `profile.status = "draft"`, then run
      completion scoring.
- [ ] 6. Write `profileService.update()`: allow section-level partial updates, re-run validation across the merged
      document (so a partial update cannot break a cross-field rule), refresh denormalised names from master data,
      and recompute completion.
- [ ] 7. Write `services/profileCompletion.js` implementing spec §57: calculate from the important fields with the
      documented weighting, treat weights as configurable constants, and persist `completionPercentage`.
- [ ] 8. Write status transitions: `draft → active` only when the required V1 field set is complete; `active → hidden`
      freely; `hidden → active` freely; `suspended` set only by admin; `deleted` set by soft delete. Enforce that
      only appropriate statuses are searchable (spec §58).
- [ ] 9. Write `services/profileSerializer.js` with three functions: `ownProfile` (everything the owner may see,
      including restricted fields for themselves), `discoveryCard` (the spec §70/§108 field subset), and
      `publicProfile` (the spec §71 sections minus restricted data). Include computed `age` and a
      centimetre → feet/inches display value.
- [ ] 10. Write the controller and routes. `GET /profile/:publicProfileId` must use the public DTO; `GET /profile/me`
      the own DTO. Never return the raw document (spec §30, §59).
- [ ] 11. Update `users.profileCreated` and `users.onboardingCompleted` when the profile is created and when the
      required set is satisfied.
- [ ] 12. Support draft saving: a partially filled profile must persist and be resumable (spec §92).
- [ ] 13. Add a note in the serializer that `email`, `phone`, exact address, exact birth time, private horoscope
      details, and identity data are restricted (spec §30, §112).

## Business rules & security

- **Ownership is absolute.** `PATCH`/`DELETE` resolve the profile from `req.auth.userId`. A `userId` in the body is
  rejected. Requesting another user's profile never returns their private fields (spec §44, §72).
- **Object-level authorization:** every profile route verifies the resource belongs to the caller or is a permitted
  public read.
- **No frontend-trusted visibility.** Restricted fields are omitted server-side, not hidden client-side (spec §30).
- **Master-data integrity:** every ID is validated against step 05 before write; inactive values are refused for new
  selections (spec §97).
- **Query allowlisting:** profile reads use a bounded query by `userId` or `publicProfileId`, never a raw filter object
  (spec §35, §46).
- **Privacy defaults:** a freshly created profile is `draft` and therefore not discoverable (spec §58).
- **Sensitive fields:** `birthTime` and Kundli details are not part of the public DTO (fields dictionary §11, §26).

## Config / environment additions

```text
PROFILE_MIN_AGE          # minimum legal age for a profile
PROFILE_MAX_AGE          # upper bound for accepted DOB
PROFILE_MIN_HEIGHT_CM    # validation bound
PROFILE_MAX_HEIGHT_CM    # validation bound
PROFILE_MAX_HOBBIES      # array cap
PROFILE_MAX_INTERESTS    # array cap
PROFILE_MAX_LANGUAGES    # array cap
HEADLINE_MAX_LEN         # fields dictionary §13
ABOUT_MAX_LEN            # fields dictionary §13
```

## Verification commands

```bash
ACCESS=...   # access token from step 04

# 1. Create a draft profile
curl -sS -X POST http://localhost:3000/api/v1/profile -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"basic":{"profileFor":"self","firstName":"Rahul","gender":"male"}}'
# Expected: 201 with publicProfileId and profile.status "draft"; completionPercentage present

# 2. Second profile for the same account is refused
#   Re-run command 1. Expected: 409

# 3. Own profile
curl -sS -H "Authorization: Bearer $ACCESS" http://localhost:3000/api/v1/profile/me
# Expected: 200 own DTO

# 4. Partial update with a cross-field violation
curl -sS -X PATCH http://localhost:3000/api/v1/profile -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"family":{"brothersCount":2,"marriedBrothersCount":3}}'
# Expected: 400 with a clear cross-field message

# 5. Invalid master-data ID
curl -sS -X PATCH http://localhost:3000/api/v1/profile -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"community":{"gotraId":"000000000000000000000000"}}'
# Expected: 400, no write

# 6. Another user's permitted view omits private fields
curl -sS -H "Authorization: Bearer $OTHER_ACCESS" \
  http://localhost:3000/api/v1/profile/<publicProfileId>
# Expected: 200 without email, phone, coordinates, birthTime, or identity data

# 7. Anonymous access
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/profile/<publicProfileId>
# Expected: 401

# 8. Attempt to patch someone else's profile by supplying userId
curl -sS -X PATCH http://localhost:3000/api/v1/profile -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"userId":"<otherUserId>","basic":{"firstName":"Hacked"}}'
# Expected: 400/403; no change to the other profile
```

## Audit checklist

### Gate 1 — Build integrity

- [ ] **G1.1** Every deliverable exists; all routes are mounted and protected.
- [ ] **G1.2** Server boots, `MatrimonialProfile` indexes are created, and the unique indexes hold.
- [ ] **G1.3** Steps 01–05 verification commands still pass (including master-data search and seeding).

### Gate 2 — Functional

- [ ] **G2.1** A profile can be created, read back, partially updated, and soft-deleted.
- [ ] **G2.2** Draft persistence works: a partial profile survives a round trip and is resumable.
- [ ] **G2.3** Completion percentage changes as fields are added and matches the documented weighting.
- [ ] **G2.4** Status transitions follow the rule table; a draft never becomes `active` while required fields are missing.
- [ ] **G2.5** `marriedBrothersCount > brothersCount`, `marriedSistersCount > sistersCount`,
      `childrenCount` with `hasChildren: false`, `dietOther` with a non-`other` diet, an out-of-range height, and an
      under-age DOB are each rejected.
- [ ] **G2.6** Enum fields reject values outside the documented option sets.
- [ ] **G2.7** Denormalised names are populated correctly on write from the referenced master record and are refreshed
      when the referenced record changes.
- [ ] **G2.8** A profile with `status: "draft"` or `"hidden"` is not returned by any public read path.
- [ ] **G2.9** `publicProfileId` is unique, stable, and not derivable from the ObjectId.

### Gate 3 — Security

- [ ] **G3.1** `GET /profile/me` for another account's token returns that account's own profile only.
- [ ] **G3.2** `PATCH` with a body `userId` does not modify another user's document.
- [ ] **G3.3** The public DTO contains no email, phone, exact coordinates, `birthTime`, identity data, or admin notes
      (spec §30, §112) — verified by inspecting the actual JSON, not the code.
- [ ] **G3.4** Unknown fields and unknown enum values are rejected, not stored.
- [ ] **G3.5** Object-shaped filters and malformed ObjectIds are rejected before any query (spec §35).
- [ ] **G3.6** A suspended or deleted account cannot read or write a profile.

### Gate 4 — Performance & data

- [ ] **G4.1** `userId` and `publicProfileId` lookups use `IXSCAN`.
- [ ] **G4.2** Reads use a projection (spec §51) and no read path returns the full raw document to a non-owner.
- [ ] **G4.3** The public read performs no populate chain; denormalised names are used instead (spec §66, §68).

### Gate 5 — Spec conformance

- [ ] **G5.1** §8 — the schema matches the documented sections and field names.
- [ ] **G5.2** §3.3 / §9 — searchable IDs are embedded in the profile document.
- [ ] **G5.3** §10 — denormalised display names exist only beside their IDs.
- [ ] **G5.4** §57 / §58 — completion scoring and status rules behave as documented.
- [ ] **G5.5** §59 / §30 — five-level privacy is represented by distinct DTOs, and restricted fields are omitted.
- [ ] **G5.6** §72 / §118 — ownership is derived from the session, never the request body.
- [ ] **G5.7** §92 / §93 — the profile supports the documented onboarding sections and page layout data.
- [ ] **G5.8** §113 — the public identifier style matches `CHV-XXXXX`.
- [ ] **G5.9** §105 — the profile index checklist is present and measurable.

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

- [ ] A user can complete every onboarding section and resume a draft.
- [ ] No user can read or write another user's private profile fields.
- [ ] Every stored master-data ID resolves to a valid, selectable record.
- [ ] The DTO layer returns only what the current screen needs.
- [ ] Step 09 can build its filters purely from this collection.

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence | |
| Fixes required | |
