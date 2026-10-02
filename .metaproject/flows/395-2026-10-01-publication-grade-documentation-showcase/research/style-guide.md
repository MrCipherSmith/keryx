# Writing guide for flow 363 workers

Every page written or rewritten in this flow follows this guide. The target IA
is `audit-report.md` §4 (approved); the drift items are §2.2 and §2.3a.

## Audience and voice

- Reader: a developer arriving from an announcement who has never seen Keryx.
- Second person, present tense, active voice. "Run `keryx doctor`", not
  "The user may wish to run".
- Plain and factual. No hype words: revolutionary, seamless, blazing,
  powerful, cutting-edge, game-changer, effortless, magic, supercharge.
- State limits honestly where they apply (platform gaps, experimental status).
- English only on the site.

## Forbidden content (AC10)

- Internal identifiers: `flow NNN`, `ACn`, `T12`, `W4`, `R1-F9`, review round
  numbers, PR numbers used as explanation. Describe the behaviour instead.
- External product names anywhere except (a) factual compatibility/provider
  tables, (b) install commands, (c) environment-variable names. Never in
  comparisons, inspiration credits or evaluative prose. No comparison pages.
- Personal data: names, emails, absolute home paths. Use `~/` or `<repo>`.

## Accuracy (AC5, AC6, AC7)

- Every command, flag and subcommand you write must exist. Check it against
  `bun ./src/cli.ts <group> --help` and, where help is incomplete, against
  `src/lib/group-subcommands.ts` or the handler. Run read-only commands to get
  real output; never invent output — trim it and mark trims with `…`.
- Never run commands that install hooks or write outside a scratch directory
  (`ctx install-hook` ignores `--dry-run`). Use a temp dir under
  `/private/tmp/claude-502/-Users-Goodea-goodea-keryx/84206f62-f154-4a1f-b114-025e8973227d/scratchpad/`
  for anything that writes (e.g. `keryx init --yes` in a fresh `git init` repo).
- Fix the drift items assigned to your task in `audit-report.md`; list any you
  leave, with the reason, in your result.

## Page templates

**Module page** (`docs/docs/modules/*.md`, 80-150 lines):

```
# <Area name>

<One sentence: what it is.> <One sentence: the problem it removes.>

## When to use it
- 3-5 bullets, each a concrete situation.

## Quick example
<A runnable 3-8 command block with trimmed real output.>

## How it works
<2-4 short paragraphs or a small table; link Concepts pages for depth.>

## Common tasks
| I want to… | Command or page |

## Status
<stable / experimental / opt-in, one line, matching project/status.md>

## Reference
- Links to the exact cli-reference.md / modules.md sections and related guides.
```

**Guide page** (how-to): title is the task ("Connect a model provider");
prerequisites, numbered steps, verify step, troubleshooting, next steps.

**Concept page** (explanation): why, the model, trade-offs, what it is not;
diagrams in Mermaid (the site renders them).

## Formatting (MkDocs Material)

- One `#` H1 per page, sentence case headings.
- Admonitions: `!!! note`, `!!! warning`, `!!! tip` — at most two per page.
- Code fences always carry a language (`bash`, `text`, `json`, `yaml`).
  Commands in `bash` blocks without a `$ ` prompt; output in separate `text` blocks.
- Links: relative Markdown links between pages (`../modules/shell.md`), with
  anchors that exist. Never link `raw.githubusercontent.com` or `blob/main`
  for site pages. Link into the repository (source files, CHANGELOG) with
  `https://github.com/MrCipherSmith/keryx/blob/main/<path>`.
- Tables for comparisons of options; prose for reasoning.

## Process

- Write only the files your dispatch assigns. If a fix belongs to another
  task's file, report it instead of editing.
- Never `git stash`, never `git add`, never commit. List every path you
  changed in `changed_files`.
- Build check when your task touches site pages:
  `/private/tmp/claude-502/-Users-Goodea-goodea-keryx/84206f62-f154-4a1f-b114-025e8973227d/scratchpad/docs-venv/bin/mkdocs build --strict -d /private/tmp/claude-502/-Users-Goodea-goodea-keryx/84206f62-f154-4a1f-b114-025e8973227d/scratchpad/site-<task>`
  and `bun scripts/check-doc-links.ts`. Other lanes write in parallel, so a
  failure in a file you do not own is reported, not fixed.
