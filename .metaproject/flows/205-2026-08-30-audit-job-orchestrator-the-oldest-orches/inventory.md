# job-orchestrator — mechanism inventory

Five auditors, disjoint ranges, over `SKILL.md` (1,759 lines) plus the four
sibling builds and two contracts. Every row was classified by running a search,
not by reading impression.

Classification rule, applied strictly: a call site found only in a `*.test.ts`
file is **not** `wired`. That distinction is the entire finding class this audit
exists for.

## Totals

| range | wired | prose-only | advisory |
|---|---|---|---|
| Phase 0 (0.0–0.4) | 1 | 20 | 13 |
| Phase 1 + 2.1–2.4 | 0 | 55 | 2 |
| 2.4.1–2.8 | **0** | 48 | 45 |
| 2.8.1–end | 5 | 9 | 19 |
| **total** | **6** | **132** | **79** |

217 mechanisms. **Six are reachable from a production code path**, and five of
those six are the `keryx skills learn` / `learn apply` pair in a single section.

Sections 2.4.1 through 2.8 — the entire implement/review/fix/verify core —
contain **zero** wired mechanisms.

## The one wired block

`2.8.2 SKILL LEARNING` is genuinely implemented: `keryx skills learn
--from-review|--from-test|--from-failure` writes a proposal
(`src/gdskills/learn.ts:53`), `keryx skills learn apply` applies it under a file
lock, refuses double-apply and refuses paths outside `.metaproject/project-skills`
(`learn.ts:127-173`), and the propose/apply separation is enforced by
construction. The loop closes: `src/gdskills/verify.ts:64` and
`src/health/skills.ts:31` read the registry back.

It is also the block that exists in **only one of the five builds**.

## Things referenced that do not exist

| name | referenced as | reality |
|---|---|---|
| `code-boss-review` | **default** reviewer in `input-contract.schema.json:114`, and in 16 files | not in `bundled/skills/review/`, not in the catalogue. Exists only in the operator's personal `~/.claude/skills/` — which is why it has never been noticed |
| `code-review` | **default** `review_mode` (L1504), strategy A and C | not bundled, not catalogued |
| `wave-executor` | the agent every implementation wave is dispatched as (L627) | no such skill or agent type |
| `subagent_type: "general"` | every dispatch block, 41 occurrences | no dispatcher accepts it; the type is `general-purpose` |
| `.metaproject/scripts/detect-models.sh` | the model-detection step (L1115) | never existed in git history; also referenced by `flow-orchestrator:388` |
| `skills/<name>/SKILL.md` | three sub-agent prompt loads | path has not existed since the tree was namespaced to `skills/gdskills/<category>/<name>/`; §2.2 hedges with "(if it exists)", so the miss is silent |
| step `CHECKS` | jumped to four times | replaced by 2.8; the label outlived its own removal |

## Claims that cannot be true in this execution model

- **"default if no response in 60s"** (L741) — no timer exists, and a model
  cannot observe wall-clock passing while a user does not answer. The default can
  never fire.
- **"Time pressure (`total_job_timeout` close)"** (L824) — same; no clock, no
  persisted start time.
- **Status `paused`** (L744, L965) and `timeout` (L1563) — `state.schema.json` has
  no `status` property and `additionalProperties: false`. Unrepresentable.
- **Five other persisted fields** — `sanity_check`, `convention_reviewers`,
  `publication_plan.mode`, `pending_pr_review_report_comment`,
  `pending_review_ai_artifact` — all claimed as recorded, none legal under the
  same schema.

## Internal contradictions

- Two sections numbered **2.8.1** (VERIFY-POST-FIX and PERF-CHECK). No `2.5`
  exists at all; `2.5.1` and `2.5.5` are orphan children of a missing parent.
- §1.1 lists `security`, `perf-check` and `deploy` **as plan steps**; §1.3 says
  they are **not in the plan**. Two authoritative plans, adjacent.
- The `fix` trigger is specified twice with different thresholds — "CRITICAL/HIGH"
  and "CRITICAL/WARNING". `security` and `perf-check` are each duplicated verbatim.
- The fix bound is **3** at L974 and L1501, **2** at L1060, and
  `"maximum": 3, "default": 2` in the input contract.
- §0.4 requires a "Proceed?" confirmation; the same folder's contract declares
  `skip_confirmation: { const: true }` — "must be true".
- §0.2 says "**No hardcoded default**" for the base branch; the contract ships
  `"base_branch": { "default": "develop-2" }`, a branch from an unrelated project.
