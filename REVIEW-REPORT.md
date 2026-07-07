---
review_run_id: gd-metapro-full-review-2026-07-07T12-02-10Z
orchestrator: review-orchestrator
project_overlay: none
verdict: REQUEST_CHANGES
context_mode: light
model_strategy: current-session
current_model: deepseek-v4-flash-free (opencode)
model_assignment: current session
agents:
  - review-architecture
  - review-logic
  - review-backend
  - review-frontend
  - review-clean-code
  - review-style
  - review-security-code
  - review-performance
  - review-highload
  - review-core-boundaries
  - review-flow-graph
  - review-testing-practices
  - code-ai-review
  - code-b091-review
  - review-strict
scope:
  pr: null
  base: path-mode
  head: 25ae7bba1268d9d164222efaad2b136acf56c759
  files_changed: 107
generated_at: 2026-07-07T12:02:10Z
---

# Review Report

## Verdict: REQUEST_CHANGES

## Summary

This is a full-project review of `gd-metapro` — a TypeScript/Bun CLI tool (~20,658 LOC, 107 source files, 27 test files) for managing agent-aware project metadata (code graphs, wiki, memory, skills, health, testing, flow/task orchestration). The codebase is **architecturally well-structured** with clean module boundaries, a strong dependency-inversion pattern in several services, and strict TypeScript configuration. However, it has **critical data-integrity issues** in the flow persistence layer (non-atomic writes, TOCTOU races on concurrent access), **several blocker-level test isolation bugs** (parallel `chdir` races, shared temp paths), and a **systemic TOCTOU epidemic** across gdskills and flow modules where concurrent file writes corrupt single-source-of-truth files. The 1350+ line files (`init.ts`, `skills.ts`, `lib/templates.ts`) and massive code duplication between `init.ts`/`update.ts` reduce maintainability. Health score is 89/100 (WARN, regressed -6 from baseline), with 28 P2 findings primarily about cyclomatic complexity.

## Review Scope

- Mode: `path` (full project)
- Scope: `src/` — 107 .ts files, ~20,658 lines
- Modules: cli, commands, flow, gdgraph, gdskills, health, lib, memory, testing, wiki
- Branch: `main`
- HEAD: `25ae7bba1268d9d164222efaad2b136acf56c759`
- Reviewers dispatched: review-architecture, review-logic, review-backend, review-frontend, review-clean-code, review-style, review-security-code, review-performance, review-highload, review-core-boundaries, review-flow-graph, review-testing-practices, code-ai-review, code-b091-review, review-strict, review-frontend-conventions
- Convention reviewers: review-frontend-conventions (src/**/*.ts), review-testing-practices (27 test files), review-core-boundaries (src/lib/ shared), review-flow-graph (src/flow/)
- Context mode: light (metaproject wiki, memory, health, skills catalog)
- Model strategy: current-session (deepseek-v4-flash-free via opencode)
- Model assignment: current session (unsupported per-reviewer model assignment)
- Token budget: unbounded; omissions: none; sub-agents filtered per-domain file content

## Stats

- blocker: 8
- major: 26
- minor: 31
- info: 18

## Blockers (must fix before merge)

### [F-503] Concurrent `flow init` silently destroys existing flow data

- **Severity**: blocker
- **File**: `src/flow/service.ts:113-118`
- **Problem**: Two concurrent `flow init` calls with the same title: both pass `pathExists` check, second `mkdir({ recursive: true })` succeeds silently, then overwrites all files from the first flow. Data destruction, not just duplicate IDs.
- **Why it matters**: Complete loss of flow data including AC confirmations, task status, and history. No recovery possible.
- **Fix**: Use `mkdir` without `recursive: true`. Use `mkdirSync` with `recursive: false` and catch `EEXIST`. Or mkdir-then-check.

### [F-500] Non-atomic `writeFlow` — crash corrupts single source of truth

- **Severity**: blocker
- **File**: `src/flow/store.ts:60`
- **Problem**: `writeFlow` writes directly with `writeFile`. If the process crashes mid-write, `flow.json` is truncated/corrupted. Unlike health artifacts (reproducible), each `flow.json` is unique and irrecoverable.
- **Why it matters**: A single corrupted `flow.json` means the entire flow is lost. No backup, no recovery path.
- **Fix**: Write to `flow.json.tmp` then `rename()` atomically across the same filesystem.

### [F-100] TOCTOU race on flow load-mutate-save — no file locking

- **Severity**: blocker
- **File**: `src/flow/store.ts:40-63`
- **Problem**: Every service method follows `load(cwd, id)` → mutate in-memory → `save()` without any file-level locking. Two concurrent calls interleave: A reads, B reads, A writes, B writes — B's write silently overwrites A's state. All mutation methods (`init`, `taskAdd`, `taskDone`, `acConfirm`, `acUpdate`, `complete`, `block`, `unblock`) follow this pattern.
- **Why it matters**: Lost state transitions, duplicate journal entries, corrupted `acConfirmed` map, or silently overwritten `previousStatus`.
- **Fix**: Add advisory file locking (`proper-lockfile` or `lockfile`) around each load-mutate-save critical section.

### [F-400] TOCTOU race on metaproject.json — concurrent skill creation corrupts registry

