# Quickstart

In this tutorial you add Keryx to a small project, ask the project a question
through its code graph, record a decision your agents can find later, and start
the agent shell. It takes about ten minutes and needs no model provider until
the last step.

Every command below was run in this order, in a new empty directory, and the
output is the real output, trimmed where marked with `…`.

## Before you start

- Keryx is installed and `keryx --version` prints a version. See [Install](install.md).
- `git` is installed.

You can follow along in any git repository you own. The examples use a
three-file TypeScript project so the output stays short.

## 1. Create a project and a workspace

Create the demo project: `checkout.ts` imports `cart.ts`, which imports
`price.ts`.

```bash
mkdir -p demo/src && cd demo
printf 'export function applyDiscount(total: number, percent: number): number {\n  return Math.round(total * (100 - percent)) / 100;\n}\n' > src/price.ts
printf 'import { applyDiscount } from "./price";\n\nexport function cartTotal(prices: number[], discount = 0): number {\n  return applyDiscount(prices.reduce((a, b) => a + b, 0), discount);\n}\n' > src/cart.ts
printf 'import { cartTotal } from "./cart";\n\nexport const checkout = (prices: number[]) => cartTotal(prices, 10);\n' > src/checkout.ts
git init -q && git add -A && git commit -qm "Initial commit"
```

Now create the Keryx workspace. `--yes` accepts the recommended defaults
without questions.

```bash
keryx init --yes
```

```text
✓ Created .metaproject
  9 of 9 modules enabled
  ✓ gdgraph (code graph, symbols, affected context)
  ✓ gdctx (token-aware command/read output)
  ✓ gdwiki (project knowledge base)
  ✓ gdskills (profile: recommended)
  ✓ health (quality scoring & gate)
  ✓ testing (test context & intelligence)
  ✓ memory (lessons, decisions, constraints)
  ✓ tasks (agent-first flow lifecycle)
  ✓ security (scanning, redaction, guardrails, audit)

Agent entrypoints
  Ignore rules: .git/info/exclude now holds keryx's managed block (38 entries); .gitignore is not modified.
  CLAUDE.local.md: created with the keryx block (gitignored, per checkout).
…
Git hooks
  ✓ gdgraph post-commit
  ✓ gdskills post-commit
  ✓ health post-commit
  ✓ testing post-commit
  · testing pre-push
  ✓ security pre-push
…
```

`init` did three things:

- It created `.metaproject/`, the directory that holds the project's knowledge.
  [The Metaproject](../concepts/metaproject.md) explains what is in it.
- It wrote ignore rules to `.git/info/exclude`, not to your `.gitignore`, and
  put a short routing block for agents in per-developer files that git ignores.
  Your tracked agent instruction files, if you have any, are not modified.
- It installed git hooks that keep the graph fresh after each commit.

The workspace is meant to be committed with your code, so commit it:

```bash
git add -A && git commit -qm "Add keryx workspace"
```

```text
keryx post-commit: rebuilding gdgraph after a graph-relevant commit
keryx post-commit: gdgraph rebuilt; versioned graph artifacts may now differ from the commit
…
```

The post-commit hook already rebuilt the graph.

## 2. Check the setup

```bash
keryx doctor
```

```text
keryx doctor

  ✓ bun: Bun 1.4.2 (floor >=1.3.14)
  ✓ ripgrep: rg at …/bin/rg
  ✓ sandbox: Seatbelt (sandbox-exec) available
  …
  ✓ standard: workspace is Metaproject Standard compliant
  ✓ entrypoints: managed block in CLAUDE.local.md (local); hooks in .claude/settings.local.json (local)
  ✓ worktrees: no .claude/worktrees directory
  ✓ graph-freshness: code graph is fresh
  ! wiki-freshness: no wiki freshness report has been produced; run `keryx wiki freshness`. This is not evidence that the wiki is fresh.
      fix: keryx wiki freshness
```

Each `!` line is a warning with the command that fixes it. Here the wiki has no
freshness report yet, which is expected in a new project. Run `keryx doctor`
whenever something looks wrong; the [troubleshooting page](troubleshooting.md)
starts from it.

## 3. Ask the code graph a question

The graph records which file imports which. Build it, then ask what depends on
`price.ts`:

```bash
keryx gdgraph build
keryx gdgraph affected src/price.ts
```

```text
gdgraph build complete: 3 nodes, 2 edges
summary: …/.metaproject/data/gdgraph/artifacts/summary.md
```

