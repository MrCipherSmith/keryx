# Plan

## Approach

Add the new verbs as the real implementation, turn the old ones into thin
aliases, then sweep the prose. In that order, because an alias that delegates
to the new code proves the new code works; a new verb that delegates to the old
one proves nothing and leaves two implementations.

`src/cli.ts:93` holds a verb map (`mcp: mcpCommand`). Adding `serve-mcp` and
`integrate` is adding entries to it. `src/commands/mcp.ts` dispatches
subcommands from `args[0]`, so the alias path is a small shim, not a rewrite.

## Trade-offs taken

**Aliases stay indefinitely, not for one release.** 414 references exist in
this repository alone; there is no way to know what exists in the operator's
scripts and in other machines' shell history. A deprecation window would be a
guess about other people's usage. The cost of keeping them is two lines.

**One deprecation line per invocation, not per operation.** `mcp install
--runtime all` performs several writes. A notice per write trains the reader to
ignore it, which is how deprecation notices stop working.

**`/mcp` is not repointed here.** Discussed in `description.md`. The consumer
does not exist, so `/mcp` keeps its meaning and gains `/integrations` as the
name that says what it does.

**The prose sweep is a test, not a task.** A one-time find-and-replace leaves
nothing to stop the next writer using the old spelling. A test that scans
`docs/`, `README.md` and `.metaproject/` fails on reintroduction. Mapping tables
are exempt by shape (`| was | is |`), not by file allowlist, so a new document
that records the history does not need editing into the exemption.

## Risk that decides how this is verified

`keryx` on PATH is an installed build (memory: `stale-installed-keryx-binary`).
Every check that shells out to `keryx serve-mcp` would test 0.2.84, which does
not have this change, and would pass or fail for reasons unrelated to the work.

So: acceptance runs the working tree. Where a check genuinely needs a process,
it invokes the built entry point from source, and the report says which checks
did which. This is not hypothetical — the same trap caught the operator's
`keryx update` run earlier today.

## Order

1. **Tests first** for the new verbs and the alias notice, red against current
   code (`tdd-workflow.mdc`).
2. **CLI**: `serve-mcp`, `integrate`, `integrate --remove`; old spellings shim
   to them and emit the notice once.
3. **TUI**: `/integrations` registered; `/mcp` aliased and marked deprecated.
4. **Prose sweep** plus the test that keeps it swept.
5. **Close the count**: report changed vs deliberately-left, summing to 414.

## What would make this wrong

If `integrate` turns out to collide with an existing or planned verb, the
rename is worse than the collision it fixes. Checked before starting: no
`integrate` verb exists in `src/cli.ts`, and none appears in
`docs/requirements/roadmap.md`. Re-checked as task T1 rather than trusted to
this sentence.
