# The `mcp` name collides: keryx is on both sides of the protocol

Version: 0.1.0
Status: proposal — no decision taken

## The problem in one line

`keryx mcp` already means **keryx is the server**. This package makes it also
mean **keryx is the client**. Those are opposite directions under one word.

## Where it collides

MCP names a protocol, not a direction. Every other CLI in the ecosystem has
only one side — the consumer — so `<tool> mcp add` unambiguously means *"add a
server I will call"*. keryx has both sides, and the existing surface took the
name first, for the other one.

| surface | today | this package proposes | direction |
|---|---|---|---|
| `keryx mcp serve` | run keryx as an MCP server | — | keryx **is** the server |
| `keryx mcp install --runtime cursor` | write keryx into Cursor's client config | — | keryx **is** the server |
| `keryx mcp add <name> — <cmd>` | *(errors)* | register a third-party server | keryx **is** the client |
| `keryx mcp list` | *(errors)* | list third-party servers | keryx **is** the client |
| `/mcp` (TUI) | installer for keryx-as-server | unchanged | keryx **is** the server |
| `/mcps` (TUI) | — | third-party server modal | keryx **is** the client |

### Ranked by how much harm each actually does

**1. `/mcp` versus `/mcps` — the worst, and the only one with no disambiguator.**
One character apart, opposite meanings, no flags, no arguments to hint at which
you meant. A slash command is typed fast from memory. This one will be
mistyped on purpose-built muscle memory, in both directions, forever.

It is also backwards relative to the ecosystem: in Claude Code `/mcp` shows the
MCP servers you are *connected to*. A keryx user typing `/mcp` today gets an
installer for keryx itself. Adding `/mcps` for the thing they meant makes the
surprise permanent instead of fixing it.

**2. `keryx mcp list` — silently answers a different question.**
It errors today, so nothing breaks. But an operator who ran `keryx mcp install
--runtime cursor,claude` and then runs `keryx mcp list` will reasonably expect
to see what they installed. They will get a list of third-party servers with no
indication the other thing exists.

**3. `install` versus `add` — conceptually confusing, operationally distinct.**
Both mean "register something", with opposite subjects: `install` puts *keryx*
into someone else's config; `add` puts *someone else* into keryx's. In practice
they are hard to confuse — `install` demands `--runtime <editor>`, `add` takes a
server name and a command — so this one is a documentation problem more than a
usage trap.

## What the two sides of the argument are

**Ecosystem convention says the new surface is right.** Claude Code, Cursor and
Grok Build all use `mcp add|list|remove` for servers the tool consumes. Users
arrive with that expectation. Refusing it costs discoverability permanently, and
`keryx mcp add` will be typed by people who have never read our docs.

**keryx's history says the old surface is entrenched.** Counted on this branch:

| spelling | references in `docs/`, `README.md`, `src/`, `.metaproject/` |
|---|---|
| `keryx mcp serve` | 266 |
| `keryx mcp install` | 132 |
| `keryx mcp uninstall` | 16 |

`serve` is the big one and it is not the problem — nothing about "serve" is
ambiguous. `install`/`uninstall` carry 148 references between them, and they are
the ones whose meaning is surprising.

## Options

### A. Ship as specified — one verb, both directions

No renames. `/mcps` and `/mcp` coexist.

*Cost:* the two worst items above ship as permanent behaviour. Every future
reader of `keryx mcp --help` has to work out which entries are inbound and which
are outbound.

### B. Direction-explicit publisher, conventional consumer *(recommended)*

- `keryx mcp serve` — unchanged.
- `keryx mcp expose|unexpose` — today's `install`/`uninstall`, renamed to say
  what they do. Old spellings kept as aliases that still work and print one
  deprecation line.
- `keryx mcp add|list|remove|enable|disable|doctor|auth` — the consumer surface,
  matching every other CLI in the ecosystem.
- TUI: **`/mcp` becomes the consumer view** (matching Claude Code), the
  publisher installer moves to `/mcp-install`. `/mcps` is never shipped.

*Cost:* 148 documentation references to update, and a TUI slash command changes
meaning — which needs a release note, because it is the one change that could
surprise an existing user mid-session.

*Why this one:* it puts the surprising thing behind an explicit word (`expose`)
and gives the conventional word to the conventional meaning. The alias keeps
every existing script working.

