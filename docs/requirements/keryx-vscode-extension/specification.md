# Keryx VS Code Extension — Specification
Version: 0.2.0

**Status: specification ready (future).** Discovery findings below are
carried forward from commit `a0ebce1` unchanged (verified, not superseded).
UI/capability decisions are new, resolved through decisions.md.

## 1. Discovery findings (carried forward)

**Finding 1 — init/status.** `keryx init` (`src/commands/init.ts:227-1082`)
is idempotent; `keryx init --yes` (`:1086`, `254-262`) is fully
non-interactive. `keryx status` (`src/commands/status.ts:20-57`) is a
3-state check (`not initialized` / `incomplete` / `ready`) — the extension
must use this, not a bare `.metaproject/index.md` existence check.

**Finding 2 — `keryx serve`.** `src/commands/serve.ts` +
`src/lib/serve-server.ts`: a real, tested, loopback-bound HTTP+SSE server
(`Bun.serve`, `:874-902`; SSE via `streamTurnEvents`, `:581-615`).
Bearer-token auth, salted-hash storage, constant-time comparison
(`:315-331,680-696`). Routes: `GET /v1/status`, `GET /v1/projects`,
`POST /v1/turns`, `GET /v1/turns/{id}`, `GET /v1/turns/{id}/events` (SSE,
resumable via `Last-Event-ID`). **Explicit non-goal by design**
(`serve-server.ts:25-27`): cannot run a turn's mutating side effects, execute
arbitrary tools, write anything, or accept a secret outside these routes —
`init`/`gdgraph build`/`health run` are not servable here.

