# T15 independent M01 routing review

- Reviewer: `review-logic`
- Scope: M01 only (`src/lib/routing-entrypoint.ts` and the dispatched init/update/rules/orient/catalog/test files)
- Base: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`
- Reviewed snapshot: `2026-09-06T11:26:13Z`
- Verdict: **PASS**
- Findings: **0 blocker, 0 major, 0 minor**

## Stage 1 — specification compliance

**PASS.** AC1 and AC2 are implemented in production code and exercised by credible lifecycle tests.

- `renderRoutingEntrypointPair` derives the compact `index.md` and full `routing.md` from the same immutable options object (`src/lib/templates.ts:427-435`).
- `writeRoutingEntrypointPair` is the single production publisher. It serializes publication with `.routing-entrypoint.lock`, writes the full router before the compact pointer, skips byte-identical files, uses atomic per-file replacement, and propagates non-ENOENT failures (`src/lib/routing-entrypoint.ts:11-40`).
- All four required lifecycle paths await that publisher with their current module flags, security flag, rule sources, and distilled-entrypoint state: init (`src/commands/init.ts:728-743`), update (`src/commands/update.ts:295-311`), rules distill (`src/commands/rules.ts:56-62`), and rules sync (`src/commands/rules.ts:74-90`, option assembly at `144-162`). A repository-wide routed search found no competing production writer for `routing.md` or the routing pair.
- The compact gate retains the actionable module pointers and routes everything else to `routing.md` (`src/lib/templates.ts:351-435`). Orient returns the compact gate verbatim when it is within the documented bound, keeping that pointer visible (`src/ctx/orient.ts:37-46`, `98-113`). The metaproject-router workflow and generated catalogue resolution order point to `.metaproject/routing.md` (`src/gdskills/catalog.ts:20-29`, `580-615`).
- The black-box lifecycle suite covers init→sync→sync, init→distill→distill→update→update, enabled/disabled module and security ownership, root user-marker preservation, orient/catalog consumers, rejected publication, and successful rerun (`src/commands/routing-entrypoint-lifecycle.test.ts:32-171`).

Focused verification:

```text
bun test src/commands/routing-entrypoint-lifecycle.test.ts src/lib/templates.test.ts src/commands/rules.test.ts src/commands/init.test.ts src/commands/update.test.ts src/ctx/orient.test.ts src/gdskills/agent-catalogue-xref.test.ts src/commands/skills-route.test.ts
57 pass, 0 fail, 416 expect() calls
gdctx capture: 2026-09-06T11-24-36-207Z_run
```

## Stage 2 — logic and edge cases

**PASS.** No reproducible blocker, major, or minor logic defect was found.

- Concurrent publishers cannot interleave the two files because the shared directory lock encloses both writes. An offline probe ran two publishers concurrently with opposing gdgraph/gdctx flags and verified that the final `index.md` and `routing.md` exactly matched one complete rendered pair (`{"coherent":true}`; gdctx capture `2026-09-06T11-25-12-192Z_run`).
- A failure at the first write is covered by the checked-in lifecycle test: the command rejects, releases the lock, and a clean rerun reconstructs both documents (`src/commands/routing-entrypoint-lifecycle.test.ts:127-171`).
- A separate offline probe forced failure at the second write by making `index.md` a directory. The helper rejected after the first atomic file write, then recovered both documents on rerun after the obstacle was removed (`{"rejected":true,"routingWrittenBeforeFailure":true,"retryRecovered":true}`; gdctx capture `2026-09-06T11-24-58-801Z_run`). This is a partial failed attempt, but never a false success, and matches AC2's observable/recoverable contract.
- All lifecycle callers `await` the shared publisher, so an I/O or lock error rejects the enclosing command instead of printing a success path. Atomic replacement prevents readers from observing partial bytes within either document.
- User-owned root entrypoint content remains under `syncAgentRules`/distillation ownership; the routing writer only touches `.metaproject/index.md`, `.metaproject/routing.md`, and its transient lock directory. The repeated lifecycle tests verify the user markers survive.

## Snapshot evidence

| File | SHA-256 |
|---|---|
| `src/lib/routing-entrypoint.ts` | `03427445eed43e45fe7562971ebd464b0bed48100b2c300fa49b26ebd8706dc8` |
| `src/lib/templates.ts` | `f8d6079f6df0411322332e67691956dc70eea159318830921286643a1234bcf1` |
| `src/commands/init.ts` | `4389ab07ac2e6aacb3c2f3948581660fcf538b9380aa4c0599b369fc7f8098fa` |
| `src/commands/update.ts` | `bee8312987b0f37d11d99c0cdd24f9651c1ded924a67814a36ea4eec6545ae18` |
| `src/commands/rules.ts` | `2cb165ee5f170830b825624081992478e2174d2b398edc60ca75a6a8a545f459` |
| `src/ctx/orient.ts` | `b67c757c99ac6fe92a3cebcbcc1d618c6786a080447d36bbdb3a664655f58e77` |
| `src/gdskills/catalog.ts` | `49958fb4844791abe974f5908093ab400ef7afded1e7fb473a3e5e3d54e08d3c` |
| `src/commands/routing-entrypoint-lifecycle.test.ts` | `f4f5759f0e818def06ac5544f872bdd7a562f3c807b876ff62bca128b1be9145` |

## T8 evidence correction

The requested correction was appended without removing the original evidence from `T8-change-report.md`. Its current SHA-256 is `d20f966e90cf530b68a5c70a10a3b2758901be9bc1e5c8c2450830738aacc02f`. The report now states that the observed health command's `PASS` did not enforce required ESLint because ESLint was recorded as skipped; it therefore makes no complete quality PASS claim. `keryx security check-output` passed with zero findings for the corrected report.

## Limits and routing audit

- No M10 code was reviewed.
- No global suite, real provider/model call, network access, source edit, git operation, or flow-state mutation was performed.
- `graph_used`: `keryx gdgraph context` and affected queries for the shared writer and lifecycle test. The graph reported 22 uncommitted code files, so it was used only for navigation; every conclusion was verified against the stable source snapshot.
- `wiki_used`: wiki index plus `components/src-lib.md`, `components/src-commands.md`, `components/src-ctx.md`, and `components/src-gdskills.md`.
- `ctx_used`: routed source search, bounded diff/status, focused tests, and both offline failure/concurrency probes; raw outputs were retained by gdctx.
- `raw_rg_used`: no.
