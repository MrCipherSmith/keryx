# Launch prompt — P1 Global sandbox defaults (flow-orchestrator)
Version: 0.1.0

**Prerequisite:** P0 (PR #175) + Verify (flow 105) landed on main.

Copy the fenced block into a flow-orchestrator session. One phase only.

---

```text
Run flow-orchestrator for ONE phase only: P1 global sandbox defaults.

## Metaproject hard gate
Project root: keryx worktree (prefer clean main).
Read `<project-root>/.metaproject/index.md` before any repo action.
Never edit flow.json by hand. All flow state: `keryx flow …` CLI only.

## Standing operator rule
When green: commit phase deliverables and push to main (PR+merge or direct).
Then stop; request P2 launch prompt.

## Intent
Implement **P1 only** of Sandbox Credential Auto-Mask:

Package: docs/requirements/keryx-sandbox-credential-auto-mask/
Read: specification.md (sandbox.json), schemas/sandbox-defaults.schema.json,
implementation-plan.md Phase P1, policies.md P-RES-1, README.

## Baseline (do not reimplement)
- mask-resolve.ts + shell/harness wire-up (P0)
- dual-axis-report + verification.md (Verify)

## P1 deliverables
1. src/lib/sandbox-config.ts — load/save ~/.local/share/keryx/sandbox.json
   (same data dir as auth.json); never throw; never store secrets.
2. Schema fields: shell, tlsTerminate, maskMode (see sandbox-defaults.schema.json).
3. Resolution order: env > global sandbox.json > built-in defaults.
4. Wire shell-exec + harness to use defaults when env unset.
5. Unit tests with temp dir (mirror shell-config tests) — AC12.
6. Docs note in package README: P1 landed; P2 still future.

## Frozen AC
- AC-P1-1: load empty/missing file → empty defaults, no throw
- AC-P1-2: env overrides file for maskMode/shell/tls
- AC-P1-3: file used when env unset
- AC-P1-4: save round-trip; mode 0600 or owner-safe path
- AC-P1-5: no API key fields accepted/written
- AC-P1-6: shell_exec/harness consult sandbox-config when env unset

## Out of scope
P2 project policy/init · P0.b default=auto · live dual-axis changes

## Done report
flow id, files, tests, commit/PR, "P2 NOT done"
```
