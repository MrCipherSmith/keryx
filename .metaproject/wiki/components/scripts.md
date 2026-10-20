---
Title: Module scripts
Version: 1.0.1
Type: component
Status: accepted
VerifiedScope: sha256:a178a68b1420160cbd9638baffa46615c256f9f959ff0bc50a0dc34c4614f7d3
Summary: The `scripts` module holds repository-level helpers: a generator for deterministic SAC policy-experiment fixtures, two documentation gates (broken relative links and retired `keryx mcp` spellings), and a test that proves `scripts/install.sh --global` produces a working `keryx` wrapper. The fixture generator is the only file that couples it to `src/sac`, in both directions.
---

# Module scripts

## Summary

The `scripts` module holds repository-level helpers: a generator for deterministic SAC policy-experiment fixtures, two documentation gates (broken relative links and retired `keryx mcp` spellings), and a test that proves `scripts/install.sh --global` produces a working `keryx` wrapper. The fixture generator is the only file that couples it to `src/sac`, in both directions.

## Overview

This component owns repository operations rather than end-user runtime code. It produces synthetic SAC policy-experiment fixtures under `fixtures/sac-policy-experiment/`, gates the documentation tree against two kinds of drift, and tests that the global installer works in an isolated prefix. The two gates exist because the failures they catch are silent: a broken link or a retired command still renders or still runs, so nothing else complains. `check-doc-links.ts` is documented as running in CI, so a broken link fails a pull request.

## How it works

Each file is a standalone Bun script with an `import.meta.main` guard, so it can be imported by its test or run from the command line. Nothing here is a layered package. The fixture generator is the only file with a real dependency graph: it reads the baseline, candidate and sandbox-control artifacts, seals a chain of three integrity-linked access receipts, attaches a verified outcome to each, builds a policy corpus, and runs `evaluatePolicyExperiment` over it. It returns a map from relative file path to contents. Run directly, it writes those files; with `--check`, it compares them with the committed fixtures and throws on the first stale one.

The two documentation gates share one shape: a collector gathers files with a glob, a pure scanner returns violations, and `main` sets a non-zero exit code. Both refuse to pass vacuously. A run that matches zero files, zero links, or zero retired spellings fails. The retired-spellings gate excuses an occurrence only when it sits in a was-to-is table cell beside its replacement, or inside a `retired-spellings-ok` marker with a written reason. The link gate strips fenced blocks and inline code first, so quoted link syntax is not treated as a link. The test files exercise those rules directly, including regressions for the cases that previously slipped through.

The installer test isolates everything under a temporary workspace. It builds a bare origin from a `git archive` snapshot of HEAD, so shallow CI clones behave the same as full ones, and it redirects `KERYX_HOME`, `KERYX_BIN_DIR`, `KERYX_REPO_URL` and `HOME`. It then checks that the generated wrapper is executable, reports a semver version through `--version`, and points into the temporary prefix. A second case neuters the wrapper step in a copy of the script, to show the first case can fail.

## Key concepts

- **Script entry point**  
  A standalone Bun script, run with `bun` and guarded by `import.meta.main`, so a test can import it without running it.

- **Public symbol**  
  `generateSacPolicyExperimentFixtures` is the only symbol the graph reports as public API. The gate files also export helpers such as `linksIn`, `blankCode` and `scanText` so their tests can reach them.

- **SAC policy experiment fixture**  
  Synthetic, seeded data for the policy-experiment evaluator. Identifiers use a `synthetic-` prefix, timestamps are fixed, and the split uses a published seed. The generated set is `receipts.jsonl`, `corpus.json`, `manifest.json`, `evaluation-report.json` and `sandbox/execution-receipts.json`, plus one file per recorded outcome. `src/sac` appears to consume the generator; the graph records the import but not which symbols are used.

- **Retired spelling**  
  <!-- retired-spellings-ok: line — names the retired spellings that check-retired-cli-spellings.ts detects; it does not teach them -->
  `keryx mcp serve`, `keryx mcp install` and `keryx mcp uninstall`. They still work, which is why prose drifts back to them. The replacements are `keryx serve-mcp` and `keryx integrate [--remove]`, per decision D-04 in `docs/requirements/keryx-mcp-servers/decisions.md`.

- **Declared exemption**  
  A `retired-spellings-ok` marker, scoped to `file`, `section` or `line`, with a written reason. A marker with no reason, or an unknown scope, is itself a failure.

- **Installer wrapper**  
  The `keryx` executable that `scripts/install.sh --global` writes into `KERYX_BIN_DIR`, which runs the real CLI entry point under the install prefix.

## Main flows

### Generate SAC policy experiment fixtures

1. The generator reads the deterministic baseline, the candidate, and the allowed and denied sandbox controls from `fixtures/sac-policy-experiment/`, and hashes each one.
2. It seals three access receipts, each chained to the previous record hash, and builds a verified outcome for each through the evidence authority.
3. It builds the policy corpus, runs `evaluatePolicyExperiment` with a baseline that selects every eligible id, and returns the file map. Run as a script it writes the files, or with `--check` it fails on any file that differs from the committed copy.

### Check documentation links

1. `scripts/check-doc-links.ts` collects `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` and `docs/**/*.md`.
2. It extracts inline and reference links from prose only, and skips `http`, `mailto` and bare-anchor targets.
3. It resolves each relative target. When the target is Markdown and has an anchor, the anchor must match a GitHub-style slug of one of its headings. `scripts/check-doc-links.test.ts` covers the code-stripping and the `policies.md` regression.

### Check retired CLI spellings

1. `scripts/check-retired-cli-spellings.ts` collects the reader-facing surfaces: `README.md`, `docs/`, `.metaproject/**/*.md`, `src/**/*.ts` and `.gitignore`. It skips the `data/`, `flows/` and `workspaces/` records.
2. Each occurrence of a retired spelling is excused only if it sits in a paired was-to-is cell, or inside a declared marker range.
3. Any undeclared occurrence is reported as `RETIRED` with its file and line, and the run fails. `scripts/check-retired-cli-spellings.test.ts` also asserts that the scan reached more than 400 files and at least six occurrences, so a dead matcher cannot pass.

---

<!-- keryx:reference:begin v=1 hash=a014a7be3cf91994268ff766957690be4bcbff9313e1c9e2670dd0a3ac776eff -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `generateSacPolicyExperimentFixtures`

### Key files

- `scripts/generate-sac-policy-experiment-fixtures.ts` - imported by 1, imports 2
- `scripts/routing-classifier-live-check-holdout.ts` - imported by 0, imports 2
- `scripts/routing-classifier-live-check.ts` - imported by 0, imports 2
- `scripts/turn-guard-live-check.ts` - imported by 0, imports 2
- `scripts/check-doc-links.test.ts` - imported by 0, imports 1
- `scripts/check-doc-links.ts` - imported by 1, imports 0

### Depends on

- `src/sac` - 2 import(s)
- `src/harness/decision` - 2 import(s)
- `src/harness/routing` - 2 import(s)
- `src/standard` - 1 import(s)
- `src/review` - 1 import(s)
- `src/tui` - 1 import(s)

### Dependency basis

- Production imports only: 1 import(s) from test file(s) (e.g. `src/sac/policy-experiment-fixtures.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 18
- Cross-module imports: 9
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived — regenerated by `keryx wiki collect --force`. Only pages that exist are linked.

- [Wiki Index](../index.md)
- [Module src/sac](src-sac.md)

## Changelog

- 1.0.1 - Reference refreshed from the code graph. Source graph was stale; VerifiedAt was not advanced.
- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 — Initial page generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections enriched and marked accepted.
