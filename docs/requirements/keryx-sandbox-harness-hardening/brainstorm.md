# Brainstorm — Sandbox Harness Hardening
Version: 0.1.0

## Source

Operator deep probe via `keryx shell` (2026-07-21, macOS, keryx 0.1.0) and
follow-up analysis of agent budget / approval / mask paths.

## What worked

- Workspace-write containment; outside write denied (with CONTROL).
- Network off; restricted allowlist with `network.decisions`.
- Structural guard on metacharacters.
- Redaction clean on RUN_DIR once REPORT existed.

## Pain points

1. **Exit 71** on helper scripts → UNKNOWN on B3/B4 instead of clear deny/allow.
2. **Mask/TLS** not exercised (no keys); D2 appeared weak (mask without TLS completed).
3. **Probe thrash:** many shell_exec, heredoc approvals, `date %N` macOS breakage.
4. **Tool budget 8** (fixed #180) and **allow pattern newlines** (fixed #181).
5. **curl exit 0** on denied host — decisions required.

## Options considered

| Option | Decision |
|--------|----------|
| New sandbox architecture | **Reject** — containment OK |
| Docs-only package | **Reject alone** — need H1 code for security |
| One-shot probe script | **Accept** (H2) |
| Raise agent budget only | **Partial** — done #180; not enough alone |
| Full Linux restricted | **Defer** to OS package |

## Decisions

| ID | Decision |
|----|----------|
| D1 | Package is **hardening/operability**, not new sandbox |
| D2 | H1 fail-closed mask/TLS on harness is mandatory |
| D3 | H2 portable script is the operator default path |
| D4 | Overall probe PASS requires CONTROLs on deny rows |
| D5 | Zero new npm deps; ADR-0007 holds |
