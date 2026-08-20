# Keryx VS Code Extension — PRD
Version: 0.2.0

## Problem

The operator asked (voice, RU, 2026-08-20) for a VS Code extension: install
into a workspace, auto-detect whether keryx is initialized, offer to run
`keryx init` if not, and provide a visual UI to manage keryx, ideally with
"its own TUI." A discovery pass (commit `a0ebce1`) confirmed the backend
picture is much further along than expected — `keryx serve` (HTTP+SSE) and
`keryx mcp serve` (21-tool MCP server) are real, tested, and sufficient
backends — but also confirmed a hard constraint: OpenTUI cannot be embedded
in a webview (Finding 4), so "its own TUI inside VS Code" is not
achievable as originally imagined. That discovery paused deliberately
before a PRD, pending discussion of UI shape and capability scope.

Separately, a comparative research pass ranked "UX/distribution surface"
(#4, opencode's `acp` pattern) in a gap-closing priority table for keryx
overall — that thread and this one converge on the same finding: keryx
already has a real, tested backend (`serve-server.ts`) that multiple UX
surfaces (ACP for Zed, a VS Code extension) can be thin clients of.

## Goal

Ship a VS Code extension that gives keryx's existing backend surfaces a
native presence in VS Code, without embedding or duplicating the TUI,
built to a scope resolved through structured discussion (see
decisions.md) rather than the originally-imagined "visual UI with its own
TUI."

## Users

- A developer already using `keryx shell` (the TUI) who wants ambient
  status/signals without a terminal pane open, and one-click access to
  init/status from inside VS Code.
- A VS Code + Copilot Chat user who wants keryx's 21 MCP tools available
  conversationally, without knowing keryx has a CLI at all.
- Marketplace browsers evaluating whether to install — the "first five
  minutes" audience, which the interview process identified as the
  audience most shaped by the auto-detect/offer-init flow specifically
  (see decisions.md D-02).

## Requirements

1. Workspace-open auto-detect via `keryx status`'s three-state check (not a
   bare file-existence check — Finding 1); on `not initialized` or
   `incomplete`, prompt (never silent-run) to execute `keryx init --yes`.
2. On successful init, auto-reveal the tree view so the transition from
   "just installed" to "something happened" is visible without the user
   hunting for it.
3. Register `keryx mcp serve` as a `vscode` MCP runtime target
   (`src/mcp/client-config.ts` — currently `cursor`/`claude`/`opencode`/
   `generic`, no `vscode` entry — Finding 5).
4. Status bar item combining base status (`GET /v1/status`) and an ambient
   health/security signal (`health.status`/`security.check`), with a
   click-through detail view — never an unexplained color change.
5. Tree view with four nodes: Status, Projects, Recent Turns, and Needs
   Your Attention (merged `flow.status` active-task/AC + `sac.*` pending
   review), each with a legible empty state, not a blank/broken-looking
   node when the underlying module isn't configured for a given project.
6. Output channel piping two things: `GET /v1/turns/{id}/events` SSE turn
   streams, and a mandatory structured audit-log line for every mutating
   action the extension performs (timestamp, actor, outcome) — not
   optional, load-bearing for user trust per the critic round.
7. Editor hover provider for `wiki.query`/`wiki.ask` snippets, scoped to
   wiki only — no `gdgraph.affected`/`memory.search` extension in v1.
8. Mutating operations not servable via `keryx serve`/`keryx mcp serve`
   (init, and whatever else Requirement 6's audit-log needs to observe)
   run via `child_process` shell-out, per Finding 2's explicit non-goal
   boundary on `keryx serve` itself.
9. Marketplace publication as the distribution channel — not
   private/internal-only.

## Success Criteria

- A brand-new user on an uninitialized workspace sees a real, non-empty
  extension experience within the first interaction (the init-prompt →
  auto-reveal flow), not a blank tree view.
- Copilot Chat can call any of keryx's 21 MCP tools with zero extension UI
  involved, immediately after the `vscode` MCP registration exists.
- The Needs Your Attention node correctly shows an explicit empty state
  (not a broken/blank one) on a project with neither `flow`/`sac` module
  configured — verified as a real test case, not assumed.
- Every mutating action taken through the extension has a corresponding
  audit-log line in the output channel, verified by test, not by
  inspection.
- The extension passes VS Code Marketplace review requirements (documented
  permissions, no undisclosed network access beyond the loopback backend
  it's a client of).

## Risks

- **Version-coupling drift.** The extension and `keryx` core ship
  independently; a future keryx release renaming/changing a surfaced
  tool's shape could silently break a tree node or hover card. No
  compatibility-check mechanism is specified in this version — flagged as
  an explicit gap for specification.md to size, not silently assumed away.
- **SAC/flow-inbox speculative day-one relevance.** The operator explicitly
  chose to include this in v1 despite the critic round flagging it as
  possibly irrelevant to projects that haven't configured those modules
  (decisions.md D-02) — accepted risk, mitigated by a required legible
  empty state (Requirement 5), not by removing the feature.
- **Untested-environment mutating shell-outs.** `keryx init` triggered from
  a public Marketplace install button will run on machines/workspace
  layouts (monorepo subpaths, restricted-permission checkouts) the
  maintainer's own testing may not cover — a real pre-ship QA scope item,
  not a reason to cut the auto-detect/offer-init flow, which is the
  extension's actual first-impression feature.
- **Wiki staleness poisoning trust.** A hover card showing stale/wrong wiki
  content in a new user's first minutes could discredit every other signal
  the extension shows afterward — no staleness indicator is specified in
  this version; worth a specification-level decision on whether one is
  needed for v1 or an accepted v1 gap.
- **Single-maintainer surface growth.** Four tree nodes, a hover provider,
  an MCP registration, and an audit-logged output channel is meaningfully
  more surface than the cheapest brainstorm option (status+tree only) —
  accepted deliberately (decisions.md D-02), not by default.

## Recommendation

Proceed to specification and implementation planning. All four open
questions the original discovery pass deferred are resolved
(decisions.md). The two carried-forward risks worth a specification-level
answer before implementation — version-compat checking and wiki-staleness
signaling — should be sized in specification.md rather than silently
assumed either way.
