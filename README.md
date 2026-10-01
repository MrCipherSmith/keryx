<p align="center">
  <picture>
    <img src="docs/assets/keryx-logo-hero.png" alt="Keryx" width="440">
  </picture>
</p>

<p align="center"><strong>One project-local brain for your AI agents and your team.</strong></p>

<p align="center">
  <a href="https://github.com/MrCipherSmith/keryx/actions/workflows/ci.yml"><img src="https://github.com/MrCipherSmith/keryx/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/@mrciphersmith/keryx"><img src="https://img.shields.io/npm/v/@mrciphersmith/keryx.svg" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <a href="https://mrciphersmith.github.io/keryx/"><img src="https://img.shields.io/badge/docs-site-7c6fd6.svg" alt="Documentation"></a>
  <a href="https://mrciphersmith.github.io/keryx/getting-started/install/#bun-version"><img src="https://img.shields.io/badge/bun-%E2%89%A51.3.14-f9f1e1.svg" alt="Bun 1.3.14 or newer"></a>
</p>

<p align="center">
  English | <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <a href="https://mrciphersmith.github.io/keryx/">Documentation</a> ·
  <a href="https://mrciphersmith.github.io/keryx/getting-started/quickstart/">Quickstart</a> ·
  <a href="https://mrciphersmith.github.io/keryx/modules/project-knowledge/">Modules</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

```bash
npm install -g @mrciphersmith/keryx
```

<p align="center">
  <img src="docs/assets/demo.gif" alt="A terminal session running keryx init, keryx doctor, keryx gdgraph build, keryx gdgraph affected and keryx wiki status in a small TypeScript project" width="880">
</p>

## What is Keryx

Keryx keeps a project's knowledge, rules and work history in a `.metaproject/`
directory next to your code. Your coding agents read it, the `keryx` shell works
from it, and your team reviews it in the same pull requests as the code.
The graph, wiki, memory and checks run locally without a model; only the agent
shell and a few commands that write prose need a provider.

- **Project context in the repository.** A code graph, a wiki, decisions and
  lessons, so an agent asks the project instead of re-reading it.
- **An agent shell of its own.** `keryx shell` runs on the model provider you
  choose, under an allow, ask or deny policy and an operating-system sandbox.
- **Managed work.** A flow freezes its acceptance criteria before work starts
  and completes only when each one is confirmed against recorded evidence.
- **Review with a record.** Review rounds and their findings are kept as files
  that outlive the branch.
- **Works with your existing agents.** Keryx installs its context into the
  coding agents and editors you already use; you do not have to switch.

## Install

