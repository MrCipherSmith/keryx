# Launch prompts — Keryx Remote Entry
Version: 0.1.0

One file per slice. Copy the fenced block into a flow-orchestrator session.

| Slice | Prompt | State |
|---|---|---|
| R4a | *(not written — the slice predates this directory)* | merged, flow 127, PR #215 |
| R4b | *(not written — the slice predates this directory)* | merged, flow 128, PR #216 |
| **R4c** | [R4c-flow-orchestrator.md](R4c-flow-orchestrator.md) | turn submission, streaming, and the non-weakening profile check |
| R4d | *(to write)* | asynchronous fail-closed approvals |
| R4e | *(to write)* | maintenance operations projected from the command registry |
| R4f | *(to write)* | one-time expiring loopback credential handoff |

R4a and R4b were launched from prompts that were never written to the repo. The
slices are still reconstructable — each flow package under `.metaproject/flows/`
carries `description.md` (problem, expected outcome, numbered decisions,
out-of-scope with reasons), the frozen `acceptance-criteria.md`, `context.md`,
`plan.md` and `tasks.md` — but those are artefacts of a run, not the thing that
started it. This directory exists so that stops being true from R4c onward.

**Prerequisite for every prompt here:** the slice before it merged to `main`,
and `docs/requirements/keryx-remote-entry/` read in full — the package specifies
the whole remote surface (29 acceptance criteria) and each slice implements a
named subset of it.