- **Severity**: blocker
- **File**: `src/gdskills/project-skills.ts:513-530`
- **Problem**: `updateManifest` reads `metaproject.json`, mutates in memory, writes back. Two concurrent `createProjectSkill` calls race — second write overwrites the first's registry entry. Same pattern in `updateSkillsCatalog` for `catalog.md`.
- **Why it matters**: Losing registry entries means skills become untracked; `resolveProjectSkill` fails for them silently.
- **Fix**: Use a file-level lock or serialize writes. Derive `catalog.md` from the registry rather than round-tripping it.

### [F-401] TOCTOU race on learning proposal application

- **Severity**: blocker
- **File**: `src/gdskills/learn.ts:170-172`
- **Problem**: `applyLearningProposal` checks `pathExists(appliedReportPath)` then writes. Two concurrent calls both pass the guard, both proceed, creating duplicate skill updates.
- **Why it matters**: Duplicate lesson application pollutes changelog and loses the idempotency guarantee.
- **Fix**: Write the `.applied.json` marker file atomically first, then apply changes. Or use `rename` from a temp file.

### [F-601] `process.chdir()` causes cross-file race conditions in all command tests

- **Severity**: blocker
- **File**: `src/commands/dashboard.test.ts:49`, `src/commands/init.test.ts:12`, `src/commands/update.test.ts:39`
- **Problem**: Three test files use `process.chdir(root)` to change CWD. Bun runs test files in parallel by default; concurrent mutations of process-global `cwd` collide.
- **Why it matters**: Tests that pass in isolation fail in CI when multiple command test files run concurrently.
- **Fix**: Refactor tested functions to accept an explicit `cwd` parameter instead of calling `process.cwd()`. Pass temp directory directly without `chdir`.

### [F-602] `scopes-component.test.ts` depends on checked-in project file structure

- **Severity**: blocker
- **File**: `src/health/scopes-component.test.ts:7-17`
- **Problem**: Test reads real project files (`src/health/metrics/churn.ts`, `src/health/run.ts`) from disk. If these files are renamed or moved, the test breaks.
- **Why it matters**: Brittle — depends on specific files existing in the repo. Not a unit test. Will fail in CI if project restructured.
- **Fix**: Create synthetic source files in a temp directory with known LOC and complexity.

### [F-603] Flow service test uses shared project-relative temp path

- **Severity**: blocker
- **File**: `src/flow/service.test.ts:7`
- **Problem**: `ROOT = path.join(import.meta.dir, "..", "..", ".tmp-flow-test")` — a fixed path inside the project. All tests share the same location; `fresh()` deletes/recreates it. If tests run in parallel across files or a previous run crashed without cleanup, artifacts collide.
- **Why it matters**: Non-isolated temp storage causes inter-test pollution and false CI failures.
- **Fix**: Use `mkdtemp(path.join(tmpdir(), "gd-flow-"))` per test file.

## Major Issues

### F-230: SonarQube status hardcoded, bypassing adapter's `detect`
- **File**: `src/health/service.ts:77-83`
- **Problem**: `detectStatuses()` hardcodes sonarqube status as `"missing"` instead of calling `sonarqubeAdapter.detect(ctx)`. The adapter has a working `detect` method.
- **Why it matters**: `gd-metapro health sources` always reports sonarqube as `missing` even when `sonar-issues.json` exists.
- **Fix**: Replace hardcoded block with `sonarqubeAdapter.detect(ctx)` call.

### F-211: Tests adapter silently swallows import failure in auto mode
- **File**: `src/health/sources/tests.ts:193-196`
- **Problem**: When `NoImportError` is thrown in `auto` mode for the `tests` adapter, `runAdapter` returns `status: "missing"` with no error message. Unlike other adapters, it never falls back to `run`.
- **Why it matters**: A corrupt test report file causes the tests source to be silently skipped. User sees `missing` and doesn't know why.
- **Fix**: Log a warning or fall back to `run` like other adapters.

### F-228: `failOnMissingRequiredSource` ignored when strict is false
- **File**: `src/health/gate.ts:51-55`
- **Problem**: Config setting `gate.failOnMissingRequiredSource` only takes effect when `strict` is true. User-configured behavior is silently bypassed.
- **Why it matters**: The option name implies it controls behavior independently of strict mode. User expectations are violated.
- **Fix**: Remove the `strict` guard, or rename to `failOnMissingRequiredSourceWhenStrict`.

### F-231: Glob matching only handles suffix patterns
- **File**: `src/health/util.ts:136-146`
- **Problem**: `matchesPattern` only handles `/**` suffix and `*` suffix patterns. Standard glob patterns like `**/dist/**` are not matched.
- **Why it matters**: Ignore patterns silently fail — build artifacts may be included in complexity analysis.
- **Fix**: Import a proper glob matching library (`minimatch` or `picomatch`) or document the limitation.

### F-213: Coverage path resolution may mismatch source file paths
- **File**: `src/health/metrics/coverage.ts:44`
- **Problem**: Istanbul coverage uses absolute paths. `path.relative(cwd, key)` may not match source file paths if `cwd` involves symlinks or differs from the coverage generation directory.
- **Why it matters**: Per-file coverage data silently fails to match, producing `null` coverage for affected scopes.
- **Fix**: Normalize both sides with `path.resolve()` before comparison.

### F-214: Average coverage uses unweighted mean
- **File**: `src/health/scopes.ts:198-209`
- **Problem**: `averageCoverage()` computes simple mean of per-file coverage percentages, weighting all files equally regardless of LOC.
- **Why it matters**: A 1-line file at 0% and a 1000-line file at 100% produce 50% — misleading for module comparisons.
- **Fix**: Compute LOC-weighted coverage: `total_covered_lines / total_lines`.