- Three severity vocabularies in one section: `CRITICAL|WARNING|INFO` (2.6.1),
  `CRITICAL/HIGH/MEDIUM/LOW` (2.6.3), against canonical
  `blocker|major|minor|info`. The 2.6.3 counts can never be populated from the
  2.6.1 findings.

## Production code this skill reimplements in prose

Each of these ships, is wired elsewhere, and is not called here:

| the skill hand-rolls | production equivalent |
|---|---|
| `topological_sort_into_waves` pseudo-function | `planWaves`, `src/harness/parallel/scheduler.ts:116`, live from `src/commands/agent.ts:30` |
| "each wave runs isolated" (one shared worktree) | `createGitWorktreePort`, `src/harness/child/git-worktree-port.ts:34`, used by `run-external-factory.ts:352` |
| STUCK CHECK by hand | `keryx review loop`, `src/commands/review.ts:988` — reads durable state, "never this session's memory" |
| package-manager if-chain in shell | `src/testing/service.ts:781` |
| "only show detected reviewers" by eyeballing | `keryx review stack`, `src/commands/review.ts:1029` — reads `package.json`, "never a model" |
| "prefer a cheaper model" via a missing script | `keryx review tier`, `src/commands/review.ts:606` |

## The review sections are two releases stale

§2.6 and §2.7 describe a review pipeline that predates the managed-review work.
Concretely, **a pull request driven by this orchestrator fails every one of the
five conditions** of the completion gate merged in 0.2.71:

1. **No managed record.** A fix round requires `keryx review start` before and
   `keryx review ingest` after. §2.7 runs up to three fix rounds and issues
   neither, so no round is citable.
2. **No dispositions.** The gate requires a terminal disposition per finding.
   §2.7 clears findings by recomputing "unresolved" as whatever the next round
   still reports — which is precisely the absence-as-evidence the gate refuses.
3. **No blast radius.** `--blast-radius` is not optional on any round that
   dispatched `review-regression`, and an ingest carrying a scope-B finding
   without it is refused. §2.6's scope is a bare `git diff`.
4. **Inbound comments unhandled.** §2.6.2 asks only whether to publish *our*
   report. The gate asks whether anyone else's comment went unanswered, proven
   from the durable record `keryx review comments collect|reply` writes.
5. **No verifier.** §2.6's reviewer table has no verifier row and the section
   never emits `scope.md`, so verification stats do not exist.

Two more: §2.6.1 pins `model_strategy: "current"` — "do not switch models" —
which is exactly the behaviour `keryx review tier` replaced; and §2.6.1 tells the
reader to launch **all** reviewers in a single turn, while
`src/review/caps.ts:343-357` names `job-orchestrator` by name as the outermost of
the three nesting levels its cap of 4 was chosen to survive, binding only when
the parent passes `--outstanding`, which §2.6 never does.

## The five builds

`SKILL.md` is 1,759 lines; the other four are 1,726 and byte-identical to each
other. The difference is three hunks, none of them harness-specific: the whole
`2.8.2 SKILL LEARNING` step, its `## Skill Updates` report section, and the
execution-metrics opt-in. All five declare `metadata.version: "3.2.0"` and
`compatible_harnesses: "cursor,codex,zed,opencode,claude"`.

`git blame` traces the divergence to the bootstrap commit `fd43d35a`. It has
never been reconciled, and no guard compares build against build — though
`round-bound.test.ts:108` already implements the analogous bundled-vs-mirror
check.

Nothing in the current codebase reads the four non-Claude builds:
`src/gdskills/export.ts` types `SkillRuntime` as `"codex" | "claude" | "plugin"`
and copies `SKILL.md` unconditionally regardless of runtime, and
`metaproject-adapter.ts:257` documents that "per-assistant variants like
SKILL.opencode.md are not catalog entries".

## Both contracts are unenforced

`input-contract.schema.json` and `output-contract.schema.json` are not in the
`CONTRACTS` registry (`src/gdskills/contracts.ts:59`, which knows five names), so
`keryx skills contracts validate` cannot load either. They are also not mirrored
into `.metaproject/core/gdskills/contracts/` like the five that are.

The output contract's `sections` enum is closed at seven values and excludes the
two sections `SKILL.md` instructs the orchestrator to emit.

## Did it ever run?

Once. `.metaproject/jobs/` is empty today, but commit `13676f0f` added a single
12-file job package (`requirements-remediation--keryx-project-agent-harness`,
2026-07-11) which was later removed. Compare: 203 flow packages, 13 review
packages.

So the pipeline is not inert — a model following the prose can drive it, and once
did. What is absent is any code that makes it happen, checks that it happened, or
records that it happened.
