# Roadmap
Version: 0.1.0

Six phases. Phases 0–2 are corrections to things that are broken or untrue
today. Phase 3 is unification. Phase 4 is the new capabilities, and it depends
on Phase 1. Phase 5 makes the whole thing measurable, which is the only way any
of this stays true.

Every item states: the problem, the evidence, the exact change, the cost, and
the risk. An item with no evidence is not on this list.

---

## The organising principle

> Gates written in TypeScript held 184 times out of 184.
> Gates written in Markdown failed 24 times out of 184.

Every phase below is an application of that sentence. When a rule matters,
it goes in code and gets a test. When it cannot go in code, it does not get to
claim it is enforced.

---

## Phase 0 — Stop asserting things that are false

Same-day work. No design required.

### 0.1 Wire the task gate into `flow complete`

**Problem.** `flow-orchestrator/SKILL.md` (~line 173) states: *"`flow complete`
gates on them, so an unrun verification step keeps the flow open instead of
being quietly dropped."* It does not. `complete()` in `src/flow/service.ts`
runs exactly four gates: acceptance-criteria, PR-or-merge, health, security.

**Evidence.** `taskGateStatus()` exists in `src/flow/machine.ts:40`, is fully
implemented and tested, and carries a comment at `machine.ts:36` reading
*"Deliberately NOT wired into `service.complete()`."* Its only caller is its own
test. Measured consequence: **24 of 184 done flows carry an unfinished task — 34
tasks in total, of which 24 are `Self-review and prepare draft PR`.** One
completion in eight skipped its own review step.

**Change.** Add a fifth gate to `complete()` calling the existing
`taskGateStatus()`. Fail when any task is non-terminal. Decide explicitly
whether disposition `skipped` passes — today it would, and it should not
without a recorded reason.

**Cost.** ~15 lines plus tests; the function is already written.
**Risk.** Real: it retroactively invalidates 24 historical flows. Gate on
`schemaVersion: 2` or an opt-in config key so existing packages are not
rewritten by a version bump.

