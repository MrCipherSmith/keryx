# Fix CI: externalize @opentui/core in build script so bun build/prepare no longer fails on platform sub-packages

Status: formalized
Source: user description

## Problem

CI ("typecheck, tests, standard" workflow, `MrCipherSmith/keryx`) has failed on
every merge to `main` at the "Install dependencies" step since `@opentui/core`
was added as an optionalDependency.

Root cause: the `prepare` script runs `bun run build`, and the `build` script
bundles `src/cli.ts` with `bun build`. `@opentui/core` is NOT externalized, so
bun traverses into it and tries to statically resolve every platform-specific
native sub-package it dynamically imports (`@opentui/core-darwin-x64`,
`-linux-x64`, `-linux-x64-musl`, `-linux-arm64`, `-win32-x64`, `-win32-arm64`,
…). Only the current platform's sub-package is installed, so bun errors with
`Could not resolve: "@opentui/core-darwin-x64". Maybe you need to "bun install"?`.
Because `prepare` runs during `bun install`, `bun install` itself fails in CI.

Reproduced locally: `bun run build` fails with the same "Could not resolve
@opentui/core-*" errors.

## Expected Outcome

- `bun run build` succeeds locally and in CI.
- `bun install` (which triggers `prepare` -> `build`) succeeds in CI.
- The built `dist/cli.js` still runs (`keryx --help` works), with `@opentui/core`
  resolved at runtime from node_modules via its existing dynamic import.
- The GitHub Actions "typecheck, tests, standard" workflow goes green on the PR.

## Out of Scope

- Any change to `dependencies` / `optionalDependencies` (must stay the lean set
  guarded by AC15).
- Any change to how `@opentui/core` is imported in source (already dynamic-import
  only per ADR-0005; guarded by the no-optional-imports test).
- Bundling native binaries or vendoring platform sub-packages.
