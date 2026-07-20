# Implementation Plan

Status: formalized

## Approach

Add `--external @opentui/core` to the `build` script in `package.json`.
Externalizing the parent package stops `bun build` from traversing into it, so
the platform-specific sub-packages (`@opentui/core-<platform>`) are never
resolved at bundle time. This is the correct treatment for an optionalDependency
that is loaded at runtime via dynamic import (ADR-0005) — it must not be bundled
into `dist/cli.js`. It mirrors how the other optionalDependencies
(`@modelcontextprotocol/sdk`, `web-tree-sitter`) and `@xenova/transformers` are
already externalized in the same script.

Verified locally: `--external @opentui/core` alone is sufficient — no glob or
per-platform externals are needed, because bun does not descend into an
externalized module. `bun build` succeeds and `dist/cli.js` runs.

### Rejected alternatives

- `--external "@opentui/core-*"` glob (or listing each platform package): not
  needed once the parent is external, and adds brittle per-platform noise.
- Removing the `prepare`/build coupling: out of scope; `prepare` building the
  bundle is intended so the published package and `bun install` from git work.
- Bundling / vendoring native binaries: violates the dynamic-import-only policy
  and the zero-runtime-dep floor.

## Steps

1. Edit `package.json` `build` script: append `--external @opentui/core`.
2. `bun run build` -> succeeds.
3. Run `dist/cli.js --help` -> prints `keryx 0.1.0` help.
4. Run the guard tests (AC15 block-d-no-network, no-optional-imports) -> green.
5. Commit package.json only, push to the feature branch, open a draft PR from the
   MrCipherSmith account, confirm the "typecheck, tests, standard" workflow is
   green.

## Risks

- Low. Change is confined to one build-flag string. If a future platform ever
  needs the sub-package bundled, that is a separate, deliberate change.
