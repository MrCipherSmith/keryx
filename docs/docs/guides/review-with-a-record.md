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
  keryx review attach --flow <id> --target <kind> --ref <ref> [--head <sha>]
                      [--reviewers a,b] [--report <path>]
  keryx review start --target <kind> --ref <ref> [--head <sha>] [--reviewers a,b] [--report <path>]
  keryx review ingest --report <path> [--flow <id>] --ref <ref> [--head <sha>]
                      [--verifications <file|->] [--verification-mode off|annotate|filter]
                      [--scope <scope.json>] [--refuted <file|->]
                      [--max-findings <n>] [--spent <usd>] [--spend-ceiling <usd>]
                      [--parallel <n>] [--outstanding <n>]
  keryx review scope [--ref <base>] [--diff <file|->] [--path a,b] [--context <n>]
                     [--json | --scoped-diff] [--append <file>]
  keryx review blast-radius [--ref <base> | --changed a,b] [--depth <n>] [--max-files <n>]
                            [--no-related-tests] [--final] [--previous <blast-radius.json>]
                            [--json | --brief] [--out <file>]
  keryx review budget [--spent <usd>] [--ceiling <usd>]
                      [--reviewers a,b] [--parallel <n>] [--outstanding <n>]
  keryx review comments collect --repo <owner/repo> --pr <n> [--self <login>]
                                [--round <n>] [--out <findings.json>] [--json]
                                [--fixtures <dir>]
  keryx review comments reply --repo <owner/repo> --pr <n> --outcomes <file|->
                              --sha <head-sha> --final [--round <n>] [--dry-run]
                              [--max-replies <n>] [--max-sentences <n>] [--max-chars <n>]
                              [--flow-link <url>] [--fixtures <dir>]
  keryx review loop --flow <flow-id> [--task <Tn>]
  keryx review stack [--json]
  keryx review status <review-id-or-path>
  keryx review complete <review-id-or-path>
                        [--finding <id> --disposition <state> --evidence <text>]...
  keryx review lightweight

An unrecognised option is REFUSED, not ignored.

Modes:
  attach-review, review-flow, ingest
```

(The help also prints a paragraph on `scope` and one on verification; both are in
the [CLI reference](../cli-reference.md#review).)

### Rounds, and why a second one gets its own directory

Without `--review-id`, a package is named from the date, the mode and the ref.
A second round of the same branch on the same day therefore used to land on the
first one and overwrite it — which quietly made loop detection impossible, since
repetition cannot be observed when only the latest round survives.

A default-named round now takes the next free name: `<base>`, then `<base>-r02`,
`<base>-r03`. The first round of a day keeps the name it always had.

**An explicit `--review-id` still overwrites, deliberately.** That is the retry
path — the same round re-ingested after a correction — and giving it a
discriminator would turn every retry into a phantom round whose report is
byte-identical to the one before it, which reads as a stuck loop.

The cost of the choice, stated: running `review ingest` twice with no
`--review-id` records two rounds, and if the reports match it escalates. That is
what the record says happened, and it is the safe direction — reusing the
directory would delete exactly the signal a genuinely stuck round produces.

## Narrow the scope before anyone reads it

```bash
keryx review scope --ref "$(git merge-base HEAD main)" --json > scope.json
```

Deterministic, no model call: lockfiles, generated and vendored paths, binaries,
whitespace-only and comment-only hunks are dropped, and what remains is bounded
to the changed hunks plus 20 lines of context. **Every drop is recorded with its
reason** — a scope that shrank silently reads afterwards as "we reviewed
everything".

Keep `scope.json` and pass it to `review ingest --scope` (below). That is how the
drop list reaches the review record. `--append <package>/scope.md` writes the
same block directly and now replaces an existing one rather than appending a
second, but `--scope` is the supported route because it does not depend on two
commands hitting the same file in the right order.

### And the second scope: what the change can break

```bash
keryx review blast-radius --ref "$(git merge-base HEAD main)" --json > blast-radius.json
keryx review blast-radius --ref "$(git merge-base HEAD main)" --brief
```

A review of the diff answers *is this change correct?* It does not answer *did
this change break something that was working*. The second scope is computed —
`gdgraph affected` walked outward from each changed file, ranked by edge
distance, kept to depth 2, cut at 40 files closest first — and it is bounded on
purpose: reviewing everything each round is unaffordable, and review quality
decays as context grows, so an unbounded second scope makes the later rounds
worse rather than safer.

The set is under **regression check, not under review**. A finding about style,
naming or architecture in code the change did not touch is refused in code, not
discouraged in prose. Every file the cap removed is in the record with its hop
and its path back to the change, and a changed file the graph cannot answer for —
any Markdown, JSON or shell file — is reported as unresolved rather than as an
empty radius.

Three rules do the refusing, and all three judge the claim: it must be anchored
inside the computed set, it must be `major` or above, and it must name what the
change did. **None of them reads the reviewer's name.** One used to: a
reviewer-dimension deny-list that, sitting after the severity floor, could only
ever fire on `major` and `blocker` findings — and duly refused a `blocker` that
said the change introduced an import cycle and the CLI no longer boots, because
`review-architecture` raised it. A false negative at blocker severity is the
failure this scope exists to prevent, so the rule is gone and the other three
carry it.

Recompute when the changed-file set moves, and always on the final round:

```bash
keryx review blast-radius --ref "$BASE" --previous blast-radius.json --final
```

## Answer the humans — once, at the end

```bash
keryx review comments collect --repo acme/app --pr 7 --self "$(gh api user --jq .login)" \
  --round 3 --out external-findings.json
