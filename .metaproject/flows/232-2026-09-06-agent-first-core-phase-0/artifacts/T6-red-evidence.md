# T6 M10 RED evidence

- Timestamp: `2026-09-06T10:52:25Z`
- Git HEAD: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`
- Agent budget test SHA-256: `3bc480596ba9e1edd37080d5c761ea6cf4b9553745b8ed3eb4c18723cba310ef`
- Stress report test SHA-256: `8b4d37036e73ae7f1f0030cbbcc05085e0312be8fdeee7e4a16da71636747910`
- Containment port test SHA-256: `ddac6138ae7e4c3cbc8a2ea04ca04c7f96d6b84d18596a6618603159320e244d`
- Scripts typecheck test SHA-256: `1af8fc2eb27c0a9cbe29a121cddf88c86897a282d61f4796f62cc34ee34932e3`

## Focused RED run

- Command: `bun test src/commands/agent-tool-call-budget.test.ts scripts/stress/keryx-shell-stress.test.ts scripts/benchmark/run-containment.test.ts scripts/typecheck.test.ts`
- Captured through: `keryx ctx run -- bun test src/commands/agent-tool-call-budget.test.ts scripts/stress/keryx-shell-stress.test.ts scripts/benchmark/run-containment.test.ts scripts/typecheck.test.ts`
- Exit code: `1`
- Result: `0 pass`, `7 fail`, `6 expect() calls`
- Duration reported by Bun: `300.00ms`
- Complete stdout/stderr: `.metaproject/data/gdctx/raw/2026-09-06T10-52-17-394Z_run.log`
- Compact report: `.metaproject/data/gdctx/artifacts/2026-09-06T10-52-17-394Z_run.md`

### Failure signatures

1. `runAgentTurn stops at maxToolCalls inside one provider round and reports a tool-call budget terminal reason`
   - Expected invocations: `["one", "two"]`; observed `["one", "two", "three"]`.
   - The local provider emits all three calls in one model round, so this directly proves `maxToolCalls` is ignored and cannot be emulated by a round cap.
2. `maxToolCalls counts actual invocations rather than relabeling maxRounds`
   - Expected `2` real invocations; observed `3` while `maxRounds: 1` and `maxToolCalls: 2` were both present.
3. `offline stress fixture writes JSON with the configured maxRounds resolver value`
   - Child exit code expected `0`; observed `1` with `ReferenceError: resolveAgentMaxToolCalls is not defined` at `keryx-shell-stress.ts:1029`.
   - The subprocess selected no suite, used a temporary output directory, and made no provider/model call.
4. `containment accepts the concrete port returned by the bound local listener`
   - Expected a pure port validation seam; current export is `undefined`.
5. `containment refuses an absent listener port instead of choosing an unsafe default`
   - Expected an explicit throw for `undefined`; the validation seam does not exist.
6. `the scripts TypeScript target covers benchmark and stress entrypoints and is currently clean`
   - `tsconfig.scripts.json` does not exist.
7. `the scripts TypeScript target fails on an injected strict type error`
   - Guarded RED for the same missing real config, preventing a false pass from TypeScript reporting both a missing base config and the synthetic `TS2322`.

## Root TypeScript check

- Command: `bun run typecheck`
- Exit code: `0`
- Complete stdout/stderr: `.metaproject/data/gdctx/raw/2026-09-06T10-52-12-856Z_run.log`
- Compact report: `.metaproject/data/gdctx/artifacts/2026-09-06T10-52-12-856Z_run.md`

The RED tests themselves preserve the existing root `src/**/*.ts` typecheck.

## Full benchmark/stress TypeScript baseline

- Command: `./node_modules/.bin/tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck --types bun-types scripts/benchmark/*.ts scripts/stress/*.ts scripts/typecheck.test.ts`
- Captured through `keryx ctx run`.
- Exit code: `2`
- Diagnostics: `13`
- Complete stdout/stderr: `.metaproject/data/gdctx/raw/2026-09-06T10-55-27-770Z_run.log`
- Compact report: `.metaproject/data/gdctx/artifacts/2026-09-06T10-55-27-770Z_run.md`

| Diagnostic | Files | Bounded correction |
|---|---|---|
| `TS2353` unknown `AgentDeps.maxToolCalls` (5) | `run-ablation-mutating.ts`, `run-ablation-raw.ts`, `run-ablation.ts`, `run-containment.ts`, `run-safety.ts` | Add a real optional `maxToolCalls` port to `AgentDeps`, count granted actual invocations across and within batches, stop at the cap, and return `finishReason: "tool-call-budget"`; retain independent `maxRounds`. |
| `TS2379` optional `cwd` passed explicitly as `undefined` (5) | `generate-express-deps-gold.ts`, `run-express-oracle.ts`, `run-gdctx-oracle.ts`, `run-memory-oracle.ts`, `run-testing-oracle.ts` | Build `Bun.spawnSync` options with conditional spread so `cwd` is omitted when absent. |
| `TS2345` optional containment listener port (1) | `run-containment.ts:419` | Narrow once through `resolveContainmentPort`; return the concrete port, throw if absent/invalid, and never substitute `0`, a conventional port, or another unsafe fallback. |
| `TS1375` top-level await in a script with no module marker (1) | `concurrent-suite-stress.ts:207` | Make the file a module and guard execution with `if (import.meta.main)` so typechecking/importing cannot accidentally run the stress suite. |
| `TS2304` nonexistent `resolveAgentMaxToolCalls` (1) | `keryx-shell-stress.ts:1029` | Serialize `maxRounds: resolveAgentMaxRounds()` in the offline report; this is the resolver the script already imports and logs. |

Add `tsconfig.scripts.json` with strict options equivalent to the root config and coverage for `scripts/benchmark/**/*.ts` and `scripts/stress/**/*.ts`. The focused test resolves representative entrypoints through TypeScript's config parser, runs the target, and then extends the same target with a temporary `TS2322` probe to prove the gate fails when scripts regress.

## Required test seam

`scripts/benchmark/run-containment.ts` already protects `main()` with `import.meta.main`, so its pure port validator can be imported without executing a benchmark. Export a narrow `resolveContainmentPort(port: number | undefined): number` function from that entrypoint. The tests require only behavior: preserve a real bound port and throw on absence. They do not prescribe the rest of the containment runner layout or any provider/worktree implementation.

## Safety and routing audit

- `graph_used`: `keryx gdgraph context`; affected context for `src/commands/agent.ts`, `scripts/benchmark/run-ablation.ts`, and `scripts/benchmark/run-containment.ts`.
- `wiki_used`: `.metaproject/wiki/index.md`, `components/src-lib.md`, and `components/scripts-benchmark.md`; treated as navigation only because freshness reported unresolved edges and the flow context warned of older prose.
- `ctx_used`: `keryx ctx rg`, `keryx ctx read`, `keryx ctx run`, and `keryx ctx diff`; exact source was checked after compact navigation.
- `memory_used`: accepted search for agent/benchmark/budget/scripts typecheck; no relevant accepted result.
- `testing_used`: testing skill, context, related-test queries, and latest normalized report before focused execution.
- `raw_rg_used`: no.
