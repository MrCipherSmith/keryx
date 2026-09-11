# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `review-agent-profile.mdc` and `review-strict-profile.mdc` are absent from `src/gdskills/bundled/rules/core/` and `.metaproject/rules/core/`, and no shipped skill, rule, source file or test references them.
- AC2: Installing over a project that holds an unmodified copy of a retired bundled rule removes it; a modified copy is kept and reported; both cases are covered by a test.
- AC3: `review-orchestrator` (every build) neither defaults to nor allows `model_strategy: current`, points model choice at `keryx review tier`, and does not mention strict synthesis.
- AC4: `code-verifier`, `test-gen` and `tests-creator` (every build) contain no hardcoded `npx eslint|biome|tsc|jest`, `cat | grep` or `find` invocation, run checks through `keryx health run` / `keryx test run` as `task-implementer` §5.1 does, and `code-verifier`'s fix-loop bound is 3.
- AC5: Every shipped skill and contract schema that names the job context file uses `<job>/ai/context.md`; `job-orchestrator` no longer writes `context_v<N>.md`.
- AC6: No shipped skill or rule cites `skills/shared/`, `skills/review/review-orchestrator/`, `.cursor/rules/core`, `AGENTS.mdc`, `.metaproject/rules/schemas/`, or a post-commit metrics hook; `skills-storage-workflow.mdc` has a sync mapping consistent with its layout and unique step numbers.
- AC7: `bundled-eval` `xref:path` resolves references against the installed layout and also sweeps rule files; a test proves a path valid only in the source tree is reported.
- AC8: Every shipped `SKILL.md` that declares `compatible_harnesses` includes `claude`, and every `metadata.category` equals the catalog category or is absent; both are `bundled-eval` checks covered by tests.
- AC9: None of the 11 rendered core/platform skills has a description of the form "Use when <imperative verb>", and the routing-baseline, skills-route and trigger-reachability tests pass.
- AC10: `rules/agents-md.md` and `rules/claude-md.md` are generated with the fallback text when the entrypoint body is only a heading; covered by a test.
- AC11: The unhandled-rejection rule is stated once and cross-referenced; the documentation rules prescribe only the `requirements-package-standard` layout; `skill-lifecycle.mdc` defers model choice to `keryx review tier`.
- AC12: A shipped `git-concurrency` rule (no `git stash` in a shared tree, explicit pathspecs instead of `git add -A`, `git -C <absolute path>` in worktrees, commit at task boundaries) is installed, referenced by `flow-orchestrator`, `job-orchestrator` and `task-implementer`, and `destructive-git.test.ts` flags `git stash` and `git add -A` in shipped skill documents.
- AC13: The eight stack-specific rules declare their stack in frontmatter, and `rules/README.md` documents how core rules are loaded and that `alwaysApply`/`globs` are not consumed by keryx.
- AC14: `entity-skill-verifier` describes only what `verify.ts` checks, and project-skill `SKILL.md` files no longer state a verification status that can contradict `verification.md`.
- AC15: Mirrored bundled and installed files are byte-identical, `bun ./src/cli.ts skills verify --bundled` exits 0, typecheck passes, and the full `bun test` suite has no failure that is absent from the pre-change baseline recorded in `journal.md`.
- AC16: A `review-orchestrator` round over the branch diff ends with zero open blocker, major or minor findings.
