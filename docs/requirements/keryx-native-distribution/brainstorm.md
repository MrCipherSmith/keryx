# Keryx Native Distribution — Brainstorm
Version: 0.1.0

## Origin

Split from the original "community/adoption evidence" gap-closing item
(#3 in the priority table), which bundled two different problems: install
friction, and contributor/issue-flow tooling (changesets, issue-triage). An
explicit choice was made to scope this package to install friction only —
see the parent conversation's decision, not re-litigated here.

## Reference design studied: opencode

A single root-level `install` shell script (served at opencode.ai/install)
auto-detects OS/arch/libc(musl)/CPU baseline and fetches the matching
prebuilt binary from GitHub Releases; the README lists 10+ parallel install
channels (npm/bun/pnpm/yarn, Homebrew tap + official formula, scoop, choco,
pacman/AUR, mise, nix run) all resolving to the same versioned artifact,
kept in sync by a GitHub Actions matrix.

Relevance: the direct model. The key structural fact this package's own
research had to establish (not assume from the summary above) is that
keryx's current install paths do NOT already work this way — see
current-state findings below.

## Current-state findings (this session, direct source reading)

Read directly, not assumed from the original gap-closing research summary
(which undercounted keryx's own existing install surface as "one path"):

- **npm**: `@mrciphersmith/keryx`, `bin: {"keryx": "./dist/cli.js"}`, built
  via `bun build ./src/cli.ts --outdir ./dist --target bun --external
  @modelcontextprotocol/sdk --external web-tree-sitter --external
  @opentui/core`. Requires `bun` at runtime — `--target bun` is a
  bun-runtime-executed bundle, not a standalone executable.
- **Clone-based** (`install`/`install.ts` → `scripts/install.sh`): `git
  clone --depth 1`, `bun install` (full dev+optional deps), runs
  interpreted via `bun src/cli.ts`. Requires `bun` AND `git`.
- **`release.yml`**: single job, `ubuntu-latest`, no OS matrix. Publishes to
  npm via OIDC trusted publishing (no token — a real, already-solid security
  posture worth preserving, not just reusing incidentally). Attaches only
  the npm `.tgz` to the GitHub Release today; no compiled binary artifact
  exists anywhere in the current pipeline.
- **`package.json` `optionalDependencies`**: exactly three —
  `@modelcontextprotocol/sdk`, `@opentui/core`, `web-tree-sitter` — matching
  the build script's `--external` list precisely. This is the exact set
  this package's live compile test needed to interrogate.

## The live compile test

Not left as a documentation-sourced claim. Run directly, this session:

```
bun build ./src/cli.ts --compile --outfile <scratch>/keryx-compile-test
```

(No `--external` flags — testing whether `--compile` needs them at all, not
assuming the npm build's reasons for excluding them apply here too.)

Result: 72.1MB binary. `--version` → `0.2.49`. `--help` → full, correct CLI
usage listing. Then, the meaningful test — not just "does it launch" but
"does an optional, WASM-backed dependency actually function" — a scratch
directory with one real `.ts` file, `keryx gdgraph build` run from the
compiled binary: `gdgraph build complete: 1 nodes, 0 edges`. Correct output,
proving `web-tree-sitter` parsed the file for real.

`mcp serve` was also tried (backgrounded, redirected output, killed after a
2-second wait) — exited with no output and no visible error, which is
consistent with normal behavior for an MCP stdio server with no client
attached, but is not the same strength of evidence as the gdgraph result.
Recorded honestly as inconclusive in prd.md/specification.md, not rounded up
to "confirmed working."

`@opentui/core` (the TUI) was not tested — the test environment has no real
TTY, and a smoke test that can't exercise the actual code path isn't
evidence either way. Left as a named, explicit gap for implementation-time
verification (specification.md AC5).
