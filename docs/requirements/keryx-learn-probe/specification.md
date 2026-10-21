# Learn Probe Specification
Version: 0.2.1

## 1. Identity and status

| Field | Value |
|---|---|
| Package | `keryx-learn-probe` |
| Command | `keryx learn probe <id>` |
| Parent | `keryx learn`, W3 self-learning, `src/learning/` |
| Status | spec ready; runtime not implemented; not frozen |
| Runtime | TypeScript/Bun (planned) |

Probe measures one task with and without a pattern. It may append evidence and
change confidence, but never changes status or writes an instruction. All new
paths, flags, schemas and lifecycle behavior here are planned, not runtime claims.

## 2. Module placement and dependency boundary

| Planned path | Zone | Responsibility |
|---|---|---|
| `src/learning/probe.ts` | core | plan, checkpoints, evidence reconciliation, retention |
| `src/learning/probe-score.ts` | core | pure counts/statistics/verdict |
| `src/harness/probe/runner.ts` | client | worktrees, gold preparation, arm turns |
| `src/commands/learn-probe.ts` | adapter | flags, consent/budget, orchestration, output |

`src/commands/learn.ts` delegates ONLY the probe subcommand to the new adapter
(lazy dispatch). Accept/apply/promote/graduate modules acquire no probe import,
condition or behavior. Their suites must pass with the probe adapter unavailable.
The existing `src/lib/import-zones.ts` classifies top-level segments; nested
paths inherit core/client/adapter zones, requiring no new top-level zone entry.
Core never imports client/adapter; client may import core, adapter may import both.
No probe path imports an instruction/agent/rule/memory writer.

## 3. Storage, identity and locking

```text
.metaproject/data/learning/
  candidates/<id>.json               existing record store
  observations/<date>.jsonl          existing observations
  probes/tasks.json                 optional default task set
  probes/<pattern-id>/<probe-id>/
    plan.json                       immutable intent and text/status snapshot
    checkpoint.json                 mutable durable seed/spend/finalization state
    comparison.json                 immutable published measurement
    runs/base/<seed>.ndjson
    runs/probe/<seed>.ndjson
```

Use `learningDataDir()` and `assertInsideLearningRoot()` in `src/learning/paths.ts`.
All writes are contained and atomic. `keryx init` must ignore the probes data root
in its managed block in `<git-common-dir>/info/exclude`. Preserve the existing
init/update contract: tracked `.gitignore` is never changed. Add a probe-root
guard test (planned capability, not current passing evidence).

`patternDigest` = full lowercase SHA-256 of UTF-8 `JSON.stringify([trigger, action])`
without Unicode normalization. `taskSetDigest` hashes exact task-set file bytes.
The full `identityDigest` is SHA-256 of these eight UTF-8 strings joined by NUL:
`patternId, patternDigest, taskId, model, provider, commit, taskSetDigest, runs`.
`runs` is its base-10 integer spelling; NUL is prohibited in all string inputs.
`commit` is the full resolved object id, not a moving ref. `probeId` is the first
12 lowercase hex characters. Keep the full hash and compare it before reuse:
48-bit directory names have a birthday bound near 2^24 probes, not uniqueness.
A short-path collision is probe-environment-mismatch, never an overwrite.

Plan pins the original eligible status, trigger/action and digest. A changed text
creates a new identity rather than reusing stale seeds. Within an existing
identity, compare immutable environment, snapshot, request (including budget),
full hash and plan linkage before any write/model call. Mismatch or corrupt state
is probe-environment-mismatch, exit 2 unchanged. Baseline changes refuse resume,
even though the directory hash does not include baselineDigest. Environment
contains model/provider, resolved commit, baseRef, taskSetDigest, baselineDigest.
The latter hashes UTF-8 JSON serialization of an array containing the exact
baseline prompt, ordered tool definitions/retrieval configuration and scorer
version, so changed tools/scoring cannot silently reuse results.

