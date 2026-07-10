# Release Readiness Report — 2026-07-10

## Decision

**Not ready to release.** Documentation is materially current and the core test
suite/build pass, but the repository has four release-blocking quality gaps:
TypeScript does not typecheck, Metaproject Standard validation fails, strict Code
Health fails, and the English-only repository requirement is not yet satisfied.

## Documentation completed

- Refreshed the root README and added a complete `[Unreleased]` changelog section.
- Updated developer architecture, module, CLI, onboarding, workspace-lifecycle,
  and navigation documentation.
- Added a complete installation and agent-workflow guide with copy-ready setup,
  operational, verification, and prompt blocks.
- Documented symbol-aware graph navigation, wiki hierarchy/backlinks, orientation
  hooks, gdctx routing guards, managed review packages, and the removed shipped
  transformer runtime.
- Updated the requirements roadmap to record the implemented managed-review slice.
- Marked the gdgraph symbol-layer plan as implemented and historical.
- Added a root documentation index and this dated release-readiness package.
- Rebuilt the file graph and regenerated the hierarchical self-hosted wiki.

## Current project map

- Source files indexed: **298**
- Total graph nodes: **302** (including 4 imported assets)
- Graph edges: **676**
- Relative import resolution: **100%**
- Wiki pages: **36**
- Wiki pages checked for links: **39**
- Wiki internal links checked: **72**, with **0 broken**
- Component pages still marked `Status: draft`: **33**

The draft count is an explicit enrichment backlog. Generated reference sections
are current; prose sections are not presented as accepted architectural guidance.

## Verification matrix

| Gate | Result | Evidence |
|---|---|---|
| Full tests | PASS | 110 test files discovered; `bun run test`; 0 failures |
| Production build | PASS | 172 modules bundled; `dist/cli.js` approximately 1.0 MB |
| TypeScript | **FAIL** | `src/assets/seed.test.ts:42:65`, TS2532: object possibly undefined |
| Wiki links | PASS | 39 pages, 72 internal links, 0 broken |
| Wiki validation | PASS | metadata, links, and index checks passed |
| Documentation links | PASS | 23 Markdown files checked; 0 broken local links |
| Flow consistency | PASS | all managed flows consistent |
| Security policy | PASS | config schema and checksum valid |
| Metaproject Standard | **FAIL** | object-form `gdgraph` capability rejected by module schema; tasks data path warning |
| Strict Code Health | **FAIL** | score 90; 67 P2 findings; required TypeScript source reported unavailable |
| Package dry-run | PASS WITH CONCERNS | 289 files, 3.1 MB unpacked; build runs twice |
| Diff hygiene | PASS | `git diff --check` clean after excluding unrelated generated churn |
| Canonical documentation language | PASS | no Cyrillic in README, changelog, security policy, `docs/`, or refreshed wiki |

## Cleanup plan

### P0 — required before release

1. **Fix TypeScript correctness.** Resolve TS2532 in
   `src/assets/seed.test.ts:42:65`, then rerun typecheck and the complete test
   suite.
2. **Repair Standard schema compatibility.** Make the module schema accept the
   current object-form capability declaration, or normalize the manifest to the
   schema's canonical representation. Create the missing tasks data path or stop
   declaring it as required. `keryx standard validate` must pass without errors.
3. **Repair strict health source discovery.** Code Health currently reports the
   required TypeScript source as unavailable even when `tsc` is installed and a
   direct typecheck runs. Align health tool discovery with the Bun project runtime
   and require a passing strict gate.
4. **Complete the English-only conversion.** Forty-one tracked files contain
   Cyrillic, primarily legacy bundled skill prompts and runtime variants. The
   audit found approximately 7,873 Cyrillic word occurrences. Translate canonical
   skills first, regenerate runtime variants, and add a CI language guard if the
   repository is intended to remain English-only.
5. **Fix top-level CLI help parity.** `keryx orient` is implemented and has local
   help, but the root usage/command list omits it. Add `orient` and verify every
   dispatched top-level command appears in root help and CLI docs.

