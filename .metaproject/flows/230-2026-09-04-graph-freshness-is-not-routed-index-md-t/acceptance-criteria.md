# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `renderGdgraphManifest()` emits a `## Freshness & Refresh` section naming what invalidates the graph (added/renamed/deleted/moved files and changed imports; file-content edits only for the symbol layer), the observable signal (the `keryx gdgraph context` freshness line), and the repair command (`keryx gdgraph build`).
- AC2: The generated `.metaproject/index.md` contains an Agent Workflow item telling the agent to rebuild the graph before relying on graph answers when the file set changed in this session or the freshness line reports uncommitted code files, and that item links `modules/gdgraph.md`.
- AC3: The generated `.metaproject/index.md` Intent Router contains a row whose intent is graph staleness after code changes, routed to the gdgraph capability with `keryx gdgraph build` as the agent action.
- AC4: `renderProjectMetaprojectReferenceBlock()` emits a policy sentence about rebuilding the graph after the file set changes, so it appears inside `<!-- keryx:index -->` in both `AGENTS.md` and `CLAUDE.md`.
- AC5: `renderGdgraphPostCommitHook()` runs `keryx gdgraph build` after a graph-relevant commit instead of only printing a reminder, resolving the binary from PATH then `$HOME/.local/bin/keryx`, and skipping with a message when neither exists.
- AC6: The hook never blocks a commit: every path returns 0, including a failed or unsupported build.
- AC7: The hook honours an opt-out: `KERYX_GDGRAPH_HOOK_REBUILD=0` in the environment makes it skip the rebuild and print the manual command instead.
- AC8: The hook does not run on commits that touched no graph-relevant path, and does not run outside a git work tree.
- AC9: The generated hooks README section for the gdgraph post-commit hook describes rebuilding, states that versioned graph artifacts may change after the commit, and names the opt-out.
- AC10: `renderGdgraphSkillReadme()` "Refresh Policy" no longer claims a behaviour the hook body does not have, and matches AC5-AC7.
- AC11: `bun test src/lib/templates.test.ts src/commands/update.test.ts` passes, and new tests cover AC1, AC4, AC5, AC6, AC7 and AC8 against the rendered strings.
- AC12: This repository's `.metaproject/index.md`, `.metaproject/modules/gdgraph.md`, `.metaproject/skills/gdgraph/SKILL.md`, `.metaproject/hooks/README.md`, `AGENTS.md`, `CLAUDE.md` and `.git/hooks/post-commit` are regenerated from the local source (`bun ./src/cli.ts update --hooks`), not from the keryx on PATH, and carry the new text.
- AC13: `bun run typecheck` passes.