Install with the command at the top of this page, then check it with `keryx --version`.
The package runs on [Bun](https://bun.sh) 1.3.14 or newer, so Bun must be on
your `PATH`. A standalone binary that needs no Bun, and two clone-based
installers, are described in [Install](https://mrciphersmith.github.io/keryx/getting-started/install/).

The package name is scoped. The unscoped `keryx` package on npm is an unrelated
project; install `@mrciphersmith/keryx`, which provides the `keryx` command.

## Quickstart

Create a three-file project (`checkout.ts` imports `cart.ts`, which imports
`price.ts`) and add Keryx to it:

```bash
mkdir -p demo/src && cd demo
printf 'export function applyDiscount(total: number, percent: number): number {\n  return Math.round(total * (100 - percent)) / 100;\n}\n' > src/price.ts
printf 'import { applyDiscount } from "./price";\n\nexport function cartTotal(prices: number[], discount = 0): number {\n  return applyDiscount(prices.reduce((a, b) => a + b, 0), discount);\n}\n' > src/cart.ts
printf 'import { cartTotal } from "./cart";\n\nexport const checkout = (prices: number[]) => cartTotal(prices, 10);\n' > src/checkout.ts
git init -q && git add -A && git commit -qm "Initial commit"

keryx init --yes
git add -A && git commit -qm "Add keryx workspace"
keryx doctor
keryx gdgraph build
keryx gdgraph affected src/price.ts
```

The last command answers what depends on `price.ts` from the code graph,
without reading every file:

```text
# Affected context for src/price.ts

## Dependencies
- none

## Dependents
- src/cart.ts
```

`keryx init` writes its ignore rules to `.git/info/exclude` and leaves your
tracked agent instruction files alone. When you are ready to work with an
agent, run `keryx shell`; on the first run it asks which model provider to
use. The full [Quickstart](https://mrciphersmith.github.io/keryx/getting-started/quickstart/)
continues with the wiki, a recorded decision and the shell.

## What you get

| You need | Keryx gives you | Read more |
|---|---|---|
| Answers about the code before an agent edits it | Code graph, compact command output, wiki and project memory | [Project knowledge](https://mrciphersmith.github.io/keryx/modules/project-knowledge/) |
| An agent that already knows the repository | `keryx shell` with durable sessions, approval modes and `/rewind` | [The keryx shell](https://mrciphersmith.github.io/keryx/modules/shell/) |
| A free choice of model | Hosted, subscription, local and any OpenAI-compatible provider | [Models and providers](https://mrciphersmith.github.io/keryx/modules/providers/) |
| Limits an agent cannot talk its way past | Policy engine, OS sandbox, lifecycle hooks and a security scanner | [Harness and safety](https://mrciphersmith.github.io/keryx/modules/harness-and-safety/) |
| The same context in the agents you already use | Hooks, instruction files and an MCP server for your editor | [Connect your agents](https://mrciphersmith.github.io/keryx/modules/integrations/) |
| A clear finish line for delegated work | Flows with frozen criteria, journals, signed confirmations and review packages | [Managed work](https://mrciphersmith.github.io/keryx/modules/managed-work/) |
| A health gate and the tests that matter | One health report with a pass, warn or fail gate, and related-test selection | [Quality](https://mrciphersmith.github.io/keryx/modules/quality/) |
| Repeatable procedures instead of improvised ones | Versioned skills, synced agent rules and reviewed learning | [Skills, rules and learning](https://mrciphersmith.github.io/keryx/modules/skills-and-learning/) |
| Upkeep without you at the keyboard | Triggers, scheduled agent tasks and a loopback HTTP entry | [Automation](https://mrciphersmith.github.io/keryx/modules/automation/) |

## How it works

<p align="center">
  <img src="docs/assets/how-it-works.svg" alt="Diagram: the repository holds the code and a .metaproject directory; your coding agents and the keryx shell both read .metaproject" width="880">
</p>

`keryx` builds and maintains `.metaproject/` from your code and from the work
done in it. Everything there is Markdown or JSON, so it is reviewed in a diff
like any other file. Agents find it through a short routing file,
`.metaproject/index.md`. [ARCHITECTURE.md](ARCHITECTURE.md) describes the
source layout, and [The Metaproject](https://mrciphersmith.github.io/keryx/concepts/metaproject/)
describes the workspace.

## Where to go next

| If you want to… | Go to |
|---|---|
| Understand the pieces in five minutes | [Keryx in five minutes](https://mrciphersmith.github.io/keryx/getting-started/concepts/) |
| Set up a real project end to end | [Set up a project](https://mrciphersmith.github.io/keryx/guides/set-up-a-project/) |
| Connect a hosted or local model | [Connect a model provider](https://mrciphersmith.github.io/keryx/guides/connect-a-provider/) |
| Wire Keryx into your current agent | [Connect your agents](https://mrciphersmith.github.io/keryx/modules/integrations/) |
| Choose how much an agent may do unasked | [Choose an approval mode](https://mrciphersmith.github.io/keryx/guides/permission-modes/) |
| Review changes and keep the record | [Review with a durable record](https://mrciphersmith.github.io/keryx/guides/review-with-a-record/) |
| Run Keryx in CI | [Run keryx in CI](https://mrciphersmith.github.io/keryx/guides/run-in-ci/) |
| Drive a running session from a chat on your phone (opt-in; connect with `/channels`) | [Drive keryx remotely](https://mrciphersmith.github.io/keryx/guides/drive-keryx-remotely/#remote-control-from-telegram) |
| Look up a command | [CLI reference](https://mrciphersmith.github.io/keryx/cli-reference/) |

## Status

Keryx is pre-1.0 and released in the 0.3.x series; the npm badge shows the
current version. Until 1.0, a minor version can change a command, a flag or a
file format, and each change is recorded in the [changelog](CHANGELOG.md).
macOS and Linux are supported; the Linux sandbox has fewer controls. Windows is
unverified; use WSL. See [Project status](https://mrciphersmith.github.io/keryx/project/status/)
for what is stable and what is experimental, and
[Limitations](https://mrciphersmith.github.io/keryx/limitations/) for known gaps.

## Built with Keryx

Keryx is developed with Keryx. This repository commits its own `.metaproject/`,
so the plan, frozen criteria, journal and review rounds behind each change sit
next to the code they produced, and you can read them here on GitHub.
[Built with Keryx](https://mrciphersmith.github.io/keryx/project/built-with-keryx/)
explains the record and walks through one change end to end.

## Community and contributing

- Questions and help: [SUPPORT.md](SUPPORT.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md) and the [roadmap](ROADMAP.md)
- Security reports: [SECURITY.md](SECURITY.md)
- Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

Keryx is released under the [MIT License](LICENSE).
