# Implementation Plan — Sandbox Credential Auto-Mask
Version: 0.1.0

## Goal

Deliver auto-mask, verification, global defaults, then project policy — in that
order — without claiming runtime success until each phase’s gates pass.

## Phase P0 — Auto-mask resolver + wire-up

**Outcome:** Restricted sandbox shell_exec and harness use a shared pure
resolver; default product path masks known provider keys when present.

### Tasks

1. Add `src/harness/process/sandbox/mask-resolve.ts` (+ unit tests) implementing
   `resolveCredentialMasks` per specification.
2. Export a small helper to build the provider list from
   `OPENAI_COMPAT_PROVIDERS` + Anthropic entry (avoid circular imports: pure data
   map or thin adapter in `src/commands/providers.ts` / sibling).
3. Wire `shell-exec-tool.ts`:
   - after `applySavedApiKeys` and env snapshot;
   - when restricted network;
   - resolve mode from `KERYX_SANDBOX_MASK_MODE` (migration default: see below);
   - pass explicit specs from `KERYX_SANDBOX_MASK_ENV`;
   - on `ok:false`, return tool error string (no spawn);
   - on success, pass masks + tlsTerminate into `setupNetworkRun`.
4. Wire `commands/harness.ts` identically for contained runs; add
   `--mask-mode` / optional `--auto-mask`.
5. Tests: unit matrix + shell-exec fixture with mocked network-run.
6. Changelog note: behavior change when mode defaults to auto.

### Migration default for maskMode (P0)

| Stage | Default when env unset |
|-------|------------------------|
| P0.a (first merge) | `manual` if package wants zero surprise; set `KERYX_SANDBOX_MASK_MODE=auto` in docs |
| P0.b (preferred product) | `auto` when sandbox restricted is on |

**Package recommendation:** land P0.a behind explicit env in the first PR if
review prefers caution; flip to P0.b in a follow-up PR with release notes.
Acceptance SC1 assumes P0.b or explicit `MASK_MODE=auto` in the test harness.

### Exit gate

- AC1–AC8 green.
- Manual or CI dual-axis Axis B smoke (see metrics-and-validation) when network
  fixtures available.

## Phase Verify — Dual-axis protocol as tests/runbook

**Outcome:** Documented, redacted verification that separates axes.

### Tasks

1. Codify scenarios from [metrics-and-validation.md](metrics-and-validation.md)
   as automated tests where possible (unit/integration first).
2. Optional `scripts/` or docs runbook under this package for live dual-axis
   (operator-run; not required in default CI if network-bound).
3. Ensure REPORT templates redact secrets.

### Exit gate

- AC9–AC10 (as applicable to CI environment).
- Axis A/B/C verdicts defined; no single boolean “all green” without axis labels.

## Phase P1 — Global sandbox defaults

**Outcome:** `~/.local/share/keryx/sandbox.json` loads when env unset.

### Tasks

1. `src/lib/sandbox-config.ts`: load/save, schema validate lightly, never throw.
2. Path next to `shellConfigPath` data dir.
3. Resolution order in shell-exec + harness: env > file > built-in.
4. Unit tests with temp dir (mirror shell-config tests).

### Exit gate

- AC12 green.
- No secrets accepted/written by sandbox-config.

## Phase P2 — Project policy + init skeleton

**Outcome:** Optional project policy; init scaffold without secrets.

### Tasks

1. Choose path (`.keryx/sandbox-policy.json` recommended).
2. Loader with project root discovery (git root / cwd rules consistent with
   sessions).
3. Merge `extraMasks` into explicitSpecs before resolve.
4. `keryx init` writes skeleton + short comment in next-steps UI.
5. Docs: “keys via `/connect`”.

### Exit gate

- AC13 green.
- Init does not prompt for raw keys into the project tree.

## File touch-point map

| File | P0 | Verify | P1 | P2 |
|------|----|--------|----|----|
| `mask-resolve.ts` | create | — | — | — |
| `shell-exec-tool.ts` | edit | — | edit | edit |
| `harness.ts` | edit | — | edit | edit |
| `network-run.ts` | maybe re-export only | — | — | — |
| `providers.ts` | thin export if needed | — | — | — |
| `sandbox-config.ts` | — | — | create | — |
| `init.ts` | — | — | — | edit |
| tests under harness/sandbox | add | add | add | add |
| this requirements package | update status | update | update | update |

## Effort (order-of-magnitude)

| Phase | Effort | Notes |
|-------|--------|-------|
| P0 | S–M | Pure resolver + two call sites; most risk is default flip |
| Verify | S | Largely tests + runbook |
| P1 | S | Mirror shell-config patterns |
| P2 | S–M | Init UX + path discovery |

## Dependencies

- Existing proxy TLS stack (ADR-0007) — **required**, already in tree.
- Provider registry completeness — custom providers remain explicit-only.
- openssl availability for TLS terminate — fail closed when missing.

## Out of order

Do not implement P2 init secret prompts. Do not block P0 on P1/P2.