### C. Separate top-level verb for the consumer

`keryx mcp …` stays entirely as-is; the consumer surface becomes
`keryx servers add|list|…` or `keryx tools …`.

*Cost:* nothing renames, nothing breaks — but `keryx mcp add` stays an error
forever, and it is the first thing an experienced user will type. Mitigable by
making that error say *"did you mean `keryx servers add`?"*, which is worth
doing under any option.

## Recommendation

**B**, with one part of **C** regardless of choice: whichever spelling loses,
the losing command should exist and print a pointer to the winner rather than
"unknown subcommand".

The single change I would not skip, even if everything else is deferred: **do
not ship `/mcps`.** It is the only item here with no way for a user to tell
which one they invoked until after it runs.

## Not decided here

This document does not change `decisions.md`, which currently adopts Grok
Build's naming wholesale — `mcp add|list|remove|enable|disable|doctor` and
`/mcps` — without recording that keryx already uses `mcp` for the opposite
direction. If an option here is adopted, that decision needs amending with the
reason, not silently overwriting.

## Concrete naming (operator decision 2026-09-09: keep the new, rename the old)

The consumer surface keeps `mcp`, because that is what the word means everywhere
else. The publisher surface — the one whose meaning surprises people — takes a
name that says what it does.

### Consumer: keryx calls other people's servers

| surface | name |
|---|---|
| CLI | `keryx mcp add \| list \| remove \| enable \| disable \| doctor \| auth` |
| TUI | `/mcp` |
| user config | `{keryxConfigDir()}/mcp-servers.json` |
| project config | `<project>/.keryx/mcp-servers.json` |

Unchanged from the specification. This is the ecosystem spelling; a user
arriving from Claude Code, Cursor or Grok Build types it without reading docs.

### Publisher: keryx is the server

Two jobs are bundled under `mcp` today, and they are not the same job. Split
them by what they do:

| today | proposed | why |
|---|---|---|
| `keryx mcp serve` | `keryx serve-mcp` | runs the server process. "serve" was never ambiguous, but it should not sit under a verb that now means the opposite. |
| `keryx mcp install --runtime cursor` | `keryx integrate cursor` | it writes keryx into *another tool's* config. That is integration, not installation — nothing is installed. |
| `keryx mcp uninstall --runtime cursor` | `keryx integrate --remove cursor` | same. |
| `/mcp` (TUI, publisher) | `/integrations` | shows which editors keryx is wired into. |

`integrate` is the load-bearing rename. `keryx mcp install` reads as "install
MCP" or "install a server"; it does neither. It tells Cursor that keryx exists.

### What each old spelling does after the rename

Every retired spelling keeps working and prints one line pointing at the new
name. None of them is removed:

- `keryx mcp serve` → runs, warns once, suggests `keryx serve-mcp`
- `keryx mcp install|uninstall` → runs, warns once, suggests `keryx integrate`
- `keryx mcp` with no subcommand → still serves, as today

### Cost, counted not guessed

| spelling | references in `docs/`, `README.md`, `src/`, `.metaproject/` |
|---|---|
| `keryx mcp serve` | 266 |
| `keryx mcp install` | 132 |
| `keryx mcp uninstall` | 16 |

414 references to update, and one TUI slash command changes meaning — `/mcp`
stops being the publisher view and becomes the consumer one. That last change is
the only one that can surprise someone mid-session, so it needs a release note
rather than a changelog line.

### Cheaper variant, if 266 references is too much churn

Leave `keryx mcp serve` where it is and rename only `install`/`uninstall` (148
references). `serve` genuinely is not ambiguous — nobody reads "serve" as
"consume" — and it is the single most-referenced spelling in the repository.

This keeps one asymmetry: `keryx mcp serve` and `keryx mcp add` coexist under one
verb meaning opposite directions. Tolerable, because neither can be mistaken for
the other in use, and it saves the bulk of the churn.

### What does not change under either variant

`/mcps` is not introduced. The guard is
`src/commands/agent-commands.confusable.test.ts`: a second slash command
differing only by a trailing `s` fails the build unless it is declared with a
written reason. `/model` + `/models` are declared; they share a subject, so a
mistype costs a keystroke.
