# Implementation Plan

Status: formalized

## Approach

Composable primitive OVER the frozen decide(), not inside it: escalateForBlastRadius
takes a PolicyDecision and returns an equal-or-stricter one. Pure + deterministic.
Populator reads blast radius from MetaprojectPort. Zero frozen-code edits. TDD.

## Steps

1. src/harness/policy/metaproject-escalation.ts: MetaprojectPolicyContext type;
   escalateForBlastRadius(decision, ctx, threshold); metaprojectBlastRadius(port, target).
2. Tests (property-style, injected fake port): allow+high-blast -> ask; allow+low ->
   allow; ask -> ask; deny -> deny; threshold undefined/<=0 -> unchanged; never
   weakens (deny/ask never become allow); populator best-effort (0 on error).

## Risks

- Accidental weakening — the primitive can ONLY escalate allow->ask; a property
  test asserts deny/ask are returned unchanged for all inputs.
- Frozen-code drift — no edits to decide()/PolicyContext; a grep/AC guards it.
