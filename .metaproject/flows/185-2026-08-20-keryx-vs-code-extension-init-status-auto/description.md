# Keryx VS Code Extension

Status: formalized
Source: docs/requirements/keryx-vscode-extension/ (specification ready, v0.2.0)

## Problem

No VS Code presence: no MCP client-config entry, no visual layer over
`keryx serve`/`keryx mcp serve`, genuinely new territory (Finding 5).

## Expected Outcome (v1, per specification.md §2 / decisions.md)

- `src/mcp/client-config.ts` gains a `VSCODE_RUNTIME` entry. Confirmed
  live (WebSearch+WebFetch against official current VS Code docs, no
  VS Code install available in this environment to verify against a real
  instance — honestly noted, same pattern as mcp-client/provider-breadth):
  `.vscode/mcp.json`, top-level `servers` object (NOT `mcpServers` like
  every other runtime here), each entry requires an explicit
  `"type": "stdio"` field alongside `command`/`args` — a real, distinct
  shape from `CURSOR_RUNTIME`/`CLAUDE_RUNTIME`'s `fileRuntime` factory,
  needs its own merge/strip/validate like `OPENCODE_RUNTIME` did.
- New top-level `vscode-extension/` directory: a real VS Code extension
  (own `package.json` with the `vscode` engine, own `tsconfig.json`) —
  deliberately OUTSIDE `src/`'s zero-dependency/SDK-lazy-import policy,
  since a VS Code extension has a different runtime contract entirely
  (the `vscode` API, normal npm deps are fine here).
- Activation: shell `keryx status`, prompt (never silent) to run
  `keryx init --yes` when not-initialized/incomplete, auto-reveal the
  tree view on success.
- Status bar item: `GET /v1/status` + health/security glyph, click-through
  names the failing check.
- Tree view, 4 nodes: Status, Projects, Recent Turns, Needs Your Attention
  (merges `flow.status` + `sac.*`, explicit empty state when neither
  configured).
- Output channel: SSE pipe of turn events + mandatory audit-log line per
  mutating action.
- Hover provider: `wiki.query`/`wiki.ask` snippets, staleness indicator
  when the MCP response exposes one.
- Version check: installed `keryx --version` vs. declared
  `minKeryxVersion`, non-blocking warning below it.

## Known environment limitation (same honest-partial-verification pattern as packages 2/3)

No VS Code CLI (`code`) or `vsce` is available in this environment. AC3
("verified end to end with a real Copilot Chat tool call") and AC9
("passes vsce package/Marketplace publish validation") cannot be fully
live-verified here. Build correctly per spec, verify everything
verifiable without VS Code itself (TypeScript compiles, unit-testable
logic, `package.json`/manifest schema correctness checked by hand
against the documented contribution-points schema), and record AC3/AC9
as not-fully-verified rather than overclaimed — a real follow-up for
whoever has a VS Code + Copilot Chat environment to finish verification.

## Out of Scope (v1)

- Full multi-panel webview dashboard (D-01, rejected outright).
- Hover extended beyond wiki (`gdgraph.affected`/`memory.search`) — v1.1.
- Private/internal-only distribution — Marketplace, public (D-04).
- OpenTUI embedded in a webview — confirmed impossible (Finding 4).
