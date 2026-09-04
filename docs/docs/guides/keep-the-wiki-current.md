# Keep the wiki current

A wiki page is a claim about code that may have moved since anyone checked it.
An agent that reads a stale page generates against an API that no longer
exists — confidently, and without any signal that it is wrong. This guide is
about the machinery that makes that visible, and about what it deliberately
does not do.

The short version: **run `keryx wiki freshness` to see what is in doubt, and
`keryx wiki refresh` to repair the part a machine can repair.** Everything
below is why those two commands behave the way they do.

## The problem, measured

Before any of this existed, this repository's own wiki looked healthy and was
not. A one-off probe compared each page's last commit against the commits
touching the code it describes:

- **28 of 42 component pages had drifted**, 530 commits in total
- all 42 had last been touched in a single month — generated once, never
  maintained
- nothing anywhere reported this

The reason was structural rather than neglect. The wiki and the code graph
were not connected: `GraphNode` was `{id, kind, path, language}` and no edge
said "this page describes that code". So the question *which pages does this
change affect* had no answer at all, and every mechanism that would depend on
it — a hook, a backlog, an enrichment pass — had nothing to stand on.

## How it works now

### `describes` — the edge everything rests on

The graph carries a layer of `wiki-page` nodes joined to files by `describes`
edges. A page's scope comes from three sources, highest precedence first:

1. a `Describes:` list in the page's frontmatter
2. paths linked under `## Related Code`
3. the module's key files, derived from the graph

Frontmatter **replaces** rather than merges. Someone who lists the files a
page covers is correcting the derivation, not adding to it.

The layer lives in its own storage files. It is deliberately *not* mixed into
`nodes.jsonl`, because five places in the codebase treat every non-`asset`
node as a source file — a page node there would be grouped into a fabricated
module and would corrupt the module set that orphan detection depends on.

### Provenance — what a page was checked against

Two fields, both inside the page, so they travel with it:

```markdown
VerifiedAt: 9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3
VerifiedScope: sha256:1a2b3c...
```

`VerifiedAt` is a git revision, and freshness is then
`git log <VerifiedAt>..HEAD -- <the page's files>` — cheap, exact, and it
yields *how far behind*, which is what makes a backlog orderable.
`VerifiedScope` is a content-hash snapshot used where git cannot answer: a
project that gitignores `.metaproject/`, a shallow clone, a rebased revision,
or no repository at all. It is strictly coarser — changed or unchanged, no
commit count — so findings derived from it are capped at `review-suggested`.
A binary verdict should not dress itself as the strongest measurement.

!!! warning "`VerifiedAt` does not mean the page is correct"
    It means *the code in this page's scope has not moved since that
    revision*. A page can be wrong from the day it was written and this
    mechanism will never notice. Every command wording keeps that distinction;
    so should you.

### Classification — what kind of change happened

Six classes: `added`, `removed`, `moved`, `signature`, `body`, `cosmetic`.
Signature detection reuses the tree-sitter symbol layer over both revisions of
a file rather than adding a second parser.

Without that layer — the capability is optional — classification returns
`body` for any substantive change and **never** claims `signature`, and the
report says so in `limitations`. A guessed signature verdict would route a
page onto the expensive prose path on no evidence.

### Propagation — how far a change travels

Bounded by what an edge *means*, not by a hop count. Two hops through
`describes` is certainty; two through `imports` is a guess; one number cannot
express both. Confidence decays `must-refresh` → `review-suggested` → `fyi`,
and the decay is the bound.

- Dependencies are never walked. A consumer changing does not make its
  dependency's documentation wrong.
- A body-only edit does not travel outward at all.
- A rename also reaches the page describing the **old** path, because that is
  where the edge still points.

Measured on this repository: a signature change in `src/lib/fs.ts` reaches 37
of 50 pages in 5 ms — 1 `must-refresh`, 23 `review-suggested`, 13 `fyi`. The
decay bounds the walk but does not make a hub change quiet, which is why the
human view hides `fyi` unless you pass `--all`.

