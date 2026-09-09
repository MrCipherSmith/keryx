# Keryx MCP Servers — Decisions
Version: 0.1.0

Numbering is local to this package.

## D-01: Grok Build is the parity target, not OpenCode

**Decision.** Behavioral reference is Grok Build's MCP client: namespaced
`server__tool` catalog, model access via `search_tool` / `use_tool`, CLI
`mcp add|list|remove|enable|disable|doctor`, TUI `/mcps`, stdio + HTTP,
OAuth, compat import of editor configs.

**Reasoning.** The operator request is "keryx should work like grok-build."
OpenCode (and Kilocode on the same runtime) register every MCP tool as a
native model tool (`server_tool`). That dumps a changing, often large list
into `AgentDeps.tools` every session and busts any chance of a stable
tool-definition prefix. Grok Build omits MCP FQNs from the advertised list
on purpose (`tool_definitions_builtins_only` drops names containing `__`)
and keeps KV cache stable. Keryx's interactive loop already takes a static
`InteractiveTool[]`; the Grok shape maps onto that seam without inventing a
dynamic provider-tool rewrite.

**Rejected.** OpenCode's per-tool registration as v1. Resources-as-three-
synthetic-tools (OpenCode) and Crush/Gemini FQN styles (`mcp_`, `mcp__`)
are also rejected for v1.

## D-02: New package and `src/mcp-servers/`, not a v2 of `keryx-mcp-client`

**Decision.** Codex elicitation stays `keryx-mcp-client`. User-configured
servers are this package. Shared transport primitives may move into
`src/mcp-client/` (listTools, HTTP) but Codex-specific wire taps and
`gatedSuperviseCodexMcpRun` are not reused as the user-server manager.

**Reasoning.** `keryx-mcp-client` D-04: "general-shaped client, single named
consumer." Reopening that package to take marketplace scope would mix two
acceptance suites (elicitation vs catalog) and two permission stories
(Codex asks keryx; here the model asks keryx to call a third-party tool).
`connectCodexMcpClient` is deliberately non-standard (raw-wire tap,
`Protocol.prototype.setRequestHandler` for `{action, decision}`). User
servers must not inherit that.

## D-03: Native config is JSON in `keryxConfigDir`, not TOML and not `mcp.config.json`

**Decision.** User file `{keryxConfigDir()}/mcp-servers.json`. Project file
`.keryx/mcp-servers.json`. Credentials `{keryxConfigDir()}/mcp-credentials.json`
via `writeOwnerOnlyFile`. Do not write Grok TOML. Do not extend
`.metaproject/core/mcp/mcp.config.json`.

**Reasoning.** Keryx already stores search providers this way
(`src/lib/search-config.ts`). The inbound MCP server config
(`src/mcp/config.ts`) is about *exposing* Metaproject, include/exclude
lists, and redaction — a different document. Mixing them would make
`keryx mcp install` and "add Playwright" collide. TOML would be a third
config language in a JSON codebase; Grok TOML is imported, not authored.

## D-04: `/mcps` consumes; `/mcp` still installs keryx-as-server

**Decision.** New slash command `/mcps`. Do not overload `/mcp`.

**Reasoning.** `src/tui/mcp-inspector.ts` already warns that the MCP tab is
easy to misread as "servers this agent is connected to." Overloading `/mcp`
would make that bug the product. Grok's consumer modal is `/mcps`. Keryx
keeps `/mcp` as `keryx mcp install` UI.

## D-05: `use_tool` is gated, never silent-read

**Decision.** Map MCP calls onto existing `GatedToolRisk` (`read` vs
`destructive`) and `resolveApprovalDecision`. Do not add a fourth decision
layer. Do not add `MCPTool` as a new risk enum in v1 unless implementation
proves the binary split is unworkable. Unknown / write-shaped tools are
`destructive`.

