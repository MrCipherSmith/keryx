# Brainstorm: Keryx Remote Entry
Version: 1.0.0

## Status

Decision history for this package. Recorded so a later reader can see which
alternatives were examined and what evidence closed them.

## Evidence collected

### helyx (a private system, studied directly)

A working Telegram-fronted orchestrator for agent sessions, running on the same
host. Studied because it solves this exact problem in production.

Its shape is the **inverse** of a wrapping server:

- The agent is the *client*. Each Claude Code session connects out to helyx's
  MCP endpoint (`/mcp`, streamable HTTP transport, `mcp/server.ts`).
- helyx is the *server*: a grammy bot (`bot/`), an MCP bridge (`mcp/bridge.ts`),
  and Postgres as the shared queue and state store.
- Permission requests travel agent → server as MCP notifications; helyx renders
  them as Telegram inline keyboards (`perm:allow:<id>`, `perm:always:<id>`,
  `perm:deny:<id>`), writes the human's answer to `permission_requests`, and
  `pollForResponse` (`channel/permissions.ts`) polls that table until it can
  answer the agent with `notifications/claude/channel/permission`.

Design points worth importing, most of them visibly learned the hard way:

| Observed in helyx | Why it matters here |
|---|---|
| Approval timeout is 600 s and resolves to **deny** | The human is not at the keyboard; an unanswered prompt must not become an allow. |
| A failed Telegram send auto-denies **immediately** rather than polling for ten minutes | Undeliverable approval is a denial, not a wait. |
| Duplicate `request_id` is ignored — Claude Code retries | Approval must be one-time and idempotent under retry. |
| Auto-approve patterns are read from the *existing* `~/.claude/settings.local.json`, not a bot-local list | The transport must never define its own allowlist. |
| Session↔transport linking is **identity-first** (`X-Helyx-Project` header, exact `project_path` match) with an explicit comment that the previous timing-based approach cross-linked transports between projects under 4+ concurrent sessions | Never pair by timing. Pair by declared identity, fall back to a TTL'd expect queue, and never let an anonymous transport claim a scoped one. |
| Unauthorized senders are **silently dropped** (`bot/access.ts`), not answered | Do not confirm the endpoint exists to an unauthorized caller. |
| Streaming edits one message every 1500 ms, formats as HTML only on the final edit, falls back to plain text on parse failure, and honours Telegram's `retry_after` on 429 | Progress streaming is a transport concern with real rate-limit behaviour; the core must not assume a free channel. |
| Project = forum topic; approvals and previews land in the project's topic, not a DM | Multi-project reach needs a routing key that is not "the user". |

Design points deliberately **not** imported:

| helyx choice | Why keryx does otherwise |
|---|---|
| Postgres as required infrastructure | keryx has zero runtime dependencies and an append-only on-disk session store that already survives restart. Adding a database to gain reach would be the most expensive possible trade. |
| The State Matrix reply gate **fails open** when the database is unavailable (`orchestrator/gate.ts`, "H3: fail open to avoid infinite block") | Defensible for a chat bot that must keep answering. It contradicts keryx's standing rule that containment which cannot be applied causes refusal, never silent downgrade. |
| Bot token in `.env` | The Telegram package already requires an OS credential store reference; that stays. |

### Eggent (`github.com/eggent-ai/eggent`)

A local-first browser workspace, MIT, Next.js. Relevant only for its entry
surface: a single `POST /api/external/message` with a bearer token and a
`sessionId` that carries the active project and chat across calls. That minimal
shape — one route, one token, one session key — is the right amount of surface
for embedding, and is what `api-protocol.md` follows.

Its stated limitation is also instructive: scheduled jobs do not rehydrate after
a process restart. Reach without durability is a half-feature; FR-03 exists
because of it.

## Alternatives considered

### A. Server wraps the agent — `keryx serve` owns the run loop

The HTTP layer starts or resumes a session and drives the existing harness run
loop in-process.

- **For:** one owner of session state; no second store; the policy engine,
  sandbox, budget and evidence path are literally the same code as the TUI; the
  origin marker is trivially unforgeable because the server assigns it.
- **Against:** the entry process must be alive for a turn to run, so a
  detached-run story is needed eventually.

### B. Agent connects out — the helyx inversion

The running agent is a client of a transport server; permission requests flow
outward over notifications.

- **For:** works when you do *not* own the agent, which is exactly helyx's
  situation with Claude Code as a black box. Naturally multi-session.
- **Against:** requires a broker and, in practice, a shared database; splits
  ownership of session state between agent and broker; the origin marker becomes
  something the broker infers rather than something the runtime knows.

### C. Extend the MCP server

Add write-capable tools to the existing opt-in MCP server.

- **For:** no new listener; clients that already speak MCP get it free.
- **Against:** MCP is the surface *agents* use to read this project's context.
  Turning it into the surface *systems* use to submit work conflates two trust
  levels on one endpoint, and the existing MCP server is deliberately read-only.

### D. Do nothing; build Telegram directly into the shell

- **For:** shortest path to the one client actually wanted today.
- **Against:** the browser workspace and embedding then need a second and third
  integration, and the shell — already the most security-sensitive surface in
  the repo — grows a network listener.

## Recommendation

**Alternative A**, because keryx owns its harness. B is the correct design for
someone who does not, which is why helyx chose it; adopting B here would import
a broker and a database to solve a problem we do not have.

Import from B its operational lessons — fail-closed approval timeout, deny on
undeliverable approval, one-time idempotent `request_id`, auto-approve sourced
only from the existing policy, identity-first session binding, silent drop of
unauthorized callers, rate-limit-aware streaming — since those are transport
truths independent of which end holds the socket.

Reject C to keep the read-only agent surface read-only, and reject D because it
puts a listener in the shell.