### Provenance outranks propagation

If a page's own scope has not moved since it was verified, it cannot be
`stale-reference` — the Reference block is derived from exactly that scope, so
the claim would be false, not merely unhelpful. A dependency change on such a
page is kept but demoted to `fyi`.

This was found by running `refresh` and watching the same ten pages come back
`must-refresh` with `commitsBehind: 0`. The report was asserting work that had
just been done.

## The commands

| Command | What it does | Writes |
|---|---|---|
| `keryx wiki freshness` | Categorised backlog, read-only over the wiki | its own report |
| `keryx wiki refresh` | Regenerates managed `## Reference` blocks | page Reference blocks |
| `keryx wiki verify` | Stamps provenance | page frontmatter |
| `keryx wiki migrate-markers` | One-off: wraps existing Reference sections | marker lines |
| `keryx wiki validate` | Structural checks | nothing |

None of them calls a model.

### `wiki freshness`

```bash
keryx wiki freshness                 # since the queue, or HEAD~1
keryx wiki freshness --since <rev>   # explicit range
keryx wiki freshness --all           # include advisory (fyi) rows
keryx wiki freshness --json          # schema-valid report
```

Exits 0 whatever it finds. It is a report, not a gate.

**Read `limitations` first, every time.** An empty finding list with a
non-empty `limitations` means the check could not run — the graph was not
built, the symbol layer was unavailable, there is no git history. Zero
findings because nothing is stale and zero findings because nothing was
checked are different facts, and only one of them is good news.

Categories:

- **`stale-reference`** — the machine-owned Reference block no longer matches
  the graph. `wiki refresh` fixes it, free.
- **`stale-prose`** — a changed symbol is named in the page's prose. Someone
  has to read and rewrite sentences.
- **`orphan`** — the page describes code that has left the graph.
- **`undocumented`** — code with no page.
- **`unknown`** — never verified. Not stale, not fresh; nobody has checked.

### `wiki refresh`

```bash
keryx wiki refresh                   # every page with a managed block
keryx wiki refresh --page <path>
keryx wiki refresh --force           # overwrite a hand-edited block
keryx wiki refresh --dry-run
```

It rewrites only the bytes between the managed markers, bumps the patch
version, appends one changelog line, and stamps provenance. A page whose block
is already current is not rewritten **at all** — no bump, no changelog, no
re-stamp, because stamping an untouched page would assert a verification that
never happened.

A hand-edited block is refused with a named conflict rather than overwritten.
Someone who edited inside the machine region probably meant to, and the cost
of asking is one flag.

### `wiki verify`

```bash
keryx wiki verify --page <path>      # records that a page was reviewed
keryx wiki verify --baseline         # a measurement starting line
```

With neither flag it refuses. The whole point of `VerifiedAt` is that it
records a human looked; stamping a corpus in one keystroke would assert
reviews that did not happen. `--baseline` exists for exactly that bootstrap
case and says in its own output that it is not a claim the pages were read.

## The managed block

The `## Reference (from code graph)` section is wrapped in markers:

```markdown
<!-- keryx:reference:begin v=1 hash=<sha256 of the block> -->
## Reference (from code graph)
...
<!-- keryx:reference:end -->
```

Everything between them is machine territory and is regenerated, **including
on `Status: accepted` pages**. Everything outside is yours and is never
touched by a deterministic writer.

This is not a new policy overriding "an accepted page belongs to the human".
It is the boundary without which the contract already written in the `gdwiki`
skill cannot hold: that skill tells an enricher to leave the Reference section
alone *because it is graph-owned and regenerated*, and in the next breath says
accepting a page makes it unoverwritable. Both are satisfiable only if page
and section are different units of ownership. The markers draw that line.