**Corroboration.** EviBound ([arXiv:2511.05524](https://arxiv.org/abs/2511.05524))
implements approval-gate plus verification-gate over declared acceptance
contracts and reports **0% hallucinated completions against 100% in the
baseline, at 8.3% overhead**.

### 0.2 Delete the false claim, in the same commit

A document asserting a safety property that does not exist is worse than no
document — it is what let 34 unfinished tasks through in 24 flows. One line. No risk. It must not land
in a later commit than 0.1, or the tree spends time in a state where the doc is
knowingly wrong.

### 0.3 Delete dead surface

- `--greptile` (`review-orchestrator/SKILL.md:450,456`) routes to a skill that
  exists nowhere in the tree.
- `src/**/*.ts` → `review-frontend-conventions` (~line 354) fires the frontend
  reviewer on **every keryx review**, in a repository with no frontend.
- ~~`FAILED` is unreachable and should be dropped from the enum and the routing
  table.~~ **Withdrawn 2026-08-29 — the premise was false.** It is true that
  `task-implementer` maps its own `failed → STATUS: BLOCKED` and that
  `subagent-status-protocol.md` (titled "The Four Statuses") never mentions it.
  It is not true that nothing emits it: `src/harness/child/contract.ts` mirrors
  the enum as `CanonicalSubagentStatus` and its `parseChildResult` reads a real
  child worker's `STATUS: FAILED`, wired into production at
  `src/harness/extension/execute.ts:167`, with `spawn.test.ts:505` asserting
  that a `FAILED` child disposition maps to a `failed` completion "never a false
  `completed`". Removing it would delete a tested completion-safety path in the
  external-child layer. The accurate defect is a **documentation** one: the
  protocol document describes four statuses while the schema carries five, and
  the two worker families differ. Fix the document, keep the enum.
- The legacy-profile prompt fires on every review; `code-ai-review` emits
  free-prose Russian with no per-finding severity field and cannot be
  normalised. Keep the profiles behind explicit flags, stop prompting.

**Cost.** One sitting. **Risk.** None.

---

## Phase 1 — Make the review record survive a round

This phase is a prerequisite for Phase 4. Nothing that gates on review history
can be built until the history exists.

### 1.1 Fix the lossy ingest

**Problem.** `src/review/managed.ts:283` re-parses findings from *Markdown*
with regexes. `NormalizedReviewFinding` (`src/review/types.ts:63`) discards
`confidence`, `evidence`, `impact` and `suggested_fix`, and hardcodes
`reviewer` to `"review-orchestrator"` (`managed.ts:305`).

**Why it is fatal, not untidy.** A fix round (`is_fix_round: true`) requires
`prior_findings[].finding` to conform to `review-finding.schema.json`, which
requires all four discarded fields and is `additionalProperties: false`. Round
1's own artifact `findings.json` (`managed.ts:91`) has none of them and carries
four forbidden fields. **Round 2 cannot be constructed from round 1's output.**
The contract is unsatisfiable, and no test covers either loss.

**Change.** Emit and consume a structured findings array. Keep the Markdown
parser only for reading legacy reports. `findings.json` must validate against
`review-finding.schema.json`.

**Cost.** ~half a day with the tests that do not exist yet.
**Risk.** Low. **Blocks:** 4.1, 4.2, 4.3, 5.1.

### 1.2 Persist attempt counts

**Problem.** `attempts: {count, log}` is declared in `src/flow/types.ts:27`,
written once as `{count: 0, log: []}`, and never incremented.

**Evidence.** Non-zero in **3 of 196** flows. Meanwhile **27% of flows exceed 8
hours** of wall-clock, so they certainly cross session boundaries — and on
resume the loop counter silently restarts from zero. A bound that resets is not
a bound.

**Change.** `keryx flow task attempt <id> <Tn> --outcome started|failed|blocked`
writing to the existing field. The orchestrator reads `count` instead of
trusting its own context window.

**Cost.** One CLI verb and one service method. **Risk.** Low, additive.

### 1.3 Resume procedure

The input contract declares `mode: "resume"`; the word "resume" appears exactly
once in the whole `flow-orchestrator/SKILL.md`, in passing prose.
`job-orchestrator` already has a working §0.0 State Resumption Check. Port it.

**Cost.** ~15 lines of SKILL.md. **Risk.** None.

---

## Phase 2 — Make review precise instead of broad

Our design bets on breadth: 19 selectable reviewers, ~440 checklist items. The
field evidence contradicts that bet uniformly.

- Only **30–42%** of AI review comments contain a valid issue — 22,326 comments
  across 178 mature repositories
  ([arXiv:2508.18771](https://arxiv.org/html/2508.18771v1)). Addressing rate for
  *valid* comments: humans 60%, best bot 19.2%, worst 0.9%. Granularity predicts
  adoption: hunk-level 19.2% vs file-level 4.2%.
- The only independent field study is negative: ~50% noise, ~25% bikeshedding,
  remainder half useful and half wrong — **≈12.5% useful** — after which the
  maintainers disabled the tool.
- On security specifically, GPT-4 flags **both** the vulnerable and the
  already-patched version as vulnerable **71.63%** of the time, scoring **5.14%
  on paired judgment against a 22.70% random baseline** — worse than chance
  ([PrimeVul](https://arxiv.org/abs/2403.18624), ICSE 2025). The best published
  whole-repository system runs an **84.82% false-discovery rate**
  ([IRIS](https://arxiv.org/abs/2405.17238), ICLR 2025).
- Neither market leader converged on our architecture. **Cursor abandoned fixed
  parallel fan-out plus voting for a single adaptive agent and called it their
  largest gain.** Greptile parallelises per *hypothesis*, spawned dynamically.
  The closest open competitor ships 5 dimensions defaulting to 3. **Nobody runs
  19.**

What works is subtraction: a QA-checker stage took precision **51% → 93%** by
rejecting; Tencent's alarm filter removes **94–98%** of static-analysis false
positives; LLift turned ~140,000 unusable kernel alarms into ~50% precision and
13 real bugs.

**"False positive" appears zero times in our entire review domain.** We built
the generator and none of the filter.

### 2.1 Deterministic pre-filter before dispatch

Before Wave A, as a hard rule rather than prose: drop generated, lockfile,
snapshot and vendored paths; drop whitespace-only and comment-only hunks; scope
every reviewer to **changed hunks ± N context lines**. Record what was dropped
in `review_context.token_policy.omissions`.

**Evidence.** reviewdog's `filter-mode: added` is the sharpest false-positive
mechanism found anywhere and is positional, not semantic — a linter with 40,000
pre-existing violations posts zero comments. Sourcery publishes the measured
effect of the same approach: **77% fewer tokens and 80%+ fewer false
positives**.

**Cost.** Low, and it requires no model call at all. **Risk.** None.
**This is the cheapest win on the list.**

### 2.2 Replace `review-strict` with a verifier that can only delete

**`review-strict` is not neutral, it is harmful.** It re-reads existing findings
and adjusts severity **without new evidence**, with an elevation table biased
3:1 toward escalation. That operation is measured to degrade accuracy: GPT-4 on
GSM8K **95.5 → 91.5 → 89.0** across self-correction rounds; GPT-3.5 on
CommonSenseQA **75.8 → 38.1**
([Huang et al., ICLR 2024](https://arxiv.org/abs/2310.01798)). Among changed
answers, correct→incorrect exceeds incorrect→correct. Self-Refine
([arXiv:2303.17651](https://arxiv.org/abs/2303.17651)) shows the same shape:
**+49.2 on dialogue, +0.2 on maths** — gains only on subjective tasks.

**Change.** A new `review-verifier` skill in Wave C, replacing it. Per finding
it emits `verification: {verdict: confirmed|refuted|unverifiable, method,
evidence}`. Methods, strongest first:

1. run a targeted command or test that **fails if the finding is real** — keryx
   is a Bun project, execution is cheap;
2. confirm the claimed sites in `class_scope` exist, via `keryx ctx rg`;
3. reasoning only — caps the verdict at `unverifiable`, never `confirmed`.

**The verifier must never be the reviewer that produced the finding.**

**Evidence.** Verification that *executes* rejects **85–96% of false reports
against 4–15% unaided, while finding 30–44% more true bugs**
([AnyPoC](https://arxiv.org/abs/2604.11950)). Meta's TestGen-LLM funnel
([arXiv:2402.09171](https://arxiv.org/abs/2402.09171)) runs 75% build → 57%
build+pass → **25%** improve-coverage, and that surviving 25% reaches **73%
human acceptance**. The decisive counter-example for voting-based schemes:
**80+ agents unanimously endorsed a padding-oracle vulnerability that did not
exist — killed by a single empirical test.** Consensus cannot detect a
hallucination its members share.

**Rollout.** `verification_mode: off | annotate | filter`, defaulting to
`annotate` for one release so the drop rate is measured before it bites.
**Risk.** Real — SWE-agent keeps its equivalent opt-in because it sometimes
rejects correct patches. That is precisely what annotate-first is for.

### 2.3 Generalise the security reviewer's Iron Laws

`review-security-code/SKILL.md:212-217` already encodes the discipline the other
thirteen reviewers lack: attack vector mandatory; no reproducible path → INFO;
never flag the theoretical; group repeats into one finding. Lift laws 2–4 into
every reviewer, phrased generically.

**Cost.** Mechanical, one sitting. **Risk.** Zero. Best cost/benefit here.

### 2.4 Confidence, aggregated — not raw

Change `confidence` to a number in [0,1] in **both**
`review-orchestrator/reviewer-finding.schema.json` and
`src/gdskills/contracts/review-finding.schema.json`. The latter is
`additionalProperties: false`, so they move together or every finding becomes
invalid — the exact trap PR #218 documented. Add `exploit_scenario` (non-empty)
to the `if/then` that already requires `class_scope` for blocker and major.

Gate at 0.7 — **but only on a score aggregated over ≥3 samples, or
cross-checked by the verifier.** Raw verbalized confidence ranks a model's own
correct against incorrect answers at **AUROC 0.551 (GPT-3.5) / 0.627 (GPT-4)**
([Xiong et al., ICLR 2024](https://arxiv.org/abs/2306.13063)), clustering at
80–100% in multiples of 5; RLHF made GPT-4's MMLU calibration error **0.007 →
0.074**. Consistency aggregation at M=5 reaches **ECE 0.148 / AUROC 0.745**. A
bare threshold on a self-reported number filters noise with noise.

### 2.5 Caps

- **Findings:** 10 per reviewer, blockers exempt. `budget.max_findings` is
  schema-required today with no default stated anywhere. Per-reviewer caps
  appear nowhere in the surveyed ecosystem — genuinely unoccupied ground.
- **Rounds:** 6 → **3**. Our bound is an outlier and unsupported. The evidence
  converges: *"the first three to four repair iterations account for most
  achievable gains"* ([arXiv:2607.05197](https://arxiv.org/abs/2607.05197));
  correctness falls **0.820 → 0.673** across two forced revisions while
  ever-correct is **0.847** — the agent finds the fix and then destroys it,
  throwing away ~15 percentage points
  ([arXiv:2607.24604](https://arxiv.org/abs/2607.24604)). Aider hardcodes
  `max_reflections = 3`; OpenHands' critic uses 3; **our own `job-orchestrator`
  already uses 3.** We currently run four unshared bounds: task-implementer 3,
  job-orchestrator 3, flow-orchestrator 6, `/goal --auto` 8.
- **Spend:** a token or currency ceiling that stops and asks rather than
  proceeding. SWE-agent chose a $3/instance dollar cap over a step budget.
- **Concurrency:** a wave cap. Claude Code allows 20 concurrent subagents and
  `review-orchestrator` is itself nested under `flow-orchestrator`.

### 2.6 Loop *detection*, not only counting

Escalate when the same finding identifier recurs twice, or two consecutive
attempts produce identical review output — regardless of remaining budget.
OpenHands ships a stuck detector with five patterns, on by default.

**Cost.** Doc-only. **Risk.** None.

---

## Phase 3 — Unify so that claims are checkable

### 3.1 One canonical severity rubric

Ten independent rubrics feed one sort. Today `review-clean-code:395` makes a
**41-line function** `major`, ranked alongside `review-security-code:303`'s
"plausible attack scenario" — and both force `REQUEST_CHANGES`. Direct
contradiction: `@ts-ignore` is `minor` in `review-backend:176` and `major` in
`review-strict:124`.

Add `## Severity (canonical)` to `review-orchestrator/SKILL.md` and delete the
ten per-reviewer tables. `blocker` means merge-blocking only: crash, data loss,
exploitable vulnerability, or an unimplemented acceptance criterion.

### 3.2 Retire the checklist mass that does not apply

~440 checklist items target NestJS, React, MobX and Prisma. keryx is a
zero-dependency Bun CLI. Those reviewers are not wrong, they are simply aimed
elsewhere; scope them by detected stack rather than running them here.

### 3.3 Skill-format cleanup against the published spec

The Agent Skills specification defines six frontmatter fields. Ours diverge in
four ways; two are deliberate and two are drift.

| Field | Verdict |
|---|---|
| `triggers` | **Keep.** Not in the spec and not used by any surveyed collection, but it gives the router a deterministic first-pass match before semantic description matching. Additive; costs nothing as long as `description` stays self-sufficient. |
| per-skill `input-contract` / `output-contract` schemas | **Keep.** Genuinely unique to us. The spec assumes one agent reading one skill; we dispatch typed payloads to subagent workers. It solves a problem the spec does not attempt. |
| `version` at top level **and** in `metadata` | **Drift — pick one.** The spec sanctions `metadata.version`; the top-level duplicate is redundant. |
| `compatibility` | **Drift — rename.** The spec means *environment requirements, in prose* ("requires git, docker, internet"). We use the same field name for a machine-readable CSV of harness names. Move ours to `metadata.compatible_harnesses`. |

### 3.4 Both copies, or a generator

`src/gdskills/bundled/skills/` is the source of truth; `.metaproject/skills/gdskills/`
is an installed mirror. Every edit must land in both. Either add a check that
fails when they diverge, or generate the mirror.

---

## Phase 4 — The new capabilities

Specified in full in [specification.md](specification.md). Summary and ordering
only here.

| # | Capability | Depends on |
|---|---|---|
| 4.1 | Deep review rounds after the draft PR — diff scope **and** blast-radius scope | 1.1, 2.1 |
| 4.2 | Completion gated on a clean final round | 1.1, 4.1 |
| 4.3 | External PR comments collected every round, answered once at the end | 1.1 |
| 4.4 | Adaptive model selection by tier, per provider family | — |
| 4.5 | Brevity rule for every outward-facing GitHub artifact | — |

4.1–4.3 cannot be built on the current review record. That is why Phase 1 is
not optional. 4.4 and 4.5 are independent and can land at any point; 4.4 in
particular pays for itself immediately, because it is what makes the added
blast-radius scope in 4.1 affordable.

Note that 4.4 **replaces** `.metaproject/rules/core/model-selection.mdc`, which
is stale in two ways: it lists Codex model names that no longer match the
environment, and its "Mandatory Behavior" requires asking the user before
changing a sub-agent's model — which makes adaptive selection impossible by
construction.

---

## Phase 5 — Make it measurable

### 5.1 `filter_stats` in the output contract

`{total, dropped_prefilter, dropped_low_confidence, dropped_refuted, retained,
by_reason}`. Without it, no claim in Phase 2 can be checked after the fact, and
this document becomes the next thing asserting an unenforced property.

### 5.2 Dismissal taxonomy

`FINDING_CLASSIFICATIONS` already contains `false_positive` and nothing ever
assigns it — `managed.ts:307` hardcodes two values. Populate it, and split
dismissals into **incorrect / correct-but-won't-fix / correct-but-out-of-scope /
correct-but-deprioritised**. Only the first is model error; conflating them
poisons any learning signal. Note that `.metaproject/memory/review-notes/` does
not exist — the `review-note` type has never been written, so the learning loop
has produced nothing to date.

### 5.3 Skill quality evaluation

The largest serious public collection runs a three-layer pipeline before
shipping a skill: static structural validation, an LLM judge across four
dimensions, and Monte-Carlo reliability over 50–100 simulated runs. We have
`entity-skill-verifier` for project skills and nothing for the 70 bundled
gdskills.

### 5.4 Cross-family review

If a second provider is configured, review with a different model family than
authored the code. Greptile's 1,000-PR study reports **~8–10 recall points**
for free: Claude→Claude 53.7% vs GPT→Claude 62.0%; GPT→GPT 50.5% vs
Claude→GPT 60.0%. We already have `llm-providers.json`.

---

## Rejected, with reasons

Each of these is a plausible next step that the evidence argues against.

**A checkpoint / durable-execution engine (LangGraph, Temporal).** These exist
to make *non-idempotent side effects* replay-safe. Our side effects are git
commits and CLI-owned JSON — already content-addressed. Every such system is
at-least-once anyway and pushes idempotency back onto the application. What we
are missing is a counter and a phase marker: **fields, not an engine.**

**Parallel writing agents / swarms.** The cleanest controlled ablation available
([arXiv:2606.05670](https://arxiv.org/abs/2606.05670)) finds **at most one of
six multi-agent systems beats a matched single-agent anchor; the other five lose
by 2.56–11.29 points while burning more compute.** Convergent rule across four
independent sources: parallelise reading, reviewing and candidate generation;
never parallelise writing.

**More reviewers or more agent roles.** BMAD retired its own Scrum Master and QA
agents into Dev in v6 — the most-adopted practitioner reversed the move. Our
defensible claim is not breadth.

**Multi-agent debate.** **28× tokens for −6 points** on MMLU-Hard; cost-equalised
on GSM8K, plain self-consistency wins. Vote-based compound systems are formally
non-monotone in call count.

**A trained critic or process reward model.** The best result in the corpus
(73.8% vs 57.9% best-of-8) rests on 800K step-level human labels, and the same
authors' ablation shows benchmark-trained critics scoring **AUC 0.45–0.48 —
worse than random**. Only production traces reach 0.69. We have neither corpus
nor training infrastructure.

**Best-of-N patch generation.** +8.2 points for ~30× generation cost. Wrong
trade for a single-developer local flow.

**Chasing SWE-bench.** **One in five "solved" patches is semantically
incorrect**; the top agent drops 78.80% → 62.20% under stronger tests. Anthropic
measured that sub-3-point leaderboard gaps are infrastructure noise.

---

## Calibration for whoever picks this up

Market rate is **$1–2 per PR review**. The headline metric everyone reports is
"comments addressed", where state of the art is **43–66%**. The realistic
baseline to beat, from the only independent study, is **~12.5% useful
comments**.

Treat vendor numbers as mutually irreconcilable: one benchmark scores a
competitor at 11.46% coverage while that competitor reports 78% resolution.
Nobody publishes a defensible precision figure. And trust benchmarks last —
BigVul's labels are 25% correct, and SWE-bench Verified's filtering moved GPT-4o
from **16% → 33.2% with no model change**.
