# Keryx MCP Servers
Version: 0.1.0

## Purpose

Give `keryx shell` the same **outbound** MCP-server capability Grok Build
ships: the operator configures third-party MCP servers (stdio processes and
remote HTTP endpoints); keryx connects to them; the model discovers and
calls their tools during a session.

This is the gap `keryx-mcp-client` explicitly deferred. That package built a
stdio MCP client and used it for one keryx-spawned child (`codex mcp-server`
elicitation). It named "arbitrary user-added servers" as a non-goal. This
package is that deferred surface, specified to Grok Build parity — not to
OpenCode's "register every MCP tool on the model" shape.

## Status

**P0 merged and released in keryx 0.2.90 (flow 246, PR #522). P1–P3 open.**

Updated 2026-09-10.

Shipped in P0 — `src/mcp-servers/` plus `src/commands/mcp-servers.ts`:

| item | module | what it does |
|---|---|---|
| 1 | `config.ts` | Native user + project JSON, `${VAR}` / `${VAR:-default}` expansion, personal enable/disable overlay. Compat readers deliberately ABSENT rather than stubbed, so nothing reports a source it never read. |
| 2 | `../mcp-client/client.ts` | `connectStdioMcpServer` — a third-party stdio server on the existing seam, with no second MCP library. |
| 3 | `manager.ts` | Bounded concurrent start that never throws (AC8: one bad command, the good server still connects), dial and `listTools` both raced against a timeout. |
| 4 | `catalog.ts` | `server__tool` qualification; every dropped tool carried with its reason. |
| 5 | `tools.ts` | `search_tool` / `use_tool` — two tools of fixed cost instead of N of unbounded cost. Results marked `untrusted`. |
| 6 | `approval.ts` | Per-call risk into keryx's own `resolveApprovalDecision`, never a parallel policy. Trust still asks for destructive; headless is DENIED; the approval fingerprint is checked, not just the boolean. |
| 7 | `store.ts` | The write seam. Never touches a compat source, never writes `enabled: false` into a committed project file. |
| 8 | `doctor.ts` | Config problems + a real connect + tool count + skipped FQNs, with `env`/`headers` reduced to `set`/`unset` (§2). |
| — | `spawn-env.ts` | The child environment: copy-then-strip reusing `EXTERNAL_ENV_DENY`, so a server installed with one `npx` line does not inherit `ANTHROPIC_API_KEY`. |

Verified end to end against a real spawn, not only fixtures: `keryx mcp add
self -- keryx serve-mcp --cwd <repo>` then `keryx mcp doctor self` connects,
handshakes and lists. **That run raised [D-13](decisions.md) (open):** 19 of
keryx's own 45 tools reachable, 26 skipped, every one for a `.` in the name —
§5.1 specifies skip-on-invalid-FQN rather than sanitise. P0 ships the
specification as written; the remedy is P1's.

Still open: HTTP/SSE transports, OAuth and owner-only credentials, the
read-only compat readers, and the `/mcp` TUI repoint.

Shipped earlier, in 0.2.85 (PR #499, #500):

<!-- retired-spellings-ok: line — the was-to-is record of the rename itself, which cannot be written without naming the spelling that was retired -->

- `keryx mcp serve` → `keryx serve-mcp`; `keryx mcp install|uninstall` →
  `keryx integrate [--remove] <editor>`. The old spellings still work and each
  prints exactly one deprecation line. **`keryx mcp` is now free for the
  consumer verbs this package specifies** (`add|list|remove|enable|disable|
  doctor`).
- The TUI installer view gained `/integrations`. `/mcp` still opens it and is
  marked deprecated — deliberately NOT repointed at the consumer, which does
  not exist yet: a slash command aimed at nothing is worse than one aimed at
  the old thing. Repointing it is P2's job (D-04).
- **AC9 is already enforced.** `/mcps` cannot be registered:
  `src/commands/agent-commands.confusable.test.ts` fails the build on any
  second command differing only by a trailing `s` unless declared, and the
  guard is mutation-verified — inserting `/mcps` into the registry fails the
  named test on its pair assertion.

The rest of P2 — the consumer modal and the Tools-tab caption — is untouched.

Verified against current code:

- `src/tui/mcp-inspector.ts` still states that keryx does not consume MCP
  servers as a client. `/mcp` and `/integrations` both install **keryx itself**
  into editor configs — the caption is still true and AC17 is still open.
- `src/mcp-client/` now also exports `connectStdioMcpServer` for a third-party
  server, alongside the `codex mcp-server` path it already had. It still does
  not speak HTTP — that is P1 — and it still never reads user config, which
  `src/mcp-servers/config.ts` does instead.
- `src/commands/mcp.ts` routes the CONSUMER verbs to
  `src/commands/mcp-servers.ts` and remains a deprecation alias for the
  publisher ones; the publisher itself lives in `src/commands/serve-mcp.ts`
  and `src/commands/integrate.ts`.
  No consumer verb is implemented.
- `GatedToolRisk` is `"read" | "shell" | "destructive" | "delegate" | "write"`
  (`src/commands/permission-mode.ts`). There is no MCP tool risk class.
- Interactive tools are a static `InteractiveTool[]` injected into
  `AgentDeps` (`src/commands/agent.ts`). There is no `search_tool` /
  `use_tool` pair.

## Document Index

| Document | Purpose |
|---|---|
| [README.md](README.md) | This overview, status, scope, index. |
| [prd.md](prd.md) | Problem, goal, users, requirements, success criteria, risks, recommendation. |
| [specification.md](specification.md) | Identity, config, CLI/TUI, data contracts, integrations, acceptance criteria. |
| [decisions.md](decisions.md) | Adopted decisions and explicit refusals. |
| [brainstorm.md](brainstorm.md) | Grok Build reference (source of parity) and other harnesses studied. |
| [implementation-plan.md](implementation-plan.md) | Phased implementation order mapped to acceptance criteria. |
| [schemas/mcp-servers-config.schema.json](schemas/mcp-servers-config.schema.json) | Native user/project MCP-servers JSON config. |

## Scope

- User- and project-scoped MCP **server** configuration that keryx's own
  agent loop consumes.
- Transports: stdio (local process) and streamable HTTP (remote). SSE is a
  config alias for the HTTP transport, matching Grok Build's runtime, not a
  second client stack.
- Internal tool catalog namespaced `server__tool`.
- Model-facing discovery/dispatch via `search_tool` and `use_tool` (Grok
  Build's stable-tool-list design), not by dumping every MCP tool into the
  provider tool list.
- CLI: `keryx mcp add|list|remove|enable|disable|doctor` alongside the
  existing `serve|install|uninstall`.
- TUI: `/mcp` (consumer). The keryx-as-server installer view moves to `/integrations`
  stays.
- OAuth for remote servers, owner-only credential store.
- Compat readers for Cursor, Claude Code, project `.mcp.json`, and Grok
  `[mcp_servers.*]` TOML.
- Approval through `resolveApprovalDecision`. Security scan of discovered
  tool descriptions before they are searchable.

## Non-goals (this version)

- Changing the *behaviour* of the publisher surface, now `keryx serve-mcp` / `keryx integrate` (keryx as an MCP **server**
  for Cursor/Claude/OpenCode/VS Code).
- Replacing or widening `keryx-mcp-client`'s Codex elicitation supervisor.
  That path stays. This package reuses generalized transport primitives; it
  does not reroute `codex-cli`.
- Becoming a full MCP spec client: sampling, elicitation from *user* MCP
  servers, roots, resource subscriptions, MCP Apps UI, and prompt
  registries are deferred. Grok Build itself does not ship those to the
  model; parity does not invent them.
- A marketplace / plugin catalog. Config + CLI + TUI + compat import is the
  surface.
- Docker as a first-class transport. Stdio `command = "docker"` is enough,
  as in Grok Build.
- OpenCode-style native registration of every MCP tool on the model.
- Changing `keryx-provider-auth` D-01. MCP OAuth tokens are keryx-owned
  credentials for MCP servers the operator added, stored like search
  credentials — not vendor coding-CLI subscription tokens.

## Related modules

- [Keryx MCP Client](../keryx-mcp-client/README.md) — stdio client
  foundation and Codex elicitation supervisor. D-04 there promised a
  general-shaped client with one named consumer; this package is the
  second consumer.
- [Keryx Project Agent Harness](../keryx-project-agent-harness/README.md) —
  `InteractiveTool`, `executeCall`, `resolveApprovalDecision`.
- [Keryx OpenTUI Shell](../keryx-opentui-shell/README.md) — slash commands
  and modal host. `/mcp` already exists and must not be overloaded.
- [Keryx OS Sandbox](../keryx-os-sandbox/README.md) — containment for
  spawned stdio MCP children; remote HTTP is not a filesystem sandbox
  concern.
- [Keryx Provider Auth](../keryx-provider-auth/README.md) — D-01 credential
  boundary this package sits beside (MCP OAuth ≠ vendor CLI login).