**Finding 3 — `keryx mcp serve`.** `src/mcp/server.ts:136-159`, official
`@modelcontextprotocol/sdk` (optional dep, lazily loaded). Stdio (default)
and HTTP/SSE (opt-in) transports. 21 tools (`src/mcp/tools.ts:70-384`):
`sac.*` (8), `gdgraph.affected/cycles/orphans`, `security.check/scan/
scan-mcp`, `flow.status`, `memory.search`, `health.gate/status`,
`wiki.query/ask`, `standard.validate`. `src/mcp/client-config.ts:148-149,
151-222` currently wires `cursor`/`claude`/`opencode` — no `vscode` entry
(this package's Requirement 3 adds one). `init` is not among the 21 tools —
bootstrap still needs `child_process`.

**Finding 4 — OpenTUI cannot embed in a webview.** `@opentui/core` ships
native Zig-FFI binaries per platform (`package.json:59`), an ANSI-terminal
renderer, not a DOM/canvas one. `src/tui/chat-shell.ts:67` types it as a
**CLI** renderer, gated on `stdout.isTTY`. No abstraction bridges this to a
webview. Any VS Code UI is a from-scratch build. The only way to see the
*existing* TUI inside VS Code at all is `vscode.window.createTerminal()`
running `keryx shell` — a real terminal panel, not a native VS Code UI —
not adopted as the primary UX per decisions.md D-01.

**Finding 5 — no prior art.** No `.vscode/` extension manifest, no
`vscode` keyword in `package.json`, no VS Code entry in
`client-config.ts`'s runtime list, no relevant roadmap item. Genuinely new
territory.

## 2. Extension surfaces (resolved — see decisions.md D-01, D-02)

### 2.1 Activation & init flow

On workspace open: shell `keryx status`. If `not initialized`/`incomplete`,
show a VS Code notification prompt (never auto-run) offering `keryx init
--yes`. On successful init, programmatically reveal the tree view
(`TreeView.reveal`/focus the view container) so the first meaningful state
is visible without the user searching for it (PRD Requirement 2).

### 2.2 MCP registration

Add a `vscode` entry to `src/mcp/client-config.ts`'s runtime list (keryx
core change, not extension-side config alone — the extension's `keryx
init`/`keryx mcp install --runtime vscode` invocation depends on this
entry existing). Writes VS Code's MCP server registration format (exact
file/schema TBD at implementation — VS Code's MCP config location has
evolved across versions; verify current shape live against the installed
VS Code version, not assumed from training-era knowledge — the same
"verify live, don't trust documentation" discipline this whole research
effort has applied repeatedly).

### 2.3 Status bar

Single `StatusBarItem`. Text/icon from `GET /v1/status` (base) composed
with a health/security glyph derived from `health.status` and
`security.check` (polled on the same cadence, short TTL cache). Click opens
a quick-pick or a small detail popup naming which check is unhappy and why
— PRD Requirement 4's "never an unexplained color change."

### 2.4 Tree view — four nodes

- **Status**: single node, label = current 3-state status.
- **Projects**: flat list from `GET /v1/projects`.
- **Recent Turns**: last N (10, cap TBD) from turn history, click reveals
  the corresponding output-channel SSE stream.
- **Needs Your Attention**: merges `flow.status`'s active task + AC
  checklist and `sac.*`'s pending proposals/reviews into one list, sorted
  by... (ordering TBD at implementation — recency vs. proposal-before-task
  or vice versa is a real UX call not resolved by this specification).
  **Explicit empty state required**: when neither module is configured for
  a project, the node must say so legibly, not render blank or appear
  broken (PRD Requirement 5, mitigating decisions.md D-02's accepted risk).

### 2.5 Output channel

Two writers: (a) SSE pipe of `GET /v1/turns/{id}/events` for an in-flight
turn; (b) a **mandatory** structured audit-log line for every mutating
action the extension performs — `{timestamp, actor: user|extension,
action, outcome}` at minimum. Not optional (PRD Requirement 6) — this is
the extension's answer to "what did this thing actually do to my repo,"
identified in the critic round as load-bearing for trust, not a nice-to-have.

### 2.6 Hover provider

Registered for source files. On hover, calls `wiki.query`/`wiki.ask` for
the symbol/file under cursor, debounced and cached per-file, renders a
markdown hover card. Scoped to wiki only in v1 (PRD Requirement 7) —
`gdgraph.affected`/`memory.search` extension is a named v1.1 candidate
(README.md non-goals), not built now.

**Staleness signal — sized here, not deferred silently.** The PRD flags
wiki-staleness as a first-impression trust risk. Resolution for v1:
`wiki.query`/`wiki.ask` responses that already carry a staleness indicator
(keryx's own `gdwiki` module tracks content-hash staleness per the wider
project's architecture) should surface that flag in the hover card (e.g. a
muted "may be outdated" line) rather than presenting every result with
equal confidence. If the MCP tool response does not currently expose a
staleness field, that is itself a finding for implementation to surface
back to `keryx-mcp-client`-adjacent work, not a reason to ship hover cards
with unqualified confidence.

## 3. Version-compatibility — sized here, not deferred silently

The PRD flags version-coupling drift as a real risk with "no mechanism
specified." Resolution for v1: on activation, the extension reads the
installed `keryx --version` (already shell-out-accessible) and compares it
against a `minKeryxVersion` the extension declares in its own manifest —
the same shape `keryx-external-agent-runtime`'s registry already uses for
per-CLI `knownGoodRange` version tolerance (advisory warning, not a hard
block, consistent with that package's own precedent: "a CLI that renames
its version banner must not become unusable"). Below the declared minimum,
show a non-blocking warning, not a refusal to activate.

## 4. Acceptance Criteria

- AC1: `keryx status`'s 3-state result correctly drives the init-prompt
  flow (not-initialized and incomplete both prompt; ready does not).
- AC2: Tree view auto-reveals within one activation cycle of a successful
  `keryx init --yes` run triggered by the extension.
- AC3: `keryx mcp serve` is reachable by VS Code's native MCP client after
  the `vscode` runtime target is registered — verified end to end with a
  real Copilot Chat tool call, not just config-file presence.
- AC4: Status bar click-through names the specific failing check when the
  health/security signal is non-green.
- AC5: Needs Your Attention node renders a real, legible empty state on a
  project with neither `flow` nor `sac` configured — a dedicated test case,
  not incidental coverage.
- AC6: Every mutating extension action produces exactly one audit-log line
  in the output channel, verified by test.
- AC7: Hover provider renders a wiki snippet with a staleness indicator
  when the underlying MCP response exposes one, and does not fabricate
  confidence when it does not.
- AC8: Activation warns (non-blocking) when the installed `keryx` version
  is below the extension's declared minimum.
- AC9: Extension passes `vsce package`/Marketplace publish validation with
  no undisclosed network access beyond the loopback `keryx serve` backend.
