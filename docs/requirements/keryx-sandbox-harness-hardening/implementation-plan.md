# Implementation Plan — Sandbox Harness Hardening
Version: 0.1.0

## Goal

Close fail-closed and operability gaps without reopening OS sandbox architecture.

## Phase H0 — Package freeze

- Land this requirements package + roadmap row.
- No `src/` required.

**Exit:** docs review green.

## Phase H1 — Security + diagnostics

1. Audit `keryx harness exec` path for mask/TLS: ensure non-empty masks without TLS cannot complete successfully (parity with `resolveCredentialMasks` / shell).
2. Add unit tests AC-H1.
3. On sandbox wrap/spawn failure, populate `outcome.reason` and/or `sandbox.detail` (path missing, launcher denied, non-executable helper).
4. Add regression test AC-H2 (forced failure fixture).

**Touch:** `src/commands/harness.ts`, sandbox adapter/wrap, shell-exec error strings, tests.

**Exit:** AC-H1, AC-H2, AC-H7.

## Phase H2 — Portable probe

1. Add `scripts/sandbox-deep-probe.sh` (bash, portable date, absolute paths, CONTROLs).
2. Write RUN_DIR under `.metaproject/tmp/sandbox-probe-<ts>/`.
3. Emit REPORT.md + optional `report.json` validating against probe-report schema.
4. Document invocation in package README + agent-protocol.
5. Optional thin CLI: `keryx sandbox probe` (only if script alone is insufficient).

**Exit:** AC-H3, AC-H4, AC-H5.

## Phase H3 — Agent UX polish

1. Ensure agent-protocol + operator notes for decisions-over-exitCode (AC-H6).
2. Optional TUI/transcript line when `decisions` contain denies.
3. Link probe from `keryx-os-sandbox` operator-guide (one paragraph).

**Exit:** AC-H6; package status → `implemented` when H1+H2 green.

## Status (honest)

H0–H3-light delivered in one flow (H1 security/diagnostics, H2 probe + docs,
H3 operator-guide link). Heavy TUI polish deferred. Linux full restricted still
out of scope.

## Order

```text
H0 (docs) → H1 (security/diagnostics) → H2 (probe) → H3 (UX)
```

H2 may start after H1 mask/TLS tests exist; do not block probe on TUI polish.

## Effort

| Phase | Size |
|-------|------|
| H0 | S |
| H1 | S–M |
| H2 | S–M |
| H3 | S |

## Already done (do not reimplement)

| Item | Evidence |
|------|----------|
| Tool budget 48 | PR #180 |
| Multiline allow globs | PR #181 |
| Mask resolver + P0.b auto | PR #175–#179 |
| Dual-axis helpers | PR #176 |

## Out of order

Do not implement Linux full restricted network here. Do not default-on interactive shell sandbox.
