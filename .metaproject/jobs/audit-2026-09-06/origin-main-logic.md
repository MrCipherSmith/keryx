# Origin Main Logic Review

Version: 0.1.0

STATUS: DONE_WITH_CONCERNS

## Logic Review

### Review Scope

- Commit: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`
- Parent ref: `HEAD^`
- Scope mode: explicit hash range `HEAD^..HEAD`
- Spec compliance gate: ran against the validated dispatch and its bounded acceptance criteria
- Source policy: read-only; no implementation or documentation-package work

### Summary

The new renderer and the `init`/`update` paths correctly split the mandatory compact gate (`index.md`) from the full router (`routing.md`). Existing projects migrate on `keryx update`, and the changed update test verifies both files. One supported lifecycle remains unconverted: `keryx rules sync` and `keryx rules distill` overwrite the compact gate with the full router, so the optimization is not stable under normal maintenance.

The focused changed-scope run performed by the parent passed (73 tests, 0 failures, 341 expectations). That green result does not contradict the finding: the changed rules tests still assert the old full-index behavior.

### Stats

- blocker: 0
- major: 1
- minor: 0
- info: 1

### Spec Gaps

None detected within the commit's bounded goal. The broader 32-point improvement plan was context only and was not treated as implementation scope.

### Logic Bugs

#### [F-001] Rules maintenance destroys the compact gate

- **Severity**: major
- **File**: `src/commands/rules.ts:147`
- **Problem**: `refreshRulesIndex` still writes `renderIndexMarkdown(...)` directly to `.metaproject/index.md`. Both `rules distill` (`src/commands/rules.ts:63`) and `rules sync` (`src/commands/rules.ts:87`) call this function. After either command, the compact gate produced by `init`/`update` is replaced by the 12.7k-character full router; no `routing.md` is refreshed, and enabled security routing is also omitted because this call does not pass `enableSecurity`.
- **Why it matters**: Trigger: initialize or update a project, then run either supported rules-maintenance command. Observable result: the compact-index contract is silently undone and subsequent agents again load the full router. The current tests preserve the defect: `src/commands/rules.test.ts:48-49` and `src/commands/rules.test.ts:92-93` explicitly require the rules table in `index.md` rather than checking it in `routing.md`.
- **Fix**: make the shared rules refresh use the same two-file write as `init` and `update`: render `renderIndexGateMarkdown` to `index.md`, render `renderIndexMarkdown` to `ROUTING_FILENAME`, and pass every enabled-module flag including security. Update both rules-sync scenarios to assert the compact gate and full routing file.
- **Class scope**:
  - sites: `src/commands/rules.ts:63`, `src/commands/rules.ts:87`, `src/commands/rules.ts:147`
  - enumeration method: `keryx ctx rg "renderIndexMarkdown|renderIndexGateMarkdown|ROUTING_FILENAME" src` found all renderer call sites. `init.ts` and `update.ts` write both files; `rules.ts` is the sole runtime writer that retains the old single-file behavior.

### Async & Concurrency

None detected.

### Error Handling

None detected.

### Null / Undefined Safety

None detected.

### Type Contract Violations

None detected.

### Edge Cases

#### [F-002] Read-side guidance still names content that moved out of `index.md`

- **Severity**: info
- **Files**: `src/gdskills/catalog.ts:25`, `src/ctx/orient.ts:26`, `src/ctx/orient.ts:80`, `src/commands/update.ts:219`
- **Observation**: the generated metaproject-router tells agents to use the “Intent Router” in `.metaproject/index.md`; the orientation excerpt extracts H2 sections that the compact gate no longer has and calls `index.md` the complete routing instructions; the update next step says `index.md` contains the module map. The actual content moved to `routing.md`.
- **Why it matters**: these are reproducibly stale directions, but the compact gate links `routing.md`, so the code examined does not prove that an agent fails rather than recovering through that link. This remains `info` under the canonical trigger/outcome test.
- **Fix**: point full-router references to `.metaproject/routing.md`; teach orientation to emit the compact gate directly or recognize its table; adjust the update message to describe routing pointers or name `routing.md` for the module map.
- **Enumeration**: searched all TypeScript references with `keryx ctx rg "\\.metaproject/index\\.md|index.md" src --glob "*.ts"` and then verified runtime references in source. Comments and existence checks with no behavioral effect were excluded.

### Suggested Patches

No source patch was applied. The minimal correction belongs in the shared rules-index refresh described in F-001, followed by assertions for both `index.md` and `routing.md`.

### Limitations

- The parent ran the focused changed-scope tests; this worker did not rerun them.
- The current checkout's generated `.metaproject/index.md` remains the old full router and `.metaproject/routing.md` is absent. The new renderer behavior therefore is not active in this repository until its own generated Metaproject files are refreshed.
- The added context-measurement document and earlier benchmark/history removals were outside this worker's assigned review scope.

## Routing Audit

- `graph_used`: yes — refreshed graph affected-context for `src/commands/init.ts`, `src/commands/update.ts`, and `src/lib/templates.ts`
- `wiki_used`: yes — read `.metaproject/wiki/index.md`; no narrower page covered this new split, so claims were verified in source
- `ctx_used`: yes — compact reads, explicit-range diff, renderer/reference searches, and command summaries
- `raw_rg_used`: no
- Raw `git diff` was read only after the compact diff omitted required hunks; no raw code search was used.
