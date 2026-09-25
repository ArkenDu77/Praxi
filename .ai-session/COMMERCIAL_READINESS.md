# Definition of Commercial Readiness

Arkiba is not commercially ready until all applicable gates below are objectively satisfied.

## Reliability
- 0 known P0 defects.
- 0 known P1 defects in supported production workflows.
- Critical workflows have deterministic E2E coverage.
- Failure/retry behavior is defined for external calls.
- Idempotency is verified where duplicate events/actions are possible.

## Security
- 0 known cross-tenant vulnerabilities.
- Authentication and authorization are tested.
- Storage/files/exports/jobs/webhooks follow tenant isolation.
- Secrets are not stored in source code.
- Independent security review is completed before meaningful patient production rollout.

## Intake
- Appointment/event detection is observable.
- SMS pre-notification is real if advertised.
- Outbound call is real if advertised.
- Secure fallback web intake is real if advertised.
- Per-stage timestamps exist.
- Target appointment-to-trigger median <= 30 seconds.
- Target P95 <= 60 seconds.
- Retry and duplicate protection tested.

## Clinical/document workflow
- Patient-supplied vs clinician-validated provenance is represented.
- Unknown/uncertain/missing information is handled explicitly.
- Physician can review/edit before final external write when required.
- Document regression corpus exists.
- No fabricated identity, allergy, antecedent or clinical fact is silently introduced.

## Integrations
- Doctolib: only supported real workflows may be advertised.
- EMED: only supported real workflows may be advertised.
- Adapter boundaries isolate vendor-specific implementation.
- A mock/simulator may exist for tests but never satisfies production acceptance criteria.

## Operations
- Staging exists.
- Production monitoring exists.
- Alerting exists.
- Backups exist.
- Restore is tested.
- CI/CD required checks exist.
- Load testing covers at least the intended 50-practice launch scale.

## Commercial workflow
- Subscription state is server-side authoritative.
- Checkout, webhooks, billing portal and cancellation/plan changes work for supported plans.

## External/human gates
- HDS hosting requirements are addressed before real patient production deployment.
- Legal/RGPD/regulatory review is completed for the actual claimed functionality.
- External provider/API contracts and credentials are obtained where required.
