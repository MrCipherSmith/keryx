# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx wiki enrich` no longer writes and auto-accepts content directly outside of review — it either produces a real SAC proposal awaiting `keryx workspace review`, or the direct unreviewed path is no longer reachable the way it was in the original repro.
- AC2: `keryx workspace catch-up` detects a session where an SAC-owned path (wiki/memory/skill) changed on disk with no corresponding proposal record, and reports it as a distinct, named case rather than lumping it into "Unknown (no resolution recorded)".
- AC3: A regression test reproduces the original repro (agent invokes `wiki enrich` via shell_exec with the mutation approved) and asserts the content no longer lands as `Status: accepted` without a review decision.
- AC4: `tsc --noEmit` is clean and the full relevant test suite (wiki/SAC/catch-up tests at minimum) passes with no regressions.