A per-probe exclusion lock serializes all invocations, including resume/scoring.
Use lock order probe then existing scope/store lock, never reacquire a
non-reentrant scope lock through updatePattern. The immediate pre-publication
snapshot check and atomic comparison publication share a scope-lock critical
section with record writers. A new contained lock-aware integration is needed;
today's updatePattern alone does not transact across record and comparison files.
Retention skips locked or unfinalized probes.

For recovery of an existing published comparison, do not create a fresh identity
or reject merely because current record status changed: locate its pending plan
by matching the original invocation environment/request, then finalize it with
that immutable snapshot. If multiple pending plans match after a text change,
refuse probe-environment-mismatch rather than choosing one. Without a published
comparison, changed snapshot refuses resume; a genuinely new measurement uses
its own identity. Finalized identities always refuse already-completed, including
skipped evidence. Recovery does not rewrite plan or comparison.

## 4. Configuration

Optional extension of `.metaproject/learning.config.json`:

```json
{
  "schemaVersion": 1,
  "capabilities": { "modelExtractor": false },
  "probe": {
    "defaultTaskSet": ".metaproject/data/learning/probes/tasks.json",
    "maxUsdPerProbe": 5,
    "retainRunsPerPattern": 20
  }
}
```

Defaults: defaultTaskSet as above, retainRunsPerPattern 20, maxUsdPerProbe unset.
The config ceiling never supplies the required explicit CLI budget. If estimate
exceeds configured maxUsdPerProbe, refuse probe-over-budget before writes.
Malformed probe blocks are ignored as a whole; validating new keys is new work,
not an assertion that today's loader already accepts them. Config ceilings, if
present, must be finite positive; retention must be a nonnegative integer.
Absent/unreadable/unparseable/schema-invalid task-set files and duplicate task
IDs are probe-bad-task-set. A missing ID in a valid set is instead no-task.

Pricing comes from `loadModelProfiles()[profileKey(provider, model)]` in
`src/harness/routing/model-profile.ts`: priceInputPerMillion/priceOutputPerMillion
have numeric value or the explicit string unknown. Estimate
`2 * runs * (estimatedInput * priceIn + estimatedOutput * priceOut) / 1e6`,
using observed per-turn median input/output usage when available; otherwise
unknown/null. See metrics-and-validation.md, Cost accounting. The adapter
supplies pricing to core (no core-to-harness/TUI import). `estimateTaskCostUsd`
in tui-shell.ts is an actual usage/cache-accounting reference, not a dependency.

## 5. CLI and output contract

```text
keryx learn probe <id> --task <task-id> [options]
  --task <task-id>       required; valid ID not found -> unmeasurable/no-task
  --task-set <path>      default from config or probes/tasks.json
  --runs <n>             integer >=1, default 3 seeds per arm
  --model <id>           same model for both arms; current session default
  --provider <name>      same provider for both arms; configured default
  --max-usd <n>          finite positive whole-probe budget, required for real run
  --dry-run              TTY-free; plan/estimate only, zero writes/model calls
  --json                 one machine-readable JSON value on stdout
```

Real runs require a real interactive terminal and typing the pattern ID after
reading the plan (task, arms, seeds, model, provider, estimate, ceiling). No yes,
force, agent-native tool or noninteractive bypass. Dry-run is the sole TTY-free
path and may show maxUsd null when unspecified; a supplied invalid budget is
still refused. Real finalization recovery also requires terminal approval/budget,
but never spends again. New runs require a project candidate/accepted record;
user scope is refused. Recovery eligibility is governed by §6.6, not a new-run
gate that would strand a rejected record's published comparison.

Before writes validate arguments, budget, task set, status/scope, existing state,
TTY and configured estimate ceiling. Refusals exit 2, write nothing (including no
new directory), and use exactly these names:

| Refusal | Condition |
|---|---|
| probe-invalid-arguments | missing task flag/ID, invalid ID, noninteger or <1 runs, invalid other values |
| probe-no-budget | real budget absent, or supplied zero/negative/NaN/infinite budget |
| probe-bad-task-set | missing/unreadable/invalid file, unsafe paths, duplicate task IDs |
| probe-no-tty | real invocation lacks interactive terminal |
| probe-over-budget | estimate exceeds configured ceiling |
| probe-ineligible-status | new run record rejected/expired/superseded |
| probe-user-scope-unsupported | user-scope probing in v1 |
| probe-environment-mismatch | incompatible/corrupt resume state or hash collision |
| probe-already-completed | requested identity has finalized checkpoint |

Missing task ID *in a valid task set* writes no-task comparison, not a refusal.
Spend is cumulative across invocations, with durable reservations before calls.
Crossing ceiling stops remaining seeds and produces budget-exceeded, never an
inconclusive measured verdict. Unknown pricing is not permission for unbounded
calls: use a conservative reservation or stop, never bypass the ceiling.

Exit 0: finalized improved/regressed/indistinguishable. Exit 3: unmeasurable OR
the invocation recording post-publication skipped/environment-drift. Exit 2:
refusal/no writes. Operational persistence errors exit 1 and leave recoverable
state; do not pretend they are successful finalization. Graceful interrupt writes
run-failed when possible and cleans worktrees; power loss recovery is §6.5.

With --json, stdout contains exactly one of these envelopes, no human text:

```text
{ "schemaVersion": 1, "comparison": <comparison>, "finalization": <checkpoint.finalization> }
{ "schemaVersion": 1, "dryRun": true, "plan": <plan> }
{ "schemaVersion": 1, "refusal": "<named reason>" }
```

Operational errors are diagnosed on stderr (no success envelope). Human plan,
confirmation and diagnostic paths go to stderr/TTY. Without --json, show BOTH
measurement verdict and evidence outcome, so immutable improved plus skipped is
not misrepresented as new confidence. The envelope is an output shape, not a
fifth persistent schema; validate its nested documents and exact keys in tests.

## 6. Data contracts

### 6.1 Task set

[schema](schemas/probe-task-set.schema.json), [example](examples/task-set.json).
Each unique task has id, deterministic/stochastic kind, prompt, expect file/symbol,
and goldArtifacts. Scoring compares normalized final answer file/symbol as the
ablation scorer does; no LLM judge. Relative paths must be nonempty, within the
repository, without absolute paths, backslashes or `..` segments. Semantic
validation rejects duplicate IDs and validates path containment before writes.

Before ANY seed, verify every gold artifact exists in the resolved base commit,
then remove from BOTH worktrees and verify removal with checkGoldLeakage.
A missing base path or surviving removal is unmeasurable/gold-leak, null arms,
null delta and runs=[] (AC8, §7). Explicit base-ref existence checking is new work:
checkGoldLeakage alone is insufficient. Diagnose missing-in-base versus
survived-removal and paths on stderr, NOT a fictional reachablePaths property.
Both arms use read-only context-on tooling: filesystem reads plus search_code,
graph_affected, memory_search, following buildTools(root, "context-on") in
scripts/benchmark/run-ablation.ts. No write tool can restore a removed path.
No runtime import of producer-side scripts/benchmark/ablation-tasks.ts; a task
export converter is optional future script work.

### 6.2 Comparison

[schema](schemas/probe-comparison.schema.json). schemaVersion 1;
probeId, full identityDigest, patternDigest, patternId, taskId, createdAt, resumed,
environment, arms, delta, verdict, optional reason and actual runs.
Measured arms carry seeds/successes/rate/Wilson CI and optional usage totals;
delta carries rate/Newcombe CI and optional usage deltas. Every unmeasurable has
arms={base:null,probe:null}, delta=null; pre-run no-task/underpowered/gold-leak
have runs=[]. Partial failures retain actual runs/transcripts, never partial
rates. Runs name arm/seed, answered/success booleans and safe relative transcript
path. Semantic checks enforce unique arm/seed pairs, seed bounds, success implies
answered, complete paired counts for measured verdicts and aggregate consistency.

