# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `quality/commit`, `quality/push` and `quality/pr` exist in neither the bundled tree nor the mirror, and `quality/git-publish/SKILL.md` exists in both, byte-identical. [verify: exec `bash -c 'for s in commit push pr; do test ! -e src/gdskills/bundled/skills/quality/$s && test ! -e .metaproject/skills/gdskills/quality/$s || exit 1; done; cmp src/gdskills/bundled/skills/quality/git-publish/SKILL.md .metaproject/skills/gdskills/quality/git-publish/SKILL.md'`]
- AC2: The anatomy lint no longer reports a missing Red Flags section, and still reports a missing "NOT for" clause and a missing Verification section. [verify: exec `bun test src/gdskills/bundled-eval.test.ts`]
- AC3: Routing sends "commit this", "push my branch" and "open a pull request" to `git-publish` first. [verify: exec `bash -c 'for q in "commit this" "push my branch" "open a pull request"; do bun ./src/cli.ts skills route "$q" --json | bun -e "const r=JSON.parse(await Bun.stdin.text()); const top=(r.matches??r.results??r)[0]; if(!JSON.stringify(top).includes(\"git-publish\")) process.exit(1)" || exit 1; done'`]
- AC4: The behaviour eval in `eval/` run with the shipped `git-publish` SKILL.md as the guidance scores every check in every scenario (two runs per scenario). [verify: judged]
- AC5: The gdskills, routing and agent suites and the type check pass, except failures that also occur on the untouched base. [verify: exec `bash -c 'bun run typecheck && bun ./src/cli.ts skills verify --bundled && bun ./src/cli.ts agents verify'`]