```text
# Affected context for src/price.ts

## Dependencies
- none

## Dependents
- src/cart.ts
```

An agent asks the same question before it edits `price.ts`, instead of reading
every file to find the callers. Answers come from the last build, not from the
working tree, so rebuild after you add, move or delete files.

## 4. Draft the wiki

The wiki is Markdown under `.metaproject/wiki/`. `collect` drafts pages from
what Keryx already knows about the code:

```bash
keryx wiki collect
keryx wiki status
```

```text
# gdwiki collect

created: 3
…
- created: .metaproject/wiki/architecture/project-map.md (gdgraph)
- created: .metaproject/wiki/components/src.md (gdgraph)
- created: .metaproject/wiki/architecture/testing-map.md (testing)

enrichment needed: 1 component page(s) still Status: draft
…
```

```text
# gdwiki status

enabled: yes
wiki root: .metaproject/wiki
total pages: 3
…
```

The drafts are scaffolding. You or an agent turn them into prose; Keryx never
overwrites a page once it has been edited.

## 5. Record a decision

Memory holds decisions, lessons and constraints that are not visible in the
code. Create a decision, accept it, and search for it:

```bash
keryx memory new decision --title "Prices round to whole cents"
keryx memory transition decisions/prices-round-to-whole-cents.md --to accepted --reason "agreed with the team"
keryx memory search "cents"
```

```text
Created decision entry: .metaproject/memory/decisions/prices-round-to-whole-cents.md
```

```text
Transitioned decisions/prices-round-to-whole-cents.md: draft -> accepted.
```

```text
# memory search: cents

Results: 1

### 1. Prices round to whole cents  (score 2.334)
- type: decision | status: accepted | confidence: medium | version: 0.2.0
…
```

New entries start as `draft`, and search skips drafts unless you pass
`--status draft`, so an unreviewed note does not reach an agent as settled fact. Edit the
Markdown file to fill in the details.

## 6. Start the agent shell

`keryx shell` is the interactive agent that works on top of the workspace. It
needs a model provider. The built-in `fake` provider makes no network call, so
you can check that the shell starts before you connect anything:

```bash
keryx shell --provider fake -p "What does src/cart.ts depend on?"
```

```text
  keryx — fake/fake-echo · agent · …/demo
  Type a message, or /help for commands.
…
  ● keryx

  [error] FakeProvider: no transcript matches request hash c9b42b10…
```

The shell started, opened a session for this project and sent the turn. The
`fake` provider only replays recorded test transcripts, so it has no answer for
a new prompt and reports that error. To get a real answer, connect a provider:

- **Interactively.** Run `keryx shell` with no flags. On the first run a picker
  lists the built-in providers and an option to add any OpenAI-compatible
  endpoint; it asks for a key when the provider needs one.
- **With an API key in the environment.** For example, with
  `ANTHROPIC_API_KEY` set, run
  `keryx shell --provider anthropic --model <model>`.
- **With a local model.** With a local model server running, run
  `keryx shell --provider ollama --model <model>`.
- **With a subscription.** `keryx auth login <provider>` signs in to a
  provider that offers subscription login.

[Connect a model provider](../guides/connect-a-provider.md) covers every
provider and where keys are stored. [Use a local model](../guides/use-a-local-model.md)
covers running fully offline.

Every session starts in `ask` mode: the agent asks before it runs a shell
command or changes a file. [Choose an approval mode](../guides/permission-modes.md)
explains the other modes.

## What you have now

```bash
keryx status
```

```text
Metaproject: ready
Root: .metaproject
Modules:
  gdgraph: enabled
  gdctx: enabled
  gdwiki: enabled
  gdskills: enabled
  memory: enabled
  tasks: enabled
  health: enabled
  testing: enabled
  security: enabled
  sac: disabled
```

Your project now has a committed workspace with a code graph, a wiki, a
decision record and git hooks that keep the graph current. Any agent that
reads the repository is pointed at `.metaproject/index.md` first.

## Next steps

- [Keryx in five minutes](concepts.md): how the pieces fit together.
- [Set up a project end to end](../guides/set-up-a-project.md): tests, code
  health, optional layers and validation for a real project.
- [Connect your agents](../modules/integrations.md): wire the workspace into
  the coding agents and editors you already use.
- [The keryx shell](../modules/shell.md): sessions, slash commands and settings.