### 6.3 Evidence extension and unchanged apply

Four enforcement sites gain sourceType probe together: src/learning/types.ts
EvidenceSourceType, src/learning/schema.ts EVIDENCE_SOURCE_TYPES, shipped
src/learning/learned-pattern.schema.json and documented
`docs/requirements/keryx-agent-platform-expansion/schemas/learned-pattern.schema.json`.
Type-only addition would fail runtime validation. No change to confidence constants.

src/learning/apply.ts is NOT a fifth enforcement site: EVIDENCE_TO_SOURCE_TYPE is
Partial; sourceTypeFor skips unmapped evidence then uses existing domain fallback.
Keep that map, fallback and gdskills LearningSourceType/proposal vocabulary
unchanged. Appending probe evidence must not change proposal sourceType or sections.

| Verdict, matching snapshot at finalization | kind | weight | append |
|---|---|---|---|
| improved | reinforcement | 1.0 | once |
| regressed | contradiction | 1.5 | once |
| indistinguishable/unmeasurable | none | none | none |

sourceRef is the repository-relative path to this immutable comparison;
observedAt equals comparison.createdAt, sourceType is probe. Dedup key is
(sourceType, sourceRef). Compute confidence from CURRENT locked record with
applyEvidence; MAX_EVIDENCE_WEIGHT=1.5 and existing asymmetry are unchanged.

### 6.4 Pattern injection

Both arms share the exact context-on baseline prompt, harness envelope, ordered
tool definitions/retrieval configuration and scorer pinned by baselineDigest.
Append to probe system instructions only:

```text
<learned-pattern id="<pattern-id>">
When <snapshot.trigger>, <snapshot.action>.
</learned-pattern>
```

Base uses an empty block. Assert the sole prompt diff is this block, not a
context-off versus context-on difference. Validate snapshot text (8–400 chars)
before worktrees. Never write AGENTS.md, skills or rules. Worktrees start from
the same resolved commit and apply identical gold removal.

### 6.5 Immutable plan and mutable checkpoint

[plan schema](schemas/probe-plan.schema.json),
[checkpoint schema](schemas/probe-checkpoint.schema.json),
[bundle example](examples/artifact-bundle.json),
[local checks](examples/README.md).

Plan includes IDs/hashes, original eligible status/text snapshot, environment,
request runs/maxUsd and nullable estimateUsd, createdAt. Null maxUsd is allowed
only for printed dry-run plans; a persisted real plan always has positive budget.
Persist it once before seeds. Checkpoint pins SHA-256 of exact plan bytes, phase,
spendUsd/reservedUsd, seed entries and nullable finalization. Each seed also pins
planDigest, arm/index, transcript, state, answered/success and chargedUsd.
Before a model call atomically persist running plus a finite reservation bounded
by remaining ceiling; usage and completion/failure are durably checkpointed.
spendUsd includes settled/conservatively charged calls; reservedUsd covers
outstanding calls, never resets on resume. Actual provider overrun still stops
remaining seeds; a reservation is not a promise of zero possible overrun.

Reuse only completed entries with matching planDigest and complete transcripts;
never infer success/completion from torn NDJSON. Interrupted running entries have
unknown completion: charge their persisted reservation conservatively, mark
failed and finalize run-failed (budget-exceeded takes precedence if exceeded).
Do not blindly replay an in-flight paid call. Crash before checkpoint creation
can reconstruct empty state from an intact plan. Graceful SIGINT/SIGTERM tries
cleanup plus run-failed; SIGKILL/power loss cannot execute handlers, so recovery
reconciles owned stale worktrees before any new ones. Signal/resume plumbing is
new work, not a capability inherited automatically from the ablation script.

### 6.6 Recoverable exactly-once finalization and drift cut-off

1. Under probe lock score durable checkpoints. Immediately before publication,
   under scope lock reread record and compare status/text to immutable snapshot.
   Drift => unmeasurable/environment-drift, null arms/delta, actual runs, no
   evidence. Atomically publish comparison while the same scope lock is held.
   Publication is the cut-off: never rewrite comparison afterward.
