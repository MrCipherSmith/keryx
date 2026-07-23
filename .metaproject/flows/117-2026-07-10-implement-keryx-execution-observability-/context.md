# Context

Collected by `keryx flow init` at 2026-07-10T11:40:52.396Z and enriched during
requirements/affected-context analysis.

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

## Agent Findings

- Requirements package: `docs/requirements/keryx-execution-observability/`
  contains README, PRD, specification, agent protocol, artifact lifecycle,
  CI protocol, metrics-and-validation, implementation plan, and the execution
  run JSON schema. It explicitly says the package is future work; docs are not
  runtime evidence.
- Required capability order: provenance/schema and event accounting first;
  then immutable testing/health evidence and latest pointers; then hooks/index
  and baseline reliability; then lightweight mode; benchmark readiness last.
- Runtime gap: `src/cli.ts` has no metrics command; `src/commands/*` expose
  health/testing/standard/flow separately; `src/gdskills/contracts/agent-event.schema.json`
  has lifecycle events but no runtime aggregation or command/file events.
- Existing evidence: `src/testing/service.ts` and `src/health/run.ts` overwrite
  `artifacts/latest.json` and `latest.md`; loaders read the mutable JSON
  directly. New per-run records and pointer readers must preserve legacy shape.
- Existing provenance: `src/sync/provenance.ts` records module build refs, but
  there is no execution-run provenance record with branch/worktree/source
  timestamps.
- Hook risk: managed hook installation is used by `src/commands/init.ts` and
  `src/commands/update.ts`; tests construct `.git/hooks` directly. Linked
  worktrees require resolving `git rev-parse --git-common-dir`.
- Documentation risk: `src/lib/templates.ts` contains generated guidance for
  `keryx index refresh`, but the CLI has no `index` command. This plan removes
  the unsupported instruction and points at supported refresh commands.
- Baseline evidence on the `main`-derived commit: `standard validate` fails on
  `gdgraph.capabilities[0]` because the standard schema expects a string while
  the manifest uses a capability object. Changed health reports `WARN` for
  required TypeScript unavailable; no health latest existed before baseline.
- Testing context: Bun test runner, `bun test`/`bun run check`, 110 test files;
  testing context exists, normalized latest reports were not present before
  baseline execution.
- Graph context: `keryx gdgraph context` indexed 298 source files; targeted
  `affected` queries returned no file-level edges for command entrypoints, so
  direct source verification is required. `keryx gdgraph find` did not find
  content terms, so `keryx ctx rg` was used for content routing.
- Wiki context: `.metaproject/wiki/index.md` read; only generated draft pages
  exist, with no accepted domain decisions relevant to this capability.
- Memory search returned no accepted execution-observability lessons.

## Routing Audit

- graph_used: `keryx gdgraph context`, `find`, and targeted `affected` queries;
  graph edges were insufficient for command files, so source verification was
  performed directly.
- wiki_used: `.metaproject/wiki/index.md`.
- ctx_used: `keryx ctx rg` and `keryx ctx read` for package/code searches.
- raw_rg_used: no.
- health_used: baseline command run; normalized health artifact was not
  available before that run.
