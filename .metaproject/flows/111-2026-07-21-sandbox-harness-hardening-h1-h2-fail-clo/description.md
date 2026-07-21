# Sandbox harness hardening H1+H2 (fail-closed + deep probe)

## Problem

Live macOS deep probe (2026-07-21) showed OS containment works, but:

1. Mask without TLS may not fail closed on all harness edges.
2. Sandbox/helper failures surface as bare exit 71 without reason/detail.
3. Operators lack a portable one-shot probe that writes RUN_DIR + REPORT.md.

## Expected outcome

One branch / one PR implementing the full package (H1 security + diagnostics, H2 probe + docs, H3 light operator-guide link). Package status and roadmap honest after land.

## Out of scope

- Linux full domain-allowlist / restricted network implementation
- Multi-agent fleet
- Force live dual-axis on every CI
- Seatbelt/bwrap redesign
- P3 features
- Default-on interactive shell sandbox
- New mask algorithms or npm deps

## Baseline (do not reimplement)

- OS sandbox + credential auto-mask P0–P0.b (PR #175–#179)
- Tool budget 48 (PR #180), multiline shell allow (PR #181)
- H0 docs package on main (PR #183)
