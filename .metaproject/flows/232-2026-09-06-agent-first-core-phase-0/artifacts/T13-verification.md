# T13 Independent Bootstrap Compatibility Verification

Version: 0.1.0  
Verified: 2026-09-06T11:10:44Z  
Branch: `codex/agent-first-core`  
HEAD: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`

## Result

Contract-specific gate: **FAIL**

The executable input contract behaves correctly, but the task-implementer prose still contradicts description-based operation. This is a bounded T13 result, not a global quality certification. The repository has no available lint command, and the latest health artifact records required ESLint as skipped, so lint is reported as **skipped**, never as PASS.

## Tooling and scope

- Package manager and runner: Bun (`bun.lock` and `bun.lockb` present; `bun test`).
- Scope: the root-authored task-implementer input schema/prose correction and its focused tests only.
- Lint: skipped; no `lint` script, ESLint dependency, or available ESLint health source.
- Type-check: not run as a separate global check; the focused Bun tests compile the changed TypeScript test.
- Circular imports: skipped; `madge` is unavailable and the change is JSON/Markdown plus a test.
- M01 routing, M10 agent/budget/scripts, and MCP HTTP changes were excluded.

## Executable checks

### Focused test suite — PASS

Command:

```text
bun test src/gdskills/task-implementer-description.test.ts src/gdskills/task-implementer-contract.test.ts src/gdskills/build-parity.test.ts
```

Result: 33 passed, 0 failed, 522 assertions. Captured summary: `.metaproject/data/gdctx/artifacts/2026-09-06T11-09-20-369Z_run.md`.

This covers both input schemas, all five build variants in both trees, established task-implementer contract behavior, and build parity.

### Source CLI request matrix — PASS

Each case ran through:

```text
bun src/cli.ts skills contracts validate <fixture> --schema task-implementer-input
```

| Case | Expected | Exit | Observed |
|---|---:|---:|---|
| Description task without `issue_number` | accept | 0 | valid |
| Request with `issue_number: 4141` | accept | 0 | valid |
| `issue_number: 0` | reject | 1 | minimum violation |
| `issue_number: -1` | reject | 1 | minimum violation |
| `issue_number: 1.5` | reject | 1 | integer type violation |
| `issue_number: "4141"` | reject | 1 | integer type violation |
| `issue_number: null` | reject | 1 | integer type violation |
| Missing `workspace.codebase_path` | reject | 1 | missing required property |
| Missing `workspace.branch` | reject | 1 | missing required property |

The actual flow input `.metaproject/flows/232-2026-09-06-agent-first-core-phase-0/dispatches/T7-input.json`, which omits `issue_number`, also validates with exit 0 through the source CLI.

### Package parity — PASS

The bundled and installed-local task-implementer packages are byte-identical for all nine files: five `SKILL*.md` builds, both schemas, `orchestrator-prompt.md`, and `task-request.template.md`. The two input schemas require only `codebase_path` and `branch`; optional `issue_number`, when present, is an integer with minimum 1. Both `orchestrator-prompt.md` copies describe it as optional.

## Finding

### T13-F-001 — HIGH: all worker builds still require an issue reference in operational prose

All ten `SKILL*.md` builds have the same four contradictory sites:

- Line 26 describes the input as including an unqualified “issue number”.
- Line 325 gives an unconditional implementation commit body containing `refs #<issue_number>`.
- Line 408 gives an unconditional verification-fix commit body containing `refs #<issue_number>`.
- Line 535 says every commit must reference the issue number.

These statements conflict with the new schema and with line 93, which correctly says to omit `issue_number` and issue references for description-based tasks. An autonomous worker following the later, more concrete instructions can emit a placeholder reference or fabricate an issue, violating the prerequisite’s core rule.

Affected builds:

- `src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md`
- `src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.codex.md`
- `src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.cursor.md`
- `src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.opencode.md`
- `src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.zed.md`
- `.metaproject/skills/gdskills/orchestration/task-implementer/SKILL.md`
- `.metaproject/skills/gdskills/orchestration/task-implementer/SKILL.codex.md`
- `.metaproject/skills/gdskills/orchestration/task-implementer/SKILL.cursor.md`
- `.metaproject/skills/gdskills/orchestration/task-implementer/SKILL.opencode.md`
- `.metaproject/skills/gdskills/orchestration/task-implementer/SKILL.zed.md`

Exact repair:

1. Change the input summary to “branch, codebase path, optional real issue number”.
2. Make both commit templates conditional: include `refs #<issue_number>` only when a positive `issue_number` was supplied; omit the entire line otherwise.
3. Change rule 8 to require conventional commits and to reference only a supplied real issue number, explicitly omitting an issue reference when absent.
4. Regenerate the four harness builds from the corrected primary skill and mirror the bundled package to `.metaproject`, preserving byte parity.
5. Extend `task-implementer-description.test.ts` to reject these unconditional prose forms across every build. The current tests validate schema behavior and generic build parity but do not catch this schema/prose contradiction.

## Acceptance assessment

- Valid issue-free and issue-backed requests, invalid supplied identifiers, and missing root/branch: **MET**.
- Five builds and companion docs agree with the schema with no misleading issue requirement: **NOT MET** due T13-F-001.
- Focused checks and source CLI evidence persisted without source edits or a false global lint claim: **MET**.

## Routing audit

- `graph_used`: not-relevant; the dispatch supplied an exact package and files, and this verification concerns JSON/Markdown contract text rather than code relationships.
- `wiki_used`: not-relevant; no architecture or domain question was needed.
- `ctx_used`: yes; scoped diff, text enumeration, and focused test output were routed through gdctx.
- `raw_rg_used`: no.
