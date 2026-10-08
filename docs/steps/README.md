# Backend Build Steps — Build & Audit Playbook

This folder turns the two source specifications into **one buildable, auditable document per functionality**.

- Build one step.
- Run that step's **audit checklist**.
- Record the verdict in [`00-progress-tracker.md`](00-progress-tracker.md).
- Only then start the next step.

The steps follow the specification's own V1 development order (spec §116) so that nothing is built before the thing it depends on.

## Source documents

| Document | Location | Role |
|---|---|---|
| Express.js Backend Specification | [`../../../Chandravanshi-Vivah-Documents/chandravanshi-matrimonial-express-backend-spec.md`](../../../Chandravanshi-Vivah-Documents/chandravanshi-matrimonial-express-backend-spec.md) | Architecture, data model, security, API design |
| Profile Fields & Options Dictionary | [`../../../Chandravanshi-Vivah-Documents/chandravanshi-matrimonial-profile-fields-options.md`](../../../Chandravanshi-Vivah-Documents/chandravanshi-matrimonial-profile-fields-options.md) | Field-level input rules, master data lists, enums |
| Finalized Backend Decisions | [`../../../Chandravanshi-Vivah-Documents/chandravanshi-finalized-backend-decisions.md`](../../../Chandravanshi-Vivah-Documents/chandravanshi-finalized-backend-decisions.md) | Resolves every question the step files had marked `OPEN DECISION`; treated as FINAL |
| Community Format (names only) | [`../../../Chandravanshi-Vivah-Documents/chandravanshi-community-format.md`](../../../Chandravanshi-Vivah-Documents/chandravanshi-community-format.md) | The community / sub-community / surname / gotra / clan / aaspad name lists and their parent scopes |

The step files **derive from and cite** these documents; they never replace them. Where the two specifications disagree, the backend specification wins for architecture and the fields dictionary wins for field-level input rules. If a step needs a decision neither document makes, the step marks it `OPEN DECISION` instead of inventing an answer.

**Previously open decisions are now closed.** The finalized decisions document resolves the questions that the step files had raised, and each affected step records the FINAL rule inline (see step 02 network policy, 05 `master_data_requests`, 07 option sets, 08 `kundli_documents`, 10 profile views, 11 `closed`/re-send, 13 `new_match`, 15 free-plan expiry, 16 roles and rename). New `OPEN DECISION` markers should only appear for questions raised **after** that document.

**Missing master-data values are user-recorded, not blocked.** For the community-context categories, a value a user cannot find is submitted on the spot, stored with that user's `userId`, and immediately selectable for every other user — flagged as user-contributed until an admin verifies it. This refines decision §3 and is specified in [step 05](05-master-data.md).

## How to use a step file

Every step file has the same shape:

1. YAML front matter (`step`, `title`, `status`, `build`, `audit`, `depends_on`, `unblocks`, `spec_refs`)
2. Goal and Scope
3. Prerequisites
4. Deliverables (exact files/folders)
5. Data model
6. API surface
7. Build tasks (ordered checkboxes)
8. Business rules & security
9. Config / environment additions (names only, never values)
10. Verification commands
11. Audit checklist (five gates)
12. Acceptance criteria
13. Sign-off block

Update the front matter and the tracker when a step's status changes.

## Steps

| # | Step | Depends on | Unblocks |
|---|---|---|---|
| 01 | [Project Setup & Configuration](01-project-setup-and-config.md) | — | 02 |
| 02 | [MongoDB Connection](02-mongodb-connection.md) | 01 | 03 |
| 03 | [User & Authentication](03-user-authentication.md) | 02 | 04 |
| 04 | [Session / Token Handling](04-session-token-handling.md) | 03 | 05, 15 |
| 05 | [Master Data](05-master-data.md) | 04 | 06 |
| 06 | [Matrimonial Profile](06-matrimonial-profile.md) | 05 | 07, 08 |
| 07 | [Partner Preferences](07-partner-preferences.md) | 06 | 09 |
| 08 | [Photos & Cloudinary](08-photos-cloudinary.md) | 06 | 09 |
| 09 | [Discover / Search](09-discover-search.md) | 07, 08 | 10 |
| 10 | [Profile Actions](10-profile-actions.md) | 09 | 11 |
| 11 | [Interests / Connections](11-interests-connections.md) | 10 | 12, 14 |
| 12 | [Block & Report](12-block-report.md) | 11 | 13, 16 |
| 13 | [Notifications](13-notifications.md) | 12 | 16 |
| 14 | [Chat](14-chat.md) | 11 | 16 |
| 15 | [Subscription / Entitlement](15-subscription-entitlement.md) | 04 | 16 |
| 16 | [Admin & Moderation](16-admin-moderation.md) | 12, 13, 14, 15 | 17 |
| 17 | [Performance Testing](17-performance-testing.md) | 16 | 18 |
| 18 | [Security Review](18-security-review.md) | 17 | — |

