# Security Model — Initial Non-Negotiables

## Tenant invariant

EVERY PATIENT-RELATED OR PRACTICE-RELATED RESOURCE BELONGS TO A TENANT.

Authorization is enforced server-side for every read/write/export/action.

Never trust:
- client-provided practice IDs;
- URL IDs;
- hidden fields;
- UI visibility;
- object IDs alone.

## Cross-tenant adversarial tests

At minimum:
- practice A cannot read patient B;
- practice A cannot mutate patient B;
- changing a URL/ID cannot cross tenant boundaries;
- direct API calls cannot cross tenant boundaries;
- exports/files/audio/transcripts/documents cannot cross tenant boundaries;
- search cannot leak another tenant;
- integration tokens cannot cross tenant boundaries;
- jobs/queues/webhooks cannot execute under the wrong tenant;
- admin/support paths are explicitly scoped and audited.

## Sensitive data and AI workflow

Never put real patient data or production credentials in:
- .ai-session;
- agent handoffs;
- ECC memory;
- test fixtures;
- screenshots committed to Git;
- public issue/PR text.

Use synthetic identifiers and synthetic medical scenarios.

## High-risk changes

Require independent review and explicit evidence:
- authentication;
- authorization;
- tenant model;
- patient identity matching;
- destructive migrations;
- external EHR writes;
- credential/secrets handling;
- backup/restore;
- encryption/key management.