### F-209: Files with findings outside sourceFiles create sparse analysis
- **File**: `src/health/scopes.ts:155-172`
- **Problem**: `filesToReport` includes files referenced by findings even if excluded by `config.ignore.paths`. No `sourceAnalysis` entry exists for these files, so LOC/complexity default to 0.
- **Why it matters**: Scores for ignored/generated files are computed with incomplete data.
- **Fix**: Skip files not in `sourceFiles` when building file scopes, or warn.

### F-502 (missed): `selectScopeTests` uses `.includes()` causing over-broad matching
- **File**: `src/testing/service.ts:469`
- **Problem**: `file.includes(normalized)` matches ANY substring. Scope `"core"` matches `"src/core/flow/store.ts"` (correct) but also `"src/ecommerce/core-logic.ts"` (wrong).
- **Why it matters**: Tests can be incorrectly included or excluded from scope-based test selection.
- **Fix**: Replace with `file.startsWith(normalized + "/") || file === normalized`.

### F-501 (missed): Hardcoded regression threshold `> 0` ignores `failOnRegressionDrop` config
- **File**: `src/health/service.ts:99`
- **Problem**: `metrics.filter(m => m.regression_score > 0)` uses hardcoded `> 0`. Config `failOnRegressionDrop: 10` is ignored.
- **Why it matters**: Every 1-point drop reported as regression, creating distrust through false positives.
- **Fix**: Use `config.gate.failOnRegressionDrop` as threshold.

### F-101: Mutating operations allowed on terminal/blocked flows
- **File**: `src/flow/service.ts:197-243`
- **Problem**: `acUpdate`, `taskAdd`, `taskDone`, `acConfirm` call `assertAcIntact` but never `assertTransition`. You can add tasks or confirm criteria on a `"done"` or `"blocked"` flow.
- **Why it matters**: Silently modifying a completed flow's AC checksum or task list breaks the audit trail.
- **Fix**: Add `assertNotTerminal(flow.status)` guard at the top of all four mutation methods.

### F-102: Concurrent `init` can produce duplicate flow IDs
- **File**: `src/flow/store.ts:23-29`
- **Problem**: `nextFlowId` reads directory listing to compute `max + 1`. Two concurrent `init` calls compute the same next ID.
- **Why it matters**: Operations referencing flow by ID become non-deterministic — `dirs.find()` returns first alphabetical match.
- **Fix**: Make `nextFlowId` atomic using a counter file with O_CREAT|O_EXCL semantics.

### F-001: Cross-module dependency gdskills → memory + wiki
- **File**: `src/gdskills/verify.ts:5-6`
- **Problem**: `gdskills/verify.ts` imports `relevantAcceptedMemory` and `wikiValidate` — a production dependency from orchestrator into two domain modules. No abstraction layer.
- **Why it matters**: If wiki/service.ts changes its `wikiValidate` signature, gdskills breaks. Tight coupling.
- **Fix**: Introduce a verifier interface or use file-system reads to keep coupling at data-contract level.

### F-003: `lib/templates.ts` is a bloated 1450+ line module
- **File**: `src/lib/templates.ts`
- **Problem**: Exports 15+ rendering functions: HTML dashboards, shell hooks, markdown docs, CLI stubs. SRP violation.
- **Why it matters**: Hard to navigate, test, and reason about. Pulls all weight even when one function is needed.
- **Fix**: Split into domain-aligned template files or move to owning modules.

### F-403: `normalizeGdskillsProfile("custom")` returns "recommended"
- **File**: `src/gdskills/catalog.ts:427-430`
- **Problem**: "custom" profile is declared valid but `getBundledSkillsForProfile("custom")` falls back to "recommended" immediately. No way to select a subset.
- **Why it matters**: User-visible contract violation. `--profile custom` silently gives the full recommended set.
- **Fix**: Implement actual custom filtering or remove "custom" from the type.

### F-402: `resolveSkillForLearning` uses substring haystack matching
- **File**: `src/gdskills/learn.ts:230-236`
- **Problem**: `haystack.includes(entry.target)` — any occurrence of the target string anywhere in source matches, regardless of relevance.
- **Why it matters**: Lessons routed to wrong skills with high confidence.
- **Fix**: Require `--skill` for non-health sources. Remove haystack fallback or require explicit confirmation.

### F-300: Massive code duplication between init.ts and update.ts
- **File**: `src/commands/init.ts`, `src/commands/update.ts`
- **Problem**: Six utility functions (`installManagedHook`, `writeTextIfChanged`, `writeTextIfMissing`, `copyFileIfChanged`, `runtimeSourcePath`, `escapeRegExp`) fully duplicated verbatim across both files. Each file also has ~85 lines of identical imports.
- **Why it matters**: Bug fixes must be applied twice. Maintenance liability.
- **Fix**: Extract all six helpers into a shared module like `src/lib/fs-io.ts`.

### F-302: `optionValue` silently returns next flag as value
- **File**: `src/lib/args.ts:1-4`
- **Problem**: `optionValue(args, "--flag")` returns the very next element regardless of whether it's another flag. `--gdskills-profile --no-health` returns `"--no-health"` as profile value.
- **Why it matters**: Users silently get wrong behavior if they omit a required value.
- **Fix**: Check if `args[index + 1]` is defined and does not start with `--`.

