# Keryx MCP Servers — Decisions
Version: 0.1.0

Numbering is local to this package.

## D-01: Grok Build is the parity target, not OpenCode

**Decision.** Behavioral reference is Grok Build's MCP client: namespaced
`server__tool` catalog, model access via `search_tool` / `use_tool`, CLI
`mcp add|list|remove|enable|disable|doctor`, stdio + HTTP, OAuth, compat
import of editor configs.

Parity is behavioural, not literal: Grok's consumer modal is `/mcps`, and
keryx uses `/mcp` for it instead (D-04). Grok has only the consumer side, so
`/mcp` was free for it; keryx has both and must say which is which.

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
`keryx integrate` and "add Playwright" collide. TOML would be a third
config language in a JSON codebase; Grok TOML is imported, not authored.

## D-04 (superseded 2026-09-09): `/mcp` consumes; the publisher is renamed

**Decision.** The consumer surface keeps `mcp` — `keryx mcp add|list|remove|
enable|disable|doctor|auth` and TUI `/mcp`. The publisher surface is renamed
to say what it does:

| was | is |
|---|---|
| `keryx mcp serve` | `keryx serve-mcp` |
| `keryx mcp install --runtime <editor>` | `keryx integrate <editor>` |
| `keryx mcp uninstall --runtime <editor>` | `keryx integrate --remove <editor>` |
| `/mcp` (installer view) | `/integrations` |

Retired spellings keep working and print one line naming the replacement.
Nothing is removed.

**`/mcps` is not introduced.** Guarded by
`src/commands/agent-commands.confusable.test.ts`: a slash command differing
from another only by a trailing `s` fails the build unless declared with a
written reason why a mistype is harmless.

**What this replaces.** The original D-04 read: *"New slash command `/mcps`. Do
not overload `/mcp`."* Its reasoning was sound as far as it went — the MCP tab
is easy to misread as "servers this agent is connected to", and overloading
`/mcp` would make that bug the product.

**Why it was reversed.** That argument treats the misreading as a thing to
route around. It is better read as evidence the name is already wrong: users
expect `/mcp` to mean the servers they are connected to, because that is what
it means in Claude Code and in every other harness with only the consumer side.
Adding `/mcps` for the thing they meant makes today's surprise permanent
instead of fixing it.

And it is the one collision on this surface with **no disambiguator**. A slash
command carries no flags and no arguments; `/mcp` and `/mcps` are one character
apart and, under the original decision, opposite roles. Nothing tells the
operator which ran until it has.

The risk was already recorded in `prd.md` under *"`/mcp` vs `/mcps`
confusion"*, with rewriting the installer copy as the mitigation. Renaming the
installer is the same mitigation carried to its conclusion.

Grok's consumer modal being `/mcps` is not a reason for keryx: Grok has only
the consumer side, so `/mcp` was free and `/mcps` was a stylistic choice. Keryx
has both sides and must say which is which.

**Cost, corrected 2026-09-09.** 116 references across `docs/`, `README.md`,
`src/` and `.metaproject/` — `serve` 65, `install` 39, `uninstall` 12, measured
with `git grep` against `HEAD`. An earlier figure of 414 was wrong: it counted
the gitignored `.metaproject/data/gdctx/` search log, which the counting itself
was writing into. Full
analysis, including a cheaper variant that was considered and not taken, is in
[naming-collision.md](naming-collision.md).

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
is sufficient. `keryx serve-mcp` remains its own `modules.mcp.enabled` flag;
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

## D-13 (RESOLVED 2026-09-11 — sanitise, first-wins on collision)

**Question.** Should a tool whose qualified name fails
`^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$` be SKIPPED (specification §5.1 as written),
or SANITISED into a valid FQN while `rawName` keeps carrying the wire name?

**What P0 measured.** `keryx mcp doctor` was pointed at keryx's own
`keryx serve-mcp` — the one MCP server whose tool list this repository
controls. Result: **19 tools reachable, 26 skipped.** Every skip had the same
cause: a `.` in the tool name (`sac.read`, `gdgraph.find`, `wiki.ask`,
`health.gate`, …). More than half of a server's surface disappeared, and the
server was ours.

