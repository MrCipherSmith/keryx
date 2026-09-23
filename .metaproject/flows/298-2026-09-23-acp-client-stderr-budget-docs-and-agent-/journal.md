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
- 2026-09-23T05:49:21.136Z - task-done: T5: Implement the frozen criteria
