# Keryx Benchmark Suite — Plan
Version: 0.2.0

Three milestones. Each is separately shippable and gated by explicit exit criteria.
No milestone publishes a comparative number before its fairness bar is met.

## M1 — Metastore oracle + Ablation core (+ safety track)

**Scope**

- Extend the protocol to `paired-3-5-v2`: N-run distributions with seeds, ablation
  pairs, IR/oracle metric fields, `ladder` / `model` / `cacheState` /
  `leakageAssertion` fields, per-run token cap. Keep `keryx metrics benchmark
  validate` passing.
- Curated real-repo gold sets for gdgraph (affected-set), gdwiki (Q→passage) and
  testing (test-impact); a small dogfood set with leakage assertions.
- Ablation runner: same agent + model, context on/off, isolated worktrees.
- Safety-track cases wired to the real policy/sandbox engine.
- Targets: `keryx-context-on`, `keryx-context-off`, `raw-model+basic-tools`.
- Models: one frontier + one local. 3 runs/stochastic task, 1 run/oracle.

**Exit**

- AC-1..AC-5, AC-7, AC-8 pass.
- Metastore IR metrics reproduce on pinned repos; ablation delta sign is stable
  across seeds; safety track scores escapes as hard fails and honest refusals as
  correct.
- An internal report renders the three ladders separately with reliability levels.

**Progress (2026-08-13, branch `fix/benchmark-remediation-v3`) — deterministic slice landed:**

- `paired-3-5-v2` protocol: types + backward-compatible validation, Wilson CIs,
  judge panel, `servedModel`/`effort`, tokenizer-normalized cost — `src/metrics/benchmark.ts`.
- IR/oracle primitives (precision/recall/f1/ndcg/recall@k/fact-preservation) —
  `src/metrics/ir.ts`.
- Gold-label derivation + a **real** express fixture (git co-change, pinned commit
  `a3714473`) — `src/metrics/gold.ts`, `scripts/benchmark/generate-express-gold.ts`,
  `fixtures/benchmark/express/`.
- Metastore oracle runner + `keryx metrics benchmark run --ladder metastore` + a
  first real result — `src/metrics/oracle-runner.ts`,
  `scripts/benchmark/run-express-oracle.ts`.

First oracle result (gdgraph `affected` vs git-co-change gold, express, F1):
`lib/application.js` 0, `lib/express.js` 0, `lib/utils.js` 0.25 — reported honestly.

**Open finding (correction):** the gdgraph oracle compares a *dependency* affected-set
to a *co-change* gold — different notions, so a low F1 is expected and does not by
itself indict gdgraph. Before any M1 metastore claim, decide the gold semantics:
either (a) reframe the metric as "does the dependency graph predict real co-change",
or (b) add a dependency-derived gold (import/usage closure) alongside co-change and
report both.

**Remaining in M1:**

- Ablation runner (context on/off, ×3 seeds, success/token/tool-call deltas) — needs
  the model legs, deferred with live runs.
- Testing/TIA, memory, gdctx oracle layers; test-impact gold (needs an instrumented
  coverage run).
- Safety track + false-premise / bullshit-resistance case group.
- The gdgraph-oracle gold-semantics decision above.

## M2 — Comparative: one third-party agent harness

**Scope**

- Adapter interface + a `native-reviewed` adapter for one other agent harness,
  driven through its own idiomatic interface.
- Fairness protocol per target: same task, same model, same environment; parity
  review recorded.
- Comparative report cells across `{keryx-on, keryx-off, raw, <harness>}` at a fixed
  model.

**Exit**

- AC-6 passes; the harness adapter is `native-reviewed`, fairness `met`.
- A comparative section is produced with per-target adapter/fairness status; any
  `pending` cell is marked non-publishable.

## M3 — Comparative: context/RAG tool + model matrix expansion

**Scope**

- Adapter for one context/RAG/code-index tool for the Metastore comparison.
- Expand the model axis (add vendors) now that M1/M2 read cleanly.
- Optional: trace-replay regression fixtures for CI (detect keryx-vs-keryx
  regressions cheaply between versions).

**Exit**

- Comparative Metastore section with a reviewed RAG adapter and met fairness.
- Model matrix expanded without breaking the decision rule.
- CI replay fixtures catch an injected regression.

## Cross-cutting, every milestone

- Every run emits a reproducible evidence bundle (inputs, target, model, seed, cache
  state, transcript ref, grading, labels).
- The decision rule governs every claim; "no claim yet" is a valid, expected output.
- Cost is bounded by the per-run token cap; the model/target matrix expands only
  after the prior milestone reads cleanly.
