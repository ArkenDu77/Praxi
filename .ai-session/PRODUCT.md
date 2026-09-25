# Arkiba Product Architecture Direction

## Shared operational core

Arkiba must become one coherent system, not five products glued together.

Target layers:

1. Practice Graph
   Canonical model for practices, practitioners, patients, locations, resources, appointment/request types, operational rules, permissions and external systems.

2. Patient Access
   Phone, SMS, secure web intake, and later other supported channels.

3. Request Engine
   Every incoming interaction becomes a normalized request/event with provenance and status.

4. Practice Brain
   Explicit versioned practice/specialty rules. Learned suggestions require validation before becoming active rules.

5. Intake & Clinical Workspace
   Structured pre-visit intake, provenance, uncertainty, consultation notes, physician review and document generation.

6. Action Layer
   Stable adapter boundary for Doctolib, EMED and future practice software.
   Prefer official APIs. Controlled browser/computer-use only where APIs are unavailable and safety permits.

7. Back Office
   Follow-up, incoming/outgoing documents, reminders, administrative workflows and other appropriate automations.

8. Trust Layer
   Authentication, authorization, tenant isolation, audit trail, monitoring, alerting, backups, human escalation and reversible/safe execution where possible.

## Existing repositories

Primary Arkiba repository:
ArkenDu77/Praxi

Arkiba Intake currently also exists as a separate repository:
ArkenDu77/arkiba-intake

M000 must determine whether Intake remains separate, becomes a service/package, or is integrated behind a stable interface. Do not merge repositories blindly.
