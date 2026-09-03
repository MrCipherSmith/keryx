# Documentation remediation phases 2-4: one honest install story, Slate and SAC visibility, stale-warning repair

Status: ready
Source: README + docs review, 2026-09-03, against `main` at `39b832f3` (0.2.76)
Specification: `docs/requirements/keryx-docs-remediation/README.md`
Phase 1 (Homebrew) shipped separately as PR #439.

## Problem

A review of `README.md` and the published documentation site found nine defects.
Phase 1 removed the worst *outward* claim — a Homebrew install that had never
worked on any platform. The remaining eight are this flow.

They fall into three groups.

**The install story does not exist as a story.** The project ships four install
paths: the npm package, a standalone binary, a managed clone, and a
project-local clone. `README.md` documents three (one of which was Homebrew).
The published site documents two — and `npm install -g @mrciphersmith/keryx`,
the path the release pipeline actually publishes and the one the version-update
advisory tells users to run, appears on the site **zero times** as an install
instruction. The file that carries it (`docs/docs/README.md`) is deliberately
excluded from the build so it does not collide with `index.md`; the only other
occurrence is the *upgrade* command inside the `version` section, which presumes
you already have the package. `scripts/install-binary.sh` — verified working,
correct asset names, live URL — appears nowhere on the site at all. No page
cross-references any other. A reader arriving at Onboarding is told to pipe a
shell script from GitHub that clones the repository, and never learns the
package exists.

**Slate is invisible and SAC is inaccurate.** Slate has a thorough guide, live
code (`src/session/external-slate.ts`, `slate.*` in `src/mcp/tools.ts`), and is
listed in the manifest's `expose.modules` array in real projects — so the
manifest exports a module the documentation never names. Outside its own guide,
`guides/goal.md` and one line of `guides/shared-agent-context.md`, the word
appears zero times: not in `README.md`, `modules.md`, `architecture.md`'s module
map, `cli-reference.md`, `limitations.md` or `harness.md`. `cli-reference.md`'s
`## mcp` section enumerates the five `sac.*` tools and their
`sac_transport_denied` refusal while never naming the three `slate.*` tools or
their identical refusal.

SAC is documented but wrong in three places. `modules.md` states it "has no
`modules.sac` toggle" — false, verified by running `keryx modules enable sac` in
a throwaway project and reading `modules.sac.enabled=true` back out of the
manifest. `cli-reference.md` documents `confirm-review` without
`--acknowledge-security`, the human acknowledgement gate shipped in 0.2.75 for
`needs-approval` proposals, so an operator who hits that refusal finds no
documented way forward. Four subcommands (`archive`, `rename`,
`remove-resource`, `list-proposals`) are undocumented everywhere, `list` is
missing `--include-archived`, and `modules.md`'s table omits `confirm-review`
entirely — the one step that requires a human. Underneath the docs,
`MODULE_COMMANDS` for `sac` lists ten of sixteen subcommands, so every manifest
`init` writes under-reports the surface to any agent routing off it.

**Two warnings describe bugs that no longer exist.** `architecture.md` states as
live caveats that `security` cannot be toggled through `keryx modules` and that
toggling any module drops an enabled `mcp`. Both were tested on 0.2.76:
`modules disable security` sets it to `false`, and `mcp` survives a toggle
untouched. A stale warning is worse than silence — it teaches a reader to route
around a working command. In the same file a stray blank line splits the
module-map table, so eight rows render on the site without a header.
`index.md` lists seven of ten guides, omitting `permission-modes`, `goal` and
`slate`; all three are in the `mkdocs.yml` nav, so `--strict` is satisfied and
the omission is invisible to CI.

**Why now.** Four of the nine findings are the same shape as the code defects
the last four releases fixed: a claim nothing verifies. `check:doc-links` proves
1145 links resolve; `mkdocs build --strict` proves the nav is complete. Both
pass on every defect above. The gap between "the link resolves" and "the
sentence is true" is where all of them live, and nothing in CI observes it.

## Expected Outcome

The site tells one install story covering all four paths, each with its
prerequisite and each naming the others, with `README.md` and `onboarding.md`
cross-linked rather than silently forked.

Slate and SAC are findable from the README, the module reference, the
architecture module map and the CLI reference; every `keryx workspace`
subcommand and flag the CLI accepts is documented, including
`--acknowledge-security`; `MODULE_COMMANDS` matches the routed surface.

The obsolete caveats are gone, the module-map table renders as one table, and
`index.md` agrees with the nav.

Three checks derive their expectations from the code — `CLI_ROUTES`,
`MODULE_COMMANDS`, and the `mkdocs.yml` nav — and fail when documentation and
implementation drift apart. Each is proved by mutation: reverted fix, red test,
restored. Without them this flow is a one-time cleanup with a predictable second
edition, which is the actual deliverable and the reason the flow exists.

## Out of Scope

- **Making the Homebrew formula real.** Phase 1 ended the false claim; it did
  not answer the Homebrew question. Correcting the formula once buys exactly one
  release of accuracy without a release-time step that rewrites its version and
  digests from the published assets. That belongs in a distribution package, not
  this one.
- **Checksum verification in `scripts/install-binary.sh`.** Noted during the
  review — the script downloads and installs a binary without verifying it. Real,
  but a supply-chain concern rather than a documentation one, and it needs its
  own decision about where the expected digest comes from.
- **Widening the `keryx commands` registry.** AC12 requires the inclusion rule
  be *stated*, not changed. Whether `workspace`, `slate` and the rest belong in
  the registry is a product question this flow does not settle.
- Any rewrite of guides whose content is accurate. The defects above are
  omissions and false statements, not style.