### F-304: `init.ts` is 1352 lines with monolithic `initCommand` (~490 lines)
- **File**: `src/commands/init.ts:156-647`
- **Problem**: `initCommand` handles 8 module enablement prompts with identical `if (options.noX) { disable } else if (!options.yes) { confirm() }` spanning 190+ lines. Same pattern for 4 hooks.
- **Why it matters**: High cognitive load; adding a module requires copying the entire block.
- **Fix**: Extract a `promptModule(options, key, label)` helper. Would collapse 190 lines to ~10.

### F-305: `skills.ts` is 1110 lines
- **File**: `src/commands/skills.ts`
- **Problem**: All skills subcommands (verify, learn, export, sync, create, contracts, route, inspect, status) in a single file. Sequential verification of N skills.
- **Why it matters**: Hard to navigate, maintain, and test.
- **Fix**: Split into `src/commands/skills/` directory. Run `Promise.all` for independent verifications.

### F-306: Inconsistent error handling — throws vs console.error + exitCode
- **File**: Multiple commands (flow.ts, dashboard.ts, gdgraph.ts, etc.)
- **Problem**: Some subcommands `throw new Error()`, others use `console.error()` directly. Two different patterns produce different output formatting.
- **Why it matters**: Inconsistent UX. Scripts can't rely on uniform error output format.
- **Fix**: Standardize: throw typed errors and let top-level catch handle formatting, or always use `console.error` + `process.exitCode`.

### F-409: `exportProjectSkill` assumes source exists
- **File**: `src/gdskills/export.ts:65`
- **Problem**: `copyFile(SKILL.md, ...)` without checking existence. If package deleted between resolve and copy, throws unhandled `ENOENT` with partial output already written.
- **Why it matters**: Partial failure leaves target directory in inconsistent state.
- **Fix**: Catch `ENOENT` or verify existence before copying.

### F-411: `collectVerificationSignals` target-check is heuristic and fragile
- **File**: `src/gdskills/verify.ts:187-198`
- **Problem**: `targetLooksLikePath` checks for `/`, `.`, or `./`. Target `auth-flow` (no dots/slashes) always passes; `example.com` (contains `.`) triggers stats on non-existent file.
- **Why it matters**: Skills targeting concepts always pass the check, masking real issues.
- **Fix**: Store an explicit `targetType` field in the registry (`path` | `symbol` | `module`).

### F-423: Test coverage — only 2 of 9 gdskills files tested
- **File**: gdskills module
- **Problem**: `contracts.ts`, `export.ts`, `learn.ts`, `project-skills.ts`, `resolve.ts`, `sync.ts`, `catalog.ts` have zero tests. The only test file for verify covers only gdwiki validation.
- **Why it matters**: High-risk code (async file I/O, path resolution, registry mutation, JSON schema validation) has no regression guard.
- **Fix**: Add unit tests for resolve, export, learn, schema validation, and sync paths.

### F-604: `runTesting` test spawns real `bun test` subprocess
- **File**: `src/testing/service.test.ts:52-70`
- **Problem**: Test actually spawns `bun test` as a child process. Requires working bun, installed deps, and no actual test failures.
- **Why it matters**: Not deterministic — depends on runtime environment. Flaky outside CI.
- **Fix**: Mock the `runCommand` internal function or inject a command runner dependency.

### F-605: skill-loop test is a cross-module E2E test in a unit test file
- **File**: `src/health/skill-loop.test.ts:1-83`
- **Problem**: Imports `learnProjectSkill` from `../gdskills/learn` and exercises the full Code Health → gdskills feedback loop. Creates real file artifacts.
- **Why it matters**: Failure in gdskills breaks a health test. Uses fixed project-relative temp path.
- **Fix**: Move to integration test directory or mock the external dependency.

### F-606: `install.test.ts` asserts magic number for installed skills count
- **File**: `src/gdskills/install.test.ts:14`
- **Problem**: `expect(result.installedSkills).toBeGreaterThan(20)` depends on actual bundle contents.
- **Why it matters**: Test breaks every time gdskills bundle is updated.
- **Fix**: Assert structural properties: `> 0` and known skill names.

### F-607: TypeScript type bypasses weaken test type safety
- **File**: `src/health/parsers.test.ts:8`, `src/health/skills.test.ts:29`, `src/health/sources/sonarqube.test.ts:5`
- **Problem**: Three uses of `as unknown as HealthContext` and `as never` to bypass type checking.
- **Why it matters**: When source code types evolve, these tests won't catch type errors.
- **Fix**: Create proper factory functions producing type-correct minimal objects.

### F-608: Critical error paths and subcommands untested across commands
- **File**: `src/commands/dashboard.test.ts`, `init.test.ts`, `update.test.ts`
- **Problem**: Unknown subcommand error, `--help`, existing metaproject detection, interactive prompt paths (only `--yes` tested), and error handling for missing manifest are untested.
- **Why it matters**: Error paths may regress silently.
- **Fix**: Add tests for unknown subcommand, `--help`, and error cases.

### F-609: GitHub tracker tests only cover `parseRef` — 4 of 6 methods untested
- **File**: `src/flow/tracker/github.test.ts`
- **Problem**: `detect`, `fetchIssue`, `prStatus`, `comment` have no tests. All call real `gh` CLI.
- **Why it matters**: Multiple error-handling paths (Bun.which null, non-zero exit codes, JSON parse failures) untested.
- **Fix**: At minimum test `detect()` when `gh` is not installed and `parseRef` edge cases.

