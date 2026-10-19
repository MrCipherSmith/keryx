# Learn Probe Specification
Version: 0.1.1

## 1. Identity

| Field | Value |
|---|---|
| Package | `keryx-learn-probe` |
| Command | `keryx learn probe <id>` |
| Parent surface | `keryx learn` (W3 self-learning loop, `src/learning/`) |
| Status | spec ready; runtime not implemented |
| Language | TypeScript, Bun runtime, same as the rest of `src/` |

Probe is a **measurement**, not a mutation. It reads one learned pattern, runs a
task twice, writes one comparison artifact, and may append one evidence item to
that pattern. It never changes `status` and never writes an instruction
(PRD R7).

## 2. Module placement

The import-zone table (`src/lib/import-zones.ts`) decides the placement: a core
segment may never import `src/harness` (client) or `src/commands` (adapter), and
the probe needs both the learning store (core) and the turn loop (client).

| Path | Zone | Owns |
|---|---|---|
| `src/learning/probe.ts` | core | plan construction from a record + task set, evidence mapping, record update, transcript retention (`retainRunsPerPattern`, called from `keryx learn prune`) |
| `src/learning/probe-score.ts` | core | pure statistics and verdict resolution over raw per-seed samples |
| `src/harness/probe/runner.ts` | client | worktree lifecycle, gold-artifact removal, one arm's agent turn |
| `src/commands/learn-probe.ts` | adapter | CLI flags, terminal and budget gate, orchestration, output |

`src/commands/learn.ts` gains one `probe` subcommand that delegates to
`src/commands/learn-probe.ts`; no probe logic lives in the existing file.

The zone table needs no new entry: `ZONE_TABLE` (`src/lib/import-zones.ts`)
classifies top-level segments under `src/` only, so `src/harness/probe/` inherits
`harness` = client and `src/commands/learn-probe.ts` inherits `commands` =
adapter by nesting. `src/lib/import-policy.ts` already enforces that direction —
the new client code may import core, the new adapter code may import both — and
`unclassifiedSegments()` stays empty because no new top-level segment appears.

## 3. Storage structure

```
.metaproject/data/learning/
  candidates/<id>.json                        existing (unchanged)
  observations/<date>.jsonl                   existing (unchanged)
  probes/
    tasks.json                                optional default task set
    <pattern-id>/
      <probe-id>/
        plan.json                             what was about to run
        comparison.json                       the scored result (data contract 6.2)
        runs/
          base/<seed>.ndjson                  one transcript per seed
          probe/<seed>.ndjson
```

`probe-id` is
`sha256(patternId + "\0" + taskId + "\0" + model + "\0" + provider + "\0" + commit + "\0" + taskSetDigest + "\0" + runs)`
truncated to 12 hex characters. Every input that changes the measurement is part
of the identity, so a re-run with a different model, provider, commit, task set
or seed count lands in a different directory instead of silently resuming
someone else's numbers. A re-run with the identical identity resumes the
existing directory; if its `comparison.json` is already complete, the command
refuses with `probe-already-completed` (exit 2) and writes nothing.

The same rule applies to a partially completed directory: the recorded
`environment` and `runs` request are compared with the new ones before any arm
starts, and a mismatch is refused rather than merged.

Root resolution reuses `learningDataDir()` (`src/learning/paths.ts`) — the probes
root is a sibling of `observations/` and `candidates/`, not a new top-level
store. Every write goes through `assertInsideLearningRoot()`.

## 4. Configuration

Probe needs no config file to exist. Three optional keys extend
`.metaproject/learning.config.json` (`src/learning/config.ts`). Example of a
fully populated block:

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

Defaults when the file or the `probe` block is absent:

| Key | Default |
|---|---|
| `defaultTaskSet` | `.metaproject/data/learning/probes/tasks.json` |
| `retainRunsPerPattern` | `20` |
| `maxUsdPerProbe` | **unset** — no ceiling is assumed |

An unset `maxUsdPerProbe` is what makes `--max-usd` mandatory rather than
defaulted: this package does not choose a spend ceiling for the operator
silently.
- `maxUsdPerProbe` set: a run whose estimate exceeds it is refused with reason
  `probe-over-budget` before any worktree is created.
- A malformed block is ignored as a whole, exactly as `loadLearningConfig` treats
  malformed capabilities today.

## 5. CLI surface

```
keryx learn probe <id> --task <task-id> [options]

  --task <task-id>       required; looked up in the task set (absent -> unmeasurable / no-task, see below)
  --task-set <path>      task set JSON; default from config or built-in path
  --runs <n>             seeds per arm; default 3, minimum 1
  --model <id>           model for both arms; default: the current session model
  --provider <name>      provider for both arms; default: the configured provider
  --max-usd <n>          required for a real run; ceiling for the whole probe
  --dry-run              print plan and estimate; writes nothing, runs nothing
  --json                 machine-readable output

keryx learn probe <id> --dry-run        # allowed without a TTY
keryx learn probe <id> ...              # requires a real interactive terminal
```

