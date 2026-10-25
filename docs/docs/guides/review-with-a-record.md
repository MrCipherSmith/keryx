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

A round runs the core reviewers and the ones the stack and the change call for. `review-clean-code` and `review-style` are off by default: `keryx review required` lists them as excluded with the reason, and `report.md` ends up with the line `опциональные роли не запускались: …`. Add `--style` to `review start` (or `review required`) to run both, or `--with-role <role>` for one; the choice is kept in the package's `round-roles.json`. A project switches any role off, or always on, under `reviewRoles` in `routing.config.json` (`disabled`, `enabled`). `--all` does not bring a switched-off role back.

The full surface:

```console
$ keryx review
Usage:
  keryx review attach --flow <id> --target <kind> --ref <ref> [--head <sha>]
                      [--reviewers a,b] [--report <path>]
  keryx review start --target <kind> --ref <ref> [--head <sha>] [--reviewers a,b] [--report <path>]
                     [--memory-query "<query>"]
  keryx review ingest --report <path> [--flow <id>] --ref <ref> [--head <sha>]
                      [--verifications <file|->] [--verification-mode off|annotate|filter]
                      [--premises <file|->]...
                      [--scope <scope.json>] [--refuted <file|->]
                      [--max-findings <n>] [--spent <usd>] [--spend-ceiling <usd>]
                      [--parallel <n>] [--outstanding <n>]
  keryx review scope [--ref <base>] [--diff <file|->] [--path a,b] [--context <n>]
                     [--json | --scoped-diff] [--append <file>]
  keryx review blast-radius [--ref <base> | --changed a,b] [--depth <n>] [--max-files <n>]
                            [--no-related-tests] [--final] [--previous <blast-radius.json>]
                            [--package <review-dir>] [--json | --brief] [--out <file>]
  keryx review budget [--spent <usd>] [--ceiling <usd>]
                      [--reviewers a,b] [--parallel <n>] [--outstanding <n>] [--full]
  keryx review comments collect --repo <owner/repo> --pr <n> --sha <head-sha>
                                [--self <login>] [--round <n>]
                                [--out <findings.json>] [--json] [--fixtures <dir>]
  keryx review comments reply --repo <owner/repo> --pr <n> --outcomes <file|->
                              --review <review-id> --sha <head-sha> --final [--round <n>] [--dry-run]
                              [--max-replies <n>] [--max-sentences <n>] [--max-chars <n>]
                              [--flow-link <url>] [--fixtures <dir>] [--allow-closed-pr]
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

## Who runs the round

The agent that loads the `review-orchestrator` skill is the orchestrator: it runs
the round inline, in the main session, and does not hand the round to one subagent.
Before step 0 it checks three things:

1. **It can spawn.** A subagent-spawn tool (`Agent`, `spawn_subagent` or the host's
   equivalent) is present and the nesting depth is not spent (Claude Code nests at
   most 3 deep). If not, the whole output is
   `STATUS: BLOCKED nested_dispatch_unavailable — run this skill in the main session`,
   and nothing else runs. It never reviews alone.
2. **A round is needed.** A diff where every file is prose or machine-written data
   gets `round not needed: <reason>` and launches no reviewer. Prose is exactly:
   README or CHANGELOG at any depth; CONTRIBUTING, LICENSE, SECURITY or CODE_OF_CONDUCT
   at the top level; and, under `docs/`, `.metaproject/wiki`, `.metaproject/reviews` or a
   flow's `journal.md`, a file with extension `.md`, `.rst` or `.adoc` whose
   name holds a lowercase letter. An all-uppercase name (`AGENT.md`, `WARP.md`,
   `CONTEXT.md`) is steering by convention. Machine-written data is a file under
   `coverage/` or `__generated__/` with extension `.lcov`, `.info` or `.map`; json, txt,
   html and md there are code. Everything else counts as code: lockfiles, committed
   `dist/` output, CI, auth, migrations, config JSON, a flow's `description.md`,
   `acceptance-criteria.md` and `tasks/` (they are gate inputs), and steering files
   wherever they sit, `docs/` included: a directory named, singular or plural, agent,
   skill, command, rule, prompt, instruction, persona, steering or hook; any path
   segment starting with a dot (`.claude`, `.cursorrules`, `.mcp.json`); a name starting
   with `SKILL`, `AGENT`, `CLAUDE`, `GEMINI`, `QWEN`, `CODEX`, `WARP`, `CRUSH`, `JULES`,
   `KNOWLEDGE`, `GUIDELINES`, `CONVENTIONS` or `copilot-instructions`, ending in `.local`,
   `.override`, `.instructions`, `.prompt`, `.agent` or `.chatmode`, or containing `prompt`, `instruction` or
   `system`. A path with `..`, a backslash, a leading `./` or `//` also counts as
   code. `--all`, an explicit reviewer list or a gating round forces a round. The files
   are listed with `git diff --name-status --no-renames <base>...HEAD`, so a rename
   shows both paths.

   The rule is written twice: the skill text above is what the host executes, and
   `classifyRoundNeed` in `src/review/round-need.ts` is its tested reference. Nothing
   in the CLI calls that function yet; a test keeps the skill text and the function's
   token lists in step.
3. **A round is left.** The ceiling is `REVIEW_ROUND_CAP` rounds on one
   `merge-base..HEAD` (5 today); after the last one it stops and reports to you.

