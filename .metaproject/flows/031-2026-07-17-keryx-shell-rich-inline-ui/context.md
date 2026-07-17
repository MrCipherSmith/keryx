# Context

Collected deterministically by `keryx flow init` at 2026-07-17T11:08:05.669Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-07-10T12:13:54.635Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security

## Agent Findings

### Grounding evidence (read against real code on `origin/main` @ 8f4495c)

- **IO seam:** `src/commands/shell.ts:31-54` — `ShellIO = { lines, write }` and
  `ShellDeps`. Core `runShell` at `shell.ts:89-234`; token deltas → `io.write`
  (`shell.ts:199`); system writes (error/help/connect/unknown) also `io.write`
  (`shell.ts:127,167,170,203,213,248`); per-turn separator `io.write("\n\n")`
  (`shell.ts:232`). The TTY wrapper `shellCommand` (`shell.ts:284-356`) owns the
  real `write = process.stdout.write` and the `node:readline` line source.
- **Styling toolkit already present (reuse, no new dep):** `src/lib/ui.ts` —
  `colorEnabled()` (respects `NO_COLOR`/`FORCE_COLOR`/TTY), `style` (bold/dim/red/
  green/yellow/cyan/gray), `symbols`, `banner`, `heading`, `note`. Tested in
  `src/lib/ui.test.ts`. `renderMarkdown` will be added here.
- **Reused unchanged (flow 022, R2-4):** `src/commands/select.ts`
  `detectProviders` + `pickProviderModel` — provider/model detection and the
  numbered picker; the old `provider="ollama"`/`model="llama3.1:latest"` hardcode
  is already gone on main.
- **Frozen sibling posture:** flow 022 (`.metaproject/flows/022-.../description.md`,
  `acceptance-criteria.md` AC5) froze **Variant A — no new dependencies,
  hand-rolled ANSI**, `dependencies == {}`, full-screen TUI deferred. Flow 031
  inherits that posture.

### Baseline (pre-change)

- `bun test`: **1355 pass / 3 skip / 0 fail**, 4826 expect() calls, 175 files
  (`[12.59s]`). Non-fatal capability-asset fallbacks (memory.embedding,
  security.piiNer/injectionModel) are pre-existing and unrelated.

### Deployment note (non-obvious)

- The `keryx` binary on PATH runs from the STALE install `~/.keryx/keryx` (detached
  HEAD @ PR #24), NOT this checkout. Test flow-031 changes via
  `bun src/cli.ts shell ...` from this repo; reinstall/update the CLI separately to
  ship them.
