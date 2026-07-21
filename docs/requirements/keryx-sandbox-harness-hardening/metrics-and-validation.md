# Metrics and Validation — Sandbox Harness Hardening
Version: 0.1.0

## Reliability levels

| Level | Meaning |
|-------|---------|
| `exact` | Automated test or structured log field |
| `observed` | Operator probe with CONTROLs |
| `unknown` | Not measured |

## Probe metrics (H2)

| Metric | Definition |
|--------|------------|
| `matrix_pass` | Count of PASS rows |
| `matrix_fail` | Count of FAIL rows |
| `matrix_skip` | Count of SKIP rows |
| `matrix_unknown` | Count of UNKNOWN rows |
| `redaction_hits` | Secret substring hits under RUN_DIR |
| `control_missing` | Deny rows without CONTROL |
| `overall` | PASS if no FAIL, redaction 0, and no required-row UNKNOWN; else PASS_WITH_GAPS or FAIL |

**Required rows for overall PASS (macOS, launcher present):** A2, B1, B2, C1, C2a or documented allowlist check, F1 metachar, R1 redaction.

## Security metrics (H1)

| Metric | Pass |
|--------|------|
| `mask_without_tls_fail_closed` | 1 automated case green |
| `spawn_failure_has_reason` | 1 automated case green |

## Links

- Dual-axis: `docs/requirements/keryx-sandbox-credential-auto-mask/metrics-and-validation.md`
- Redaction helpers: `src/harness/process/sandbox/dual-axis-report.ts`
- Linux false-pass rules: `docs/verification/linux-sandbox-verification.md`

## Schema

Machine-readable companion: [schemas/probe-report.schema.json](schemas/probe-report.schema.json).
