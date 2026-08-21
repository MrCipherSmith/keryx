# Context

Collected deterministically by `keryx flow init` at 2026-08-21T10:10:59.885Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
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

- Full requirements already written and committed this session:
  `docs/requirements/slate/{README,prd,specification,agent-protocol,
  implementation-plan}.md` v3 sections (branch
  `slate-v3-external-hand-mcp`). This flow implements that spec verbatim —
  no separate design step needed.
- Verified directly against source (not filename search, which failed once
  this session and produced a wrong "unimplemented" claim later corrected):
  `src/sac/machine-wrap-up.ts` (`resolveMachineWrapUp`/`runWrapUp`,
  `WrapUpSource === "flow"`) and `src/sac/session-wrap-up.ts` (uses it as
  primary evidence for `WrapUpSource === "session"`) both fully implement
  SLATE-7/21 already — no dependency to wait on for T3's wrap-up branch.
- `src/mcp/tools.ts`'s `sac.workspaceList/Show/Create` (SLATE-19b) is the
  pattern to mirror for the new `slate.*` tools: stateless,
  `context?.transport === "http"` denied, same `OBJECT_SCHEMA` helper.
- `src/sac/workspace-resolve.ts` (SLATE-16) is the existing resolve-or-create
  procedure `slate.open`'s no-`workspaceId` path must call, not reimplement.
- Memory constraint `.metaproject/memory/constraints/
  stale-installed-keryx-binary.md`: the `keryx` binary on PATH is a stale
  build and does not exercise the current working tree. For anything that
  must run against THIS flow's code (tests, type-check, any CLI path this
  flow touches), invoke via `bun run keryx -- <cmd>` or the project's own
  test runner directly, never the installed `keryx` on PATH.
- Base branch: `main`. Work happens on the already-pushed
  `slate-v3-external-hand-mcp` branch (created this session for the docpack
  commits, currently 2 commits ahead of `main`). The eventual PR must merge
  into `main`.
