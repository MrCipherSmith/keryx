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
                      [--verifications <file|->] [--verification-mode off|annotate|filter]
                      [--scope <scope.json>]
  keryx review scope [--ref <base>] [--diff <file|->] [--path a,b] [--context <n>]
                     [--json | --scoped-diff] [--append <file>]
  keryx review status <review-id-or-path>
  keryx review complete <review-id-or-path>
  keryx review lightweight

Modes:
  attach-review, review-flow, ingest
```

(The help also prints a paragraph on `scope` and one on verification; both are in
the [CLI reference](../cli-reference.md#review).)

## Narrow the scope before anyone reads it

```bash
keryx review scope --ref "$(git merge-base HEAD main)" --append <package>/scope.md
```

Deterministic, no model call: lockfiles, generated and vendored paths, binaries,
whitespace-only and comment-only hunks are dropped, and what remains is bounded
to the changed hunks plus 20 lines of context. **Every drop is recorded with its
reason** — a scope that shrank silently reads afterwards as "we reviewed
everything".

## Verify the findings before you report them

Wave C of a review used to be `review-strict`, which re-read the findings and
adjusted their severity with no new evidence. It is gone, because that operation
is measured to make accuracy worse: GPT-4 on GSM8K falls 95.5 → 91.5 → 89.0 across
self-correction rounds, GPT-3.5 on CommonSenseQA falls 75.8 → 38.1 (Huang et al.,
ICLR 2024, arXiv:2310.01798).

`review-verifier` replaced it and **can only delete**. It checks a finding by
running something that fails if the finding is real, and merges through:

```bash
keryx review ingest --report round7.md --ref round7 \
  --verifications verifier-result.json \
  --scope scope.json
```

The merge cannot raise a severity, add a finding, or rewrite one; a finding is
never verified by the reviewer that raised it; and a verdict reached by reasoning
alone is capped at `unverifiable`. The default mode is `annotate` — verdicts are
recorded and **nothing is removed** — so the drop rate is a measured number before
it costs a real finding. Every package's `scope.md` carries the stage counts:
dropped by the pre-filter, refuted by the verifier, retained.

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
