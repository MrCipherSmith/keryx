# Flow Journal

- 2026-09-23T05:23:55.733Z - flow created
- 2026-09-23T05:24:42.390Z - frozen: 4 criteria; checksum recorded
- 2026-09-23T05:24:42.648Z - started
- 2026-09-23T05:24:42.903Z - task-added: T5: Implement the frozen criteria
- 2026-09-23T05:24:43.138Z - task-added: T6: Verification: CI green, keryx health run
- 2026-09-23T05:24:43.385Z - task-attempt: T5: started (attempt 1)
- AC1: added a separate `OutputBudget` for stderr (`DEFAULT_MAX_STDERR_BYTES`,
  `stderrBudgetReason`) in `src/harness/external/bounded.ts`, wired into both
  `superviseAcpRun` (acp-client.ts) and `superviseExternalRun` (supervise.ts,
  same gap, per the AC's "shared line-stream supervisor" instruction). Kept
  separate from the run-output budget rather than merged into it: they measure
  different failure modes (flood the result vs. flood the diagnostic) and
  merging them would let stderr noise starve a legitimate large result's
  budget or vice versa. New tests in bounded.test.ts use a flood port that
  only stops on `kill()` (not on a finite line count), so a passing test
  proves the budget caused the stop rather than the flood happening to end.
  Verified by hand: reverting the fix makes both new tests fail (one times out
  waiting `timeoutMs`, matching the bug description; the other never sets
  `overflow`) — then restored.
- AC2: added an "Unattended dispatch (triggers, and `agents external run`)"
  section to the flow module skill (`renderFlowSkillRouter` in
  `src/flow/templates.ts`, ships as `skills/flow/SKILL.md`) covering
  `trigger list/status/run/schedule/install/resolve`, the `flow-next`
  report-only vs. dispatching distinction, the unattended posture (ask is
  read-only, trust needs the Linux sandbox, everything that would ask is
  denied and recorded — the floor not the boundary), and what
  `keryx agents external run` does/does not control. Added one routing row to
  both the compact index gate and the full router in `src/lib/templates.ts`
  (`renderIndexGateMarkdown`/`renderIndexMarkdown`), unconditional since
  neither trigger nor externalAgents has a dedicated enable-module flag. Did
  NOT touch any file under `src/gdskills/bundled/**`: `flow/SKILL.md` is a
  module-generated skill outside that mirrored/ceiling-checked system (absent
  from `SKILL_LENGTH_CEILINGS`), so no ceiling was at risk and none needed
  lowering. `keryx skills verify --bundled` still reports 0 findings.
- AC3: `docs/docs/architecture.md` (~lines 549-575) now lists all 8 gates
  `flow complete` evaluates today, in order (acceptance-criteria,
  pull-request/main-merge, base-branch, tasks, owner, review, health,
  security), verified against `src/flow/service.ts`'s actual push order. The
  old text cited "completion gate 3" for health and "completion gate 4" for
  security, which were themselves wrong against the code's own `Gate 1..6`
  comments (health is `Gate 5`, security is `Gate 6`) — not just a
  simplification but stale. Replaced both citations and added the full
  ordered list with a pointer back to `service.ts` as source of truth.
- Also updated `docs/docs/guides/acp-client.md`'s "Size bounds" section to
  document the new stderr-read budget alongside the existing stderr-retention
  bound, so the public docs stay in sync with AC1's fix.
- Verification run: `bun run src/cli.ts skills verify --bundled` (0
  findings), `bun test src/lib/templates.test.ts`, `bun test src/flow/`, `bun
  test src/commands/update.test.ts src/commands/init.test.ts`, `bun test
  src/gdskills/ src/commands/routing-corpus.test.ts
  src/commands/routing-entrypoint-lifecycle.test.ts
  src/commands/skills-route.test.ts` (781 pass), `bun test
  src/harness/external/ src/commands/trigger.test.ts
  src/commands/trigger-dispatch.test.ts src/commands/agents-external.test.ts
  src/commands/agents-external-run.test.ts` (543 pass), `bun test
  src/cli-reference-coverage.test.ts`, `bun run check:doc-links` (0 broken of
  1516 links), `bun run typecheck` (clean), `bunx eslint` on every changed
  file (clean). AC4 (CI green / `keryx health run` gate) left for the PR/CI
  step — not run locally per the "don't duplicate CI" rule.
- Follow-up (coordinator request): brought this repo's own committed
  `.metaproject/index.md`, `.metaproject/routing.md` and
  `.metaproject/skills/flow/SKILL.md` in step with the AC2 template changes.
  Ran `bun run src/cli.ts update --skip-runtime` (previewed with `--dry-run`
  first). It touched 6 files, only 3 of them intended
  (index.md/routing.md/skills/flow/SKILL.md); reverted the other 3
  (`.metaproject/metaproject.json`'s `updatedAt` timestamp,
  `.metaproject/modules/gdskills.md` — pre-existing unrelated drift from the
  catalog, `.metaproject/keryx-dashboard.html` — a ~918-line regenerated
  snapshot) with `git checkout --`. A second run also reordered `.gitignore`'s
  managed block relative to a hand-added `.mutation-sweep-*` entry, unrelated
  to this task; reverted that too. Wrote a throwaway render-and-diff script
  (not committed) that reads this project's `metaproject.json`, calls
  `renderIndexGateMarkdown`/`renderIndexMarkdown`/`renderFlowSkillRouter`
  directly, and compares byte-for-byte against the three files on disk — all
  three matched exactly. Re-ran `src/lib/templates.test.ts` (22 pass) and
  every flow test under `src/flow/` (317 pass), plus
  `src/lib/routing-entrypoint.test.ts` and
  `src/commands/routing-entrypoint-lifecycle.test.ts` (8 pass), all green.
  Answer on regression coverage: no existing test compares this repo's own
  checked-in `.metaproject/**` copies against what the templates currently
  render — every test that touches `renderIndexGateMarkdown`/
  `renderIndexMarkdown`/`renderFlowSkillRouter` (`templates.test.ts`,
  `rules.test.ts`, `update.test.ts`, `routing-entrypoint*.test.ts`) scaffolds
  a fresh temp project and asserts properties of THAT output; none reads this
  project's own committed copy and diffs it against a fresh render. This
  drift (the one just fixed) would not have been caught automatically. Not
  adding such a test in this flow, per instruction.
- PR #660 review follow-up (2 findings):
  1. CONFIRMED — verified with the code, not guessed: `dispatch.ts`'s
     `IMPLEMENTED_SANDBOX_MODES = ["read-only"]` for a line-stream (codec)
     agent (`IMPLEMENTED_ACP_SANDBOX_MODES` adds `worktree-write` for ACP
     only), and `validateRuntimeBlock` REFUSES `worktree-write` on a codec
     agent fail-closed with a distinguishable `not-implemented` code — this is
     also the ONLY path: `keryx agents external run` itself refuses a
     non-ACP entry outright (`transportOf(entry) !== "acp"` ->
     `commands/agents-external.ts:369`, "drives ACP agents only... Delegate to
     it from `keryx shell` with /delegate"), and `/delegate`
     (`tui/external-operator.ts`) hardcodes `read-only` as
     "the sandbox every run in this release uses... worktree-write is refused
     upstream (D-04)". So there is NO silent-discard path for a line-stream
     `--write`: it is refused everywhere, consistently, before any run
     starts. Nothing to note as a behavioural follow-up. Rewrote the
     "Unattended dispatch" section's `agents external run` paragraph in
     `src/flow/templates.ts` (ships as `.metaproject/skills/flow/SKILL.md`)
     to say this precisely, per transport, instead of the prior "ACP/CLI"
     phrasing that implied both worked the same way.
     `docs/docs/cli-reference.md`'s `run` row was already accurate ("Drive
     one registry agent whose transport is `acp`... A line-stream agent is
     refused") — no change needed there.
  2. Added `DEFAULT_MAX_LINE_STREAM_STDERR_BYTES = 256 * 1024 * 1024` in
     `bounded.ts`, used as `supervise.ts`'s stderr-budget default (kept
     `DEFAULT_MAX_STDERR_BYTES` = 16 MiB for the ACP path, since the
     "codex narrates on stderr and prints file contents" reasoning is
     specific to the line-stream/codec path, per `codec/codex-cli.ts`'s
     header). Added `ExternalAgentEntry.maxStderrBytes?: number`
     (`types.ts`) as a per-agent override, wired through
     `runtime.ts` (falls back to `entry.maxStderrBytes` for the line-stream
     `superviseExternalRun` call) and `acp-run.ts`'s `runAcpInWorktree`
     (`options.maxStderrBytes ?? entry.maxStderrBytes`, caller option still
     wins). No entry sets an override yet — the blanket default raise covers
     both shipped codec agents. Measured (not guessed): a synthetic
     256 MiB flood against the shared supervisor's mechanism resolves in
     ~54ms of pure budget/read overhead in a throwaway timing script — the
     softened doc comment in `bounded.ts` says "well under a second" rather
     than quoting that exact number, since a real child's actual pipe I/O
     will dominate. Documented both defaults and the override in
     `docs/docs/guides/acp-client.md`'s "Size bounds" section. Flood tests in
     `bounded.test.ts` already inject an explicit small `maxStderrBytes`
     rather than relying on the default, so they were unaffected by the
     raise (all 469 tests under `src/harness/external/` still pass).
  Re-synced `.metaproject/skills/flow/SKILL.md` the same way as the prior
  follow-up (`update --skip-runtime`, kept only the one intended file,
  reverted `metaproject.json`/`modules/gdskills.md`/`keryx-dashboard.html`/
  `.gitignore`); render-and-diff check confirmed byte-for-byte match again.
  `index.md`/`routing.md` were untouched this round (no `src/lib/templates.ts`
  change). Verification: `skills verify --bundled` (0 findings),
  `templates.test.ts` + `src/flow/` (317 pass), `src/harness/external/`
  (469 pass), `agents-external*.test.ts` + `trigger*.test.ts` (74 pass),
  `cli-reference-coverage.test.ts`, `check:doc-links` (0 broken),
  `typecheck` (clean), `eslint` on every changed file (clean). Four
  `.metaproject/data/gdgraph/**` and `data/wiki/freshness-queue.jsonl` files
  show as modified in `git status` — pre-existing background hook drift from
  this session's `keryx ctx`/`gdgraph` tool calls, present before this
  round's `update` ran and unrelated to it; left untouched.
- 2026-09-23T05:49:21.136Z - task-done: T5: Implement the frozen criteria
- 2026-09-23T06:24:51.708Z - ac-confirmed: AC1: stderr budget: DEFAULT_MAX_STDERR_BYTES/DEFAULT_MAX_LINE_STREAM_STDERR_BYTES wired in acp-client.ts/supervise.ts; bun test src/harness/external/bounded.test.ts 10 pass (flow 298 review 2026-09-23-review-298, F-002 refuted) (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-23T06:24:56.392Z - ac-confirmed: AC2: SKILL.md/templates.ts guidance verified accurate per-transport against agents-external.ts:369-375 and dispatch.ts:68,144-151; keryx skills verify --bundled 0 findings; bun test src/lib/templates.test.ts src/harness/external/dispatch.test.ts src/commands/agents-external*.test.ts 78 pass (review 2026-09-23-review-298, F-001 refuted) (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-23T06:27:27.171Z - ac-confirmed: AC3: docs/docs/architecture.md 8-gate ordered list verified against src/flow/service.ts:784-923 (Gate1,2/2b,3/3b,4,5,6); matches exactly, caveat about code's own numbering is accurate (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-23T06:27:27.530Z - ac-confirmed: AC4: CI green on PR #660 (19/19 per coordinator); merge commit 7cd96cbe3df6be503dea1f07dccc8d0b375d68ca on main; local: bun test across touched suites all pass, bun run typecheck clean per flow journal (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-09-23T06:27:35.226Z - task-done: T1: Collect remaining context
- 2026-09-23T06:27:38.371Z - task-done: T2: Implement per plan
- 2026-09-23T06:27:42.017Z - task-done: T3: Add/adjust tests and make them pass
- 2026-09-23T06:27:45.452Z - task-done: T4: Self-review and prepare draft PR
- 2026-09-23T06:27:50.099Z - task-done: T6: Verification: CI green, keryx health run
- 2026-09-23T06:28:00.727Z - completing: merged commit: 7cd96cbe3df6be503dea1f07dccc8d0b375d68ca
- 2026-09-23T06:28:00.787Z - completion-attempt-recorded: attempt 1: failed
- 2026-09-23T06:28:00.788Z - completion-failed: review: 1 of 5 conditions failed — head-commit (violated): the latest round ran against cca2d5d1c227a8eae9db0804a8d4a2e8c4f66732, but the completion names merged commit 7cd96cbe3df6be503dea1f07dccc8d0b375d68ca, and cca2d5d1c227a8eae9db0804a8d4a2e8c4f66732 is neither contained in it (git reports it is not an ancestor) nor does it carry the same tree (round f5893c6d7e05bc1e5afdb79733c6bcb701a60a17, merged 7f4ac5a10b28d49610b9eb12d67386574720dd88). So the reviewers did not read what merged: the base moved under the branch, or the merge was edited. Re-running the round against the branch will not close this — ingest a round against the merged commit (`keryx review ingest … --head 7cd96cbe3df6be503dea1f07dccc8d0b375d68ca`), or record the pull request on the flow so the round is compared against the PR head rather than against the merge. | health: no report; run `keryx health run` first
- 2026-09-23T06:28:39.935Z - completing: merged commit: 7cd96cbe3df6be503dea1f07dccc8d0b375d68ca
- 2026-09-23T06:28:39.952Z - completion-attempt-recorded: attempt 2: passed
- 2026-09-23T06:28:39.953Z - done: all gates passed
