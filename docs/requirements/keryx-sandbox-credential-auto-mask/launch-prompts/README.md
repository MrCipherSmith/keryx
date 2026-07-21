# Launch prompts — flow-orchestrator
Version: 0.4.0

Copy-paste prompts for **one phase per flow**. Do not combine phases in a single
flow unless the operator explicitly expands scope.

| Phase | Prompt file | When to run |
|-------|-------------|-------------|
| **P0** | [P0-flow-orchestrator.md](P0-flow-orchestrator.md) | ✅ Done — PR #175, flow 103 |
| **Verify** | [Verify-flow-orchestrator.md](Verify-flow-orchestrator.md) | ✅ Done — PR #176, flow 105 |
| **P1** | [P1-flow-orchestrator.md](P1-flow-orchestrator.md) | ✅ Done — global `sandbox.json` |
| **P2** | [P2-flow-orchestrator.md](P2-flow-orchestrator.md) | ✅ Done — project policy + init skeleton |

**Operator protocol**

1. Paste the current phase prompt into a session that runs **flow-orchestrator**.
2. When the flow finishes (or verified handoff), report back: phase id + flow id
   + outcome (PR / handoff / open).
3. Ask for the **next** phase launch prompt (do not invent the next phase yourself
   if the docpack owner is producing prompts sequentially).

**Package root:** `docs/requirements/keryx-sandbox-credential-auto-mask/`
