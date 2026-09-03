# Documentation remediation — README and the published docs site

**Status.** Specification ready. Nothing implemented.
**Date.** 2026-09-03, against `main` at `39b832f3` (release 0.2.76).
**Trigger.** A README review that started from one observation — "installation
via Homebrew, we don't have that" — and found the claim was not merely stale but
had never been able to work.

## Method, and why it matters here

Every finding below was verified by **running something**, not by reading. The
distinction is the whole point of this package: a documentation defect is
invisible to the compiler, invisible to the test suite, and invisible to
`check:doc-links`, which validates that a relative link resolves and nothing
about whether the sentence around it is true. `mkdocs build --strict` fails on a
dead internal link or a page missing from the nav; it passes happily on a page
that documents a flag the CLI does not have, or omits the install path the
project actually ships.

So: the Homebrew formula was downloaded and read. `modules enable sac` was run in
a throwaway repository and the manifest inspected. `init --yes` was run and its
module count counted. Every external URL was probed for a status code. Two
"known bug" warnings in `architecture.md` were tested and found to describe
behaviour that no longer exists.

One methodological correction belongs here, because it nearly became a finding
of its own. A first pass probed the CLI by running `keryx <cmd> --help` and
grepping for "unknown", and reported **fourteen** documented commands as missing.
They all exist. Two-word subcommands reject a trailing `--help` and answer
`Unknown command: <cmd>` — the probe was measuring its own malformed invocation.
Re-verified through each parent command's help surface. A verification method
that produces alarming results is the one to distrust first.

## Findings

Ordered by what a reader loses.

### F1 — Homebrew is advertised and cannot work (README, CHANGELOG)

`README.md:51-55` offers:

```bash
brew install MrCipherSmith/keryx/keryx
```

The tap repository exists and is public. Its single formula
(`Formula/keryx.rb`, last pushed 2026-08-20) pins `version "0.2.49"` — twenty-seven
releases behind — and both checksums are the literal strings
`PLACEHOLDER_SHA256_DARWIN_ARM64_FILL_FROM_REAL_RELEASE` and
`PLACEHOLDER_SHA256_DARWIN_X64_FILL_FROM_REAL_RELEASE`. Homebrew downloads the
asset and compares; a non-hex placeholder can only fail. There is also no
`on_linux` block at all, while the README presents the command without platform
qualification.

This has never installed keryx for anyone, on any platform, since the day it was
published.

The sharp part is not the staleness. The formula's own comment says it is a
placeholder written ahead of the first real tagged release with binaries
attached, and instructs whoever cuts that release to fill in real digests —
explicitly warning against fabricating one.
`docs/requirements/keryx-native-distribution/README.md:23-27` records the same
thing: "its checksums are still placeholders pending the first real tagged
release with binaries attached, documented as such in the formula itself, not
fabricated."

That condition fired long ago. Binaries are attached to every release —
confirmed on v0.2.49, v0.2.75 and v0.2.76, all four platform assets present each
time. So the placeholder was honestly marked as unfinished **where a maintainer
looks**, and simultaneously announced as available **where a user looks**:
`README.md:51` and `CHANGELOG.md:1201-1206` ("a Homebrew tap … is also
available").

This is the recurring defect class of the last four releases — a mechanism
asserting a capability it does not have — arriving in documentation instead of
code.

### F2 — The npm install path is absent from the published site

`README.md` leads with `npm install -g @mrciphersmith/keryx`. It is the path the
release pipeline actually publishes, and the one the version-update advisory
tells users to run.

On the published documentation site it appears **zero times** as an install
instruction. `docs/docs/README.md:12` has it, but that file is deliberately
excluded from the build (`mkdocs.yml`, `exclude_docs: README.md`) so it does not
collide with `index.md`. The only other occurrence, `cli-reference.md:42`, is the
*upgrade* command inside the `version` section — it presumes you already have it.

A reader who lands on Onboarding is told to install by piping a shell script from
GitHub that clones the repository into `~/.keryx`. That path works, but it is the
managed-clone installer, not the package. The npm package is never mentioned.

The standalone binary is worse off: `scripts/install-binary.sh` — verified
working, correct asset names, live URL — appears **nowhere on the site at all**.

So the project ships four install paths (npm, standalone binary, managed clone,
project-local clone), the README documents three of them, the site documents two,
and no page cross-references the others. One of the README's three is F1.

### F3 — Slate is invisible outside its own guide

`guides/slate.md` is thorough: three MCP tools, trust model, on-disk layout, an
explicit not-shipped section. The feature exists in code (`src/session/external-slate.ts`,
`slate.*` in `src/mcp/tools.ts`) and `slate` is listed in the manifest's
`expose.modules` array in real projects.

Mentions of "slate" across `README.md` and `docs/docs/`:

| File | Count |
|---|---|
| `guides/slate.md` | 40 |
| `guides/goal.md` | 16 |
| `guides/shared-agent-context.md` | 1 |
| **everything else, including `README.md`** | **0** |

Not in `modules.md`. Not in `architecture.md`'s module map. Not in
`cli-reference.md` — whose `## mcp` section enumerates the five `sac.*` tools and
their `sac_transport_denied` refusal, and never names `slate.open`,
`slate.writeSeed`, `slate.close` or their identical `slate_transport_denied`
refusal. Not in `limitations.md`. Not in `harness.md`.

The guide is also unreachable from `index.md` (see F6). A reader arrives only by
scrolling the nav sidebar to a title that assumes they already know the word.

### F4 — SAC is under-documented where it is documented at all

`README.md` mentions Shared Agent Context three times, all inside one bullet, and
never names the CLI verb. A reader cannot learn from the README that the feature
is driven by `keryx workspace`.

Deeper, three concrete errors:

1. **`modules.md:962-963` states SAC "has no `modules.sac` toggle".** False.
   Verified: `keryx modules enable sac` in a fresh project writes
   `modules.sac.enabled = true` with a full module block. `keryx modules --help`
   lists `sac` among the enableable names.

2. **`cli-reference.md:2107,2123` documents `confirm-review` without
   `--acknowledge-security`.** That flag is the human acknowledgement gate
   shipped in 0.2.75 for `needs-approval` proposals
   (`src/commands/workspace.ts:134,156`). An operator who hits the refusal finds
   no documented way forward: the CHANGELOG describes the control, the CLI
   reference does not, and the command's own usage banner omits it too (only the
   thrown error string carries it).

