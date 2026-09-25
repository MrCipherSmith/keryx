# Keryx Jev Rule-Conformance Reviewer
Version: 0.1.0

## Purpose

Add one more reviewer to keryx's existing review fan-out
(`src/review/reviewers.ts`), built on TypeSafe's Jev ("System One") structured-decision
model, whose job is triage rather than authorship: score every (changed hunk, rule)
pair cheaply via Jev's `noul`/`choice` questions, and hand only the flagged pairs to an
existing strong-model pass for confirmation, evidence, and a fix. Rules come from
bundled review skills, from a project's own `.metaproject/project-skills/review/**`,
or from an external project's checklist-shaped rules (the operator's global
skills-and-rules collection, or a private external project's roughly 8 domain review
skills) imported the same way project reviewers already are — content stays in that
project's own tree and is loaded at run time; nothing is copied into keryx's public
repository.

Jev never writes a finding. It is not a code reviewer and the vendor says so
explicitly; every requirement in this package exists to keep a `noul`/`choice` answer
from ever becoming a `findings.json` entry without a confirmation pass in between.

## Status

**Research and design — not yet implemented.** This package is a PRD and phased
implementation plan only, produced on branch `docs/jev-prd` against keryx 0.2.161
(`e04715a2`). No source code changed.

## Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | This overview. |
| [PRD.md](PRD.md) | Problem, goal, non-goals, users, cited research, 19 numbered requirements, success criteria, risks. |
| [PLAN.md](PLAN.md) | 6 phases (Phase 0–5), each a draft flow with single-line acceptance criteria in keryx's own style, sized tasks, a shared test strategy (injected fetch, no real network), and 7 open questions for the operator. |

## Scope

- A new Jev/`systemone` HTTP client, reusable across this package and the parallel
  `keryx-jev-router` package (see PLAN.md Open Question 2 — the shared "decision port").
- Rule extraction from bundled skills, `.metaproject/rules/*.mdc` files, and project
  skills, both structured (frontmatter/`## Rules`, no model call) and one-off
  (strong-model extraction, cached and drift-checked).
- Deterministic hunk×rule dispatch reusing `src/review/scope.ts`'s existing
  change-block extraction and `src/review/stack.ts`'s stack detection.
- A confirmation pass that turns a Jev candidate into a schema-valid
  `reviewer-finding.schema.json` record or a recorded drop.
- Registration as one more bundled reviewer, an opt-in per-project privacy setting, a
  `keryx review rules` CLI surface, and TUI sidebar + modal visibility.
- An evaluation plan against keryx's own historical review packages
  (`.metaproject/flows/*/reviews/*/findings.json`) for recall/precision, plus a real
  cost/latency measurement.

## Non-goals (this version)

- Jev standing alone as a reviewer, or reviewing whole files/diffs.
- A new rule-authoring format that duplicates existing skills/`.mdc` rules.
- Any change to how the existing (non-Jev) reviewers work.
- Copying a private external project's or the operator's global collection's rule
  text, file contents, or internal names into the keryx repository.

## Related work

- **`docs/requirements/keryx-jev-router/`** — a parallel package (in progress alongside
  this one) covering Jev's use for request/model routing rather than review. The two
  packages share the same underlying need for a Jev/`systemone` client — see this
  package's PLAN.md Open Question 2 for the integration point neither package should
  resolve unilaterally.
- **`src/gdskills/bundled/skills/review/review-orchestrator/`** — the existing
  reviewer-dispatch engine this reviewer plugs into as one more entry.
- **`src/review/reviewers.ts`** — the existing bundled/project reviewer registry this
  reviewer registers through, and the existing origin/drift mechanism this package
  reuses for importing external rule sets.
