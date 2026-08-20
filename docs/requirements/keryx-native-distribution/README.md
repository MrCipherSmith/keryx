# Keryx Native Distribution
Version: 0.1.0

## Purpose

Add a real standalone-binary release artifact and native package-manager
channels (Homebrew, and similarly-shaped channels for other platforms) on
top of it, closing the specific gap named in a prior comparative research
pass: keryx has no zero-runtime-prerequisite install path, while opencode's
studied pattern (a single install script auto-detecting OS/arch/libc and
fetching a prebuilt binary from GitHub Releases, plus 10+ parallel
package-manager channels) does.

## Status

**specification ready (future).** No code exists. Grounded in direct reading
of `.github/workflows/release.yml`, `scripts/install.sh`,
`install`/`install.ts`, and `package.json` — not assumed from the earlier
comparative research summary, which undersold how much distribution
infrastructure already exists. The one real go/no-go risk (whether
`bun build --compile` can bundle keryx's optional dependencies) was
live-tested during specification authorship, not left open — see
decisions.md D-01.

## Document Index

| Document | Purpose |
|---|---|
| [README.md](README.md) | This overview, status, scope, index. |
| [prd.md](prd.md) | Problem, goal, users, requirements, success criteria, risks, recommendation. |
| [specification.md](specification.md) | Build pipeline, artifact matrix, channel-by-channel plan, acceptance criteria. |
| [decisions.md](decisions.md) | Adopted decisions: standalone-binary foundation over thin wrappers; single-runner cross-compile. |
| [brainstorm.md](brainstorm.md) | opencode's studied pattern, current-state findings, the optional-dependency bundling question. |

## Scope

- A standalone, dependency-free binary built via `bun build --compile`,
  cross-compiled for macOS (arm64, x64) and Linux (x64, arm64) from one CI
  runner — confirmed technically possible (Bun supports cross-compiling
  `--target=bun-<platform>-<arch>` binaries from a single machine, not
  requiring a per-OS runner matrix).
- Attaching these binaries to the existing `release.yml` GitHub Release step
  (which today only attaches the npm tarball).
- A Homebrew formula/tap pointing at the macOS binaries.
- Extending `scripts/install.sh` (or a new script) to detect OS/arch and
  download the matching standalone binary directly, as a zero-`bun`/zero-`git`
  alternative to the existing clone-and-run path.

## Non-goals (this version)

- Windows. Not requested; opencode's own Windows story was not researched to
  the depth this package needs, and keryx's own sandbox/OS-integration work
  (`keryx-os-sandbox`) is macOS-full/Linux-partial today — a Windows binary
  with no corresponding sandbox story is a bigger, separate decision.
- AUR, scoop, nix, or any channel beyond Homebrew. Homebrew is the first
  proof of the standalone-binary foundation; additional channels are
  mechanical once it exists and are each their own small addition, not
  bundled into this package's initial scope.
- Changing what the npm package (`@mrciphersmith/keryx`) or the existing
  clone-based `scripts/install.sh --project`/`--global` modes do. Both
  continue to exist unchanged; this package adds a third path, it does not
  replace the first two.
- `.changeset`/issue-triage/community-process work. That was the other half
  of the original "community/adoption" research item; this package is
  scoped to the install-friction half only, per an explicit choice between
  the two.

## Related modules

- No existing requirements package covers release/distribution
  infrastructure directly — `release.yml` and the install scripts are
  operational, undocumented-as-a-package code. This is the first package to
  formalize them.