keryx review comments reply --repo acme/app --pr 7 --outcomes outcomes.json \
  --sha "$(git rev-parse HEAD)" --final --dry-run
```

Comments left on the pull request by other people — and by other bots — are
collected **every round** and answered **once**, after the final round. Replying
per round turns one thread into six and every reply states an intention rather
than an outcome. All three sources are read (inline comments, review submissions,
PR-level discussion), a bot reviewer is treated exactly like a human, and only
our own identity is filtered out — the collector refuses to run without knowing
it, because otherwise the reply pass answers itself.

Each reply is at most **two sentences and 600 characters**, cut rather than
warned about, with the detail living in the flow package that the link points at.
Both bounds are load-bearing: one 4,000-character sentence is one sentence, and a
sentence budget alone posts it verbatim.

Nothing here can resolve or hide a thread. The port holds an allow-list of five
endpoints — three reads and two writes — and everything else, GraphQL included,
is refused by the port itself. Replying is ours; resolving is the reviewer's call.

`--dry-run` prints the exact requests and writes nothing, and `--fixtures <dir>`
answers every read from JSON on disk, so the whole loop can be rehearsed with no
token, no network and no pull request.

### What survives a kill

The record for a pull request lives in
`.metaproject/reviews/pr-comments/<owner>__<repo>__<n>.json` and is written
*around* each POST, not after it: a marker before the request leaves, the settled
entry when it returns. Kill the process in that window and the next run finds the
marker, looks for that exact reply on the pull request, and either adopts it —
GitHub is the record — or sends it. Writing only after the post bounds the loss
to one comment; it does not close the window, and a rerun that answers a reviewer
twice is as bad as never answering.

A row with no `reply_url` means **nobody answered that comment**, and the
collector and the completion gate both read it that way, so a comment cannot be
simultaneously unanswerable and unclearable. Beyond the reply cap one summary
comment stands for the backlog — which changes how those comments are answered,
never what was decided about them: each keeps the disposition the orchestrator
reached for it. Inventing `dismissed-deprioritised` there would be a dismissal on
the orchestrator's own authority, and a dismissal needs a human decision.

## Check the bounds before you dispatch

```bash
keryx review budget --spent 2.10 --reviewers review-logic,review-style,review-security-code --outstanding 1
```

Three caps, all with defaults in code so a caller that says nothing still gets a
bound: **10 findings per reviewer** (blockers exempt), a **3.00 USD** spend
ceiling, and **4** reviewers in flight at once. This command exits non-zero when
the spend ceiling is reached, which is the point at which stopping is still
possible — an ingest can only record that a round already went over.

`--outstanding` is what an enclosing orchestrator already has in flight. It
matters because `review-orchestrator` runs nested under `flow-orchestrator` and
`job-orchestrator`, and keryx cannot see subagents in another process: without a
declared count the cap bounds this dispatch alone, and the record says so rather
than implying it covered more.

**Every cap records what it dropped** — the truncated finding ids, the queued
reviewers, the stop — in the package's `scope.md` under `## Caps`. A cap that
did not run prints `not recorded`, never `0`.

## Stop a fix loop that is not converging

```bash
keryx review loop --flow 203 --task T4
```

The round bound is three attempts. But a bound that fires on count alone lets an
agent emit the identical failing output three times and spend the whole budget
before anything notices. This escalates — exit 1 — when the same finding recurs
in two rounds or two consecutive rounds produce identical output, **regardless of
the remaining budget**, which it deliberately never reads.

It reads the review packages on disk and `tasks[].attempts.count` from
`flow.json`, not the session's memory: a resumed orchestrator's context starts at
zero while the real count does not.

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

## Complete it — and say what became of each finding

```bash
keryx review complete <review-id-or-path> \
  --finding F-001 --disposition acted-on --evidence "closed by 380bf3b0" \
  --finding F-002 --disposition dismissed-incorrect \
    --evidence "ran the writer under umask 002; the mode is 0700"
```

Completion validates the package structurally — coverage, findings and
decisions have to be present and consistent, so "reviewed" is a state something
had to earn.

The disposition triples are the half that was missing, and the cost of missing
it is measurable: computed over every review package in this repository,
precision came out at **53 / (53 + 0) = 100%** — not because the reviewers were
right, but because nothing on disk could record a finding as *wrong*. Only
`acted-on` and `dismissed-incorrect` say anything about accuracy; the other
dismissals (`dismissed-wont-fix`, `dismissed-out-of-scope`,
`dismissed-deprioritised`) say the finding was correct and not worth doing now.
Everything except `unknown` must cite where the outcome is written down, and a
recorded state and its citation cannot be overwritten by a later close.

The same applies to what a round raised and then threw away — pass it at ingest
rather than describing it in prose nobody can count:

```bash
keryx review ingest --report round7.md --ref round7 --refuted refuted.json
```

Closing with no dispositions is allowed. It leaves every finding reading
`unknown`, which means "nobody wrote down what happened".

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