### P1 — high-value cleanup before the release tag

1. **Remove stale transformer build metadata.** The shipped
   `@xenova/transformers` dependency is gone, but the build command still lists it
   as external. Keep only intentional compatibility guards/comments.
2. **Stop building twice during package assembly.** `prepack` and `prepare` both
   invoke the production build under `bun pm pack`; retain one release build hook.
3. **Reduce bundled skill duplication.** The source bundle contains 64 canonical
   `SKILL.md` files and 112 runtime-specific variants. The recommended installed
   workspace contains another 58 runtime variants. Prefer canonical sources plus
   deterministic generation/export unless a variant has independently maintained
   semantics.
4. **Reduce package payload.** The dry-run package contains 289 files and is
   3.1 MB unpacked, with a large share coming from bundled skills and variants.
   Define the minimal runtime package contract and add a package-content snapshot
   test.
5. **Resolve the wiki import cycle.** The graph reports
   `src/wiki/service.ts -> src/wiki/ask.ts -> src/wiki/service.ts`. Move shared
   collection/types behind a lower-level boundary and verify the cycle disappears.
6. **Fix gdctx diff-stat parsing.** `keryx ctx diff --stat` captured a non-empty
   raw stat but reported `Changed files: 0`. Add a regression fixture for standard
   `git diff --stat` output and verify the summary reports the real file count.
7. **Reconcile generated workspace policy.** The self-hosted `.metaproject` working
   tree is about 11 MB, including 8.4 MB under generated `data/`. Preserve durable
   agent-facing summaries, but prune ignored raw/log/query artifacts before the
   release and verify lifecycle regeneration remains deterministic.

### P2 — structural cleanup after blockers are closed

1. **Archive completed work artifacts.** The completed managed-review flow and the
   implemented gdgraph symbol plan are useful evidence now. After the release,
   extract durable decisions into changelog/wiki/memory, then archive or remove the
   historical packages according to a documented retention rule.
2. **Flatten `docs/docs/`.** Moving current-behavior documentation directly under
   `docs/` would remove redundant nesting. Perform it as one link-checked change,
   preferably before the next public minor release if stable URLs are not yet a
   compatibility promise.
3. **Enrich the highest-value wiki drafts.** Start with `src/commands`, `src/lib`,
   `src/wiki`, `src/gdgraph`, `src/ctx`, `src/review`, and `src/security`; leave
   fixture-only pages as generated reference unless they need conceptual prose.
4. **Review graph orphans conservatively.** Current orphan output is dominated by
   fixtures, tests, and type-only modules. Do not delete them from graph evidence
   alone; verify package/test/runtime references first.

## What should not be removed blindly

- Do not delete `.metaproject` wholesale; it is the product's dogfooded workspace
  and contains versioned context contracts.
- Do not delete fixtures reported as graph orphans; many are direct test inputs.
- Do not delete type-only modules solely because the import graph reports no
  runtime edges.
- Do not delete completed flows before extracting their decisions and release
  evidence.
- Do not remove runtime-specific skill variants until generation parity is tested.

## Proposed release sequence

1. Complete P0 fixes on a dedicated cleanup branch.
2. Complete the P1 package/runtime cleanup and rerun the package-content audit.
3. Rerun typecheck, full tests, build, wiki validation, Standard validation,
   strict Code Health, security policy validation, and package dry-run.
4. Require every gate to pass and require zero Cyrillic matches.
5. Choose the next SemVer version, replace `[Unreleased]` with the version/date,
   bump `package.json`, and update the README badge.
6. Commit and merge through a reviewed pull request.
7. Tag the merge commit, publish the package, create GitHub release notes from the
   changelog, and verify a clean installation in an empty fixture repository.

## Routing audit

- `graph_used`: yes — affected context, cycles, orphans, and rebuilt graph summary.
- `wiki_used`: yes — index, full-coverage collection, link check, and validation.
- `ctx_used`: yes — bounded searches, reads, command output, and repository audit.
- `raw_rg_used`: no.