**Why the regex is nonetheless right.** It is not arbitrary parity with Grok.
Provider tool-name limits are real, and Anthropic's own API rejects a `.` in
a tool name. Loosening the pattern would move the failure from load time,
where `doctor` explains it, to call time, where the provider rejects the
whole request with a message that says nothing about MCP.

**Why skipping is nonetheless wrong.** `CatalogEntry` already separates `fqn`
(keryx's name, shown to the model) from `rawName` (the server's name, sent in
`tools/call`). That separation is what would make sanitising cheap: `sac.read`
becomes `self__sac_read` on the model's side and stays `sac.read` on the
wire. Nothing about provider safety requires DROPPING the tool.

**Not decided here.** Sanitising introduces a collision the current pattern
cannot produce — `a.b` and `a_b` would both map to `a_b`. `catalogForServer`
already records a duplicate FQN as skipped with a reason, so a fallback
exists, but which name wins is a choice this note does not make.

**Decision.** SANITISE. A tool whose qualified name fails the pattern is
renamed for the model and keeps its wire name: `sac.read` becomes
`self__sac_read` in `fqn` and stays `sac.read` in `rawName`. The regex is
unchanged — it is still what keeps a `.` from reaching a provider that
rejects it — and the separation `CatalogEntry` already had is what makes
this cost nothing.

**Collision.** `a.b` and `a_b` both sanitise to `a_b`. FIRST WINS, in the
order the server's own `tools/list` returns, and the loser is recorded as
skipped with a reason. This reuses the duplicate-FQN path
`catalogForServer` already has rather than adding a second mechanism. A
numeric suffix (`a_b_2`) was rejected: it invents a name that exists
neither on the server nor in any config, so the operator has nothing to
match it against.

decided-by: altsay (operator), 2026-09-11, in the helyx channel — shown
both questions with options and a recommendation, answered with the
recommendation on each and confirmed in text.

**Status.** P0 and P1 shipped the specification as written (skip +
`doctor` warning), so the behaviour through 0.2.92 is the one that was
reviewed. The evidence above is reproducible: `keryx mcp add self --
keryx serve-mcp --cwd <repo>`, then `keryx mcp doctor self`. Implementing
this decision is P3 work, alongside the compat readers.

## D-14: a project-scoped server is not started until the operator approves it

**Decision.** A server defined in `<project>/.keryx/mcp-servers.json` is held
at status `needs-approval` and never dialled until `keryx mcp trust <name>`
records the operator's consent. User-scoped servers are unaffected.

**Why this was not in the specification.** §2 treats the project file as an
ordinary config layer that is committed and shared. The P0 review asked what
that means on a machine that has just cloned the repository, and the answer
was: `git clone … && cd … && keryx` executes whatever command the
repository's author wrote, before the prompt paints, with no approval, and
without the model or `use_tool` being involved at all. There was no
folder-trust mechanism anywhere in keryx to fall back on.

That is the same hazard VS Code answers with Workspace Trust and Claude Code
with folder trust, and it is not a hazard the approval gate on `use_tool`
touches — the code runs at session start, long before any tool call.

**Shape.** Two properties follow from approving *the exact command*:

- the record is keyed by what will be EXECUTED (command, args, env, cwd),
  not by the server's name. Getting a harmless `docs` approved and changing
  it in a later commit does not carry the approval forward.
- the record lives in the operator's config directory, owner-only. A trust
  marker a repository can commit is not a trust marker.

An unreadable trust store grants nothing.

**What it costs.** One command, once per project server, per machine. The
alternative price is that adding keryx to a repository becomes a way to run
code on every contributor's laptop.

**Not applied to user scope**, deliberately. The operator wrote that file
themselves with `keryx mcp add`; asking them to confirm their own action is
the kind of prompt people learn to dismiss unread, which makes the prompts
that matter worth less.

**Status.** Implemented in P0 (`src/mcp-servers/trust.ts`). The
specification's §2 and §4.2 should be amended to describe it; this note is
the decision record until they are.