### F-610: `ingest.test.ts` only covers reconciliation — creates zero new entries
- **File**: `src/memory/ingest.test.ts:29-57`
- **Problem**: Single test only exercises "reconcile near-duplicate" path. No test creates entries from new findings or handles empty findings arrays.
- **Why it matters**: Primary function (creating new memory entries) is untested.
- **Fix**: Add test with genuinely new finding that creates a new entry.

### F-504 (missed): Case-sensitive path comparison — fails on case-insensitive filesystems
- **File**: `src/gdskills/resolve.ts:20`
- **Problem**: `path.resolve(projectRoot, entry.path) === directPackage` is a string comparison. On APFS (case-insensitive), `src/Commands/Init.ts` ≠ `src/commands/init.ts` even though both resolve to the same file.
- **Why it matters**: Registry lookup fails silently on macOS, the primary development platform.
- **Fix**: Normalize via `fs.realpath.native` or case-fold comparison.

## Minor Issues

### F-301: CLI uses fragile if-else chain for command routing
- **File**: `src/cli.ts:19-101`
- **Problem**: 14 commands dispatched via linear if/else chain. No ability to list commands programmatically.
- **Fix**: Replace with `Map<string, Function>` and extract command name via destructuring.

### F-303: `requireId` matches `--flag` as positional ID when no positional args present
- **File**: `src/commands/flow.ts:249-255`
- **Problem**: If only flags passed, `id` is `undefined` and shows misleading error.
- **Fix**: Use `args[0]` with explicit check.

### F-005: Duplicate `slugify` across 3 files
- **File**: `src/flow/store.ts:126`, `src/memory/service.ts:151`, `src/gdskills/project-skills.ts:585`
- **Problem**: Three nearly identical slugify functions. Flow version also caps at 40 chars (undocumented).
- **Fix**: Move canonical `slugify` to `src/lib/strings.ts`.

### F-006: Duplicate file walking in health + testing
- **File**: `src/health/util.ts:82-101`, `src/testing/service.ts:279-294`
- **Problem**: Both implement same recursive file walk with IGNORED_DIRS set. Nearly identical but maintained independently.
- **Fix**: Move canonical walk function to `src/lib/fs.ts`.

### F-103: `list()` silently drops corrupt flows
- **File**: `src/flow/service.ts:155-169`
- **Problem**: `for await` loop catches ALL errors from `readFlow` with empty `catch { }`. No logging, no warning.
- **Fix**: Log warning to stderr with flow directory name or collect error entries.

### F-104: Empty string bypasses required `--title` check
- **File**: `src/flow/service.ts:87-88`
- **Problem**: `if (!input.title && !input.issue)` — `??` operator only checks null/undefined, so `""` passes validation.
- **Fix**: Change to `if (!input.title?.trim() && !input.issue)`.

### F-105: `taskDone` on already-done task creates duplicate history entries
- **File**: `src/flow/service.ts:212-220`
- **Problem**: No idempotency check. Calling `taskDone` for already-done task pushes redundant history event.
- **Fix**: Check `task.status === "done"` and either throw or return as-is.

### F-106: `checksGreen` never returns `null` for the no-CI-checks case
- **File**: `src/flow/tracker/github.ts:72-76`
- **Problem**: Type declares `checksGreen: boolean | null` (null = unknown), but adapter always returns `boolean`. PR with no CI checks exits non-zero, so `checksGreen` is `false`, not `null`.
- **Fix**: Parse output to distinguish "checks ran and failed" from "no checks configured".

### F-107: Stderr pipe silently consumed in `gh()` helper
- **File**: `src/flow/tracker/github.ts:5-12`
- **Problem**: `Bun.spawn` pipes stderr but output is never read or logged. Error messages (expired token, wrong repo) go nowhere.
- **Fix**: Capture stderr and include in thrown error or log to stderr.

### F-108: Silent catch-all swallows errors in context collection
- **File**: `src/flow/context.ts:60-61, 89-91, 107-109`
- **Problem**: Three try-catch blocks use empty `catch { }`. Intended for "module absent" but also swallow real errors (corrupted JSON, bugs).
- **Fix**: Log caught errors at debug/warn level before swallowing.

### F-109: No runtime type validation of `FlowState` from JSON
- **File**: `src/flow/store.ts:50`
- **Problem**: `JSON.parse(...) as FlowState` is compile-only. Hand-edited or corrupted `flow.json` proceeds with invalid data.
- **Fix**: Add runtime schema validator (Zod or manual shape check) at `readFlow` boundary.

### F-308: `dashboardCommand` imports `buildDashboard` from `update.ts`
- **File**: `src/commands/dashboard.ts:3`
- **Problem**: Importing `update.ts` (1145 lines) just for `buildDashboard` pulls the entire update dependency tree.
- **Fix**: Extract `buildDashboard` into its own module.

### F-307: Duplicate import blocks across init.ts and update.ts
- **File**: `src/commands/init.ts:1-85`, `src/commands/update.ts:1-73`
- **Problem**: Both files import nearly the same 60+ render functions — ~85 lines of identical imports each.
- **Fix**: Create barrel imports from `../lib/templates`.

