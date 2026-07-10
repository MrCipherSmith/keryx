# gdgraph Java/Python import resolution

Status: formalized
Source: user description + requirements package
`docs/requirements/gdgraph-java-import-resolution/`

## Problem

gdgraph scans `.java`/`.py` files into nodes and extracts import specifiers, but
its only resolver understands TypeScript/JavaScript path semantics
(`tsconfig.json` + relative paths). Java fully-qualified imports and Python dotted
modules never map to files, so a Java/Python graph has thousands of nodes and
**zero edges** — impact analysis, cycles, affected-sets and the module map are all
empty. The import-resolution metric additionally reports `100%` when zero imports
were processed (`0 / 0`) — a false-success signal.

## Expected Outcome

- A language-aware `ImportResolver` selected by the importing file's language;
  TS/JS keeps the existing tsconfig/relative logic **byte-identically**.
- Java (Maven & Gradle): FQN `a.b.C` → `<sourceRoot>/a/b/C.java`, roots derived
  from `pom.xml` / `build.gradle(.kts)`, resolved once per build and cached.
- Python: dotted modules → `pkg/mod.py` / `pkg/__init__.py`, plus relative
  imports (`from . import x`) that are currently dropped at extraction.
- Honest metric: rate over all extracted specifiers; `n/a` at zero extracted;
  non-relative unresolved imports emitted as `unresolved` edges (not dropped).
- Java/Python tree-sitter grammars seeded in `src/assets/seed.ts`.
- Dead code `detectSupportedLanguages` / `renderGdgraphConfig` (config.ts) either
  wired into init or removed.

## Out of Scope

- External jar / transitive dependency-coordinate resolution.
- Classpath/build execution (`mvn`/`gradle` invocation). Resolution is static.
- Semantic (symbol-level) cross-language call resolution (separate tree-sitter
  symbol layer).
