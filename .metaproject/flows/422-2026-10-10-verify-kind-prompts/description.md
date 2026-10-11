# Verification kind is asked for at every criterion: template, flow and flow-orchestrator skills, freeze warning

Status: formalized
Source: operator request of 2026-10-10 (handoff from the Cowork session, data check for part 2 of the role-blurring study)

## Problem

The verification-kind marker `[verify: exec|invariant|judged|none]` (acceptance layer W0, flow 379,
`src/flow/ac-kinds.ts`) works in code, but no instruction an agent follows when it writes criteria
mentions it:

- `renderAcceptanceCriteria` in `src/flow/templates.ts` scaffolds
  `- AC1: <replace with a hard, verifiable criterion before freeze>` with no marker;
- the criteria-writing step of the flow skill (text generated from `templates.ts`, and
  `.metaproject/skills/flow/SKILL.md`) does not name the marker;
- `src/gdskills/bundled/skills/orchestration/flow-orchestrator/SKILL.md` and its copy under
  `.metaproject/skills/gdskills/` are silent too;
- `keryx flow freeze` prints the kind distribution, but nobody reads it.

The data show the effect. Criteria of flows created 2026-09-28..10-04 carried the marker in about two
cases of three (333 of 523), while the acceptance layer was being built and the agent had the
context. From 2026-10-05 only flow 406 carries it (8 of 8). All 78 criteria of flows 410–419 are
`unclassified`. This breaks predictions P2 and P3 of the part-2 protocol
(`docs/research/role-blurring-part1/protocol-part2.md`), which count shares by kind.

Constraint kept: the acceptance-layer spec (AC4) and `src/flow/ac-kinds-never-gates.test.ts` forbid a
kind from refusing freeze, confirmation or completion. The fix is a mandatory moment of choice, not a
gate: the agent sets the kind when it writes the criterion, and asks the operator before freeze when
the kind is unclear.

## Expected Outcome

- The criteria template carries a marker rule and a placeholder with a marker; the placeholder
  detector in `src/flow/service.ts` still finds it, and the placeholder marker never parses as a
  valid kind.
- The flow skill's criteria step and flow-orchestrator (bundled and `.metaproject` copy) require a
  marker on every criterion (`exec`/`invariant` with a backticked command, `judged` for what a human
  checks, `none` with a reason) and one operator question listing criteria with proposed kinds when
  a kind is unclear; flow-orchestrator's rationalization table gets "I'll set the kind later". The
  skill length ceilings of `src/gdskills/skill-length-ceilings.ts` and the flow-417 preflight-in-
  first-60-lines rule still hold.
- `keryx flow freeze` with `unclassified > 0` prints a visible warning naming the criteria; in an
  interactive terminal it asks whether to freeze without a kind on them; non-interactively it writes
  the warning to the flow's `journal.md`. It never refuses.
- Flows created through intake (flow 403), `goal`, and helyx/Telegram use the same template.
- `sync-status.md` (generator `src/commands/research-sync*.ts`) shows the share of `unclassified`
  among criteria of flows frozen in the last 7 days, with a warning above 20%.
- `docs/docs/cli-reference.md` (verification kinds, `flow freeze`) and CHANGELOG updated.

## Outcome criteria

- A week after merge, criteria of new flows carry no `unclassified` without a recorded operator
  decision, and `sync-status.md` shows no unclassified warning. Observed with
  `keryx flow ac kinds <id>` on new flows and the line in `sync-status.md`.

## Out of Scope

- Editing existing flows. The retro tagging of 410–419 is done by the operator through
  `keryx flow ac update … --reason "retro verify tag"`.
- Any gate on kinds.
- The `forced`-share and 49/48 counter items of the part-2 data-readiness request (separate flow).
