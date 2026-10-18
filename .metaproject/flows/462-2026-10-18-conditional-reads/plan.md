# Implementation Plan

Status: draft (waits for the operator's confirmation of PRD and criteria)

## Approach

A sidecar `references.json` in the project rules folder carries the declarations, because imported rules are overwritten by `skills update` and the front-matter reader has no nested values. The resolver gets the task text, matches globs and keywords, and promotes matching contracts to must_read with anchor, description and section size. The result schema gains optional `anchor` and `summary` on `project_context_applied` items; `how` keeps its enum so old results stay valid (decision D1 for the operator). The validator adds a deterministic summary check on top of the 461 path and hash check. A `skills references check|suggest` pair helps authoring; the TUI gets a References tab, a sidebar counter and a command.

## Steps

1. Schema and loader for references.json; section extraction by heading anchor (src/gdskills).
2. Resolver: task text input, promotion, never demoted by the cap, descriptions on unmatched entries.
3. Output schemas of task-implementer and tests-creator, plus the sync copies: `anchor`, `summary`.
4. Validator: anchor equality, summary length and vocabulary overlap, warn/block, `flow task done` refusal.
5. CLI `skills references check` and `suggest`; end-of-import hint.
6. TUI: sidebar counter, References tab, `/projectctx refs`, settings rows if any; TUI-states.md.
7. Orchestrator and skill instructions: pass the task text, require the citation.
8. Docs: README, docs site, CLI reference, the project-rules guide.
9. Fixture with STYLING- and THEMING-like documents; tests per criterion; operator runbook for the live run on vantage-frontend.

## Risks

- Keyword breadth, summary false positives and fabricated summaries; see the PRD risk table.
- The resolver and validator live in PR #1047; start code only after it is merged and this branch is rebased.
