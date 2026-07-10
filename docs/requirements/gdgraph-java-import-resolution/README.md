# gdgraph Java/Python Import Resolution

Version: 1.0.0

## Purpose

Give gdgraph a **language-aware import resolver** so that Java (and Python)
source files produce a real dependency graph. Today the file layer scans
`.java`/`.py` files into nodes and extracts import specifiers, but the resolver
only understands TypeScript/JavaScript path semantics (`tsconfig.json` +
relative paths). Java fully-qualified imports and Python dotted modules never map
to files, so the graph has **thousands of nodes and zero edges** — impact
analysis, cycles, affected-sets, and the module map are all empty for these
languages.

## Status

`implemented` — resolver, metric fix, and grammar seeding shipped under
`src/gdgraph/build.ts` and `src/assets/seed.ts`; dead code removed from
`src/gdgraph/config.ts`. Verified: `bunx tsc --noEmit` = 0, full `bun test` green
(incl. new `build-lang.test.ts`), TS/JS graph byte-identical (AC4 guard), and an
end-to-end build of `back4/example-backend` produced **47,984 edges** (was 0) —
19,360 resolved `imports` + 28,624 `unresolved` external, **94% in-repo
(`com.example.*`) resolution**, honest overall rate 40.3% (no longer `0/0 = 100%`).

## Document index

- [README.md](README.md) — this file: purpose, status, scope, index.
- [prd.md](prd.md) — problem, goal, users, requirements, success criteria, risks, recommendation.
- [specification.md](specification.md) — resolver design, config shape, data contracts, acceptance criteria.
- [metrics-and-validation.md](metrics-and-validation.md) — measurable targets, the `0/0 = 100%` metric-reporting bug, and validation plan.

## Scope

In scope:

- A resolver abstraction that dispatches by language, keeping the current
  TS/JS path exactly as-is (zero behavior change).
- **Java**: map fully-qualified names (`com.example.admin.dto.FixReplicaRequest`) to
  files under Maven/Gradle source roots (`src/main/java/com/example/admin/dto/FixReplicaRequest.java`).
- **Python**: resolve dotted modules to `pkg/mod.py` and `pkg/__init__.py`, and
  extract the relative imports (`from . import x`) that are currently dropped.
- Fixing the **import-resolution metric**, which reports `100%` when zero
  imports were processed (`0 / 0`).
- Seeding the Java/Python tree-sitter grammars so new projects get them.

Non-goals:

- Full Maven/Gradle dependency-coordinate resolution (external jars, transitive
  deps). Only in-repo source-to-source edges are targeted.
- Classpath/build execution. Resolution is static, from source layout + build
  config, never by invoking `mvn`/`gradle`.
- Semantic (symbol-level) call resolution across languages — that is the
  separate tree-sitter symbol layer.

## Related modules

- **gdgraph** — the module this extends (`src/gdgraph/build.ts` resolver,
  `src/gdgraph/config.ts`, `src/assets/seed.ts`).
- Predecessor feature: "gdgraph: Add Java and Python language support" (merged;
  commits `898ec13`, `5631ee4`, `2070c2e`, `ac5e35c`) — added scanning and
  import extraction but not resolution.
