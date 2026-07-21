# Plan — flow 111 (one flow / one branch / one PR)

## Approach

Implement H1 → H2 → H3-light in a single delivery. Reuse `resolveMasksFromSandboxEnv`
and dual-axis redaction helpers. No new npm deps. No ADR-0007 relaxation.

## Tasks (decomposition)

1. **T1 H1 security** — harness exec: non-empty masks without TLS → structured
   `blocked` (no spawn); unit test on harness path; shell path already uses resolver.
2. **T2 H1 diagnostics** — sandboxed spawn failures / exit-71 class → non-empty
   `outcome.reason` and/or `sandbox.detail`; regression test.
3. **T3 H2 probe** — `scripts/sandbox-deep-probe.sh` portable matrix + REPORT.md +
   optional report.json + redaction FAIL.
4. **T4 H2/H3 docs** — package README how-to, agent-protocol, operator-guide
   paragraph, honest status + roadmap.
5. **T5 verify + review** — focused tests, code-verifier, review; then commit/push/PR/merge.

## Trade-offs

- Prefer structured blocked JSON for mask fail over plain text (machine-readable).
- Exit 71 remains observable as completed+exitCode when not clearly a launcher
  spawn failure; we add detail and map clear sandbox adapter spawn-errors to blocked.
- Probe is bash script only (no thin CLI unless needed).

## Completion

Standing rule: when green → commit, push, open PR, merge to main when checks pass.
