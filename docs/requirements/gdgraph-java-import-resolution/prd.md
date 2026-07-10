# PRD — gdgraph Java/Python Import Resolution

Version: 1.0.0

## Problem

After Java/Python language support was added, gdgraph scans the files and
extracts import specifiers but **cannot resolve them to file paths**, so no
dependency edges are produced.

Verified evidence (real build of `back4/example-backend`):

- `nodes.jsonl`: **3733 nodes** (3732 `java`, 1 `javascript`) — 2788 under
  `src/main/java`, 822 under `src/test/java`.
- `edges.jsonl`: **1 byte (`\n`) — 0 edges.**
- gdgraph's own `summary.md`: `Total nodes: 3733`, `Edges: 0`, `Import edges: 0`,
  yet `Import resolution: 100%`.

Root cause, in `src/gdgraph/build.ts`:

1. `resolveImport()` → `importCandidateBases()` delegates non-relative specifiers
   to `resolver.candidateBases()`, whose only implementation is the
   **tsconfig** resolver. With no `tsconfig.json` (Java/Python projects have
   none) it returns `[]`, so the import is dropped — not even recorded as
   `unresolved`.
2. `resolveSourceCandidate()` only tries `base`, `base.<ext>`, and
   `base/index.<ext>`. There is **no dot→slash translation** for Java packages
   and **no `__init__.py`** for Python.
3. The import-extraction regex for Python requires a leading `[a-zA-Z_]`, so
   **relative imports (`from . import x`) are never extracted.**
4. `Import resolution` is `importTotal > 0 ? imports/importTotal : 100`, where
   `importTotal = imports.length + unresolved.length`. Because dropped
   non-relative imports never become `unresolved` edges, `importTotal` is `0`, so
   the code takes the explicit `: 100` fallback. This is a false-positive metric
   that masks the failure.

Secondary gaps found in the same feature:

- `src/assets/seed.ts` (`GRAMMAR_ASSETS`) has no Java/Python grammar entries, so
  a fresh `keryx init`/`update` does not seed them — only keryx's own hand-edited
  `assets.lock.json` has them.
- `detectSupportedLanguages()` and `renderGdgraphConfig()` (in `config.ts`) are
  **never called** anywhere — dead code.
- Java/Python tests exercise only hand-built mock AST nodes; there is **no
  build-level test** asserting that a resolved edge is produced.

## Goal

Produce real, correct dependency edges for Java and Python in-repo imports, with
zero change to TS/JS behavior, and make the resolution metric honest.

## Users

- **Agents/humans** doing impact analysis, cycle detection, affected-sets, and
  module maps on Java/Python (e.g. Spring Boot backends like example-backend).
- **keryx maintainers** relying on the graph for review/navigation tooling.

## Requirements

### Functional

1. **Language-aware resolution.** Introduce a resolver selected by the importing
   file's language. TS/JS keeps the existing tsconfig/relative path exactly.
2. **Java (Maven & Gradle).** Discover source roots from `pom.xml`
   (`sourceDirectory`, `testSourceDirectory`; default `src/main/java`,
   `src/test/java`) and `build.gradle`(`.kts`) (`sourceSets`), then map a
   fully-qualified name `a.b.C` → `<sourceRoot>/a/b/C.java`. Support multi-module
   (aggregator) layouts by unioning each module's source roots.
3. **Python.** Resolve dotted modules to `pkg/mod.py` and `pkg/__init__.py`
   relative to discovered roots (project root and/or `src/`); handle relative
   imports (`from .x import y`, `from ..a.b import c`) against the importing
   file's package.
4. **Extraction fix.** Extend the Python import regex/parse to capture relative
   imports currently dropped.
5. **Metric fix.** Report import resolution over **all extracted specifiers**
   (resolved vs. unresolved vs. dropped); when zero were extracted, report `n/a`
   (or `0 edges`), never `100%`. Non-relative unresolved imports must be recorded
   as `unresolved` edges, not silently dropped.
6. **Grammar seeding.** Add Java/Python grammars to `GRAMMAR_ASSETS` so new
   projects receive them on `init`/`update`.
7. **Wire or remove dead code.** Either wire `detectSupportedLanguages` /
   `renderGdgraphConfig` into `init`, or remove them.

### Non-functional

- Zero breaking changes to TS/JS resolution (byte-identical graph on TS/JS-only
  projects).
- Graceful fallback when `pom.xml`/`build.gradle` is absent or unparyable.
- Resolve source roots once per build and cache; no per-file re-parse.
- Unit tests for the Maven and Gradle root parsers **and** a build-level test
  asserting resolved edges on a fixture Java and Python project.

## Success criteria

- `back4/example-backend` build shows **> 0 import edges** (currently 0).
- **≥ 80%** of extractable in-repo Java/Python imports resolve to real files.
- The reported resolution metric equals actual `resolved / extracted`, and is
  `n/a` at zero extracted imports.
- All existing tests pass; TS/JS graph output is byte-identical.

## Risks

- **Multi-module Maven** aggregators and non-standard `sourceSets` may miss
  roots → mitigated by unioning discovered roots and falling back to
  `src/main/java` / `src/test/java` conventions.
- **Gradle DSL variety** (Groovy vs Kotlin, dynamic config) makes static parsing
  partial → target the common `sourceSets`/convention cases; treat the rest as
  unresolved rather than wrong.
- **Ambiguous Python roots** (implicit namespace packages, no `src/`) → prefer
  `__init__.py`-anchored packages; document limits.
- Over-counting edges if wildcard imports (`import a.b.*;`) are expanded — treat
  wildcard as a package reference, not a file edge, or omit.

## Recommendation

Proceed. Implement the resolver abstraction first (Java Maven path — the
highest-value case for example-backend), with the metric fix and a build-level
fixture test shipped in the same change so the `0 edges / 100%` regression cannot
recur. Gradle and Python follow as separate increments.