### F-405: `listFiles` duplicated 3× across gdskills module
- **File**: `src/gdskills/export.ts:136-149`, `sync.ts:142-155`, `install.test.ts:86-97`
- **Problem**: Same recursive file-listing utility copied verbatim in three places.
- **Fix**: Extract to `src/lib/fs.ts`.

### F-407: `readManifest` duplicated across gdskills files
- **File**: `src/gdskills/learn.ts:194-200`, `verify.ts:119-126`, `project-skills.ts` (inline)
- **Problem**: Three copies of nearly identical `readManifest` with locally redefined `MetaprojectManifest` type.
- **Fix**: Export `MetaprojectManifest` and a single `readManifest` from shared location.

### F-408: Bundled path resolution — four identical fallback patterns
- **File**: `src/gdskills/install.ts:135-221`
- **Problem**: `contractSourcePath`, `bundledSkillSourcePath`, `bundledSharedSourcePath`, `bundledRulesSourcePath` are structurally identical. Final fallback returns non-existent path.
- **Fix**: Extract single `resolveBundledPath(...segments)` returning `undefined` when neither path exists.

### F-206: Finding ID collision when `ruleId` is null in ESLint adapter
- **File**: `src/health/sources/helpers.ts:40-46`
- **Problem**: When `ruleId` is null, `key` becomes `"eslint"` for all errors on the same file/line.
- **Fix**: Include content hash of message in the ID.

### F-229: Corrupted `latest.json` silently returns null
- **File**: `src/health/service.ts:33-36`
- **Problem**: When `latest.json` is corrupted, `readLatest` silently returns `null`. User sees "no data" with no indication file exists but is unreadable.
- **Fix**: Log warning to stderr when file exists but parsing fails.

### F-207: `history.ts` and `config.ts` lack permission error handling
- **File**: `src/health/history.ts:40`, `src/health/config.ts:57`
- **Problem**: `loadHistory()` calls `readdir` without try-catch. `loadHealthConfig()` calls `pathExists` without handling permission errors.
- **Fix**: Wrap `readdir` in try-catch (returning `[]` on failure).

### F-223: Unknown source filter silently ignored in run
- **File**: `src/health/run.ts:56-62`
- **Problem**: If user passes `--source unknown-source`, filter is created but never validated against known adapter IDs. Run completes with no warning.
- **Fix**: Validate each entry against `FINDING_ADAPTERS.map(a => a.id)` plus coverage/complexity.

### F-225: Test uses `as never` to bypass type checking
- **File**: `src/health/skills.test.ts:29`
- **Problem**: `buildOwnership([{ module: "m" } as never])` bypasses all TypeScript safety.
- **Fix**: Use proper type or `Partial<RegistryEntry>[]`.

### F-227: Trend detection uses first/last points only
- **File**: `src/health/history.ts:89-99`
- **Problem**: `computeTrend()` computes `delta = current - first`. A-shaped trends (improve then decline) with similar endpoints classified as "stable".
- **Fix**: Use linear regression slope or require monotonicity.

### F-410: `copyDirectoryIfExists` silently skips symlinks to directories
- **File**: `src/gdskills/export.ts:124-133`
- **Problem**: `entry.isDirectory()` returns `false` for symlinks-to-directories. Contents silently omitted.
- **Fix**: Handle `entry.isSymbolicLink()` with `stat` to determine target type.

### F-412: `pushGdwikiSignal` truncates validation issues to 3
- **File**: `src/gdskills/verify.ts:285-288`
- **Problem**: `.slice(0, 3)` silently drops issues beyond 3. User fixes 3, runs again, sees 3 more.
- **Fix**: Include total count (e.g., "... and 12 more issues").

### F-413: `validateContractFile` — no input size protection
- **File**: `src/gdskills/contracts.ts:83`
- **Problem**: `readFile` loads entire file, `JSON.parse` parses it. Maliciously large JSON (500MB) crashes process.
- **Fix**: Add size limit check before reading.

### F-414: Recursive `validateValue` without stack-depth guard
- **File**: `src/gdskills/contracts.ts:128-233`
- **Problem**: Recurses for each nested property. Deeply nested objects (10,000 levels) cause stack overflow.
- **Fix**: Convert to iterative traversal or add depth parameter with reasonable limit.

### F-415: `resolveRef` hardcodes `"review-finding.schema.json"`
- **File**: `src/gdskills/contracts.ts:250`
- **Problem**: Only one external schema reference supported via hardcoded filename. Any other cross-schema ref throws.
- **Fix**: Generalize to load any schema by filename from the CONTRACTS registry.

### F-417: `healthLessonsForSkill` — exact string match may mismatch formats
- **File**: `src/gdskills/learn.ts:294`
- **Problem**: `skillKey` is `"module/name"` but health report's `scope.skill` may use just `"name"`. If formats differ, filter produces zero matches.
- **Fix**: Normalize both sides to canonical `module/name` before comparison.

### F-418: `extractLessons` keyword matching — unreliable fallback
- **File**: `src/gdskills/learn.ts:312-325`
- **Problem**: When JSON parsing fails, keyword filtering produces low-quality "lessons" from error logs.
- **Fix**: Require structured input. Gate keyword fallback behind `--allow-unstructured`.

