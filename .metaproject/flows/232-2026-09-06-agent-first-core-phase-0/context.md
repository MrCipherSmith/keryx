# Phase 0 context
Version: 0.1.0

- Project root: /Users/Goodea/goodea/keryx. Branch: codex/agent-first-core. Recorded base: main at 0bc6418fa1a038f8ec909cf949fecba077acf9a4.
- All nine phases share the integration branch; parent alone owns git operations and flow state. Workers own disjoint files, no commits, checkout, stash, push or merges.
- User authorized implementation and phased flows. Stats opt-out persists. Completion choice is reserved until verified work is reviewable.
- Required specification: docs/requirements/keryx-agent-first-core/README.md, implementation-plan.md, decision-traceability.md. Full schema/semantic docpack review passed, runtime not implemented by docs.
- gdgraph affected src/lib/templates.ts => init.ts/update.ts/rules.ts and entrypoint/template tests. Pure renderers must feed one shared pair writer; rules currently restore full index. Main already has short index generation in init/update. Do not rewrite large templating module without need.
- M10 seeds: scripts/benchmark/run-ablation*.ts, run-containment.ts and stress script; src/commands/agent.ts AgentDeps supports maxRounds but maxToolCalls is silently unused in benchmark callers. Inspect actual source for precise locations. A call cap must count tool invocations, not relabel rounds.
- Read .metaproject/wiki/index.md, components/src-lib.md and components/scripts-benchmark.md as navigation only. Wiki freshness has symbol-layer-unavailable/unresolved edges and old d0a2a01 history; prose has known inaccuracies, verify against source.
- memory search accepted routing/index/benchmark yielded no matches. flow init collected additional memory snippets in its initial journal; consult only relevant current evidence.
- Testing context is stale: contains removed .worktrees paths. Use current checkout file existence and explicit focused bun:test files; do not trust old changed selection. Old health PASS at d0a2a01 skipped required ESLint and misparsed Bun audit, so does not certify current work. Later phase 1 repairs health gate.
- Tests: local Bun; use keryx ctx run for captured logs, immutable per-worker report paths so latest report races do not replace evidence. No real-provider calls or credentials.
- Routing: index gate read, graph/wiki/ctx/memory/testing consulted. raw_rg_used:no. No project MCP capabilities exposed, CLI fallback.
