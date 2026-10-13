# Support

Keryx is maintained by one primary maintainer and a small group of contributors.
Replies are best effort, with no response-time guarantee.

## Before you ask

1. Run `keryx doctor`. It checks the version, the Bun floor, ripgrep, the
   sandbox, providers, MCP, integrations and graph and wiki freshness, and
   prints what to fix.
2. Search the [documentation site](https://mrciphersmith.github.io/keryx/),
   including [Troubleshooting](https://mrciphersmith.github.io/keryx/getting-started/troubleshooting/)
   and [Limitations](https://mrciphersmith.github.io/keryx/limitations/).
3. Run `keryx help` or `keryx <command> --help`, which describe the commands of
   the version you have installed.
4. Search [existing issues](https://github.com/MrCipherSmith/keryx/issues).

## Where to ask

GitHub Discussions is not enabled for this repository, so everything goes through
[Issues](https://github.com/MrCipherSmith/keryx/issues/new/choose). Pick the form
that fits; each one adds a label.

| You have | Use | Label |
| --- | --- | --- |
| A defect or a crash | Bug report | `bug` |
| A how-to or "does it support" question | Question | `question` |
| A wrong, missing or unclear docs page | Documentation problem | `documentation` |
| An idea or a missing capability | Feature request | `enhancement` |
| A security vulnerability | [Private advisory](https://github.com/MrCipherSmith/keryx/security/advisories/new), never a public issue. See [SECURITY.md](SECURITY.md). | |

## What to include

A report that carries these can usually be answered without a second round trip.

- The version: `keryx --version`.
- The `keryx doctor` output, or `keryx doctor --json` for a machine-readable
  copy. Remove anything private first.
- Your operating system and architecture, for example macOS 15 arm64 or
  Ubuntu 24.04 x64.
- How you installed Keryx: npm, the standalone binary, the install script, a
  project clone, or from source.
- The model provider and model, if the problem involves `keryx shell`,
  `keryx harness` or another model command.
- The exact command you ran, what you expected, and what happened, as text rather
  than a screenshot.
- The smallest project state that reproduces it. Relevant
  `.metaproject/data/*/artifacts/latest.md` files help; trim secrets and private
  paths before pasting.

Keryx scans its own output for secrets, but do not rely on that for text you
paste into a public issue.

## Contributing a fix

Pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the
checks to run first.
