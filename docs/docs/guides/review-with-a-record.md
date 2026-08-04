# Review a branch and keep a durable record

**The problem:** review findings live in pull-request comments, which are
scattered, unqueryable, and gone the moment the branch is deleted. Nobody can
answer "what did we already find here, and what did we decide about it?"

**What you get:** a managed review package in the repository — coverage,
findings, decisions and learning candidates — that outlives the branch.

Every command below was executed; the output is from those runs.

## Start one

Standalone, or attached to a managed flow:

```bash
keryx review start  --target branch --ref feature/example --reviewers a,b
keryx review attach --flow 001 --target pull-request --ref 42
```

The full surface:

```console
$ keryx review
Usage:
  keryx review attach --flow <id> --target <kind> --ref <ref> [--reviewers a,b] [--report <path>]
  keryx review start --target <kind> --ref <ref> [--reviewers a,b] [--report <path>]
  keryx review ingest --report <path> [--flow <id>] --ref <ref>
  keryx review status <review-id-or-path>
  keryx review complete <review-id-or-path>
  keryx review lightweight

Modes:
  attach-review, review-flow, ingest
```

## Ingest a report someone already wrote

```bash
keryx review ingest --target report --ref round6-review.md --report path/to/report.md
```

**The parser has a shape, and it will refuse rather than guess.** Two things
that cost real time when they are learned the hard way:

- A finding must be a `## F-nnn — title` heading with `severity: <level>` in its
  block. A heading like `## F-040 (blocker) — …` is read as **prose**, and the
  ingest reports success having recorded **zero findings** — a ten-finding
  review stored as an empty package.
- A `blocker` or `major` finding **without a `class_scope`** is refused. The
  scope must name the sites and the enumeration method: *how* you established
  that this is the whole class, not just the instance you happened to see.

The second is the more useful constraint. It is the difference between "I found
a bug here" and "I know where else this shape occurs, and here is how I looked."

## Check where one stands

```console
$ keryx review status .metaproject/reviews/2026-08-03-ingest-round6-review-md/
# managed review: 2026-08-03-ingest-round6-review-md

mode: ingest
status: draft
target: report round6-review.md
flow: none
coverage: 1
```

## Complete it

```bash
keryx review complete <review-id-or-path>
```

Completion validates the package structurally — coverage, findings and
decisions have to be present and consistent, so "reviewed" is a state something
had to earn.

## Feed what you learned back

```bash
keryx memory ingest --from-review <path>
keryx skills learn --from-review <path> --skill <module>/<skill>
```

This is the point of the whole exercise. A finding that changes nothing is a
finding you will make again — and this repository has the receipts: six review
rounds on one branch, twelve blockers, and every one of them the same mistake
in a different place until it was written down as a
[lesson](https://github.com/MrCipherSmith/keryx/blob/main/.metaproject/memory/lessons/branching-on-a-value-whose-domain-you-never-wrote-down.md).

## Verify

```console
$ keryx review status <your-review>
```

`coverage` above `0` means reviewers are recorded against the target. A package
that ingested cleanly but shows **zero findings** has almost certainly hit the
heading-format problem above — check the report's `## F-nnn` headings before
concluding the branch was clean.

## Where to go next

- [CLI reference › review](../cli-reference.md)
- [Give an agent context](give-an-agent-context.md) — where the memory that
  review feeds actually lands.