2. Set checkpoint phase finalizing. If comparison exists after a crash, resume
   from its exact bytes (even if checkpoint phase is stale): no model calls,
   no rescoring, no comparison rewrite. Validate plan/comparison linkage first.
3. For improved/regressed, locked updatePattern FIRST checks existing evidence
   sourceType=probe/sourceRef=this comparison. A matching receipt means record
   commit already succeeded: recover applied without applying confidence twice,
   even if a later writer changed text/status. Never roll back historical evidence.
4. Without receipt, compare CURRENT text/status to snapshot under the lock. If
   drifted AFTER publication: leave record/confidence unchanged and checkpoint
   finalization={evidence:skipped,reason:environment-drift}. Keep measured verdict
   byte-identical; CLI reports separate finalization outcome and exits 3 for the
   invocation recording skip. Otherwise append once, compute confidence/level
   from locked current record and preserve concurrent unrelated evidence.
5. Indistinguishable/unmeasurable use finalization={evidence:not-needed}, no
   record write. Persist finalization marker with phase finalized only after
   required record commit succeeds. Failure is pending recovery, never success.
   Crash after comparison/before record resumes step 3; after record/before
   marker dedup recovers applied. Two invocations serialize to at most one append.
   Crash after marker => already-completed exit 2, no writes, including skipped.

## 7. Statistics and verdict precedence

Per seed success means expected file AND symbol in the normalized final answer.
Per-arm successes/seeds and 95% Wilson interval reuse wilsonInterval from
src/metrics/benchmark.ts. Use Newcombe hybrid-score interval for difference of
independent proportions; conservative for paired-by-seed construction. Pure
probe-score counts-in/numbers-out; tokens/tools reported, never verdict criteria.

Order (the six unmeasurable reasons are a closed enum):
1. Valid task-set lacks task ID -> no-task, no seeds.
2. Fewer than 3 seeds for stochastic or 1 for deterministic -> underpowered.
3. Missing gold in base commit or removal failure -> gold-leak, before all seeds.
4. Missing/mismatched arm environment or pre-publication text/status drift -> environment-drift.
5. Spend exceeded ceiling -> budget-exceeded (including truncated remaining seeds).
6. Any failed/unrecoverable running seed or no answer -> run-failed; one failed
   seed suffices, even if others succeeded. Preserve actual runs, null rates.
7. Delta CI entirely >0 -> improved; entirely <0 -> regressed; else indistinguishable.

## 8. Integration points

| Existing surface | Planned use/new obligation |
|---|---|
| learning/store.ts | readPattern, locked snapshot publication integration, updatePattern dedup; no nested lock |
| learning/confidence.ts | applyEvidence unchanged, locked current confidence |
| learning/scan.ts | record text already scanned at creation; probe adds no free text to record |
| metrics/benchmark.ts | wilsonInterval; validatePairedBenchmark only if later exported |
| metrics/ablation-runner.ts | reference scoring shape, NOT imported variant-comparison producer |
| harness/child/git-worktree-port.ts | create/remove isolated worktrees |
| commands/agent.ts runAgentTurn | headless arm execution; new signal/checkpoint integration |
| metrics/leakage.ts | removal verification PLUS explicit new base-commit existence check |
| learning/prune.ts | new transcript pass, existing two passes unchanged |
| commands/learn.ts | probe-only lazy dispatch, decision behavior unchanged |

## 9. Acceptance criteria (planned fixture tests, not live-model gates)

- **AC1** Help lists every §5 flag, exit 0.
- **AC2** TTY-free dry-run prints plan/estimate, zero writes/worktrees/model calls.
- **AC3** Absent real budget and supplied zero/negative/NaN/infinite budget refuse
  probe-no-budget; estimate above configured ceiling refuses probe-over-budget;
  all exit 2/no writes, distinct from mid-run budget-exceeded.
