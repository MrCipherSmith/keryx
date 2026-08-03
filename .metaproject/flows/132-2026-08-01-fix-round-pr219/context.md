# Context

Collected deterministically by `keryx flow init` at 2026-08-01T22:38:26.451Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-01T20:58:09.551Z)
- refresh: `keryx health run`

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

## Source Review

- `.metaproject/reviews/2026-08-01-ingest-feat-r4c-turn-submission/report.md` —
  the consolidated review of PR #219 and PR #220. F-013, F-014 and F-015 plus
  the journal-claim minor are this flow; everything else is #220's.
- Recommended order §1: "Fix and land PR #219 first … it must land first because
  `readTranscriptFile` is the helper PR #220 needs in order to fix the event-log
  bound."

## The three classes and how each was enumerated

**F-015 — "text that is not a finding heading being parsed as one".**
Sites: `src/review/managed.ts:315` (`FINDING_HEADING`) and `:322`
(`findingBlock`, which ends the previous body at the same false heading).
Method: ran `keryx review ingest` on the report and read `findings.json` — 14
real findings and 8 phantoms, every phantom traced to a line in the
"Recommended order" section.

**F-014 — "a caller of the newly-throwing transcript readers, and whether it
guards the throw".** Method: `openSession(`, `exportSessionMarkdown(`,
`loadContext(`, `loadArchive(` across `src`, excluding tests — 11 call sites, 9
guarded or non-loading, 2 unguarded. Guarded: `src/commands/shell.ts:213`,
`:870`; `src/tui/tui-shell.ts:1407`, `:1436`, `:1444`, `:1454`; non-loading:
`src/tui/tui-shell.ts:1492`. Unguarded: `src/commands/sessions.ts:70`,
`src/tui/tui-shell.ts:1563`. Plus the regression itself at
`src/session/store.ts:431` — `loadArchive`'s pre-fallback read.

**F-013 — "an operator instruction printed by `keryx serve` that AC8 claims is
executed verbatim".** Fifteen printed instructions:
`src/lib/serve-server.ts:130`, `:136`, `:145`, `:162`;
`src/lib/serve-config.ts:508`, `:510`, `:516`, `:520`;
`src/commands/serve.ts:233`, `:237`, `:411` (two in one line), `:513`, `:556`,
`:598`, `:677`; `src/lib/serve-credential.ts:333`. The extractor at
`src/commands/serve.recovery.test.ts:487` selects only the `config` subset.

## Templates to copy, and ones not to

- `src/lib/config-dir.writers.test.ts:190` and
  `src/lib/config-dir.readers.test.ts:460` are the correct source-level guards:
  the self-check drives the same seam as the tree assertion, scan-reach is
  asserted, and the numerator is controlled. The review names them "the
  strongest tests in either PR".
- The two guards on #220 (`profiles.test.ts:240`, `serve-server.test.ts:381`)
  are the decorative ones (F-009). Do not copy their shape.

## Verification surface

- rg is not on `PATH` for this host; `keryx ctx rg` needs the directory holding
  `rg` prepended to `PATH`.
- `bun test`, `bun run typecheck`, `bun run lint`, `keryx health run`.

## Agent Findings

_(flow-init skill appends here)_
