# Orchestrator hardening — re-measurement, 2026-08-31
Version: 0.1.0

Measured at `HEAD = eb987aa2` (`chore(release): 0.2.72`), against the August 2026
study and the Phase 7 audit. This document has two halves; this is the first.

---

## Internal measurement

### What was measured, and by what method

Four orchestrators, inventoried by the method the Phase 7 audit defined in
`.metaproject/flows/205-2026-08-30-audit-job-orchestrator-the-oldest-orches/inventory.md`.
Every documented mechanism — each step, gate, cap, bound, required artifact,
refusal, hand-off, and every "this is enforced / is recorded / cannot happen"
sentence — classified as:

- **`wired`** — a production code path reaches it, with `file:line` of the call
  site *and* the entry point that reaches it.
- **`prose-only`** — nothing in code makes it happen. **A call site found only in
  a `*.test.ts` counts as `prose-only`.** This rule was applied without
  relaxation and it changed answers; see [Where the rule bit](#where-the-rule-bit).
- **`advisory`** — openly guidance to the model, claiming no enforcement.
  Legitimate, not a defect.

Four independent auditors ran the searches. Nothing below is classified from
belief; every `wired` row in the source inventories carries the search that
established it.

### Headline table

| orchestrator | mechanisms | wired | prose-only | advisory |
|---|---:|---:|---:|---:|
| `review-orchestrator` | 112 | 68 | 11 | 33 |
| `flow-orchestrator` | 79 | 43 | 9 | 27 |
| `job-orchestrator` | ~201 | ~74 | ~27 | ~100 |
| `task-implementer` | 88 | 2 | 60 | 26 |

`job-orchestrator`'s row is approximate and is marked so deliberately — see
[The weakest leg](#the-weakest-leg-is-the-headline-number). The other three are
exhaustive enumerations.

### Before and after

| | August 2026 baseline | 2026-08-31 | like-for-like? |
|---|---|---|---|
| `review-orchestrator` | **2 of ~10** mechanisms enforced | **68 of 112** | **No** — denominator changed 10 → 112 |
| `flow-orchestrator` | task gate claimed, `taskGateStatus()` unwired; **34 unfinished tasks across 24 flows** | gate wired; **34 unfinished tasks across 24 flows — unchanged** | **Yes** |
| `job-orchestrator` | **6 wired of 217**; §2.4.1–2.8 scored **0** | **~74 of ~201**; the same core now ~35 | Partly — see below |
| `task-implementer` | never inventoried | **2 of 88** | No prior; this is a new baseline |

The four pairs, stated plainly: **2/~10 → 68/112**, **34-across-24 → 34-across-24**,
**6/217 → ~74/~201**, and **(none) → 2/88**.

---

### `review-orchestrator` — 2 of ~10 → 68 of 112

**The denominators are not comparable and the ratio should not be quoted.** The
August figure counted roughly ten headline mechanisms. This inventory enumerated
112 at a much finer grain. 2/10 = 20% against 68/112 = 61% is not a measurement
of a 41-point improvement; it is two different questions. What *is* comparable is
the list of named mechanisms, and that list did move.

**The two August-enforced mechanisms, re-checked:**

1. **`class_scope` required for blocker/major — still wired, and tightened.**
   `src/gdskills/contracts/review-finding.schema.json:161-165` carries the
   `if`/`then`; enforcement throws at `src/review/managed.ts:376-399`, reached
   from `keryx review start` / `keryx review ingest`
   (`src/commands/review.ts:302-309, 363-391`). Originally `345eaa55` (#218);
   hardened by `2fc9f1b0`, whose own comment (`managed.ts:390-392`) records that
   the previous check was a shape check over prose, so a `major` that merely
   *named* `class_scope` in sentences passed and was persisted without one.

2. **`prior_findings` required on fix rounds — fails the strict test.** The rule
   lives in `reviewer-input.schema.json:227-237`. No production `.ts` file loads
   that schema. `keryx ctx rg "is_fix_round" src` returns hits only in the schema
   itself, `*.test.ts` files, and other `SKILL.md` prose — zero production
   TypeScript. `reviewer-input` is not in the `CONTRACTS` registry
   (`src/gdskills/contracts.ts:72-105`, six names), so
   `keryx skills contracts validate` cannot target it either. Reviewer dispatch
   is a host-agent action, not a `keryx` CLI call, so nothing can reach this
   validation automatically. **`SKILL.md:538` says "the schema rejects the
   dispatch otherwise". It does not.**

So one of the two baseline mechanisms was never `wired` by the rule this
programme adopted. The honest August number is **1 of ~10**, not 2 — and that
correction is a finding about the baseline, not about the fix.

**Newly wired since August, each attributed:**

| mechanism | evidence | commit |
|---|---|---|
| Deterministic pre-filter: 5 drop classes + whitespace/comment-only hunks + ±20-line bound, every drop recorded with a reason | `src/review/scope.ts:78-85, 207, 325-381, 1010-1031`; entry `src/commands/review.ts:311 → runScope:1404` | `f42758b6` |
| Blast radius from `gdgraph affected`, depth 2, cap 40, recompute decision, scope-B rejection reasons; ingest **refused** when a scope-B finding arrives without the record | `src/review/blast-radius.ts:96, 107, 110, 566-615, 646-648`; refusal `src/review/managed.ts:482-508` from `createManagedReviewPackage:273` | `26e91824` |
| Per-reviewer findings cap 10, blockers exempt | `src/review/caps.ts:56, 143-147`; called `src/review/managed.ts:275` | `9f425d9f` |
| Reviewer concurrency cap 4 | `src/review/caps.ts:359`, `planReviewerWaves` at `src/commands/review.ts:582` | `9f425d9f` |
| Spend ceiling $3, non-zero exit at the ceiling | `src/review/caps.ts:247`; `runBudget` `src/commands/review.ts:572-620` | `9f425d9f` |
| Loop detection on recurring finding identity, deliberately ignoring remaining budget | `src/review/loop.ts:106, 271`; `src/commands/review.ts:1175` | `9f425d9f`, fixed `860535e3` |
| `review-verifier` replacing `review-strict`; a verifier can only delete — a claim carrying extra fields is discarded whole | `src/review/verification.ts:200-211`; `review-strict/` absent from `bundled/skills/review/` | `0300e353` |
| `verification_mode` off/annotate/filter | `src/commands/review.ts:383, 1386`; `src/review/managed.ts:234` | `0300e353` |
| Dismissal taxonomy; `false_positive` now actually assigned; only `dismissed-incorrect` counts as model error | `src/review/types.ts:28-35, 133-142`; `MODEL_ERROR_STATES` `src/review/review-notes.ts:53`; mapping `src/review/managed.ts:1207` | `63b340d1` |
| `.metaproject/memory/review-notes/` written by the pipeline | `writeReviewNotes` `src/review/managed.ts:432` ← `completeManagedReview` ← `src/commands/review.ts:1696` | `63b340d1` |
| External PR comments: collect per round, `--sha` required, two-sentence brevity cap, reply cap 30, `--final` only, resolve/hide unreachable | `src/review/pr-comments.ts:70, 143-153, 617-654, 1018-1099, 1642-1646` | `26e91824` |
| Model tier computed at runtime, no model name in the command | `runTier` `src/commands/review.ts:626+`; `dispatchModelBlock:800-808` emits `{inherit:true}` when unresolved | `26e91824` |
| Disposition + citation cannot be overwritten by a later close | `src/review/managed.ts:1259-1279` | `26e91824` |
| Unrecognised CLI option refused rather than ignored | `rejectUnknownFlags` `src/commands/review.ts:277-288` | `26e91824` |
| `keryx:findings` fence: exactly one block, indentation rule, null/non-array refusal, unknown properties dropped not rejected | `src/review/managed.ts:1315, 1325-1378, 1028-1090` | `df1e6234`, `2fc9f1b0` |
| Canonical severity rubric, one table, Iron Laws in every reviewer | `## Severity (canonical)` `review-orchestrator/SKILL.md:1054`; guard `src/gdskills/review-skills-iron-laws.test.ts` | `9f425d9f` |
| `--greptile` route and the `src/**/*.ts` frontend-conventions trigger removed | `--greptile` absent from the tree | `75da0db7` |

**Not delivered, despite being specified:**

- **Confidence as a number in [0,1] with a 0.7 gate (roadmap §2.4) does not
  exist.** `confidence` is `"high" \| "medium" \| "low"` in
  `src/review/types.ts:346` and
  `src/gdskills/contracts/review-finding.schema.json:105`. No `0.7` threshold
  exists anywhere in `src/review` or `src/gdskills`.
- **Stack scoping is a half-finished fix.** `keryx review stack` works — run
  here it excludes `review-backend`, `review-frontend` and
  `review-frontend-conventions` with reasons — but `src/review/stack.ts:43-48`
  states in its own docstring that wiring the answer into
  `review-orchestrator`'s dispatch decision is a follow-up. Dispatch-time
  protection is still prose.
- **Memory search, described in `SKILL.md` as "required, not best-effort", is
  unenforced.** `keryx ctx rg "memory search|memory\.search|keryx memory"` over
  `src/commands/review.ts` and `src/review/managed.ts` returns **0 matches**.
  Nothing records `searched: true/false` or blocks context assembly.
- **The propose/apply separation for skill learning is trust, not a guard.**
  `applyLearningProposalCommand` (`src/commands/skills.ts:749-776`) takes no
  caller or origin parameter, so "never run `skills learn apply` from the
  reviewer" cannot be enforced.
- **`publish_pr_review_report`** is declared in `input-contract.schema.json:89`
  and read by no runtime code.

---

### `flow-orchestrator` — the false sentence is now true, the debt is not paid

**The claim is wired.** `keryx flow complete <id>` →
`src/commands/flow.ts:456` → `src/flow/service.ts:380 complete()` →
`:448 gates.push(taskGate(flow))` → `service.ts:726 taskGate()` →
`src/flow/machine.ts:129 evaluateTaskGate()` → `:136 taskGateStatus()`.
No test file appears anywhere in that chain. In August, `taskGateStatus()`'s
only caller was its own test and `machine.ts:36` carried the comment
*"Deliberately NOT wired into `service.complete()`."* Commit **`ad15cd4b`**.

**`complete()` went from four gates to six** (`src/flow/service.ts:380-539`):
acceptance-criteria (`:394`), pull-request/main-merge (`:416`), **tasks**
(`:448`, new — `ad15cd4b`), **review** (`:454`, new — `26e91824`), health
(`:476`), security (`:492`). Failing gates return the flow to `in-progress`
(`:526-536`).

The gate refuses more than "not done": `disposition: "failed"`
(`machine.ts:53`), `"blocked"` (`:94-96`), `"skipped"` **without a recorded
reason** (`:67-69`), and any unrecognised disposition (`:98-107`) all fail. The
`--disposition skiped` typo bypass is closed by strict validation at
`src/commands/flow.ts:57-73` (`cd927cd1`).

**The review gate's five conditions** are `ingested-round`,
`terminal-dispositions`, `head-commit`, `external-comments`, `verifier-stats`
(`src/flow/review-gate.ts:1125-1131`), each `pass | violated | unobserved`
(`:1139`) — **and `unobserved` fails**. A gate that passes because nothing was
recorded is precisely what it was built to remove.

**What did not improve — measured, not assumed.** Re-counted directly over
`.metaproject/flows/*/flow.json`:

| | August | now |
|---|---|---|
| done flows | 184 | **190** |
| done flows carrying ≥1 unfinished task | 24 | **24** |
| unfinished tasks in those flows | 34 | **34** |
| flows with any non-zero `attempts.count` | 3 | **3** (`003`, `004`, `117` — all July) |

The historical debt is **exactly unchanged**. Both gates are opt-in per package
via `gates.tasks` / `gates.review`, written by `flow init`
(`src/flow/service.ts:164`); a package created before they existed has no flag
and reports `skipped`. That was a deliberate design choice — turning them on
retroactively would invalidate 24 completed packages — but the consequence is
that **nothing re-audits or reports the 24**. They remain silently open.

**The forward-looking number, with its own confidence stated.** Seven packages
carry `gates.tasks: true` (202–208); six are done, and **none carries an open
task**. But the August violation rate was 24/184 = 13.0%, so six clean
completions is an expected 0.78 violations avoided. **Observing 0 in 6 is not
statistically distinguishable from the baseline rate.** The gate is provably
wired; it is not yet provably effective.

---

### `job-orchestrator` — 6 of 217 → ~74 of ~201

Commit **`6a9d611c`**, "make job-orchestrator's claims true".

**The one number that is exact and decisive: `keryx job` now exists.**
`src/commands/job.ts`, registered at `src/cli.ts:78`, with verbs `init`,
`status`, `step`, `document`, `complete`, `list`, backed by `src/job/service.ts`,
`src/job/machine.ts`, `src/job/store.ts` and `src/job/plans.ts`. Every write is
validated against the schema now registered as the contract
`job-orchestrator-state` (`src/gdskills/contracts.ts:78-84`) and loaded in
production at `src/job/store.ts:81`. `keryx skills contracts list` now returns
**six** contracts where the audit found five.

**Sections 2.4.1–2.8 no longer score zero.** The implement/review/fix/verify
core (now §2.5–2.8) reaches roughly 35 wired mechanisms, each resolving to a
handler in `src/commands/review.ts` or `src/commands/job.ts` reached from
`src/cli.ts`.

**The five builds are reconciled.** All five `SKILL*.md` are 2189 lines and
byte-identical; `src/gdskills/build-parity.test.ts` enforces it by name with an
**empty** allow-list, over both the bundled tree and the `.metaproject` mirror,
and passes.

**Dangling references, row by row:**

| baseline finding | now |
|---|---|
| `code-boss-review` as default reviewer | **removed**, 0 matches in the repo |
| `code-review` as default `review_mode` | **mostly removed** — but `SKILL.md:302` still carries `agent: "code-review"` in the §1.1 plan JSON, while `:950` and `:1894` state it is gone |
| `wave-executor` | **denied in job-orchestrator** (`SKILL.md:733`) — but still described as real in 4 places in `task-implementer/orchestrator-prompt.md`, the file §2.5 tells the reader to load |
| `subagent_type: "general"` | **fixed**, only `general-purpose` |
| `.metaproject/scripts/detect-models.sh` | **fixed**, 0 references |
| unnamespaced `skills/<name>/SKILL.md` | **fixed** |
| step `CHECKS` | **fixed** |

**Impossible claims and internal contradictions.** All of the baseline's
"cannot be true in this execution model" items (the 60-second default,
`total_job_timeout`, statuses `paused`/`timeout`, five persisted fields illegal
under `state.schema.json`) are removed, and two are pinned by a real end-to-end
test at the CLI (`src/job/job.e2e.test.ts:490`). All seven internal
contradictions — duplicate 2.8.1, missing 2.5, §1.1 vs §1.3, the 3-vs-2 fix
bound, `skip_confirmation` vs "Proceed?", `base_branch: "develop-2"`, three
severity vocabularies — are reconciled.

**Four of the five completion-gate conditions now pass**, against "fails every
one" at baseline. The exception is real: §2.6.3 instructs skipping FIX when only
`minor`/`info` findings remain, but the gate's default severity floor *is*
`minor` (`REVIEW_GATE_SEVERITY_FLOOR_DEFAULT`, `src/flow/review-gate.ts`), so
those findings never receive a terminal disposition and `terminal-dispositions`
blocks. A freshly-rewritten section contradicts the gate it was rewritten to
satisfy.

---

### `task-implementer` — 2 of 88, and no prior

The fourth orchestrator, never inventoried. **88 mechanisms: 2 wired, 60
prose-only, 26 advisory.** This has no "before"; it is a baseline, and it cannot
show improvement or regression.

Both `wired` rows are the *same* mechanism restated twice: `parseChildResult`
(`src/harness/child/contract.ts:160-176`) throws unless the first line is
`STATUS: <TOKEN>` from `CANONICAL_STATUS_TOKENS`, reached from production at
`src/harness/extension/execute.ts:167`. The entire six-phase core — RECEIVE,
RESEARCH, PLAN, IMPLEMENT, VERIFY, REPORT — has **zero** wired mechanisms,
matching what Phase 7 found in `job-orchestrator`'s core.

**It is not dispatched by any production code.** `"task-implementer"` appears in
`src/` as a job-plan *label* (`src/job/plans.ts:19,24`, used only for
`keryx job status` reporting), a catalogue registration
(`src/gdskills/catalog.ts:90`), test files, and prose in other `SKILL.md` files.
It runs only when a model, following another skill's prose, invokes it — and
`orchestrator-prompt.md:184` tells it to use `subagent_type: "general"`, which
no dispatcher accepts.

**The finding that matters most.** `SKILL.md` is 575 lines. `SKILL.codex.md`,
`SKILL.cursor.md`, `SKILL.opencode.md` and `SKILL.zed.md` are **413 lines and
byte-identical to each other** — a 162-line divergence, and
`keryx ctx rg "STATUS:"` over that directory returns **8 hits in `SKILL.md` and
zero in any other build**. The four non-Claude builds are missing the whole
`## Reporting Results` section: the Iron Law, the status vocabulary, the required
response format, and all three worked examples. So production code
(`parseChildResult`) parses a status line that the shipped skill never asks four
of five harnesses to emit. **On Codex, Cursor, OpenCode and Zed,
`task-implementer` is 0 of 88 wired.**

Declared `metadata.version` is `1.2.0` in `SKILL.md` and `1.0.0` in the other
four — so unlike `job-orchestrator` (where all five falsely declared 3.2.0) the
drift is *visible in the frontmatter*, and nothing looks. `task-implementer` is
also the only one of the four orchestrators whose `compatible_harnesses` omits
`claude` — on every build, including the one Claude loads.

**Other defects, all of the same classes Phase 7 named:**

- `input-contract.schema.json` / `output-contract.schema.json` exist and are
  **not** in the `CONTRACTS` registry — unchanged from the job-orchestrator
  finding.
- `output-contract.schema.json` has no `skill_drift` property while `SKILL.md`
  requires emitting one; the schema is `additionalProperties: false`.
- The self-fix bound contradicts itself: `SKILL.md:337` states an absolute
  "Maximum 3 self-fix attempts", while `:427` and `input-contract.schema.json`
  make it `{minimum: 1, maximum: 5, default: 3}`.
- `SKILL.md:457` says "Return the JSON result object as your final message";
  `:406` and `:479` say "No JSON in the response body".
- `fix_context.original_task_id` (singular, schema) vs
  `orchestrator-prompt.md:166` sending `original_task_ids` (plural array).
- Phase 5 hand-rolls `npm run lint` / `type-check` / `test` /
  `build-storybook`, which `code-verifier` already does and which
  `src/job/plans.ts` already schedules as the *next* step. keryx's own
  `package.json` defines none of those scripts.

---

### Where the rule bit

The "a call site found only in a `*.test.ts` is `prose-only`" rule changed three
answers, and all three changes were unfavourable:

1. **`prior_findings` on fix rounds** — the second of the two August "enforced"
   mechanisms. Schema-declared, test-validated, loaded by no production code.
2. **The round bound of 3.** `src/gdskills/round-bound.test.ts` pins the
   *sentence* in all builds of all three orchestration skills. No counter
   exists. `REVIEW_ROUND_CAP = 3` (`src/flow/review-gate.ts:86`) is read only at
   `:1213` and `:1511` to *phrase a message*; its own comment says so: *"This
   constant does not enforce the bound — nothing in `flow complete` dispatches a
   round."* Nothing refuses a fourth round.
3. **The Iron Laws and the canonical severity rubric.** Enforced by
   `src/gdskills/review-skills-iron-laws.test.ts` — a genuinely well-built guard
   that derives the laws from the canonical block rather than hardcoding them,
   takes its denominator from the filesystem, enumerates its exemptions with
   reasons, and refuses self-exemption by shape. It is still a test over
   markdown: it makes the prose impossible to change silently; it does not make
   a reviewer follow it.

This is not an argument against those guards — CI guards are how a text
regression is caught. It is an argument against counting them as `wired`, which
is what the August study did and what produced "2 of ~10".

---

### The instruments, and what each answered

Each was **run**, not read.

| instrument | what it answered that August could not |
|---|---|
| `keryx skills verify --bundled` | Structural evaluation of the shipped tree: `skills_evaluated: 65`, `findings: 0`, 12 checks including `xref:skill` and `xref:path`. August had to leave "are there more dangling references?" open; the `xref:path` check now answers it for the 65 `SKILL.md` files. The command also prints its own limits: layers 2 (LLM judge) and 3 (Monte-Carlo reliability) are not built, and "a clean report here is not a quality claim." |
| `filter_stats` | Distinguishes **measured zero** from **not measured** — the defect that made the August precision corpus read as 100% precise. Producer `src/review/managed.ts:915`; consumer `src/commands/review.ts:1636-1653`. |
| The review gate's five conditions | Turns "did this flow close over open findings?" from unanswerable into a gate outcome, with `unobserved` failing separately from `violated`. |
| `build-parity.test.ts` | Answers "have the five builds diverged?" — for `job-orchestrator`. See below for its denominator. |
| `round-bound.test.ts` | Answers "do the four repair bounds agree?" — three unified at 3, `/goal --auto` deliberately 8 with the reason in the file that carries the constant. |
| `bundled-no-persona.test.ts` | Answers "does the shipped tree name a person or a home directory?" — no, and re-adding one fails. It states its own hole: it cannot notice a *new* persona under a new name. |

**`filter_stats`, actually read.** Exactly **one** round on disk carries it
(`.metaproject/flows/207-.../reviews/2026-08-30-phase5/manifest.json`):
`total: 6, retained: 6, dropped_refuted: 0, dropped_findings_cap: 0` — and **four
of six stages `null` with a recorded reason**, including *"no `--scope` was
supplied to this ingest. Nothing ran, so nothing is known — this is NOT
`dropped 0`."* The instrument works exactly as designed, and what it reports is
that the pre-filter did not run on the only round that could report it. It also
independently confirms the un-delivered confidence gate: `dropped_low_confidence`
is `null` because *"this pipeline has no confidence threshold."*

---

### What got worse, or did not move

Reported with the same prominence as the improvements, per AC6.

1. **`keryx skills verify --bundled` does not work from an installed copy.**
   Run against the published 0.2.72 global install it prints
   `skills_evaluated: 0`. `defaultBundledRoot()` is
   `path.join(import.meta.dir, "bundled")`
   (`src/gdskills/bundled-eval.ts:397`); in the built CLI `import.meta.dir` is
   `dist/`, and the 65 skills ship at `src/gdskills/bundled/`. The guard test
   cannot catch it: `src/commands/skills.bundled-verify.test.ts:40` asserts
   `skills_evaluated: 65` from the repo tree. **The flagship Phase 5 instrument
   is unrunnable for every user who installed it.** It did refuse to call the
   empty result clean — *"NOTHING WAS EVALUATED"* — which is the design working
   and is the only reason this is a defect rather than a false pass.

2. **Build parity is enforced on 1 skill of 37.** A census of
   `src/gdskills/bundled/skills`: **37 skills ship harness builds; 36 still
   differ from their own `SKILL.md`.** The single clean one is
   `job-orchestrator` — exactly and only the member of `PARITY_ENFORCED_SKILLS`.
   The guard's own comment is honest about this ("Absence from this list is a
   backlog entry, NOT an exemption"), but the measured outcome is that the
   worst instance found — `task-implementer`, 162 lines and two version numbers
   adrift, missing its entire reporting contract — sits outside the guard's
   denominator. The divergence the guard *does* catch was 33 lines.

3. **The 65-skill sweep never reads a harness build.** `bundledSkillFiles`
   (`src/gdskills/bundled-eval.ts:378-393`) pushes only `entry.name ===
   "SKILL.md"`. The tree holds **65 `SKILL.md` and 111 harness builds**. So
   `skills_evaluated: 65` is 65 of **176** shipped skill documents, and the
   `xref:path` clean result says nothing about the 111.

4. **`cross_family_review` shipped with no consumer — in the commit that
   forbade exactly that.** Flow 207's AC3 reads: *"A field nothing reads is the
   `attempts.count` defect repeated, and this flow exists to stop that class."*
   `filter_stats` got a consumer. `cross_family_review` did not:
   `keryx ctx rg "cross_family_review" src` returns 6 hits, all in
   `src/commands/providers.ts` (which emits it, `:598`, `:661`) and its own
   test. `keryx review ingest` has no flag to accept it. The command computes
   and prints a correct, opt-in, recorded decision; nothing reads it back.

5. **The attempt counter is wired and unused.** `keryx flow task attempt` works
   (`src/commands/flow.ts:388-396` → `src/flow/service.ts:304`, incrementing at
   `:315`). **Zero of the seven flows completed since it shipped have called it
   once.** The failure moved from "code never increments it" to "nothing calls
   the code that increments it" — the same practical blindness, one layer down.

6. **`dependsOn` is the same defect, still live.** Written at
   `src/flow/service.ts:253`, migrated at `src/flow/store.ts:175-176`, typed at
   `src/flow/types.ts:64,237` — and read by nothing. `flow-orchestrator`'s
   documented "resume at the first task not done, respecting `dependsOn` order"
   has no code behind it.

7. **A dangling reference was reintroduced while dangling references were being
   removed.** `job-orchestrator/SKILL.md:302` still carries
   `agent: "code-review"` in the §1.1 plan JSON, contradicting `:950` and
   `:1894` in the same file. And `wave-executor`, denied at `:733`, is still
   described as real in four places in
   `task-implementer/orchestrator-prompt.md` — the file §2.5 instructs the
   reader to load.

8. **Two new doc/code mismatches arrived with the new subsystem.**
   `job-orchestrator/SKILL.md:1755` claims `keryx job list --json` filters by
   phase; `src/job/service.ts:278-299` returns every job unconditionally.
   `SKILL.md:2111,2139` instruct writing `post-mortem.md`, but `DOCUMENT_TYPES`
   (`src/job/types.ts:40-45`) has four values and no `post-mortem`, so it is the
   one artifact `keryx job document` cannot record.

9. **`review-orchestrator`'s own false sentence is still there.**
   `SKILL.md:538` — "the schema rejects the dispatch otherwise" — asserts an
   enforcement that does not exist, which is the same class of statement as the
   `flow-orchestrator` sentence that started this programme.

10. **Loop detection shipped broken.** Introduced in `9f425d9f`, it could never
    fire because of an identity mismatch, and passed 18 of 18 tests anyway.
    Fixed in `860535e3`. It is working now; it is recorded here because "looked
    wired, wasn't, and the tests agreed" is the failure mode this whole
    programme is about, and it recurred *inside* the programme.

11. **`README.md`'s status block is stale.** It still reads "Phases 0 and 1
    delivered in 0.2.70… Phases 2 through 7 are specified and not started."
    All seven shipped.

---

### The weakest leg is the headline number

`job-orchestrator`'s `~74 / ~201` is the least trustworthy figure in this
document and should not be quoted without this paragraph. The re-inventory was
done by four agents over mapped line ranges, doing full-text passes with real
per-range search evidence — **not** a one-for-one re-classification of each of
the original 217 items. Advisory counts in particular are representative rather
than exhaustive. The structural claims are solid and independently checkable
(`keryx job` exists; the core is no longer zero; five builds are byte-identical;
the dangling-reference table was verified row by row, and two rows came back
*negative*). The precise arithmetic is not.

More generally: **three of the four denominators changed between the two
measurements.** `review-orchestrator` went from ~10 counted mechanisms to 112;
`job-orchestrator` from 217 to ~201; `task-implementer` had none. Only
`flow-orchestrator`'s task-debt figure (34 across 24) is a true like-for-like
number — and it did not move.

---

### What these numbers do and do not establish

**They establish:**

- That named, previously-false claims are now true, each traceable to a commit:
  the task gate (`ad15cd4b`), the review record surviving a round (`df1e6234`),
  the pre-filter (`f42758b6`), the verifier (`0300e353`), caps and one severity
  rubric (`9f425d9f`), deep rounds and the completion gate (`26e91824`),
  `keryx job` (`6a9d611c`), and `filter_stats` (`63b340d1`).
- That `job-orchestrator`'s builds cannot silently diverge again, and that its
  audited defect list is mostly closed, with two verified exceptions.
- That `task-implementer` now has a baseline: 2 of 88 on Claude, 0 of 88
  everywhere else.
- That the instrumentation refuses to report a clean result it did not earn —
  the empty-tree message, `filter_stats`'s `not_measured` array, and the review
  gate's `unobserved` status are three independent implementations of that rule.

**They do not establish:**

- **Any improvement in review quality.** No precision, recall or usefulness
  figure is claimed. Flow 202's baseline explains why the historical corpus
  cannot produce one, and the instrumented replacement has **n = 1 round**, in
  which four of six stages did not run.
- **That the gates prevent anything in practice.** Six gated completions with
  zero violations, against a 13.0% baseline rate, is an expected 0.78 violations
  avoided. That is not evidence of effect.
- **That the historical debt was addressed.** 34 unfinished tasks across 24
  flows on 2026-08-30; 34 across 24 today.
- **That the shipped skills are good.** `keryx skills verify --bundled` is
  layer 1 of 3 by its own statement, covers 65 of 176 shipped skill documents,
  and returns 0 from an installed copy.
- **That the non-Claude harnesses work.** Nothing in production delivers a
  bundled skill's non-Claude build to a non-Claude harness;
  `keryx skills export orchestration/job-orchestrator --runtime codex` returns
  "Project skill not found". The builds are reconciled; they are not consumed.

**A note on this measurement's own method.** It was asked to find bad news if
bad news existed, and it did — eleven items, including a broken flagship
instrument, a no-consumer field shipped in the commit that banned them, and a
correction *downward* to one of the two numbers the August baseline claimed. A
self-measurement returning only good news should be distrusted; this one does
not, which is weak evidence that the method held. It is weak because the same
programme wrote both the instruments and this report, and the strongest finding
here — `task-implementer` — was found only because it was the one orchestrator
nobody had looked at.

---

### Sources

- Baseline: `.metaproject/flows/205-2026-08-30-audit-job-orchestrator-the-oldest-orches/inventory.md`
- Baseline: `.metaproject/flows/202-2026-08-29-review-precision-measure-the-baseline-fi/baseline.md`
- Baseline: [README.md](README.md) §The measured baseline; [roadmap.md](roadmap.md); [specification.md](specification.md)
- Releases: 0.2.70 (`003569cd`), 0.2.71 (`a75af921`), 0.2.72 (`eb987aa2`)
