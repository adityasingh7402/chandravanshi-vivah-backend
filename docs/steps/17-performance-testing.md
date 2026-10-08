---
step: 17
title: Performance Testing
status: not_started
build: not_started
audit: not_run
depends_on: [16]
unblocks: [18]
spec_refs: ["§18", "§49", "§50", "§51", "§52", "§65", "§66", "§82", "§106", "§107", "§108", "§123"]
---

# Step 17 — Performance Testing

## Goal

Replace assumptions with measurements. This step builds a reproducible dataset generator and a benchmark harness, then
records query plans and latency for the important read and write paths at realistic dataset sizes (spec §106). The
specification explicitly refuses to promise a fixed millisecond figure and instead asks for targets that are tested
(spec §123), so this step produces **evidence**, not claims.

## Scope

**In scope**

- A seed generator producing realistic volumes of users, profiles, preferences, photos, actions, connections,
  conversations, messages, notifications, and master data.
- An `explain("executionStats")` harness for the important queries, capturing `IXSCAN` versus `COLLSCAN`,
  `executionTimeMillis`, `nReturned`, `totalKeysExamined`, and `totalDocsExamined` (spec §50).
- Latency measurement for the key endpoints, reported as percentiles, not averages alone.
- A written performance report artifact with the measured numbers and the dataset size behind them.
- Regression detection: a stored baseline that a later run can be compared against.

**Out of scope (do not build now)**

- Production load testing against live traffic or third-party traffic generators.
- Redis or any caching layer; the specification says to add it only when measurements justify it (spec §61, §124).
- Cloudinary or CDN tuning beyond confirming transformation sizes are used (spec §18).
- Frontend rendering performance; this step measures the API.

**Later**

- Adding Redis, and re-measuring, if a measured repeated-read problem appears (spec §61, §62).
- Continuous performance checks in CI once a stable baseline exists.

## Prerequisites

| Requirement | Step | Must be |
|---|---|---|
| Complete backend surface to measure | 16 | `audited_passed` |
| Indexes created in step 09 with recorded plans | 09 | `audited_passed` |

> Run this against an environment with a dataset of the intended size. The specification's own warning applies: a
> benchmark with ten test users proves nothing (spec §106, §123). Use a staging cluster and disposable data.

## Deliverables

```text
server/scripts/seed-load-test.js            # dataset generator with configurable volumes
server/scripts/bench-queries.js             # explain() harness for the important queries
server/scripts/bench-endpoints.js           # latency harness for key endpoints
server/scripts/perf-baseline.json           # committed baseline of measured numbers
server/perf/report-template.md              # structure for the written report
server/perf/reports/<date>-<size>.md        # generated reports (one per run)
server/src/config/perfTargets.js            # declared targets, not promises
```

## Data model

No new collection. This step reads and writes the existing collections to build fixtures.

### Dataset sizes (spec §106)

| Tier | Profiles | Purpose |
|---|---|---|
| Small | 1,000 | Fast local sanity check |
| Medium | 10,000 | Realistic early production |
| Large | 100,000 | Stress the index design |

Run the same suite at each tier and compare. A plan that is fast at 1,000 and degrades at 100,000 indicates an index
or query-shape problem, not a hosting problem.

### Queries to measure

| Query | Endpoint | Expected index |
|---|---|---|
| Default discover (active + gender + age) | `GET /discover` | Compound status/gender/DOB |
| Location-filtered discover | `GET /discover?cityId=…` | Compound status/gender/city |
| Occupation-filtered discover | `GET /discover?occupationId=…` | Compound status/gender/occupation |
| Community/gotra filter | `GET /discover?gotraId=…` | Compound status/gotra |
| Recency-sorted page | `GET /discover?sort=recently_active` | status/lastActiveAt |
| Distance search | `GET /discover?lat=…&lng=…` | 2dsphere |
| Profile card by public id | `GET /profile/:publicProfileId` | Unique publicProfileId |
| Own profile | `GET /profile/me` | Unique userId |
| Master-data search | `GET /master-data/occupations?query=…` | name/slug index |
| Conversation history page | `GET /conversations/:id/messages` | conversation/createdAt |
| Notification inbox page | `GET /notifications` | userId/createdAt |

For each: record the plan stage, `executionTimeMillis`, `nReturned`, `totalKeysExamined`, and `totalDocsExamined`
(spec §50).

### Targets (spec §123)

