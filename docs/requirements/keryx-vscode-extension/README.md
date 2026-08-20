# Keryx VS Code Extension
Version: 0.2.0

## Purpose

A VS Code extension for keryx: auto-detects whether a workspace has keryx
initialized and offers to run `keryx init` if not, registers `keryx mcp
serve` as a native MCP server so Copilot Chat gets keryx's 21-tool surface
for free, and adds a lightweight visual layer (status bar, tree view,
output channel, editor hover cards) built entirely on top of the already-
shipped `keryx serve` (HTTP+SSE) and `keryx mcp serve` (MCP) backends — no
new backend work, a client-building effort.

## Status

**specification ready (future).** No code exists. This package supersedes
the paused discovery notes at commit `a0ebce1` (branch
`docs/keryx-vscode-extension-research`) — that document's four explicitly
deferred open questions (UI shape, v1 capability scope, MCP-client
sequencing, distribution) are now all resolved below, each through a
structured brainstorm (Pragmatist/Innovator/Critic) + interview round with
the operator. The discovery findings themselves (Findings 1–5, file:line
grounded) are carried forward unchanged into specification.md — they were
verified, not superseded.

## Document Index

| Document | Purpose |
|---|---|
| [README.md](README.md) | This overview, status, scope, index. |
| [prd.md](prd.md) | Problem, goal, users, requirements, success criteria, risks, recommendation. |
| [specification.md](specification.md) | Discovery findings (carried forward), UI/capability specification, data contracts, acceptance criteria. |
| [decisions.md](decisions.md) | The four resolved open questions, each with its brainstorm options, critic questions, and the operator's actual decision. |
| [brainstorm.md](brainstorm.md) | Full brainstorm records (Pragmatist/Innovator/Critic outputs) for the two rounds that needed one — UI shape and v1 capability scope. |

## Scope (v1)

- Auto-detect (`keryx status`) + offer-init (`keryx init --yes`) on
  workspace open, with an explicit user confirmation prompt (never silent),
  and a deliberate auto-reveal of the tree view immediately after a
  successful init so the very first thing a new user sees has content.
- Register `keryx mcp serve` as keryx's VS Code MCP runtime target
  (`src/mcp/client-config.ts` gains a `vscode` entry) — Copilot Chat's
  native MCP client gets all 21 tools with no extension-authored UI.
- Status bar item: base status (`GET /v1/status`) plus an ambient
  health/security signal (from `health.status`/`security.check`), with a
  click-through to "why"/"how to fix" detail — never a bare, unexplained
  color change.
- Tree view, four nodes: Status, Projects (`GET /v1/projects`), Recent
  Turns, and **Needs Your Attention** — a merged worklist from
  `flow.status`'s active task/acceptance-criteria and `sac.*`'s pending
  proposals/reviews, with an explicit, legible empty state when a project
  has neither module configured.
- Output channel: pipes `GET /v1/turns/{id}/events` SSE streams, AND a
  structured audit-log line for every mutating action the extension takes
  (timestamp, actor, outcome) — not optional, a trust mechanism by design.
- Editor hover provider: `wiki.query`/`wiki.ask` snippets on symbol/file
  hover. Scoped to wiki only in v1.
- Distribution: VS Code Marketplace, public.

## Non-goals (v1)

- A full multi-panel webview dashboard. Rejected — duplicates Copilot
  Chat's native MCP access at higher cost and higher risk (auth/CSP
  surface, two-mechanism straddle between HTTP+SSE/MCP reads and CLI
  shell-out writes) with no capability a lighter shape doesn't already
  cover. See decisions.md D-01.
- Extending the hover provider to `gdgraph.affected` (blast-radius count)
  or `memory.search` (decision context). Deferred to v1.1 — real value
  (works on any codebase, not just Keryx-module-configured ones) but adds
  hover-crowding and symbol-resolution risk on top of an unshipped,
  unvalidated wiki-only hover. Doubles as a cheap preview of the
  gap-closing priority table's separate blast-radius CodeLens idea, gated
  the same way: prove v1 gets used first.
- Private/internal-only distribution. Considered and rejected — Marketplace
  chosen explicitly.
- OpenTUI embedded in a webview. Confirmed impossible (Finding 4,
  specification.md) — not a scope decision, a hard technical constraint.

## Related modules

- [Keryx Remote Entry](../keryx-remote-entry/README.md) — hosts
  `keryx serve`/`serve-server.ts`, the HTTP+SSE backend this extension's
  status bar and turn-streaming features are a client of. No changes to
  that package required.
- No existing package covers `src/mcp/server.ts`/`client-config.ts`
  directly; this package adds the `vscode` runtime target there as part of
  its own scope, not as a dependency on separate work.
