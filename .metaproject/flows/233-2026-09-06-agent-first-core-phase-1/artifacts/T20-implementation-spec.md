# T20 implementation spec: recursive security scan coverage

## Contract

`keryx security scan <path>` accepts a contained file or directory. A directory is recursively traversed by default; `--recursive` is accepted explicitly. Traversal follows only internal symlinks, visits canonical file/directory identities once, terminates cycles, and refuses external targets. File count, aggregate bytes, directory count, and depth are bounded. Explicit exclusions narrow the declared scope and do not make coverage incomplete. Unreadable entries, denied external links, traversal failures, and exhausted required limits preserve findings already established and mark required coverage incomplete.

The scan report remains the existing security report with additive `scope`, `coverage`, and per-file `files` metadata. Coverage is independent from findings: a blocking finding keeps gate `fail` even when coverage is incomplete; a clean but incomplete traversal reports gate `incomplete`. Paths in report metadata are project-relative authorized paths only. External target names and contents never enter reports, errors, or findings.

## Design

1. Add `src/security/path-scan.ts` as a traversal-only seam. It uses `lstat`/`realpath` for directory discovery and `readContainedFile` for every file read, with canonical identity sets and explicit limits.
2. Extend security report/types/schema with additive scan metadata and the `incomplete` gate state.
3. Add `runScanPath` to the security service. It analyzes each successfully read file, retains all findings, computes the aggregate gate, and folds incomplete coverage only when no stronger security gate exists.
4. Update the security CLI to parse scan limits/exclusions, route files and directories through `runScanPath`, print the additive report, and return nonzero for incomplete in strict CI/enforced modes.
5. Preserve `validateSerializedOutput`, `redact`, detector ownership, guard files, and output-validation implementation.

## Initial RED evidence

The T7 recursive tests fail before implementation because directory scans attempt `readFile` on a directory and throw `EISDIR`. Raw log: `.metaproject/data/gdctx/raw/2026-09-06T12-32-02-740Z_run.log`.