Behavior:

- `<id>` must resolve to a `status: candidate` or `status: accepted` record in
  project scope. A `rejected`, `expired` or `superseded` record is refused with
  reason `probe-ineligible-status`; a user-scope record is refused with
  `probe-user-scope-unsupported` in v1.
- A real run prints the plan (task, arms, seeds, model, estimate) and requires
  typing the pattern's `id` to confirm, the same confirmation shape
  `learn promote` and `learn graduate apply` use.
- `--max-usd` missing on a real run: refused, reason `probe-no-budget`.
- No TTY on a real run: refused, reason `probe-no-tty`. No flag bypasses it.
- An existing, complete `comparison.json` for this probe id: refused, reason
  `probe-already-completed` (already-complete runs are never overwritten).
- An interrupted directory whose recorded `environment` or `runs` request differs
  from this invocation: refused, reason `probe-environment-mismatch`. A resumed
  probe never mixes two environments into one comparison.
- A `--task` id absent from the task set is **not** a refusal: the probe writes a
  comparison with `verdict: "unmeasurable"`, `reason: "no-task"`, null arms,
  empty `runs`, and exits `3`. A stale task set is visible in the artifact
  instead of failing silently.
- **Budget overrun.** Spend is summed from the turn loop's per-call usage after
  each seed. Crossing `--max-usd` mid-probe stops the remaining seeds, writes the
  comparison with `verdict: "unmeasurable"` and `reason: "budget-exceeded"`, and
  exits `3`. An overrun never becomes `indistinguishable`: a truncated run
  answered a different question than the one it planned to ask.
- Refusals (`probe-no-tty`, `probe-no-budget`, `probe-over-budget`,
  `probe-ineligible-status`, `probe-user-scope-unsupported`,
  `probe-already-completed`, `probe-environment-mismatch`) exit `2` and write
  nothing — not even the probes directory.
- Exit codes: `0` for a written comparison (`improved`, `regressed`,
  `indistinguishable`); `3` for `unmeasurable` (comparison still written); `2`
  for a refusal that wrote nothing.
- `--json` emits the comparison object on stdout and nothing else.

## 6. Data contracts

### 6.1 Task set — [schemas/probe-task-set.schema.json](schemas/probe-task-set.schema.json)

```json
{
  "schemaVersion": 1,
  "tasks": [
    {
      "id": "wilson-interval",
      "kind": "deterministic",
      "prompt": "In this repository, which exported function computes ...",
      "expect": { "file": "src/metrics/benchmark.ts", "symbol": "wilsonInterval" },
      "goldArtifacts": ["scripts/benchmark/ablation-tasks.ts"]
    }
  ]
}
```

- `kind`: `deterministic` (one seed suffices) or `stochastic` (three seeds
  minimum, PRD R3).
- `expect`: the objectively checkable answer. The scorer compares the model's
  final answer line against `file` and `symbol` with the same normalization the
  ablation tasks use. There is no LLM judge.
- `goldArtifacts`: repository-relative paths that contain the answer key and must
  be removed from every arm's worktree before the agent starts (PRD R9).
- A task whose `goldArtifacts` entry does not exist in the base ref, or survives
  removal, yields `unmeasurable` / `gold-leak` (exit 3) with a comparison that
  records the reason and carries no arms — an unverified key is not a passing
  run.
- Both arms run the **read-only** tool set `scripts/benchmark/run-ablation.ts`
  already uses (filesystem reads plus the metaproject retrieval tools). No write
  tool is offered, so a probe cannot mutate its worktree, and the claim in PRD R9
  is limited to what that tool set can reach: the named paths are absent before
  the turn starts.

The spec does not import `scripts/benchmark/ablation-tasks.ts` at runtime: that
file is a producer-side constant, and coupling a shipped command to a script
would invert the zone direction. A converter that exports its tasks into this
JSON shape is a separate, optional script.

### 6.2 Comparison — [schemas/probe-comparison.schema.json](schemas/probe-comparison.schema.json)

Holds: `probeId`, `patternId`, `taskId`, `createdAt`, `resumed`,
`environment` (`model`, `provider`, `commit`, `baseRef`, `taskSetDigest`),
`arms.base` and `arms.probe` (each `seeds`, `successes`, `rate`, `ci`, and
`tokens`/`toolCalls` when the provider reported them), `delta`
(`rate`, `ci`, and the token/tool-call deltas), `verdict`, `reason`, and `runs[]`
(one entry per seed with its transcript path).