**Reasoning.** `keryx-mcp-client` D-05 already traced approval to
`resolveApprovalDecision`. A new `MCPTool` risk (Grok's `AccessKind::MCPTool`)
would require permission-mode, TUI prompts, and tests across `ask`/`trust`/
`auto` for one feature. Fail-closed mapping onto `destructive` reuses
ADR-0010's trust-mode escalation. Credentials and SAC-review floors already
cannot be lifted.

## D-06: SSE is an alias of streamable HTTP

**Decision.** `--transport sse` and `type: "sse"` use
`StreamableHTTPClientTransport`. No separate SSE client in v1.

**Reasoning.** Grok Build's docs mention SSE; its `start_mcp_server` matches
`Http` and `Sse` to the same HTTP transport
(`xai-grok-mcp/src/servers.rs`). Claiming a real SSE stack would overstate
parity. If a live host later requires SDK `SSEClientTransport`, that is a
spec revision with a named probe, not a silent extra.

## D-07: OAuth is in v1 for interactive shells; headless fails closed

**Decision.** Browser OAuth for remote servers, tokens in
`mcp-credentials.json`. Non-TTY / unattended / `keryx serve` never opens a
browser; status is `needs_auth`. Headers and env remain the automation path.

**Reasoning.** Grok Build's hosted examples (Linear, Sentry, Mixpanel) are
OAuth. Omitting OAuth is not Grok parity. Opening a browser from
`keryx serve` would violate that package's "no secrets on the remote
surface" and hang unattended runs.

## D-08: v1 stdio MCP processes are not OS-sandboxed by default

**Decision.** Spawn stdio servers with the same env hygiene as other keryx
children where it already exists (no leaking `KERYX_` secrets into the
child beyond an allowlist), but do not wrap them in Seatbelt/bubblewrap
unless the operator opts in.

**Reasoning.** Grok Build: "Sandbox does not special-case MCP. Stdio
children inherit the agent process." Keryx interactive `shell_exec` sandbox
is already opt-in because default-on breaks npm/bun caches. MCP stdio
servers are typically `npx`/`uvx` and need network + caches. Default-on
containment would make every first-run `npx` server look `failed`. Remote
HTTP is not a child. An opt-in wrap is allowed later; v1 does not claim
MCP stdio is inside the OS sandbox.

## D-09: Compat import is read-only; native writes never clobber editor files

**Decision.** Cursor, Claude, `.mcp.json`, and Grok TOML are sources for
`list`/connect. `keryx mcp add` writes only native JSON. `keryx mcp remove`
does not edit `.cursor/mcp.json`.

**Reasoning.** `src/mcp/client-config.ts` already has a `_keryxManaged`
sentinel so keryx-as-server install never clobbers user MCP entries. The
inverse must hold: consuming those entries must not rewrite them. Grok
Build's merge priority (native > Claude > Cursor > `.mcp.json`) is copied.

## D-10: No new `src/capability/` ceiling

**Decision.** Configured servers are available when configured. Search
providers are the precedent, not `gdskills.external-agents`.

**Reasoning.** External agents spawn a vendor CLI under a subscription and
are hard-disabled in CI/remote. MCP servers are tools the operator added,
closer to SearXNG. A ceiling would mean `keryx init --mcp-servers` plus a
manifest bit before Playwright works — unlike Grok, where adding a server
is sufficient. `keryx mcp serve` remains its own `modules.mcp.enabled` flag;
that flag is inbound and is not reused here.

## D-11: Subagents do not inherit MCP in v1

**Decision.** `spawn_subagent` children keep today's tool list. No
`mcpInheritance`.

**Reasoning.** Grok Build does inherit connections. Keryx child tools are
explicitly assembled in `spawn-subagent-tool.ts` (`builtinReadOnlyTools` +
metaproject + spawn). Silently appending `search_tool`/`use_tool` would
give children network-equivalent reach the parent never budgeted and would
cross the child quarantine story. Follow-up package after v1 is used.

## D-12: Do not consume `codex mcp-server` as a user MCP server

**Decision.** The catalog ignores a server whose command is `codex
mcp-server` (or equivalent). Codex remains the elicitation supervisor's
child, not a `use_tool` target.

**Reasoning.** Mixing them would double-spawn Codex, bypass
`gatedSuperviseCodexMcpRun`, and present Codex's internal tools to the
parent model. AC13 exists to keep the suites separate.
