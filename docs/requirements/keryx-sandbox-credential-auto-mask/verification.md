# Dual-axis operator runbook
Version: 0.1.0

## Purpose

Live / operator dual-axis verification of sandbox credential masking after a
keryx update. Complements automated unit tests in
`src/harness/process/sandbox/dual-axis-report.test.ts` and
`mask-resolve.test.ts`.

**Default CI does not run live network dual-axis** (AC-V6). Flag-gate any live
smokes yourself.

## Preflight (required first)

| ID | Check | Pass | Fail action |
|----|-------|------|-------------|
| PF1 | `keryx --version` / binary path | Expected build | Stop |
| PF2 | Named API key present in env **or** `auth.json` | Name recorded only — never print value | `/connect` or export |
| PF3 | `openssl version` if TLS needed | Success | Install openssl or skip TLS axes |
| PF4 | sandbox-exec (macOS) / bwrap (Linux) when sandbox on | Available | Install or set sandbox off for negative tests only |
| PF5 | Record `KERYX_SANDBOX_MASK_MODE` (`auto` \| `manual` \| `off`) | Written to preflight.md | Continue |

Never print key values in preflight output.

## Axes

### Axis A — Subagent / model network (NOT mask proof)

- Child agent / model turn under policy (tools RO, network for provider).
- **PASS** if turn completes or typed auth error (not silent FakeProvider when key expected).
- **Do not** require sentinel in model process env.
- **A green model call is never proof of shell masking.**

### Axis B — shell_exec credential mask (mask proof)

Requires restricted network + mask/TLS (auto mode recommended after P0):

```bash
export KERYX_SANDBOX_SHELL=workspace   # or 1
export KERYX_SANDBOX_ALLOWED_DOMAINS=api.deepseek.com   # example
export KERYX_SANDBOX_MASK_MODE=auto
# keys from auth.json after applySavedApiKeys — no need for MASK_ENV in auto
```

| ID | Assert |
|----|--------|
| B1 | Child `printenv <KEY>` → sentinel or empty-not-real; **≠** real key |
| B2 | HTTPS to inject host authenticates (proxy unmask) |
| B3 | Non-inject host does not receive real key |
| B4 | Mask without TLS → fail closed |
| B5 | Auto + key only in auth.json → B1 holds |

### Axis C — Harness CLI parity

Same inputs → same `MaskResolution` as shell path (`resolveMasksFromSandboxEnv`).
Unit coverage on main; live: compare harness `--mask-mode auto` vs env-only shell.

## RUN_DIR layout

```text
RUN_DIR/
  preflight.md          # no secrets
  axis-a.md
  axis-b.md
  axis-c.md
  resolution.json       # MaskResolution only — no realValue fields
  REPORT.md             # summary table only
```

### REPORT.md table

| Axis | Verdict | Notes |
|------|---------|-------|
| Preflight | PASS/FAIL/SKIP | … |
| A | … | … |
| B | … | … |
| C | … | … |

Pure helper (CI-safe): `buildDualAxisReportMarkdown` in
`src/harness/process/sandbox/dual-axis-report.ts`.

## Redaction gate (hard fail)

If the real key substring appears **anywhere** under `RUN_DIR`, the run is
**FAIL** regardless of axis functional pass.

```ts
import { scanArtifactsForSecrets, overallDualAxisVerdict } from ".../dual-axis-report";

const scan = scanArtifactsForSecrets(artifacts, [realKey]); // never log realKey
if (scan.totalHits > 0) {
  // overall = FAIL
}
```

## Overall verdict

- `FAIL` if any axis is FAIL, or redaction hits &gt; 0, or Axis B required and not PASS.
- Axis A PASS + Axis B FAIL ⇒ **FAIL** (A is not mask proof).

## Related

- Protocol: [metrics-and-validation.md](metrics-and-validation.md)
- Policies: [policies.md](policies.md) P-VERIFY-1
- P0 resolver: `src/harness/process/sandbox/mask-resolve.ts`
