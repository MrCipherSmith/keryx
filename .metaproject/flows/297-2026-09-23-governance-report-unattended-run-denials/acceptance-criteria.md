# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx governance report` reads the denials that unattended trigger runs record and lists them per trigger and run — the tool, the reason and the time — instead of reporting every policy decision as not recorded. Policy decisions of interactive sessions, which still have no durable record, are reported as not recorded with that narrower reason.
- AC2: A dispatch run that names a flow and task is attributed to that flow in the report — its spend and its outcome — while trigger runs without a flow stay a project-level line; if run records do not yet carry the flow, they gain it additively and older records still read.
- AC3: The report no longer describes flow 290 as a future source, and a test pins where the denials come from.
- AC4: Tests over a fixture ledger cover a dispatch run with denials, an open spend reservation, a report-only run and a record written before this change.
- AC5: The CLI reference describes the new sections of the report.
- AC6: CI is green on the PR and `keryx health run` gate is pass.
