---
step: 08
title: Photos & Cloudinary
status: not_started
build: not_started
audit: not_run
depends_on: [06]
unblocks: [09]
spec_refs: ["§17", "§18", "§30", "§43", "§44", "§60", "§80", "§105", "§112", "§127"]
---

# Step 08 — Photos & Cloudinary

## Goal

Store profile and gallery images in Cloudinary and keep only references in MongoDB (spec §17). The step delivers a
signed, server-authorized upload path, ownership enforcement so one user cannot touch another's photos, moderation
state, per-photo visibility, and the image-transformation rules that keep profile cards small (spec §18, §43).
A photo signal also feeds profile completion and the community's `requireProfilePhoto` setting (spec §15).

## Scope

**In scope**

- `photos` collection per spec §17.
- Cloudinary configuration and a signed-upload endpoint so the API secret never reaches a client (spec §43).
- Ownership enforcement on every photo route (spec §44).
- File type, size, and count validation; moderation status defaulting to pending; per-photo visibility.
- Primary-photo handling (exactly one) and `sortOrder`.
- Cloudinary transformation URLs for card, profile, and gallery sizes (spec §18).
- Delete that removes both the Cloudinary asset and the database reference.
- `kundli_documents`: the horoscope/Kundli document upload as its own collection, not a photo type (decisions §6,
  fields dictionary §11.7).

**Out of scope (do not build now)**

- Admin moderation queue — step 16 (spec §101).
- Video, voice, or any non-image media.
- Automatic facial detection, cropping, or NSFW scoring.

**Later**

- CDN or signed-delivery URLs for `private` visibility photos.
- Kundli downloads via time-limited signed URLs if the product needs direct file access beyond a submitted reference.

**FINAL — Kundli documents get their own collection (finalized decisions §6).** A Kundli document is **not** stored as
an ordinary profile photo. It lives in the dedicated `kundli_documents` collection, the file itself is held by the
configured secure file storage, and MongoDB stores only the reference/metadata. Kundli documents are never public
profile-card data and discovery must never expose them.

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| Matrimonial profile, ownership and DTO patterns | 06 | `audited_passed` |
| Collection constants and base schema | 02 | `audited_passed` |

## Deliverables

```text
server/src/config/cloudinary.js              # SDK config from env; never logs the secret
server/src/models/Photo.js                   # spec §17 schema + indexes
server/src/services/photoService.js          # createFromUpload, list, setPrimary, reorder, updateVisibility, delete
server/src/services/uploadSignature.js       # short-lived signed params, scoped per user
server/src/controllers/photo.controller.js
server/src/routes/photo.routes.js
server/src/validators/photo.validators.js
server/src/utils/cloudinaryUrl.js            # transformation URL builders: card | profile | gallery
server/src/constants/photo.js                # types, visibility, moderation states, limits
server/src/models/KundliDocument.js          # dedicated kundli_documents collection (decisions §6)
server/src/services/kundliService.js         # create, get, updateVisibility, delete
server/src/controllers/kundli.controller.js
server/src/routes/kundli.routes.js
server/src/validators/kundli.validators.js
server/src/constants/kundli.js               # visibility + moderation states
```

## Data model

### `photos` (spec §17)

```js
{
  _id: ObjectId,
  userId: ObjectId,
  url: String,
  publicId: String,
  type: "profile" | "gallery",
  isPrimary: Boolean,
  sortOrder: Number,
  visibility: "public" | "registered_users" | "matches_only" | "private",
  moderationStatus: "pending" | "approved" | "rejected",
  createdAt: Date,
  updatedAt: Date
}
```

| Index | Definition | Purpose |
|---|---|---|
| `userId` | `{ userId: 1 }` | Load a user's photos |
| primary | `{ userId: 1, isPrimary: 1 }` | Find the primary photo cheaply for discovery cards |
| sort | `{ userId: 1, sortOrder: 1 }` | Gallery ordering |

### Invariants

