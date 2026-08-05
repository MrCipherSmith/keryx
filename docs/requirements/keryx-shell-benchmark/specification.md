# Keryx Shell Benchmark Specification
Version: 0.2.0

## Identity

| Field | Value |
|---|---|
| Package | `keryx-shell-benchmark` |
| Kind | implementation-plan |
| Protocol | `paired-3-5-v1` (from `keryx metrics benchmark init`) |
| Depends on | [keryx-execution-observability](../keryx-execution-observability/README.md) for metrics, reliability levels, manifest and decision rule |

## Targets

| # | Target | Why | Bias |
|---|---|---|---|
| T1 | `helyx` (`/home/altsay/bots/helyx`) | ~2 650 TypeScript files, actively developed, populated `.metaproject/` — graph, wiki (architecture / components / testing), memory, health, testing | **Primary.** Not keryx, so the tool does not grade itself. |
| T2 | `keryx` (`/home/altsay/keryx`) | The richest workspace in existence: full wiki, dense graph, accumulated memory | **Secondary, biased.** Reported separately and never averaged with T1. |

Excluded: every `/tmp/.../scratchpad/*` registry entry (fixtures, not projects)
and the `deprecated*` trees (out of scope for this work).

### Target preparation

Before any run, on each target, at a recorded commit:

```bash
keryx sync --apply        # graph + wiki + memory reconciled with the code
keryx health run          # so health cases have a current artifact
keryx test analyze        # so test-intelligence cases have one
git rev-parse HEAD        # recorded into every result
```

A stale workspace would make keryx fail cases for a reason that has nothing to do
with the capability under test.

## Variants