The default profile is read-only: one round, no edits. `--fix` is a separate
profile: the orchestrator still changes no code itself, it hands the findings to
`flow-orchestrator` or `task-implementer`, takes the new head and runs the next
round, and each re-review counts toward the ceiling.

Reviewers are dispatched in waves split by diff domain: `core` (logic, security,
architecture) first, then `domain` (frontend, backend, conventions), then `support`
(style, tests); the verifier runs last and only
removes findings. For `--all` and a full review a wave holds at most 10 reviewers
(`keryx review budget --full` prints the plan). A reviewer that answers
`STATUS: RATE_LIMITED` is requeued with the wave halved and `retry-after`
honoured, at most 300 seconds; after two halvings the round stops with
`STATUS: BLOCKED rate_limited`, naming the reviewers still queued.

After a timeout or a resumed session, `keryx review next --package <dir>` says which
reviewers still owe slices. It counts every reply a reviewer left, in wave order, so
slices covered in an earlier wave are not asked for again; saved `*.prev*.txt` copies are
ignored; and a finished reply that does not list the slices it covered is shown as
`rejected` and the reviewer is asked again. Asking twice gives the same answer.

What the skill does not do: it does not run as a subagent of another orchestrator
by default, it does not fix code, and it does not shrink the reviewer set to fit a
budget.

## How deep a round goes

