# Keryx Native Distribution — PRD
Version: 0.1.0

## Problem

keryx already has two install paths — `npm install -g @mrciphersmith/keryx`
and the clone-based `scripts/install.sh` — and both were undercounted as
"one generic install path" by the earlier comparative research. But reading
both directly shows a real, shared gap: neither is zero-prerequisite. The
npm path needs npm/Node; `bun`'s own runtime is still required to execute
`dist/cli.js` (`bin: {"keryx": "./dist/cli.js"}`, built with
`--target bun`, not a standalone executable). The clone path needs `bun` AND
`git`, then clones full source and runs it interpreted. Neither matches
opencode's studied pattern: a single script that detects OS/arch/libc and
downloads a prebuilt, dependency-free binary from GitHub Releases — the
`install` script IS the whole install, no separate runtime required
afterward.

## Goal

A real standalone binary, built from the existing `bun build --compile`
capability (confirmed cross-compilable from one machine for
macOS-arm64/macOS-x64/Linux-x64/Linux-arm64 — no per-OS runner matrix
needed), attached to GitHub Releases, with a Homebrew channel as the first
native package-manager consumer of it.

## Users

- An operator with Homebrew installed who does not want to install `bun`
  first, or install `bun` at all, just to try keryx.
- A CI/container context wanting a single dependency-free binary rather than
  a `bun install` step.

## Requirements

1. `bun build --compile` produces a working, standalone executable for each
   of macOS-arm64, macOS-x64, Linux-x64, Linux-arm64 from the existing
   `release.yml` runner (`ubuntu-latest`) — verify cross-compilation actually
   works for keryx's specific entrypoint before committing to this as fact;
   the general Bun capability is confirmed (sourced), keryx's own build has
   not been tried.
2. **Optional-dependency bundling — live-verified during this PRD's
   authorship, not left as a paper question.** `package.json`'s `build`
   script marks `@modelcontextprotocol/sdk`, `@opentui/core`, and
   `web-tree-sitter` as `--external` for the npm-targeted build. A real local
   `bun build ./src/cli.ts --compile` (no `--external` flags) against
   keryx's actual entrypoint was run and its output exercised directly:
   `--version`/`--help` worked, and — the meaningful test — `keryx gdgraph
   build` against a real TypeScript file from the compiled binary correctly
   produced `1 nodes, 0 edges`, proving `web-tree-sitter` (the WASM-backed,
   most bundling-risky of the three) genuinely works standalone, not merely
   that the binary launches. `keryx mcp serve`'s bundling was NOT
   conclusively verified the same way — a background smoke test exited
   quickly with no error output, consistent with normal stdio-server
   behavior when no MCP client is attached rather than a bundling failure,
   but this is not proof either way and must be re-verified with a real MCP
   client round-trip before implementation claims it works. `@opentui/core`
   was not exercised at all (the TUI needs a real TTY this test environment
   didn't have) and is unverified.
3. Each platform binary is smoke-tested in CI before being attached to a
   release — mirroring `release.yml`'s existing "Build and smoke-test the
   packed artifact" step for the npm tarball, not a lower bar for the new
   artifact.
4. A Homebrew formula (tap or core, to be decided — see specification.md)
   that installs the macOS binary matching the user's architecture.
5. `scripts/install.sh` gains a new mode (or a new sibling script) that
   downloads the matching platform binary directly, rather than requiring
   `bun`/`git` — the actual "reduce install friction" deliverable, not just
   an artifact nobody's install path points at yet.
6. The existing npm and clone-based install paths are unchanged in behavior.
   This is additive.
7. Tag/version consistency: the new artifacts follow the same
   tag-must-match-`package.json` discipline `release.yml` already enforces
   for the npm publish — no separate, weaker version contract for binaries.

## Success Criteria

- `curl -fsSL .../install-binary | bash` (or equivalent) on a clean macOS or
  Linux machine with no `bun`/`git`/`node` installed produces a working
  `keryx --version` with no additional setup.
- `brew install keryx` (tap or core) produces the same.
- Every existing install path (`npm install -g`, `scripts/install.sh
  --global`, `scripts/install.sh --project`) is unaffected — verified by the
  existing release smoke-test step continuing to pass unmodified.
- The optional-dependency question (Requirement 2) has a recorded, tested
  answer, not a silent gap discovered by a user whose MCP/TUI/gdgraph
  feature quietly does not work in the binary build.

## Risks

- **Optional-dependency bundling — partially de-risked, not fully closed.**
  The highest-risk dependency (`web-tree-sitter`, WASM-backed) is now
  live-confirmed to bundle and function correctly. `@modelcontextprotocol/sdk`
  is untested by a real client round-trip; `@opentui/core` (the TUI) is
  entirely untested (needs a real TTY). The current npm build's `--external`
  choice for all three may have been made together for a reason that does
  not actually apply to two of them, or may reflect real, undiscovered
  issues with the other two specifically — this PRD does not assume either
  reading.
- **72MB artifact size.** The local test build was 72.1MB uncompressed, with
  no `--external` flags at all (i.e., bundling everything, including
  dependencies not yet confirmed necessary to bundle). Four platform
  binaries per release is meaningfully more GitHub Release storage/bandwidth
  than the current single npm tarball — not a blocker, but a cost the
  specification should size rather than discover.
- **Homebrew maintenance cost.** A formula is a small, ongoing maintenance
  surface (version bumps, SHA256 updates) distinct from writing it once;
  keryx is effectively single-author (per the original comparative
  research), so this is a recurring cost accepted, not a one-time task.
- **CI surface growth.** `release.yml` currently does one job on one runner
  with tight, deliberate gates (documented inline, e.g. the ripgrep
  omission incident). Adding a compile-and-attach step to that same
  disciplined pipeline is lower-risk than a parallel, less-scrutinized one,
  but still real new surface to keep passing on every tagged release.

## Recommendation

Proceed to implementation planning. The one question that could have
invalidated the whole premise — can `--compile` bundle keryx's WASM-backed
optional dependency at all — is answered yes, by a real functional test, not
documentation. What remains (MCP round-trip, TUI/TTY, artifact size
budgeting) are scoping details for specification.md, not open
go/no-go questions.
