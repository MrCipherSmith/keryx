# Keryx Native Distribution — Decisions
Version: 0.1.0

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

## D-02: Single-runner cross-compile, no OS matrix

**Decision.** `release.yml` gains a build loop on its existing
`ubuntu-latest` runner, not a new per-OS runner matrix.

**Reasoning.** Bun's cross-compilation support (D-01) makes a matrix
unnecessary work — `release.yml`'s own header comment already states a
deliberate philosophy about minimal, legible CI surface (a tag is the only
trigger, no `workflow_dispatch`, provenance traceable from the tag alone);
adding four runners where one already does the job would work against that
stated discipline, not extend it.

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