### F-419: `slugify` strips non-ASCII
- **File**: `src/gdskills/project-skills.ts:585-593`
- **Problem**: `[^a-z0-9]+` removes non-ASCII. Module like `überwachung` produces `berwachung`. Empty string falls back to `"entity"`.
- **Fix**: Transliterate Unicode to ASCII before slugging, or allow Unicode.

### F-420: `copyDirectory` across gdskills — no error aggregation
- **File**: `src/gdskills/export.ts:124-133`, `sync.ts:134-140`, `install.ts:56`
- **Problem**: All `copyFile` calls unguarded. Single file failure throws unhandled error with partial files already written.
- **Fix**: Collect errors, attempt all files, throw aggregate error. Use temp dirs + atomic rename.

### F-110: History array grows unbounded with no eviction policy
- **File**: `src/flow/service.ts:65`
- **Problem**: Every `save()` pushes to `flow.history`. No cap, no TTL, no pruning. Serializes into `flow.json` on every write.
- **Fix**: Add `maxHistory` cap (e.g., 500) with FIFO eviction.

### F-701: `parseCounts` omits skipped tests — total is wrong
- **File**: `src/testing/service.ts:626-639`
- **Problem**: Regex only matches `pass` and `fail`, never `skip`. `total` = `passed + failed`. Skipped tests invisible.
- **Fix**: Add skip capture group. Compute total as max of parsed values.

### F-702: `parseFailures` only handles bun `(fail)` format
- **File**: `src/testing/service.ts:608-624`
- **Problem**: Looks for `\(fail\)\s+(.*)$` — bun-specific. Jest/Vitest/Playwright output goes unmatched.
- **Fix**: Add runner-specific failure parsers or generalize to broader pattern.

### F-703: Wiki link checker misresolves absolute `/` paths
- **File**: `src/wiki/service.ts:155-156`
- **Problem**: Links starting with `/` treated as filesystem-absolute, not wiki-root-relative. False broken-link reports.
- **Fix**: Resolve relative to `wikiRootPath(cwd)` when `filePart` starts with `/`.

### F-704: `entity` filter is case-sensitive while `module` filter is case-insensitive
- **File**: `src/memory/search.ts:47`
- **Problem**: `filters.entity` compares raw strings. Search for `"http-step"` won't match entry with `"HTTP-Step"`.
- **Fix**: Normalize entity comparison with `.toLowerCase()`.

### F-611: `store.test.ts` does not test `collectEntries`
- **File**: `src/memory/store.test.ts`
- **Problem**: `collectEntries` — the primary memory entry loader — has zero tests. Only `parseEntry` is tested.
- **Fix**: Add test with multiple .md files and verify sorted results.

### F-612: Flow machine tests miss `blocked` state outbound behavior
- **File**: `src/flow/machine.test.ts:21-26`
- **Problem**: `canTransition("blocked", "in-progress")` never tested. Service's `unblock` bypasses `assertTransition`.
- **Fix**: Document blocked special-case or add `blocked: ["ready", "in-progress", ...]` to TRANSITIONS.

### F-613: complexity-findings does not test threshold boundary
- **File**: `src/health/metrics/complexity-findings.test.ts:8-34`
- **Problem**: Does not test exact threshold, below threshold, or empty file cases.
- **Fix**: Add boundary tests for `threshold - 1`, `threshold === value`, `threshold + 1`.

### F-615: `verify.test.ts` does not test non-dryRun path
- **File**: `src/gdskills/verify.test.ts:9-42`
- **Problem**: Both tests pass `dryRun: true`. Real update logic (writing skill files) is untested.
- **Fix**: Add test with `dryRun: false` verifying writes are idempotent.

### F-616: Gate test misses optional-source-failure and boundary values
- **File**: `src/health/gate.test.ts:61-100`
- **Problem**: Missing: optional source in "configured-but-failed", regression score at boundary, coverage at boundary.
- **Fix**: Add tests for optional source failure and exact-boundary scores.

### F-617: History test does not test `loadHistory`
- **File**: `src/health/history.test.ts`
- **Problem**: All 6 tests only test `computeTrend`. Disk I/O and corrupt-data handling untested.
- **Fix**: Write snapshot JSON files to temp directory and test `loadHistory`.

## Info

### F-111: Duplicated blocked-transition logic in `machine.ts`
- **File**: `src/flow/machine.ts:16-18`
- **Fix**: Remove special case — derive `blocked` programmatically from TRANSITIONS map.

### F-210: npm vs bun audit output format fragility
- **File**: `src/health/sources/dependency-audit.ts:33-48, 54-69`
- **Fix**: Detect which tool produced output and validate key presence.

### F-220: Two runs in same millisecond overwrite history JSON
- **File**: `src/health/run.ts:44, 249`
- **Fix**: Add unique suffix (process.ppid or random) to filename.

### F-224: scopes-component.test.ts depends on real project file structure
- **File**: `src/health/scopes-component.test.ts:9`
- **Fix**: Use mkdtemp and write controlled files.

### F-226: Low-risk findings dominate scoring for small scopes
- **File**: `src/health/scoring.ts:36-45`
- **Fix**: Document normalizePerLoc semantics in config schema.

### F-311: Help text inconsistencies between master and subcommand help
- **File**: `src/cli.ts:141-145`
- **Fix**: Derive master help from subcommand help, or reference `gd-metapro flow --help`.

### F-312: `ctx diff` — raw git flags without validation
- **File**: `src/commands/ctx.ts:118-119`
- **Fix**: Intercept known flags and validate, or add --help subcommand.

