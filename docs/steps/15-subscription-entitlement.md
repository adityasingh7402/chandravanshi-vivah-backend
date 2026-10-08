---
step: 15
title: Subscription / Entitlement
status: not_started
build: not_started
audit: not_run
depends_on: [04]
unblocks: [16]
spec_refs: ["§26", "§27", "§86", "§87", "§88", "§89", "§114", "§124", "§127"]
---

# Step 15 — Subscription / Entitlement

## Goal

Create the entitlement abstraction **before** any payment provider exists, so the rest of the application asks
"does this user have feature X?" rather than "did they pay through provider Y?" (spec §26, §86, §114). Every account
receives a free entitlement on registration that, in the current phase, stays active indefinitely (decisions §11,
§22). **No payment code is written in this step** — no checkout, no buttons, no webhooks (spec §89).

## Scope

**In scope**

- `subscriptions` schema per spec §26.
- Automatic free entitlement created when a user registers; `expiresAt = null` and **no automatic expiry** in the
  current phase (decisions §11, §22).
- A centralised `hasFeatureAccess(userId, feature)` / `hasEntitlement()` service used by other steps.
- Feature-key constants so premium limits are declared in one place (spec §114).
- `GET /api/v1/subscription` returning the caller's effective entitlement.
- A documented seam where providers will later attach, without implementing them.

**Out of scope (do not build now)**

- Razorpay order/verify/webhook endpoints (spec §27, §87, §89).
- Google Play Billing verification (spec §27, §88, §89).
- The `payment_transactions` collection — future-only per spec §127.
- Pricing pages, upgrade prompts, or trial-expiry enforcement messaging.

**Later**

- `PaymentTransaction` model and provider integration (spec §27, decisions §17).
- Trial expiry policy and downgrade behaviour — **only** once an explicit payment-related product update defines them
  (decisions §11).

**FINAL — indefinite free access, no premium restrictions (decisions §11, §12, §22).**

- Every account gets `{ plan: "free", status: "active", source: "free_trial", startedAt: <registration time>,
  expiresAt: null }`.
- `source: "free_trial"` is retained **only for schema compatibility** with the current specification. It does
  **not** mean the current free entitlement will expire.
- **Do not run the expiry process against `plan = "free"` with `expiresAt = null`.** The current free plan stays
  `active` indefinitely; there is no automatic `active → expired` transition for it.
- There are **no premium feature restrictions** in the current version: every currently implemented feature is free.
  `hasFeatureAccess(userId, feature)` returns `true` for currently available features while the account itself is
  active and otherwise eligible.
- The entitlement layer still exists so future payment logic has one central access-control point. When monetisation is
  introduced, paid plans, the premium feature set, limits, and the provider mapping are defined together at that time
  — never preemptively blocking existing features, and never changing an existing free user's access as a side effect
  of adding payment code.

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| Auth service with a registration hook | 03 | `audited_passed` |
| Authenticated identity and roles | 04 | `audited_passed` |

> This step depends only on step 04, so it may be built in parallel with the profile track (steps 05–14).

## Deliverables

```text
server/src/models/Subscription.js            # spec §26 schema + indexes
server/src/services/entitlementService.js    # grant, get, hasEntitlement, hasFeatureAccess, expire
server/src/services/subscriptionService.js   # getActiveForUser, createFreeTrial
server/src/controllers/subscription.controller.js
server/src/routes/subscription.routes.js
server/src/constants/features.js             # feature keys + which plan includes them
server/src/constants/plans.js                # plan identifiers and sources
```

## Data model

### `subscriptions` (spec §26)

```js
{
  _id: ObjectId,
  userId: ObjectId,
  plan: String,                                        // "free" for the current phase
  status: "active" | "expired" | "cancelled",
  source: "free_trial" | "razorpay" | "google_play",
  startedAt: Date,
  expiresAt: Date | null,
  createdAt: Date,
  updatedAt: Date
}
```

| Index | Definition | Purpose |
|---|---|---|
| user + status | `{ userId: 1, status: 1 }` | Find the active entitlement |
| expiry | `{ status: 1, expiresAt: 1 }` | Expiry sweep — only for rows that actually have a non-null `expiresAt`; the free plan (`expiresAt: null`) is never touched (decisions §11) |

### Entitlement decision flow (spec §86)

```text
Caller needs a feature
        ↓
entitlementService.hasFeatureAccess(userId, "feature_key")
        ↓
load active subscription for the user
        ↓
map plan -> feature set (constants/features.js)
        ↓
permissions resolved from the backend only
```

