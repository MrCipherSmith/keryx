# Context

Collected deterministically by `keryx flow init` at 2026-08-10T20:36:40.541Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-08-10T19:29:58.876Z)
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

## Agent Findings

### Current state and seams

- `package.json` is the version source; `src/cli.ts` already imports it for
  `--version`. There is no existing npm update-check service or TTL cache.
- `src/lib/config-dir.ts` owns bounded user-global reads and owner-only writes.
  Update metadata must use a separate `version-check.json`, never `auth.json`.
- `src/commands/shell.ts` chooses agent TUI, chat TUI, or readline. Both TUI
  paths mount `src/tui/shell-chrome.ts` and populate `sidebarTop`; readline must
  receive advisories through its IO boundary rather than an asynchronous raw
  stdout write.
- `renderIndexMarkdown` in `src/lib/templates.ts` is the managed source for
  `.metaproject/index.md`; production callers are init, update, and rules sync.
  Generated index files must not be edited by hand.
- A new top-level `version` verb requires `CLI_ROUTES`, help, the command
  registry, and registry coverage to agree.

### Chosen boundaries

- Fixed endpoint: `https://registry.npmjs.org/@mrciphersmith%2Fkeryx/latest`.
- Direct injected `fetch`; no `npm view` subprocess, npm credentials, runtime
  dependency, configurable registry URL, or import-time network.
- Success cache TTL 24 hours, failure retry suppression 15 minutes, request
  timeout 2 seconds, response-body cap 64 KiB.
- Cache `latestVersion`, not `updateAvailable`; compare against the running
  binary every time. Stale cache is diagnostic only and never authorizes an
  update notice.
- The install command is a fixed constant:
  `npm install -g @mrciphersmith/keryx@latest`.

### Constraints and risks

- External registry data is untrusted: validate HTTP status, body size, JSON
  shape and strict SemVer before it reaches UI or model context.
- Shell startup and project work must never wait on, fail from, or be declared
  current by an unavailable check.
- `.metaproject/index.md` is precedence guidance, not enforcement. Unknown
  command/offline/timeout results must explicitly remain non-blocking.
- Accepted memory records that `keryx` on PATH may be stale. Verification for
  this flow uses `bun run keryx -- ...` from the working tree.
- The graph reported stale connectivity metadata after repository movement;
  every finding above was verified in source rather than accepted from graph
  output alone.

### Worker provenance

- `142-context` — Luna, `DONE_WITH_CONCERNS`: exact file/test map and network
  constraints; concern about the workspace meaning of `keryx update` retained.
- `142-architecture` — Sol, `DONE_WITH_CONCERNS`: typed result/cache/SemVer/UI
  design; unavoidable bootstrap limitation retained.
