# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update <id> --reason` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> ACn --note "<evidence>"`.

## Criteria

- AC1: Requirement docs mark Shared Agent Context Phases 0–5 as implemented and
  explicitly record Phase 5 as synthetic-only with no default operational policy effect.
- AC2: A production guard and real opt-in readiness runbook is added with explicit
  operator prerequisites, exact artifact inputs, verification order, and rollback rule.
- AC3: Phase execution prompt index contains the next phase so future work can be
  started consistently through the same flow convention.
- AC4: README and metrics/validation docs in `docs/requirements/shared-agent-context`
  do not claim production effectiveness from Phase 5 and explicitly describe
  opt-in limitations.
- AC5: No code-path changes are introduced that enable candidate policies by default;
  the current `enabled=false`, `killSwitch=true` posture remains documented as required.