3. **Four subcommands are undocumented in both `cli-reference.md` and
   `modules.md`:** `archive`, `rename`, `remove-resource`, `list-proposals`.
   `list` is missing its `--include-archived` option. `modules.md`'s table also
   omits `confirm-review` entirely — the one step that requires a human.

### F5 — `MODULE_COMMANDS` is stale for `sac` (code, not docs)

`workspace-and-lifecycle.md:167` documents `commands[]` in the manifest as coming
from `MODULE_COMMANDS`, "single source of truth". For `sac` that source lists ten
subcommands; the CLI has sixteen. Missing: `confirm-review`, `catch-up`,
`list-proposals`, `archive`, `rename`, `remove-resource`.

Every manifest written by `init` or `modules enable sac` therefore under-reports
the surface, and any agent routing off the manifest sees ten of sixteen. This one
is a code fix, surfaced by the documentation review.

### F6 — `index.md` lists seven of ten guides

The site's own landing page omits `guides/permission-modes.md`,
`guides/goal.md` and `guides/slate.md`. All three are in the `mkdocs.yml` nav, so
`--strict` is satisfied and the omission is invisible to CI. A reader using the
index as a table of contents never learns `/goal` or Slate exist.

### F7 — `architecture.md` warns about two bugs that no longer exist

Lines 145-147 state, as live caveats, that `security` is "absent from that
command's module list, so it cannot be toggled there", and that "toggling
anything currently drops an enabled `mcp` from the manifest".

Both tested against 0.2.76 in a throwaway project:

- `keryx modules disable security` → `modules.security.enabled = false`. It
  toggles. `keryx modules --help` lists `security`.
- `mcp` enabled, then `modules enable sac` → `modules.mcp.enabled` still `true`.
  Nothing was dropped.

Stale warnings are not harmless. They teach a reader to distrust a working
command and to route around it.

### F8 — The module map table is broken by a stray blank line

`architecture.md:129` is an empty line between the `sac` row and the `harness`
row of one Markdown table. On the rendered site this ends the first table and
starts a second one without a header, so `harness`, `sandbox`, `tui`, `session`,
`serve`, `projects`, `metrics` and `contracts` render as an unheaded block. Not
caught by `--strict`, which validates links and nav, not table structure.

### F9 — Command surfaces with no reference section

`cli-reference.md` is titled "Every command, subcommand, flag, and exit code". It
has no section for `keryx job` (six subcommands) or `keryx sandbox status`. The
top-level `keryx` usage banner omits `orient` — a command the README documents at
length — and its trailing "Commands:" description list omits `workspace`,
`metrics`, `job` and `orient`.

`keryx commands` returns 40 registry entries and excludes `workspace`, `slate`,
`review`, `skills`, `standard`, `serve`, `mcp` and others. `cli-reference.md`'s
`## commands` section and `modules.md`'s `## sac` both note the `workspace`
omission, so it is at least partly intentional — but the inclusion rule is never
stated, which leaves a reader unable to tell intent from oversight.

## What is NOT wrong

Recorded so the plan is not read as a general indictment, and so nobody re-checks
these:

- `scripts/install-binary.sh` is real, its URL returns 200, and its asset names
  match what releases attach. (It performs no checksum verification on the
  downloaded binary — noted for the curl-to-bash path, not a documentation
  defect.)
- "Nine modules are on after `init`; `mcp` is opt-in" — verified by a real
  `init --yes`: 9 of 9 enabled, `mcp` present and disabled.
- Every command named in `README.md` exists, verified through parent help
  surfaces.
- All eight external URLs in `README.md` return 200, including every image, the
  docs site, and the unrelated-package link.
