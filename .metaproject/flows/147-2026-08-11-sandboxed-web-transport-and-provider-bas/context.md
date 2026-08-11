# Context

Collected deterministically by `keryx flow init` at 2026-08-11T22:32:37.114Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/lesson] A shell allowlist matched against the raw command string is not a security boundary - `.metaproject/memory/lessons/allowlist-not-a-boundary.md`
- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
- [accepted/constraint] Flow ids are allocated per clone, not per checkout - `.metaproject/memory/constraints/flow-ids-allocated-per-clone.md`
- [accepted/lesson] OpenTUI: alignSelf on a transcript box collapses its intrinsic height - `.metaproject/memory/lessons/tui-alignself-height-collapse.md`

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

- PRD sources: `docs/requirements/sandboxed-web-transport-and-search/2026-08-12/{ru,en,ai}/sandboxed-web-transport-and-search.md` in the user-supplied `keryx-web-fetch` worktree. The variants agree on the security invariants and acceptance scenarios.
- Existing `webFetchTool` validates DNS but directly executes its default request in the agent process. It already has public-HTTPS, redirect, bounded-output, redaction, and injection behavior that must move behind the new port without an insecure compatibility path.
- Existing OS containment is under `src/harness/process/sandbox/`; the current restricted-network proxy is macOS-only, so Linux web egress must not rely on it.
- Existing shell provider UX distinguishes configure-capable from connected provider selection. Search providers must use the same truthful state semantics.
- Accepted memory: raw shell allowlists are not security boundaries; design must rely on OS/process isolation and a pinned transport.
- Baseline health artifact is absent in this checkout; a new changed-scope health report is required before completion.
- Decision: do not reuse `SandboxProfile.network = restricted`. It intentionally has no Linux egress implementation, while its normal filesystem profiles expose too much host state for the web-worker contract.
- Decision: remote adapter-owned fixed GET/POST requests are permitted by descriptor schema (needed by Tavily/Exa); caller-controlled POST, headers, cookies, and proxy configuration remain forbidden.
- Decision: remote credentials are an ephemeral one-time capability in the JSON worker request, never inherited environment data. Local SearXNG gets a separate exact-loopback capability and cannot be used by generic fetch/remote adapters.
