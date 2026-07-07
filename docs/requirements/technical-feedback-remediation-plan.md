# Technical feedback remediation plan

Version: 0.1.0

## Purpose

This plan converts external technical feedback into an ordered implementation
track. It covers graph precision, health runtime performance, hook safety,
complexity precision, and CLI argument parsing.

## Principles

- Keep installer/runtime behavior compatible with the current Bun-first,
  zero-runtime-dependency install path.
- Prefer small verified slices over broad rewrites.
- Preserve deterministic output ordering even when implementation becomes
  parallel internally.
- Update module-specific specifications when behavior changes.
- Add tests before relying on a behavior in docs or agent workflows.

## Phase 1: gdgraph parser-backed import resolution

Status: implemented in this branch.

Scope:

- replace regex-first import extraction with Bun `Transpiler.scanImports`;
- keep regex extraction as fallback;
- support root `tsconfig.json` `baseUrl` and `paths`;
- resolve aliases to source files and assets;
- ignore non-literal dynamic imports instead of producing false unresolved
  edges.

Verification:

- `bun test src/gdgraph/build.test.ts`;
- `bun run typecheck`;
- full `bun test`.

Follow-up:

- nested tsconfigs;
- `extends`;
- workspaces/package exports;
- symbol graph.

## Phase 2: Code Health parallel adapter execution

Status: implemented in this branch.

Scope:

- run independent finding adapters concurrently;
- keep `sourceInfos` ordered by `FINDING_ADAPTERS`;
- keep raw artifact paths deterministic by adapter id and shared run stamp;
- preserve strict/fallback behavior per adapter;
- keep coverage and complexity after finding adapters because they are metric
  sources and complexity consumes source analysis.

Verification:

- full health tests;
- full test suite;
- manual compare of latest report shape if needed.

## Phase 3: Git hook compatibility

Status: implemented in this branch.

Scope:

- test existing user hook preservation;
- test managed block replacement/idempotency;
- test shebang preservation and executable mode;
- document that hooks are block-managed and do not overwrite Husky/Lefthook
  style hooks.

Verification:

- update/init command tests;
- full test suite.

## Phase 4: Complexity AST-safe slice

Status: implemented first safe slice in this branch.

Scope:

- keep no runtime npm dependency;
- improve nested-function handling first;
- subtract nested function bodies from enclosing function complexity counts;
- keep token-based scanner as fallback until a full AST/symbol mode lands;
- document remaining approximation.

Verification:

- complexity tests for nested callbacks, TSX-like braces, template strings;
- health complexity findings tests;
- full test suite.

## Phase 5: CLI parseArgs migration slice

Status: first helper slice implemented in this branch.

Scope:

- introduce a shared helper around `node:util.parseArgs`;
- migrate low-risk option-heavy commands first;
- keep positional command routing unchanged initially;
- preserve public CLI strings and error behavior where tests depend on them.

Implemented first:

- shared `parseBooleanFlags` helper;
- `dashboard` command migration;
- helper tests for positionals and `-h`.

Candidate first commands:

- `health`;
- `test`;
- `dashboard`;
- `wiki collect`.

Verification:

- command unit tests;
- CLI help tests;
- full test suite.

## Explicit non-goals for this pass

- full TypeScript Compiler API program graph;
- new runtime npm dependencies;
- npm/package publishing automation;
- dashboard UI redesign;
- monorepo workspace resolution beyond documentation and follow-up tracking.
