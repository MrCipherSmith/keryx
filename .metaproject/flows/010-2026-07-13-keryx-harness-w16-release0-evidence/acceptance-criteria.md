# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: E-01 — `docs/decisions/keryx-harness/E-01-release0-evidence-matrix.md` maps every Release 0 capability (W1–W7) to a status (implemented / planned / deferred) with a source path, a test-file reference, and a commit; `research-ledger.md` is updated with Release 0 findings/OPEN resolutions; migration notes are recorded; the package index (`decision-registry.md`) is updated to include the W2–W16 artifacts; the two deferred `@release-0` scenarios (SC_R12_TRANSIENT_RETRY, SC_R16_BUDGET_RESERVATION) are explicitly marked deferred; the frozen requirements package is NOT modified.
- AC2: E-02 — `docs/decisions/keryx-harness/E-02-release0-review-package.md` is a normalized managed review of the Release 0 slice across the 7 lenses (architecture, contract, logic, security, testing/replay, performance, Gherkin) with severity-ranked findings and an explicit verdict on whether any BLOCKER/P0/P1 remains; the per-wave (flow 003–009) review outputs are not modified.
- AC3: E-03 — the roadmap/package is promoted and `docs/decisions/keryx-harness/flow-orchestrator-handoff.md` includes the DAG, a frozen acceptance-criteria proposal, the verification gates, constraints, out-of-scope, and the deferred list; the handoff is created ONLY when E-02 reports no BLOCKER/P0/P1 (otherwise the doc records why it is withheld and what must be fixed first).
- AC4: Docs-only / no regression / scope — `git status` shows NO change under `src/**` and no test-file change (the `bun test` suite stays at 797 pass / 0 fail); `tsc --noEmit` is clean; `package.json` dependencies stay `{}`; the frozen requirements package (`docs/requirements/…`) and the frozen ADR-0001…0004 are NOT modified; all new/updated docs live under `docs/decisions/keryx-harness/`; every evidence-matrix row resolves to a file/test/commit that actually exists.