Revised 2026-08-05 during the first run; the reasons are recorded in
[the run report](run-2026-08-05.md#34-the-control-legs-and-why-they-were-added).

| Variant id | Agent | Model | Manifest `variant` |
|---|---|---|---|
| `keryx-deepseek` | `keryx shell` | `deepseek-v4-flash` | `with-keryx` |
| `keryx-gemma` | `keryx shell` | `gemma4-coder:latest` via Ollama (free, local) | `with-keryx` |
| `opencode-deepseek` | opencode | `deepseek-v4-flash` — **the same model as the keryx leg** | `without-keryx` |
| `baseline-claude` | Claude Code | its own default | `without-keryx` |
| `baseline-grok` | Grok CLI | its own default | `without-keryx` |
| `naked-claude` | Claude Code | its own default | `without-keryx` |
| `naked-grok` | Grok CLI | its own default | `without-keryx` |

Three changes from 0.1.0, each forced by evidence rather than preference:

- **Codex removed** — usage limit exhausted until 2026-08-11.
- **`opencode-deepseek` added.** It runs the *same model* as the keryx leg, so a
  difference between the two cannot be attributed to model quality. This is the
  only clean pair in the matrix and it repairs the fairness caveat the PRD
  states.
- **`naked-*` added.** The first A1 run showed both baselines *shelling out to
  the keryx CLI*, because the target's `CLAUDE.md` routing block tells every
  agent to. Without a leg that has the workspace removed, the benchmark compares
  keryx-as-a-shell to keryx-as-a-CLI, not to its absence.
- **`deepseek-chat` → `deepseek-v4-flash`.** The API lists only
  `deepseek-v4-flash` and `deepseek-v4-pro`; the former id is an undeclared alias.

The paired manifest carries two variants only, so each pairing
(`keryx-*` × `baseline-*`) is emitted as its own manifest and the variant id is
recorded in the result record alongside it.

`keryx harness run` is **not** a variant: it registers no tools and completes a
single text turn, so it cannot perform an agentic task. Recording it would
compare an agent to a chat completion.

## Isolation

One `git worktree` per (target × variant × case bundle), created from the
recorded commit:

```bash
git -C <target> worktree add <run-dir> <commit>
```

Properties this buys, each of which a shared checkout would destroy:

- byte-identical starting state for every agent;
- a run's `git diff` attributable to that run alone;
- no cross-contamination when two agents edit the same file;
- a discardable tree — a destructive-command case can be *allowed to happen*.

`.metaproject/` is present in every worktree. The baseline agents may read it;
what they do not have is the query layer. See the PRD's fairness section.

## Execution

Each case runs as an independent agent session. Nothing carries over between
cases except in group D, which tests carry-over on purpose.

Driving each agent verbatim is specified in [agent-protocol.md](agent-protocol.md).

## Evidence capture

Every run produces a durable evidence bundle. The benchmark is being written up
afterwards, and a claim whose evidence was not captured at the time cannot be
recovered later.

```text
bench/<target>/<case-id>/<variant-id>/
  prompt.txt          the verbatim prompt as sent
  transcript.txt      full stdout of the session
  diff.patch          `git diff` of the worktree at finish (empty for read-only cases)
  result.json         the case result record (schema below)
  screens/            timestamped screenshots
    000-start.png
    NNN-<label>.png
```

### Screenshots

Captured for **every** agent, not only keryx — a side-by-side write-up needs both
halves or it is an advertisement.

| When | Label | Why |
|---|---|---|
| Session start, prompt visible | `start` | Proves the same prompt, and shows provider/model in the keryx header |
| First tool call | `first-tool` | The discriminating moment: which tool the agent reached for first |
| Each subsequent distinct tool | `tool-<n>-<name>` | The path to the answer, which is what group A is actually measuring |
| Final answer on screen | `final` | The result as a user sees it, not as a log renders it |
| Any refusal, approval prompt or denial | `gate` | Group C's evidence |

Interactive TUI sessions are captured from the terminal window. Piped
non-interactive sessions have no window; for those the transcript is the record
and a rendered still of the transcript is produced instead, labelled as such — a
rendered transcript must never be presented as a screenshot of a live session.

## Grading rubric

Scored per case, per variant, by the criteria this package fixes **before** the
run.

| Dimension | Scale | Notes |
|---|---|---|
| `correctness` | 0 / 1 / 2 | 0 wrong, 1 partially right or incomplete, 2 matches the expected outcome |
| `grounding` | `grounded` / `plausible` / `unsupported` | `grounded` only when the answer cites the evidence the case declares. A right answer with no evidence is `plausible`, and that distinction is the point of the exercise |
| `tool_path` | list | Which tools were called, in order |
| `used_workspace` | yes / no / n-a | Did the agent reach the workspace layer at all |
| `steps` | integer | Model turns |
| `tool_calls` | integer | |
| `context_files_read` | integer or `unknown` | |
| `wall_time_seconds` | number | Recorded, never reported alone |
| `human_interventions` | integer | Any operator input past the initial prompt |
| `safety` | `pass` / `fail` / `n-a` | Group C only: did the gate behave as declared |

### Verdicts

Per case, comparing a keryx leg to a baseline leg:

- **`keryx-advantage`** — equal or better `correctness`, `grounded`, and strictly
  fewer `tool_calls` **or** strictly fewer `context_files_read`.
- **`parity`** — equal correctness, no material difference in effort.
- **`keryx-regression`** — lower correctness, or materially more effort.
- **`capability-unused`** — the workspace could have answered it and the model
  did not reach for it. Recorded distinctly, because the fix is a prompt or
  registry change, not a capability.
- **`model-limited`** — passes on `keryx-deepseek`, fails on `keryx-gemma`.

## Data contracts

Each case result is one JSON document validating against
[`schemas/benchmark-case.schema.json`](schemas/benchmark-case.schema.json).

Aggregate results are emitted into paired manifests in bundles of 3–5 case ids —
the range `keryx metrics benchmark init` enforces:

```bash
keryx metrics benchmark init --tasks A1,A2,A3,A4,A5 --out bench/manifests/group-a-1.json
keryx metrics benchmark validate bench/manifests/group-a-1.json
```

`speed_claim` stays `not-claimed`. Promoting it requires the decision rule in
[metrics-and-validation](../keryx-execution-observability/metrics-and-validation.md#decision-rule):
a documented task set, a documented measurement source, and no quality traded for
elapsed time.

## Reporting

Two artefacts, and the second is the reason the first is captured so carefully:

1. **`report.md`** — per-group verdict tables, every case listed including
   skipped ones, with the evidence bundle path for each row.
2. **An article draft** — narrative, built from the captured screenshots and
   transcripts, structured as: the claim, how it was tested, what happened,
   where it failed. Written whether the result is favourable or not; a benchmark
   published only on success is not evidence.

## Acceptance criteria

Mapped to the PRD's success criteria: S1→AC1/AC2, S2→AC6, S3→AC4, S4→AC3/AC8,
S5→AC8, S6→AC9. The case catalog these criteria are applied to is
[test-cases.md](test-cases.md).

| # | Criterion |
|---|---|
| AC1 | The case catalog is fixed at a package version before the first run, and the version is recorded in every result. |
| AC2 | Every executed case has an evidence bundle with prompt, transcript, and at least the `start` and `final` screenshots. |
| AC3 | Every result record validates against the case schema. |
| AC4 | Every paired manifest validates with `keryx metrics benchmark validate`. |
| AC5 | Prompts are byte-identical across variants; a mismatch invalidates that case's pair. |
| AC6 | Each target's preparation commands and resulting commit are recorded. |
| AC7 | Group C cases run in a disposable worktree, and a destructive case is permitted to reach the gate rather than being avoided. |
| AC8 | `capability-unused` and `keryx-regression` outcomes appear in the report with the same prominence as `keryx-advantage`. |
| AC9 | No speed claim is published unless the decision rule is satisfied and stated. |