- **AC4** Real invocation without terminal refuses probe-no-tty exit 2/no writes.
- **AC5** Completed run writes schema-valid plan/checkpoint/comparison at §3 paths;
  worktrees removed. Persisted plan has positive budget.
- **AC6** Improved with matching snapshot appends one reinforcement/probe/1.0;
  confidence=applyEvidence(lockedCurrent,reinforcement,1.0), record validator passes.
- **AC7** Regressed with matching snapshot appends one contradiction/1.5;
  indistinguishable/unmeasurable append none and leave confidence untouched.
- **AC8** Missing base gold OR surviving removal in either arm -> gold-leak exit 3,
  null arms/delta, runs=[], no evidence. Path diagnostics only on stderr.
- **AC9** Probe never changes status, trigger/action or other record fields except
  evidence/confidence/confidenceLevel/updatedAt; unrelated concurrent writes survive.
- **AC10** Matching checkpoint reuses completed seeds. Pending comparison resumes
  finalization only; published comparison remains byte-identical under every verdict.
  Finalized rerun refuses already-completed exit 2/no writes, including skips.
- **AC11** Import graph has no path to instruction/rule/agent/memory writers.
- **AC12** Router-only probe dispatch permitted; accept/apply/promote/graduate have
  no probe dependency and suites pass without probe adapter. Apply Partial map/
  domain fallback unchanged; probe evidence never changes proposal sourceType/sections.
- **AC13** Identical pinned context-on environment/worktrees/tools/baseline;
  sole system-instruction difference is snapshot pattern block.
- **AC14** Stochastic runs=2 -> underpowered, never indistinguishable;
  deterministic runs=1 allowed.
- **AC15** Table fixtures cover all four verdicts, six reasons and §7 precedence,
  including simultaneous budget exhaustion and remaining-seed failure.
- **AC16** Thrown turn and graceful SIGINT leave zero owned worktrees and run-failed
  comparison when persistence succeeds; uncatchable death reconciles on resume.
- **AC17** Retention cap=2/three finalized probes deletes oldest runs only;
  plan/checkpoint/comparison stay. Locked/unfinalized probes are never pruned.
- **AC18** Resume environment/request/snapshot/digest mismatch or corrupt state ->
  probe-environment-mismatch exit 2/no writes, no mixed seeds or silent restart.
- **AC19** Missing/invalid task-set -> probe-bad-task-set; bad runs/missing task flag/
  invalid arguments -> probe-invalid-arguments; exit 2/no writes. Missing task ID
  inside valid set produces no-task instead.
- **AC20** Changed trigger/action changes identity; full-hash short-path collisions
  refuse. Snapshot/environment/baseline/plan/checkpoint links are checked.
- **AC21** Crash injection at every plan/checkpoint/comparison/record/marker write
  and concurrent invocations prove one append/confidence application; record
  receipt dedup occurs before post-publication drift checks. No comparison rewrite.
- **AC22** Before-publication drift -> unmeasurable/environment-drift; after it,
  skip uncommitted evidence, confidence unchanged, record skipped/environment-drift,
  report separate finalization exit 3; finalized skip rerun exit 2/no writes.
- **AC23** All unmeasurable have null arms/delta; partial runs retained. Durable
  spend/reservations survive resume, completed calls reused, unknown running calls
  not replayed. No retention of unfinished probes is lost.
- **AC24** Capture normal/dry-run/refusal/recovery/skip streams: --json stdout is
  exactly one §5 envelope; confirmation/plan/diagnostics never contaminate it.

## 10. Preparation assumptions and open verification

Operator cut-off decision resolved the immutable-comparison/drift conflict.
No unresolved product choice is delegated to implementation here. Lock-aware
publication, usage reservations, signal/resume and four-type enforcement edits
are NEW implementation work. Refresh graph impact and health before runtime
acceptance: baseline graph reports moved repo/new paths; health last ran
2026-09-09. Documentation validation does not prove those runtime guarantees.
