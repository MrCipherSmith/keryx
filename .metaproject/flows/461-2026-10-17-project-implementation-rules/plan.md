# Implementation Plan

Status: revised to the operator's decisions of 2026-10-17; criteria AC1-AC25 frozen at flow start.

Full PRD, TRD and criteria: `docs/requirements/keryx-project-implementation-rules/`.

## Approach

Variant (a) from the design analysis: new skill kinds, rule import without a citing skill, and a deterministic resolver (`keryx skills resolve-context`) that every code- and test-writing skill calls first; its output is checked against a schema-validated field in the skill's result. Taken from variant (b) only rule shadowing through the existing `.metaproject/rules/project/` slot. Rejected: skill inheritance (b), links as the main path (c; only a `source: <path>@<sha256>` pointer expanded by `skills update` into a copy).

Why code and not prose: the orchestrator benchmark leaked 34 of 184 prose gates. The check must be a command that exits non-zero, introduced as a warning first (operator decision) and switchable to blocking.

Operator decisions (poll 209, 2026-10-17T18:20:22Z): both modes, import by default; warning first, blocking later; project skills only supplement with rules and templates, never replace an implementer; context size decided after measurement, then a configurable cap (default 128 KiB, `gdskills.projectContext.maxBytes`) after the operator called 40 KB too small; both copy and in-place (`--link`) modes; a TUI representation; the live run on vantage-frontend is run by the operator. Coordinator note: the unmerged thin-overlay branch of vantage-ai-assistant makes linked rules and referenced contract files a first-class source (AC23, AC25).

## Steps

1. Stage 0 (AC1-AC3): order fix in `skills route`; `rules/project` slot in `task-implementer` Phase 2.4/2.0b; rules step in `tests-creator`.
2. Stage 1 (AC4-AC8, AC23): categories `implementation`/`testing`; `skills import --rules <dir> [--only <glob>]`; registry keeps `kind`/`globs`/`description`/`alwaysApply`/`taskTypes`; update/remove.
3. Stage 2 (AC9-AC14, AC25): `src/gdskills/context-resolver.ts` + `skills resolve-context`; configurable budget; referenced contract files and hash pin; schemas; `contracts validate --resolved`; skills call the resolver.
4. Stage 3 (AC15-AC16, AC24): orchestrator dispatch templates; shell/MCP operation `skills_resolve_context`; TUI sidebar line, `/projectctx` modal, settings rows.
5. Stage 4 (AC17-AC18): `enforcement: warn|block`, `flow task done` check.
6. Cross (AC19-AC22): docs, reviewer non-regression, Vantage fixture, live proof with the operator's OK.

Each stage lands as its own PR or commit group so a stage can be released without the next one.

## Risks

- Bundled copy vs installed copy drift: skills text lives in `src/gdskills/bundled` and in each project's `.metaproject/skills/gdskills`; a project must run `keryx update` or the live test runs on old skills.
- Imprecise `globs` pull in too much or too little; the fixture set (AC21) is the guard.
- A cap overrun on a real task: the design degrades to `on_demand` with a warning instead of truncating; the answer is to raise `maxBytes`.
- The orchestrator dispatch step is still prose until AC18; stage 2-3 give detection (warning), not prevention.
- Engine shadowing: a project rule named like a bundled rule replaces it; `shadows` makes that visible, and rules in `rules/core/` are never written by import.
- Untested numbers: ~85 KB frontend-relevant Vantage set was measured by file size, the `globs` of each rule were not read; cap overrun estimates are sizes, not resolver output.