### Dependency graph

```text
01 → 02 → 03 → 04 → 05 → 06 → 07 ┐
                        │         ├→ 09 → 10 → 11 → 12 → 13 ┐
                        └→ 08 ────┘         │                ├→ 16 → 17 → 18
                                           └→ 14 ────────────┤
                                    04 → 15 ──────────────────┘
```

Step 15 (entitlement) depends only on step 04, so it may be built in parallel with the profile track.

## Status legend

Used in both the step front matter and the tracker.

| Status | Meaning |
|---|---|
| `not_started` | No work begun |
| `in_progress` | Being built |
| `built` | Deliverables exist and the step's own verification commands pass; audit not yet run |
| `audited_passed` | All five audit gates checked **with evidence** |
| `audited_notes` | Audited; non-blocking findings or follow-ups recorded |
| `failed` | Audit found a blocking defect; must be fixed and re-audited |

Front matter splits this into two independent fields: `build` and `audit`. A step can be `build: built` / `audit: not_run` — that is a normal intermediate state.

## Audit protocol

Each step ends with five gates. An audit is **evidence-based**: every checkbox must cite the command run and the observed result. "Looks right" is not a pass.

| Gate | Question | Evidence |
|---|---|---|
| **G1 — Build integrity** | Do the deliverables exist, does the server boot, and did this step break anything earlier? | File listing, boot log, re-run of prior steps' verification commands |
| **G2 — Functional** | Does each endpoint/behaviour do what the step claims, including edge cases? | Request/response pairs captured for happy path, boundary, and error cases |
| **G3 — Security** | Are authorization, ownership, validation, and data-exposure rules enforced server-side? | Negative tests: wrong user, wrong role, malformed input, injection payloads, response field inspection |
| **G4 — Performance & data** | Are indexes used, is projection applied, is pagination bounded? | `explain("executionStats")` output, payload sizes |
| **G5 — Spec conformance** | Does the implementation match the cited spec sections? | Checkbox against each `spec_refs` entry |

### Verdict rules

- `PASS` — every gate checked, with evidence attached for each.
- `PASS WITH NOTES` — gates checked, non-blocking findings or deferred items recorded, each with an owner.
- `FAIL` — any gate failed. Record a fixes-required list; the step returns to `in_progress` and cannot be marked audited until re-run.

### Audit order and regression rule

Audit steps in numeric order. **A step cannot be marked `audited_passed` while any prerequisite step is unaudited.**

Because later work can break earlier work, the tracker has a **Regressed by** column. After audit of steps 09, 11, 14, 16, and 18 in particular, re-run the G1 and G3 checks of every step that shares a collection or route with the change. Record the re-run in the tracker's audit log; do not silently leave a stale pass in place.

## Conventions

- **Backend only.** The Next.js site and Expo app are consumers of this API (spec §90–§91). Frontend responsibilities are noted where relevant but never built here.
- **No secrets in docs.** Environment variables are referenced by name only (spec §79).
- **Library choices are recommendations**, not assertions. Approximate versions must be verified at implementation time (the specification's own disclaimer). `express@^5.2.1` is already installed in this repository, so step 01 is written against Express 5 behaviour.
- **Explicit "later" fences.** Payment collection (`payment_transactions`), OTP, email/phone verification, Redis, chat media, realtime chat transport, hard deletion, and AI matchmaking are documented as out of scope for the current version and appear only in the relevant step's "Later" notes (spec §115, §124; finalized decisions §17, §19).
- **The finalized decisions win over a former open marker.** Where a step previously said `OPEN DECISION`, it now states the FINAL rule with a `(finalized decisions §N)` citation.

## Appendix

| File | Role |
|---|---|
| [_master-data-community-format.md](_master-data-community-format.md) | The community / sub-community / surname / gotra / clan / aaspad name lists and scopes, generated verbatim from the community-format source. Seed input for step 05; not a build step. |

## Out of scope for this folder

Application code, dependency installation, and edits to the two source specification files.
