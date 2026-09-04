# Implementation Plan

Status: ready

## Approach

Graph refresh already exists as a command and as a signal; what is missing is routing plus one
honest hook. All agent-facing surfaces are generated from `src/lib/templates.ts` and
`src/lib/agent-entrypoint-blocks.ts`, so every change is a template change plus a regeneration of
this repository's own `.metaproject`.

The dedicated graph document is a `## Freshness & Refresh` section inside the existing
`modules/gdgraph.md` manifest (chosen over a new file: the manifest is already the "what this module
is" document, and `keryx update` already rewrites it — `src/commands/update.ts:343`).

The hook becomes mutating. That deliberately reverses the "avoid mutating versioned `.metaproject`
artifacts after the commit is already written" line in the hooks README: graph
`artifacts/summary.md` and `artifacts/module-map.json` are tracked in this repository, so a rebuild
leaves them dirty after a commit. The README section is rewritten to say so, and
`KERYX_GDGRAPH_HOOK_REBUILD=0` is the opt-out for projects that want the old reminder.

## Steps

1. `renderGdgraphManifest()`: add `## Freshness & Refresh`.
2. Index template: add the Agent Workflow item and the Intent Router row, both gated on `enableGdgraph`.
3. `renderProjectMetaprojectReferenceBlock()`: add the rebuild policy sentence after the gdgraph navigation sentence.
4. `renderGdgraphPostCommitHook()`: resolve the binary, honour `KERYX_GDGRAPH_HOOK_REBUILD=0`, run `keryx gdgraph build`, report the outcome, always return 0.
5. Hooks README template: rewrite the gdgraph post-commit section.
6. `renderGdgraphSkillReadme()`: rewrite "Refresh Policy" to match the hook.
7. Tests in `src/lib/templates.test.ts`, plus `src/commands/update.test.ts` if hook-body assertions live there.
8. Regenerate: `bun ./src/cli.ts update --hooks`; verify the generated files and the installed post-commit hook.
9. `bun run typecheck` and the touched test files.

## Risks

- Post-commit rebuild cost on a large repository: the build is full, not incremental. Mitigated by
  the path filter (only graph-relevant commits) and the env opt-out; incremental build is out of scope.
- Dirty worktree after a commit for projects that version graph artifacts. Documented in the README
  section and in the hook's own output line.
- The keryx on PATH is a stale build (recorded constraint), so regeneration must go through
  `bun ./src/cli.ts`.
