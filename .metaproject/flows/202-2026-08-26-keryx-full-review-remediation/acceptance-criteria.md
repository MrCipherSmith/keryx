# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A tracked validation report records which claims from the 2026-08-24 review are confirmed, corrected, deferred, or disproved, including graph, catch, health, sandbox, provider-auth, wiki, and security evidence.
- AC2: Foreground and background shell execution consume one neutral process/sandbox spawn seam, and background-job-registry has no runtime import from shell-exec-tool.
- AC3: The runtime value-import SCC among machine-wrap-up, proposal-lifecycle, and session-wrap-up is removed while provenance, expiry, conflict/idempotency, and immutable proposal behavior remain covered.
- AC4: Workspace harness tools import SAC implementation only through a named harness facade, with existing ACL/denial/result tests green.
- AC5: spawn-subagent-tool has no runtime TUI bridge import; an optional injected fleet-event sink covers TUI updates and absent-sink behavior.
- AC6: Health status exposes separately named decliningScopes and regressedScopes, preserves regressions compatibility and the existing gate, and tests deltas -3 through +3 plus null baseline.
- AC7: Exactly 14 validated comment-only catch clauses have explicit dispositions and targeted observable-fallback/degraded-path assertions.
- AC8: Every currently guarded durable sink consumes one shared pre-write materializer; redact persists only replacement and enforced block persists no raw sentinel.
- AC9: After untrusted web output, workspace_create, workspace_propose, and slate_write_seed are denied before invocation while read_file remains allowed.
- AC10: Session archive/evidence, Slate, proposal record/note, normal wiki enrich, and RLM wiki enrich persist only approved/redacted output or no tainted artifact on block.
- AC11: A needs-approval proposal cannot be accepted without explicit human security acknowledgement bound to workspace/proposal, single-use, and expiring with the existing token.
- AC12: Focused affected tests and TypeScript/build checks pass; the full-suite result introduces no new failing test identity and no increase over the captured 18 skips relative to the 5325-pass/49-fail/18-skip baseline.
- AC13: A refreshed graph reports neither the background shell SCC nor the SAC lifecycle SCC; the documented type-only modal-host/shell-chrome relation may remain.
- AC14: Requirements, implementation plan, catch disposition artifact, change report, routing audit, and opted-in execution metrics are tracked in the flow/package.