Targets are declared in `perfTargets.js` and are **thresholds to test**, not guarantees:

```text
discover p95 latency            <= <target ms>   at medium tier
profile read p95 latency        <= <target ms>
master-data read (cached)       near-instant
totalDocsExamined / nReturned   <= <small ratio> for the default discover query
```

Fill in concrete numbers for this deployment before running the suite. Do not copy a figure from the specification —
it deliberately does not give one.

## API surface

None. This step adds scripts and reports only; no route is created or changed.

## Build tasks

- [ ] 1. Write `scripts/seed-load-test.js`: generate master data first, then users, profiles (with valid IDs from the
      generated master data), preferences, photos, actions, connections, conversations, messages, and notifications.
      Support `--profiles`, `--users`, and `--seed` for reproducibility, and distribute values realistically across
      gender, age, city, occupation, and status so filters return meaningful subsets.
- [ ] 2. Make the generator idempotent per seed value and clearly marked as non-production data.
- [ ] 3. Write `scripts/bench-queries.js`: for each query in the table, run
      `.explain("executionStats")`, capture the plan stage and the four counts, print a table, and write JSON.
- [ ] 4. Write `scripts/bench-endpoints.js`: drive the real endpoints with authenticated tokens and record
      p50/p90/p95/p99 latency plus payload size. Exclude Cloudinary image fetches; measure API time only.
- [ ] 5. Write `config/perfTargets.js` with the declared thresholds and a clear comment that they are targets to
      verify, not promises (spec §123).
- [ ] 6. Write `perf/report-template.md` and generate `perf/reports/<date>-<size>.md` containing: env details, dataset
      sizes, the query-plan table, the latency table, payload sizes, and any index that was added or rejected.
- [ ] 7. Commit `perf-baseline.json` after the first accepted run, and add a comparison mode that flags a regression
      beyond a defined tolerance.
- [ ] 8. Verify projection and payload size: confirm discover card responses contain only the projected fields and one
      small transformed photo URL (spec §51, §18, §107).
- [ ] 9. Verify no populate chain exists on any measured read path (spec §66) and record the result.
- [ ] 10. Verify pagination bounds at scale: page through discover at the large tier and confirm stable `nextCursor`
      behaviour and no deep-skip degradation (spec §52).
- [ ] 11. Record every index decision: which queries justified which index, and any index proposed and rejected as
      unnecessary, so the index set stays deliberate (spec §49, §82 item 6).
- [ ] 12. Explicitly note in the report whether Redis is justified by the measurements, and if not, say so with the
      numbers behind the conclusion (spec §61, §124).

## Business rules & security

- **Measure, do not assert.** No claim of a speedup or a latency figure is made without a recorded measurement.
- **Test at realistic size.** Small-dataset results are labelled as such and never presented as production evidence
  (spec §106).
- **Report the distribution**, not only the mean: p50/p90/p95/p99 with the dataset size attached.
- **Report the plan, not just the time:** `IXSCAN` versus `COLLSCAN`, and the examined-versus-returned ratio
  (spec §50).
- **Disposable data only.** The load generator must never run against a production database. Guard it with an
  environment check plus an explicit confirmation flag, and fail closed when the target is not local (spec §38, §98).
- **No sensitive data** in generated fixtures or report artifacts: no real user records, no secrets, no connection
  strings, and no production identifiers (spec §78, §79).
- **No public trigger.** Benchmarking is a command-line activity; nothing in this step is reachable through an API
  route (spec §91).
- **No production credentials** in benchmark tooling; use dedicated test accounts and a staging cluster
  (spec §38, §39).
- **No caching added without evidence.** Redis is not introduced here; the report must justify it from measurements
  or state that it is not yet warranted (spec §61, §124).

## Config / environment additions

```text
PERF_SEED_PROFILES       # target profile count for the generator
PERF_BASE_URL            # API base URL to benchmark
PERF_CONFIRM             # explicit guard required before seeding a non-local database
PERF_P95_TARGET_MS       # declared target for discover
PERF_DOCS_RATIO_TARGET   # examined/returned ratio target
```

## Verification commands

