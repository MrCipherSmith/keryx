# Context

Source pack:

- `feat/shared-agent-context` already merged on `main`; Flow 151 (Phase 5) is complete.
- Current policy-experiment implementation exposes:
  - corpus manifest digest binding
  - independent outcome quarantine
  - sandbox control/escape evidence and execution receipts
  - opt-in gating with kill-switch and rollback path
- Remaining gap: operator-ready real opt-in path is not yet documented as a deployment
  posture and no runbook exists for real artifacts.

Reference files:

- `docs/requirements/shared-agent-context/implementation-plan.md`
- `docs/requirements/shared-agent-context/README.md`
- `docs/requirements/shared-agent-context/phase-5-policy-experiment-report.md`
- `docs/requirements/shared-agent-context/phase-execution-prompts.md`
- `src/sac/policy-experiment.ts`
- `fixtures/sac-policy-experiment/README.md`
