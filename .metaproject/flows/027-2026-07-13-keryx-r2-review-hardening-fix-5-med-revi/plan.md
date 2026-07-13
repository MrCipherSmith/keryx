# Implementation Plan — Flow 027 (R2 review hardening)

Status: frozen scope (5 MED findings only)

## Approach

Fix the five MED review findings across `select.ts`, `process/{executor,real-process-adapter}.ts`,
`extension/execute.ts`, and `process/executor.test.ts`, test-first, reusing existing primitives
(W15 egress guard, W7/W8 receipt/evidence). Deterministic/offline; deps `{}`; fail-closed posture
preserved and adversarially re-verified.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Reviewer |
|---|---|---|---|---|
| T5 (RED) | test | tests-creator | **Sonnet** | security/logic |
| T6 (impl) | implement | task-implementer | **Opus 4.8** | security/logic |
| T7 (review) | review | review-orchestrator | **Opus 4.8** | security |
| T2/T3/T4 | umbrella | orchestrator | Opus | — |

Orchestrator = Opus. Workers via subagent-dispatch → subagent-result, worktree-guard
(`cd /Users/Goodea/goodea/keryx`, branch `feature/keryx-r2-review-hardening`).

## Steps

1. T1: scope from the review (description.md).
2. T5 (RED): tests for the 5 fixes (offline, injected id/clock + fakes):
   - #1 select.ts SSRF: a private/metadata `--base-url` host → ollama OMITTED from detection AND
     the guarded fetch NOT issued to it (spy/injected fetch asserts 0 calls to a private host);
     loopback (`localhost`/127.0.0.1) still probed and allowed.
   - #2 executor: a clean-exit observation carrying `exitCode` (0 and non-zero) → `{kind:"completed"}`
     with `exitCode` SURFACED on the outcome (assert the exact value); bound-hits unchanged.
   - #3 real-adapter PURE classifier: a synthetic spawnSync-like result with `error.code==="ETIMEDOUT"`
     OR (`signal==="SIGKILL"` + deadline hit) → `deadline-exceeded`; `signal==="SIGSEGV"`/other →
     a distinct crash/spawn-error observation (NOT `deadline-exceeded`); clean → clean-exit. Import
     ONLY the pure exported classifier (no adapter construction, no spawn).
   - #4 executor branches: (a) a CLEAN observation + `input.cancelled===true` → `{kind:"cancelled"}`
     (asserts the cancel-override; deleting `|| input.cancelled` would fail this); (b) a clean
     observation with `outputBytes > outputLimitBytes` → `{kind:"output-overflow"}` (asserts the
     executor's finer-limit reclassification; deleting that branch would fail this).
   - #5 dispatchExtension: existing execute.test.ts stays green after the `buildExt` refactor (no new
     behavior); optionally assert dispatch vs result differ ONLY in canonicalContract.
   RED before T6.
3. T6 (GREEN): implement the 5 fixes + the 2 folded doc/comment corrections. Reuse-only. Make T5 green.
4. T7 (review, security): re-verify fail-closed (SSRF now closed, no new fail-open; #2 keeps bound-hits
   non-success; #3 never a false `completed`/`deadline`; adapter still gated/not-in-CI); no regression
   (tsc + full suite ≥ baseline); reuse-only (guard/receipt/evidence/planWaves unmodified or additive);
   deps `{}`; D-02; secrets never logged; determinism; frozen untouched.
5. `keryx health run`; confirm ACs; completion (option B) + PR (no co-authorship).

## Verification

Gate: `tsc` clean; full `bun test` ≥ 1306 pass / 2 skip + new green; select detection is egress-guarded
(private/metadata host fail-soft, no unguarded fetch; loopback allowed); executor `completed` surfaces
`exitCode`; the real adapter labels only a genuine deadline as `deadline-exceeded`; the two executor
branches are pinned; dispatchExtension dedup with no behavior change; deterministic; no real spawn in CI;
no new dependency; D-02; secrets safe; frozen surface untouched.

## Risks

- **#1 over-blocking loopback** → reuse the EXACT `OllamaProvider` gate (loopback allowed via opt-in,
  metadata always denied); T5 asserts localhost still probed.
- **#2 breaking the bound-hit contract** → only the `completed` variant gains `exitCode`; timeout/
  overflow/cancel/blocked unchanged; T5/T7 re-assert bound-hits are non-success.
- **#3 pure-classifier import loading the real adapter offline** → export a PURE function with NO
  import-time side effect (spawn only inside the method / behind the gate); T7 confirms no spawn at
  import and the adapter constructor stays gated.
- **#4 tautological tests** → each new case must FAIL if its branch is deleted (mutation check).
- **#5 behavior drift in the refactor** → `buildExt` closes over the identical shared input; existing
  execute.test.ts round-trip/transport-parity tests must stay green unchanged.
- **Rewriting reused primitives / new dep / non-determinism / flow.json write** → reuse-only; deps `{}`;
  injected id/clock; no fs; T7 greps.
- **Wrong-worktree / index-guard** → guard directives in every dispatch.