```bash
# 1. Generate a small dataset (safe, local)
PERF_SEED_PROFILES=1000 node scripts/seed-load-test.js --seed=1
# Expected: master data and 1000 profiles created; counts printed

# 2. Query plans
node scripts/bench-queries.js
# Expected: a table showing each query, its plan stage, and the four counts.
#           Every expected index shows IXSCAN (spec §50).

# 3. Endpoint latency
node scripts/bench-endpoints.js
# Expected: p50/p90/p95/p99 per endpoint plus payload sizes

# 4. Payload shape
curl -sS -H "Authorization: Bearer $ACCESS" 'http://localhost:3000/api/v1/discover?limit=20' | wc -c
# Expected: a small payload consistent with the projection (spec §51)

# 5. Safety guard
PERF_SEED_PROFILES=100 node scripts/seed-load-test.js
# Expected: refuses to run against a non-local database without PERF_CONFIRM

# 6. Repeat at the next tier and compare with the baseline
PERF_SEED_PROFILES=10000 node scripts/seed-load-test.js --seed=1 && node scripts/bench-queries.js
node scripts/bench-endpoints.js
# Expected: a comparison against perf-baseline.json, flagging any regression beyond tolerance
```

## Audit checklist

Every box must cite the command run and the recorded numbers.

### Gate 1 — Build integrity

- [ ] **G1.1** Every deliverable exists; scripts run standalone with the documented flags.
- [ ] **G1.2** The generator refuses to touch a non-local database without the explicit confirmation flag.
- [ ] **G1.3** Steps 01–16 verification commands still pass; performance work changed no behaviour.

### Gate 2 — Functional

- [ ] **G2.1** A dataset can be generated at each tier with reproducible content for a given seed.
- [ ] **G2.2** Generated profiles reference valid master-data IDs, so filters return non-empty result sets.
- [ ] **G2.3** The query harness reports a plan stage and the four counts for every listed query.
- [ ] **G2.4** The endpoint harness reports percentiles and payload sizes.
- [ ] **G2.5** Reports are generated from the template for each run.
- [ ] **G2.6** The regression comparison correctly flags a deliberately degraded query (prove the check actually works).

### Gate 3 — Security & safety

- [ ] **G3.1** The generator cannot be pointed at production without the guard flag, and the flag is documented as
      requiring deliberate intent.
- [ ] **G3.2** Report artifacts contain no secrets, connection strings, or real user data.
- [ ] **G3.3** Benchmarking uses test accounts, not a real user's credentials.
- [ ] **G3.4** Benchmarks cannot be triggered through any public route.

### Gate 4 — Performance & data

- [ ] **G4.1** Every expected query shows `IXSCAN` and not `COLLSCAN` at the medium tier; any exception is documented
      with its reason and a remediation.
- [ ] **G4.2** For the default discover query, `totalDocsExamined / nReturned` is within the declared target, and the
      measured ratio is written into the report.
- [ ] **G4.3** Latency targets in `perfTargets.js` are met or the gap is recorded with an owner.
- [ ] **G4.4** Results are recorded at two or more dataset sizes to show scaling behaviour, not a single point.
- [ ] **G4.5** Every index in the database maps to a measured query, and any unused index is proposed for removal.
- [ ] **G4.6** Card payloads remain small and use transformed image URLs (spec §18, §51).
- [ ] **G4.7** The report states whether Redis is justified by the numbers, with the supporting measurements
      (spec §61, §124).

### Gate 5 — Spec conformance

- [ ] **G5.1** §106 — testing occurs at realistic dataset sizes, not just a handful of records.
- [ ] **G5.2** §50 — `IXSCAN` and the examined/returned counts are recorded for important queries.
- [ ] **G5.3** §107 — read paths use projection, indexes, and pagination; write paths validate first and update only
      necessary fields (spot-check both).
- [ ] **G5.4** §65 — the performance levers from the specification are each verified or explicitly deferred.
- [ ] **G5.5** §82 — every listed anti-pattern is checked and reported absent (or fixed).
- [ ] **G5.6** §123 — targets are declared, tested, and reported as measured outcomes rather than guarantees.

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

- [ ] A repeatable dataset can be generated at small, medium, and large tiers.
- [ ] Every important query has a recorded plan proving index use, with counts.
- [ ] Latency is reported as percentiles against declared targets, with the dataset size stated.
- [ ] A committed baseline allows later runs to detect regressions.
- [ ] The report states, with evidence, whether any caching layer is currently justified.

## Sign-off

| Field | Value |
|---|---|
| Auditor | |
| Date | |
| Verdict | |
| Evidence (plans, latencies, payload sizes) | |
| Fixes required | |
