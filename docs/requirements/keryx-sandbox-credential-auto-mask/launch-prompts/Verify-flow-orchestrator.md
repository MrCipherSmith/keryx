# Launch prompt — Verify dual-axis (flow-orchestrator)
Version: 0.1.0

**Prerequisite:** P0 merged to `main` (PR #175, flow 103 DONE).

Copy everything inside the fenced block below into a new agent turn that runs
**flow-orchestrator**. One phase only.

---

```text
Run flow-orchestrator for ONE phase only: Verify (dual-axis credential mask).

## Metaproject hard gate
Project root: the keryx repo worktree where you start (prefer clean main).
Before any search, shell, or subagent: read `<project-root>/.metaproject/index.md`.
Use gdgraph / gdctx / gdwiki / memory per Metaproject rules. Never edit flow.json by hand.
All flow state changes: `keryx flow …` CLI only.

## Intent
Implement the **Verify** phase of Sandbox Credential Auto-Mask only:

Package:
  docs/requirements/keryx-sandbox-credential-auto-mask/

Must read:
  - metrics-and-validation.md (full dual-axis protocol)
  - policies.md (P-VERIFY-1, redaction)
  - implementation-plan.md → "Phase Verify"
  - specification.md AC9–AC10 (redaction / dual-axis)
  - README status (P0 already landed — do not re-implement P0)

## Baseline already on main (do not reimplement)
- resolveCredentialMasks / resolveMasksFromSandboxEnv
  (src/harness/process/sandbox/mask-resolve.ts)
- shell_exec + harness exec wire-up (P0.a default maskMode=manual)
- Unit AC1–AC8 green on main (PR #175)

## Verify deliverables
1. Codify dual-axis scenarios from metrics-and-validation.md as automated tests
   where possible (unit/integration first):
   - S1–S4 already partly covered by mask-resolve tests — extend if gaps remain.
   - Axis separation tests: model/path docs or fixtures that assert Axis A is NOT
     used as mask proof (documentation test or comment contract in suite).
   - AC10 redaction: fixture key string must never appear in a generated REPORT
     body helper if you add one.
2. Operator runbook under the package (e.g. launch-prompts or verification.md)
   for live dual-axis with RUN_DIR layout:
   preflight.md, axis-a.md, axis-b.md, axis-c.md, resolution.json, REPORT.md
   — no real secrets; redaction gate documented.
3. Optional: small pure helper that builds REPORT table from axis verdicts
   (unit-tested). Live network dual-axis remains operator-run / flag-gated, not
   required green on default CI.
4. Update package README status: Verify phase delivered; P1/P2 still future.

## Frozen acceptance criteria
- AC-V1: Automated tests cover dual-axis separation (A is not mask proof; B is mask).
- AC-V2: S1–S4 remain or are reasserted; gaps from metrics-and-validation closed in unit form.
- AC-V3: Redaction gate — fixture secret substring fails a scan of sample REPORT artifact.
- AC-V4: Operator runbook documents Preflight + A/B/C + RUN_DIR + fail if secret leaks.
- AC-V5: No P1 sandbox.json, no P2 project policy/init in this flow.
- AC-V6: CI default path does not require live network dual-axis.

## Constraints
- Zero new runtime npm deps.
- Do not flip P0.b default to auto.
- Do not claim live dual-axis green in CI without flag-gated tests.
- code-verifier + focused tests + review before completion choice.
- Never edit flow.json / frozen AC by hand.

## Flow lifecycle
1. keryx flow list — or init --title "Verify dual-axis sandbox credential masking"
2. Enrich from package metrics-and-validation + P0 code; freeze AC; start
3. Workers: tests-creator / task-implementer / code-verifier / review-orchestrator
4. Green → ask A/B/C completion

## Out of scope
P1 global sandbox.json · P2 project policy + init · P0.b default=auto · new mask features

## Done report
flow id, files, tests, AC table, residual risks, explicit "P1/P2 NOT done"
```

---

## After Verify

Report flow id + outcome, then request: **"give me the P1 prompt"**.