For `unmeasurable`, `arms.base` and `arms.probe` are `null` and `runs` may be
empty: the artifact records that the question was not answerable, and the schema
does not force a fabricated zero-success rate or a transcript that never
happened.

`environment` is written before the first arm starts and re-read before scoring.
A mismatch between the two arms' recorded environment is `unmeasurable` with
reason `environment-drift`.

### 6.3 Evidence extension

Four places enumerate evidence source types and they must move together: the
type union `EvidenceSourceType` (`src/learning/types.ts`), the runtime validator
whitelist `EVIDENCE_SOURCE_TYPES` (`src/learning/schema.ts`, which is what
`validateLearnedPattern` actually checks before a write), the shipped schema
`src/learning/learned-pattern.schema.json`, and the documented schema
`docs/requirements/keryx-agent-platform-expansion/schemas/learned-pattern.schema.json`.
All four gain one value: `"probe"`. Adding it to the type alone would compile and
then fail at write time, so AC6 asserts the written record still passes `validateLearnedPattern` after the
append.

An appended item is exactly:

```json
{
  "kind": "reinforcement",
  "sourceType": "probe",
  "sourceRef": ".metaproject/data/learning/probes/<pattern-id>/<probe-id>/comparison.json",
  "observedAt": "2026-10-20T00:00:00.000Z",
  "weight": 1.0
}
```

Weight mapping, all inside the existing `MAX_EVIDENCE_WEIGHT = 1.5`:

| Verdict | `kind` | `weight` | Evidence written |
|---|---|---|---|
| `improved` | `reinforcement` | `1.0` | yes |
| `regressed` | `contradiction` | `1.5` | yes |
| `indistinguishable` | — | — | no |
| `unmeasurable` | — | — | no |

A regression outweighs an improvement because a single reproduced failure is
harder evidence than a single reproduced success — the same asymmetry the
confidence model already encodes with `CONTRADICT_RATE > REINFORCE_RATE`.

### 6.4 How the pattern reaches the arm

The pattern is injected as one instruction block appended to the system
instruction for every turn of the `probe` arm:

```
<learned-pattern id="<pattern-id>">
When <trigger>, <action>.
</learned-pattern>
```

The `base` arm receives the same system instruction with an empty block, so the
two arms differ by that text and nothing else. No file in either worktree is
modified — the pattern is not written into `AGENTS.md`, a rule, or a skill, which
keeps the repository byte-identical across arms and keeps the probe from
practising the very write it is meant to justify.

`trigger` and `action` are validated at record creation (8–400 characters,
`learned-pattern.schema.json`), so an empty block cannot reach the runner; a
record that somehow lacks them is refused before any worktree starts.

## 7. Scoring

One arm's outcome for one seed is a boolean: the final answer line names the
expected file and symbol. Per-arm success rate is `successes / seeds`; the
per-arm interval is the existing `wilsonInterval` from `src/metrics/benchmark.ts`.

The design is paired by construction — the same task, environment and seed index
in both arms — but the scored quantity is the difference of two independent
proportions, because the two arms are separate runs rather than one run compared
with itself. The interval is therefore a Newcombe hybrid-score interval (95%),
which is conservative for a paired design: it cannot manufacture significance
the data does not support. `src/learning/probe-score.ts` owns this function and
is pure: counts in, numbers out, no IO.

Verdict resolution, in order:

1. The task id is absent from the task set → `unmeasurable` / `no-task`.
2. Fewer seeds than the task's `kind` requires → `unmeasurable` / `underpowered`.
3. Any arm's environment record missing or mismatched → `unmeasurable` /
   `environment-drift`.
4. Any seed's turn failed to produce an answer line at all → `unmeasurable` /
   `run-failed` (a crashed arm is not a zero).
5. Spend crossed the ceiling → `unmeasurable` / `budget-exceeded`.
6. Delta interval entirely above zero → `improved`.
7. Delta interval entirely below zero → `regressed`.
8. Otherwise → `indistinguishable`.

The six `unmeasurable` reasons defined in §6.1 and this section are the complete
vocabulary; the schema enforces it as an enum, so a seventh spelling cannot
appear without a schema change. The seven refusals in §5 are not verdicts and
never reach an artifact.

Token and tool-call deltas are recorded and reported, never used to decide the
verdict: a pattern that achieves the same outcome with fewer tokens is not
`improved` by this contract, and saying so is a deliberate limitation rather than
an oversight.

## 8. Integration points

