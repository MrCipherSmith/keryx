# R4b: keryx serve skeleton (loopback listener, bearer auth, token lifecycle, status/projects routes)

Status: formalized
Source: roadmap R4 (Phase 1 — "get keryx out of the terminal"), second slice.
Requirements package: `docs/requirements/keryx-remote-entry/` v1.1.0.

## Problem

The only way to reach a keryx agent today is a TTY. `keryx shell` owns stdin and
the run loop lives inside a process bound to that terminal. The
`keryx-remote-entry` package specifies a second door — a loopback-bound HTTP
adapter over the already-implemented Project Agent Harness — so that a Telegram
bot, a browser workspace or an embedding product can drive one surface instead of
three integrations.

The first slice (R4a, flow 127, PR #215) shipped the addressing layer: a
user-global project registry (`src/lib/project-registry.ts`,
`src/commands/projects.ts`). Nothing yet listens.

R4b builds the **door itself, and nothing behind it**: a process that can bind a
loopback socket, authenticate a bearer token, and answer two read-only questions.
It deliberately cannot run a turn. Opening a network listener is the most
security-sensitive change in this codebase to date, so the listener lands before
anything that can execute, and it lands with its refusal paths proven.

## Expected Outcome

- `keryx serve` exists and is **off by default**: a fresh install binds no port,
  holds no token, and `keryx serve status` reports `stopped`.
- A user-global serve configuration exists, shaped against
  `schemas/remote-entry-config.schema.json`, carrying mode, bind address, profile
  name, timeouts and an **opaque credential reference id**. A raw bearer token is
  structurally impossible in it.
- `keryx serve token issue | revoke | rotate` manages one credential. The token
  is printed exactly once, at issue; only a salted hash and an opaque id are
  persisted, at mode 0600. No route, command, status output or error message can
  print an existing token.
- Startup is a state machine — `stopped -> configured -> listening -> draining ->
  stopped`, with `refused` as a terminal startup outcome. `refused` means **no
  socket is ever bound**, never a degraded listen.
- The listener answers exactly two authenticated routes, `GET /v1/status` and
  `GET /v1/projects`, and nothing else. Authentication runs **before** routing, so
  an unauthenticated request to an unknown path is byte-identical to one to a
  known path.
- Bearer comparison is constant-time and length-independent.
- SIGINT/SIGTERM drain the listener and release the port.

## Decisions

### D1 — `configDir()` is extracted, not copied a third time

`configDir()` already existed twice, byte-identical, in `src/lib/shell-config.ts`
and `src/lib/project-registry.ts`. This slice needs the same directory for
`serve.json` and the credential store. It extracts the resolver into
`src/lib/config-dir.ts` and makes both existing copies import it, rather than
adding a third.

### D2 — Config safety is structural, not name-based

`stripSecretShapedFields` (R4a) cannot be reused for the serve config: the
schema's own legitimate field is `credentialRef`, and the word `credential` is in
`SECRET_WORDS`, so the heuristic would delete exactly the field the schema
requires. The serve config is instead written through a **whitelist projection**
of the schema's `additionalProperties: false` shape. A key outside the schema
cannot reach the file, so a raw token cannot be persisted there by any route —
a stronger and more testable property than a name heuristic.

### D3 — `serve config init` is added to the CLI surface

`specification.md` §CLI surface lists `keryx serve [--bind] [--profile]`,
`keryx serve status` and `keryx serve token …`, but names no command that
*creates* the configuration. Something must, and inferring a persisted config
from a bare `keryx serve` invocation would make "off by default" depend on
argument order. `keryx serve config init [--bind] [--port] [--profile]
[--acknowledge-non-loopback]` and `keryx serve config show` are added as the
explicit operator action. Flags on `keryx serve` itself remain a per-run overlay
and are never persisted.

### D4 — `keryx serve status` reports configuration state, not cross-process liveness

This slice writes no PID file and opens no control socket, so a separate CLI
process cannot honestly claim `listening`. `keryx serve status` therefore reports
`stopped` (nothing configured), `refused` (configured but a startup precondition
fails, with the reason) or `configured`. `listening` and `draining` are reported
by the running process over `GET /v1/status`, which is the only place they are
knowable. Cross-process liveness belongs with the slice that adds a supervisor.

### D5 — `serve` is excluded from the command descriptor registry

`src/standard/command-registry.ts` describes agent-callable operations.
`keryx serve` binds a port and runs until signalled — the same shape as the
existing `shell` and `harness` exclusions — and `serve token issue` mints a
credential. Neither is a single callable agent operation, so `serve` joins
`EXCLUSIONS` in `src/standard/command-registry.coverage.test.ts` with that
reason, rather than being described.

## Out of Scope — with reasons

- **`task.submit`, turns, streaming, tool execution.** The next slice. This one
  deliberately cannot execute anything, which is what makes shipping a listener
  acceptable.
- **The non-weakening remote policy profile check (spec AC-04).** It compares a
  remote profile against the local one. This slice runs no turn, evaluates no
  policy decision, and there is no single existing `resolveLocalProfile` to
  compare against — profiles are built inline per command (`shellAllowProfile()`
  / `readOnlyProfile()` in `src/commands/harness.ts`). Implementing the check
  here would mean inventing a local-profile resolver to guard a server that
  cannot execute anything. It belongs with the first slice that runs a turn. The
  config still carries a profile name and `serve status` reports it.
- **Asynchronous approvals, maintenance operations (`GET /v1/commands`,
  `POST /v1/maintenance`), credential handoff links.** Later slices. The
  pending-approval count is reported as a constant 0 because nothing can create
  one.
- **`GET /health` (unauthenticated liveness).** `api-protocol.md` exempts it from
  authentication. In a slice whose whole security claim is "authentication runs
  before routing, so nothing is distinguishable to a stranger", an unauthenticated
  route is a hole in the property being proven. It lands with the slice that has
  a supervisor to need it.
- **TLS, a public listener, any non-loopback default.** Non-loopback stays
  refused-unless-acknowledged.
- **Rate limiting / throttling of repeated auth failures.** `security-policy.md`
  requires it for the full surface; on two read-only routes behind a
  loopback-bound socket there is nothing to enumerate and no state to change, so
  it is deferred to the slice that adds a route which mutates.
