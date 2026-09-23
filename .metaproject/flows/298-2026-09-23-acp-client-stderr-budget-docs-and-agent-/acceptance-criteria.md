# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The ACP client counts what a foreign agent writes to stderr against a run budget, so a stderr-only flood ends the run with a named reason within that budget rather than running on until the run timeout; a test drives such a flood and asserts the named reason and that the child was killed.
- AC2: The agent-facing instructions cover triggers and external agents: how a `flow-next` dispatch is configured, run and inspected and what an unattended run may not do, and how `keryx agents external run` works and what keryx does and does not control. Generated and mirrored copies stay identical, every skill stays under its recorded length ceiling, and `keryx skills verify --bundled` reports no finding.
- AC3: The architecture page's diagram of the completion gates either lists the gates `flow complete` evaluates today, including tasks, owner and review, or says plainly that it is a simplification and where the full list lives.
- AC4: CI is green on the PR and `keryx health run` gate is pass.
