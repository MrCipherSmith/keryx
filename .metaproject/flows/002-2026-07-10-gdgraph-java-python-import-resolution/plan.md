# Implementation Plan

Status: frozen approach (per PRD recommendation)

## Approach

Incremental, TDD-first, as the PRD recommends: ship the resolver abstraction +
Java Maven path + metric fix + build-level fixture test **in the same first
increment** so the `0 edges / 100%` regression cannot recur; Gradle and Python
follow as separate increments. TS/JS stays byte-identical by keeping the existing
tsconfig/relative logic behind an unchanged `typescript|javascript` dispatch
branch.

Rejected alternatives:
- Rewriting the whole resolver into one mega-function → risks TS/JS regression;
  rejected in favor of a narrow `ImportResolver` interface with per-language
  implementations, TS/JS impl = current code verbatim.
- Invoking `mvn`/`gradle` for source roots → out of scope; static parse only.

## Steps (execution order)

1. **T3 (test, tests-creator) — FAILING tests first (TDD).**
   - Build-level: fixture Maven Java project → assert `imports` edges > 0 and a
     specific FQN edge resolves.
   - Build-level: fixture Python package (incl. `__init__.py` + relative import)
     → assert `imports` edges > 0.
   - Regression: TS/JS-only fixture → build twice (baseline captured, then after
     changes) asserting `nodes.jsonl` + `edges.jsonl` byte-identical.
   - Metric: `0 extracted → n/a`; non-relative unresolved → `unresolved` edge.
   - Unit: Maven `pom.xml` root parse (single + multi-module); Gradle
     `sourceSets` parse (Groovy + Kotlin). (Gradle/Python unit asserts may start
     skipped/failing until their increment.)
   All must FAIL initially (assert red before green).

2. **T2 (implement, task-implementer) — Java Maven resolver + metric fix.**
   - Generalize `TsconfigResolver` → `ImportResolver` interface; dispatch in
     `resolveImport()`/`resolveAssetImport()` by `getLanguage(fromFile)`.
   - `loadJavaResolver`: parse `pom.xml` (`build/sourceDirectory`,
     `testSourceDirectory`, `<modules>` union) with `src/main/java`,
     `src/test/java` defaults; FQN dots→slashes per root; cache roots per build.
   - `resolveSourceCandidate`: language-appropriate suffix (`.java`).
   - Metric fix in `writeSummary()`: count extracted/resolved/unresolved over all
     specifiers; `rate = extracted === 0 ? n/a : resolved/extracted`; emit
     non-relative unresolved as `unresolved` edges (adjust `shouldTrackUnresolved`).
   - Wildcard `import a.b.*;` → package reference only, no fabricated file edge.
   - Make T3's Java + metric + regression tests green.

3. **T5 (implement, task-implementer) — Gradle source roots.**
   - `build.gradle`/`.kts` `sourceSets { main/test { java { srcDirs } } }`;
     default roots; fold into the Java resolver. Green Gradle unit tests.

4. **T6 (implement, task-implementer) — Python resolver + extraction fix.**
   - Extend Python extraction to capture relative imports (`from . import x`,
     `from ..a.b import c`).
   - `loadPythonResolver`: roots = project root + `src/`; absolute `a.b.c` →
     `R/a/b/c.py` | `R/a/b/c/__init__.py`; relative → resolve against importing
     file's package (count leading dots). Green Python tests.

5. **T7 (implement, task-implementer) — Grammar seeding.**
   - Add `tree-sitter-java` + `tree-sitter-python` to `GRAMMAR_ASSETS`
     (real pinned sha256/size). Also add java/python to
     `DEFAULT_GDGRAPH_CONFIG.treesitter.languages` if consistent with F6.

6. **T8 (implement, task-implementer) — Dead-code decision.**
   - Wire `detectSupportedLanguages`/`renderGdgraphConfig` into `init` (write
     `gdgraph.config.json` with detected languages) — the package recommends
     wiring. If wiring proves out-of-scope/risky, remove them instead. Decide and
     journal the rationale.

7. **T4 (review) — verification + review + E2E.**
   - `code-verifier`: lint, `bunx tsc --noEmit` == 0, full `bun test`.
   - Regression byte-identical re-check.
   - `review-orchestrator` on the diff.
   - E2E: `keryx gdgraph build` on example-backend → edges > 0 + spot-check
     `com.example.admin.dto.FixReplicaRequest`.

8. **T9 (docs) — package + roadmap updates.**
   - README status `spec ready`/draft → implemented; roadmap line; bump versions
     of changed docs.

## Risks

- Multi-module Maven / non-standard `sourceSets` → union discovered roots + fall
  back to conventions.
- Gradle DSL variety → target common `sourceSets`/convention cases; rest =
  unresolved, not wrong.
- Ambiguous Python roots → prefer `__init__.py`-anchored packages; document limits.
- **TS/JS regression** → the byte-identical test is the guardrail; the TS/JS
  dispatch branch must call the exact existing code path.
- Wildcard over-counting → treat `import a.b.*;` as a package ref, not a file edge.
