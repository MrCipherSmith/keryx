# Flow 041 — context-aware approval (MP-6)

Status: formalized
Source: docs/requirements/keryx-metaproject-native (MP-6) + RFC SA-01 §7. Driven
via flow-orchestrator. Builds on the flow-037 MetaprojectPort and the flow-036
agent shell_exec approval gate.

## Problem

The agent's `shell_exec` approval prompt (`Run <cmd>? [y/N]`, flow 036) gives the
user no project context to decide with. keryx has the metaproject layer
(blast-radius via the graph, prior mistakes via memory) but it never informs the
approval. MP-6 wants context-aware gating — WITHOUT touching the frozen harness
policy engine (ADR-0003) or weakening the default-deny posture.

## Expected Outcome

1. A pure-ish helper `buildApprovalContext(port, command)` (MetaprojectPort-backed):
   extract file-like tokens from the proposed command; for the first that resolves,
   `graphAffected` → a "affects N file(s)" blast-radius line; `memorySearch` on the
   command → the top related memory note (e.g. a known mistake). Returns a short,
   dim context string (empty when nothing relevant / on any port error — never
   throws).
2. The agent REPL's `requestApproval` shows this context line BEFORE the `[y/N]`
   prompt, so the user approves with metaproject awareness.
3. The default-deny approval gate and its outcomes are UNCHANGED (context is
   advisory only); the harness policy engine (ADR-0003) is NOT modified.

## Out of Scope

- No change to the harness `decide()` policy engine or PolicyContext (deeper
  ADR-0003 integration is explicitly deferred). No change to what is allowed/denied.
  No new dependency. No mutating tools.