### F-313: `ctx read --mode` unsafe optionValue
- **File**: `src/commands/ctx.ts:164`
- **Fix**: Validate --mode has a value after the flag.

### F-314: `skills create` and `skills generate` are full aliases with separate help
- **File**: `src/commands/skills.ts:126-128`
- **Fix**: Drop `generate` alias or make it hidden.

### F-315: No centralized config path resolution
- **File**: Every command file
- **Fix**: Export `metaprojectRoot()` from shared lib.

### F-316: `skills route` normalization behavior undocumented
- **File**: `src/commands/skills.ts:359-395`
- **Fix**: Document normalization in `route` help text.

### F-317: `updateCommand` has dual responsibility — runtime AND service files
- **File**: `src/commands/update.ts:111-138`
- **Fix**: Make runtime update best-effort; log warning on failure but continue.

### F-318: `compactLines` and `importantLines` duplicate regex pattern
- **File**: `src/commands/ctx.ts:563-567, 576-578`
- **Fix**: Extract to module-level ERROR_PATTERN constant.

### F-319: `parseScope` silently returns undefined for unknown scope values
- **File**: `src/commands/health.ts:206-225`
- **Fix**: Validate scope value and print error for unrecognized formats.

### F-406: `today()` duplicated across gdskills files
- **File**: `src/gdskills/learn.ts:561`, `project-skills.ts:603`
- **Fix**: Extract to `src/lib/date.ts`.

### F-416: `renderAgentCommandContract` hardcodes `"entity-skill-creator"`
- **File**: `src/gdskills/catalog.ts:471-474`
- **Fix**: Add `hasCommandContract` property to BundledSkill.

### F-421: `validateSyncTarget` — `isPathInside` name ambiguous
- **File**: `src/gdskills/sync.ts:85-98`
- **Fix**: Rename to `isSubpathOf` or add JSDoc.

### F-422: `verifyProjectSkill` updates `Last Verified` timestamp even on failure
- **File**: `src/gdskills/verify.ts:113`
- **Fix**: Only update when status !== "blocked" and !== "stale".

### F-424: `installGdskills` sequential skill write loop
- **File**: `src/gdskills/install.ts:51-60`
- **Fix**: Collect all write promises and `await Promise.all(...)`.

### F-425: Mix of sync (`existsSync`) and async (`pathExists`) in install.ts
- **File**: `src/gdskills/install.ts`
- **Fix**: Replace `existsSync` with `await pathExists`.

### F-505 (missed): `validateValue` continues checking enum after type mismatch
- **File**: `src/gdskills/contracts.ts:142-155`
- **Problem**: Produces two errors for a single violation when type check fails but enum check continues.
- **Fix**: Add `return` after type-mismatch error.

### F-705: `WikiValidate` re-runs full link check every time
- **File**: `src/wiki/service.ts:190-242`
- **Fix**: Accept optional `skipLinkCheck` flag or cache reports.

### F-706: `checkMemory` redundant backtick strip on scoped files
- **File**: `src/memory/check.ts:31`
- **Fix**: Remove dead code — `parseScopes` already strips backticks.

### F-707: `reflectMemory` uses `existsSync` instead of async `pathExists`
- **File**: `src/memory/reflect.ts:50`
- **Fix**: Replace with `await pathExists(file)`.

### F-708: `runTesting` never produces `"error"` status
- **File**: `src/testing/service.ts:94-178`
- **Problem**: Type includes `"error"` but code only assigns `"skipped"`, `"pass"`, `"fail"`.
- **Fix**: Wrap `Bun.spawn` in try/catch and set `status = "error"` on failure.

## Positive Notes

- **Strong TypeScript config**: `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true` — catches many issues at compile time.
- **Clean module boundaries**: The `src/lib/` layer is properly free of project imports. Modules are well-separated by directory.
- **Good dependency-injection pattern**: `FlowServiceDeps`, `HealthContext`, `TrackerAdapter` — clean interfaces for external dependencies.
- **Comprehensive skill system**: The gdskills module has a well-designed plugin lifecycle (catalog → install → export → sync → verify → learn).
- **Well-tested core logic**: Scoring algorithms, gate logic, state machine, search, and dedup have strong unit test coverage.
- **Deterministic analysis**: Health and testing modules use heuristics instead of LLM calls — deterministic and predictable.
- **No secrets committed**: No hardcoded credentials, API keys, or tokens found in source code.

## Fix Order

1. Data integrity blockers: F-503 (mkdir race), F-500 (atomic write), F-100 (flow locking), F-400/401 (gdskills TOCTOU)
2. Test isolation: F-601 (chdir races), F-602 (real-files), F-603 (shared temp)
3. Silent correctness bugs: F-230 (sonarqube), F-211 (tests adapter), F-501 (hardcoded threshold), F-502 (over-broad scope matching)
4. Maintainability: F-300 (init/update duplication), F-003 (templates.ts split), F-304/305 (monolithic files)
5. Test coverage: F-423 (gdskills tests), F-608/609/610 (critical untested paths)

## Validation Plan

- `bun test` — ensure all tests pass after fixes
- `tsc --noEmit` — type check passes
- `gd-metapro health status` — verify health system works after threshold/gate fixes
- `gd-metapro flow init --title "test"` — verify flow creation with atomic writes
- `gd-metapro skills verify <skill>` — verify gdskills verification path