| Point | Use |
|---|---|
| `src/learning/store.ts` | `readPattern`, `updatePattern` under the existing file lock; no new store |
| `src/learning/confidence.ts` | `applyEvidence` for the confidence update; no new constants |
| `src/learning/scan.ts` | the record's text is already scanned at creation; the probe writes no new free text into the record |
| `src/metrics/benchmark.ts` | `wilsonInterval`; `validatePairedBenchmark` if the comparison is ever exported as a manifest |
| `src/metrics/ablation-runner.ts` | reference for arm scoring shape; not imported — probe scores two arms of the same task, not two variants of a context policy |
| `src/harness/child/git-worktree-port.ts` | create/remove one worktree per arm |
| `src/commands/agent.ts` (`runAgentTurn`) | run one arm headlessly, exactly as `scripts/benchmark/run-ablation.ts` does |
| `src/metrics/leakage.ts` | `checkGoldLeakage` after removal, before the turn |
| `src/learning/prune.ts` | new third pass calling `retainRunsPerPattern` from `probe.ts`; today's two passes are unchanged |
| `src/commands/learn.ts` | dispatch only |

## 9. Acceptance criteria

- **AC1** `keryx learn probe --help` exits zero and lists every flag in §5.
- **AC2** `--dry-run` without a TTY prints the plan (task, arms, seeds, model,
  estimate) and writes nothing: no probes directory, no worktree, no evidence.
- **AC3** A real run without `--max-usd` is refused with reason
  `probe-no-budget`, exit `2`, and writes nothing. A run whose estimate exceeds
  the configured `maxUsdPerProbe` is refused with `probe-over-budget`, exit `2`,
  and writes nothing — distinct from AC15's mid-run `budget-exceeded`.
- **AC4** A real run outside a TTY is refused with reason `probe-no-tty`, exit
  `2`, and writes nothing.
- **AC5** A completed probe writes `comparison.json` and `plan.json` under
  `probes/<pattern-id>/<probe-id>/`, both schema-valid, and leaves both worktrees
  removed.
- **AC6** `improved` appends exactly one `reinforcement` item with
  `sourceType: "probe"` and weight `1.0`; the record's confidence equals
  `applyEvidence(old, "reinforcement", 1.0)`; and the stored record still passes
  `validateLearnedPattern` (`src/learning/schema.ts`) after the append.
- **AC7** `regressed` appends exactly one `contradiction` item with weight `1.5`;
  `indistinguishable` and `unmeasurable` append none and leave confidence
  byte-identical.
- **AC8** A task set whose `goldArtifacts` path is present in the worktree after
  removal yields `unmeasurable` / `gold-leak`, exit `3`, no evidence, and a
  schema-valid comparison with `arms.base` and `arms.probe` both `null` and an
  empty `runs`.
- **AC9** The record's `status` and `updatedAt`-independent fields are unchanged
  by a probe; only `evidence`, `confidence`, `confidenceLevel` and `updatedAt`
  may differ.
- **AC10** An interrupted probe whose recorded `environment` and `runs` request
  match the invocation resumes from its existing directory and reuses completed
  seeds; one whose recorded values differ is refused with
  `probe-environment-mismatch`, exit `2`, and writes nothing (AC18). A completed
  `comparison.json` is never overwritten under any verdict, and a re-run of a
  completed probe id is refused with `probe-already-completed`, exit `2`, leaving
  the file byte-identical.
- **AC11** No probe code path imports a writer under
  `.metaproject/project-skills/`, `.metaproject/rules/`, or
  `.metaproject/agents/`; the guard test asserts the import graph.
- **AC12** (R1) The import graph of `src/commands/learn.ts` and the four
  decision commands' modules contains no edge into `learn-probe.ts`, and each
  passes its existing test suite with probe absent from the build.
- **AC13** (R2) Both arms' recorded `environment` is identical, the two
  worktrees are byte-identical, and the only difference between the arms' system
  instructions is the `<learned-pattern>` block; the diff is asserted in the
  runner test.
- **AC14** (R3) A `stochastic` task run with `--runs 2` yields `unmeasurable` /
  `underpowered`, never `indistinguishable`; a `deterministic` task run with
  `--runs 1` is allowed.
- **AC15** (R4) A table-driven test feeds counts for each of the four verdicts
  and asserts exactly one verdict per input, including all six `unmeasurable`
  reasons.
- **AC16** (R10) A runner test that throws mid-arm, and a runner test that
  receives SIGINT, both leave zero worktrees behind and still write the
  comparison with `run-failed`.
- **AC17** Retention: with `retainRunsPerPattern: 2` and three completed probe
  directories for one pattern, the transcript pass deletes only the oldest
  directory's `runs/` and leaves every `plan.json` and `comparison.json` intact.
- **AC18** An interrupted directory whose recorded `environment` or `runs`
  request differs from the invocation is refused with
  `probe-environment-mismatch`, exit `2`, and its files are unchanged.
