# Contributing to Keryx

Thanks for your interest in improving `keryx`. This guide covers everything you
need to get a change from a local checkout to a merge-ready pull request.

## Project Philosophy

Please keep these two invariants in mind before proposing changes:

- **Zero runtime dependencies.** `package.json` `dependencies` stays `{}`. Model
  and precision features are opt-in capabilities that live under
  `optionalDependencies` and load lazily via `await import()`. A missing optional
  dependency must always degrade to the deterministic fallback, never throw.
- **Offline-first, deterministic core.** The core is local, offline, and
  git-diffable. With no opt-in flags and no assets, every command must be
  byte-identical to before. No network calls or model backends in the default
  path.

## Requirements

- [Bun](https://bun.sh) `>= 1.1.0`
- `git`

## Getting Started

```bash
git clone https://github.com/MrCipherSmith/keryx.git
cd keryx
bun install
```

Run the CLI directly from source while developing:

```bash
bun ./src/cli.ts --version
bun ./src/cli.ts init --yes
bun ./src/cli.ts status
```

## Development Commands

| Command             | What it does                                  |
| ------------------- | --------------------------------------------- |
| `bun install`       | Install dev/optional dependencies             |
| `bun run build`     | Bundle the CLI to `./dist`                    |
| `bun run typecheck` | Type-check with `tsc --noEmit`                |
| `bun test`          | Run the test suite                            |
| `bun run check`     | Full gate: `tsc --noEmit && bun test`         |

Run `bun run check` before opening a pull request. It is the same gate reviewers
expect to pass.

## Tests

Tests are written with `bun test` and are **co-located** with the code they
cover as `*.test.ts` files under `src/` (for example
`src/security/guard.test.ts` next to `src/security/guard.ts`). When you add or
change behavior, add or update the co-located test in the same module.

Keep tests deterministic and offline — no network, no model backends in the
default path — consistent with the core philosophy above.

## Branch and Pull Request Flow

1. Fork the repository and create a topic branch off `main`.
2. Make your change, keeping the two invariants intact.
3. Run `bun run check` and make sure it passes.
4. Push your branch and open a pull request against `main`.
5. Fill out the pull request template (what/why, tests, docs).

Keep pull requests focused; smaller, single-purpose changes are easier to review
and land faster.

## Commit Messages

This repository uses [Conventional Commits](https://www.conventionalcommits.org/).
Use a type prefix and an optional scope, for example:

```text
feat(gdgraph): add ranked affected output
fix(security): stop redaction from leaking mask width
docs: clarify offline-first capability seam
chore: refresh module manifests
```

Common types: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`.

## Documentation

If your change affects behavior, update the relevant docs:

- User-facing behavior: `README.md`
- Current behavior reference: `docs/docs/`
- Intended design / specifications: `docs/requirements/`

## Reporting Bugs and Requesting Features

Open a GitHub issue using the bug report or feature request templates. When
relevant, attach the applicable `.metaproject/data/*/artifacts/latest.md` files.

## Security

Do not report security vulnerabilities through public issues. See
[SECURITY.md](SECURITY.md) for the private disclosure process.

## Code of Conduct

By participating in this project you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).
