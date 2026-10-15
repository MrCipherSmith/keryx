# Brainstorm: Keryx Remote Entry
Version: 1.0.0

## Status

Decision history for this package. Recorded so a later reader can see which
alternatives were examined and what evidence closed them.

## Alternatives considered

### A. Server wraps the agent — `keryx serve` owns the run loop

The HTTP layer starts or resumes a session and drives the existing harness run
loop in-process.

- **For:** one owner of session state; no second store; the policy engine,
  sandbox, budget and evidence path are literally the same code as the TUI; the
  origin marker is trivially unforgeable because the server assigns it.
- **Against:** the entry process must be alive for a turn to run, so a
  detached-run story is needed eventually.

### B. Agent connects out — the broker inversion

The running agent is a client of a transport server; permission requests flow
outward over notifications.

- **For:** works when you do *not* own the agent and must treat it (e.g.
  Claude Code) as a black box. Naturally multi-session.
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
someone who does not, which is why another agent tool chose it; adopting B here would import
a broker and a database to solve a problem we do not have.

Import from B its operational lessons — fail-closed approval timeout, deny on
undeliverable approval, one-time idempotent `request_id`, auto-approve sourced
only from the existing policy, identity-first session binding, silent drop of
unauthorized callers, rate-limit-aware streaming — since those are transport
truths independent of which end holds the socket.

Reject C to keep the read-only agent surface read-only, and reject D because it
puts a listener in the shell.
