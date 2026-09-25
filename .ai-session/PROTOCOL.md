# Shared Communication Protocol

The repository is the shared truth. The user must not act as a courier between agents.

## Control plane

Communication happens through:
1. GitHub task issues / pull requests;
2. versioned files in .ai-session;
3. machine-readable task state and handoffs.

## Task lifecycle

READY
→ ASSIGNED
→ IMPLEMENTING
→ REVIEW_READY
→ REVIEWING
→ REJECTED or APPROVED
→ MERGE_READY
→ MERGED
→ VERIFIED

If REJECTED:
REJECTED → ASSIGNED_TO_BUILDER → IMPLEMENTING → REVIEW_READY.

## Required task artifact

Each task must have a file under:
.ai-session/tasks/<TASK-ID>.md

It must include:
- WHY
- SCOPE
- OUT OF SCOPE
- DEPENDENCIES
- ACCEPTANCE CRITERIA
- SECURITY REQUIREMENTS
- TEST REQUIREMENTS
- PERFORMANCE REQUIREMENTS when applicable
- ROLLBACK PLAN
- HUMAN/EXTERNAL BLOCKERS

## Builder handoff

.ai-session/handoffs/builder/<TASK-ID>.md

Must contain:
- branch;
- commit SHA;
- root cause;
- files changed;
- tests executed;
- exact results;
- before/after metrics where applicable;
- known risks;
- remaining external blockers.

## Reviewer handoff

.ai-session/handoffs/reviewer/<TASK-ID>.md

Must contain:
- reviewed commit;
- checks performed;
- additional tests performed;
- security findings;
- regressions;
- verdict;
- reproducible rejection reasons if any.

## Locks

Domain lock files live in .ai-session/locks/.

Typical domains:
auth, tenant, database, intake, telephony, documents, doctolib, emed, billing, frontend, infrastructure.

An agent must not modify a locked domain owned by another active task unless Astra explicitly resolves it.

## No false completion

The following never count as completion:
- screenshots without functional verification;
- mocks of a production integration;
- hard-coded demo responses;
- skipped failing tests;
- tests that only validate mocks;
- a manual happy-path test when a critical E2E test is required;
- "looks correct" or "should work".
