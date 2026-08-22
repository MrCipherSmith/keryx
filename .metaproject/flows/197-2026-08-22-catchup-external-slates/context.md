# Context

Collected deterministically by `keryx flow init` at 2026-08-22T11:00:47.070Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Source Issue

https://github.com/MrCipherSmith/keryx/issues/395

### keryx workspace catch-up never scans .keryx/external-slates/ — an unbound external MCP slate silently never surfaces, contradicting slate.md

## Summary

docs/docs/guides/slate.md (the external-hand MCP Slate surface — slate.open/writeSeed/close) states: "If nothing was ever bound, nothing is lost: Anchors and Seeds are written to a local artifact and surface at the next keryx workspace catch-up as unbound-candidate, never silently discarded."

Live-tested against the real keryx 0.2.55 MCP server: the artifact genuinely is never discarded (confirmed real, on disk), but it never surfaces in catch-up either — under any of its sections. For an operator relying on catch-up as the documented pull-based discovery surface, this is functionally indistinguishable from silent discard, contradicting the doc's own explicit claim.

## Repro (real, live — real MCP SDK client against a freshly-spawned keryx mcp serve)

1. slate.open with a fresh externalSessionId, no workspaceId passed.
2. slate.writeSeed — a real seed lands.
3. slate.close — succeeds ({"closed": true}).
4. Confirm the artifact is real: read .keryx/external-slates/<externalSessionId>.json — real file, no workspaceId field, real seed, closedAt populated.
5. keryx workspace catch-up:

   == Unbound candidates (wrap-up ran, no workspace bound) ==
   (none)

   The closed, unbound external slate does not appear here, nor anywhere else in the output — the "Unknown" section only ever lists real keryx-native session UUIDs, never an MCP externalSessionId string.

## Root cause (read from source)

src/sac/catch-up.ts's own comment (line 24) describes unbound-candidate detection as checking whether slate-archive/*-unbound-candidate.json exists — a path under a keryx-native session's own store (~/.local/share/keryx/sessions/<project>/<sessionId>/slate-archive/). The external-hand MCP slate store lives entirely separately, at .keryx/external-slates/<externalSessionId>.json (per slate.md's own "On-disk layout" section). catch-up's scan has no code path that reads the external-slates directory — the two Slate surfaces use different storage layouts, and only the internal one is wired into the discovery command the docs describe as covering both.

## Why this matters

This is the intended "nothing is lost" safety net for the entire external-hand Slate surface (Claude Code, Codex, or any other MCP-connected harness using slate.open/writeSeed/close without ever binding a workspace) — and it currently has no real discovery path. An external hand that opens a slate, writes real findings, and closes without binding a workspace (e.g. because resolve-or-create genuinely found nothing to bind to) leaves those findings permanently undiscoverable through the one command the docs point operators to for exactly this case.

## Suggested direction (not prescriptive)

- Extend keryx workspace catch-up's unbound-candidate scan to also read .keryx/external-slates/*.json for closed, unbound entries, surfacing them in the same unbound-candidate shape already used for internal sessions.
- Or, if unifying the two storage paths isn't desired short-term, correct slate.md to state plainly that external-hand slates left unbound are not currently discoverable via catch-up, rather than promising a discovery path that doesn't exist.

## Found via

Live-testing pass building/executing the formalized keryx shell/MCP test catalog — see
docs/verification/test-results/09-mcp-slate/MCPSLATE-01-to-05-full.md on branch real-test-keryx.

## Environment

- keryx 0.2.55 (npm @mrciphersmith/keryx)
- Real @modelcontextprotocol/sdk client against a freshly-spawned keryx mcp serve --cwd <repo>

## Related Memory

- [accepted/constraint] The keryx on PATH is a stale build; the review pipeline does not exercise the code under review - `.metaproject/memory/constraints/stale-installed-keryx-binary.md`
- [accepted/lesson] A fix round needs its own review: three consecutive rounds each introduced a blocker - `.metaproject/memory/lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md`
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

_(flow-init skill appends here)_
