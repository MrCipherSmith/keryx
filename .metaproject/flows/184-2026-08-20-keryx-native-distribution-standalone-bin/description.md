# Keryx Native Distribution: standalone binaries, Homebrew tap, install-binary.sh

Status: formalized
Source: docs/requirements/keryx-native-distribution/ (specification ready)

## Problem

keryx has no zero-runtime-prerequisite install path — every existing path
needs `bun` (and usually `git`) already installed.

## Expected Outcome

- `release.yml` builds 4 standalone `bun build --compile` binaries
  (darwin-arm64/x64, linux-x64/arm64) on the existing single runner,
  smoke-tests each, attaches them to the GitHub Release alongside the npm
  tarball.
- `scripts/install-binary.sh` (new, additive — existing `install.sh`
  unchanged) detects platform and installs the matching binary to
  `~/.local/bin/keryx`, the same location `install.sh --global` uses.
- A Homebrew formula in a new tap repo `MrCipherSmith/homebrew-keryx`
  (approved by the user), SHA256-pinned to a real release's binaries.

## Corrected claim (found during this flow, not in the original docpack)

The original specification's D-01/§2 claimed `web-tree-sitter` was
"confirmed functional" in a compiled binary via a real `gdgraph build`
run producing "1 nodes, 0 edges." Live re-verification this flow found
that exact "1 nodes, 0 edges" is the DETERMINISTIC FALLBACK's output, not
a genuine tree-sitter parse — the compiled binary could not actually load
`web-tree-sitter` at all (`Cannot find package 'web-tree-sitter'`),
because `src/capability/seam.ts`'s generic capability-resolution seam
loads every optional dependency via `await import(spec.optionalDependency)`
— a **runtime string variable** Bun's `--compile` bundler cannot trace
statically (confirmed against a real Bun upstream issue,
oven-sh/bun#11732). The spec's own evidence was very likely the fallback
path mistaken for a real one.

Good news, also verified empirically: a **literal** `await
import("web-tree-sitter")` DOES bundle and work correctly (a real probe
loaded the WASM engine and parsed real TypeScript into a genuine AST, zero
`node_modules` present). `@opentui/core` and `@modelcontextprotocol/sdk`
both already use literal import specifiers throughout and were
independently confirmed to bundle-and-work in the compiled binary — MCP
via a real client round-trip (`tools/list` returned 34 real tools),
opentui via a real `createCliRenderer()` construction with genuine
terminal-control-sequence output.

This flow therefore includes a real source fix (T6): an
adapter-level literal-import fast path for the gdgraph/treesitter
capability specifically, WITHOUT touching `src/capability/seam.ts`'s
generic `await import(spec.optionalDependency)` mechanism (locked by
`src/gdgraph/treesitter/no-treesitter-import.test.ts`'s own assertion —
that seam is shared by other, unrelated capabilities like memory
embedding and security NER models, and changing its generic contract is
out of this package's scope and a much larger blast radius than fixing
tree-sitter's one capability).

## Out of Scope

- Windows.
- AUR/scoop/nix/any channel beyond Homebrew.
- Changing the npm package or the existing `install.sh --project`/`--global`
  modes.
- Widening `src/capability/seam.ts`'s generic optional-dependency
  resolution mechanism for capabilities other than gdgraph.treesitter.
- A real, published GitHub Release triggered as part of this flow's own
  verification (release.yml only triggers on a `v*` tag push — this flow
  edits the workflow file, which is safe, but does not push a tag).
