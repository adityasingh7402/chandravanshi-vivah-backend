---
step: 00                 # zero-padded step number, matches the filename prefix
title: Template           # short title, matches the filename suffix
status: not_started       # not_started | in_progress | built | audited_passed | audited_notes | failed
build: not_started        # not_started | in_progress | built
audit: not_run            # not_run | in_progress | passed | notes | failed
depends_on: []            # step numbers that must be audited_passed first
unblocks: []              # step numbers this step enables
spec_refs: []             # spec section numbers this step implements, e.g. ["§5", "§40"]
---

# Step NN — <Title>

> Copy this file to `NN-<slug>.md` and replace every placeholder. Delete this blockquote and any
> guidance you have not filled in. Keep the section order identical across all steps.

## Goal

One paragraph: what this functionality is, why it exists in the product, and which spec sections define it.

## Scope

**In scope**

- …

**Out of scope (do not build now)**

- …

**Later** (explicitly deferred; note which spec section defers it)

- …

If a decision is required that neither source document makes, write `OPEN DECISION:` and the question, and treat the step as blocked on a product answer rather than inventing a rule.

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| … | NN | `audited_passed` |

## Deliverables

Exact files and folders, relative to the backend repository root, following the structure in spec §4.

```text
server/src/…
```

## Data model

The collection(s) and schema(s) this step owns. Quote the specification's schema and note which fields are
master-data IDs (for filtering) versus denormalized display names (spec §10).

| Collection | Fields | Indexes |
|---|---|---|
| … | … | … |

## API surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| … | … | … | … |

All responses use the envelope from spec §33 (`success`, `data`, `message` / `success`, `message`).

## Build tasks

Ordered. Each task is a single reviewable change: route → controller → service → model.

- [ ] 1. …
- [ ] 2. …

## Business rules & security

- **Authorization / ownership:** (spec §44)
- **Validation:** (spec §34, §81)
- **Query construction:** (spec §35) — allowlisted filters only, never `Model.find(req.query)`
- **Rate limiting:** (spec §36)
- **Response fields:** what must be omitted (spec §30, §51, §59)

## Config / environment additions

Names only — never values. Add to `.env.example` and the env schema.

```text
VAR_NAME   # what it is for
```

## Verification commands

Commands that prove the build works, with the expected result.

```bash
# Expected: 200 with { success: true }
curl -sS http://localhost:3000/api/v1/…
```

## Audit checklist

Run after the build tasks are complete and the verification commands pass. Every box needs a command and an
observed result.

### Gate 1 — Build integrity

- [ ] **G1.1** All deliverables exist at the stated paths.
- [ ] **G1.2** Server boots with no errors.
- [ ] **G1.3** No earlier step's verification command now fails (regression check).

### Gate 2 — Functional

- [ ] **G2.1** Happy path …
- [ ] **G2.2** Boundary case …
- [ ] **G2.3** Error case …

### Gate 3 — Security

- [ ] **G3.1** Unauthenticated request is rejected with 401.
- [ ] **G3.2** Wrong-owner / wrong-role request is rejected with 403 (or 404 where existence must not leak).
- [ ] **G3.3** Malformed and unexpected input is rejected, not silently coerced.
- [ ] **G3.4** Response contains no field listed as restricted in spec §30.

### Gate 4 — Performance & data

- [ ] **G4.1** Index exists and the query plan shows `IXSCAN` for the expected query.
- [ ] **G4.2** Response uses a projection and no unbounded result set.

### Gate 5 — Spec conformance

- [ ] **G5.x** Each cited `spec_refs` section is implemented as written (or the deviation is recorded).

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

The step is done when all of the following hold. These are the conditions the audit confirms.

- [ ] …
- [ ] …

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence | |
| Fixes required | |
