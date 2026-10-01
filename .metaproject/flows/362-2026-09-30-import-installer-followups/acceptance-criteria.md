# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: When the security gate changes or refuses imported content, the import says so: a rule or SKILL.md whose content the gate rewrote (for example a redacted secret) is reported on its row as rewritten by the gate, in text and in `--json`; content the gate's prompt-injection detection flags is not written and the row gives the reason. Dry run and real run agree on the status. Covered by tests with a rule carrying a secret and a rule carrying instruction-override text, for both a rule and a SKILL.md.
- AC2: `keryx skills remove` has tests that fail when the name half of the segment check in `resolveTarget` is removed (a registry entry named `..` or `.` must be refused — flow 360 finding F-010, mutant R02) and when trailing-slash normalisation of a registry path is removed (flow 360 round-2 mutant R06).
- AC3: The bundled docs that describe import output (`reviewer-skill-creator/SKILL.detail.md`, `docs/docs/cli-reference.md`) describe the new gate rows, and `keryx skills verify --bundled` reports 0 findings.
- AC4: CI on the flow's pull request is green (lint, typecheck, the full test suite, bundled-skill checks), and `keryx health run` reports no new failure against `main`.