The rest of the application must **never** branch on `source === "razorpay"` or on the presence of a payment. It asks
about features.

### Feature key example

```js
// constants/features.js
export const FEATURES = {
  SEND_INTEREST: "send_interest",
  VIEW_CONTACT_DETAILS: "view_contact_details",
  ADVANCED_SEARCH: "advanced_search",
  SEE_WHO_VIEWED: "see_who_viewed",
  UNLIMITED_CHAT: "unlimited_chat",
};
```

**FINAL — this list carries no restrictions in the current phase (decisions §12).** The keys exist so the access-control
point is centralised, but the free plan grants every one of these features. Do not gate any of them now.

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/v1/subscription` | authenticated | The caller's effective plan, status, dates, and granted features |

Nothing else is exposed in this phase. The later provider endpoints are listed in spec §32 but must not be created now
(spec §89).

## Build tasks

- [ ] 1. Write `models/Subscription.js` with the schema, base plugin, and indexes.
- [ ] 2. Write `constants/plans.js` (`free`, and placeholder identifiers for future paid plans) and
      `constants/features.js` (feature keys plus the plan-to-feature map).
- [ ] 3. Write `subscriptionService.createFreeTrial(userId)`: create one `plan: "free"`, `source: "free_trial"`,
      `status: "active"` record with **`expiresAt: null`** (decisions §11, §22). Be idempotent so a retried
      registration hook cannot create duplicates (unique index on `{ userId, status }` for `active`, or an upsert).
      Do not compute an expiry date for the free plan.
- [ ] 4. Hook `createFreeTrial` into the registration path from step 03, so a new account always has an entitlement.
      Backfill existing accounts created before this step with a documented migration.
- [ ] 5. Write `entitlementService.hasEntitlement(userId)` and `hasFeatureAccess(userId, featureKey)`:
      load the active subscription, resolve the plan's feature set, and return a boolean plus a reason for logging.
      Cache nothing server-side yet (spec §61); the query is indexed and cheap.
- [ ] 6. Write the expiry sweep so it transitions **only** rows that have a non-null `expiresAt` and that past-due
      date, using the expiry index, and logs the count. It must **skip `plan: "free"` / `expiresAt: null` rows
      entirely** — the current free entitlement never expires (decisions §11, §22).
- [ ] 7. Write the controller and route for `GET /subscription`, returning plan, status, `startedAt`, `expiresAt`,
      and the resolved feature list for the caller. Never return another user's subscription (spec §44).
- [ ] 8. Document the provider seam: a comment block in `entitlementService` naming where a provider webhook would
      call `grant()` to create or update a subscription, and noting that no provider code exists yet (spec §87, §88, §89).
- [ ] 9. Add `hasFeatureAccess` as the single gate that other steps use; if any earlier step hardcoded a premium
      assumption, route it through this service instead (spec §86).
- [ ] 10. Add `payment_transactions` to the **future-only** list in `constants/collections.js` with a comment that it
      is intentionally not created (spec §127).

## Business rules & security

- **Entitlement is backend-decided.** A client cannot claim a plan, feature, or provider; a `plan` in a request body
  is rejected (spec §31, §44, §88).
- **Providers never own business logic.** They will only update entitlement status (spec §26, §86). No matrimonial
  rule may depend on a provider name.
- **No payment code in this phase** — no order creation, no webhook routes, no purchase validation (spec §89).
- **No secrets yet:** any future provider secret is declared only when the provider is actually added (spec §79, §124).
- **One active entitlement per user** at a time.
- **Free access does not expire:** there is no automatic `active → expired` transition for the free plan, and no code
  may expire an entitlement that has `expiresAt: null` (decisions §11, §22).
- **No premium gating now:** `hasFeatureAccess` is the single gate and returns true for currently available features;
  the premium mapping is defined only at monetisation time (decisions §12).
- **Privacy:** a subscription record is private to its owner; only admins may inspect another user's status
  (spec §28, §112).

## Config / environment additions

```text
FREE_TRIAL_DAYS          # NOT used in the current phase; the free plan has expiresAt = null (decisions §11).
                         # Kept declared only for a future explicit payment-related update.