- `engines`, dependency and "zero runtime dependencies" claims match
  `package.json` (`dependencies: {}`).
- The Windows and CI statements are accurate.
- `check:doc-links` reports 1144 links, 0 broken; `mkdocs build --strict` passes.
  Both remain true throughout — which is the point of F1 through F9.

## Plan

Four phases. Phase 1 stands alone and should not wait for the others.

### Phase 1 — Stop the false promise (small, urgent)

1. Remove the Homebrew block from `README.md:51-55`.
2. Correct the `CHANGELOG.md:1201-1206` claim. The entry is historical, so amend
   rather than rewrite: state that the tap was published with placeholder
   checksums and has never been installable, with a pointer here.

**AC1.** No user-facing file offers `brew install` for keryx.
**AC2.** A grep for `homebrew` across `README.md` and `docs/docs/` returns
nothing, or only text that describes the tap as not yet usable.

### Phase 2 — One honest install story

3. Give the site a single install page, or an install section on
   `onboarding.md`, covering all four paths with the trade-off of each: npm
   (needs node/npm, the published package), standalone binary (no runtime
   dependency at all), managed clone, project-local clone.
4. Add `npm install -g @mrciphersmith/keryx` to `onboarding.md` as the default
   path, matching the README.
5. Document `scripts/install-binary.sh` on the site.
6. Make `README.md` and `onboarding.md` cross-reference each other so neither is
   a silent fork of the other.

**AC3.** `npm install -g @mrciphersmith/keryx` appears on at least one page
included in the built site.
**AC4.** Each of the four install paths appears on the site with a stated
prerequisite, and each names the others.

### Phase 3 — Make Slate and SAC visible and accurate

7. Add a `slate` entry to `architecture.md`'s module map and a `## slate` section
   to `modules.md`, both linking `guides/slate.md`.
8. Add the three `slate.*` tools to `cli-reference.md`'s `## mcp` section beside
   the `sac.*` five, including the `slate_transport_denied` refusal.
9. Delete the false "has no `modules.sac` toggle" sentence from `modules.md` and
   state the actual classification: not a default `init` module, toggleable via
   `keryx modules enable sac`.
10. Document `--acknowledge-security` on `confirm-review` in `cli-reference.md`
    and `guides/shared-agent-context.md`, including what an operator sees when a
    proposal is `needs-approval`. Add it to the command's own usage banner.
11. Add `archive`, `rename`, `remove-resource`, `list-proposals` and
    `list --include-archived` to `cli-reference.md` and `modules.md`; add
    `confirm-review` to the `modules.md` table.
12. Add Slate and SAC one-line entries to `README.md`, each naming its entry
    point (`keryx workspace`, and the MCP `slate.*` tools).
13. Fix `MODULE_COMMANDS` for `sac` to list all sixteen subcommands, with a test
    that fails when the CLI surface and `MODULE_COMMANDS` diverge.

**AC5.** "slate" appears in `modules.md`, `architecture.md` and
`cli-reference.md`.
**AC6.** Every `keryx workspace` subcommand and flag appears in
`cli-reference.md`; asserted by a test that reads the CLI's own surface, not by
inspection.
**AC7.** `modules.sac` claim in `modules.md` matches observed behaviour.

### Phase 4 — Repair what is stale or broken

14. Delete the two obsolete caveats at `architecture.md:145-147`, after
    re-confirming both on the release the fix ships in.
15. Remove the stray blank line at `architecture.md:129`.
16. Add the three missing guides to `index.md`, and add a check that
    `index.md`'s guide list matches the `mkdocs.yml` nav.
17. Add `job` and `sandbox` sections to `cli-reference.md`; add `orient`,
    `workspace`, `metrics` and `job` to the top-level usage banner's command
    list.
18. State the inclusion rule for `keryx commands` in `cli-reference.md`'s
    `## commands` section.

**AC8.** `index.md`'s guide list and the `mkdocs.yml` nav agree, enforced by a
check.
**AC9.** Every top-level CLI verb has a `cli-reference.md` section, enforced by a
test that derives the verb list from `CLI_ROUTES`.

## The structural point

Four of these nine findings are the same shape as the code defects the last four
releases fixed: a claim nothing verifies. `check:doc-links` proves links resolve.
`mkdocs --strict` proves the nav is complete. Neither can prove a sentence true,
and the gap between "the link works" and "the sentence is true" is where all of
F1 through F9 live.

The tests named in AC6, AC8 and AC9 are the part of this plan that keeps it from
being needed again. They derive the expected surface from the code — `CLI_ROUTES`,
`MODULE_COMMANDS`, the `mkdocs.yml` nav — and fail when documentation and
implementation drift apart. Without them this package is a one-time cleanup with
a predictable second edition.

A candidate tenth item, deliberately left out of scope: a release-time step that
rewrites the Homebrew formula's version and real checksums from the published
assets. Without it, making the formula correct once buys exactly one release of
accuracy. It belongs in a distribution package, not a documentation one — but
Phase 1 should not be read as closing the Homebrew question, only as ending the
false claim.
