# Implementation Plan

Status: approved (flow-orchestrator, autonomous run)

## Approach

Content is authored per pack by parallel, file-disjoint workers; the small
code additions needed to make the gates real land in one separate lane.

1. **Gate plumbing (T5)** — wire `keryx skills eval --runner <provider>[:<model>]`
   to the existing single-turn provider helper (`runModelTurn`) with the skill
   body as system prompt; extend `checkStablePackGate` to accept a pack-level
   `governance/eval.json` of `{schemaVersion, reports: EvalReport[]}` that must
   cover every skill in `pack.json`; stack-packs guard: >=10 authored trigger
   prompts (>=4 negatives) + >=1 deterministic behavior scenario per skill and,
   for a stable pack, every behavior scenario passRate >= 0.8; `agents verify`
   default `skillExists` learns stack-pack skills and default
   `stackPackExists` requires a gate-cleared pack (stable + passing gate, not
   deprecated).
2. **Packs (T6-T9)** — one worker per pack: research current practice
   (ctx7 / official docs / OWASP), write rules, skills, evals.json, scout
   records via the real CLI, `agentProfile` block in pack.json.
3. **Agents (T10)** — `src/agents/generate.ts` renders the two definitions
   from a pack deterministically; bundled files + drift test; agent-refs.json.
4. **Manifest (T11)** — rule and skill modules per pack, components, profiles.
5. **Gate runs (T12)** — eval every pack skill with the ollama runner
   (`llama3.1:latest`, strictness high, 5 trials), record reports, set stable.
6. **Gate checks (T13)** — agents verify, stocktake vs baseline, guard tests,
   audit-harness on a temp install+export, install dry-runs.
7. **Docs (T14)** — W1/W2 spec updates, coverage count in journal after gate.

## Decisions

- Skill names are prefixed per stack so catalog ids stay unique and routing
  vocabulary stays stack-specific (e.g. `go-build-fix`, `react-code-review`).
- `migrate` only for ts-js-node (CommonJS->ESM) and react (major upgrade);
  python and go declare `migrate: []` explicitly.
- Runner model: local `ollama` `llama3.1:latest` — the only runnable provider
  on this machine without an API key; results are real trials, not synthesized.
- Gate-cleared for generated agents = pack `stable` and `checkStablePackGate`
  pass; a pack that cannot pass stays `experimental` and gets no agents.

## Risks

- Cross-pack trigger stealing (react vs ts-js-node) — authored negatives +
  final eval pass catch it; T12 may tune descriptions.
- 8B local model flakiness on behavior scenarios — graders check concrete,
  skill-driven content; 5 trials with a 0.8 floor.
- Stocktake merge verdicts from near-duplicate descriptions — checked per
  worker with scout and in T13 against the recorded baseline.
