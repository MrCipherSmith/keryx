# Flow 042 — metaproject policy escalation primitive (MP-6 deep)

Status: formalized
Source: docs/requirements/keryx-metaproject-native (MP-6, deep/Phase-4 harness-policy
angle) + RFC SA-01. Driven via flow-orchestrator.

## Problem

Flow 041 made the interactive agent's approval advisory-context-aware. The deeper
MP-6 goal — letting the harness POLICY layer weigh metaproject signals (blast
radius) — must NOT touch the frozen policy engine (`decide()`), `PolicyContext`, or
ADR-0003 invariants. A composable, non-weakening primitive is the safe realization.

## Expected Outcome

1. A pure, additive escalation primitive `escalateForBlastRadius(decision, ctx,
   threshold)` (new src/harness/policy/metaproject-escalation.ts): given a
   `PolicyDecision` and a metaproject context `{ blastRadius? }`, returns the SAME
   decision UNLESS it is `allow` AND `blastRadius >= threshold`, in which case it
   returns an `ask` decision (with an escalation reason). It NEVER changes `ask` or
   `deny`, never makes anything more permissive, and is a no-op when `threshold` is
   undefined/<=0 or `blastRadius` is absent.
2. A populator `metaprojectBlastRadius(port, target)` computing the blast radius
   from `MetaprojectPort.graphAffected` (best-effort; 0 on error).
3. A `MetaprojectPolicyContext` type ({ blastRadius?, affected? }).
4. ZERO changes to the frozen `decide()`, `PolicyContext`, `PolicyProfile`, or the
   runOffline loop. The primitive is a ready-to-wire building block; wiring it into
   a live decision path is a documented future step (needs a high-stakes auto-allow
   consumer — read tools auto-allow harmlessly and shell_exec already asks).

## Out of Scope

- No modification of decide()/PolicyContext/PolicyProfile/runOffline (ADR-0003/0002
  preserved). No change to any existing allow/ask/deny outcome. No new dependency.
