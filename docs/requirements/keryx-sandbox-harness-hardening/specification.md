# Sandbox Harness Hardening — Specification
Version: 0.1.0

## Module Identity

- **Name:** `keryx-sandbox-harness-hardening`
- **Kind:** harness / sandbox operator + security edge hardening
- **Status:** draft (not implemented)
- **Home code (planned touch-points):**
  - `src/commands/harness.ts` — CLI flags, mask/TLS gate before spawn
  - `src/harness/process/sandbox/mask-resolve.ts` — shared fail-closed (already)
  - `src/harness/process/sandbox/network-run.ts` / adapter wrap — spawn failure reasons
  - `src/harness/tool/builtin/shell-exec-tool.ts` — parity + error strings
  - `src/lib/shell-permissions.ts` — **done** multiline globs (PR #181)
  - `src/commands/agent.ts` — **done** budget default 48 (PR #180)
  - `scripts/sandbox-deep-probe.sh` — **planned** portable probe
  - optional: thin `keryx sandbox probe` CLI wrapping the script

## Related packages

- `docs/requirements/keryx-os-sandbox/`
- `docs/requirements/keryx-sandbox-credential-auto-mask/`
- `docs/verification/linux-sandbox-verification.md`

## Structure

```text
docs/requirements/keryx-sandbox-harness-hardening/
  README.md
  prd.md
  specification.md
  policies.md
  agent-protocol.md
  metrics-and-validation.md
  implementation-plan.md
  brainstorm.md
  schemas/probe-report.schema.json
  launch-prompts/

scripts/sandbox-deep-probe.sh          # planned runtime deliverable
```

## Config / env surface

| Name | Role |
|------|------|
| Existing mask/TLS env | Unchanged; fail-closed enforced |
| `KERYX_ALLOW_REAL_SUBPROCESS=1` | Live smoke (existing) |
| `KERYX_DUAL_AXIS_LIVE=1` | Dual-axis live (existing) |
| `KERYX_AGENT_MAX_TOOL_CALLS` | Optional budget override (landed) |
| Probe RUN_DIR | `.metaproject/tmp/sandbox-probe-<utc>/` (no secrets) |

## CLI surface (planned)

### A. Enforce on existing `keryx harness exec`

Before starting a restricted/masked run:

1. Resolve masks via `resolveMasksFromSandboxEnv` / CLI flags (same as shell).
2. If resolution `ok:false` → exit non-zero, print reason, **do not spawn**.
3. If masks non-empty and TLS false → must not reach successful masked run
   (parity with pure resolver).

### B. Diagnostics

Harness outcome JSON (or tool error) SHOULD include when blocked/failed:

```json
{
  "outcome": { "kind": "blocked" | "completed", "exitCode"?: number, "reason"?: string },
  "sandbox"?: { "launcher": "seatbelt" | "bwrap" | "none", "detail"?: string },
  "network"?: { "restricted": true, "decisions": [ ... ] }
}
```

Bare exit **71** without `reason` is a **defect** relative to this package.

### C. Probe entrypoint

```bash
# Planned
./scripts/sandbox-deep-probe.sh
# or
keryx sandbox probe [--run-dir PATH] [--live-smokes]
```

Requirements:

- `set -u`; portable `date` (no GNU `%N`);
- absolute paths for harness exec;
- no shell metachar in harness argv (helpers as executable scripts with `chmod +x`);
- CONTROL runs outside sandbox for each deny claim;
- redaction scan over RUN_DIR;
- write `REPORT.md` + optional `report.json` per schema.

## Data contracts

See [schemas/probe-report.schema.json](schemas/probe-report.schema.json).

Probe matrix (minimum for H2):

| ID | Check |
|----|-------|
| A1–A2 | launcher + harness echo |
| B1–B2 | write in / write out + CONTROL |
| B5 | write `/tmp` (or document platform path policy) |
| C1 | network off + CONTROL |
| C2 | allowlist allow + deny via **decisions** (macOS; Linux document fail-closed) |
| D\* | mask path if fixture/key available; else SKIP with reason |
| E\* | live smokes optional flag |
| F1 | metachar blocked |
| R1 | redaction clean |

## Integrations

| Component | Integration |
|-----------|-------------|
| mask-resolve | Single source for fail-closed TLS |
| dual-axis-report | Reuse redaction helpers in probe |
| shell permissions | Already multiline-aware |
| OpenTUI approval | May surface decisions; optional H3 |

## Acceptance criteria

| ID | Criterion |
|----|-----------|
| AC-H1 | Harness path: non-empty masks without TLS → non-success outcome; unit test green. |
| AC-H2 | Forced sandbox spawn failure surfaces non-empty `reason` or sandbox.detail in at least one automated test. |
| AC-H3 | `scripts/sandbox-deep-probe.sh` exists, is executable, runs matrix min set on macOS without `%N`. |
| AC-H4 | Probe writes REPORT.md with matrix table + overall PASS \| PASS_WITH_GAPS \| FAIL. |
| AC-H5 | Redaction: fixture secret in artifact → overall FAIL. |
| AC-H6 | Agent-protocol documents decisions-over-exitCode rule. |
| AC-H7 | Zero new runtime npm deps; ADR-0007 intact. |
| AC-H8 | Roadmap row + package status honest (`draft` until code lands). |

## Non-goals (spec)

- Linux domain-allowlist full support.
- Changing default interactive `KERYX_SANDBOX_SHELL`.
- Storing secrets in project policy or probe fixtures (fixtures only synthetic).