A pull-request round runs **every available reviewer** by default (`mode: all`):
the bundled `review-*` roles and the project's own reviewers, minus the ones the
stack rules out and the ones whose path triggers no changed file matches.
`review-regression` joins the set only when a blast radius was computed for the
package, and `review-pr-contract` (the reviewer that reads the diff against the
pull request's own stated contract: title, description, linked issue, CI) only when
`pr-context.md` is in the package. `keryx review required --pr-context <file>`
prints the set, and prints each excluded reviewer
with its reason. A narrower set (`mode: diff`, the roles derived from the changed
files) is the operator's call and the dispatch records their own words as
`operatorQuote`; `review complete` refuses a smaller dispatch without them.

Reading the code is not the same as running it. After the reviewers answer, the
mutants they proposed are run against the tests:

```bash
keryx review mutate --test "bun test" --package <review-dir>
keryx review severity-audit --package <review-dir>
```

Reviewers propose a mutant for every changed branch, not a sample. On a shell host
the reviewers cannot write files, so the main session writes their candidates to
`research-evidence/mutants.json` as they are. A mutant says what kind of change it
is: `behavior` (the default) or `presentation` (copy, class names, display order).

`mutate` applies each proposed mutant in a scratch copy of the worktree (the
worktree is never written) and records whether the tests failed. The table in
`research-evidence/mutation-<n>.md` gives every mutant a row with its result, the
test command it was judged by and that command's exit code. A mutant that
**survived** means no test pins that behaviour. A survivor shows a
missing assertion, not wrong behaviour, so `severity-audit` raises a finding that
cites a surviving mutant (`mutant:<id>` in its `evidence`) from minor to major only
when no mutant in the same file was killed: nothing in the suite exercises that code.
When the file has a killed mutant, the suite covers it, the survivor is a gap in covered
code, and the severity is held with `severity_audit.held` (`kind: "covered"`, and the
kill count in `reason`). A survivor of kind `presentation` is held the same way,
because a test that does not pin copy is not a missing test. The audit never deletes a finding.
For an attended run `review complete`
refuses a package with proposed mutants nobody ran, unless the dispatch carries a
`mutationWaiver` with the operator's own words.

A long list can be run in part: `keryx review mutate --cap 20 …` runs the first 20
and prints `Not run: N candidates (cap 20)`. The rest stay pending, still block
`review complete` and are named in the report, so a cap changes the order of work,
not what the round claims.

A reviewer that answers `NEEDS_CONTEXT` is asked once more with what it named. If it
asks again it is recorded as **Not run** (`layout: no engine` for `review-layout`,
which needs a browser; `no engine` for any other role), never as a clean pass. On a
shell host the main session takes the browser measurements first and hands them to
`review-layout` as `context_files`.

A reviewer's `Parent follow-up:` lines and `follow_ups` are work handed back to you.
`review ledger build` turns each into an obligation `<reviewer>:fu<n>` that stays a
gap until a disposition closes it (`narrowed` needs a `remains` note).

Before dispatch, `keryx review context-collect` writes the pull request's
comments in full, its intent, its CI status and the backend pins it names into
the package, and `dispatch-check --pr-context` refuses a payload without them.
To see what a round missed against a report someone else wrote, run
`keryx review compare-reference --reference <report.md> --package <review-dir>`:
each item of that report comes back as role-not-run, role-ran-and-found-nothing,
seen-and-lost, or kept.

The shell shows the same record. `/reviews` opens a **Review depth** tab next to
the managed-review metrics: per pull request the mode, how many of the required
reviewers were dispatched, which were missing, which were excluded and why, and the
mutation totals with the number still pending. In the readline shell `/reviews`
prints the same block under the metrics.

## Narrow the scope before anyone reads it

```bash
keryx review scope --ref "$(git merge-base HEAD main)" --json > scope.json
```

Deterministic, no model call: lockfiles, generated and vendored paths, binaries,
whitespace-only and comment-only hunks are dropped, and what remains is bounded
to the changed hunks plus 20 lines of context. If the repository has a rule that
limits comments (in `CLAUDE.md`, `AGENTS.md` or `.metaproject/rules/**`), a
comment-only block that adds comments is **kept**, not dropped, because for that
repository a comment is something that can be wrong; the scope lists it under
"Kept past a drop rule" with the reason `kept:comment-rule`. Set `retainCommentBlocks`
to `false` to switch that off, or to a pattern to keep only matching comments. **Every drop is recorded with its
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

### The layers every reviewer reads, and the files the cap dropped

Before a round dispatches, the review refreshes the graph, the wiki and the memory for the PR head and writes `layers.json` into the package. **No model is called**, and `wiki enrich` — the only model step in the wiki — is never run automatically. The graph is built at the PR head in a fresh worktree, so its recorded commit equals the head; the wiki and the memory come from your working copy, and `layers.json` says how far that copy is from the head. Each reviewer payload carries a bounded `layers` block, and the package records per reviewer how many graph, wiki, memory and ctx calls it made (`unknown`, never zero, when it left no tool-call log).

The blast radius is capped at 40 files a pass. The files beyond the cap are not skipped silently: `keryx review chunks plan` splits them into chunks, `chunks estimate` states the cost before you spend it (the ceiling is 25 passes of 40 files, set by `reviewChunks.maxPasses` in `routing.config.json`), and the chunks run one at a time through `review-regression` on the middle tier. `keryx review coverage` counts what is covered, covered by a named omission, and uncovered. `keryx review complete` refuses while a file is uncovered and names the command that runs the missing chunks; the only way past is `--waive-coverage "<operator quote>"`, recorded with the time and the files not reviewed. What a chunk pass finds reaches the round: `chunks merge` prints the findings and how many `findings.json` does not hold, and `keryx review ingest --review-id <id>` records them as `review-regression/<chunk>` findings that the scope-B screen no longer deletes for being outside the set (a minor is still dropped by the severity floor). A major the pass did not enumerate carries a `class_scope` that says `NOT ENUMERATED`. If a pass finishes after the report was written, ingest again and rewrite the report; `keryx review complete` warns about, and records in `report.md`, any pass finding still out of `findings.json`, and does not refuse. See [`review layers`, `review chunks` and `review coverage`](../cli-reference.md#review-layers-review-chunks-and-review-coverage).

#### Child agents are counted per wave

One orchestrator turn may start at most 32 child agents, which a deep run with many waves used to hit: the 33rd reviewer was refused and the package stayed incomplete. The dispatcher now names the wave on `spawn_subagent` with `review_wave: { "package": "<package dir>", "pass": "<chunk id>" }` (`"pass": "round"` for the round's own reviewers), and each wave counts its own 32 children. One turn opens at most 25 waves, the same ceiling as the chunk plan, so the total stays bounded; the pool of 16 concurrent children is shared and unchanged.

The count is fail-closed. A wave is accepted only when the package is inside the project, has a `manifest.json`, and the pass is `round` or a chunk the package records (`chunks.json`, or a retry chunk in `chunk-state.json`). A wave that does not check out is ignored, not refused: the child counts against the turn's 32 exactly as a call without `review_wave` does, so inventing wave names buys nothing. A refusal says which cap was hit. For a full wave, finish it with `review chunks record` and dispatch the next one; for the turn, continue in a new turn.

## Answer the humans — once, at the end

```bash
keryx review comments collect --repo acme/app --pr 7 --self "$(gh api user --jq .login)" \
  --sha "$(git rev-parse HEAD)" --round 3 --out external-findings.json
keryx review comments reply --repo acme/app --pr 7 --outcomes outcomes.json \
  --review <review-id> --sha "$(gh pr view 7 --json headRefOid --jq .headRefOid)" --final --dry-run
```

Comments left on the pull request by other people — and by other bots — are
collected **every round** and answered **once**, after the final round. Replying
per round turns one thread into six and every reply states an intention rather
than an outcome. All three sources are read (inline comments, review submissions,
PR-level discussion), a bot reviewer is treated exactly like a human, and only
our own identity is filtered out — the collector refuses to run without knowing
it, because otherwise the reply pass answers itself.

`--sha` is required on **both** halves, and on `collect` it is what makes the
record datable: it is written as `collected_sha`, and the completion gate
compares it with the pull request's head before believing "nothing outstanding".
`rounds_collected` cannot do that job — it is a count, `--round` defaults to `1`,
and a file written before anyone commented reads exactly like one written after
the last round.

### The precondition this puts on `flow complete`

Dating the record means resolving the pull request's head, and that is done with
`gh pr view`. So **once a flow has a PR recorded, completing it needs a `gh` that
can authenticate** — `gh` on `PATH` and `gh auth status` exiting `0`. On a CI
runner or a machine that is logged out, the gate reports:

```text
✗ review (1 of 5 conditions failed — external-comments (unobserved): acme/app#7 has a
  comment record collected against a1b2c3d… (round 2), and this run could not resolve
  the pull request's own head to compare it with: the tracker could not be reached, so
  the pull request was never asked about — `gh` is not on `PATH`, or `gh auth status`
  exits non-zero. So the record is neither shown to be current nor shown to be stale —
  nobody looked. Install `gh` and run `gh auth login` …)
```

The condition distinguishes three states, and the message says which one you are
in, because the fix for each is different:

| What happened | Status | What to do |
|---|---|---|
| The head resolved and the collection is against it | `pass` | nothing |
| The head resolved and the collection is against another commit, or names none | `violated` | re-run `keryx review comments collect --sha <pr-head>` |
| The head could not be resolved at all | `unobserved` | fix the tracker — the message names how it failed |

The third one used to be reported as the second, so a logged-out `gh` read as
*your comment record is stale* and sent you to re-collect a record that was
already current.

**`--merged <sha>` does not lift it.** The merged commit stands in for the PR
head in the head-commit condition, because "was the reviewed tree the one that
merged" is a question the local object database answers on its own — see *What
`--merged <sha>` proves about the round*, below. It cannot stand in here:
"has anyone commented since the record was written" is a question about the pull
request, and a comment posted after the last round and before the merge is
invisible to every fact in the local repository. Substituting the merged commit
would not relax the check, it would answer a different question and call the
answer clean.

If an environment will never reach the tracker, the way past is
`completion.require_clean_round: false` in `.metaproject/tasks.config.json`,
which reports the whole review gate as `skipped` in the gate list. That is the
point of it: the waiver is on the record, rather than hidden inside a green tick.

Each reply is at most **two sentences and 600 characters** — `--max-sentences`
and `--max-chars`, both refusing a value below one — cut rather than warned
about, with the detail living in the flow package that the link points at. Both
bounds are load-bearing: one 4,000-character sentence is one sentence, and a
sentence budget alone posts it verbatim. Beyond `--max-replies` (default 30) one
summary comment stands for the backlog.

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

A row with no `reply_url` means **nobody answered that comment**, and all three
readers agree: the collector re-offers it, the completion gate counts it
unanswered, and the reply pass sends it. The pass used to skip on the row merely
existing, which is how a comment became simultaneously unanswerable and
unclearable — offered every round, posted never. A row reaching the pass with no
reply is resolved against the pull request first, so repairing it cannot answer
the reviewer twice. Beyond the reply cap one summary
comment stands for the backlog — which changes how those comments are answered,
never what was decided about them: each keeps the disposition the orchestrator
reached for it. Inventing `dismissed-deprioritised` there would be a dismissal on
the orchestrator's own authority, and a dismissal needs a human decision.

## What `--merged <sha>` proves about the round

`flow complete --merged <sha>` has no pull request to ask for a head, so the
head-commit condition compares the round's recorded commit with the merged one
instead. The question it is asking is **"is the content the reviewers read the
content that merged?"** — and there are two ways to answer it yes, both decided
locally, with no network and no `gh`:

| Route | What it proves | Merge strategy it covers |
|---|---|---|
| **Commit containment** — `git merge-base --is-ancestor` | the reviewed commit is reachable from the merge | `--no-ff`, fast-forward |
| **Tree equality** — `git rev-parse <sha>^{tree}` on both | the reviewed bytes *are* the merged bytes | **squash**, rebase |

Containment is tried first; tree equality only when it fails. **The passing
detail names which route was used and both SHAs**, so a green tick says what was
actually proved rather than merely that something was:

```text
round `round-1` ran against 77811f5…, which is NOT contained in the merged commit
c056793… — but both commits have the identical tree 188e5b2… (accepted by TREE
EQUALITY). That is what a clean squash or rebase of the reviewed branch produces,
and it is a stronger claim than ancestry: the content the reviewers read is
byte-for-byte the content that merged.
```

This is why a **squash merge completes**. It did not use to: the condition was
first an equality test and then a containment test, and a squash commit has no
ancestry relation to the branch commits at all, so containment is false for it by
construction. Tree equality is not a weaker fallback — ancestry proves a commit is
*reachable*, tree equality proves the *bytes are the same*.

### When it fails, and which failure it is

Four outcomes, and the last two are deliberately not the same status:

| What happened | Status | What to do |
|---|---|---|
| The round's commit is contained in the merge | `pass` | nothing |
| It is not contained, and the two trees are identical | `pass` | nothing — this is a clean squash or rebase |
| It is not contained, and the two trees **differ** | `violated` | ingest a round against the merged commit: `keryx review ingest … --head <merged-sha>` |
| A tree could not be **read** at all | `unobserved` | fetch the missing object, or ingest a round against the merged commit |

**A moved base legitimately fails.** If something else landed on `main` between
the round and the squash, the squash carries it and the trees differ. That is
`violated`, and it is not rescued by a three-way comparison, because it is a true
statement about the review: the reviewers did not read what merged. The message
prints both tree ids so the claim is checkable rather than asserted.

**A tree that could not be read is never a pass, and never a `violated` either.**
A commit missing from this clone, a shallow clone, a directory that is not a
repository, no `git` on `PATH` — none of those is evidence that the trees differ,
and none of them is evidence that they match. The condition reports `unobserved`,
quotes git's own first line of complaint, and names which of the two objects it
could not read:

```text
head-commit (unobserved): round `round-1` ran against 77811f5… and the completion
names merged commit 1234567… . 77811f5… is not contained in it, and the trees could
not be compared: the merged commit 1234567… — `git rev-parse 1234567…^{tree}` exited
128: fatal: ambiguous argument … unknown revision or path not in the working tree.
So nothing here shows either that the reviewed content is what merged or that it is
not — the check could not run, which is not the same as running and failing.
```

Both `violated` and `unobserved` fail the gate. They are separate because the
fixes are different, and because a gate that passed when its check could not run
is the exact failure this gate exists to end.

## Check the bounds before you dispatch

```bash
keryx review budget --spent 2.10 --reviewers review-logic,review-style,review-security-code --outstanding 1
```

Three caps, all with defaults in code so a caller that says nothing still gets a
bound: **10 findings per reviewer** (blockers exempt), a **3.00 USD** spend
ceiling, and a wave of at most **10** reviewers (`--parallel <n>` replaces the 10
without `--full`; with `--full` it can only lower it). This command exits non-zero when
the spend ceiling is reached, which is the point at which stopping is still
possible — an ingest can only record that a round already went over.

`--outstanding` is the number of subagents the main session still has running. It
matters because `review-orchestrator` runs inline in that session next to whatever
else it has dispatched, and keryx cannot see those subagents: without a declared
count the cap bounds this dispatch alone, and the record says so rather than
implying it covered more.

**Every cap records what it dropped** — the truncated finding ids, the queued
reviewers, the stop — in the package's `scope.md` under `## Caps`. A cap that
did not run prints `not recorded`, never `0`.

### Know the price before you spend it

`keryx review scope --reviewers a,b,c` ends with an estimate of the round, in
the one moment the number can still change what you do:

```text
### Estimated cost

- ≈ 26,655 prompt tokens of scoped diff per reviewer (characters ÷ 4 — an estimate, not a measurement)
- ≈ 106,620 across 3 reviewers, before their own prompts, tools and any verifier wave
```

It multiplies by the fan-out because every reviewer receives the scoped diff.
Afterwards, `review ingest --tokens-in <n> --tokens-out <n>` records what was
actually used, and `review complete` divides it by what survived:

```text
tokens: 552,502
retained findings: 6
per retained finding: 92,084 tokens
```

A round nobody reported a cost for reads `cost: not recorded`, and the command
says out loud that this is not zero. The point is not accounting — it is that a
fan-out of reviewers cannot be argued for or against while its price is a
feeling.

## Stop a fix loop that is not converging

```bash
keryx review loop --flow 203 --task T4
```

The round bound is five attempts. But a bound that fires on count alone lets an
agent emit the identical failing output again and again and spend the whole
budget before anything notices. This escalates — exit 1 — when the same finding recurs
in two rounds or two consecutive rounds produce identical output, **regardless of
the remaining budget**, which it deliberately never reads.

It reads the review packages on disk and `tasks[].attempts.count` from
`flow.json`, not the session's memory: a resumed orchestrator's context starts at
zero while the real count does not.

## Tell reviewers to quote, not to count

A finding does not carry a line number. It carries `quote` — the code it is
about, copied out of `file` — and `review ingest` finds that quote at the commit
the round records and derives the line from where it matched.

The reason is what it replaces. Nothing used to compare a reported line against
anything, so a number that had drifted rode into `findings.json`, into the
report, and into the disposition someone recorded against it. An audit of every
review package in this repository found **108 of 582 anchored findings naming a
file that is absent at their own package's recorded head** — the anchor and the
commit were a pair, and nothing checked them together.

What a reviewer is asked for is also easier to get right: a model is poor at
counting lines and good at repeating text it has just read.

Three outcomes, all recorded in `locator`, none of them a guess:

- **`derived`** — the quote was found. `line` is where it starts, and
  `reported_line` keeps whatever the reviewer claimed, so drift stays
  measurable rather than merely corrected.
- **`unlocatable`** — it was not, and `line` is `null` rather than a number
  nobody checked. The reason distinguishes *the file is not there at that
  commit*, *the quote does not appear*, and *it appears more than once*.
- **absent** — the finding quoted nothing, because it is about the round rather
  than a site. Its line is reported-only and says so by carrying no locator.

A quote that matches twice is `unlocatable`, never the first hit. A wrong anchor
is acted on; an admitted one is investigated.

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

## Ask whether the finding is a defect at all

A finding can reproduce and still be wrong: the code may carry an explicit
override, an exemption note or a sibling doing the same thing, and accepted
platform practice may back it (media controls and timelines do not mirror in
right-to-left layouts). The verifier cannot see that, because it checks facts.
`review-premise` runs after it, on a clean context, and answers `upheld`,
`downgraded`, `challenged` or `owner-decision` for each finding. Like the
verifier it **can only hold or lower**, and it never dismisses anything.

```bash
keryx review ingest --report round7.md --ref round7 \
  --verifications verifier-result.json \
  --premises premise-result.json
```

`--premises` takes the judge's JSON, or a reply that holds it in one
`` ```json keryx:premises `` block. A `challenged` or `owner-decision` finding is
**held**: it is not an open blocker or major, it is not handed to a fixer, the
verdict lists it as "awaiting operator", and readiness and the flow review gate
fail until you answer. You decide it with the `review_decide_premise` card. In keryx shell the agent calls the card and you answer it in the shell or, with remote control on, in the Telegram topic (an allowed Telegram user only, for that card, once, within one hour; the record keeps `confirmedVia: remote-card` with `pressedBy` and `pressedAt`). If the topic cannot be reached the card says the Telegram mirror was not delivered and you answer it in the shell. Outside keryx shell, at a terminal:

```bash
keryx review decide-premise --package .metaproject/reviews/round7 \
  --finding LY-003 --answer dismiss --reason "platforms do not mirror media controls"
```

`--answer uphold` returns the finding to kept at its original severity;
`--answer dismiss` records it `dismissed-incorrect` with your reason as the
evidence. Without `--answered-by` the command asks at the
terminal and is refused without one, so the agent never sends you there from keryx shell; it calls the card.

**Without a card: a host question.** In Claude Code, Codex or another host there is no card. The agent asks you the question with the host's own question tool (or a Telegram poll through Helyx) and offers `uphold` or `dismiss`, naming the finding id in the question; it then records what you chose, with no terminal:

```bash
keryx review decide-premise --package .metaproject/reviews/round7 \
  --finding LY-003 --answer dismiss --reason "platforms do not mirror media controls" \
  --answered-by helyx-poll:poll-223/msg-214878 \
  --answer-text "dismiss" --question-text "LY-003: dismiss or uphold?"
```

The record carries `confirmedVia: "host-question"`, the question and your answer verbatim, and a `keryx decisions` entry is written. keryx does not verify the answer, so it is a weaker record than a card press: it proves the agent reports that you answered, not that it reported truthfully (see [limitations](../limitations.md#a-host-question-is-a-weaker-proof-than-a-card)). The same holds for `confirm-plan` (the question carries the plan's dispatch count and minutes, or the verb refuses it as stale), `waive-mutation` and `override-reviewers`. A host question is refused in an unattended run and under `KERYX_TOOL_CALL=1`, and for a decline or, on `decide-premise`, words that name the other choice. `review complete` and its waivers still need you at a card or a terminal.

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
filter_stats: total=5 prefilter=2 low_confidence=not-measured refuted=1 scope_b=not-measured findings_cap=1 merged_duplicates=0 dismissed_by_round=not-measured retained=3
  low_confidence: not measured — this pipeline has no confidence threshold …
  scope_b: not measured — no blast-radius record reached this ingest …
```

`filter_stats` is what the round dropped, read back out of `manifest.json` — the
same numbers `scope.md` shows a person, in a form something else can check.
`not-measured` is not `0`: it means that stage did not run, and the reason is
printed underneath. `status` exits **1** when the numbers do not add up (`total`
minus the measured finding-stage drops and `merged_duplicates` must equal
`retained`) or when a count is absent with no reason recorded, so a stage that
starts dropping findings without counting them is caught on the next status call
rather than a release later.

`dropped_prefilter` counts diff material — whole files and change blocks removed
before anyone read them — so it is deliberately not summed with the rest.

What a round leaves behind that no finding count shows is printed under the same
header: `Not run: N candidates`, `held: F-003 stays minor (mutant m2)`, and
`follow-up open: <reviewer>:fu1 …`. `keryx review report-parity <review>` prints the
same as Markdown to paste into `report.md`; `/review parity` in the shell and the
sidebar show it too. Between waves, `keryx review next` journals each call in
`<package>/tool-calls/wave-events.jsonl`, and a pause with open slices under an
authorized plan adds `Gaps without a launch after the plan was authorized: N, longest
M min (waits for operator cards are possible)` to the same place; it is a number to
read, never a warning. `review complete` warns, and does not refuse, when the report
names none of a kind of leftover. A package built before this existed shows no such
lines, and a package whose ledger predates `review-pr-contract` is not refused for
lacking it; `review complete` warns `review-pr-contract not run (package predates
the role)`.

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

### Completed means ready — the checklist

A package cannot be marked `completed` while a file nobody read, a reviewer
that never reported, or a verifier that skipped findings is still in it. Ten
items are checked, offline except the ninth, and `keryx review complete` refuses
while any of them fails:

```bash
keryx review readiness <review-id-or-path>   # NOT READY lists each failing item and its repair
```

| # | Item | Repair |
|---|------|--------|
| 1 | every changed file is covered by a wave or a recorded waiver | run the missing wave |
| 2 | no file the blast radius cut is left unreviewed | `keryx review chunks plan`, `estimate`, `next`/`record`, `merge` |
| 3 | every planned reviewer was dispatched and ingested | dispatch it, save the reply, `ledger build` |
| 4 | the verifier checked every finding it should | run the verifier, or let the report state the count it did not |
| 5 | the ledger is READY | close each obligation with a disposition |
| 6 | coverage.md does not list a reviewer as `run` that did not finish | re-run `keryx review ingest` |
| 7 | the report's head is the PR head | `--head <sha>` |
| 8 | pending mutation candidates and parity warnings are named | add them to the report |
| 9 | the changed-file count equals the PR's own file list | recount from the PR's files |

When the blast radius is cut, `keryx review blast-radius --package <ref>` writes
the chunk plan next to it, so the waves are one command away. An unattended run
(`keryx review run --autonomous`) runs every wave without asking, up to the
25-pass ceiling; an interactive run asks you once before the waves start.

Only you can waive an item, with your own words recorded beside the time. In keryx shell the agent calls the card and you answer it in the shell or, with remote control on, in the Telegram topic (an allowed Telegram user only, for that card, once, within one hour; the record keeps `confirmedVia: remote-card` with `pressedBy` and `pressedAt`). If the topic cannot be reached the card says the Telegram mirror was not delivered and you answer it in the shell. The terminal form is the fallback:

```bash
keryx review complete <ref> --waive blast-radius "the cut files are generated code"
```

Publishing is held by the same checklist. `keryx review publish` refuses a
package that is not READY; `keryx review publish --partial` posts it with a
"Partial review" header and never approves. The same verdict shows in
`keryx review status`, in the TUI Review depth tab and sidebar, and as
`/review readiness`.

**Named limit.** The refusal lives in keryx and in the keryx shell guard. A
publisher outside them (CI, another agent, a script file calling `gh`
directly) is not stopped by it.

### A review starts with clean context

A review has to be reproducible from its package: the same inputs give the same
context, whoever runs it and whatever that agent remembers from earlier work. So
the orchestrator takes context only from its own stages (scope, the context pack,
one memory search, the layers), and a reviewer takes the reviewer payload only.
The agent's session memory, its auto-memory index (`MEMORY.md`), remembered
feedback and the earlier conversation are not inputs. When the orchestrator has
a question, it looks in its own instructions; if the answer is not there it asks
you (once, interactively), or ends an unattended run with
`STATUS: BLOCKED question — <the question>`. It never answers from memory or a
guess.

`keryx review start --memory-query "<query>"` writes a `cleanContext` block into
the manifest: the start time and the query of the memory stage. keryx writes the
orchestrator log, `<package>/tool-calls/orchestrator.jsonl`, itself: the agent
does not append to it and must not edit it. `keryx review start` and
`keryx review attach` mark the package as the active one (a small pointer in the
project's data directory, `.metaproject/data/review-active/`, which is not
committed), and from then on every `keryx memory` command, every MCP memory tool
(`memory_search`, `memory_handoff`, `memory_propose`) and every memory call the
keryx agent makes adds one line: the tool, its query, the time, the source (`cli`,
`mcp` or `shell`) and who called. closing the package (`keryx review complete`) removes the pointer, and a
pointer to a package that is missing or closed is ignored, so a finished review is
never written to. The tenth readiness item, `memory-outside-stage`, reads that log. A memory call
with another query, without `--status accepted`, any other memory command, or a
stage call stamped before the round started, fails the item; the same query
repeated does not. It blocks `review complete` and `review publish` like the
other nine, and only you lift it, through the `review_waive_readiness` card (see above) or, as the fallback, in a terminal:

```bash
keryx review complete <ref> --waive memory-outside-stage "<your own words>"
```

Three paths bring earlier work into a review on purpose, and they are kept:

1. `prior_findings` from an earlier round of the same package.
2. Review-notes and skill learning that earlier reviews wrote, which reach the
   next review only through the memory stage as accepted memory.
3. A reviewer's own `memory_search`, a lookup in the project's recorded lessons.
   The item never judges a reviewer's log.

Who called is one of three things. In a `keryx shell` session the parent's own
calls are `orchestrator`, and a call by a `spawn_subagent` child is recorded under
the child's reviewer id (keryx puts `KERYX_REVIEW_CALLER` into the child's command
environment only), so a reviewer's own lookup is never counted against the
orchestrator. A call that reaches keryx from a host that names no caller, such as
`keryx memory search` typed in another terminal or an MCP memory tool called by
Claude Code or Codex directly, is `unattributed`. It does not block: it adds
`warning: N unattributed memory call(s)` to the item's detail, and `review
readiness`, `review status`, the Review depth tab and the sidebar show
`orchestrator log: recorded, N unattributed`. A log that holds only its first line
passes with "no memory call recorded"; no file at all passes with "no orchestrator
tool log", as before, and those surfaces say `orchestrator log: none`.

**Named limits.** keryx cannot prevent an agent runtime that loads its memory
before the skill starts. The guarantee is instruction plus detection, not
isolation, and reads of the agent's personal memory outside `keryx memory` are not
visible to the log. Four things the automatic log does not do:

- Only calls through keryx are visible. A memory read through a tool keryx does not
  wrap is not in the log.
- Unmarked calls outside the keryx shell are `unattributed`: keryx records them but
  cannot say whether the orchestrator or a reviewer made them.
- The log is not a sandbox. It records the calls; it does not stop them.
- The log is a plain editable file. Anyone with write access to the package can
  change it, so it is evidence of what keryx saw, not proof against tampering.

### Five gates that keep a report honest

- **The PR moved.** `keryx review complete` on a PR-bound package asks the tracker for the PR. When it is merged or its head is no longer the reviewed SHA, completion is refused until the first line of `report.md` names the reviewed SHA and says so ("Reviewed `1a2b3c4` — the PR has since merged."). A package is PR-bound when it targets a pull request or when its `--ref` is a pull request URL, even if it was ingested with `--target report`; a package with no PR binding is not asked; a tracker that cannot be reached is a warning, not a refusal.
- **Evidence level.** A report carries one line, `Evidence level: static only — did not run: <what>` or `Evidence level: ran — <what ran>`, and `complete` refuses a report without it. A package ingested before the field existed completes with a warning.
- **Citations.** When a dismissal's rebuttal cites a rule or document, `review ingest` looks the path up in the tree (at the reviewed commit and as it stands) and, if it is not there, adds a `citation not found: <path>` line to the finding's evidence. The finding is never deleted.
- **Narrowed.** A research obligation may close as `narrowed` with a `remains` text ("what is still open"). It counts as closed only with that text, and the report keeps it under "Refuted and narrowed" with its evidence.
- **Locators at the SHA.** `review ingest` reads each finding's quote at its `path` at the reviewed SHA, not from the working tree. A quote absent from that file, or in it more than once, does not refuse the round (flow 460): the finding is kept with no line, never relocated by similarity, flagged `quote_unlocated` (with the candidate lines when ambiguous), listed in scope.md, and readiness item `quotes-located` fails until it has a disposition or the operator waives it. The ingest still refuses, naming the finding, a quote it could not check at all: the commit is not in the checkout, no file is named, or a size bound stopped the match. The report links the blob at that SHA.

### The one dismissal that teaches something

`dismissed-incorrect` — and only that state — writes a note into
`.metaproject/memory/review-notes/`, naming the finding, the reviewer, why it was
dismissed, and the round and commit it came from:

```console
$ keryx review complete <path> --finding F-002 --disposition dismissed-incorrect \
    --evidence "human: alice ran the writer under umask 002; the mode is 0700"
review-note: 2026-08-03-round6#F-002 -> .metaproject/memory/review-notes/2026-08-03-round6__F-002.md (attested by human)
```

The other three dismissals write nothing, deliberately. They say the finding was
*correct* and not worth doing now; feeding them into a learning signal teaches
the reviewer to stop raising true findings, and in the resulting `SKILL.md` that
is indistinguishable from having learned something real.

A note needs somebody behind it. The evidence must name a human decision
(`human: <who>`, `decided-by: <who>`) or the finding must carry an independent
verifier's `refuted` verdict with a method and evidence — which is what an
applied `--verification-mode filter` verdict already produces at ingest. Without
either, the dismissal is still recorded in `findings.json` and no note is
written:

```console
review-note NOT written for 2026-08-03-round6#F-009: no recorded human decision and no independent verifier `refuted` verdict …
```

That refusal is the point. An orchestrator that could file its own finding as its
own error, teach a skill from it and move on would be grading its own work with
nobody in the room.

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

### And the comments other people left

The commands above learn from *your own* review reports. The comments humans left
on the pull request are a second source, and the project decides whose count:

```bash
keryx review learn --pr <n>
keryx skills learn apply .metaproject/data/gdskills/proposals/<id>.json
```

`learn` reads the record `comments collect` already wrote — no second fetch — and
keeps only the authors named in `.metaproject/review-learning.config.json`. A
project without that file does not learn, and that is fine. Keryx ships no
reviewer and no checklist: which reviewers teach a project, and what they teach,
stays in that project.

Seeding a local skill from conventions you already keep elsewhere is documented
in [CLI reference › review learn](../cli-reference.md) — the content comes from
your own copy, because keryx holds none.

## Running it from the keryx shell

A review run in the shell is finished when `keryx review complete` has closed the package, not when the
model stops writing. Once the session has loaded `review-orchestrator` or run a `keryx review` command,
the shell does not accept a text-only finish while no package is closed: it names what is still missing
(no package opened yet, missing artifacts, research or dispatch errors) and the next step, prints a
`[review-gate]` line in the pane, and continues the turn. It gives up after 20 continues, or after three
in a row that added no new artifact, and then reports the state instead of looping.

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
filter_stats: total=5 prefilter=2 low_confidence=not-measured refuted=1 scope_b=not-measured findings_cap=1 merged_duplicates=0 dismissed_by_round=not-measured retained=3
  low_confidence: not measured — this pipeline has no confidence threshold …
  scope_b: not measured — no blast-radius record reached this ingest …
```

`filter_stats` is what the round dropped, read back out of `manifest.json` — the
same numbers `scope.md` shows a person, in a form something else can check.
`not-measured` is not `0`: it means that stage did not run, and the reason is
printed underneath. `status` exits **1** when the numbers do not add up (`total`
minus the measured finding-stage drops and `merged_duplicates` must equal
`retained`) or when a count is absent with no reason recorded, so a stage that
starts dropping findings without counting them is caught on the next status call
rather than a release later.

`dropped_prefilter` counts diff material — whole files and change blocks removed
before anyone read them — so it is deliberately not summed with the rest.

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

### The one dismissal that teaches something

`dismissed-incorrect` — and only that state — writes a note into
`.metaproject/memory/review-notes/`, naming the finding, the reviewer, why it was
dismissed, and the round and commit it came from:

```console
$ keryx review complete <path> --finding F-002 --disposition dismissed-incorrect \
    --evidence "human: alice ran the writer under umask 002; the mode is 0700"
review-note: 2026-08-03-round6#F-002 -> .metaproject/memory/review-notes/2026-08-03-round6__F-002.md (attested by human)
```

The other three dismissals write nothing, deliberately. They say the finding was
*correct* and not worth doing now; feeding them into a learning signal teaches
the reviewer to stop raising true findings, and in the resulting `SKILL.md` that
is indistinguishable from having learned something real.

A note needs somebody behind it. The evidence must name a human decision
(`human: <who>`, `decided-by: <who>`) or the finding must carry an independent
verifier's `refuted` verdict with a method and evidence — which is what an
applied `--verification-mode filter` verdict already produces at ingest. Without
either, the dismissal is still recorded in `findings.json` and no note is
written:

```console
review-note NOT written for 2026-08-03-round6#F-009: no recorded human decision and no independent verifier `refuted` verdict …
```

That refusal is the point. An orchestrator that could file its own finding as its
own error, teach a skill from it and move on would be grading its own work with
nobody in the room.

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

### And the comments other people left

The commands above learn from *your own* review reports. The comments humans left
on the pull request are a second source, and the project decides whose count:

```bash
keryx review learn --pr <n>
keryx skills learn apply .metaproject/data/gdskills/proposals/<id>.json
```

`learn` reads the record `comments collect` already wrote — no second fetch — and
keeps only the authors named in `.metaproject/review-learning.config.json`. A
project without that file does not learn, and that is fine. Keryx ships no
reviewer and no checklist: which reviewers teach a project, and what they teach,
stays in that project.

Seeding a local skill from conventions you already keep elsewhere is documented
in [CLI reference › review learn](../cli-reference.md) — the content comes from
your own copy, because keryx holds none.

## Running it from the keryx shell

A review run in the shell is finished when `keryx review complete` accepts the package, not when the
model stops writing. While a review package is open and `review complete` would still refuse, the
shell does not accept a text-only finish: it names what is still missing, prints a `[review-gate]`
line in the pane, and continues the turn. It gives up after 20 continues, or after two in a row that
added no new artifact, and then reports the state instead of looping.

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