The recorded `hash` detects a hand edit inside the block. A block with **no**
recorded hash is not treated as tampered — otherwise every page would demand
`--force` exactly once, immediately after migration, for having been migrated.

## Pages that are not about code

Some pages describe generated state or a decision rather than a region of the
repository: a project map rendered *from* the graph, a quality map from a
health run, an ADR. Giving one a scope would either cover the whole repository
— stale on every commit, useless as a signal — or invent a relationship that
is not there.

Declare it:

```markdown
Describes: none  # rendered from the graph, so its scope would be everything
```

The report counts these **separately from a gap**. "Nobody has done this yet"
and "this page is not about code" are different facts, and one of them is not
work. Without the declaration such a page sits in `undecidable` forever and
reads as an oversight, so each new reader tries to fix it again.

## For agents

`wiki_freshness` is available over MCP, read-only. Its output leads with
`limitations` unconditionally, because an agent that skims reads the top and
the one thing it must not miss is that a short list may mean nothing was
checked.

The `gdwiki` skill routes a reader to it **before** treating a page as
context. A page reported `stale-reference` may still have sound prose — its
API list is what moved; say so rather than quoting the list as current.

Repair stays a human act. Nothing here lets an agent stamp provenance.

## In CI and in health

A workflow runs on pull requests touching `src/**` or the wiki:

- `wiki validate` is a **gate** — a truncated managed block or a `Describes`
  path that does not exist are defects of structure, not matters of opinion.
- `wiki freshness` **reports and never fails the build.**

That second choice is deliberate and worth stating: a blocking freshness check
invites updating a page so CI passes, which manufactures filler faster than
drift manufactures staleness. Whether stale documentation should stop a merge
is a project's decision, not this workflow's.

`keryx health run` carries the figure beside lint, types and tests:

```
wiki freshness: 92% (46/50 scorable pages, 4 not code-scoped), 2 needing attention
```

Health **reads** the last report; it never recomputes, because a graph
traversal behind a command people expect to be fast is a cost they did not
agree to. If no report exists the metric is absent **with a reason** — never a
number, and never a flattering default.

The metric cannot move the health gate. That is enforced by the compiler: the
gate's input type has no place for it, so the guarantee breaks loudly the day
someone wires it in.

## What is deliberately not built

**Delta prose enrichment.** Designed, specified, and not implemented — on
measurement rather than preference. Over a 189-file range on this repository
the drift was **100% `stale-reference` and 0% `stale-prose`**: everything
stale was repairable for free, and the only token-spending phase had nothing
to work on.

That zero was checked twice before being trusted. All 53 pages carry real
prose, and all 53 name graph symbols in it — 2137 mentions — so the detector
can fire here. It did not, because no *changed* symbol is named in any page's
prose. If that stops being true, the case for building it will be made by
data.

**Incremental graph rebuild.** A pure optimisation. A full build is ~2.3 s on
this repository; the manifest it would read is already written. Worth taking
when full builds start to hurt, not before.

**A file watcher.** Accumulation is continuous and cheap — a git hook appends
one line within a ~40 ms budget. Interpretation is expensive and on demand. A
model woken on every file save would be resented within a week.

**Auto-accepted prose.** Changes to prose are either an explicit human command
or a reviewed proposal. Never a background rewrite.

## Known limits

- A page's freshness says nothing about whether it was ever correct.
- `stale-prose` fires only when a changed symbol is *named* in prose. Prose
  that describes a module in general terms will under-report by construction.
- The `undecidable`/`not-code-scoped` split depends on authors declaring
  intent. An undeclared page is indistinguishable from a forgotten one.
- Propagation cannot follow unresolved imports. The report now carries the
  share so you can judge it: on this repository 50 of 3406 edges, 1.5%,
  nearly all test fixtures.

## Related

- [Give an agent context](give-an-agent-context.md)
- [Run keryx in CI](run-in-ci.md)
- Requirements package: `docs/requirements/keryx-living-wiki-graph/`
