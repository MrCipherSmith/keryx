# gdgraph AST-grade import resolution implementation plan

Version: 0.1.0

## Goal

Improve `gdgraph build` precision for large TypeScript/JavaScript projects by
replacing regex-first import extraction with a parser-backed import scanner and
adding first-slice `tsconfig.json` `baseUrl`/`paths` resolution.

## Context

Feedback identified two recurring graph-quality risks:

- regex import parsing can miss or misread complex TS/JS import forms;
- path aliases such as `@/*` or `~/*` become unresolved even when they are
  valid project-local imports.

The installer currently runs `src/cli.ts` directly from a cloned repository and
does not run `bun install`. Therefore the first slice must not require a new
runtime npm dependency. The TypeScript Compiler API remains a future option, but
using it directly would require changing installer/runtime dependency behavior.

## Decision

Use Bun's built-in `Transpiler.scanImports` as the primary extraction mechanism.
It is available in the required Bun runtime, handles static imports, re-exports,
dynamic imports with literal specifiers, and CommonJS `require` calls, and avoids
shipping a runtime dependency.

Keep the current regex extraction only as a fallback when the scanner is
unavailable or throws.

## Scope

Implemented in this slice:

- parse imports with `Bun.Transpiler.scanImports`;
- keep support for asset imports with suffixes such as `?raw` and `?react`;
- read nearest root `tsconfig.json`;
- support `compilerOptions.baseUrl`;
- support simple wildcard and exact `compilerOptions.paths` mappings;
- resolve alias imports to source files or asset nodes;
- keep unresolved external package imports ignored;
- keep unresolved local/alias imports as `unresolved` edges;
- add tests for path aliases and ignored dynamic template imports.

Out of scope:

- full TypeScript program/symbol graph;
- `extends` chain support for tsconfig;
- package `exports`/workspace package resolution;
- monorepo multi-tsconfig discovery;
- symbol-level affected context.

## Implementation Steps

1. Add a small `TsconfigResolver` builder inside `src/gdgraph/build.ts`.
2. Replace direct `extractImportSpecifiers` regex use with scanner-first
   extraction.
3. Extend import resolution from relative-only to relative-or-alias.
4. Reuse source-file and asset candidate resolution for both relative and alias
   paths.
5. Update gdgraph tests with:
   - `@/*` alias to `src/*`;
   - `~assets/*` alias to asset files;
   - dynamic literal import;
   - dynamic template import ignored rather than false-positive unresolved.
6. Run gdgraph tests, typecheck, and full test suite.

## Risks

- Bun scanner behavior is runtime-specific. This is acceptable because `bun`
  is already the runtime requirement.
- `paths` matching is intentionally first-slice and does not yet cover every
  TypeScript resolution edge case.
- Projects with nested tsconfigs still need future monorepo support.

## Follow-up

Next gdgraph precision slices:

1. monorepo package/workspace resolution;
2. tsconfig `extends` support;
3. TypeScript Compiler API program mode for symbol graph;
4. symbol-level affected context.
