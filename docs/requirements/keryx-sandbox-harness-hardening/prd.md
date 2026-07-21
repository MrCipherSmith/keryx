# Sandbox Harness Hardening — Product Requirements
Version: 0.1.0

## Problem

After OS sandbox and credential auto-mask landed, a **live operator deep probe**
on macOS showed:

1. **Containment works** for FS write boundaries and network off/allowlist.
2. **Security contract gaps** remain at the harness CLI edge (e.g. mask without
   TLS may complete instead of fail-closed).
3. **Diagnostics are opaque** — sandboxed helpers fail with **exit 71** and no
   structured reason, so operators mark UNKNOWN instead of PASS/FAIL.
4. **Agent shell thrash** — multi-step probes needed dozens of `shell_exec`
   calls, heredoc approval loops, and macOS-incompatible scripts (`date %N`),
   producing long sessions without a durable REPORT until late.
5. **False-pass risk** — `curl` may exit 0 when the allowlist proxy denies a host;
   only `network.decisions` is authoritative (documented, not always enforced in UX).

Related UX already fixed outside this package: tool budget 8→48 (PR #180),
multiline shell allow globs (PR #181). This package covers **remaining** product
work.

## Goal

Operators and agents can **prove** sandbox posture in under one focused run, with:

- fail-closed mask/TLS on all contained entry paths;
- actionable failure reasons;
- a portable in-repo probe that writes RUN_DIR + REPORT without inventing P3 features.

## Users

| User | Need |
|------|------|
| Human operator | One command/script → REPORT.md; trust PASS/FAIL |
| Interactive agent | Correct flags; no thrash; interpret blocked/decisions |
| Implementer | Clear AC, file touch-points, no ADR-0007 relaxation |
| Reviewer | Security: mask/TLS and false-pass rules testable |

## Requirements

### Functional

| ID | Requirement |
|----|-------------|
| FR1 | Any non-empty credential mask on `harness exec` / shell restricted path **requires** TLS terminate (explicit or auto-derived). Missing TLS → `blocked` / `ok:false` with reason, no successful contained spawn that injects masks without TLS. |
| FR2 | Sandbox spawn failures expose **structured reason** (path, launcher, policy) in harness JSON / tool error string — not only a bare OS exit code. |
| FR3 | Repo ships a **portable** deep-probe entrypoint (script and/or `keryx` subcommand) that creates RUN_DIR, runs matrix A–F subset, applies CONTROLs, redaction scan, writes REPORT.md. |
| FR4 | Probe REPORT includes capability matrix with PASS \| FAIL \| SKIP \| UNKNOWN and evidence paths. |
| FR5 | Agent-facing docs state: restricted deny is **`network.decisions`**, not curl exitCode alone. |
| FR6 | Probe never prints real API key values; redaction FAIL if secret substrings appear under RUN_DIR. |

### Non-functional

| ID | Requirement |
|----|-------------|
| NFR1 | Zero new runtime npm dependencies. |
| NFR2 | No ADR-0007 relaxation. |
| NFR3 | Linux restricted still fails closed (no silent full-network). |
| NFR4 | Interactive shell sandbox remains **opt-in** (not default-on). |
| NFR5 | Default CI does not require live dual-axis or real network probe green. |

## Success criteria

| ID | Criterion |
|----|-----------|
| SC1 | Unit/integration tests: mask specs without TLS → fail closed on harness path. |
| SC2 | At least one regression test or fixture for diagnostic reason on forced spawn failure. |
| SC3 | Portable probe runs on macOS without `date %N`; produces REPORT.md. |
| SC4 | Operator re-run of deep matrix reaches PASS or PASS_WITH_GAPS with **zero** UNKNOWN on B2/C1/C2 when launcher present. |
| SC5 | Docs package status honest; roadmap row present. |

## Risks

| Risk | Mitigation |
|------|------------|
| Over-broad structural guard breaks legitimate ops | Document allowed patterns; helpers with absolute paths |
| Probe flaky on CI | Flag-gate live sections; default unit-only |
| Diagnostic strings leak paths/secrets | Redact secrets; paths only under workspace when possible |
| Scope creep into Linux restricted full support | Explicit out of scope |

## Recommendation

Ship as a **small hardening package** (H1 security/diagnostics, H2 probe script,
H3 docs/UX). Do not open a new sandbox architecture track. Reuse
`keryx-os-sandbox` + credential-auto-mask + dual-axis helpers.
