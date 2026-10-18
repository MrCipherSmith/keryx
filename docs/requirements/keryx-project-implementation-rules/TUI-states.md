# TUI state x event matrix: ProjectCtx sidebar line and `/projectctx` modal

Companion to [TRD.md](TRD.md) section 2.7 and AC24. One test per cell, in `src/tui/project-context-inspector.test.ts`; the pure functions (`formatProjectContextLines`, `renderProjectContextSidebarValue`, `parseProjectContextCommand`) are tested without a renderer, the modal controller with an injected fake `openModal` host as `jev-edit-guard-inspector.test.ts` does.

## States

| Id | State | Snapshot |
|---|---|---|
| S0 | no content | no imported project rules, no linked rules, no `last.json` |
| S1 | rules imported, never resolved | rules or linked rules present, no `last.json` |
| S2 | last resolve fits | `last.json` present, `budget.exceeded: false` |
| S3 | last resolve over the cap | `last.json` present, `budget.exceeded: true` |
| S4 | config unreadable | `tasks.config.json` is not valid JSON; the snapshot reads defaults and says so |
| S5 | last resolve unreadable | `last.json` exists but is not valid JSON or has an unknown `schema` |

## Events

| Id | Event |
|---|---|
| E1 | `/projectctx` (open the modal) |
| E2 | footer key `e` inside the modal (toggle enforcement warn/block) |
| E3 | `/projectctx warn` or `/projectctx block` |
| E4 | `/projectctx <anything else>` |
| E5 | refresh (modal reopened, or a `resolve-context` call finished) |
| E6 | theme change while the modal is open |
| E7 | close (esc) |

## Matrix

Sidebar column is the line under `ProjectCtx` after the event. "hidden" means no row is rendered.

| | E1 open | E2 toggle `e` | E3 set directly | E4 bad argument | E5 refresh | E6 theme change | E7 close |
|---|---|---|---|---|---|---|---|
| S0 | modal opens, Status tab shows enforcement `warn (default)`, cap 131072 (default), counts 0, Last resolve tab says "no resolve recorded yet"; sidebar hidden | writes `block`, reloads, Status shows `block (config)`; sidebar appears as `block · 0 rules` | writes the value, system line `ProjectCtx: <mode>`; sidebar as in E2 | system line `Unknown /projectctx argument 'x'. Usage: /projectctx [warn\|block]`, nothing written | sidebar stays hidden | modal repaints, no throw if the renderable is gone | modal closes, key listener removed |
| S1 | Status shows counts, Last resolve says "no resolve recorded yet"; sidebar `<mode> · N rules` | toggles, sidebar keeps `N rules` | as S0 | as S0 | sidebar `<mode> · N rules` | as S0 | as S0 |
| S2 | Status shows counts, Last resolve lists `must_read`, `on_demand`, shadows, warnings; sidebar `<mode> · N rules` | toggles | as S0 | as S0 | picks up a newer `last.json` | as S0 | as S0 |
| S3 | as S2 plus a line `cap exceeded: raise gdskills.projectContext.maxBytes (now <n>, from <source>)`; sidebar `<mode> · N rules · cap exceeded` | toggles, `cap exceeded` stays | as S0 | as S0 | clears `cap exceeded` when the new `last.json` fits | as S0 | as S0 |
| S4 | Status shows `config unreadable: <reason>`, defaults used, E2 disabled (footer hint says why); sidebar `warn · N rules · config unreadable` | refuses with system line `projectctx: tasks.config.json is not valid JSON, refusing to overwrite it` and writes nothing | same refusal | as S0 | re-reads, leaves S4 when the file is valid | as S0 | as S0 |
| S5 | Status as S1, Last resolve says `last resolve unreadable: <reason>`; sidebar as S1 | toggles | as S0 | as S0 | re-reads | as S0 | as S0 |
