# Review round 1 — flow 281 (delegated gdgraph build records no provenance)

One reviewer read the fix commit `db1f786b` against `main` and found no defect at or
above its threshold. It walked the cases the round was opened for: which commands the
copied runner is delegated (only `build` rebuilds), extra arguments to `build`, a
signal-killed child, a repository with no commits, a detached HEAD, a project outside
git, concurrency against `keryx sync --apply`, and whether the new tests would fail
without the fix. It confirmed the tests spawn a real child against a real scaffolded
runner and that the failure-case test breaks module loading for every subcommand rather
than passing vacuously.

One interaction was recorded as an observation rather than a finding: `applyModule` in
`src/commands/sync.ts` calls `recordProvenance` again right after `gdgraphCommand(["build"])`,
so a scaffolded project now writes the record twice in a `sync --apply` — sequentially,
naming the same commit, with the second write carrying the earlier timestamp. The same
double write already happened for the in-process path before this change. It is kept in
the flow journal, not fixed here.

The fix commit is contained in merge commit `5aeff45a`, which landed PR 638 on `main`.

```json keryx:findings
[]
```
