# Keryx Acceptance Layer

Version: 0.3.0

## Purpose

Make a flow's acceptance criteria carry their own **kind of verification**, and
give the executable kinds a runner and a gate. The programme turns confirmation
from an assertion into a measurement where that is possible, and — where it is
not — makes the absence of verification visible instead of indistinguishable
from success.

## Status

**Draft — specification written, nothing implemented.** W0 is specified in full;
W1–W4 are stated at the resolution needed to keep W0 honest about what it does
not do, and are not implementation-ready.

The package is grounded in two measurements over this repository's own flow
corpus, recorded in [metrics-and-validation.md](metrics-and-validation.md). Both
falsification criteria written before those measurements fired, and the
programme was rewritten around the results: the original framing — "confirmations
are unreliable" — did not survive contact with the data.

## Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | Package status, scope, index. |
| [prd.md](prd.md) | Problem, goal, users, requirements, success criteria, risks, recommendation. |
| [specification.md](specification.md) | Format, storage, CLI surface, data contracts, integration points, acceptance criteria. |
| [metrics-and-validation.md](metrics-and-validation.md) | The corpus measurements, the pre-registered falsifiers, and what fired. |
| [implementation-plan.md](implementation-plan.md) | W0–W4, order, and the decision gates between them. |
| [tools/](tools/) | The two measurement scripts behind metrics-and-validation. No model, no network, read-only. |

## Scope

- A declared verification kind per acceptance criterion, inside the sealed
  `acceptance-criteria.md`.
- A parser and a report over those kinds, and the acceptance-coverage figure
  that follows from them.
- A field in the requirements-package PRD contract so criteria are born with a
  kind rather than acquiring one at freeze.
- An executable runner for the `exec` and `invariant` kinds, and the right to
  gate `flow ac confirm` — for those kinds only (W1).
- A split of the PRD success contract into release criteria and outcome
  criteria, so a package states what should change and not only what was built
  (W5).

## Non-goals

- **Refusing a freeze.** A flow whose criteria are all `none` still freezes. The
  distribution is reported, never enforced. A gate here would turn the format
  into a formality satisfied by typing `exec` and moving on.
- **Gating on a model verdict.** `flow check-ac` stays advisory. The decision
  taken in flow 328 was right and this package does not revisit it.
- **Rewriting history.** The 2,705 criteria already frozen are not migrated. The
  kind is required of new criteria only; old flows report `unclassified`.
- **A new review pipeline.** Posting the report on a pull request rides the
  existing `keryx-p0-improvements` W3 workstream and is not duplicated here.

## Related modules

- `tasks` (Task Manager) — `.metaproject/modules/tasks.md`; freeze, `ac update`,
  `ac confirm`, completion gates.
- `src/flow/check-ac.ts` — flow 328; the deterministic-facts-first pipeline this
  package extends rather than replaces.
- `gdskills/planning/docpack-orchestrator` — the Verify phase that gains the
  per-requirement verification field.
- `keryx-p0-improvements` W3 — review as a GitHub Action; the transport for the
  report, owned there.
