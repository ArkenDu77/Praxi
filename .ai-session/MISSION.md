# Arkiba Mission

## North Star

Turn the current Arkiba prototype into a real, commercially deployable operational platform for French medical practices.

No mocked workflow, fake integration, hard-coded demo path, simulated success, or placeholder dependency may be counted as production-ready.

The immediate objective is commercial readiness. The long-term objective is an operational layer / OS for the medical practice.

## Product direction

Arkiba should progressively combine the strongest ideas observed in:

- Paratus: conversational pre-visit intake and structured consultation preparation.
- Elite: omnichannel patient front office, specialty rulebooks, escalation and resolved-interaction workflows.
- Avoca: request extraction/classification, practice-specific operational rules, matching and operational learning.
- Beacon: execution inside external healthcare software and chained actions.
- Plena: orchestration across existing practice tools rather than forcing replacement of the entire stack.

These are product references, not products to clone.

## Target operating loop

Patient request
→ capture through phone/SMS/web/document
→ normalize into a canonical request
→ apply practice rules
→ resolve or schedule
→ prepare the consultation
→ assist the physician
→ generate/validate documents
→ execute approved actions in external systems
→ perform follow-up
→ retain a complete audit trail.

## Hard constraints

1. Real patient data must never be copied into AI handoffs, .ai-session artifacts, synthetic fixtures, or persistent agent memory.
2. Every production resource must belong to a tenant/practice and authorization must be enforced server-side.
3. External writes that can affect a patient record require explicit safeguards and auditability.
4. API integrations are preferred. Browser/computer-use is a controlled fallback, never an excuse to claim an integration exists when it does not.
5. A task is not DONE because an agent says it is done. It is DONE only when acceptance criteria and evidence pass independent review.
6. M000 is audit-only: understand the current system before making product changes.
