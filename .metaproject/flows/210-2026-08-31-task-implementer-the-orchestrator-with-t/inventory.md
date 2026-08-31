# task-implementer — mechanism inventory

Reproduction of the 2026-08-31 measurement's `2 wired of 88`, over
`src/gdskills/bundled/skills/orchestration/task-implementer/` and its
byte-identical `.metaproject` mirror: five 575-line builds, `orchestrator-prompt.md`
(206), `input-contract.schema.json` (204), `output-contract.schema.json` (51),
`task-request.template.md` (111).

## The classification rule, applied without relaxation

- **`wired`** — a production `file:line` **and** the entry point that reaches it.
  For a skill, the entry point is a named `keryx` command whose implementation
  performs or refuses the claimed thing; the model runs the command, and the code
  behind it is what makes the claim true.
- **`prose-only`** — nothing in code makes it happen. **A call site found only in
  a `*.test.ts` counts as `prose-only`.**
- **`advisory`** — openly guidance to the model about its own behaviour, claiming
  nothing about the system ("read the target files", "follow the module
  patterns"). Legitimate, not a defect.

The line between `advisory` and `prose-only`, stated because it is where a
count can be inflated: an instruction is `advisory`; a **statement about the
system** is `prose-only` when false. "Read each target file" is advisory. "The
schema validates this", "created automatically", "the orchestrator ensures
order", "otherwise ABORT" — each asserts that something outside the model acts,
and is `prose-only` when nothing does.

## Totals

Counted at the row grain of the enumeration below: 109 rows, each one a step,
gate, cap, bound, required artifact, refusal, hand-off, or sentence asserting
that something is enforced, recorded or validated.

One sub-rule, stated because it decides several rows: **a frontmatter field that
declares rather than asserts** (`triggers`, `agent_worthy`, `version`,
`description`) is `advisory`. It says what the skill is; it does not claim that
anything checks it. `compatible_harnesses` is the exception and was
`prose-only`, because its value was *false*: it named four harnesses and omitted
`claude`, the one that loads the primary build.

| file | rows | wired before | prose-only before | advisory before | wired after | prose-only after | advisory after |
|---|---:|---:|---:|---:|---:|---:|---:|
| `SKILL.md` ×5 (counted once) | 74 | 6 | 31 | 37 | 28 | 0 | 46 |
| `orchestrator-prompt.md` | 15 | 1 | 13 | 1 | 8 | 0 | 7 |
| `input-contract.schema.json` | 12 | 0 | 12 | 0 | 12 | 0 | 0 |
| `output-contract.schema.json` | 4 | 0 | 4 | 0 | 4 | 0 | 0 |
| `task-request.template.md` | 4 | 0 | 4 | 0 | 3 | 0 | 1 |
| **total** | **109** | **7** | **64** | **38** | **55** | **0** | **54** |

**109 mechanisms, not 88, and 7 wired, not 2.** Both differences are stated
rather than smoothed:

1. **+21 rows.** The measurement enumerated `SKILL.md` and the two contracts.
   This inventory also enumerates `task-request.template.md` (4 rows) and splits
   at a finer grain in three places: the `automation` object as six settings
   rather than one, the five Phase 1.4 `ASSERT` lines as five refusals, and the
   six `wave-executor` mentions in `orchestrator-prompt.md` as six claims. No
   verdict changes — every added row was `prose-only` before, for the same reason
   the contracts were.
2. **+5 wired.** The measurement's two `wired` rows are the `STATUS:` contract,
   which this inventory also scores as two (rows 72 and 73). The five it did not
   credit each name a real command or a real build guard:
   - row 1, `name: task-implementer` — `src/gdskills/catalog.ts:90`, enforced by
     `catalog:registered` in `src/gdskills/bundled-eval.ts`, entry
     `keryx skills verify --bundled`.
   - row 2, `model_tier: standard` — `src/gdskills/model-tier.ts:768`
     (`SKILL_TIER_KEY`), enforced at build by `src/gdskills/bundled-eval.ts:602`
     (`model:concrete-declaration`), same entry.
   - row 28, `keryx skills route <target>` — `src/commands/skills.ts`, entry
     `src/cli.ts`; pinned by `src/commands/skills-route.test.ts`.
   - row 29, `keryx skills verify <module>/<skill>` — `src/gdskills/verify.ts:64`,
     which returns exactly the `fresh|stale|needs-review|blocked` vocabulary
     §2.0b quotes.
   - row 88, `subagent_type: "general-purpose"` — a real dispatcher type, and
     `src/gdskills/agent-catalogue-xref.test.ts` fails the build on a dispatch
     position naming anything else.

   So the honest baseline is **7 of 109 (6.4%)**, against the measurement's
   **2 of 88 (2.3%)**. The correction makes the before-number better and is
   recorded because that is what reproducing a measurement means.

**The six-phase core — rows 13-66, RECEIVE through REPORT — scored 2 of 54
before**: §2.0b's `keryx skills route` and `keryx skills verify`, and nothing
else. The `STATUS:` rows sit in `## Reporting Results`, outside the phases. It
scores **20 of 54** now.

**Resolution split for the 64 prose-only rows: 48 wired, 16 claims deleted.**
Nothing was resolved by softening a verb.

---

## `SKILL.md` — 74 mechanisms (rows 1-74)

### Frontmatter

| # | claim | needs to be true | before | search | after |
|---|---|---|---|---|---|
| 1 | `name: task-implementer` | the name resolves to a catalogued skill | **wired** — `src/gdskills/catalog.ts:90`; `catalog:registered` in `bundled-eval.ts`, entry `keryx skills verify --bundled` | `keryx ctx rg "task-implementer" src --glob '!*.md'` | wired |
| 2 | `model_tier: standard` | a tier, not a model id, and something reads it | **wired** — `model-tier.ts:768`, guard `bundled-eval.ts:602` | same | wired |
| 3 | `description` | the harness routes on it | advisory — routing is the host harness's, outside this tree | — | advisory |
| 4 | `triggers:` (5 phrases) | the host harness matches them | advisory — a declaration, not an enforcement claim; no `src/` consumer, and `keryx skills route` routes *project* skills rather than bundled triggers | `keryx ctx rg "triggers" src --glob '!*.md'` | advisory, unchanged; see "What this flow did NOT fix" |
| 5 | `agent_worthy: true` | a dispatcher consults it | advisory — a declaration; zero `src/` consumers | `keryx ctx rg "agent_worthy" src` (hits only in `.mdc` and docs) | advisory, unchanged; see "What this flow did NOT fix" |
| 6 | `compatible_harnesses: "cursor,codex,zed,opencode"` | those are the compatible harnesses | **prose-only and false** — omits `claude`, the harness that loads the primary build | `keryx ctx rg "compatible_harnesses" src --glob '!*/bundled/skills/**'` | **claim deleted and replaced with the true one** — `claude` added; advisory after, pinned by `task-implementer-contract.test.ts` |
| 7 | `version: "1.2.0"` | it tracks the content | advisory — a declaration; nothing compares declared version to content in any skill | — | advisory; bumped to `1.3.0` to match the change, still unchecked (see NOT fixed) |

### Purpose / When to Use

| # | claim | before | after |
|---|---|---|---|
| 8 | "Commits its changes to a shared feature branch managed by the orchestrator" | advisory | advisory |
| 9 | "**Input:** JSON task object + workspace context" | **prose-only** — the shape existed in a contract nothing could load | **wired** — `keryx skills contracts validate … --schema task-implementer-input` |
| 10 | "**Output:** JSON result object …" | **prose-only** — same, and the schema refused its own skill's output | **wired** — `--schema task-implementer-output` |
| 11 | 3 "When to Use" bullets | advisory | advisory |
| 12 | "Architecture: 6 Phases" | advisory | advisory |

### Phase 1 — RECEIVE

| # | claim | needs to be true | before | after |
|---|---|---|---|---|
| 13 | 1.1: the task object carries these 13 fields | a schema declares them | **prose-only** — declared in a contract nothing could load; `test_case_specs` was in the prose and **absent from the schema** | **wired**; `test_case_specs` added to the contract |
| 14 | 1.1: `dependencies: … (already satisfied — orchestrator ensures order)` | something orders dispatch | **prose-only** — `src/job/plans.ts` orders *plan steps*; nothing orders tasks inside the `implement` step | **claim deleted** — now "array of task_id strings this task reads from"; the unsatisfied-dependency case is already handled by the Error Handling row and the `BLOCKED` worked example |
| 15 | 1.2: workspace carries 4 fields | a schema declares them | **prose-only**; `job_name`/`context_path` were used by the skill and absent from the schema | **wired**; both added |
| 16 | 1.3: `original_task_id` (singular) | it matches what the dispatcher sends | **prose-only and contradictory** — `orchestrator-prompt.md:166` sends `original_task_ids`, a plural array | **wired** — schema is `original_task_ids: array, minItems 1`; prose, template and prompt all agree |
| 17 | 1.3: `iteration: … (1 or 2)` | it matches the one repair bound | **prose-only and contradictory** — a fourth bound against everyone else's 3 | **wired** — `maximum: 3`, and `maximum` now enforced by the validator |
| 18 | 1.4 `ASSERT task_id IS NOT EMPTY → ABORT` | something refuses | **prose-only** | **wired** — `task.required` + `task_id.pattern` |
| 19 | 1.4 `ASSERT task_type IN valid_types → ABORT` | " | **prose-only** | **wired** — `task_type.enum` |
| 20 | 1.4 `ASSERT target_files IS NOT EMPTY → ABORT` | " | **prose-only** — and `minItems: 1` was in the schema while the validator **silently ignored the keyword** | **wired** — `minItems` implemented in `src/gdskills/contracts.ts` |
| 21 | 1.4 `ASSERT codebase_path EXISTS → ABORT` | " | **prose-only** | **advisory, explicitly** — a schema cannot check the filesystem; the skill now shows the `test -d` it must run and says why the contract cannot |
| 22 | 1.4 `ASSERT branch IS NOT EMPTY → ABORT("Wrong branch checked out")` | " | **prose-only**, and the message did not match the assertion | **wired** (presence, `workspace.required`) + **advisory** (`git rev-parse --abbrev-ref HEAD` for the actual branch) |
| 23 | 1.5 TDD: read each file in `test_case_specs.test_files` | the field exists in the contract | **prose-only** — field absent from the schema | **wired** — declared, `minItems: 1` |
| 24 | 1.5 TDD: run them and confirm they FAIL | | advisory | advisory |
| 25 | 1.5 TDD: "if tests pass already → report `DONE_WITH_CONCERNS`" | | advisory | advisory |
| 26 | 1.5 TDD: "do not rewrite or delete them" | | advisory | advisory |

### Phase 2 — RESEARCH

| # | claim | before | after |
|---|---|---|---|
| 27 | 2.0 read `CONTEXT_PATH` if provided | **prose-only** — `context_path` was not in the contract | **wired** (declared) + advisory (the reading) |
| 28 | 2.0b `keryx skills route <target_file>` | **wired** — `src/commands/skills.ts`, entry `src/cli.ts`, pinned by `skills-route.test.ts` | wired |
| 29 | 2.0b `keryx skills verify <module>/<skill>` returns `fresh\|stale\|needs-review\|blocked` | **wired** — `src/gdskills/verify.ts:64` | wired |
| 30 | 2.0b "note the drift in `notes` so the orchestrator can trigger `skills learn`" | **prose-only** — the field it names is `skill_drift`, and `skill_drift` was **not in the output schema**, which is `additionalProperties: false` | **wired** — `skill_drift` declared; a result carrying it now validates |
| 31 | 2.0b "read-only and inline; do not spawn a subagent" | advisory | advisory |
| 32 | 2.1 read every target file in full (3 bullets) | advisory | advisory |
| 33 | 2.2 `If existing_tests is not "none"` | **prose-only and contradictory** — the schema types it `array`, default `[]`; `"none"` is not a legal value | **claim deleted**; the array semantics are stated and `additionalProperties`/`type` refuse the string |
| 34 | 2.3 read module neighbours (2 bullets + 5 sub-bullets) | advisory | advisory |
| 35 | 2.4 "Always load" 3 rules | advisory — all three files exist (`src/gdskills/bundled/rules/core/`) | advisory |
| 36 | 2.4 rule table by task type (6 rows, 11 distinct files) | advisory — every file exists | advisory |
| 37 | 2.4 "Load when detected" (4 rules) | advisory — all exist | advisory |
| 38 | 2.4 "Rules are located at: OpenCode / Cursor / Codex" | **prose-only and false** — three harnesses named, five builds ship; Claude and Zed are simply absent, and all five builds are byte-identical so every build told two of its readers nothing | **claim deleted and replaced with the true one**: `.metaproject/rules/core/` on every harness, Cursor mirrors it |
| 39 | 2.4 "Output of Phase 2: RESEARCH_SUMMARY" required artifact | **prose-only** — nothing consumes or checks it | advisory (a thinking aid, and now labelled as one by position) — see NOT fixed |

### Phase 3 — PLAN

| # | claim | before | after |
|---|---|---|---|
| 40 | "Self-validate — no orchestrator approval needed" | advisory | advisory |
| 41 | 3.1 `CHANGE_PLAN` artifact | **prose-only** — nothing reads it | advisory — see NOT fixed |
| 42 | 3.2 required-outputs table (6 rows) | advisory | advisory |
| 43 | 3.3 self-validation checklist (6 items) | advisory | advisory |

### Phase 4 — IMPLEMENT

| # | claim | before | after |
|---|---|---|---|
| 44 | 4.0 TDD Mode vs Standard Mode selection | **prose-only** — keyed on `test_case_specs`, absent from the contract | **wired** — the field is declared, so its presence is a fact the validator knows about |
| 45 | 4.1 implementation order, Standard (6 steps) | advisory | advisory |
| 46 | 4.1 implementation order, TDD (5 steps) — **and the heading is `4.1` twice** | advisory, with a numbering collision | advisory; collision left, see NOT fixed |
| 47 | 4.2 code standards (6 bullets) | advisory | advisory |
| 48 | 4.3 test standards (4 bullets) | advisory | advisory |
| 49 | 4.4 story standards (4 bullets) | advisory | advisory |
| 50 | 4.5 commit with `refs #<issue>` / `task: <task_id>` | advisory | advisory |
| 51 | 4.5 commit-type mapping (6 rows) | advisory | advisory |

### Phase 5 — VERIFY

| # | claim | before | after |
|---|---|---|---|
| 52 | 5.1 "Always run: `npm run lint`, `npm run type-check`" | **prose-only** — hard-codes a package manager and two script names in a skill shipped to arbitrary projects; `src/testing/service.ts:780` is the detection this reimplements | **wired** — `keryx health run --changed --source eslint,typescript` (`src/health/sources/eslint.ts`, `src/health/sources/typescript.ts`, entry `src/commands/health.ts` ← `src/cli.ts`) |
| 53 | 5.2 "`npm test`" | **prose-only** — same | **wired** — `keryx test run --changed --strict` (`src/testing/service.ts:756-780` detects bun/pnpm/yarn/npm and builds the argv) |
| 54 | 5.3 `npm run build-storybook` | **prose-only** — same | **claim corrected** — `<pm> run build-storybook`, `<pm>` being what 5.2 detected |
| 55 | 5.4 failure table row: "Fix automatically using `npm run lint:fix:changed`" | **prose-only** — a script name from one specific project | **claim deleted** |
| 56 | 5.4 "Maximum 3 self-fix attempts per verification step" | advisory — a budget for the model, with its evidence stated; `round-bound.test.ts:63` pins the sentence across all builds, which is a documentation guard, not an enforcement | advisory, unchanged (AC4-adjacent: `round-bound.test.ts` still passes) |
| 57 | 5.4 the evidence paragraph (two arXiv citations, Aider, OpenHands) | advisory | advisory |
| 58 | 5.4 "Stop earlier on repetition, whatever the count says" | advisory — pinned as text by `round-bound.test.ts:83` | advisory, unchanged |
| 59 | 5.4 ROLLBACK POLICY: "you MUST run `git reset --hard`" | advisory (an instruction), but an unscoped destructive one | unchanged — see NOT fixed |
| 60 | 5.5 re-commit fixes | advisory | advisory |

### Phase 6 — REPORT

| # | claim | before | after |
|---|---|---|---|
| 61 | 6.1 write the result to `<JOBS_ROOT>/<JOB_NAME>/results/<task_id>.json` | **prose-only** — `keryx ctx rg "results/" src --glob '!*.md'` returns three hits, none of them this path. Nothing creates, reads or checks it | **wired** — `keryx job document <JOB_NAME> --type implementation-report --file <that file>`, which **refuses when the file does not exist** (`src/job/service.ts` `document()`: "`--file` not found … Write the document first, then record it"), refuses an unknown `--type` (`src/job/store.ts:115`) and an unknown job, and on success appends the name to `state.documentation.documents_created` under a file lock. Entry `src/commands/job.ts:runDocument` ← `jobCommand` ← `src/cli.ts` |
| 62 | 6.1 the 16-field result JSON | **prose-only** — the schema was unloadable and lacked `skill_drift`, so a compliant result was refused by its own contract | **wired** — `keryx skills contracts validate … --schema task-implementer-output` |
| 63 | 6.1 "Set `skill_drift` from Phase 2.0b … the orchestrator uses this to decide whether to trigger `skills learn`" | **prose-only** — see #30 | **wired** (the field) + advisory (the orchestrator's decision) |
| 64 | 6.1 "do NOT run `learn` yourself" | advisory — and true: `keryx skills learn apply` refuses any target outside `.metaproject/project-skills/` | advisory |
| 65 | 6.2 "Do NOT include the full JSON block inline" | advisory, contradicted by Rule 10 | advisory, contradiction removed |
| 66 | 6.2 status classification `success→DONE` etc. | advisory | advisory |

### Automation Settings / Error Handling / Rules of Engagement / Red Flags

| # | claim | before | after |
|---|---|---|---|
| 67 | "The following settings control behavior" (7-row table) | **prose-only** — nothing reads them, and the table said `max_self_fix_attempts: 1-5` while §5.4 said 3 | **claim deleted; replaced by a pointer to the one declaration** (`input-contract.schema.json`, `automation`), which §1.4 now validates. AC5 instance |
| 68 | Error Handling table (7 rows) | advisory | advisory |
| 69 | Rules of Engagement 1–9 | advisory | advisory |
| 70 | Rule 10: "Return the JSON result object as your **final message**" | **prose-only and false** — contradicts §6.2, `## Reporting Results` and `parseChildResult`, which throws on any first line that is not a canonical STATUS token | **claim deleted**, replaced with the STATUS rule and a note naming the contradiction |
| 71 | Red Flags table (5 rows) + IRON LAW | advisory | advisory |

### Reporting Results

| # | claim | before | after |
|---|---|---|---|
| 72 | "Every final response MUST begin with `STATUS: <STATUS>`" + Iron Law + status table + three worked examples | **wired — the one mechanism the measurement found.** `parseChildResult` (`src/harness/child/contract.ts:169-185, 200`) throws on a first line that is not `STATUS: <TOKEN>` from `CANONICAL_STATUS_TOKENS`, reached from production at `src/harness/extension/execute.ts:167`. Guarded across all five builds and both trees by `src/gdskills/status-contract.test.ts` | **wired, untouched, and re-pinned** — AC4 |
| 73 | "the fifth, `FAILED`, belongs to harness child workers and you must never emit it" | wired — `CANONICAL_STATUS_TOKENS` has exactly five, and `status-contract.test.ts` reads the set from production rather than restating it | wired |

### Job Context Awareness

| # | claim | before | after |
|---|---|---|---|
| 74 | `JOB_NAME` / `CONTEXT_PATH` may be supplied; read the context doc at the start of Phase 2 | **prose-only** — neither field was in the contract | **wired** (declared) + advisory (the reading) |

---

## `orchestrator-prompt.md` — 15 mechanisms (rows 75-89)

| # | claim | before | after |
|---|---|---|---|
| 75 | "Template used by `wave-executor` (dispatched by `job-orchestrator`)" | **prose-only** — no such agent. `job-orchestrator/SKILL.md:733` denies it exists; `src/job/plans.ts:19,29` names `task-implementer` for `implement` and `fix` with nothing in between | **claim deleted** and replaced with an explicit denial |
| 76 | "The wave-executor fills in the placeholders" | **prose-only** | **claim deleted** |
| 77 | Data Flow: "`[job-orchestrator]` → dispatches wave-executor per wave (not task-implementer directly)" | **prose-only** | **claim deleted** |
| 78 | Data Flow: "`[wave-executor]` → extracts tasks → fills template → Task(task-implementer) × N" | **prose-only** | **claim deleted** |
| 79 | Data Flow: "`[wave-executor]` → collects STATUS responses → returns compact WAVE_DONE summary" | **prose-only** — and `WAVE_DONE` is not in `CANONICAL_STATUS_TOKENS` | **claim deleted** |
| 80 | "## Parsing the Result (wave-executor)" + "the wave-executor must:" | **prose-only** | **claim deleted** |
| 81 | Step 1: extract 12 task fields + 4 workspace + 2 job-context | **prose-only** — the contract could not be loaded | **wired** |
| 82 | Step 1: "`dependencies` (already satisfied — dispatch in dependency_order)" | **prose-only** | **claim deleted** (the "already satisfied" half) |
| 83 | Step 2: four `ASSERT … → ABORT` lines | **prose-only** | **wired** — `keryx skills contracts validate … --schema task-implementer-input`, plus one explicit `test -d` for the filesystem fact a schema cannot check |
| 84 | Step 3/4: "Load the skill: task-implementer (from `skills/task-implementer/SKILL.md`)" | **prose-only** — that path has not existed since the tree was namespaced to `skills/gdskills/<category>/<name>/` | **claim deleted**, real path substituted |
| 85 | Step 4: fix task `"task_id": "fix-<ITERATION>"` | **prose-only and self-refuting** — the input contract's pattern was `^task-\d+$`, so every fix dispatch this file documents was one the contract would refuse | **wired** — pattern widened to `^(?:task\|fix)-\d+$` in both contracts, with the reason recorded in the schema |
| 86 | Step 4: `"original_task_ids": [ … ]` | **prose-only** — the schema said `original_task_id`, singular | **wired** — schema now plural |
| 87 | Step 4: "EXECUTION: Run to completion, return JSON result." | **prose-only and false** — the fix prompt asked for the exact output `parseChildResult` throws on, and never mentioned the STATUS line at all | **claim deleted**, replaced with the same EXECUTION INSTRUCTIONS as Step 3, naming `parseChildResult` |
| 88 | Example Task Tool Call: `subagent_type: "general-purpose"` | **wired** — `general-purpose` is a real dispatcher type, and `agent-catalogue-xref.test.ts` fails the build on a dispatch position naming anything else | wired |
| 89 | "Parsing the Result" steps 1–4 (read STATUS, extract summary, read result file only when needed, decide) | advisory | advisory + one wired hand-off: `BLOCKED` now states that the `implement` step stays open and `keryx job complete` refuses while it is (`src/job/service.ts` `complete()` → `evaluateJobGate`) |

---

## `input-contract.schema.json` — 12 mechanisms (rows 90-101)

Every row was **`prose-only` before for one reason**: the contract was not in the
`CONTRACTS` registry (`src/gdskills/contracts.ts`), so `keryx skills contracts
validate` could not name it, and no production `.ts` loads the file. It is
registered now as `task-implementer-input`, with `sourcePath` pointing at the file
that ships with the skill — the `job-orchestrator-state` precedent, so there is
no second copy to drift.

| # | mechanism | before | after |
|---|---|---|---|
| 90 | `required: [task, workspace, automation]` | prose-only | wired |
| 91 | `task.required` (6 fields) | prose-only | wired |
| 92 | `task_type.enum` (6 values) | prose-only | wired |
| 93 | `task_id.pattern` | prose-only, **and it refused `fix-<n>`, the id its own prompt builds** | wired, pattern corrected |
| 94 | `target_files.minItems: 1` | prose-only **twice over** — unloadable, and `minItems` was a keyword the hand-rolled validator silently ignored | wired; `minItems` implemented |
| 95 | `acceptance_criteria.minItems: 1` | same | wired |
| 96 | `workspace.required` (3 fields) | prose-only | wired |
| 97 | `issue_number.minimum: 1` | prose-only (unloadable; `minimum` was implemented) | wired |
| 98 | `automation.skip_confirmation.const: true` | prose-only | wired |
| 99 | `max_self_fix_attempts {minimum:1, maximum:5}` | prose-only, **and `maximum` was also silently ignored**, and 5 contradicted §5.4's 3 | wired; `maximum` implemented and set to 3 |
| 100 | `fix_context.iteration {minimum:1, maximum:2}` | prose-only; a fourth repair bound | wired; `maximum: 3` |
| 101 | closed shape | **absent** — no `additionalProperties: false` anywhere, so a request could carry any field and still read as validated | wired — `false` on the root, `task`, `workspace`, `fix_context`, `review_feedback[]`, `automation`, `test_case_specs` |

---

## `output-contract.schema.json` — 4 mechanisms (rows 102-105)

| # | mechanism | before | after |
|---|---|---|---|
| 102 | `required: [task_id, task_name, task_type, status]` | prose-only — unregistered | wired as `task-implementer-output` |
| 103 | `status.enum: [success, partial, failed]` | prose-only | wired |
| 104 | `additionalProperties: false` | prose-only, **and actively wrong**: `skill_drift` is required by `SKILL.md` §6.1 and was not declared, so the contract refused its own skill's compliant output | wired; `skill_drift` declared |
| 105 | `task_id.pattern: ^task-[0-9]+$` | prose-only, and refused `fix-<n>` | wired; widened with the reason recorded |

---

## `task-request.template.md` — 4 mechanisms (rows 106-109)

| # | claim | before | after |
|---|---|---|---|
| 106 | "Валидация: input-contract.schema.json" | **prose-only** — the sentence names a file that no command could load | **wired** — names `keryx skills contracts validate <request.json> --schema task-implementer-input` |
| 107 | "Все обязательные поля (\*) должны быть заполнены" | prose-only — nothing checked | wired, by the same command |
| 108 | `Original Task ID` (singular) | prose-only, and disagreed with the prompt | claim corrected to `Original Task IDs` |
| 109 | Automation Settings table (7 rows with descriptions) | prose-only — a third copy of the `automation` object | **claim deleted**; the table now carries values only and points at the contract |

---

## Where the skill restated code that already exists (AC5)

| # | the skill hand-rolled | production equivalent | resolved? |
|---|---|---|---|
| A1 | Phase 1.4's five `ASSERT … → ABORT` lines, and the prompt's four | `validateContractFile` / `validateJson`, `src/gdskills/contracts.ts`; entry `keryx skills contracts validate` (`src/commands/skills.ts:1000-1028`, non-zero exit on invalid) | **yes** — the skill calls the command |
| A2 | Phase 6.1's `mkdir -p …/results` + free-form JSON write, described as a durable record | `keryx job document`, `src/job/service.ts` `document()` — refuses a missing file, refuses an unknown type, records under a file lock in `state.json` | **yes** |
| A3 | The Automation Settings table (7 settings, their types, defaults and bounds) | `input-contract.schema.json`'s `automation` object, now loadable | **yes** — table replaced by a pointer |
| A4 | `npm run lint` / `npm run type-check` hard-coded | `keryx health run --source eslint,typescript`; `src/health/sources/eslint.ts`, `src/health/sources/typescript.ts` | **yes** |
| A5 | `npm test` hard-coded | `keryx test run`; `src/testing/service.ts:756-780` detects bun/pnpm/yarn/npm from the lockfile and builds the argv — the same if-chain flow 205 found `job-orchestrator` writing in shell | **yes** |
| A6 | "Maximum 3 self-fix attempts" as a number the model counts | `keryx review loop --flow <id> --task <Tn>` — loop DETECTION from durable state, "never this session's memory" | **no, and deliberately.** `review loop` requires `--flow` and reads the flow's *review packages* and `tasks[].attempts.count`. `task-implementer`'s self-fix loop is over its own lint/type/test output inside one dispatch, with no flow, no task id and no review round to read. Wiring it would mean inventing a flow id, and the command would then report on rounds that do not exist. Named here rather than forced |
| A7 | The `implement` step's own status | `keryx job step <name> <step-id> --status …`; `src/job/service.ts` `step()`, gate in `complete()` | **no, and deliberately.** `src/job/plans.ts:19` makes `implement` ONE step for a whole wave, so a single task cannot close it and two parallel tasks would race the transition. The skill now says so explicitly and points at the orchestrator as the owner |
| A8 | `RESEARCH_SUMMARY` and `CHANGE_PLAN` as named artifacts | nothing — there is no store for a per-task plan | **no.** There is no code to call; they are thinking aids and are left as such |

---

## What this flow did NOT fix, and why

1. **`agent_worthy: true` and `triggers:` have no consumer.** Both are frontmatter
   fields nothing in `src/` reads. They are classified `advisory` here rather than
   `prose-only` because they declare rather than assert: a skill *is*
   agent-worthy and those phrases *do* describe it, so there is no false claim to
   delete and no code to call. Removing them would change what every other
   bundled skill declares, which is a tree-wide decision and not this flow's. It
   is still a gap worth naming: a field with no consumer is a field that can say
   anything.
2. **`metadata.version` is still unchecked** — `advisory` for the same reason.
   Bumped to `1.3.0` to match the change, but nothing compares a declared version
   against content in any skill.
   The `job-orchestrator` case (all five builds falsely declaring `3.2.0`) shows
   the failure mode; a guard for it belongs with `build-parity.test.ts` and would
   need a versioning policy first.
3. **The duplicate `4.1` heading survives.** Two subsections are both numbered
   `4.1` (Standard Mode order, TDD Mode order). It is a numbering collision in
   advisory text, not a false claim, and `job-orchestrator`'s duplicate `2.8.1`
   was fixed in the flow that owned that file.
4. **`ROLLBACK POLICY: git reset --hard` is unchanged and is a real hazard.**
   It is an instruction to the model, so it classifies `advisory` and AC3 does not
   reach it — but it is unscoped, it runs on a *shared* feature branch the
   orchestrator manages, and a wave-mate's uncommitted work is inside its blast
   radius. Naming it rather than leaving it for the next measurement: the correct
   form is a path-scoped `git checkout -- <target_files>` or a `git stash`, and
   changing it is a behaviour change that wants its own flow.
5. **`RESEARCH_SUMMARY` / `CHANGE_PLAN` are not artifacts.** See A8.
6. **The self-fix loop has no stuck detector in code.** See A6.
7. **`task-implementer` is still not dispatched by production code.** `keryx ctx rg
   "task-implementer" src --glob '!*.md'` returns a plan *label*
   (`src/job/plans.ts:19,29`, used for `keryx job status` reporting), a catalogue
   registration (`src/gdskills/catalog.ts:90`), and test files. It runs when a
   model, following another skill's prose, dispatches it. That is the execution
   model for every bundled skill in this tree and is not a `task-implementer`
   defect; it is the reason every fix here takes the form "name a command the
   model runs, whose implementation refuses".
8. **The harness contract itself is untouched.** `parseChildResult` still requires
   `meta` for string input and still throws rather than returning a typed error,
   and nothing routes a *skill worker's* output through it — the STATUS contract
   binds harness children. AC4 says keep it enforced and present, which this flow
   did; widening `parseChildResult`'s reach to host-agent subagents is a harness
   change, not a skill change.