| Invariant | Enforcement |
|---|---|
| Exactly one primary photo per user | Set-primary transactionally clears the previous primary (single write pipeline or ordered update) |
| At most one `type: "profile"` primary | Reject a second primary for the same type |
| Photo count within the configured limit | Count before accepting a new reference |
| `publicId` unique | Unique index; also required so deletion can target the asset |
| Ownership | Every mutation compares `userId` to `req.auth.userId` |

### `kundli_documents` (finalized decisions §6)

```js
{
  _id: ObjectId,
  userId: ObjectId,
  url: String,
  publicId: String,
  moderationStatus: "pending" | "approved" | "rejected",
  visibility: "private" | "matches_only",
  createdAt: Date,
  updatedAt: Date
}
```

| Index | Definition | Purpose |
|---|---|---|
| `userId` | `{ userId: 1 }` | Load a user's Kundli document |
| visibility | `{ userId: 1, visibility: 1 }` | Decide whether a relationship viewer may see it |

Note the reduced visibility set: a Kundli document is never `public` or `registered_users`. Its only non-private
option is `matches_only`.

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/photos` | authenticated | Caller's photos with transformation URLs |
| POST | `/api/v1/photos/sign` | authenticated | Short-lived signature for a direct Cloudinary upload |
| POST | `/api/v1/photos` | authenticated | Register an uploaded asset after verified upload |
| PATCH | `/api/v1/photos/:photoId` | authenticated, owner | Visibility, `sortOrder`, primary flag |
| DELETE | `/api/v1/photos/:photoId` | authenticated, owner | Delete asset + reference |
| GET | `/api/v1/kundli` | authenticated | Caller's Kundli document metadata |
| POST | `/api/v1/kundli` | authenticated | Register an uploaded Kundli document |
| PATCH | `/api/v1/kundli/:kundliId` | authenticated, owner | Change `visibility` |
| DELETE | `/api/v1/kundli/:kundliId` | authenticated, owner | Delete asset + reference |

### Upload flow

```text
client → POST /photos/sign        (authenticated; returns signature scoped to this user's folder)
client → Cloudinary direct upload (uses the signature; API secret never leaves the server)
client → POST /photos             (registers publicId + url; ownership and count re-checked server-side)
```

The server must not accept an arbitrary `publicId` from a client without verifying the asset exists and belongs to
that user's upload folder/context (spec §43).

## Build tasks

- [ ] 1. Install the Cloudinary SDK and record the version.
- [ ] 2. Write `config/cloudinary.js`: configure from `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`,
      `CLOUDINARY_API_SECRET`; throw at boot if any is missing; never log values.
- [ ] 3. Write `models/Photo.js` with the schema, base plugin, and indexes. Mark `publicId` unique.
- [ ] 4. Write `services/uploadSignature.js`: generate a signature with a short expiry, a per-user
      folder/context, and a restricted allowed-format list so a signature cannot be reused for arbitrary uploads.
- [ ] 5. Write `utils/cloudinaryUrl.js`: build URLs with transformations for the three display sizes — discovery
      card (small, square), profile page (larger), gallery (medium) — so originals are never delivered to cards
      (spec §18).
- [ ] 6. Write `photoService.list()`: return photo metadata plus the card/profile/gallery URLs, respecting the
      viewer's relationship for `matches_only` and `private` visibility.
- [ ] 7. Write `photoService.createFromUpload()`: verify the asset exists in the expected folder, enforce allowed
      formats and size, enforce the photo count limit, default `moderationStatus` to `pending`, and set the
      first profile photo as primary.
- [ ] 8. Write `photoService.setPrimary()` and `reorder()`: maintain the single-primary invariant and `sortOrder`.
- [ ] 9. Write `photoService.updateVisibility()`: allow only the documented visibility values and only by the owner.
- [ ] 10. Write `photoService.delete()`: verify ownership, destroy the Cloudinary asset, then remove the reference;
      if Cloudinary deletion fails, keep the reference and surface a retryable error rather than orphaning the asset.
- [ ] 11. Write validators, controller, and routes with `requireAuth` and an owner check that returns 404 when the
      photo is not the caller's (avoid confirming the existence of another user's asset).
- [ ] 12. Implement the `kundli_documents` collection and service (decisions §6): store a secure reference only,
      default `moderationStatus` to `pending`, allow `visibility` of `private` or `matches_only` only, and never
      include it in any discovery or profile-card response (fields dictionary §11.7).
- [ ] 13. Wire the photo signal into `profileCompletion` and read `community_configs.settings.requireProfilePhoto`
      for the validation message shown when a profile is activated without a photo (spec §15).

## Business rules & security

- **Upload authorization happens server-side.** The API secret never reaches a client; signatures are short-lived,
  scoped, and format-restricted (spec §43).
- **Never trust a filename extension.** Validate the actual content type/size and enforce an allowlist (spec §43).
- **Object-level authorization:** a user may modify only their own photos (spec §44). Another user's `photoId`
  returns 404, not 403, so existence is not confirmed.
- **Moderation default:** every new photo starts `pending`; only `approved` photos are eligible for discovery cards
  (spec §17, §101).
- **Visibility:** `matches_only` and `private` photos are excluded from non-relationship viewers in both the URL
  selection and the DTO (spec §17, §112).
- **No binaries in MongoDB:** the database stores references only (spec §17). This applies to `kundli_documents`
  too — the file lives in secure storage, MongoDB holds its reference/metadata (decisions §6).
- **Kundli is private by default:** not public profile-card data; discovery must never expose it, and only the owner
  or an accepted-connection viewer (per `matches_only`) may retrieve it.
- **Bounded counts and sizes:** enforce a photo cap and an upload size limit (spec §80).
- **Optimized delivery:** cards receive transformed, small variants; originals are never served to discovery
  (spec §18, §82 item 3).

## Config / environment additions

```text
CLOUDINARY_CLOUD_NAME    # account identifier
CLOUDINARY_API_KEY       # public key used in signatures
CLOUDINARY_API_SECRET    # server-only secret; never sent to a client
CLOUDINARY_UPLOAD_FOLDER # per-environment folder/prefix
PHOTO_MAX_COUNT          # maximum photos per user
PHOTO_MAX_BYTES          # maximum accepted upload size
PHOTO_ALLOWED_FORMATS    # allowlisted content types/formats
PHOTO_SIGN_TTL_SECONDS   # signature lifetime
```

## Verification commands

```bash
ACCESS=...   # access token from step 04

# 1. Request an upload signature
curl -sS -X POST http://localhost:3000/api/v1/photos/sign -H "Authorization: Bearer $ACCESS"
# Expected: 200 with signature, timestamp, folder, allowed formats; no API secret

# 2. Register an uploaded asset (after a real upload using the signature)
curl -sS -X POST http://localhost:3000/api/v1/photos -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"publicId":"<folder>/<id>","type":"profile","url":"<url>"}'
# Expected: 201 with moderationStatus "pending" and isPrimary true for the first profile photo

# 3. List own photos
curl -sS -H "Authorization: Bearer $ACCESS" http://localhost:3000/api/v1/photos
# Expected: 200 with card/profile/gallery URLs, not original URLs

# 4. Attempt to modify another user's photo
curl -sS -o /dev/null -w '%{http_code}\n' -X DELETE \
  http://localhost:3000/api/v1/photos/<otherUsersPhotoId> -H "Authorization: Bearer $ACCESS"
# Expected: 404 (not 403), and the photo still exists

# 5. Count limit
#   Register photos up to the configured cap, then attempt one more.
# Expected: 400/409 with a clear message

# 6. Disallowed format / oversized upload
#   Attempt a signature for a disallowed format and register an asset with a forged publicId.
# Expected: rejected; asset outside the user's folder is refused

# 7. Primary invariant
curl -sS -X PATCH http://localhost:3000/api/v1/photos/<photoId> -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' -d '{"isPrimary":true}'
curl -sS -H "Authorization: Bearer $ACCESS" http://localhost:3000/api/v1/photos | grep -c '"isPrimary":true'
# Expected: exactly one primary photo

# 8. Anonymous access
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/photos
# Expected: 401
```

## Audit checklist

### Gate 1 — Build integrity

- [ ] **G1.1** Every deliverable exists; photo routes mounted and protected.
- [ ] **G1.2** Server boots with Cloudinary configured; a missing secret fails fast at boot.
- [ ] **G1.3** Steps 01–07 verification commands still pass.

### Gate 2 — Functional

- [ ] **G2.1** A signature can be issued and used for a real upload; registering the asset succeeds.
- [ ] **G2.2** Listing returns three transformation variants per photo with correct dimensions and no original URL.
- [ ] **G2.3** The first profile photo becomes primary; setting another as primary leaves exactly one primary.
- [ ] **G2.4** Reordering persists and is reflected in the list order.
- [ ] **G2.5** Deleting a photo removes the Cloudinary asset and the database reference.
- [ ] **G2.6** A Cloudinary delete failure leaves the reference intact and returns a retryable error.
- [ ] **G2.7** The count limit is enforced, and the error message is clear.
- [ ] **G2.8** New photos default to `pending` and are excluded from discovery-card eligibility until approved.

### Gate 3 — Security

- [ ] **G3.1** No response or log contains `CLOUDINARY_API_SECRET` (spec §43, §78).
- [ ] **G3.2** Another user's photo cannot be read as a management object, updated, reordered, or deleted.
- [ ] **G3.3** Registering an asset with a `publicId` outside the user's folder/context is refused.
- [ ] **G3.4** A disallowed file type or an oversized upload is refused; the check is on content, not extension alone.
- [ ] **G3.5** A signature cannot be reused beyond its TTL or for another user's folder.
- [ ] **G3.6** `private` and `matches_only` photos are absent from the responses of non-relationship viewers
      (spec §112) — verified by inspecting the JSON for a second account.
- [ ] **G3.8** A Kundli document is unreachable for a non-owner, non-match viewer: the discovery response and another
      user's profile DTO contain no `kundli` URL or `publicId` (decisions §6, spec §112).
- [ ] **G3.7** Unauthenticated requests are rejected with 401.

### Gate 4 — Performance & data

- [ ] **G4.1** Loading a user's photos uses the `userId` index and a projection.
- [ ] **G4.2** Discovery-card URLs request a small transformation, so card payloads and page weight stay low
      (spec §18).
- [ ] **G4.3** `publicId` is unique, and no orphaned reference can accumulate from a failed delete.

### Gate 5 — Spec conformance

- [ ] **G5.1** §17 — the photo document matches the documented fields and states.
- [ ] **G5.2** §18 — transformation sizes are used for card, profile, and gallery; originals are not delivered to cards.
- [ ] **G5.3** §43 — upload authorization, type/size validation, count limits, and ownership are enforced.
- [ ] **G5.4** §44 — object-level authorization is verified on every mutation.
- [ ] **G5.5** §15 — `requireProfilePhoto` is honoured when activating a profile.
- [ ] **G5.6** §105 — the `photos.userId` index exists.
- [ ] **G5.7** §112 — private-photo access rules are enforced.
- [ ] **G5.8** decisions §6 — Kundli documents are stored in the dedicated `kundli_documents` collection (not as a
      `photos` type), with `visibility` limited to `private | matches_only`, and are absent from discovery output.

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

- [ ] A user can upload, order, set primary, change visibility, and delete only their own photos.
- [ ] No client ever receives the Cloudinary secret or an original multi-megabyte image in a card.
- [ ] New photos cannot appear in discovery before moderation approval.
- [ ] Failed asset deletion leaves a recoverable state rather than an orphan.
- [ ] Step 09 can read a single primary, approved, transformed card URL with no join.

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence | |
| Fixes required | |
