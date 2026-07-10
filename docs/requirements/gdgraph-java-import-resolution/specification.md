# Specification — gdgraph Java/Python Import Resolution

Version: 1.0.0

## Module identity

An extension of the **gdgraph** file-level build, not a new module. All changes
live under `src/gdgraph/` (plus `src/assets/seed.ts` for grammar seeding). No new
CLI command; the behavior is exercised by the existing `keryx gdgraph build`.

## Current structure (what exists today)

`src/gdgraph/build.ts` — file graph builder:

- `SOURCE_EXTENSIONS` includes `.java`, `.py` (files are scanned into nodes).
- `extractImportSpecifiers()` — regex extraction with `jsPatterns`,
  `javaPatterns` (`import a.b.C;`), `pythonPatterns` (`import a.b`,
  `from a.b import c`). **Gap:** no relative-Python pattern.
- `resolveImport()` → `importCandidateBases()` → `resolver.candidateBases()`.
- `createTsconfigResolver()` / `loadTsconfigResolver()` — the ONLY resolver.
- `resolveSourceCandidate(base, fileSet)` — tries `base`, `base+ext`,
  `base/index+ext`. **Gaps:** no dot→slash, no `__init__.py`.
- `getLanguage(file)` maps `.java`→`java`, `.py`→`python`.

`src/gdgraph/config.ts` — `detectSupportedLanguages()` and
`renderGdgraphConfig()` exist but are **unwired** (dead code).

`src/assets/seed.ts` — `GRAMMAR_ASSETS` has ts/tsx/js only (no java/python).

## Proposed design

### 1. Resolver abstraction

Generalize the existing `TsconfigResolver` into a per-language `ImportResolver`
interface selected by the importing file's language:

```ts
interface ImportResolver {
  // Ordered candidate repo-relative bases for a raw specifier from `fromFile`.
  candidateBases(specifier: string, fromFile: string): string[];
}
```

`resolveImport()` picks the resolver by `getLanguage(fromFile)`:

- `typescript | javascript` → existing tsconfig/relative logic (unchanged).
- `java` → `MavenGradleResolver`.
- `python` → `PythonResolver`.

`resolveSourceCandidate()` gains language-appropriate candidate suffixes:
Java `<base>.java`; Python `<base>.py` and `<base>/__init__.py`.

### 2. Java resolver (`loadJavaResolver`)

- Discover source roots from build config, once per build, cached:
  - `pom.xml`: `build/sourceDirectory`, `build/testSourceDirectory`; multi-module
    `<modules>` each contribute roots; default `src/main/java`, `src/test/java`.
  - `build.gradle`/`build.gradle.kts`: `sourceSets { main/test { java { srcDirs } } }`;
    default `src/main/java`, `src/test/java`.
- `candidateBases("a.b.C")` → for each root `R`: `R/a/b/C` (dots→slashes).
  `resolveSourceCandidate` then appends `.java`.
- Wildcard `import a.b.*;` → resolve to a package reference only (no file edge),
  or omit; never fabricate a file edge.

### 3. Python resolver (`loadPythonResolver`)

- Roots: project root and `src/` if present.
- Absolute `a.b.c` → `R/a/b/c.py` or `R/a/b/c/__init__.py`.
- Relative `from .x import y` / `from ..a import b` → resolve against the
  importing file's package directory (count leading dots for parent levels).
- Extraction must be extended to capture the relative forms currently dropped.

### 4. Metric correction

In the summary/report path of `build.ts`:

- Count `extracted`, `resolved`, `unresolved` over **all** specifiers (not only
  relative). Non-relative imports that fail to resolve are emitted as
  `unresolved` edges.
- `resolutionRate = extracted === 0 ? null : resolved / extracted`; render `n/a`
  when null. Never emit `100%` for `0/0`.

### 5. Grammar seeding

Add `tree-sitter-java` and `tree-sitter-python` entries to `GRAMMAR_ASSETS` in
`src/assets/seed.ts` (same jsDelivr `tree-sitter-wasms@0.1.13` source, pinned
sha256/size), so `init`/`update` seed them into `assets.lock.json`.

### 6. Dead-code decision

Wire `detectSupportedLanguages()`/`renderGdgraphConfig()` into `init` (write a
`gdgraph.config.json` with detected languages) or delete them. The package
recommends wiring, so mixed-language projects self-configure.

## Config shape

Existing `.metaproject/gdgraph.config.json`:

```json
{ "treesitter": { "languages": ["typescript", "tsx", "javascript", "java", "python"] } }
```

No new config keys are required; source roots are derived from `pom.xml` /
`build.gradle`, not configured by hand. (Optional future: an override for
non-standard roots.)

## Data contracts

- **GraphNode** — unchanged; `language` already widened to include
  `"java" | "python"`.
- **GraphEdge** — unchanged shape (`from`, `to`, `kind`, `specifier`); `kind`
  stays `"imports" | "asset" | "unresolved"`. Java/Python resolved imports emit
  `imports` edges; failed ones emit `unresolved` (no longer silently dropped).

## Integration points

- `keryx gdgraph build` (no new flags).
- `keryx sync --apply` / post-commit staleness — unchanged; benefits
  automatically once edges exist.
- Downstream consumers (module map, affected-set, cycles, gdwiki `collect`
  Reference/Related Wiki) start producing real Java/Python results with no
  changes on their side.

## Acceptance criteria

1. Build of a fixture Maven Java project resolves `a.b.C` imports to files and
   emits `imports` edges.
2. Build of a fixture Python project resolves absolute and relative imports,
   including `__init__.py` packages.
3. `back4/example-backend` build reports **> 0 import edges** and a resolution
   rate that is not `0/0`-derived.
4. TS/JS-only project graph is **byte-identical** to before.
5. Summary reports `n/a` (not `100%`) when zero imports are extracted.
6. New projects receive Java/Python grammars via `seed.ts`.
7. Unit tests for Maven and Gradle root parsing; build-level tests asserting
   resolved edges for Java and Python fixtures.
