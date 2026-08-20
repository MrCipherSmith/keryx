# Keryx Native Distribution — Specification
Version: 0.1.0

**Status: specification ready (future).** The go/no-go technical question
(§2) is live-verified. Remaining items are scoping, not open unknowns.

## 1. Build pipeline

Add to `.github/workflows/release.yml`, after the existing "Build and
smoke-test the packed artifact" step (same runner, `ubuntu-latest` — no new
runner matrix needed, per §2):

```text
for target in bun-darwin-arm64 bun-darwin-x64 bun-linux-x64 bun-linux-arm64; do
  bun build ./src/cli.ts --compile --target=$target \
    --outfile ./.release/keryx-$target
done
```

Each output is smoke-tested the same way the npm tarball already is
(`./.release/keryx-<target> --help` must exit 0 with non-empty output) before
`gh release create` attaches it. A target whose smoke test fails fails the
release, exactly like a failing `bun run check` does today — no partial,
silently-degraded release.

## 2. Cross-compilation — confirmed, not assumed

Bun supports cross-compiling `--compile` binaries for macOS (arm64, x64) and
Linux (x64, arm64) from a single machine — confirmed via current Bun
documentation, not memory. This means the existing single-runner
(`ubuntu-latest`) architecture in `release.yml` does not need to become an
OS matrix; the for-loop in §1 runs entirely on the existing runner.

**Live-verified locally, not merely documented:** `bun build ./src/cli.ts
--compile` against keryx's real entrypoint (native target, not
cross-compiled, but the same bundling question applies regardless of target
platform) produced a 72.1MB working binary. `--version` and `--help` both
ran correctly. `keryx gdgraph build` against a real `.ts` file from that
binary correctly produced `1 nodes, 0 edges` — proof `web-tree-sitter` (WASM,
the highest-risk of the three optional dependencies) is genuinely bundled
and functional, not merely present as dead weight. `@modelcontextprotocol/sdk`
was invoked (`mcp serve`) but not round-tripped with a real client — the
process exited quickly with no error, which is consistent with (but not
proof of) correct behavior for a stdio server with nothing attached to its
stdin. `@opentui/core` was not exercised (no TTY in the test environment).

**Before implementation:** re-verify MCP with a real client round-trip
(e.g. point a local MCP inspector or another keryx instance's client at
`keryx mcp serve` run from the compiled binary) and verify the TUI shell
launches correctly from a real terminal. Do not carry forward this
specification's partial verification as if it covered all three
dependencies equally.

## 3. Artifact naming and attachment

Binaries attach to the existing `gh release create` step as additional
positional file arguments, alongside the `.tgz` already there — one
`gh release create` call, not a second release step. Naming follows Bun's
own `--target` vocabulary directly (`keryx-bun-darwin-arm64`, etc.) rather
than inventing a parallel scheme, so a user matching their platform to an
asset name can cross-reference Bun's own documentation if confused.

## 4. Homebrew channel

A formula (tap under `MrCipherSmith/homebrew-keryx` — a personal tap, not a
core-Homebrew submission, which has its own, separate, higher-bar
acceptance process out of scope here) that:

- Downloads the matching `keryx-bun-darwin-{arm64,x64}` asset from the
  GitHub Release matching the formula's pinned version.
- Verifies its SHA256 (computed and pinned per release — the same
  provenance discipline `release.yml` already applies to the npm publish
  via OIDC trusted publishing, translated to Homebrew's checksum-pinning
  idiom since Homebrew has no equivalent trusted-publish mechanism).
- Installs the binary directly; no `bun`/`git`/`node` dependency declared,
  since the binary is standalone (pending §2's MCP/TUI re-verification —
  if either turns out to need something not actually bundled, this
  no-dependency claim must be revisited before the formula ships, not
  after).

Formula version bumps are a manual or lightly-scripted step per release,
not automated in this version — `keryx-mcp-client`'s and
`keryx-provider-breadth`'s own precedent of not over-scoping a first version
applies here too.

## 5. Install script

A new `scripts/install-binary.sh` (name provisional), NOT a modification of
the existing `scripts/install.sh`'s `--project`/`--global` modes (PRD
Requirement 6: additive, not a replacement):

- Detects `uname -s`/`uname -m`, maps to the matching `bun-<platform>-<arch>`
  asset name (§3).
- Downloads it from the latest (or a pinned, via `KERYX_REF`-equivalent env
  var, matching the existing scripts' convention) GitHub Release.
- Places it in the same `~/.local/bin/keryx` location the existing
  `--global` mode already uses, so both paths converge on one
  already-documented "add this to PATH" instruction — no second,
  divergent install location for a user to reason about.

## 6. Acceptance Criteria

- AC1: All four platform binaries build successfully in CI via the §1
  for-loop, on the existing runner, with no new runner matrix.
- AC2: Each binary passes a smoke test (`--help` exits 0, non-empty output)
  before being attached to a release — verified the same rigor as the
  existing npm-tarball smoke test.
- AC3: `gdgraph build` against a real file succeeds from each Linux/macOS
  binary in CI, not just the one platform verified locally during
  specification authorship.
- AC4: `mcp serve` is verified with an actual connecting MCP client (not
  just "process exits without error") before the specification's
  no-dependency claim is treated as proven for that feature.
- AC5: The OpenTUI shell launches correctly from each binary in a real
  terminal context (CI's TTY emulation or a manual check) before the
  no-dependency claim is treated as proven for that feature.
- AC6: The Homebrew formula installs and `keryx --version` matches the
  tagged release version, with the pinned SHA256 verified by `brew` itself
  (not merely present in the formula).
- AC7: Existing npm and clone-based install paths are unchanged — verified
  by `release.yml`'s existing smoke-test step continuing to pass unmodified.
