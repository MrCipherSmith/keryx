# Context

Collected deterministically by `keryx flow init` at 2026-08-26T05:21:02.327Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] Theme switch repaints already-rendered chrome via old-slot value matching - `.metaproject/memory/lessons/theme-switch-repaint.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

- Worktree: `/Users/tsaitler.aleksandr/goodea/keryx/.worktrees/full-review-remediation`; branch `fix/full-project-review-remediation-2026-08-24`; base `1ece28b2818d6ce2d5bfa89e0bc8a8b57b96c797`.
- Review validation: background shell and SAC runtime cycles confirmed; modal-host/shell-chrome is type-only in one direction and allowed; 25 graph orphans are intentional.
- Import count correction: 17 harness-to-command/TUI/SAC matches in 12 files are not all violations; `src/lib imports nothing above` is disproved by 32 imports in 12 files.
- Catch correction: 65 textual hits = 63 clauses plus 2 comments; 14 production comment-only sites require explicit disposition, not mechanical rewriting.
- Health correction: positive regression_score means decline; trend=regressed uses the existing +/-2 deadband. Gate semantics remain unchanged.
- Security validation: untrusted web output could reach durable session/SAC/wiki paths; existing guarded sinks could ignore redacted output. This is the highest-severity confirmed defect.
- Baseline previously captured on this commit after install: health PASS 93/100; typecheck/build passed; full Bun suite 5325 passed, 49 failed, 18 skipped.
- The first temporary worktree was removed by OS cleanup before commit. This persistent worktree is the recovery run; verified waves must be committed before long-running verification.
- Execution metrics were explicitly enabled by the user and must be shown only in the final response.
