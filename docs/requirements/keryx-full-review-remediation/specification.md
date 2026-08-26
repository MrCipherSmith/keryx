# Technical Specification — Keryx Full Review Remediation
Version: 1.1.1

Status: **spec ready — not implemented**. The interfaces below are target
contracts; names may change while boundaries and acceptance criteria remain.

## Module identity and storage

This is a cross-cutting remediation package. It adds no standalone CLI command,
database, manifest entry, or user-authored configuration. Existing session,
Slate, SAC, proposal, and security artifacts retain their current owners.

## Integration contracts

### Shell process seam

Create a neutral harness-process module that resolves shell environment,
sandbox profile, network posture, and spawn construction. Foreground
`shell_exec` and background jobs consume it. The registry must not import the
shell tool merely to obtain those helpers. Required behavior includes saved
credentials, injected deterministic dependencies, and fail-closed refusal when
required/restricted containment cannot be established.

### SAC lifecycle composition

Remove the runtime value-import SCC among machine wrap-up, proposal lifecycle,
and session wrap-up through a composition/shared layer. Preserve session-versus-
flow provenance, injected-clock expiry, conflict/idempotency results, and
immutable proposal records. Moving only types is insufficient.

### Harness facades and event sinks

Workspace tools use only a narrow public SAC facade or harness adapter. Fleet
publication is an optional injected event sink: TUI composition supplies it;
non-TUI callers receive an absent/no-op sink with unchanged behavior.

### Health reporting

Use these exact terms: `declining scopes` means `regression_score > 0`, while
`regressed scopes` means `trend === "regressed"` under the existing +/-2
deadband. For non-null baseline `delta = current - baseline`: delta <= -3 is
regressed, -2..+2 stable, and >= +3 improved. A null baseline is unknown with
zero regression score. Project-level gate policy does not change.

### Error observability

The fourteen production comment-only catches are inventoried in
`catch-dispositions.md`. Each must retain an intentional parser/cleanup
fallback with a targeted assertion, or gain a typed degraded result or
contextual redaction-safe diagnostic. Raw untrusted content and secrets are
forbidden in diagnostics.

### Durable-write security

Every durable adapter calls `guardOutput({ cwd, content, target, source, path? })`
before writing. `allowed` permits only approved content; a supplied `redacted`
value is written exactly; `allowed: false` writes nothing and returns a named
denied/degraded result. `needs-approval` remains blocked until the existing
single-use, scoped, two-minute confirmation token is consumed.

The contract covers workspace/proposal creation, Slate/archive, session
evidence, proposal records/notes, memory/wiki/skill owner writers, and both
normal and RLM wiki-enrich writes. Read-only web research remains available.

## Acceptance criteria

- **AC-ARCH-1:** No targeted shell/background runtime SCC; identical sandbox/env
  and fail-closed behavior are covered by tests.
- **AC-ARCH-2:** No SAC lifecycle runtime SCC; provenance, expiry, conflict, and
  immutable-proposal tests remain green.
- **AC-ARCH-3:** Workspace tools use only the approved SAC facade/adapter.
- **AC-ARCH-4:** Spawn-subagent has no direct TUI bridge import; injected sink
  behavior is covered for TUI and non-TUI callers.
- **AC-HEALTH-1:** All eight health boundaries (including null baseline) pass.
- **AC-OBS-1:** C-01..C-14 each has an explicit disposition and assertion.
- **AC-SEC-1:** Parameterized sinks persist masks under redact and nothing under
  enforced block.
- **AC-SEC-2:** Web-tainted turns cannot persist raw archive/evidence/proposal
  data before the required human decision.
- **AC-SEC-3:** Ordinary and RLM wiki-enrich writes apply the guard.
- **AC-REG-1:** The targeted harness, SAC, health, security, Slate, owner-writer,
  and wiki suites pass independently.
- **AC-REG-2:** Full-suite comparison introduces no new failure and no skip.

## CLI/configuration surface

No new user-facing command or configuration is planned. Existing schemas and
commands remain compatible; internal dependency injection may be added.

## Explicit non-goals

Provider-auth implementation, wholesale harness/lib reorganization, deleting
intentional graph orphans, treating type-only imports as runtime cycles,
changing gate policy, or retaining blocked raw content.

