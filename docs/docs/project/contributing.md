# Contributing and support

Keryx is developed in the open on GitHub. The documents below live in the
repository root, so they are versioned with the code they describe.

| Document | Read it when you want to |
|---|---|
| [CONTRIBUTING.md](https://github.com/MrCipherSmith/keryx/blob/main/CONTRIBUTING.md) | Set up a development checkout, run the tests, and open a pull request |
| [SUPPORT.md](https://github.com/MrCipherSmith/keryx/blob/main/SUPPORT.md) | Ask a question, report a bug, flag a docs problem or request a feature |
| [SECURITY.md](https://github.com/MrCipherSmith/keryx/blob/main/SECURITY.md) | Report a vulnerability privately |
| [CODE_OF_CONDUCT.md](https://github.com/MrCipherSmith/keryx/blob/main/CODE_OF_CONDUCT.md) | Know the standards for taking part |
| [ROADMAP.md](https://github.com/MrCipherSmith/keryx/blob/main/ROADMAP.md) | See what is being worked on, what comes next, and the stability policy |
| [ARCHITECTURE.md](https://github.com/MrCipherSmith/keryx/blob/main/ARCHITECTURE.md) | Find your way around the source tree before changing it |

## Ask or report

All questions and reports go through
[GitHub issues](https://github.com/MrCipherSmith/keryx/issues/new/choose).
Pick the form that fits: bug report, question, documentation problem or feature
request. Include the output of `keryx doctor`; it lists the version, Bun,
ripgrep, sandbox, providers and integrations in one place.

!!! warning "Security problems"
    Never report a vulnerability in a public issue. Use
    [private vulnerability reporting](https://github.com/MrCipherSmith/keryx/security/advisories/new)
    as described in SECURITY.md.

## Contribute a change

You need `git` and Bun 1.3.14 or newer. CONTRIBUTING.md has the full steps; in
short:

```bash
git clone https://github.com/MrCipherSmith/keryx.git
cd keryx
bun install
bun run check
```

`bun run check` runs lint, typecheck and the test suite. Pull requests run the
CI jobs listed on [Project status](status.md#quality-gates).

Larger changes in this repository go through a flow with frozen acceptance
criteria and recorded reviews. [Built with Keryx](built-with-keryx.md) shows
what that record looks like and how to read it.