DEFAULT_FREE_PLAN        # plan identifier granted on registration
```

No payment provider variables are added in this step.

## Verification commands

```bash
# 1. Registration grants a free entitlement
curl -sS -X POST http://localhost:3000/api/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"identifierType":"email","identifier":"trial@example.com","password":"correct-horse-battery"}'
ACCESS=$(curl -sS -X POST http://localhost:3000/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"identifierType":"email","identifier":"trial@example.com","password":"correct-horse-battery"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.accessToken))")
curl -sS -H "Authorization: Bearer $ACCESS" http://localhost:3000/api/v1/subscription
# Expected: 200 with plan "free", source "free_trial", status "active"

# 2. No duplicate entitlements
#   Inspect the subscriptions collection for that user.
# Expected: exactly one active row

# 3. Feature access resolution
node -e "/* call entitlementService.hasFeatureAccess(userId,'send_interest') */"
# Expected: true under the current free plan

# 4. No payment routes exist
curl -sS -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/v1/subscription/razorpay/order
# Expected: 404 — intentionally not implemented

# 5. Cross-account access
curl -sS -H "Authorization: Bearer $OTHER_ACCESS" http://localhost:3000/api/v1/subscription
# Expected: that account's own subscription only

# 6. Unauthenticated
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:3000/api/v1/subscription
# Expected: 401

# 7. Expiry sweep
#   Seed an active row with a past expiresAt, run the sweep.
# Expected: status becomes "expired"; access behaviour matches the recorded decision
```

## Audit checklist

### Gate 1 — Build integrity

- [ ] **G1.1** Every deliverable exists; the subscription route is mounted and protected.
- [ ] **G1.2** Server boots with the model and indexes in place.
- [ ] **G1.3** Steps 01–04 verification commands still pass, and any step that consulted entitlement still works.

### Gate 2 — Functional

- [ ] **G2.1** Registration creates exactly one free entitlement with `plan: "free"`, `status: "active"`,
      `expiresAt: null` (decisions §11).
- [ ] **G2.2** Pre-existing accounts are backfilled so every user has an entitlement.
- [ ] **G2.3** `hasFeatureAccess()` returns the correct answer for the current plan and is the only feature gate used.
- [ ] **G2.4** `GET /subscription` returns plan, status, dates, and resolved features.
- [ ] **G2.5** The expiry sweep transitions only past-due rows that have a non-null `expiresAt`; running it leaves
      a `plan: "free"` / `expiresAt: null` entitlement `active` (decisions §11, §22).
- [ ] **G2.7** `hasFeatureAccess()` returns true for every currently implemented feature under the free plan, with no
      feature gated (decisions §12).
- [ ] **G2.6** Re-running the registration hook cannot create a second entitlement.

### Gate 3 — Security

- [ ] **G3.1** A client-supplied plan, source, or feature cannot change entitlement resolution.
- [ ] **G3.2** One account cannot read another account's subscription.
- [ ] **G3.3** No payment/provider route exists in this phase (404 on the documented future paths).
- [ ] **G3.4** No provider secret or placeholder credential is present in the codebase or `.env.example`.
- [ ] **G3.5** Business logic contains no branch on a provider name.
- [ ] **G3.6** Unauthenticated access returns 401.

### Gate 4 — Performance & data

- [ ] **G4.1** Entitlement lookup uses the `{ userId, status }` index (`IXSCAN`).
- [ ] **G4.2** `hasFeatureAccess()` does not issue a query per feature in a loop; one lookup resolves the plan's set.
- [ ] **G4.3** The expiry sweep uses the expiry index.

### Gate 5 — Spec conformance

- [ ] **G5.1** §26 — the subscription document matches the specification.
- [ ] **G5.2** §86 / §114 — access is checked through a centralised feature/entitlement service.
- [ ] **G5.3** §89 — no payment flow, checkout, or webhook is implemented.
- [ ] **G5.4** §27 / §127 — `payment_transactions` is documented as future-only and not created.
- [ ] **G5.5** §87 / §88 — provider flows are described as future work only.
- [ ] **G5.6** §124 — payment providers appear only in the "later" section.
- [ ] **G5.7** decisions §11, §12, §22 — indefinite free access (`expiresAt: null`, no automatic expiry) and the
      absence of premium restrictions are stated and verifiable.

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

- [ ] Every account has exactly one **indefinite** active free entitlement after registration (`expiresAt: null`).
- [ ] Feature access is asked through one service and never inferred from a provider.
- [ ] Every currently implemented feature is available on the free plan; nothing is gated.
- [ ] No payment integration exists, and none of its endpoints are reachable.
- [ ] The provider seam is clearly documented for a future step.
- [ ] Adding Razorpay or Play Billing later requires no change to profile, connection, or chat logic.

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence | |
| Fixes required | |
