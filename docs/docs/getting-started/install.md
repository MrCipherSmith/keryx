# Install

Keryx is one command-line program, `keryx`. There are four ways to install it.
They all give you the same CLI. They differ in what the machine needs first and
in which version you get.

| Path | Needs on the machine | Version you get | Installs to |
|---|---|---|---|
| [npm package](#npm-package) (recommended) | npm to install, Bun ≥ 1.3.14 to run | the published release | your global npm prefix |
| [Standalone binary](#standalone-binary) | `curl` and a sha256 tool; no Bun, git or Node | the published release | `~/.local/bin/keryx` |
| [Managed clone](#managed-clone) | `git`, Bun | the tip of git `main`, not a release | `~/.keryx/keryx` plus a wrapper in `~/.local/bin` |
| [Project-local clone](#project-local-clone) | `git`, Bun | the tip of git `main`, not a release | `.metaproject/runtime/keryx` inside the project |

If you are not sure, use the npm package.

## Requirements

- **Bun 1.3.14 or newer** for every path except the standalone binary. See
  [Bun version](#bun-version).
- **git** for git hooks, `--changed` scopes and the two clone installers. The
  core runs without it.
- **ripgrep** (`rg`) for `keryx ctx rg` and the agent's code search. Without it
  those commands exit non-zero instead of falling back to a slower scan.

Other tools (`gh`, `eslint`, `tsc`, your test runner) are used when present and
skipped when absent.

## Platforms

| Platform | Status |
|---|---|
| macOS, arm64 and x64 | Supported. Full OS sandbox: filesystem, network off, domain allowlist, credential masking. |
| Linux, x64 and arm64 | Supported. OS sandbox through `bubblewrap`: filesystem and network off only. The domain allowlist and credential masking refuse to run. |
| Alpine and other musl or BusyBox systems | No standalone binary. The npm launcher's `env -S` shebang does not work with BusyBox `env`. |
| Windows | Not verified. No standalone binary and no OS sandbox, so every contained run fails closed. Use WSL. |

`keryx sandbox status` prints what the sandbox can do on your machine. The
[security model](../concepts/security-model.md#os-sandbox) explains the
difference between the platforms.

## npm package

```bash
npm install -g @mrciphersmith/keryx
keryx --version
```

`keryx --version` prints the installed version, a `0.3.x` number. The newest
one is on the [releases page](https://github.com/MrCipherSmith/keryx/releases/latest).

!!! warning "Install the scoped name"
    The package is `@mrciphersmith/keryx`. The unscoped name `keryx` on npm
    belongs to an unrelated project, so `npm install -g keryx` and `bunx keryx`
    install or run the wrong program. The command the scoped package installs
    is still called `keryx`.

The package is built for Bun: its launcher runs `bun`, so Bun must be on your
`PATH` even though npm installed the package. Releases are published from a
version tag with npm provenance.

## Standalone binary

A compiled binary is attached to every GitHub release for macOS (arm64, x64)
and Linux (x64, arm64). It carries its own Bun, so the machine needs nothing
else.

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/scripts/install-binary.sh | bash
```

The script picks the asset for your platform and installs it to
`~/.local/bin/keryx`. Two environment variables change that:

| Variable | Effect |
|---|---|
| `KERYX_BIN_DIR` | Install directory instead of `~/.local/bin`. |
| `KERYX_RELEASE_TAG` | Install this release tag (for example `v0.3.46`) instead of the latest one. |

The download is checked against the sha256 digest GitHub records for that
release asset. A mismatch, an unreadable digest or a missing sha256 tool stops
the install. `KERYX_ACKNOWLEDGE_NO_CHECKSUM=1` installs without the check, as
an explicit choice. The check catches a corrupted or tampered download. It does
not protect against a compromised GitHub account, because the digest and the
binary come from the same place.

## Managed clone

This clones the repository into `~/.keryx/keryx` and writes a wrapper at
`~/.local/bin/keryx`.

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/install | bash
```

The same installer is available as a Bun script:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/install.ts | bun -
```

!!! note "The clone installers track `main`"
    Both clone installers check out the tip of git `main`, which can be ahead
    of the latest release. To install a release instead, pin its tag with
    `KERYX_REF`:

    ```bash
    curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/install | KERYX_REF=v0.3.46 bash
    ```

    `keryx update` later moves a clone back to the tip of `main` unless you pass
    `--skip-runtime`.

Make sure `~/.local/bin` is on your `PATH`. This also applies to the standalone
binary:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## Project-local clone

Use this when you do not want a global command. It clones the runtime into
`.metaproject/runtime/keryx` inside the current project and runs `keryx init`
there.

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/keryx/main/scripts/install.sh | bash -s -- --project --yes
```

`--no-gdgraph` and `--no-gdctx` skip those two modules. `KERYX_REF` pins a tag
here too.

## Bun version

Keryx needs **Bun 1.3.14 or newer**. Check with `bun --version` and update with
`bun upgrade`. `keryx doctor` reports the installed version against the floor.

The floor fixes a real failure. Bun 1.2.22 through 1.3.13 can close the
terminal's input stream while another native stream is read in the same
process. In `keryx shell` that looks like a frozen screen: the spinner keeps
running but no key, Esc or Ctrl+C gets through, typically when subagents start.
Keryx detects the closed input and reopens the terminal, but only a current Bun
removes the cause.

The standalone binary bundles its own Bun and is not affected.

## Check the install

```bash
keryx --version
keryx doctor
```

`keryx doctor` prints one line per check (version, Bun floor, ripgrep, sandbox,
providers, MCP servers, integrations, workspace, graph and wiki freshness) and
a `fix:` line under every warning. The [quickstart](quickstart.md#2-check-the-setup)
shows its output in a new project.

## Upgrade

Keryx checks for a newer release itself. `keryx shell` runs one bounded check in
the background at start-up and shows a notice only when the registry has a
strictly newer version. It never installs anything. Run the same check by hand:

```bash
keryx version check
```

```text
Keryx 0.3.46 → 0.3.48
npm install -g @mrciphersmith/keryx@latest
```

The output above is from an older install; yours shows your version and the
newest one.

A successful answer is cached for 24 hours, a failed one is not retried for 15
minutes, and each request times out after 2 seconds. Offline or unknown results
never stop work. `keryx version check --json` is the form for scripts and
agents.

How to upgrade depends on the install path:

| Path | Upgrade |
|---|---|
| npm package | `npm install -g @mrciphersmith/keryx@latest` |
| Standalone binary | Run the install script again. |
| Managed or project-local clone | Run the installer again, or run `keryx update`, which fetches `main` into the clone before it refreshes the project. |

After upgrading, run `keryx update` in each project. It refreshes the managed
files in `.metaproject/` (skills, module manifests, hooks, the dashboard) and
never writes your data under `.metaproject/data/`. For npm and binary installs
`keryx update` does not touch the program itself.

## Reference

- [`version`](../cli-reference.md#version), [`doctor`](../cli-reference.md#doctor) and [`update`](../cli-reference.md#update) in the CLI reference.
- [Reference index](../reference/index.md): configuration and every other reference page.

## Next steps

- [Quickstart](quickstart.md): set up a project and ask it a question.
- [Keryx in five minutes](concepts.md): the mental model.
- [Troubleshooting](troubleshooting.md): `command not found`, Bun errors and other first-run problems.
