# Keryx Native Distribution — Decisions
Version: 0.3.0

## D-01: Standalone binary via `bun build --compile`, not thin wrappers

**Decision.** Build a real standalone binary as the foundation for native
package-manager channels, rather than thin Homebrew/AUR wrappers that shell
out to `npm install`/`git clone` under the hood.

**Reasoning.** A thin wrapper is cheaper to write but does not close the
actual gap: an operator without `bun` installed still ends up needing it.
opencode's studied pattern — the one this work is modeled on — specifically
avoids that: its install script IS the whole install, no runtime
dependency survives it. Confirmed technically viable before committing:
Bun cross-compiles `--compile` binaries for macOS/Linux from one machine
(specification.md §2, sourced), and a live local build of keryx's actual
entrypoint produced a working 72.1MB binary with its highest-bundling-risk
optional dependency (`web-tree-sitter`, WASM) confirmed functional by a real
`gdgraph build` run, not just a launch check.

**Amended by flow 184 (`keryx-native-distribution`), 2026-08-20.** The
`web-tree-sitter` claim in the reasoning above was wrong: the "confirmed
functional" `gdgraph build` run's "1 nodes, 0 edges" output is the
DETERMINISTIC FALLBACK's output, not a genuine tree-sitter parse. The
compiled binary could not actually load `web-tree-sitter`
(`Cannot find package 'web-tree-sitter'`), because `src/capability/seam.ts`'s
generic `await import(spec.optionalDependency)` resolves a **runtime string
variable**, which Bun's `--compile` bundler cannot trace statically
(confirmed against oven-sh/bun#11732). The decision to build a real
standalone binary (this D-01's actual decision) is unaffected — it does not
rest on tree-sitter specifically — but the supporting evidence line does not
hold as written.

Re-verification the same flow found the decision's foundation intact from a
different angle: `@modelcontextprotocol/sdk` and `@opentui/core`, which
already use literal import specifiers throughout, both independently
bundle-and-work correctly in the compiled binary — MCP via a real client
round-trip (`tools/list` returned 34 real tools, not just "process exited
without error"), OpenTUI via a real `createCliRenderer()` construction with
genuine terminal-control-sequence output, zero `node_modules` present.
`web-tree-sitter` itself was also confirmed to bundle-and-work when reached
through a **literal** `await import("web-tree-sitter")` rather than through
the generic seam — proving the standalone-binary approach is sound, and
narrowing the actual gap to one capability's import path, not the whole
tree-sitter dependency or the decision itself. The fix (a
gdgraph/treesitter-specific literal-import fast path, not a change to
`seam.ts`'s generic contract) is tracked as this flow's T6. See
[specification.md](specification.md) §2's amendment for the full record.

## D-02: Single-runner cross-compile, no OS matrix

**Decision.** `release.yml` gains a build loop on its existing
`ubuntu-latest` runner, not a new per-OS runner matrix.

**Reasoning.** Bun's cross-compilation support (D-01) makes a matrix
unnecessary work — `release.yml`'s own header comment already states a
deliberate philosophy about minimal, legible CI surface (a tag is the only
trigger, no `workflow_dispatch`, provenance traceable from the tag alone);
adding four runners where one already does the job would work against that
stated discipline, not extend it.

**Amended by flow 184 (`keryx-native-distribution`), 2026-08-20.** The
decision stands, but implementing it hit a real, reproducible blocker not
named above: a plain `bun install` only writes the CURRENT runner's
platform variant of an `optionalDependencies` package with `os`/`cpu`
fields to disk (e.g. `@opentui/core-darwin-x64` is pinned in the lockfile
but never installed on an ubuntu-x64 runner), regardless of what the
lockfile resolves. Cross-compiling for any target other than the runner's
own therefore failed with `Could not resolve: "@opentui/core-<other
platform>"` — reproduced locally before the fix, not assumed. Fix:
`bun install --os='*' --cpu='*'` before the build loop, forcing every
platform variant onto disk regardless of the runner's own OS/arch. Single-
runner cross-compilation is still correct and still avoids an OS matrix —
this was a missing install flag, not a flaw in D-02's premise.

## D-03: Homebrew first, personal tap not core submission

**Decision.** The first native package-manager channel is a Homebrew formula
under a personal tap (`MrCipherSmith/homebrew-keryx`), not a submission to
Homebrew core.

**Reasoning.** Homebrew core has its own acceptance bar (notability,
maintenance commitment, no build-from-source-only exceptions without
justification) that is a separate, larger undertaking from proving the
standalone-binary foundation works at all. A personal tap ships immediately
once the binary exists and is the same mechanism opencode's own studied
README lists as one of its 10+ channels — not a lesser version of the same
idea, a normal one.

## D-04: Additive install script, existing paths unchanged

**Decision.** A new `scripts/install-binary.sh` is added; the existing
`scripts/install.sh --project`/`--global` modes are not modified or
deprecated.

**Reasoning.** The existing clone-based install serves a real, different
need this package does not replace: `--project` mode installs into
`.metaproject/runtime/keryx` from source specifically so a project-local
runtime can be inspected/modified, which a standalone binary cannot serve
by definition. Collapsing three paths into a "smarter" single script was
considered and rejected as scope creep beyond what this package's PRD
scoped (PRD Requirement 6, non-goals in README.md).
