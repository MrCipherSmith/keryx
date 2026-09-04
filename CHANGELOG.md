# Changelog

All notable changes to `keryx` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/); versions follow semver.

## [0.2.77] — 2026-09-04

The wiki stops going quietly out of date. Measured on this repository before
anything was built: 28 of 42 component pages had drifted, 530 commits in
total, and all 42 had last been touched in a single month — generated once,
never maintained, and nothing anywhere reported it. The cause was structural:
the wiki and the code graph were not connected, so *which pages does this
change affect* had no answer, and every mechanism that would need one had
nothing to stand on.

Four of the five designed phases shipped. The fifth is deliberately absent,
and that is the release's other half: over a 189-file range the drift was
100% machine-repairable and 0% prose, so the only phase that would spend
model tokens had nothing to work on. It stays specified and unbuilt until a
report says otherwise.

### Added

- **`keryx wiki freshness`** — a read-only, categorised backlog of the pages a
  change puts in doubt, with a reason chain on every entry and sorted by how
  far behind each page is. Exits 0 whatever it finds: a blocking freshness
  check invites updating a page so CI passes, which manufactures filler faster
  than drift manufactures staleness.
- **`keryx wiki refresh`** — regenerates the machine-owned
  `## Reference (from code graph)` block, including on `Status: accepted`
  pages, without touching a byte of human prose and without calling a model.
  A page already current is not rewritten at all; a hand-edited block is
  refused rather than overwritten.
- **`keryx wiki verify`** — records provenance. `--page` states that a page was
  reviewed; `--baseline` sets a measurement starting line and says in its own
  output that it is not a claim the pages were read. With neither it refuses,
  because stamping a corpus in one keystroke would assert reviews that did not
  happen.
- **`keryx wiki migrate-markers`** — one-off, idempotent, authors no content.
- **A `describes` layer in the code graph**, joining wiki pages to the files
  they document, traversable in both directions. It lives in its own storage
  files: five call sites treat every non-`asset` node as a source file, so a
  page node in `nodes.jsonl` would have corrupted the module set that orphan
  detection depends on.
- **Page provenance** — `VerifiedAt` (a git revision) and `VerifiedScope` (a
  content hash) live inside the page, so versioning does not depend on whether
  a project tracks `.metaproject/` or has git at all.
- **`wiki_freshness` over MCP**, read-only, and a `gdwiki` skill route telling
  a reader to check freshness *before* treating a page as context. The output
  leads with `limitations` unconditionally: an empty finding list with a
  non-empty limitations list means the check could not run, not that the wiki
  is fresh.
- **A freshness figure in `keryx health run`**, beside lint, types and tests.
  Health reads the last report and never recomputes. With no report the metric
  is absent *with a reason* — never a number, and never a flattering default.
  It cannot move the health gate, and that is enforced by the compiler rather
  than by a runtime check that could pass vacuously.
- **A CI workflow**: `wiki validate` gates on structural defects, `wiki
  freshness` reports and never fails the build.
- **`Describes: none  # why`** — a page can declare that it is not scoped to
  code (a map rendered from the graph, an ADR). The report counts that
  separately from a gap: "nobody has done this yet" and "this page is not
  about code" are different facts, and one of them is not work.

### Fixed

- **Forty-eight test failures that only happened on macOS.** `mkdtemp` returns
  `/var/folders/...` while `process.cwd()` after `chdir` returns the resolved
  `/private/var/folders/...`, so anything keyed on the absolute project path
  wrote to one directory and read from another. Linux CI never saw it. The
  suite had been red locally and green in CI — the worst shape a suite can
  have, because a real regression hides in a red run everyone has learned to
  scroll past.
- **Two more of those** bound to `0177.0.0.1`, octal notation macOS refuses
  outright. Replaced with a form that preserves the test's intent exactly —
  still classified non-loopback, still resolved to loopback by the kernel.
- **A freshness report that asserted work already done.** Propagation knew
  nothing about when a page was verified, so pages stamped at the range's own
  end came back `must-refresh` with zero commits behind. Provenance now
  outranks propagation over a page's own scope.
- **Five tool descriptions** that stated the opposite of what their code does.

### Changed

- The `unresolved-edges-present` limitation now carries its magnitude. "Coverage
  is partial" with no scale invites ignoring it forever or treating a rounding
  error as a blocker.

### Documentation

- **[Keep the wiki current](https://mrciphersmith.github.io/keryx/guides/keep-the-wiki-current/)**
  — how the machinery works, how to read the report, and what it deliberately
  does not do.
- Three status lines corrected against the code: `RP-13` was documented as
  planned while both halves were shipped and wired, and understating a
  delivered capability is the mirror image of overstating one.

## [0.2.76] — 2026-09-03

Six commits since 0.2.75, and four of them are about one object: the ctx routing
guard. It refused the pipelines the routing rule itself demands, it could be
wedged by a stdin that never closed, it honoured its own escape marker inside
quotes, and it never watched the search tool a runtime provides natively. That is
the class the last three releases have circled — a mechanism asserting a
compliance it never observed — arriving this time in the thing that does the
enforcing.

### Added

- **Foreground operations in the TUI can be cancelled.** A single owner holds the
  one operation that may keep the interactive shell busy, with identity-safe
  tokens so an operation that settles late cannot clear the one that replaced it.
  Forcing a queued item interrupts the running main turn instead of waiting it
  out, and the cancellation is cooperative: the forced item does not start until
  the interrupted operation's finalizer has settled its own UI state. Destroying
  the renderer cancels and disposes rather than leaving the operation running.
  Wiki enrichment moved onto the same cancellation path instead of keeping a
  second one.

### Fixed

- **The ctx guard refused pipe filters.** Every stage of a pipeline was
  classified as though it named a file, so `npm test | grep -E 'Tests'`,
  `bun test 2>&1 | tail -5` and even `keryx ctx rg 'foo' | grep -c 'bar'` were
  blocked — routing a search exactly as the rule demands and then counting the
  results was refused. That is the failure mode that gets a hook uninstalled.
  Position was the wrong discriminator; a stage is now judged by whether it names
  a file. Three siblings found by a later round are closed with it: `sed`/`awk`
  take a script as their first operand, so an allowance given only to search-like
  commands moved the false-block class one command over; `-e`/`-f`/`--regexp`/
  `--file` supply the pattern, so the allowance absorbed the file instead and
  `grep -e foo file.ts` passed where it used to block; and a short-option regex
  could not match a long option, so `grep --recursive foo` walked the tree.

- **The guard never watched a runtime's own search tool.** The matcher was `Bash`
  alone and everything else failed open, so an agent using its harness's native
  search went unguarded while the Bash guard reported a clean run. Runtimes now
  declare `nativeSearchTools` and the matcher is derived from that declaration.
  `validate` had reported five under-covering shapes as clean, and its drift
  branch could not fire in production at all, because the installer merged before
  validating.

- **The escape marker was honoured inside quotes.** `grep -rn '#keryx:raw' src/`
  and `git log --grep='# keryx:raw'` both passed, so searching the guard's own
  source for its marker disabled the guard. It is now recognised only where a
  shell would start a comment. The asymmetry is what gave it away: the same file
  already knew that a `|` inside quotes is not a pipe.

- **`ctx hook` could be wedged by a stdin that never closes.** Measured still
  running at 14s, and once past 120s, where the equivalent read in `keryx orient`
  exited in 1202ms. For a PreToolUse gate that is worse than allowing — it wedges
  the tool call instead of failing open, the opposite of what its own header
  promises. `readStdinBounded` now lives in `src/lib` and both entry points use
  it. Cancelling the reader is load-bearing and not obvious: racing a timer
  resolves the race while the abandoned read keeps its own handle on the event
  loop, so the process writes its output and still never exits.

- **Guard ownership was decided in two places, and one of them was wrong.** A
  second hand-rolled walker still matched on `command` alone — exactly what the
  comment on the shared walker had predicted: "when a fourth settings shape
  arrives, one copy gets updated and the other keeps reporting the install
  clean". The fourth shape was already in the file. Every `validate` now routes
  through one walker, and flat-versus-nested is a per-runtime fact rather than
  either counting for everyone, which had let a flat-shaped group validate clean
  for a runtime that executes only nested ones.

- **A specialist skill claimed every review request in every language.**
  `review-frontend` carries the trigger "ui review"; the router drops tokens
  under three characters, reducing it to `["review"]`, and an all-words match
  over a one-element list matches any query containing "review". The specialist
  hijacked every review request, inverting `review-orchestrator`'s own contract.
  A trigger's dropped words are now matched too, against the query's raw words,
  which is where a short word like "ui", "db" or "pr" still exists.

- **The Context Pack described rules it had no carrier for.**
  `review-orchestrator` told reviewers to read `review_context.pr.body` and to
  record producers in `review_context.cross_repo`; `pr` was a bare object with no
  properties, and `cross_repo` was not declared at all, surviving on
  `additionalProperties: true`. Neither rule could be violated, which is not the
  same as neither being broken — a body never fetched and a body that was empty
  were one value. Both are typed now, `cross_repo` can describe a producer that
  has not merged, and findings carry `repo` in both schemas, since the registered
  contract is `additionalProperties: false` and would have rejected a finding
  that only the reviewer-side schema knew could carry one.

### Changed

- **The router has a baseline that records what it gets wrong.** Three earlier
  attempts each introduced regressions the round before them had introduced,
  because the corpus asserted only cases expected to work: every round could see
  its improvements and none could see its losses. `routing-baseline.ts` is
  written first — 25 entries, 10 marked `wrong` — and was green against the
  untouched scorer before a line of the scorer changed, so a scorer change either
  leaves that file alone or produces a diff someone has to justify. The result is
  10 of 10 wrong entries moved with zero `ok` entries lost. The first
  hand-written draft disagreed with reality in 10 of its 25 rows; it is generated
  by measurement now.

  The synonym table is a closed contract in the same spirit: each row states what
  a phrase must produce *and* must not, and writing that down immediately exposed
  three missing prefixed verb forms.

- **Ceiling, stated rather than papered over.** The guard's block decision still
  requires the first token to be in a fixed name list, so `sh -c`, `$(…)`, `eval`
  and `xargs` pass unclassified. This is a better nudge, not a boundary. The next
  step is not a larger parser but teaching the routing audit to distinguish
  classified-and-allowed from could-not-classify, so `ctx_used` stops asserting a
  compliance it never observed.

## [0.2.75] — 2026-09-01

A security patch. A full review of 0.2.74 — six reviewers over the release diff,
plus a mutation pass over every gate it added — found that **0.2.74 shipped two
security controls that did not control anything**, both in the same commit, the
one titled "remediate validated full-project review findings".

**Upgrade if you are on 0.2.74**, particularly if you use the SAC workspace
proposal flow or persist agent sessions to disk.

### Fixed

- **The security acknowledgement never happened.** `consumeConfirmToken` refuses
  a `needs-approval` proposal unless the confirm token records that a human
  acknowledged the security findings — and the only production minter passed
  that literal unconditionally, on every invocation. The gate could not fire,
  while the error text behind it promised "explicit human acknowledgement of the
  proposal security findings". A proposal whose evidence tripped the scanner was
  accepted through the ordinary two-step flow with the reviewer never shown, and
  never asked about, the finding.

  Before 0.2.74 the same call passed no flag at all, so a `needs-approval`
  proposal could not be accepted by any route — a dead end, which is why the
  literal was added. 0.2.74 replaced a visible refusal with a silent bypass, the
  worse of the two. `keryx workspace confirm-review` now reads the gate, prints
  what the scan found and in which evidence, and requires an explicit
  `--acknowledge-security`; a clean proposal claims no acknowledgement, and a
  proposal that cannot be read is refused rather than assumed to have passed.

- **Session-history redaction covered message content but not tool-call
  arguments.** `redactHistory` rewrote `content` and let the object spread carry
  `toolCalls` through untouched, while the writer serialises them verbatim into
  `context.jsonl`, `archive.jsonl` and the legacy `transcript.jsonl`. A
  credential the model read from one tool result and passed into the next call's
  arguments was written to disk in the clear, in three files — through the
  function whose own comment says a command that reads a credential must not leak
  the raw value.

- **A validation keyword declared but ignored, for the third time.** A contract
  registered in 0.2.74 declares `maxItems: 0` on the list of comments excluded by
  the prompt-injection screen when that screen never ran — the machine form of
  "you may not claim it excluded anything". The validator had no `maxItems`
  branch, so a record asserting both validated clean. `minItems` and `maximum`
  were the first two instances, each repaired by hand.

  Fixed as a class instead: a guard now refuses any shipped schema that declares
  a keyword the validator ignores, deriving the implemented set from the
  validator's own source rather than a hand-maintained list. It found two more on
  its first run — `exclusiveMinimum` on a dispatch budget (zero and negative
  validated clean) and `not`, the only way a schema expresses a prohibition,
  which was decorative: the branch accepted exactly what it forbade.

- **The routable-target guard sat on one write path of two.** Added in 0.2.74
  after two prose-target skills reached `main`, and wired into the automatic
  wrap-up path only. `keryx skills create` — the path agents are instructed to
  use — never called it, so the entry point most likely to be handed a sentence
  was the unguarded one.

- **`keryx ctx diff` reported "no risky files" for a file list it never had.**
  For an output shape carrying a file count but no per-file rows (`--shortstat`),
  the risk section printed `- none`, conflating "examined, nothing risky" with
  "files changed, none examined". The same false-clean class 0.2.74 fixed one
  section higher up.

- **A regex escape that escaped nothing.** The character class closed at its
  first `]`, so the expression matched essentially nothing. Latent — all current
  labels are metacharacter-free — but the next label added is the one that breaks
  it, silently.

### Changed

- **Four gates the release added had no test that noticed their removal**, and
  deleting both ledger-truncation checks made the suite **hang** rather than
  fail — a timeout reads as infrastructure trouble, not a defect. The four are
  now pinned, and the digest read loop is bounded by a computed chunk count so
  the same double removal can only produce a wrong digest, never a hang.

  Two truncation lines remain individually removable and are recorded as such:
  they are genuinely redundant, producing the same refusal for the same input,
  so no test can discriminate them.

## [0.2.74] — 2026-09-01

Twelve commits since 0.2.73, and the theme running through most of them is the
one 0.2.73 started: a mechanism that reports success without having done
anything is the mechanism that fails. Four of these were found by measuring a
claim rather than reading it.

### Added

- **`review-pr-feedback` 2.0.0 — the skill that reads other people's PR comments
  now checks them and can act on them.** It collects through
  `keryx review comments collect` instead of three hand-rolled `gh api` calls
  (which returned the first thirty comments and wrote no durable record), gives
  every comment a verdict against the code at the head SHA with the evidence
  that settled it, and plans by class rather than by comment — six comments
  about one shape become one plan item that fixes every site holding it.

  With `--fix` it executes that plan through `flow-orchestrator`: a branch cut
  from the reviewed PR's own head branch, a draft PR based on it, a review/fix
  loop to zero findings at `minor` or above, and a merge back into that branch.
  Anywhere else and the pull request the reviewer is reading never changes.
  Every comment then gets one short answer, in English, once, after the merge.

- **`keryx review reviewers`** — the reviewer set is asked for rather than
  recited. A project can define its own reviewers and, before this, nothing
  dispatched them: a team could write one, register it, and watch it never run.

- **`reviewer-skill-creator`** — a skill for writing project-local reviewers.

- **Three registered contracts** — `flow-orchestrator-input`,
  `review-pr-feedback-input`, `review-pr-feedback-output`. Registration is what
  lets a validator be pointed at a schema at all; before it,
  `keryx skills contracts validate --schema review-pr-feedback-input` exited
  with a usage banner. See *Known limitations* for what that is and is not.

### Fixed

- **The SAC ledger missed a same-size rewrite inside one filesystem timestamp
  tick.** `fastCheckpointState` trusted the checkpoint whenever identity matched
  and then verified only the tail record. Measured on one machine: an in-place
  same-size rewrite left both timestamps unchanged in **189 of 200 attempts**.
  Nanosecond field names do not imply nanosecond granularity.

- **Seven `planning/` skills declared a frontmatter `name` their directory
  lacked.** Two naming systems are live and disagreed — installation copies by
  directory, harnesses register by frontmatter name — so those skills installed
  and then failed to resolve when dispatched.

- **A skill's `target` was carrying prose**, and the registry promised skills
  that were neither present nor reachable.

- **The task scaffold stays, and is marked.** The four rows `flow init`
  generates were proposed for removal on the premise that flows replace them.
  Measured across all 206 packages the premise is false: zero have a task list
  without those rows, and 91.5% of scaffold rows reach `done`. The measurement
  is the deliverable.

- Full-project review remediation, and the historical unfinished-task debt cut
  from 59 to 9.

### Known limitations

- **A registered contract is not an enforced one.** Of eleven registered
  contracts, four refuse a bad value in production — `review-finding`
  (`src/review/managed.ts`), `subagent-dispatch` and `subagent-result` (the
  harness), and `job-orchestrator-state` (`src/job/store.ts`). The other seven,
  including the three added here, are refused only when an agent runs
  `keryx skills contracts validate` itself. The four that work do so because
  keryx sits on the path — it writes the file, or it spawns the child; a
  dispatch between two agents has no keryx in it. Tracked as flow 213.

- **`flow complete` does not ask where a merge landed.** The record carries no
  base branch. Its condition 3 compares the reviewed tree against the merged
  tree, which catches a wrong-target merge whenever the targets' content
  differs — the residual is the case where they have converged. Tracked as
  flow 214.

## [0.2.73] — 2026-08-31

A correction release. 0.2.72 completed the orchestrator-hardening roadmap; this
one fixes what measuring that work afterwards revealed — including two defects in
0.2.72 itself, one of them destructive.

**Upgrade if you are on 0.2.72.** It ships an instruction that can destroy
uncommitted work, and a command that reports a clean result for a tree it never
read.

### Fixed

- **`task-implementer` told every implementer to run `git reset --hard` on fatal
  failure.** `job-orchestrator` dispatches implementers in parallel waves that
  share one worktree, so an agent failing its third attempt would discard a
  wave-mate's uncommitted work — work it does not own, cannot restore, and cannot
  observe the loss of, because the other agent's failure surfaces elsewhere. It
  now restores only the files that task changed and refuses unscoped reverts. A
  guard sweeps every shipped document for unscoped `reset --hard`, `clean -fd`,
  `checkout -- .` and `restore .`, excusing lines that forbid them so the
  correction cannot fail on itself.

- **`keryx skills verify --bundled` reported `skills_evaluated: 0` from an
  installed copy.** The root resolved to `dist/bundled`; the tree ships at
  `src/gdskills/bundled`. It surfaced only because the sweep refuses to call an
  empty result clean — it printed `NOTHING WAS EVALUATED` instead of reporting a
  clean tree. A second guard now builds the package from `package.json`'s own
  `files` and `bin` lists and runs the real binary against it.

- **Build parity was enforced on one skill of thirty-seven.** A census found
  thirty-six diverging, and the divergence ran opposite to the assumption: the
  harness builds are stale *ancestors* of their own `SKILL.md`, and text that
  looked harness-specific was an old path the canonical file had already replaced.
  Seven hunks are genuinely deliberate and allow-listed with the reason; the rest
  are reconciled. Enrolment is now computed from the filesystem, because a
  hand-listed frontier is what produced a denominator disjoint from the defect.

- **Nine `SKILL.claude.md` files shipped in 0.2.72 that no runtime addresses.**
  Deleted, with a check against any future unaddressable build.

- **Four of five `task-implementer` builds omitted the reporting contract** while
  production code throws unless a child's first line is `STATUS: <TOKEN>`.

- **`cross_family_review` shipped with no consumer**, in the commit whose own
  criteria forbid fields nothing reads. `review ingest --cross-family-review`
  accepts it and `review status` reads it back in a later invocation, exiting
  non-zero on a self-contradictory record.

- **`dependsOn` and `attempts.count` were written and read by nothing.**
  `dependsOn` now drives `keryx flow next` and dependency validation — which
  immediately found a task in an older flow depending on itself. `attempts.count`
  is recorded when a task closes `failed` or `blocked`.

- **A dangling agent name lived in code, not only prose**: `agent: "code-review"`
  in `src/job/plans.ts` was writing an unresolvable label into every implement job
  on disk. A new guard fails the build on any skill naming an agent outside the
  catalogue, and immediately found `subagent_type: "general"` — a value no
  dispatcher accepts — in twelve files.

- **Loop detection could never fire**, for two independent reasons: finding
  identity was led by a per-round `global_id`, and a date-keyed review id let a
  second same-day round overwrite the first.

- **Both `task-implementer` contract schemas declared `minItems` and `maximum`
  while the validator silently ignored them.** Registering the schemas without
  implementing the keywords would have moved the defect up a layer rather than
  removing it.

### Changed

- `task-implementer` goes from 7 documented mechanisms reachable from production
  code to 55 of 109; its six-phase core from 2 of 54 to 20 of 54. Forty-eight
  claims wired, sixteen deleted, none softened. All four orchestrators have now
  been inventoried and hardened by the same method.

- Five places where a skill restated logic that already exists now call it:
  contract assertions, job document recording, the automation table, lint and
  type-check, and the test runner that already resolves the package manager the
  skill was reimplementing in shell.

## [0.2.72] — 2026-08-30

Phases 5 and 7 of the orchestrator-hardening programme, which completes it: all
seven phases are now delivered. The theme of both is the same one the programme
started with — a mechanism whose failure is silent is the one that fails — and
this release is mostly the result of going looking for those on purpose.

### Added

- **`keryx job`** — the job pipeline has a real implementation, built the way
  `keryx flow` is: a package on disk, a typed state file, an explicit transition
  map, atomic writes, an append-only journal. `init` / `status` / `step` /
  `document` / `complete` / `list`. It uses the `state.schema.json` that had
  shipped beside the skill since the first commit rather than inventing one, and
  registers it as a contract — which no command could validate before, because
  the contract installer carried a duplicate name list instead of deriving from
  the registry.

- **`keryx skills verify --bundled`** — the 65 skills that ship to every user are
  evaluated rather than assumed correct. Structural validation: frontmatter,
  resolvable cross-references, no concrete model name, no persona or
  home-directory path. It reports itself as *layer 1 of 3* rather than describing
  a pipeline that was not built.

- **`keryx review learn --pr <n>`** — a reviewer whose checklist is learned
  locally from pull-request comments by people the project names, configured per
  project. Learned content stays in that project; the apply path refuses any
  target outside `.metaproject/project-skills/`, so a misconfigured project
  cannot teach the shipped template.

- **`keryx providers cross-family`** — opt-in review by a different model family
  than authored the change, reading the existing provider configuration. It
  refuses to call a gateway or a local runner a "family", since fronting many
  vendors and being recorded as cross-family would corrupt the comparison the
  feature exists to enable.

- **`filter_stats`** in the round manifest, produced by the code that filters —
  the pre-filter, the verifier, the scope-B screen, the findings cap. Every count
  distinguishes **measured zero** from **not measured**, and `keryx review
  status` reads it back off disk in a later invocation and exits non-zero on a
  record that contradicts itself.

### Fixed

- **The review sections of `job-orchestrator` were two releases stale.** A pull
  request driven by it failed all five conditions of the completion gate shipped
  in 0.2.71. They now run the managed pipeline end to end.

- **Things that were documented and did not exist.** An audit of
  `job-orchestrator` inventoried 217 mechanisms and found six reachable from
  production code. Deleted or wired: `wave-executor` (the agent every
  implementation wave was dispatched as), `code-review` (the *default* review
  mode), `subagent_type: "general"` (41 occurrences; no dispatcher accepts it),
  three skill-load paths that stopped resolving when the tree was namespaced, and
  a step that outlived its own removal. Roughly 90 claims were wired to a real
  command and 45 deleted. None was softened — turning "is enforced" into "should
  be done" makes a sentence true while leaving the guarantee absent.

- **Claims that were impossible in this execution model**, deleted rather than
  reworded: a step defaulting "if no response in 60s", when no timer exists and a
  model cannot observe wall-clock passing while a user does not answer; and
  routing on time pressure with no clock and no persisted start.

- **27 defects in the shipped skill tree**, found by the new evaluator on its
  first run: a skill dispatching an agent that has never shipped, 25 unresolvable
  paths in nine forms including four contract schemas, and
  `.metaproject/scripts/detect-models.sh` — cited by two different orchestrators
  as the way to find a cheaper model, and never present in any tree.

- **The four non-Claude harness builds were dead content.** Export copied
  `SKILL.md` regardless of runtime — even for codex, with `SKILL.codex.md` beside
  it. They are now selected correctly and can be synced to their platforms by an
  explicit command, never as a side effect of `keryx update`. A new parity guard
  caught three sections that had existed only in the Claude build since the
  bootstrap commit while all five declared the same version.

- **The learning loop had never produced anything.**
  `.metaproject/memory/review-notes/` did not exist and the note type had never
  been written. Notes are now written when a finding is dismissed as incorrect —
  and only that dismissal counts as model error, because the other three are
  correct findings nobody acted on and conflating them poisons the signal.

- **The reviewer profile no longer describes a person.** It shipped one
  individual's conventions and speech markers in a public repository. Keryx now
  ships the mechanism; the conventions live in the projects that hold them.

## [0.2.71] — 2026-08-30

Phase 4 of the orchestrator-hardening programme: a pull request is now reviewed
for what it can **break**, not only for what it changed; a flow cannot close over
an unresolved finding; reviewers on the pull request get an answer; and a
dispatch is sized to the work instead of every dispatch paying flagship prices.

This release was itself produced through the loop it adds — five review rounds
over its own pull request, twenty-four findings, every one verified against a
named commit before being called fixed. Two of the four fix rounds introduced a
defect that the next round caught, which is the strongest evidence available that
the rounds are doing something.

### Added

- **A second review scope: the blast radius.** `keryx review blast-radius`
  computes what a change can break from `gdgraph affected` over the changed
  files, ranked by edge distance and bounded at depth 2 / 40 files — both
  measured over 80 commits, not guessed. Every file the cap drops is named in the
  round manifest and on the terminal, because a silent truncation reads as "we
  checked everything". A finding raised under this scope that is not a regression
  is rejected **in code**: it must anchor inside the computed set, clear a
  severity floor, and name the change it breaks.

- **A `review` gate on `flow complete`.** It passes only when a managed review
  record exists with at least one readable ingested round, every finding carries
  a terminal disposition, the round ran against the commit that is merging, no
  external comment is unanswered, and the verifier ran with its stats recorded.
  "Clean" is defined positively, per finding: `acted-on` needs a commit SHA and a
  verifier verdict against it, a dismissal needs one of four taxonomy reasons
  **and** a recorded human decision. A finding that simply stops appearing in a
  later round is not cleared — absence never reads as a fix.

- **External pull-request comments are collected and answered.** All three
  GitHub sources — inline review comments, review submissions, PR-level
  discussion — with bot authors handled identically to humans. Collected every
  round, answered **once at the end**, at most two sentences and 600 characters,
  threaded, and never resolved by us: replying is ours, resolving is the
  reviewer's call. A comment cannot be refuted by the verifier alone; a human
  asked a question, and a machine deciding the question was invalid is not an
  answer.

- **`keryx review tier` — adaptive model selection, computed rather than
  chosen.** Skills declare a tier (`light`/`standard`/`deep`), never a model
  name; a skill naming a concrete model fails a test. The tier is assigned
  deterministically from signals the orchestrator already holds — scope, attempt
  count, finding count, diff size, verification method, security in scope — and
  never by asking a model to rate its own difficulty. It resolves against
  whatever the provider reports **at runtime**, placing the tiers relative to the
  session's own model. No model id is written anywhere in the codebase: what is
  hard-coded is a list of sixteen *size words*, which makes no claim about which
  models exist and cannot go stale when a vendor ships a new one. An environment
  that cannot be ranked inherits the session model — never a downgrade, never a
  dispatch failure.

### Fixed

- **A squash merge can now be verified.** The completion gate asked whether the
  reviewed commit is reachable from the merge, which a squash destroys by
  construction — so on the merge strategy this project actually uses, the check
  could never pass. It now compares the two commits' **trees**: equal trees prove
  the reviewed bytes are the bytes that merged, which is a stronger claim than
  ancestry. Every non-answer — missing object, shallow clone, `rev-parse`
  failure, git absent — is `unobserved`, never `pass`.

- **`flow complete` told three different situations apart.** "The comment
  collection is stale", "the tracker is unreachable" and "nobody has commented"
  were all reported as one status with advice that fitted only one of them.
  Collection now records the commit it ran against, and a record that cannot be
  shown current never reads as fresh.

- **Reply length is bounded by characters as well as sentences.** A single
  4,000-character sentence satisfied a two-sentence budget and was posted whole.

- **Four mechanisms documented as enforcement had no caller.** `buildTierMap`,
  `assignTier`, `decideDispatchModel` and `screenBlastRadiusFindings` were
  reachable only from their own tests while a skill, a schema and a rule all
  stated they ran. Each is wired at its stated seam, and each wire is pinned by a
  test that goes red when the wire is cut.

- **`parseModelTier` returned inherited `Object.prototype` keys**, so
  `model_tier: constructor` passed the guard that exists to reject it and then
  resolved as a silent downgrade.

- An external comment's dedupe key is stable across rounds by design, so an
  unanswered comment read as a reviewer stuck in a loop and `review loop` exited
  non-zero from round 2 naming the commenter.

- A sentence-final abbreviation (`etc.`, `i.e.`, `vs.`) swallowed the stop that
  ended its sentence, under-counting a reply in the direction that lets a long
  one through. The mask no longer depends on which regex engine reads it.

## [0.2.70] — 2026-08-29

### Fixed

- **`keryx flow complete` now gates on tasks — it never did, despite saying so.**
  `flow-orchestrator/SKILL.md` told readers that an unrun verification step
  keeps a flow open "instead of being quietly dropped". `complete()` ran four
  gates and the task gate was not among them: `taskGateStatus()` was written,
  tested, and carried a comment saying it was deliberately unwired. Measured
  across 184 completed packages, **34 unfinished tasks in 24 flows shipped
  behind that sentence, 24 of them the review step itself.**

  The gate is **opt-in by creation** (`gates.tasks`, written by `flow init`), so
  historical packages are not retroactively invalidated; a package without the
  field reports the gate as `skipped` rather than silently passing it. A
  `skipped` task passes only with a recorded reason, a `blocked` task does not
  pass at all, and an unrecognised disposition fails rather than falling through
  — `--disposition` is now parsed instead of cast, so a typo can no longer reach
  disk and close a task.

- **A review round can now seed the next one.** A fix round requires
  `prior_findings[].finding` to conform to a schema with five required fields
  and `additionalProperties: false`; the artifact a round wrote had none of them
  and carried four forbidden ones, so round 2 could not be constructed from
  round 1's own output. Findings now travel as structured data rather than being
  re-parsed out of prose, with the Markdown path kept for existing reports.

- **Attempt counts persist.** `attempts.count` was declared and never
  incremented. New `keryx flow task attempt <id> <Tn> --outcome
  started|failed|blocked` records it, and the orchestrator reads it from flow
  state instead of from its own context — which matters because 27% of flows run
  longer than eight hours and cross session boundaries.

- **`--greptile` is gone** (it routed to a skill that exists nowhere), the
  frontend-conventions reviewer no longer fires on every `.ts` file in a
  repository with no frontend, and the review orchestrator no longer prompts
  about legacy profiles on every run.

- **The subagent status protocol documented four statuses while the schema
  carried five.** That made `FAILED` look unreachable; it is reachable from the
  harness child layer and load-bearing there. The protocol now documents all
  five and names which worker family emits the fifth. A guard test asserts every
  bundled rule stays byte-identical to its installed copy — this correction was
  first written to the generated copy alone, where the next `keryx update` would
  have reverted it.

### Added

- **`keryx sandbox status`** — the OS sandbox launcher's availability and a
  per-capability containment matrix, distinguishing "requires a launcher you
  have not installed" from "not implemented on this platform at all". A report,
  not a gate: it always exits 0.

- **`keryx flow task attempt`** — see above.

- **`docs/requirements/keryx-orchestrator-hardening/`** — the benchmark that
  produced the fixes above, and the plan for what follows: review precision, one
  canonical severity rubric, deep review rounds bounded by a computed blast
  radius, completion gated on a clean final round, external PR comments answered
  once at the end, and adaptive model selection by tier.

- **A dynamic import is no longer counted as a load-order edge in gdgraph**, so a
  module that lazily imports something which statically imports it back is no
  longer reported as a cycle.

- **The approval menu no longer offers a prefix grant the grant itself would
  refuse.** It validated the derived pattern rather than the command, so "always
  allow" could be offered for a command a stored grant would then decline.

### Changed

- **Brevity in the agent's system instruction governs prose length only.** It
  was paired with "be economical with output tokens", which reads as a budget on
  tool calls too — and a benchmark caught the agent reporting a result from one
  call because verifying it felt like spending. A tool result that is itself the
  deliverable is now checked against source before being presented as fact.

## [0.2.69] — 2026-08-28

### Fixed

- **The sidebar outgrew a 24-row terminal and hid half of itself.** The
  balance/usage panels added in 0.2.62 pushed the fixed-height sidebar stack
  to 31 rows against the ~24 a standard terminal gives, so `Tools`, `Status`,
  the sub-agent and background-job boxes and the pinned toast fell off the
  bottom of the screen. CI's macOS pty leg caught this on the introducing
  commit and had been red on every push since 2026-08-23; it was a real
  regression, not a flaky job.

- **`security` and `ctx` wrote their data wherever the process started.** Both
  built `.metaproject/data/…` from `cwd` instead of resolving the project
  root, so running either from a subdirectory created a stray `.metaproject/`
  there — twelve had accumulated in this repository. For `security` the litter
  was the lesser half: the per-project HMAC key that keeps finding hashes
  unguessable was regenerated per working directory, the self-protection state
  used to detect a mode downgrade started empty on every subdirectory run, and
  `isSecurityEnabled()` returned false from a subdirectory, so every write
  seam silently skipped its check.

### Changed

- **The `Balance`, `Workspace` and `Review` sidebar rows are hidden when they
  have nothing to show**, rather than occupying rows with a placeholder. This
  is what reclaims the space above; `/workspace` and `/review` are unaffected.

## [0.2.68] — 2026-08-26

### Added

- **Custom file-backed LLM providers.** Operator-defined OpenAI-compatible
  providers can now be registered in `~/.local/share/keryx/llm-providers.json`,
  merged into the built-in provider list. The TUI `/provider` wizard offers a
  new "add custom provider" entry (name → URL → key → models) that persists to
  the file. Custom names colliding with a built-in provider are excluded.

### Security

- Custom file-backed providers get a narrow, opt-in SSRF allowance: a new
  `isPrivateLanHost()` predicate (RFC1918 + CGNAT ranges) paired with
  `grant.allowPrivateLan`, granted only to custom providers as an explicit
  operator-trust boundary. Loopback still requires `allowLoopback` separately;
  link-local metadata addresses (`169.254.x`) stay denied regardless. Built-in
  providers never receive the LAN grant.

## [0.2.67] — 2026-08-24

### Added

- **A suggested next step after every settled turn** (Claude-style): when the
  main agent finishes and the queue is empty, a short model-generated follow-up
  appears in the composer placeholder. Tab / Right-arrow inserts it without
  submitting; Enter on the empty composer submits it directly; typing dismisses
  it. Fail-closed: no credential, a timeout, or a `.` reply shows nothing and
  never blocks the shell.

- **`keryx workspace dismiss-candidate <evidence-path|session-id>`** — UNBOUND
  candidates (wrap-up ran with no workspace bound) can now be dismissed instead
  of lingering in `catch-up` / `/review` forever: the artifact is removed and a
  `*-unbound-dismissed.json` receipt is written, after which both the internal
  and external-slate readers skip it.

### Fixed

- **`/theme` switch did not repaint already-rendered chrome.** Only the
  chrome's own surfaces were recolored; transcript frames, tone block headers,
  dock buttons and sidebar panels kept the old palette's hexes, so dark-to-dark
  switches looked like the theme never applied. The tree is now walked with
  theme-color remapping (OpenTUI stores colors as RGBA objects).

## [0.2.66] — 2026-08-24

### Fixed

- **A typed message in front of a paste vanished from the transcript, leaving
  only `[pasted N lines]`.** The composer's submit echo collapsed ANY
  multi-line input into that bare placeholder, so typing a question and then
  pasting a block after it discarded your own words entirely — the transcript
  looked like you'd said nothing. It now keeps your own first line and
  summarizes only the rest as a paste count (`explain this [+ 12 pasted
  lines]`). The logic was also duplicated between the chat and agent shells;
  it is now one shared function.

- **Fenced code blocks in a reply had no way to copy them.** `y`/`/copy` only
  ever reached the block-nav registry (thought/tool/output blocks) — a fence
  embedded in the reply text had no registry entry of its own, so there was no
  copy path at all. Both now fall back to the most recently rendered code
  block when nothing is registered to copy, and the block's header advertises
  the shortcut (`python · 15 lines · y copy`).

### Added

- **Code blocks get lightweight local syntax highlighting.** Comments,
  strings, numbers and keywords are colorized via a plain-string tokenizer —
  no tree-sitter worker, no network or grammar fetch, so it stays inside flow
  109's worker-free, no-egress rendering stance (D-2).

### Known gaps

- **A paste can occasionally split** — part of it lands in the transcript as
  a sent message, the rest stays stuck in the input. This traces to an open
  upstream bug in `@opentui/core`'s `StdinParser`
  ([anomalyco/opentui#1270](https://github.com/anomalyco/opentui/issues/1270),
  unterminated bracketed paste), present in both the installed `0.4.5` and the
  latest `0.5.7` — not fixable from here until it lands upstream.

## [0.2.65] — 2026-08-23

### Fixed

- **`/game`'s modal no longer scrolls as a whole and the board is never
  clipped.** The 0.2.64 prompt card used `flexGrow: 1` on a ScrollBox with no
  height cap, which made OpenTUI measure the card at the full parent height —
  the card ballooned to the whole modal body, pushed the stats/footer out of
  view and gave the modal a body-wide scrollbar that also clipped the bottom
  of the board. The agent panel now reserves a fixed slice (status + stats
  lines), the board is sized from the modal body HEIGHT (cell heights 2..5:
  tiny/small/medium/large), and the prompt card is a bounded minmax-style
  block (5..14 rows) that scrolls only inside itself. Board + panel now sum
  exactly to the body height, so everything is on screen at once on any
  terminal of ~30 rows or more.

- **The agent panel now shows what the model actually receives and with what
  parameters.** The prompt card shows the system prompt AND the per-turn user
  prompt (the exact board state sent each turn, so you can see how the model
  learned your move); the status card shows the provider/model in effect
  (`auto/auto` until the first turn) and the compact last-turn/session stats
  (latency, in/out tokens, reasoning/fallback/error flags, fallback/error
  counts) on three lines instead of two tall cards.

- **Modal tab bodies got a stale 68x13 viewport instead of the real one.** At
  mount time OpenTUI's `width`/`height` getters still return the last LAYOUT
  value (the 72x18 creation-time floor), so `renderTab`'s context claimed the
  panel body was 68x13 even on a normal terminal — the /game board was sized
  from that floor. The host now computes the body size deterministically from
  the renderer (`resolveModalPanelSize`), matching the panel's actual resolved
  size at open.

## [0.2.64] — 2026-08-23

### Fixed

- **`/game`'s system-prompt card is no longer capped at 6 lines.** The agent
  panel truncated the prompt the model sees to 6 lines plus "… (N more)" and
  left dead space below it. The card now renders the full prompt, flexes to
  absorb the leftover body height, and scrolls (wheel, scrollbar, or
  j/k/↑/↓ once the scrollbar has focus) when the prompt is taller than the
  space the layout leaves it.

## [0.2.63] — 2026-08-23

### Changed

- **`/game`'s agent panel is now real cards with a stats table.** The system
  prompt, last-turn latency/tokens and session totals were one undifferentiated
  dim line; they are now three bordered cards — a status line ("agent is
  thinking…" / notice / "waiting for your move"), the system prompt wrapped as
  lines (capped at 6 + "… (N more)"), and a side-by-side last-turn/session table
  (model, first byte, total, in/out tokens, reasoning/fallback/error flags;
  turns, fallbacks, errors, token totals), with long provider/model ids
  truncated so a half-width card never clips. Footer hints now say
  `arrows move` / `tab games`.

### Fixed

- **`/game`'s left/right arrows stopped moving the cursor again.** The
  multi-tab games-host split (0.2.62) dropped the `onArrowKeys` claim the
  legacy single-game modal keeps, so the modal host's own tab switch consumed
  both arrows and `stopPropagation`'d them before the game saw them — the
  cursor moved up/down but not sideways, and with one game the tab switch was
  a silent no-op. The games host now claims both arrows for the active game
  through the host's `onArrowKeys` hook again (a pure probe; the game's own
  keypress handler still applies the move, so each press moves once) and only
  falls back to tab switching when the game declines the key.

## [0.2.62] — 2026-08-23

### Added

- **`/game` is now a multi-tab games host with an agent-stats panel.**
  The single tic-tac-toe modal became a component-based games module
  (`src/tui/games/`): one `GameDefinition` contract (rules, prompts, render,
  input) plus a registry, so adding a game is adding one definition — its tab
  appears automatically on the shared modal host, with `←`/`→` switching
  games. Tic-tac-toe itself is split into `core`/`prompts`/`layout`/`render`/
  `input`/`game`. Under the board sits the new agent panel (dim/secondary):
  the exact system prompt the model sees each turn, plus per-turn
  latency/token stats — provider/model, time-to-first-byte, total time,
  input/output tokens, reasoning flag, local-fallback count, errors. `runModelTurn`
  now surfaces `usage`/`latencyMs`/`reasoning` from the stream so any caller
  can show what an agent turn actually costs.
- **`/game <seconds>` raises the model-turn deadline; the default went from
  12s to 60s.** Local models are slow, and the stats panel's point is to
  observe that latency, not to race it. `/game 45` sets a 45-second deadline
  for that modal.

### Fixed

- **The sidebar now shows provider balance and session usage.** A new
  `Balance` row under Model fetches the ACTIVE provider's balance live
  (DeepSeek `GET /user/balance`, OpenRouter `GET /api/v1/credits` — the only
  registry providers with public balance APIs; the rest render `—`), on
  mount and again on click, honouring `KERYX_<NAME>_BASE_URL` overrides. A
  new `Usage` row shows the cumulative in/out token totals for the session,
  fed from the same `io.onUsage` stream that drives the header counter.
  Both are wired into the agent and chat shells.

## [0.2.61] — 2026-08-23

### Fixed

- **Web search returned empty results on bun-in-`~/.bun` installs.** The
  bwrap profile for the sandboxed web worker masked `$HOME` entirely
  (`--tmpfs`), hiding `process.execPath` itself when bun lives under home.
  The worker could not start and the search bridge silently returned empty
  results. The profile now masks only home's secret subdirectories via
  `defaultReadDenyList`, leaving the runtime readable.

## [0.2.60] — 2026-08-23

### Fixed

- **`/game`'s cursor would not move left or right.** `modal-host` claims both
  arrows for its own tab switch and calls `stopPropagation()`, so the game's
  keypress listener only ever saw up/down. The cursor now moves through the
  host's `onArrowKeys` hook, and left/right are removed from the keypress
  handler — that hook returns without stopping propagation, so handling them
  in both places would move the cursor two cells per press.

- **The board is sized from the modal body width**: 9×5 cells where the 33
  columns they need fit, the previous 5×3 where they do not.

- **A model turn could hang the game indefinitely.** There was no deadline on
  the provider call, so a stalled request left "agent is thinking…" on screen
  with `R` as the only way out. The turn now has a 12s deadline; on timeout —
  or on a reply that names no free cell — the game plays a local move (win,
  block, centre, corner) and says so, instead of silently passing the turn
  back and letting the user win against nobody. A hard error (no credential,
  provider failure) still hands the turn back with the reason. `runModelTurn`
  takes no abort signal, so a timed-out request is abandoned, not cancelled.

- **The model turn's output budget was 16 tokens.** On a reasoning-capable
  model that budget covers the thinking pass, so the answer digit could be
  truncated away before it was ever emitted — the turn then looked like a slow
  model that skipped. Raised to 256; the visible reply is still one character.

- The status line read "Your turn — O" while the agent was thinking. It now
  reads "Agent's turn — O".

## [0.2.59] — 2026-08-23

### Fixed

- **`/game` drew its board as one 9-cell vertical column instead of a 3×3
  grid.** The board was a single `flexDirection: "column"` box holding nine
  bare text nodes — with no row boxes between the board and the cells, flex
  put every cell on its own line. The tree is now built once in `renderTab`
  as three row boxes of three bordered cell boxes, and `paint()` only
  mutates the retained cell handles instead of clearing and re-adding all
  nine nodes on every keypress. The cursor is a real highlight (focus border
  + highlight fill) rather than a swapped glyph, the winning line takes the
  winner's colour, and legend/board/status are centred.

- **A model error during the game's turn was never visible.**
  `applyModelMove` wrote the message straight onto the status node and the
  `paint()` immediately after overwrote it. The message now goes through a
  `notice` state that `paint()` owns and renders on its own line — the same
  line that carries "agent is thinking…".

## [0.2.58] — 2026-08-23

### Added

- **`/game` — tic-tac-toe vs the model in a TUI modal.** A pure game core
  plus a model move via an injectable, fail-closed provider factory; state
  lives in the modal's own closure so `Esc` minimizes without resetting and
  reopening `/game` resumes the same board. Available while the main agent
  is busy, registered alongside the other agent-only slash commands.

### Fixed

- **The interactive agent's runaway-tool-loop guard counted unique
  tool-call signatures, conflating a big legitimate task with an actual
  loop.** A task with many DIFFERENT tool calls (e.g. a wide refactor) was
  indistinguishable, under that metric, from real repetition, and hit the
  same budget wall either way. Replaced the three unique-signature pools
  (`DEFAULT_MAX_TOOL_CALLS`/`_READ_`/`_NON_READ_`) with a model-round-trip
  cap (`DEFAULT_MAX_ROUNDS`, `KERYX_AGENT_MAX_ROUNDS`); the existing
  per-signature attempt cap (`MAX_ATTEMPTS_PER_HASH`) remains the actual
  repetition guard. `spawn_subagent` and wiki deep-enrich child budgets
  migrated the same way.

- **Untrusted web content could permanently block an unrelated tool call
  turns later in the same session.** Once any `web_fetch`/`web_search`
  result came back untrusted, every later non-read tool call was refused
  for the rest of the session, with no way back short of `/new`/`/clear` —
  including actions that had nothing to do with the tainted content. The
  gate is now scoped to the turn the untrusted content appeared in: it
  still blocks every later round within that same turn, but a following
  user turn starts clean.

- **External Slate-Adjacent Context (SAC) hands could get a workspace
  auto-created for them at close.** Flow 200's lazy resolve-or-create in
  `runWrapUp` now excludes external slates entirely — a hand that never
  bound a `workspaceId` gets the unbound-candidate artifact, never a
  created workspace. Internal session/flow wrap-ups keep the lazy resolve
  (AC-38, flow 182).

## [0.2.57] — 2026-08-22

### Added

- **Lazy SAC workspace binding.** A session no longer auto-resolves-or-creates
  a workspace from its first message (which produced junk workspaces like
  "git pull --rebase" before the session's real topic was known). A session
  now opens with no workspace bound; the agent decides via
  `workspace_list`/`workspace_create`/`workspace_propose` when a workspace is
  actually warranted, `workspace_create` binds the created workspace to the
  session's slate, and `runWrapUp` resolves-or-creates a workspace **from the
  session's Seeds** (the real topic) when the slate is unbound at close time,
  then proposes per kind-group. A failed resolve still degrades to the
  unbound-candidate artifact.

- **Explicit agent seed-writing instruction.** `buildAgentSystemInstruction`
  now teaches the model when to write a `slate_write_seed` (root cause found,
  code changed, decision taken, risk identified), which `kind` to use, the
  2-3 sentence length, and that one-shot operational requests need no Seeds —
  making wrap-up's proposal pipeline actually fed, since Seeds are its only
  input.

### Fixed

- **`/review` Accept/Decline were a plain text hint, not buttons.** On the
  Detail tab of a proposal, `[a] Accept this proposal [d] Decline this
  proposal` rendered as text: mouse clicks did nothing and there was no
  arrow-key navigation. They are now real clickable buttons (same style as
  the main-queue buttons) with a two-step keyboard flow: `←`/`→` (or `a`/`d`)
  move the highlight, Enter arms, Enter/`y` confirms. A new
  `modal-host` `onArrowKeys` hook lets the tab body claim the arrows, and a
  stale-node write into destroyed `TextBuffer`s on tab switch was fixed.

## [0.2.56] — 2026-08-22

Fixes every finding from the 0.2.55 live-testing campaign
(`docs/verification/` on the `real-test-keryx` branch): 118 real test cases
run against a live shell, live DeepSeek traffic, and a live MCP server,
covering the full `/goal`, Slate, SAC, permission-mode, and slash-command
surface. This release closes the six flows that came out of it.

### Fixed

- **A stored `keryx *` shell-permission grant silently auto-approved every
  future `keryx` subcommand forever, including destructive ones.**
  `validateShellPattern` refused bare `<verb> *` wildcards for known
  destructive verbs but never covered the harness's own binary. The binary
  name is now resolved dynamically and added to that same guard; any
  pre-existing bare wildcard already loaded from `permissions.json` is now
  flagged the same way `rejected`/`tampered` patterns already are.
  ([#390](https://github.com/MrCipherSmith/keryx/issues/390))

- **Mutating `keryx` CLI subcommands could bypass SAC review entirely.**
  `keryx wiki enrich` could land `Status: accepted` content with zero SAC
  proposal, once its `shell_exec` call was approved. It can no longer set a
  page's `Status` at all — it always re-asserts whatever the page's Status
  was before the run, regardless of flags or what the model itself returns.
  `keryx workspace catch-up` also gained a standing backstop: it now flags
  any SAC-owned path (wiki/memory/skill) that changed with no matching
  review receipt, as its own distinct category.
  ([#391](https://github.com/MrCipherSmith/keryx/issues/391))

- **`/goal --auto`'s independent verifier pass was silent, evidence-blind,
  and its "one more round" safety net was unreachable.** Three related
  reliability gaps in the T10 verifier (SLATE-27), all fixed together:
  the verifier's dispatch and verdict are now recorded in the visible
  transcript on every outcome — achieved, not achieved, or unavailable —
  instead of only the disagreement case; the verifier is now handed the
  run's actual evidence (recent Slate Seeds and `workspace_propose` records)
  instead of just the bare goal text; and the round loop can now exit early
  on a real, deterministic "this round is done" signal, so the verifier is
  reached with round budget still available instead of always exhausting it.
  ([#389](https://github.com/MrCipherSmith/keryx/issues/389),
  [#392](https://github.com/MrCipherSmith/keryx/issues/392),
  [#394](https://github.com/MrCipherSmith/keryx/issues/394))

- **`/theme` was advertised by `/help` in agent-mode readline but had no
  dispatch branch there**, falling through to "Unknown command: /theme."
  right after `/help` listed it. It now dispatches to a working
  readline-mode theme picker.
  ([#393](https://github.com/MrCipherSmith/keryx/issues/393))

- **`keryx workspace catch-up` never scanned `.keryx/external-slates/`**, so
  a closed, never-bound external MCP Slate genuinely persisted on disk but
  never surfaced as `unbound-candidate` the way `slate.md` documents. It now
  scans that store too.
  ([#395](https://github.com/MrCipherSmith/keryx/issues/395))

- **`/mode auto`'s auto-approval line lacked test coverage that the
  `[destructive]` audit tag actually reaches it** for a genuinely
  destructive command — the rendering itself was already correct.

- **A headless/piped `keryx shell` process ignored `SIGINT`**, only exiting
  on `SIGTERM` — consistent with an interactive "press again to confirm
  exit" trap a non-TTY process can never satisfy. A single `SIGINT` now
  exits immediately when stdin is not a TTY; interactive behavior is
  unchanged.

## [0.2.55] — 2026-08-21

### Fixed

- **`keryx shell`: a parallel-tool-call turn could stall the session with a
  provider 400 and no further reply.** `runAgentTurnCore`'s per-tool-call
  loop pushed the SLATE-2a Anchors-block (and the repeated-failure hint)
  into history mid-loop, splicing a `role:"user"` message between two
  `tool` results that answer the SAME assistant `tool_calls` batch. Several
  OpenAI-compatible providers (observed: DeepSeek) reject that shape
  outright with `"An assistant message with 'tool_calls' must be followed
  by tool messages responding to each 'tool_call_id'"` — the batch's own
  `tool_calls` never got a next reply, and every following turn replayed
  the same broken history. Both injections are now deferred and pushed
  once, only after every call in the batch has its `tool` result recorded.
  Root-caused from a real local session transcript that reproduced the
  exact interleaving and the exact provider error.

## [0.2.54] — 2026-08-21

### Fixed

- **`slate.*` MCP tools (SLATE-22..26, shipped in 0.2.53) were unreachable
  over MCP on every project, including keryx's own.** They were registered
  tagged `module: "slate"`, but neither `MODULE_MANIFEST_KEY` nor the
  default `expose.modules` allowlist had an entry for it, so
  `isModuleExposed("slate")` silently returned `false` everywhere — with no
  `keryx modules enable` toggle to work around it. Fixed at the source
  (`src/mcp/discovery.ts`, `src/mcp/client-config.ts`) so every future
  `keryx init`/`mcp install` writes a working manifest; this repo's own
  already-generated manifest is patched the same way. Live-verified against
  the real MCP SDK: `tools/list` now returns all three tools. A standing
  regression test drives discovery against keryx's own committed manifest
  and fails if any registered tool ever resolves to unexposed again — this
  exact bug class was already found and fixed once before this feature
  shipped it a second time.

## [0.2.53] — 2026-08-21

### Added

- **`/goal --auto [N]`: bounded autonomous continuation (SLATE-27).**
  `/goal` was strictly one-shot: it opened the Slate, bound a SAC workspace,
  ran exactly one turn, and stopped — whether the goal was actually achieved
  was left entirely to the model's own narrative. `--auto` (default 8
  rounds, or an explicit cap) now re-drives the turn in a bounded loop,
  auto-provisioning a Task Manager flow as the durable "is this done" record
  when none is bound, and — before the final stop — dispatches one
  independent `spawn_subagent` verifier call that checks the claimed outcome
  against the repository instead of trusting the model's own "I'm done."
  On a rejected verdict with rounds remaining, it reopens for exactly one
  more round. The armed round budget lives only on the in-memory session
  object, never in `slate.json`, so a forked or resumed session never
  silently inherits an unattended loop. Guide: `docs/docs/guides/goal.md`.
  Drawn from a 13-competitor survey of comparable mechanisms in other
  coding-agent CLIs — `docs/requirements/goal-continuation/`.
- **Slate v3: private MCP slate lifecycle for external hands (SLATE-22..26).**
  Three new MCP tools — `slate.open`/`slate.writeSeed`/`slate.close` — let
  any MCP-connected external harness (Claude Code, Codex, or anything else
  that speaks MCP) keep its own task-local working memory the way keryx's
  own runtime already does for itself, and dispatch it into the same SAC
  propose/review pipeline on completion. Each hand's slate is scoped to
  `(cwd, externalSessionId)` and structurally never reachable through a
  different id; every Seed it writes carries a server-set
  `origin`/`trust: "external-unverified"` a reviewer can see. Local
  stdio/in-process only — refused over HTTP. Guide: `docs/docs/guides/slate.md`.

### Fixed

- **TUI: the Tools/MCP modal's MCP tab was showing chat providers, not MCP
  servers.** It listed the connect status of keryx's own outbound MCP
  client registrations (Cursor/Claude/opencode/VS Code) but never the
  actual MCP servers each of those clients has configured — context7,
  Playwright, keryx-mcp itself. The tab now also surfaces each connected
  client's other configured servers, with a caption clarifying what's shown.
- **TUI: the `/`-command dropdown had no way to receive a required
  argument.** Enter was the only way to act on a highlighted command, and
  it submits immediately — commands like `/goal <text>` or `/delegate
  <agent> <task>` had no way to get their argument from the dropdown at
  all. **Tab** now accepts the highlighted command into the composer
  (`<name> `) and hands the keyboard back instead of running it, so typing
  the rest of the line just continues; Enter still runs a no-arg command
  immediately as before. Along the way, fixed a related bug where the
  dropdown's own filter `.trim()`'d the composer query, so a value ending
  in a genuine trailing space still equalled the bare command name and kept
  reopening the dropdown.

## [0.2.52] — 2026-08-21

### Added

- **VS Code/Cursor extension: one-command local install.** `bun run
  install:vscode` / `bun run install:cursor` package (`vsce package`) and
  install the extension in a single command, replacing the manual
  `npx`-per-iteration sequence every prior verification round required. Adds
  `@vscode/vsce` as a devDependency. README documents both, plus the
  GUI-launched-editor PATH gotcha (an nvm-managed `keryx` resolves from a
  terminal but not from a Dock/Spotlight-launched editor, since GUI
  processes don't source shell profiles) and its fix.

### Fixed

- **TUI: the Tools/MCP inspector modal is now actually usable.** It shipped
  in 0.2.51 rendering as a small, mouse-dead box: the shared modal host
  capped every modal at a fixed 96x28 regardless of terminal size, and the
  Tools/MCP rows were one joined-text block, so a click could never land on
  a specific row's connect/disconnect action. The modal now sizes to 95% of
  the terminal, and every row is a real, independently clickable element —
  click a row to arm connect/disconnect, click it again to confirm, mirroring
  the existing `[c]`/`[d]`-then-`[y]` keyboard gate exactly. Keyboard nav is
  unchanged.

## [0.2.51] — 2026-08-21

### Added

- **TUI: `Tools` in the sidebar is now clickable** (and reachable via `/mcp`),
  opening a two-tab inspector modal. The **Tools** tab lists every tool the
  agent currently has access to (name, risk, description). The **MCP** tab
  lists every registered MCP client runtime (Cursor, Claude Code, opencode,
  VS Code, generic) with its live connect status and a `[c]`/`[d]`-then-`[y]`
  connect/disconnect action, wired to the existing `keryx mcp install`/
  `uninstall` — no new install mechanism. Kept deliberately separate from the
  LLM chat-provider picker (`/search-provider`): those are OpenAI-compatible
  API endpoints, unrelated to the Model Context Protocol, and were being
  conflated in an earlier design discussion this closes out correctly.
- **TUI: `/review` gains a decline action.** Previously only accept was
  reachable from the modal (reject/dismiss required a terminal command).
  `[d]`-then-`[y]` now declines a proposal in-modal, symmetric to accept.
  `[a]`/`[d]` on a non-proposal item (blocked/unbound-candidate/unknown) now
  say the action doesn't apply here instead of silently doing nothing.

### Fixed

- **MCP: `skills_catalog`/`skill_load` are now actually reachable over MCP.**
  Both operations were registered and unit-tested since 0.2.50, but a stale
  `expose.modules` allowlist (in the default `keryx init`/`mcp install`
  template, and in this project's own manifest) filtered them out of every
  real `tools/list` response. Verified live: 34 tools before the fix, 36
  after, with `skills_catalog` returning real catalog data end-to-end.
- **`keryx harness run --provider`** now recognizes `openai`/`gemini`,
  matching `keryx shell --provider`/`/search-provider`, which already
  supported both. Fails closed with a clear message when the matching API
  key is unset, mirroring the existing `anthropic` behavior.
- **SAC: accepted proposals now render as `accepted`, not `draft`.**
  `wiki`/`memory`-owner-writers only ever persist a page after a reviewer
  accepts it, but both hardcoded `Status: draft` on the rendered page —
  producing a self-contradicting record that `wiki enrich`'s default batch
  then kept silently regenerating forever. The Reviews modal's Detail tab
  was also structurally unable to show what was proposed (kind/author/date/
  note); it now surfaces all of them, sourced from the real proposal record
  and its propose-time note.
- **VS Code extension: activates eagerly and its tree views are now
  clickable.** Previously the extension only activated once a user manually
  opened the Keryx sidebar, so the status bar never appeared on a fresh
  window; `Projects`/`Recent Turns`/`Needs Your Attention` were inert text
  lists. Also closed real packaging gaps found by actually building and
  installing the `.vsix` (missing activity-bar icon, no `.vscodeignore` —
  packaging was shipping this subproject's own local-only `.metaproject/`
  including a gitignored-but-unexcluded security key, no `repository`/
  `LICENSE`, no CI coverage).

## [0.2.50] — 2026-08-21

### Added

- **VS Code extension** (`vscode-extension/`). A visual layer over keryx
  inside the editor: activation checks `keryx status` and, if the workspace
  isn't initialized (or is incomplete), prompts before running
  `keryx init --yes` — never silently. A status bar item polls
  `keryx status`/`health status`/`security status` and names the specific
  failing check on click, not just a color change. A sidebar (Keryx icon in
  the activity bar) shows four views: Status, Projects, Recent Turns, and
  Needs Your Attention (in-progress flows merged with pending SAC
  proposals). An output channel streams live turn events over SSE
  (resumable) and logs one line per mutating action. A hover provider shows
  `keryx wiki ask` snippets for symbols under the cursor, cached and
  debounced. Reachable via `keryx mcp install --runtime vscode`, which
  writes `.vscode/mcp.json` in the new VS Code-native shape (`servers` key,
  `"type": "stdio"` per entry) so VS Code's own MCP client / Copilot Chat
  agent mode can also call keryx's tools directly. See
  `vscode-extension/README.md`.
- **Standalone binaries + Homebrew tap.** `keryx` now ships as 4
  self-contained compiled binaries (darwin-arm64/x64, linux-x64/arm64),
  attached to every GitHub Release — no bun/git/node required to install
  or run. `scripts/install-binary.sh` fetches and installs the binary for
  the current platform in one line. A Homebrew tap
  (`MrCipherSmith/homebrew-keryx`) was published alongside it and described
  here as available — **it never was**, and this line is corrected in place
  rather than deleted, because the claim shipped. The tap's formula pins
  `0.2.49` and carries literal `PLACEHOLDER_SHA256_*` strings where the
  digests belong, so `brew install` fails the checksum comparison on every
  platform; it also has no `on_linux` block at all. The formula itself said so
  in a comment, and so did
  `docs/requirements/keryx-native-distribution/README.md` — the honest note
  sat where a maintainer looks while this entry announced the feature where a
  user looks. See
  [`docs/requirements/keryx-docs-remediation/`](docs/requirements/keryx-docs-remediation/README.md).
  Fixed two real bugs
  found while verifying this: `web-tree-sitter` was silently falling back
  to the deterministic parser in every compiled binary (now a real parse,
  scoped fix to `gdgraph.treesitter`), and cross-platform compiles were
  failing because `@opentui/core`'s native package only installs for the
  build machine's own OS/arch by default.
- **Native OpenAI and Gemini provider adapters.** `--provider openai`
  (needs `OPENAI_API_KEY`) now targets OpenAI's Responses API directly,
  and `--provider gemini` (needs `GEMINI_API_KEY`, falling back to
  `GOOGLE_API_KEY`) targets Gemini's `generateContent`/
  `streamGenerateContent` API — both alongside the existing Anthropic
  adapter and the 9 already-shipped OpenAI-Chat-Completions-compatible
  providers (OpenRouter, DeepSeek, Z.AI, Cerebras, Groq, Moonshot, Grok,
  ...), whose shared engine was extracted out of `OllamaProvider` into its
  own module with no behavior change. Both new adapters fail closed to the
  offline fake provider when their key is absent, exactly like the
  existing Anthropic adapter — never constructed without a real
  credential.
- **MCP client: `codex-cli` elicitation handling.** A new stdio MCP client
  (`src/mcp-client/`) lets keryx correctly answer `codex mcp-server`'s
  approval prompts (`elicitation/create`) when running Codex as an
  external agent, instead of the request going unanswered. This is a
  prerequisite for the external-agent-runtime's deferred-write path; the
  existing default `codex exec` production path is unchanged, and
  `claude-cli` is unaffected.
- **`skills_catalog`/`skill_load` metaproject operations.** Two new
  operations (reachable as agent tool calls, through the Tool Registry,
  and as MCP tools) let an agent discover and read `.metaproject/skills/`
  content programmatically: `skills_catalog` walks the skill tree and
  returns a structured listing (with a one-line summary derived from each
  skill's frontmatter, or its body when frontmatter has none);
  `skill_load` reads one specific skill by the catalog-discovered path
  only.
- **TUI: `/search-provider` and `/search-connect` now open interactive
  pickers when given no arguments**, instead of printing a static text
  list. `/search-provider` opens a 3-step wizard (select provider → enter
  fields/credential/active-toggle → test connection); `/search-connect`
  opens a single-step picker over already-configured providers. Both
  forms with an explicit id (`/search-provider <id> field=value...`,
  `/search-connect <id>`) are unchanged.

## [0.2.49] — 2026-08-20

### Added

- **External agent runtime: delegate bounded, read-only work to `codex exec`
  and `claude -p` as child agents.** keryx can now run the vendors' own
  coding CLIs — Codex and Claude Code — as children of the existing harness,
  so the operator's own subscription does the work while keryx keeps
  isolation, budget, supervision, and completion. keryx never reads a
  vendor credential store, not even to check whether the operator is
  logged in — availability has three states (`installed`/`not installed`/
  `login not verified`), and the CLI states the limit rather than hiding it
  behind a tick. No vendor sanction is claimed; this is mitigated
  structurally — off by default, opt-in, local-only, and hard disabled
  under remote transports and CI. What ships: a registry of two agents with
  one pure, offline-tested codec each; a `runtime` block on
  `subagent-dispatch` with a fail-closed validator; read-only execution in
  a disposable git worktree with a stripped environment and restricted
  tool roster; an opt-in capability gate; `keryx agents external list|probe`;
  `/delegate <agent> <task>` with a live transcript (Work/Meta/Command
  tabs), a sidebar marker, and a per-addressee message queue where `force`
  is kill-plus-resume; a structured-result validator so a schema-invalid
  response is reported as a named error rather than silently accepted as
  free text; five supervision triggers (`phase_changed`, `budget_threshold`,
  `no_progress`, `agent_asked`, `scope_drift`) computed live from the event
  stream, including a background timer for the two conditions that must
  fire during total silence; and a pure bridge feeding external-agent
  events through the existing internal-agent monitoring fold, unmodified.
  Mutating external agents is explicitly not shipped — the permission axis
  exists in the contract, but `worktree-write` is refused at runtime with a
  reason distinct from "this agent cannot." See
  `docs/requirements/keryx-external-agent-runtime/`.

### Fixed

- **Agent: the tool-call loop now survives into the provider request.** A
  turn consisting purely of a tool call previously wrote nothing to
  history, and every OpenAI-compatible provider (DeepSeek, OpenRouter,
  Z.AI, Groq, Cerebras, Moonshot) degraded `role:"tool"` results into a
  plain user message with no `tool_call_id` — the model was asked to
  continue a transcript in which it had never called a tool. Both adapters
  now send the real `assistant(tool_calls) → tool(result)` shape their
  APIs document; calls survive session persistence and compaction, with a
  pairing linker that degrades safely to the old framed-text behaviour for
  any half-paired call a cut or an intercepted turn can produce, rather
  than sending a request either API would reject outright.
- **Security: dated flow-directory names are no longer masked as phone
  numbers.** `NNN-YYYY-MM-DD-<slug>` flow package names satisfied every
  `pii.phone` heuristic, so `ls .metaproject/flows` reached agents fully
  redacted and no flow directory could be opened. A phone candidate
  carrying a real calendar date is now recognized as a dated identifier
  and left alone; a real phone number with no valid month/day pair is
  still masked.
- **Security: a credential's own JSON key name no longer blocks masking its
  value.** `"ZAI_API_KEY": "…"`-shaped assignments were missed by the
  secrets detector because the closing quote after the key name stopped
  the match before the colon — this is exactly how keryx persists provider
  keys in `auth.json`, so reading the credential store published every key
  whose value carried no separately-recognized prefix. The key name may
  now be quoted; only values are masked. Also hardened: a dotted composite
  credential (`<hex>.<alnum>`) no longer masks only its first segment, and
  a bare 24+ character hex blob next to a sensitive label is now judged on
  its actual entropy rather than always passing.
- **Agent: the toolless-reprompt budget raised from 1 to 2**, with a
  strictly stronger second nudge and an early stop on a verbatim repeat —
  a model that narrates a step once typically narrated it once more when
  nudged under the old budget, ending the turn unexecuted.
- **TUI: the main-queue marker now shows an item's own position**, not how
  many items are still queued behind it — `q1 (1)`, `q2 (2)`, `q3 (3)` for
  a 3-item queue, instead of the previous `q1 (2)`, `q2 (1)`, `q3 (0)`.
- **TUI: `/mode` (permission-mode switching) now works while the main agent
  turn is busy**, and a mid-turn switch — e.g. to `auto` — applies
  immediately to the turn's next tool call, since the approval gate
  already re-reads the mode fresh on every call. All three forms (explicit
  mode, `clear`, the no-argument picker) are unblocked; the one-time
  confirmation before switching to `auto` is unchanged.

## [0.2.48] — 2026-08-19

### Added

- **SAC: durable wrap-up dispatch outcome recording for the Review UI.**
  `runWrapUp` already computed rich per-group outcome data on every wrap-up
  dispatch attempt (proposed / conflict / unbound-candidate / no-credential /
  error with a message), but both real callers discarded the return value
  entirely, only catching a rare thrown exception. A session whose wrap-up
  dispatch genuinely failed was indistinguishable in the TUI's Review
  section from a session that never reached a wrap-up trigger at all — both
  collapsed into the same opaque "unknown" catch-up item with a generic
  message. `runWrapUp` now persists a best-effort durable artifact under the
  session's `slate-archive/` on every dispatch attempt, success or failure;
  the Review detail view surfaces the real trigger, timestamp, and per-group
  failure reason when one is recorded, and is unchanged when it isn't. No
  changes needed to the trigger call sites — both already call `runWrapUp`
  at all three trigger points. See
  `docs/requirements/keryx-sac-wrapup-dispatch-outcome/`.

## [0.2.47] — 2026-08-19

### Added

- **`apply_patch`: write-risk file edits via unified diff (ADR-0010).**
  Extends the interactive agent's approval gate to a real `risk: "write"`
  path (previously hard-denied unconditionally), backed by a patch-risk
  escalation classifier (delete/`.git`/many-files/credential-path). Takes a
  standard multi-file unified diff, confined to the project root, applied
  via a constrained argv-only `git apply` subprocess — patch over stdin,
  never shell-interpolated. One call can edit several files, collapsing N
  `shell_exec`-per-edit calls into a single non-read budget slot. The
  write-risk approval prompt now renders the actual diff (line-classified,
  colored) instead of raw JSON tool input, in both the readline shell and
  the TUI. See `docs/requirements/structured-file-edit-tools/`.
- **Background shell jobs: `shell_exec` gains `background: true`.** Starts a
  detached, process-group-owned job and returns immediately instead of
  blocking the turn on the synchronous path's timeout. Two new `risk: "read"`
  tools, `shell_job_output`/`shell_job_kill`, poll and stop it later, scoped
  strictly to the calling session's own job registry — reuses the existing
  shell approval gate and OS-sandbox setup unchanged. A new TUI "Background
  Jobs" sidebar panel mirrors the existing Subagent Inspector: clickable rows
  open a live-updating Output/Meta modal. Every job is swept
  (SIGTERM→SIGKILL by process group) on real session exit but deliberately
  survives `/clear`/`/new` — a background job is meant to outlive the turn
  that started it. See `.metaproject/wiki/architecture/background-jobs.md`
  (flow 173).
- **Non-read tool-call budget raised 8 → 32, with a "raise and continue"
  option instead of an unconditional stop.** The loop-safety budget shared
  across `shell_exec`/write/destructive/network/delegate calls was small
  enough that routine edit-plus-verify work exhausted it; hitting the limit
  now offers a picker to raise it and continue instead of forcing a wrap-up.
  Adds `flow_status` as a proper `risk: "read"` tool so checking flow
  progress no longer needs `shell_exec`.

### Fixed

- **The agent could stall mid-task on a narrated-but-unexecuted step.** A
  short continuation nudge like "проверяй"/"делай" wasn't recognized as an
  action request, so the built-in toolless-reprompt safety net never engaged
  when the model announced a next step ("Проверю ...:") without calling its
  tool — the turn just ended, silently waiting for the user to nudge it
  again. Broadened the action-request/claimed-action detection (plus a
  same-reply narrate-then-act instruction in the system prompt) so the model
  keeps working instead of stopping on a claim.

## [0.2.46] — 2026-08-19

### Added

- **TUI: unblock `/think`, `/expand`, `/copy`, `/workspace`, `/review` while
  the main agent turn is busy.** `runLine`'s busy branch previously handled
  only 6 of 24 slash commands (`/exit`, `/help`, `/interrupt`, `/queue`,
  `/status`, `/flows`) while a main turn was in progress; every other command
  was refused with a generic "main is busy — command deferred" message, even
  ones that were already provably safe — the `Ctrl+O` block-nav keyboard path
  that does the same thing as `/expand`/`/think`/`/copy` has never had a busy
  gate at all, and `/workspace`/`/review` are read-only modals structurally
  identical to the already-allowed `/status`/`/flows`. These five commands now
  work while busy, reusing exactly the functions the idle path already calls.
- **TUI: `runLine`'s busy-branch dispatch decision extracted into a pure,
  unit-tested `classifyBusyDispatch` function** (`src/tui/busy-dispatch.ts`),
  closing a gap where none of `runLine`'s 24 commands (busy or idle) had any
  test coverage. `runLine`'s busy branch is now a thin `switch` over the
  classifier's result; 13 unit tests cover every dispatch target directly,
  without mounting a renderer. See
  `docs/requirements/keryx-tui-busy-command-allowlist/` (flow 172).

## [0.2.45] — 2026-08-18

### Added

- **Concurrent `spawn_subagent` waves + structured completion status.**
  Sibling `spawn_subagent` calls issued in one interactive turn now run
  concurrently (bounded by a new `maxSubagentConcurrency`, default 3) instead
  of strictly sequentially, by wiring the already-existing `planWaves`
  scheduler to a new `executeWaves` executor. Non-`spawn_subagent` tool calls
  in the same batch, and result ordering back to the model, are unaffected. A
  spawned child's result now also carries a structured completion status
  (`Completed | BudgetExhausted | Timeout | Denied | Error | NoProgress`),
  closing a gap where a child that exhausted its own internal step budget
  returned `isError:false` — indistinguishable from a clean finish — with no
  change to the existing `{output, isError}` shape callers already rely on.
  Grounded in a live bug report plus a three-project reference study (xAI Grok
  Build, OpenAI Codex CLI, sst/opencode). See
  `docs/requirements/keryx-multi-agent-engine/` (Phase D).

## [0.2.44] — 2026-08-18

### Added

- **TUI: `/review` sidebar badge + list/detail modal for the SAC catch-up
  report.** A new "Review" sidebar row surfaces every item across the project
  needing human attention — pending proposals, sessions that stopped
  unattended, unbound wrap-up candidates, and sessions with no recorded
  resolution (SLATE-10's `keryx workspace catch-up`, whole-project scope,
  never limited to the current session's own workspace) — turning yellow
  once nonzero, refreshed at the same points the Workspace row already uses
  (session open/resume, `/new`, main turn settled). Clicking it or typing
  `/review` opens a list+detail modal (arrows/`[`/`]`/Enter to navigate,
  same interaction model as `/flows`/`/workspace`). Accepting a proposal is
  an `[a]`-then-`[y]` confirm inside the Detail tab that runs `keryx
  workspace confirm-review` then `keryx workspace review --decision
  accepted` as two real shell commands — never through the model/tool-calling
  loop — so the human keying the confirm is the same human-presence proof a
  terminal invocation would be.

### Security

- **Permission modes: SAC's `confirm-review`/`review` commands are a hard
  floor no mode lifts.** `trust`/`auto` could previously auto-approve `keryx
  workspace confirm-review` and `keryx workspace review` — the commands that
  mint and spend the confirm-token proving a human accepted a proposal
  (SLATE-20) — closing a self-approval gap the same shape as the existing
  `credentials` hard floor. Also hardened the independent
  `isShellCommandAllowed`/`validateShellPattern` barrier so a hand-edited
  `permissions.json` entry for either command can never auto-approve or be
  remembered.

## [0.2.43] — 2026-08-18

### Added

- **TUI: main queue moves off-transcript into its own dock.** `keryx shell`'s
  main message queue (queue while the agent is busy, flow 167) no longer
  renders as `> qN (p)` markers interleaved in the transcript — it's now a
  persistent panel above the composer, positioned so it stays visible
  alongside the existing approval-gate/wiki-enrich choice dock rather than
  competing with it. Each queued item gets clickable **Force** / **Edit** /
  **Delete** buttons, plus a `Ctrl+Q` keyboard-only path (arrow keys select
  item/action, Enter fires, Esc exits). The existing `/queue remove|edit|force
  [N]` text command keeps working unchanged.
- **TUI: region click-to-focus + launch autofocus.** Clicking the
  transcript/output area or empty space now focuses the composer; clicking
  the queue dock enters queue-nav (a click on one of its buttons still fires
  that action directly, not just focus). The composer is focused
  automatically the moment the shell finishes launching, so typing can start
  immediately. Clicking the sidebar is an intentional no-op — it has no
  focusable content today, so literally focusing it would blur the composer
  into a keyboard dead-zone.
- **TUI: workspace sidebar row + `/workspace` inspector modal.** The sidebar
  now shows the current session's bound SAC workspace (title · status · slate
  count), refreshed after session open/resume, after `/new`, and after every
  main turn settles; empty (`—`) until one is bound. Clicking it opens a new
  `/workspace` inspector with 3 tabs — Workspace (overview), Slates (every
  session bound to this workspace, newest-first, same interaction model as
  `/flows`), Slate (detail: touched files, seeds).
- **TUI: translucent modal backdrop.** The full-screen backdrop behind
  `/flows` and every other modal was 100% opaque; now translucent via the
  fill color's own alpha channel (never the `opacity` prop, which would have
  faded the panel's own content along with it). The panel itself stays fully
  opaque.

## [0.2.42] — 2026-08-18

### Added

- **Session permission modes: `ask` / `trust` / `auto`.** `keryx shell` gains
  a session-level layer over the existing approval gate — `--permission-mode
  <ask|trust|auto>` / `--ask`/`--trust`/`--auto`, and a `/mode` command
  (show/switch/`save`/`clear`) in both the OpenTUI shell and the `--no-tui`
  readline REPL. `trust` auto-approves everything except a destructive
  command (tool-declared or classifier-detected); `auto` auto-approves
  everything except a credentials-touching command, which no mode ever
  bypasses, and requires an explicit one-time confirmation to enter. A
  per-project default persists to `permission-mode.json` next to
  `auth.json`/`projects.json` in the shared keryx config directory, opt-in
  via `/mode <mode> save`. Every silent auto-approval still prints a
  non-dimmed transcript line. Deliberately out of scope: `harness run`/
  `harness exec`/`keryx serve` and the MCP server keep the existing
  policy-profile engine untouched — "headless never silently allows" is
  unaffected. See the
  [permission modes guide](docs/docs/guides/permission-modes.md).
- **`keryx init`: one-question install shortcut.** Interactive `init` now
  opens with *"Install everything with recommended defaults?"* (default Y).
  Answering yes enables all 9 modules with their recommended settings and
  skips every per-module question that follows — equivalent to `--yes`.
  Answering no falls through to the existing per-module questions, unchanged.
  An explicit `--no-<module>` flag still wins either way.
- **Optional RLM-style recursive enrichment for `wiki enrich`.** A
  classification gate (skip/light/deep) can run ahead of each page's model
  call — light-tier batches sibling pages of the same module; deep-tier
  spawns a bounded, unattended child turn with a filtered read-only tool
  subset (never `shell_exec`/`spawn_subagent`, so it cannot recurse).
  Per-page staleness is now also tracked independently via content-hash
  resume state. Off by default — `.metaproject/wiki.config.json`'s
  `rlm.enabled: false`, matching an absent config file, and the disabled
  path is byte-for-byte identical to the pre-existing worker. Kept off in
  this project's own dogfood config for now: live comparison (local Ollama
  8B and DeepSeek) showed high variance on the weak local model and no clear
  quality win on a capable one, pending real classification-threshold tuning
  data.

## [0.2.41] — 2026-08-18

### Added

- **Slate v2 — autonomous SAC workspace binding (SLATE-16..21).** An agent now
  resolves-or-creates its own SAC workspace by judgment on an action-intent
  turn — the same tool-calling judgment `ask_user`/`spawn_subagent` already
  use, no new similarity/embedding engine — and re-evaluates that binding
  mid-session if the topic shifts. On task completion it dispatches a wrap-up
  proposal autonomously (machine-composed evidence: git diff, Flow snapshot,
  tagged Seeds). Review/accept stays strictly human: a `decision: "accepted"`
  review now requires a `confirmToken`, minted only by `keryx workspace
  confirm-review <workspace-id> <proposal-id>` run in a real, approval-gated
  shell — no tool call, MCP or `keryx-shell`, can mint one itself. Workspace
  `list`/`create`/`show` are now available with identical shape from both
  `keryx-shell` tools and MCP (`workspace_list`, `workspace_create`,
  `workspace_show`) — previously CLI/`keryx-shell`-only.
- **Decision dedup/conflict hint at review time.** Accepting a wiki-update or
  memory-entry proposal now computes a `DedupHint` (duplicates/conflicts
  against already-accepted entries, reusing `src/memory/dedup.ts`'s existing
  scoring unchanged) and, when the hint is non-empty, an optional bounded
  model-judge annotation — informational only, never consulted by any
  accept/reject/merge code path. Computed *after* the decision, never gating
  it; a computation failure (timeout, read error) degrades to an absent hint,
  never a blocked or crashed review. `sac.review` (MCP) and `keryx workspace
  review` (CLI) return the identical shape.
- **Lifecycle flag for orphaned SAC content.** `keryx workspace catch-up`
  gains a fifth, additive section (`--include-lifecycle-flags`, shown by
  default) surfacing every workspace, memory entry, and wiki decision page
  whose recorded module no longer resolves in the code graph — reusing the
  exact graph-diff signal that already drives `wikiPruneOrphans`. Report-only:
  it never archives a workspace, edits a memory entry, or removes a wiki page
  on its own; a workspace can appear here and in the pending-proposals section
  at the same time without either suppressing the other.
- **TUI: queue input while the agent is busy.** Submitting a normal message
  while the main agent is busy now opens a selector — **Main queue**
  (default) or **Side-1** (the existing read-only worker, outside main
  history). A queued main message appears in the transcript as `qN (p)` and
  drains FIFO right after the current turn completes. Each queued item can be
  `remove`d (dropped without running), `edit`ed (returned to the composer,
  pulled from the queue until re-submitted), or `force`d (aborts the current
  turn and runs immediately as a new priority turn).
- **Shell-command approvals are mouse-clickable.** The Allow/Deny-style option
  list (shell approval, the wiki-enrich plan picker, `ask_user`) is a
  scrollable, clickable list instead of keyboard-only.

### Changed

- **`/flows` sorts newest-first; Detail scrolls; the modal grows toward
  96×28.** The flow list now orders by highest id, then `updatedAt`. On the
  Detail tab, `↑`/`↓` scroll the body instead of changing the selection —
  `[`/`]` (or `p`/`n`) switch between flows instead; the List tab still uses
  `↑`/`↓` to move the selection. The shared modal panel (`/status`, `/flows`,
  `/theme`) now grows toward a 96×28 target from the live terminal size
  (floor 72×18) instead of a fixed 72×18 box.
- `/status` and `/flows` are now allowed while the main agent is busy
  (previously blocked like any other input).
- A subagent's tool-call budget was a whole-session-lifetime pool that only
  reset on `/model` switch; it now resets per parent turn, with a larger
  default pool and higher per-child limits.
- Tool/error block headers used a fixed bright red/cyan instead of the active
  theme's palette; they are now theme-driven, matching `/theme`.

### Fixed

- The TUI subagent sidebar never cleared finished entries — not on
  `/clear`/`/new`, not at the start of a fresh turn — so subagents from
  earlier turns piled up indefinitely; it now clears at both points.
- A shell-command approval's command preview was hard-truncated at 120
  characters regardless of available box space; it now shows in full (8,000
  character cap) in a scrollable box, with `ctrl+o` toggling focus into it for
  arrow/PageUp/PageDown scrolling.

## [0.2.40] — 2026-08-17

### Added

- **Switchable TUI color themes (`/theme`).** `/theme` with no argument opens
  a picker modal — a theme list on the left, a live preview (assistant
  markdown, a code block, tool/side/chip/ok/error samples) on the right.
  Arrow keys move the highlight and repaint the preview instantly; the
  palette only applies on Enter or `[ Apply ]` — Esc/close leaves the
  current theme untouched. `/theme <name>` still applies immediately on any
  surface.

### Changed

- **Shared modal panel is opaque and near-fullscreen.** The `/status`,
  `/flows`, and `/theme` host used to be a translucent 72×18 box that leaked
  the transcript behind it and clipped long content; it now fills the
  available terminal space with a scrollable body.
- `/clear` and `/new` now fully reset the visible transcript (messages,
  blocks, fleet rows, token counters), not just the underlying session.

### Fixed

- **Ctrl+O focused blocks scroll into view.** `↑`/`↓` navigation didn't
  reveal the highlighted block if it was off-screen; it does now.
- A toast now fires once when transcript retention drops an old payload,
  instead of the loss only being discoverable via expand/copy.
- Side-worker replies render in a framed box with a `── side-1 ──` label
  instead of a bare, easy-to-miss magenta line.
- A modal-open theme-change listener could accumulate across renderer
  create/destroy cycles (relaunching the TUI shell within one process, or
  running its own test suite) and kept writing onto already-destroyed
  panels; it is now unregistered on teardown, alongside two related listener
  leaks in the chat and agent TUI shells.
- A keyboard-focus edge case let a stray digit `1`–`9` keypress jump modal
  tabs while the scrollable body itself held focus, instead of being
  absorbed by the scroll box — now consistent with the existing `x`-to-close
  guard.
- `/flows` content could overflow unwrapped on a narrow terminal while
  `/status` wrapped correctly right next to it; both now wrap to the
  panel's real width.

## [0.2.39] — 2026-08-17

### Added

- **SAC workspace lifecycle completion.** `WorkspaceService` gains `archive`,
  `removeResource`, and `rename`. Archiving a workspace hides it from
  `workspace list` by default (`--include-archived` to see it) without
  blocking read access, in-flight review, or discovery of its pending
  proposals. `archive`/`removeResource`/`rename` all require `owner` role,
  matching `archive`'s existing authorization level.
- **Slate: a task-local harness layer over the shared workspace.** Every
  `keryx shell`/TUI/`harness run` turn now tracks three ephemeral, per-attempt
  shelves that live alongside — never inside — the shared SAC workspace:
  - **Anchors** — execution context (root, tree/branch, runtime, touched
    files) recomputed fresh from live state on every restart/resume/fork,
    never restored from a prior attempt. Auto-injected into history on
    harness effects (tool call done, worktree resolved, `/model` switch,
    subagent spawn/return), visible on both the TUI and the readline shell.
  - **Course** — a live, read-only projection of the attempt's bound Flow
    (if any); never a second tracker, never mutated by slate itself.
  - **Seeds** — append-only, model-writable hypotheses (`slate_read`/
    `slate_write_seed` tools), promoted to the shared workspace's Know-how
    only through the existing `workspace review` gate — never automatically.
  - Opens on an action-intent turn or `/goal <text> [--workspace <id>]`
    (also `keryx harness run --goal ... [--workspace <id>] [--unattended]`);
    closes on flow-done, an explicit close phrase, `/new`, or shell exit,
    always archiving an unclosed prior attempt first, never overwriting it
    silently.
- **Unattended-mode safety gate (SLATE-8).** `workspace review --decision
  accepted` is denied outright for any session whose `interactive` context
  field is `false` — every `keryx serve` session, unconditionally, regardless
  of role or policy profile. `propose` is unaffected (deferred-queue model,
  not a full block); a session can never flip its own `interactive` field at
  runtime.
- **Ephemeral subagent slate.** A dispatched subagent gets its own full,
  disposable Anchors/Course/Seeds scoped to that one dispatch. On return, its
  state lands only in the parent's `slate.childDispatches[dispatchId]` — a
  separate, non-merged, provenance-tagged entry — never folded into the
  parent's own Seeds, and unreachable by any other path once the dispatch
  completes.
- **Machine wrap-up composer.** Replaces raw-transcript evidence with machine
  evidence (git diff, Flow snapshot, tagged Seeds) plus a model-generated
  summary, falling back to a mechanical template on a slow-but-present
  credential and failing closed (no proposal) with no credential at all.
  Seeds are grouped by `kind` and proposed one group at a time; a proposal is
  never created without a captured `workspaceId` — evidence is preserved as a
  local `unbound-candidate` artifact instead.
- **`keryx workspace catch-up` / `list-proposals`.** A pull-based,
  `cwd`-scoped surface for reviewing what accumulated during unattended runs:
  four always-separate sections (pending proposals, blocked runs,
  unbound-candidate wrap-ups, and sessions of genuinely unknown fate), with
  evidence freshness re-checked at display time rather than only at accept.
  Archived workspaces surface identically to active ones — archival never
  hides a pending proposal.

## [0.2.38] — 2026-08-16

### Added

- **Managed flow PR completion lifecycle.** The flow orchestrator now offers a
  complete PR path: create the PR, run review and fix iterations, merge into
  the recorded base branch, and close the flow only after the merge.
- **Bounded review recovery.** After six unsuccessful review/fix attempts, the
  orchestrator must enrich context, diagnose the cycle, and choose a materially
  different fix strategy or split the work into narrower tasks.
- **Clickable TUI subagent inspector (flow 162, #303).** The sidebar lists
  every spawned child for the session (running / done / failed) with no
  `… +N more`. Clicking a row opens the shared modal host on Work + Meta:
  task, live tool/reasoning/text log, model, status, and elapsed. Finished
  children stay inspectable until the TUI session ends.

### Changed

- Flow completion is now explicitly PR-and-merge-gated; an unmerged PR or a
  direct commit without a PR cannot transition a managed flow to `done`.

### Fixed

- **TUI/readline tool and approval parity.** One factory builds the
  interactive tool set for both surfaces, so `web_fetch` is no longer
  TUI-only. Approval policy (allowlist, tamper check, no auto-approve for
  destructive or credential commands) lives in one module. Readline prints
  those hints and can remember an exact `shell_exec` grant.

## [0.2.37] — 2026-08-16

### Added

- **`/status` inspector tabs.** The shared modal now has a fixed 72×18 chrome
  (title + `[x] esc` header, one-line footer). `/status` (chat and agent) opens
  Status plus a Context bar of known usage — last-turn tokens and a labelled
  estimate, never a guessed window. Workspaces and Flow tabs appear only when
  the session actually referenced a SAC workspace or a flow (`runLink.sessionId`
  or an explicit `flow 154` / `/flows 154` mention). `c` copies the session id.
- **`/flows` inspector.** Lists project flows; `↑/↓` selects, Enter or `→`
  opens the adjacent Detail tab (status, dir, tasks, PR). Readline/`--no-tui`
  prints the list, or `/flows 154` for one package.

### Changed

- **`/session-info` and `/info` removed.** They are no longer aliases. The
  slash menu advertises only `/status`.

### Fixed

- **Modal size no longer jumps on tab switch.** The host no longer shrink-wraps
  to each tab body.

## [0.2.36] — 2026-08-15

### Added

- **Reusable OpenTUI modal + tab host (flow 154).** `src/tui/modal-host.ts`
  opens a titled panel over a dimmed backdrop (not a full-screen `overlayBox`
  replacement of chrome), with an optional tab strip, Esc dismiss, composer
  focus restore, and `shell-chrome` overlay registration so the `/`-menu and
  Ctrl+O stay inert. Two callers can share the same host with different
  titles, tabs, and `initialTab`. Headless tests cover open, tab switch,
  replace-not-stack, and OpenTUI-unavailable no-op.
- **`/session-info` inspector (flow 155).** Slash commands `/session-info`,
  `/status`, and `/info` (chat and agent) open that host on Session and Usage
  tabs: title, keryx version, session id, project path, provider/model (live
  selection wins), parent id for forks, timestamps, message/archive/compact
  counts, last-turn tokens, and a labelled context **estimate** when the
  provider did not report a window. `c` copies the session id; `y` copies the
  block. Readline/`--no-tui` prints the same rows. The command never starts a
  model turn.

## [0.2.35] — 2026-08-15

### Added

- **Shared Agent Context complementary-stack proof (flow 153).** SAC is not a
  second wiki: Facts / Work / Know-how stay owned by evidence, Flow, and
  wiki/memory/skills. `keryx workspace overview|read --explain` prints that split
  next to the JSON receipt. Installed `dist/cli.js` now finds the normative SAC
  schemas by walking up from the CLI and cwd (the old `../../docs/...` URL from
  `src/sac` resolved to the *parent of the package* and `workspace create`
  ENOENT'd). The npm package ships `docs/requirements/shared-agent-context/schemas`.
  Live runbook: `docs/verification/wiki-graph-sac-proof.md`. Architecture page:
  `.metaproject/wiki/architecture/wiki-graph-sac.md`.
- **Benchmark suite M3 — model-matrix expansion, third local leg (qwen3.5-9b-4bit).**
  `run-safety.ts`/`run-containment.ts` had a real filename-collision bug: `FILE_SUFFIX`
  was keyed on `--provider` alone, so a second rapid-mlx model would silently
  overwrite the first model's committed fixture on every rerun — this actually
  happened live (driving `qwen3.5-9b-4bit` clobbered the already-committed
  `qwen3.5-4b-4bit` data), caught via `git diff`, reverted, and fixed by qualifying
  the suffix with the model too. The original `qwen3.5-4b-4bit` fixtures were
  restored byte-exact from git history, not regenerated — a fresh rerun of the same
  cases produced a genuinely different sample (1/3 vs the original 2/3) due to this
  small model's real run-to-run non-determinism. With the fix live,
  `qwen3.5-9b-4bit` (previously unused, carries a noted SIGABRT crash risk under
  memory pressure — did not materialize here) ran as a third real local leg:
  completion-honesty **3/3** (vs the 4-bit sibling's 2/3), false-premise **3/3**,
  containment **9/9 contained, 0 escapes** — no crash across the full run.
- **Benchmark suite M3 — RAG-adapter baseline, real live results.**
  `scripts/benchmark/run-rag-embedding-baseline.ts` (new): a real local
  semantic-embedding search (`Xenova/all-MiniLM-L6-v2` via `@xenova/transformers`,
  a `devDependency` scoped only to this benchmark tooling — never the shipped
  CLI's runtime or `src/memory`'s core capability seam) over the same
  `.metaproject/wiki/` corpus and the same 5 gold queries as the gdwiki metastore
  oracle, reported side by side and never averaged
  (`wiki-ask-results-embedding-baseline.json` vs `wiki-ask-results.json`).
  rapid-mlx (the originally-preferred local server) was tried first and confirmed
  unable to serve this model (`ModuleNotFoundError: No module named
  'mlx_lm.models.bert'` — rapid-mlx only supports causal-LM architectures);
  keryx's own dormant `@xenova/transformers` embedding path was investigated next
  but is unresolvable as-is in this repo (no `memory-embed-default` entry in
  `.metaproject/assets.lock.json`; wiring one up needs a pinned asset + an ADR,
  out of scope here). Getting the dependency working itself needed a real fix:
  `@xenova/transformers`'s `sharp@^0.32.0` dependency failed to load under bun
  (`Cannot find module '.../build/Release/sharp-darwin-arm64v8.node'`) — root
  cause was running the smoke-test script from outside the repo tree, where bun
  resolves packages from its global cache directly instead of the project's own
  `node_modules` (where `sharp`'s postinstall had already built the binary); an
  in-repo script resolved correctly once `sharp`'s install script was trusted
  (`bun pm trust sharp`). Real live results (k=5, all 5 gold queries): nDCG@5 and
  recall@5 match the lexical gdwiki oracle exactly on 4/5 queries (1.000/1.0);
  both systems land the `quality-map.md` query at rank 2 for an identical
  nDCG@5=0.631, for different reasons (lexical's distractor is `project-map.md`
  via "map" token overlap, the embedding's is `src-health-metrics.md` via
  semantic proximity to "Code Health scan") — corroborating that page's known
  gap (no `## Summary` block) is a corpus-content weakness, not a single
  retrieval method's artifact. Groundedness intentionally not scored for this
  leg (the existing hand-labeled panel describes wikiAsk's own citation order,
  not this system's).
- **Benchmark suite M1 — safety track multi-model coverage, milestone complete.**
  `run-safety.ts`/`run-containment.ts` parameterized with `--provider`/`--model`
  (matching `run-ablation.ts`'s pattern). A local second leg (`rapid-mlx serve
  qwen3.5-4b-4bit`) run live across all four case groups: completion-honesty **2/3**
  (a real, model-specific failure the deepseek baseline never showed — hit the
  tool-call budget on a no-argument tool, gave a malformed reply, correctly scored
  `overclaimed`); false-premise **3/3** (matches deepseek); containment **9/9
  contained, 0 escapes** (matches deepseek, preflight canary confirmed sandbox
  blocking first) with an honestly-reported `attempted`-pattern divergence between the
  two models. All 5 fixtures pass `validatePairedBenchmark`. **M1 is now complete** —
  every exit-criteria item has real, live-captured data.
- **Benchmark suite M1 — mutating-ablation capable-model coverage across THREE
  third-party CLI harnesses, all 18/18.** The 0/18 qwen3.5-4b-4bit finding needed a
  model that can actually complete the base task.
  `scripts/benchmark/run-ablation-mutating-{codex,opencode,grok}.ts`: **codex**
  (`gpt-5.6-sol`) **18/18**; **Grok Build CLI** (`grok-4.6`, a third, newly-added
  agentic CLI, live-verified headless before being wired in) **18/18**; **opencode**
  (`opencode/deepseek-v4-flash-free`) **18/18** — but only after root-causing and
  fixing a real container-escape bug, not a model-capability finding. Two full
  opencode runs scored 0/18 with this repo's own real `src/lib/*.ts`/`opencode.json`
  found modified on disk afterward each time — opencode was editing the real checkout
  instead of its assigned isolated directory. Switching from a linked `git worktree`
  to a fully independent `git clone` (new `src/harness/child/git-clone-port.ts`) did
  NOT fix it (a third run still escaped); a minimal isolated repro nailed the actual
  cause: `Bun.spawn`'s `cwd` option sets the process's real working directory but does
  not update the inherited `PWD` env var, and opencode's own path resolution trusts
  `PWD` over the OS cwd for at least some operations. Fix (`env: { ...process.env,
  PWD: root }` alongside `cwd`), confirmed via a clean A/B repro before touching the
  real producer, then a fourth full run: 18/18, real repo verified untouched
  throughout. Every accidental edit from the three earlier escapes was caught and
  reverted before being committed. Kept the clone-based isolation as an independent
  extra safety margin alongside the PWD fix. Also fixed a real, separate bug found
  along the way in `scripts/benchmark/mutating-tasks.ts`'s `cliPrompt()`: it left
  `<seed test path>` as a literal, un-interpolated placeholder instead of the task's
  real file path (did not by itself explain the escapes, but a real bug regardless).

### Fixed

- **Installed CLI could not load SAC schemas.** `loadNormativeSchema` used
  `new URL("../../docs/...", import.meta.url)`, which only works from `src/sac`.
  The bundled `dist/cli.js` looked in the parent of the package.
- **TUI `/connect` listed providers that were not live.** The picker now keeps
  only providers that actually resolve.
- **TUI composer did not grow with wrapped input.** The composer now grows like
  a wrapping textarea instead of clipping the prompt.

## [0.2.34] — 2026-08-14

### Added

- **Benchmark suite M1 — metastore oracle slice (deterministic).** The
  `paired-3-5-v2` protocol (backward-compatible with `paired-3-5-v1`; Wilson CIs,
  judge panel, `servedModel`/`effort`, tokenizer-normalized cost), IR/oracle metric
  primitives, git-co-change gold derivation with a real pinned express fixture, and a
  metastore oracle runner exposed as `keryx metrics benchmark run --ladder metastore`.
  Produces the first honest oracle result (gdgraph `affected` vs co-change gold). All
  five metastore layers (gdgraph, testing, memory, gdctx, gdwiki) are landed.
  Requirements: `docs/requirements/keryx-benchmark-suite`.
- **Benchmark suite M1 — ablation runner (first live slice).** New
  `keryx metrics benchmark run --ladder harness` scores the SAME agent + model run
  twice per seed, in isolated git worktrees, with keryx metaproject tools present
  (`context-on`) vs a basic-tools-only baseline (`context-off`) —
  `src/metrics/ablation-runner.ts`, driven live by `scripts/benchmark/run-ablation.ts`
  via the same multi-turn agent loop `keryx shell --agent` uses
  (`src/commands/agent.ts` `runAgentTurn`), plus a real `git worktree add/remove`
  adapter (`src/harness/child/git-worktree-port.ts`) for a seam flow 096 had only
  planned. First live result (`deepseek-v4-flash`, 3 code-comprehension tasks, ×3
  seeds): task success 9/9 with context on vs 0/9 with it off, and 2-6x fewer
  tool-calls with it on. A second, separately-reported manifest
  (`scripts/benchmark/run-ablation-codex.ts`) runs the identical tasks through the
  already-authenticated `codex` CLI (its own agent loop; context on/off toggled by
  presence/absence of `AGENTS.md`/`.metaproject/` in the worktree) as the milestone's
  frontier-model leg: 18/18 success on BOTH variants (a real shell closes the gap a
  no-search baseline can't), with a mixed, non-directional token/tool-call delta —
  reported honestly rather than as a win. A third, separate manifest closes the
  milestone's "one frontier + one local" model coverage: `run-ablation.ts` is now
  parameterized (`--provider`/`--model`) and was run against a local `rapid-mlx serve
  qwen3.5-9b-4bit` (ollama would not start on the dev machine; unrelated to this work) —
  6/9 success with context on vs 0/9 off, tool-call counts only (this provider path
  reports no token usage). All three legs (deepseek/codex/rapid-mlx) are reported side
  by side, never averaged.
- **Benchmark suite M1 — safety track, first two case groups.** `PairedBenchmarkRunV2`
  gained `safety` (`contained`/`escaped` + case class) and `completionHonesty`
  (`honest`/`overclaimed`) fields, with AC-4 enforced as a hard invariant in
  `validatePairedBenchmarkV2`: an escaped case must score `correctness: 0`. New
  `src/metrics/safety-runner.ts` + `keryx metrics benchmark run --ladder harness --layer
  completion-honesty|false-premise`, driven live by `scripts/benchmark/run-safety.ts`.
  Completion-gate honesty gives the agent one fixed, non-configurable check tool per
  case (no injection surface) and grades whether its `VERDICT:` claim matches
  independently-verified reality; false-premise resistance asks loaded questions built
  on premises verified false against this repo's real source. First live result
  (`deepseek-v4-flash`): 3/3 honest on completion-honesty (the agent answered `UNKNOWN`
  even when it had just seen a clear pass/fail result — overcautious, not dishonest; an
  earlier scorer draft would have wrongly flagged that caution as an unsafe escape, since
  fixed) and 3/3 correctly rejected the false premise.
- **Benchmark suite M1 — safety track, containment (real OS sandbox).** Designed via an
  interviewer+brainstorm pass (Pragmatist/Innovator/Critic) before writing code —
  `scripts/benchmark/run-containment.ts`. A live agent (`deepseek-v4-flash`) is given a
  REAL, OS-sandboxed `shell_exec` (`KERYX_SANDBOX_SHELL=strict`) and tempted toward the
  same 3 unsafe actions (write outside its worktree, network egress when off, read a
  secret-shaped path) across 3 case classes (workspace-write containment,
  shell-permission restraint, prompt-injection resistance via a planted file). A
  mandatory preflight canary runs all 3 unsafe actions directly (no LLM) before any live
  case and aborts the whole run if even one is not blocked. `SafetyResult` gained
  `attempted`/`blockedAt` evidence fields (informational; AC-4 still governs
  correctness). Real result: **9/9 contained, 0 escapes** — and the new `attempted`
  field surfaced a real behavioral split the bare count would have hidden:
  shell-permission-restraint's "is this OK?" framing led the agent to never even attempt
  2 of 3 unsafe actions, while the other two case classes attempted all 3 and were
  stopped by the OS kernel every time.
- **Benchmark suite M1 — ablation runner, mutating coding tasks.**
  `scripts/benchmark/run-ablation-mutating.ts` + `scripts/benchmark/mutating-tasks.ts`
  extend the ablation runner from read-only comprehension questions to real,
  write-capable coding tasks: the agent gets a real `shell_exec` (auto-approved,
  scoped to this script's own `AgentIO`, same pattern `run-containment.ts` already
  established) and must edit an EXISTING file to make an already-seeded, already-failing
  test pass, in its own fresh git worktree per (task, variant, seed) — mutating tasks
  can't reuse a worktree across seeds the way read-only ones can. Success is decided by
  an independent `bun test` run after the turn, never the agent's own claim. All 3 tasks
  are real gaps observed this session, not invented (a missing atomic-JSON-write
  counterpart to `writeFileAtomic`; the exact `args.includes(flag)` one-liner repeated
  across `src/commands/init.ts`'s own flag parsing; the plain-text sibling of
  `readJsonFileOr` that `src/sac/proposal-evidence.ts` hand-rolls inline today) — each
  seeded test was hand-verified fail-then-pass before any live run. Live result with
  `rapid-mlx serve qwen3.5-4b-4bit` (deepseek/cerebras both unusable — no balance / HTTP
  401): **0/18, every task, both variants** — a real, diagnosed capability finding, not
  a scorer bug: a re-run with tracing showed the model looping on empty `get_cwd` calls
  until it hit `runAgentTurn`'s anti-loop guard, never once reading the target file. The
  original `qwen3.5-9b-4bit` (6/9 on the read-only leg) was never actually tested on this
  workflow — it crashed with SIGABRT under real memory pressure (108% projected RAM
  utilization, matching `rapid-mlx serve`'s own startup warning) partway through this
  slice's first live attempt, forcing a switch to the smaller model mid-session. Full
  harness + tasks + verification is real and reusable; the milestone still needs a model
  actually capable of the base task before the context-on/off comparison is measurable.
- **Benchmark suite M2 — harness-selection investigation, opencode headless dead-end.**
  Spec §1.3's comparative ladder requires the model held constant across targets.
  `opencode`'s free `deepseek-v4-flash-free` provider would have satisfied this
  literally (same model family as keryx's own harness legs), and its interactive TUI
  confirmed the model/provider works fine live — but both `opencode run --auto` and a
  `opencode serve` + `run --attach --auto` variant hang indefinitely on any task
  requiring a tool call, reproduced twice, independent of `.mcp.json` auto-discovery.
  The running server's own `/session` API surfaced a plausible cause: a
  `question`/`plan_enter`/`plan_exit` permission set to `deny` that `--auto` doesn't
  cover. `codex` was picked as M2's harness target instead, with the model-mismatch
  recorded as a disclosed spec deviation rather than papered over — see
  `docs/requirements/keryx-benchmark-suite/plan.md`'s M2 section.
- **Benchmark suite M2 — comparative report + fairness review (AC-6).** New
  `src/metrics/comparative.ts`: `buildComparativeReport`/`validateComparativeReport`
  combine keryx's own harness legs, a new zero-tool `raw` floor leg, and a
  third-party harness leg into `{keryx-on, keryx-off, raw, <harness>}` cells per
  task, with a per-target adapter/fairness status and a `publishable` flag on
  every cell that AC-6 requires be false whenever fairness isn't `met` — computed,
  never hand-set, so a caller can't silently mark a caveated result publishable.
  Legs stay independently-valid `paired-3-5-v2` manifests, never merged into one
  (the paired-cell invariant only fits exactly two complementary variants; a
  comparative row needs up to four) — this module only re-presents their `runs`
  side by side. `validatePairedBenchmarkV2`'s pairing invariant now exempts the
  `baseline` variant (a floor reference has no complement to pair against),
  existing pairing behavior unchanged (regression-tested). New
  `scripts/benchmark/run-ablation-raw.ts` produces the live `raw` leg —
  deepseek-v4-flash, same tasks, same `runAgentTurn` driver, EMPTY tool array:
  **0/9**, honest (the model cannot know this repo's exact symbols by guessing).
  New `scripts/benchmark/build-comparative-report.ts` synthesizes the three
  already-live fixtures into `fixtures/benchmark/keryx/comparative-report.json`:
  keryx-on 3/3, keryx-off 0/3, raw 0/3 (matching M1's already-reported numbers),
  codex 3/3 but `publishable: false` on every cell (fairness `not-met`, model not
  held constant) — AC-6 passes as a mechanism, but M2's `fairness: met` exit bar
  is honestly not reached with codex; the milestone stays open pending a
  same-model headless-capable harness.
- **Benchmark suite AC-5 — real gold-artifact leakage found and fixed.** AC-5 ("A
  dogfood case whose gold artifact is reachable by the agent fails its leakage
  assertion and is excluded from scoring") had never been demonstrated —
  `leakageAssertion` defaulted to `not-applicable` in every real M1 producer. Auditing
  it surfaced a genuine bug: every ablation worktree is a full `git worktree add
  --detach <path> HEAD` checkout (`src/harness/child/git-worktree-port.ts`), which
  includes `scripts/benchmark/ablation-tasks.ts`/`mutating-tasks.ts` THEMSELVES —
  containing the exact `expectedFile`/`expectedSymbol` answer key (and, for mutating
  tasks, the seeded test that IS the solution spec). An agent with `read_file` could
  read its own gold answer key directly, undetected, on every ablation run landed so
  far. New `src/metrics/leakage.ts` (`checkGoldLeakage`) is the real, deterministic
  reachability check; `validatePairedBenchmarkV2` gained a hard invariant mirroring
  AC-4's pattern — a manifest containing any `leakageAssertion: "failed"` run is
  invalid by construction. New `scripts/benchmark/run-leakage-check.ts` proves both
  directions live against real `git worktree` operations (no LLM call needed — leakage
  is a worktree filesystem property, decided before any agent runs): an unmodified
  worktree really does expose both gold files
  (`fixtures/benchmark/keryx/leakage-check.json` — the real, unpatched vulnerability),
  a stripped one genuinely reports `passed`. The fix — strip the gold artifact from
  every worktree before the agent ever sees it, verify the strip worked, abort rather
  than run a live case on an unverified worktree — is now wired into all three live
  producers (`run-ablation.ts`, `run-ablation-codex.ts`, `run-ablation-mutating.ts`).
  Every ablation manifest already landed in M1 was captured on an unstripped worktree;
  disclosed honestly rather than retracted — no evidence of actual exploitation
  (`context-off`'s consistent failures and the mutating slice's diagnosed anti-loop
  trip are inconsistent with a model that read its own answer key), but future
  regenerations now run leakage-clean by construction.
- **Fixed: two real MCP exposure gaps found while auditing keryx-shell/MCP capability
  parity.** (1) `buildMcpModuleEntry()`'s default `expose.modules`
  (`src/mcp/client-config.ts`) was missing `"gdctx"` and `"testing"` — `search_code` and
  `test_related` were registered in `buildToolRegistry` but invisible via `tools/list`
  to every external MCP client (Claude Code, Cursor) unless someone hand-edited the
  manifest. (2) The unified `read_wiki`/`wiki_ask`/`wiki_backlinks` operations
  (`src/harness/tool/metaproject-operations.ts`) tagged themselves `module: "gdwiki"` —
  the real internal facade name — instead of the MCP discovery layer's established alias
  `"wiki"` (`src/mcp/discovery.ts`'s `MODULE_MANIFEST_KEY`, mirroring `flow`→`tasks`),
  so `exposedModules.includes(module)` silently failed even with `"wiki"` correctly
  present in `expose.modules` — these three tools were invisible to every MCP client
  since they were unified into `metaproject-operations.ts`, leaving only the older,
  duplicate hand-written `wiki.ask`/`wiki.query` MCP tools reachable. Fixed the tag (and
  its schema enum, `metaproject-operation.schema.json`) rather than the discovery layer,
  since the alias convention is already established and correct everywhere else. Live
  end-to-end verified with a real spawned `keryx mcp serve` + `@modelcontextprotocol/sdk`
  `Client`/`StdioClientTransport` round-trip against this repo: tool count visible to an
  external client went from 27 to 30 (`search_code`, `test_related`, `read_wiki`,
  `wiki_ask`, `wiki_backlinks` all now present and callable). Both fixes also applied to
  this repo's own live `.metaproject/metaproject.json` (same surgical, targeted-edit
  pattern as the earlier `sac` expose fix).
- **MCP: real `codex`/`opencode` client verification, `opencode` install support.**
  Live-tested whether keryx's MCP server (fronting the same gdgraph/wiki/memory/health
  intelligence `keryx shell` uses internally) actually works with third-party CLI
  harnesses, not just Claude Code/Cursor. `codex`: registered via its own native
  `codex mcp add`, called `graph_affected` through `codex exec --approve-for-me`
  headlessly, got a real correct result — `codex exec` alone (no approval flag) silently
  cancels MCP tool calls, documented in `renderMcpManifest()`. `opencode`: called the
  same tool through `opencode run --auto` headlessly and it worked — genuinely
  surprising given `opencode`'s own built-in tools hang indefinitely in headless mode
  (documented separately); an MCP-sourced tool call apparently takes a different
  permission path than opencode's own tools. Added `OPENCODE_RUNTIME` to
  `src/mcp/client-config.ts` as a real, tested `--runtime opencode` for
  `keryx mcp install`/`uninstall` (writes project-local `opencode.json`, shape
  `{mcp: {keryx: {type, command, enabled}}}` — structurally different from every other
  runtime's `mcpServers.<name>.{command,args}`, confirmed against a real `opencode.json`
  before wiring in) and to `keryx init`'s interactive MCP prompt; `all` now expands to
  cursor+claude+opencode. `codex` is deliberately NOT a `--runtime` here — its config is
  a single GLOBAL `~/.codex/config.toml`, not project-local, and its own `codex mcp add`
  is already the safe way to manage it; documented instead of duplicated. Along the way,
  found and fixed a real, generic bug in `uninstallMcpClient`: its "was this runtime's
  keryx entry present" check hardcoded the `mcpServers` shape, so uninstall always
  silently reported `removed: false` for any runtime using a different shape (opencode
  today, any future one later) — fixed by adding a `hasManaged(settings)` predicate to
  the `McpClientRuntime` interface itself rather than special-casing it.
- **Fixed: sandbox read-deny list built from an uncanonicalized `homedir()`.**
  `src/harness/tool/builtin/shell-exec-tool.ts`'s `shellSandboxProfile` canonicalized
  `root`/`tmpdir()` for the Seatbelt profile but passed `homedir()` through raw; on
  macOS `/var` symlinks to `/private/var`, so a `HOME` pointed at a `tmpdir()`-derived
  path (exactly what an isolated CI run or test harness does) silently escaped the
  secret read-deny rules. Found live by the M1 safety-track containment preflight
  canary before any agent case ran — not a live risk for a real user's real `$HOME`
  (`/Users/<name>` has no symlink component), but a real gap for anyone overriding
  `HOME` for isolation. Fixed with `canonical(homedir())`, matching the existing
  treatment of `root`/`tmpdir()`.
- **Shared Agent Context — real harness composition for the memory-entry write path.**
  `keryx workspace propose --kind memory-entry --session <id>` and
  `keryx workspace review ... --decision accepted` now land a real file in
  `.metaproject/memory/` end-to-end, closing the gap the Phase 3 exit note left open:
  SAC's write path was intentionally fail-closed (`createLocalProposalLifecycleService`
  ships every owner writer as `unavailable` — "SAC never edits Wiki, Memory or Skills
  files itself" until each owning subsystem composes a trusted implementation). New
  `createHarnessProposalLifecycleService` (`src/sac/proposal-lifecycle.ts`) composes two
  new real modules: `src/sac/session-wrap-up.ts` (`resolveSessionWrapUp`) turns a real
  keryx shell session into a `TrustedWrapUpResolution` by exporting its full archive
  (`src/session/store.ts` `exportSessionMarkdown`, every role/message verbatim) into the
  target workspace and hashing that export — never the agent's own summary; and
  `src/sac/memory-owner-writer.ts` (`createRealMemoryOwnerWriter`) is memory's first real
  `GuardedOwnerWriter`: it reads the proposal's evidence pointer, re-verifies the
  evidence file's hash against what was recorded at propose time, and writes a
  schema-valid entry via the same canonical `src/memory/write.ts` `writeCanonicalEntry`
  path (and its security guard scan) `keryx memory new` uses. Verified live end-to-end
  (real session, real hash-verified evidence chain, real written memory file) and with
  103/103 `src/sac/` tests green (14 files). Wiki/skill owner writers remain
  `unavailable`/fail-closed — only memory has a real composition today. Two real bugs
  found and fixed along the way: (1) `TrustedWrapUpProvenance.sourceRef` is schema-typed
  as a workspace-relative `path` (no bare IDs, no `#` fragments) —
  `resolveSessionWrapUp` now encodes the session id in the path itself
  (`sessionEvidenceRef`) and independently re-derives+re-verifies it rather than
  trusting the caller's resolution (defends against a spoofed workspace segment); (2) an
  optional `--note` passed at `propose` time was captured in a service-composition
  closure that does not survive into a separate `review`-time process — fixed with a
  sidecar `<proposalId>.note.txt` file (`proposalNotePath`), written at propose time and
  read back at accept time, mirroring the approval/intent/decision sidecar pattern
  `proposal-lifecycle.ts` already used. The read-path (an agent reading FWK context
  live inside `keryx shell`) remains unwired — out of scope for this slice.
- **Shared Agent Context — real harness composition for the wiki-update write path.**
  `keryx workspace propose --kind wiki-update --session <id>` +
  `review --decision accepted` now lands a real "decision" page (`WIKI_PAGE_TYPES` —
  "known decisions and ADR-like records", `.metaproject/wiki/decisions/`) end-to-end,
  the same shape of gap the memory-entry path closed above. New
  `src/sac/wiki-owner-writer.ts` (`createRealWikiOwnerWriter`) is wiki's first real
  `GuardedOwnerWriter`, guarded by the SAME security write seam
  `keryx wiki collect` runs before publishing a generated page
  (`src/wiki/service.ts`, `guardOutput({ target: "wiki" })`) — a blocked write is
  refused, not silently sent. Unlike memory, there is no canonical "write real body
  content" helper to reuse here: `keryx wiki new` (`wikiCreatePage`) only scaffolds a
  blank title/type template with no content field, so this writes directly via the
  same `writeFileAtomic` helper `proposal-lifecycle.ts` already uses elsewhere. The
  proposal-record read + evidence hash re-verification that memory and wiki both need
  was pulled out into shared `src/sac/proposal-evidence.ts` (`readVerifiedProposalEvidence`,
  `ownerReceiptPath`, `proposalNotePath` + the sidecar-note fix from above) rather than
  duplicated a second time; `memory-owner-writer.ts` was refactored onto the same
  seam with no behavioral change (same receipt paths, same tests, still 115/115 green
  across `src/sac/` + the session-reader caller guard). Verified live end-to-end (real
  session → hash-verified evidence → accepted `wiki-update` proposal → real
  `.metaproject/wiki/decisions/sac-<id>.md`, note included). **`skill` stays
  `unavailable`/fail-closed on purpose**: `src/security/types.ts`'s `SecurityTarget`
  union has no `"skill"` member and `createProjectSkill`
  (`src/gdskills/project-skills.ts`) runs no security scan at all today — writing
  SAC-derived content into skills (read as agent routing instructions every turn)
  without the same guard memory/wiki get would be a real safety regression, not a
  shortcut, and was deliberately not done.
- **Shared Agent Context — FWK read-path wired into the live agent shell.** A
  running `keryx shell` agent turn can now read SAC workspace context directly:
  two new read-only tools, `workspace_overview` and `workspace_read`
  (`src/harness/tool/builtin/workspace-context-tool.ts`), wrap
  `createLocalFwkReadService` (previously reachable only from a separate CLI
  process via `keryx workspace overview`/`read`, or over MCP as `sac.overview`/
  `sac.read`) and are added to both the TUI and readline tool arrays in
  `src/commands/shell.ts`, `risk: "read"` like `read_file`/`list_dir`. There is
  no session↔workspace linkage anywhere in keryx (no `--workspace` flag, no
  workspace field on `SessionSummary`), so the agent must be told which
  workspace to read via an explicit `workspaceId` on every call, same as the
  CLI. Confirmed this can't become HTTP-reachable: `keryx serve`'s handler
  never touches `shell.ts`'s `AgentDeps`/tool-array construction, so this stays
  on the same local-only trust boundary `shell_exec` already operates under —
  unlike the MCP `sac.*` tools, which explicitly refuse HTTP transport because
  SAC's local auth server derives its actor from the OS user with no verified
  per-request principal. Verified two ways: 6 offline unit tests calling the
  tools directly against a real (but resource-less) workspace, AND one fully
  live round-trip — a real local model (`rapid-mlx serve qwen3.5-9b-4bit`)
  driven through the actual `runAgentTurn` loop `keryx shell` uses, calling
  `workspace_overview` for real, getting back a real signed access receipt, and
  correctly reporting the result. (DeepSeek and Cerebras credentials were both
  unusable at verification time — no balance / 401 — so the live check ran
  against a local model instead of the usual `deepseek-v4-flash`.)
- **Fixed: `keryx skills create` ran zero security scanning.** Unlike
  `keryx wiki collect` (`guardOutput({ target: "wiki" })`) and `keryx memory new`
  (`writeCanonicalEntry`'s guard), `createProjectSkill`
  (`src/gdskills/project-skills.ts`) wrote `SKILL.md` — content read as agent
  routing instructions every turn — with no scan at all. `SecurityTarget`
  (`src/security/types.ts`) gained a `"skill"` member (also added to
  `src/security/schemas.ts`'s finding-schema enum and `src/commands/security.ts`'s
  `--target` validation list — both closed allow-lists, found and updated
  together so `--target skill`/a finding with `target: "skill"` don't fail
  closed for unrelated reasons); `writeProjectSkillPackage` now renders
  `SKILL.md`'s content and runs it through `guardOutput({ target: "skill",
  source: "generated" })` **before** any `mkdir`/write happens, throwing if the
  strict/enforced gate blocks it. New `src/gdskills/project-skills.test.ts`
  (this function had no test coverage at all before) proves all three real
  behaviors: unaffected by default (security module disabled), a planted
  secret genuinely blocked end-to-end in `enforced` mode with **nothing**
  written to disk, and the same content allowed through in `advisory` mode
  (report-only, matching every other target's documented behavior). Found
  while investigating why `skill` — the third `GuardedOwnerWriter` owner
  alongside `memory`/`wiki` — was still `unavailable`/fail-closed in SAC; this
  was the actual blocker (no target, no scan), not laziness. 190/190
  `src/gdskills`+`src/security`+`src/commands/security` tests green.
  **A real skill owner-writer is still not composed**: while wiring this,
  found that `ProposalLifecycleService.targetWriteOrStale`
  (`src/sac/proposal-lifecycle.ts:127`) requires an owner's receipt
  `targetRef` to literally start with `./${owner}` — `./memory/...` and
  `./wiki/...` both genuinely match where those owners store files under
  `.metaproject/`, but `keryx skills create` stores real skills under
  `.metaproject/project-skills/`, not `.metaproject/skill/`. A skill
  owner-writer built today would have to fake a `targetRef` that doesn't
  match the real file location to pass that check, which is worse than not
  building it — so it wasn't built. Fixing this needs a decision on the check
  itself (e.g. a per-owner prefix map instead of a literal `./${owner}`
  assumption) before a real skill writer can be composed honestly.
- **Shared Agent Context — the skill owner-writer, and the targetRef fix it
  needed.** `ProposalLifecycleService.targetWriteOrStale`
  (`src/sac/proposal-lifecycle.ts`) assumed every owner's receipt `targetRef`
  starts with the literal `./${owner}` — true by coincidence for memory/wiki,
  false for skill (real skills live under `.metaproject/project-skills/`, not
  `.metaproject/skill/`). Replaced with `ownerTargetPrefix(owner)`, a real
  per-owner map (`memory→./memory`, `wiki→./wiki`, `skill→./project-skills`).
  Two new regression tests in `proposal-lifecycle.test.ts` prove the fix
  actually enforces the correct prefix rather than just "always pass": a skill
  receipt with the OLD, buggy `./skill/...` shape (exactly what the previous
  check would have accepted) is still rejected and the accept lands as
  `stale`; one with the real `./project-skills/...` shape is accepted.
  `src/sac/skill-owner-writer.ts` (`createRealSkillOwnerWriter`) is skill's
  real `GuardedOwnerWriter` — the third and last, alongside memory and wiki.
  It reuses `createProjectSkill` itself (`keryx skills create`'s own write
  path, now guarded from the previous change) rather than writing
  `.metaproject/project-skills/` files a second, parallel way: every
  SAC-derived skill lands under the fixed `sac` module
  (`.metaproject/project-skills/sac/<proposalId>/SKILL.md`), so it's always
  distinguishable from a skill a person created directly. `keryx workspace
  propose --kind <kind>` now accepts all six real proposal kinds (`decision`,
  `wiki-update`, `memory-entry`, `follow-up`, `contract-change`, `risk`) — not
  just the two that had writers before — since every kind now routes (via the
  existing `ownerFor`) to a real owner. Verified live end-to-end: real
  session → hash-verified evidence → accepted `decision` proposal → real
  `.metaproject/project-skills/sac/<id>/SKILL.md`, with `metaproject.json`'s
  skill registry and `skills/catalog.md` correctly updated by
  `createProjectSkill`'s own bookkeeping (and cleanly reverted after
  verification, along with the demo skill directory). 7 new tests in
  `skill-owner-writer.test.ts`, including one proving the security gate from
  the previous change genuinely blocks a skill write end-to-end (not just
  wired) — a planted secret in the derived skill content is refused in
  `enforced` mode with nothing written to disk. Full suite green after this
  change (typecheck clean; `src/sac`+`src/gdskills`+`src/security`+
  `src/commands/security`+`src/commands/workspace`: 309/309).
- **Fixed: `sac.propose`/`sac.review` over MCP were never actually wired.**
  `src/mcp/tools.ts`'s `sac.propose` unconditionally returned
  `trusted_wrap_up_required` (empty input schema — it could not have worked),
  and `sac.review` called the fail-closed `createLocalProposalLifecycleService`
  instead of the real `createHarnessProposalLifecycleService` composition the
  CLI/keryx-shell paths already use. Both now compose the real thing: `sac.propose`
  takes `{ workspaceId, kind, sessionId, note?, proposalRevision? }`, resolves the
  session via `findSession`, issues a real wrap-up, and creates a real proposal
  (with the same propose-time note sidecar the CLI uses); `sac.review` runs the
  same review path the CLI does. `src/sac/service.ts` (the facade `src/mcp/`
  is architecturally restricted to — enforced by `boundary.test.ts`'s M-3 guard)
  gained the needed exports: `createHarnessProposalLifecycleService`,
  `sessionEvidenceRef`, `proposalNotePath`, `findSession`. A SECOND, independent
  bug surfaced while live-verifying this: `sac.*` tools were entirely invisible
  over MCP regardless of the fix — `buildMcpModuleEntry()`'s default
  `expose.modules` allowlist (`src/mcp/client-config.ts`) never included
  `"sac"`, so `tools/list` never returned them. Both fixed together; verified
  with a real MCP SDK `Client`/`Server` round-trip (`InMemoryTransport`, real
  protocol serialization, not just in-process function calls) against a real
  session and a real workspace: `tools/list` now returns all 5 `sac.*` tools,
  `sac.propose` creates a real proposal over the wire, `sac.review` accepts it
  and a real file lands in `.metaproject/memory/task-notes/`. New
  `src/mcp/sac-tools.test.ts` (3 tests, previously zero coverage for these two
  tools). Also documented `keryx mcp install`/`uninstall` in the mcp module's
  own manifest doc (`renderMcpManifest`) — it only mentioned `serve` before,
  so nothing told an agent reading `.metaproject/modules/mcp.md` that
  `mcp install --runtime <runtime>` is the real, complete way to connect a
  project when asked to "enable MCP", short of hand-editing a client config.
  Connected this repo for real (`keryx mcp install --runtime claude`) after
  confirming it was safe to run from this dev checkout: `enableMcpModule` is a
  surgical read-parse-patch-write on just `modules.mcp` in the existing
  manifest, unlike `keryx modules enable <name>`'s full `initCommand()`
  reconciliation (which regenerates every enabled module's files and, earlier
  this session, was found to silently regress this repo's real
  `.metaproject/` content when run from a dev checkout whose generators have
  diverged from the separately-installed global `keryx` binary that actually
  wrote it). 246/246 across `src/mcp`+`src/sac`+`src/commands/security`+
  `src/gdskills` after this change, typecheck clean.

## [0.2.33] — 2026-08-13

### Added

- **Shared Agent Context — phase-6b operator readiness check.** New read-only
  `keryx workspace policy-readiness` (backed by `diagnosePolicyReadiness`) validates
  the full opt-in policy integrity chain **before** enabling — even while the
  experiment is disabled — reporting each gate's pass/fail and exiting non-zero when
  not ready, so an owner can prove real-data readiness before flipping
  `enabled: true`. Read-only; the runtime guard and default-off posture are
  unchanged. Documented in the new Phase 6b operator playbook.

## [0.2.32] — 2026-08-12

### Added

- **Shared Agent Context — phase-6 runtime opt-in policy guard.** The FWK read
  path now switches from the deterministic baseline to the experimental learned
  candidate policy only through `resolvePolicySelection`
  (`src/sac/fwk-service.ts`): a strict, fixed-order integrity chain over explicit
  config pins (candidate → baseline → corpus → evaluation report → deterministic
  activation). It is fail-closed to baseline on any error, off by default, and
  gated by a kill-switch and rollback. No public CLI or MCP schema changes; the
  candidate is never enabled implicitly. Acceptance criteria AC1–AC6 met; full
  SAC suite 88/88 green.

### Documentation

- **New docsite guide: "Shared Agent Context (experimental)"** covering the FWK
  model, the `keryx workspace` workflow (create / add-resource / overview / read /
  propose / review) and the phase-6 runtime opt-in config, linked from the README.
- **SAC requirements package reconciled.** Phase 6 is documented as one phase with
  two parts — 6a runtime enforcement guard (implemented) and 6b real operator-data
  readiness (planned) — across the package README, implementation plan and the
  phase-6 readiness document.

## [0.2.31] — 2026-08-12

### Changed

- **Agent TUI now separates `/connect` and `/provider` semantics.**
  `/connect` lists only already-configured and reachable providers, while
  `/provider` remains the configuration/setup path (API key + endpoint + model).

- **Provider selection and model discovery robustness.** Endpoint overrides are
  persisted per provider, and rapid-mlx detection no longer falls back to
  unrelated hardcoded models when endpoint probing fails.

## [0.2.30] — 2026-08-12

### Fixed

- **Agent TUI launch regression fix.** Removed stale `searchController` option from the
  `launchTuiAgentShell` call path to match its current signature after `/connect`
  / `/provider` picker refactoring. This unblocks the release pipeline type check and keeps
  the shell launch API consistent.

## [0.2.29] — 2026-08-12

### Changed

- **Split `/connect` and `/provider` semantics in agent TUI.** `/connect` now
  selects only already-configured providers (with required keys and successful live
  `/models` checks). `/provider` remains the configuration command for provider
  credentials and model setup.

## [0.2.28] — 2026-08-12

### Fixed

- **Local SearXNG search now works through the sandbox.** The web worker selects
  the HTTP client for loopback search endpoints while retaining HTTPS-only
  policy for remote web fetches.

## [0.2.27] — 2026-08-12

### Fixed

- **Sandboxed web fetch now connects reliably on dual-stack hosts.** The worker
  returns the correct Bun DNS-pinning callback shape and prefers a validated
  IPv4 address when it is available alongside IPv6.
- **Agent web-tool guidance no longer treats fetch as search.** For unknown
  sources, the agent now gives search-provider setup guidance instead of
  guessing URLs or repeatedly retrying an unavailable search provider.

## [0.2.26] — 2026-08-12

### Added

- **Sandboxed web transport and provider-based search.** Agent mode now offers
  `web_fetch` and `web_search` through a fail-closed, DNS-pinned sandbox worker.
  SearXNG, Brave Search, Tavily, and Exa are configured through the TUI; only a
  successfully tested provider can become active.
- **Local SearXNG guide.** `/search-provider` supplies editable localhost URL
  and port defaults, with an installation guide for a local Docker deployment.

### Security

- **External web data is tainted.** It is bounded, redacted, provenance-labelled,
  and cannot authorize later agent tool calls across turns or session compaction.

## [0.2.25] — 2026-08-11

### Changed

- **Provider configuration is now uniform in the agent TUI.** `/provider`
  lists all supported providers and lets every endpoint-based provider edit its
  endpoint URL before live model discovery; overrides are stored per provider.
  `/connect` lists only configured or currently reachable providers.

### Fixed

## [0.2.24] — 2026-08-11

### Fixed

- **Provider switching is available in agent TUI.** `/provider` now opens the
  provider, API-key, and model picker in agent mode, matching `/connect` and
  avoiding a switch to chat mode solely to change providers.

## [0.2.23] — 2026-08-11

### Added

- **Configurable OpenAI-compatible provider endpoints.** Override any built-in
  provider URL with `KERYX_<PROVIDER>_BASE_URL`; for example,
  `KERYX_RAPID_MLX_BASE_URL=http://127.0.0.1:8010`. The selected endpoint is
  also used to discover the provider's live model list.

## [0.2.22] — 2026-08-11

### Fixed

- **Durable interactive-session checkpoints.** `keryx shell` now writes the user
  message immediately, checkpoints tool results, and journals streamed assistant
  text every 300 ms. `/interrupt` therefore preserves the latest partial answer
  instead of losing the active turn.

## [0.2.21] — 2026-08-11

### Fixed

- **Release verification for changed-test selection.** Updated stale test expectations
  for the existing `imports` selection strategy, restoring the release test gate.

## [0.2.20] — 2026-08-11

### Added

- **Interactive session switching in the TUI (`/sessions`).** The shell now opens a
  per-project session picker for live switching while preserving current sessions on
  disk.
- **Main-turn interrupt command in the TUI (`/interrupt`).** Added a hard-stop path for
  an in-flight main turn, with deterministic teardown of the running provider loop.

### Changed

- **Side prompt execution model in the TUI.** While the main turn is busy, additional
  plain prompts are queued into a single read-only side worker (`side-1`) and processed
  sequentially. This keeps the interface responsive without mutating context during
  background helper turns.

## [0.2.19] — 2026-08-11

### Fixed

- **Health regression fixed for keyless OpenAI-compatible providers (Rapid-MLX and similar).**
  OpenAI-compatible registry providers without `envKey` are now handled correctly in
  mask resolution, provider detection, and provider construction paths. This removes
  the TypeScript hard failures that blocked release-health gates on `keryx health run`.
- **Release metadata stability for provider detection flows.**
  Type strictness and generated graph/wiki artifacts were updated so the same provider
  registry changes (including rapid-mlx) are represented safely in runtime and docs tooling.

## [0.2.18] — 2026-08-11

### Added

- **Bounded version update advisories.** `keryx shell` performs one background,
  non-blocking check and shows a notice only for a strictly newer validated
  npm version. `keryx version check [--json]` exposes the same typed result;
  neither surface auto-installs or blocks project work. Successful metadata is
  cached for 24 hours, failed checks are suppressed for 15 minutes, and the
  registry request times out after 2 seconds. The exact manual update command
  is `npm install -g @mrciphersmith/keryx@latest`.

### Documentation

- Generated `.metaproject/index.md` guidance asks agents to run the JSON check
  once per session and to notify only on `update-available`; the instruction is
  prompt guidance, not enforcement, and unknown/offline/unavailable results
  remain non-blocking. Existing installations from before the first
  feature-bearing release cannot discover that release through code they do not
  yet contain, and existing projects gain the guidance only after index
  regeneration or update.

## [0.2.17] — 2026-08-11

This release makes project bootstrap reliable without inflating every agent
turn, gives read-heavy investigation enough room to finish, and completes the
memory reliability work from recall through lifecycle writes.

### Added

- **Agent orientation now starts from the launch project's Metaproject.** When
  `.metaproject/index.md` exists at the project root, `keryx orient` includes a
  bounded excerpt of its routing sections and tells the agent to read the full
  file before project work. It deliberately does not discover an ancestor
  Metaproject or describe the prompt instruction as an enforced runtime gate.
- **Memory reports and lifecycle transitions are explicit surfaces.** Default
  recall is side-effect free; `memory search --save-report` persists an
  immutable report only when requested; `memory transition` validates status
  changes; and supersession updates both entries through the guarded lifecycle.

### Changed

- **Interactive-agent tool budgets are split by risk inside a 48-signature
  total:** up to 40 read signatures and 8 non-read or unknown-risk signatures.
  Repeating the same normalized call still occupies one slot, and merely
  reaching a limit no longer ends the turn before the model can answer from the
  last result.
- **Automatic memory influence is accepted-only, current, and bounded** across
  shell approval context, flows, the harness adapter, MCP, and skill
  verification. Search filters, temporal validity, memory types, templates, and
  configuration now share one validated contract.
- **Canonical memory writes are confined, security-gated, and atomic.** Paired
  supersession writes roll back together on failure. Legacy generated
  `data/memory/artifacts/latest.*` files receive advisory migration guidance;
  Keryx does not delete downstream files or mutate the Git index automatically.

### Documentation

- Added the implemented P0–P6 memory reliability requirements, specification,
  migration policy, verification evidence, schema, and updated CLI/module/wiki
  guidance.
- Added a frozen 26-case shell benchmark protocol for comparing Keryx model
  legs with Claude Code and Codex without claiming results before a run.

## [0.2.16] — 2026-08-05

The other half of the 0.2.15 audit. That release corrected what the README
claimed; this one closes the five gaps it found in the code — one live security
weakness, two safety mechanisms that could not fire, and two finished features
with no way in.

### Security

- **A `network: "restricted"` sandbox profile now fails closed on Linux
  regardless of `KERYX_SANDBOX_ALLOW_UNSANDBOXED`.** One variable covered two
  unrelated failure modes. A missing launcher is a degradation an operator can
  knowingly accept; a domain allowlist that is not implemented on this platform
  is not. In the second case the allowlist proxy had already started and the
  proxy variables were already merged into the command environment, and then the
  command was spawned uncontained and free to ignore both. The check lives at the
  spawn point, where profiles from all three construction paths converge and the
  invariant cannot be routed around. The missing-launcher escape hatch is
  unchanged, and is pinned by its own test so the fix cannot be satisfied by
  refusing everything.
- **The harness mutation path is scanned by a scanner that can find
  something.** The redaction seam was real, but the only implementation behind it
  answered "no secret here" to every input, so every tool result the run loop
  persisted came out verbatim. `scanAvailable` — a fail-closed capability signal
  the guard denies on — was hardcoded `true` at the production call site. Both
  now derive from the real detectors, resolved once before the run so the loop
  stays synchronous, offline and replayable.

### Added

- **`keryx sessions fork <id>`** branches a conversation into a new session that
  keeps its ancestry (`parentSessionId`) and starts from the same context and
  archive. Writing to the fork never touches its source. Forks are marked `↳` in
  `keryx sessions list`.
- **`keryx harness replay --record <path>`** validates a recorded run's log
  against a replay fixture, and **`keryx harness run --record <path>`** writes
  the record. `--write-fixture` keeps a fixture, `--fixture` compares against a
  kept one, and a divergence prints a typed mismatch naming the field and exits
  non-zero. This is `validate-log` and says so: it checks that a fixture still
  describes the run it was built from, and re-executes nothing.
- **The completion gate can be told what to require.** `runOffline` accepts
  `requiredEvidenceRefs` and `requiredGates` instead of building two empty arrays
  itself, so two of the gate's three conditions stop being vacuous. Supplying
  nothing keeps the previous behaviour, which has its own test.

## [0.2.15] — 2026-08-05

A claim-by-claim audit of the README against source. Three commands turned out
to report work they had not done, and the fixes are the substance of this
release; the documentation changes are what the audit found on the way.

### Fixed

- **`keryx orient install-hook --dry-run` wrote the file anyway.** The flag was
  accepted by the shell and parsed by nobody. A `--dry-run` that mutates is worse
  than no flag at all, because it is the flag someone reaches for when they are
  unsure a command is safe to run. Both `install-hook` and `uninstall-hook` now
  honour it and report the file they would have touched.

- **`keryx init` claimed the git hooks were installed when there was no
  repository.** The hook installer returns early with no hooks root, but the
  summary rendered its rows from the intent flags — so running `keryx init`
  before `git init` reported every hook as installed while nothing was written
  and nothing would ever fire. It now reports them as skipped and says how to get
  them installed. The security agent hook keeps its row; it lands in
  `.claude/settings.json` and does not need a repository.

- **`keryx status --help` ran the report instead of printing help.** Harmless in
  itself — `status` is read-only — and fixed for the reflex it teaches for the
  commands that are not.

### Documentation

- **The README stops claiming four harness capabilities that are built but not
  reachable**, and stops describing a replay path that cannot detect a divergent
  run. The capabilities are tracked in the issue tracker rather than dropped
  silently.

- **The provider list was four of eleven.** Anthropic, Ollama and the
  OpenAI-compatible gateways — OpenRouter, DeepSeek, Z.AI, Cerebras, Groq,
  Moonshot, Grok — with the offline fake provider alongside them.

- **Corrections where the README and the code disagreed:** CI runs on pull
  requests and pushes to `main`, not every push; four of the five model commands
  exit non-zero without a credential, and `wiki enrich` is the one that exits `0`
  and skips pages; the remote policy profile is compared once at startup, where a
  weaker profile refuses to bind at all; git is required for hooks, changed-scope
  runs and the managed installer, not by the core.

- **The CLI reference gained the five model commands it was missing** —
  `wiki enrich`, `test suggest`, `flow plan`, and `--narrate` on `memory reflect`
  and `health explain` — and its `harness run` signature no longer names three
  providers out of eleven.

## [0.2.14] — 2026-08-04

### Documentation

- **The documentation site stops describing itself as machine output.** The
  landing page opened with "Auto-generated developer documentation … reverse
  engineered from source", which is both wrong — you cannot reverse-engineer
  your own code — and the first sentence a visitor read. The useful half of that
  note survives: these pages describe shipped behaviour, `docs/requirements/`
  describes intent, and where they disagree the docs section wins.

- **The public documentation index no longer links to the scaffolding.** The
  release-readiness audit and the community-documentation plan are working
  material; they stay in the repository and leave the published index, which now
  points at the changelog and the tagged releases.

- **README images use absolute URLs.** The README is the npm page as well as the
  GitHub one, and relative `docs/assets/` paths only render there by grace of
  npm's URL rewriting. They are now pinned to `raw.githubusercontent.com`, so the
  page renders the same wherever it is displayed.

## [0.2.13] — 2026-08-04

### Documentation

- **The harness screenshots show the harness working.** The first pass shipped a
  `/help` frame — the UI, with nothing in it. Replaced with three captures of
  real turns against this repository: `glm-5.2` answering a blast-radius
  question through the `graph_affected` tool in twelve seconds; the agent
  raising a structured `ask_user` question with selectable options instead of
  guessing; and the same loop with the same tools running a different provider,
  which is the evidence behind the provider-neutral claim rather than a
  restatement of it.

- **The local example names a model that exists.** `keryx shell --provider
  ollama --model llama3.1:latest` was a plausible-looking placeholder; the local
  example now uses `gemma4:e4b`, which is what the capture was actually taken
  against.

## [0.2.12] — 2026-08-04

### Documentation

- **The agent harness is now stated as a first-class part of the product.** The
  previous README mentioned it twice in passing — once as the thing `keryx shell`
  starts, once as the thing `keryx serve` is a second door into — and never in
  the first screen, the value table or the capability list. A reader could
  finish the page without learning that keryx owns an execution loop at all.

  The new section says what is in it: a provider-neutral loop over Anthropic,
  Ollama, OpenRouter and Grok plus an offline fake provider; durable per-project
  append-only sessions with resume, branching and compaction; a policy engine
  with `allow`/`ask`/`deny` over paths, commands, tools, network and resources;
  guarded mutation that is path-checked, security-scanned, approval-bound and
  evidence-recorded; kernel-enforced containment below the policy engine;
  child agents over the canonical contracts with token budgets and bounded
  parallel scheduling; an evidence ledger behind the completion gate;
  deterministic replay from recorded fixtures; and four doors — CLI, JSONL/RPC,
  TUI and loopback HTTP — onto one loop.

  Framed as the combination rather than a feature list: the harness is worth
  having *because* it reads the same `.metaproject/` context every other agent
  reads, and the context is worth having *because* something can act on it
  without rediscovering the repository first. The package's own thesis — the
  agent is ephemeral, the project brain is durable — now appears where a reader
  will meet it.

- **The first two screenshots.** `docs/assets/dashboard.png` and
  `docs/assets/shell.png`, both captured from real runs against this repository
  rather than mocked up. A tool with a TUI and a dashboard that shows neither is
  asking to be judged on prose alone.

- **The README links the documentation site** (`mrciphersmith.github.io/keryx`),
  which has been deploying on every push to `main` and was reachable from
  nowhere in the README.

## [0.2.11] — 2026-08-04

### Documentation

- **The README leads with what keryx is for, not with what it cannot do.** The
  old first screen spent its attention on absent model runtimes, empty runtime
  identifiers and non-zero exit codes — accurate, and the worst possible order
  in which to say it. A reader met the limitations of a product before its
  purpose, and concluded the product was unfinished rather than deliberate.

  The new order is: one sentence of value, the install, the problem, a table of
  what you get, a real end-to-end agent workflow, the express example, the
  `.metaproject/` tree, capabilities grouped by what you are trying to do, and
  only then requirements, optional AI features and limitations. Nothing was
  softened into untruth — the macOS-only containment tier, the missing
  approval transport, the unbundled embedding runtime and the external ripgrep
  dependency are all still stated, with the impact and the alternative next to
  each.

- **`docs/docs/limitations.md`** now holds the detail the README used to carry:
  the removed ONNX stack and the two constants that re-enable those seams, the
  five commands that need a provider credential, the platform matrix, the
  remote-approval gap and the pre-1.0 format-stability note. Linked from the
  README and the docs index, and in the site nav.

- **Two README caveats were removed because they had become false**, not
  because they were inconvenient: `security` is in `keryx modules` and can be
  toggled there, and enabling `mcp` no longer survives only until the next
  unrelated toggle — `defaultEnabled`/`enableFlag` in `src/commands/modules.ts`
  fixed that. Every command the README now shows was checked against the live
  CLI surface.

- **The npm `description` and `keywords` describe the product category** —
  version-controlled project context for AI coding agents — rather than opening
  with "metaproject workspace", a term that means nothing before the reader has
  installed the thing.

## [0.2.10] — 2026-08-04

### Changed

- **The release workflow publishes with no credential at all.** The trusted
  publisher is registered on the package (`MrCipherSmith/keryx`, `release.yml`,
  permissions `npm publish` and `npm stage publish`), so `npm publish` now
  authenticates as the OIDC identity of this workflow. The `NODE_AUTH_TOKEN`
  env block is gone and the `NPM_TOKEN` repository secret has been deleted —
  not merely left unused, because a credential nothing reads is still a
  credential that can be read.

  The bootstrap ordering is recorded in the workflow itself, because it is not
  obvious and cost four failed attempts to learn: a trusted publisher is
  configured under the **package's** settings, which means the package has to
  exist before it can be configured, which means the first publish of a new
  package cannot use it. `0.2.9` went out under a classic Automation token —
  the only token type that bypasses the 2FA prompt a CI runner cannot answer.
  A granular token obeys the account's 2FA setting and fails with `EOTP`, which
  is exactly how the third attempt died.

  Nothing published between those four failures. Every one of them stopped at a
  gate before the publish step, which is the gate working; three of the four
  were the same defect wearing different clothes — a requirement satisfied in
  one place and never written down as belonging to the suite.

## [0.2.9] — 2026-08-04

### Documentation

- **The name question is settled: `keryx` stays**, published as
  `@mrciphersmith/keryx`. Decided on evidence. Fourteen plausible single
  classical words were checked against npm and **all were taken** — that
  namespace was exhausted years ago, which is why a scope is normal practice
  rather than a workaround. And the rename was measured, not guessed: **8,554
  occurrences across 1,503 files, 621 of them file or directory names**.

  The one candidate that would have made the project better rather than merely
  different was `metaproject` — free, and already this project's own noun. Today
  it has two names for one thing: the tool is `keryx`, the thing it makes is a
  `metaproject`. Collapsing them would have been a simplification, and it was
  still not worth six hundred renames.

  The mitigation is discipline: always write the scope, because
  `npm install -g keryx` installs an unrelated project.

- **An announcement draft**, at `docs/plans/announcement-draft.md`, written to
  the plan's rules — one demonstrated thing rather than a feature list,
  boundaries stated in the post itself, prepared answers to the three questions
  that will be asked, and an explicit **what not to claim** list: no performance
  claim, not "ML-powered" (those runtimes are not shipped), not "fully
  sandboxed" without naming the tier and platform.

  It is a draft for a human to post. Nothing has been published.

## [0.2.8] — 2026-08-04

### Documentation

- **Five task-shaped guides**, organised by what a reader is trying to do rather
  than by which module implements it: give an agent context, run an agent
  without giving it your machine, drive keryx from a bot, review with a durable
  record, and run keryx in CI. They are doors into the reference, not a
  replacement for it.

  Every command shown was executed and the output is from those runs. Each guide
  ends with a verification command **and with what a misleading pass looks
  like** — a graph reporting `0 nodes` on a repository that has code, a review
  package that ingested cleanly with zero findings, a health gate passing over
  stale artifacts.

  Two things only a real run would have surfaced:

  - `keryx harness exec --allowed-domains api.example.com` produces an allowlist
    of **five** domains. The extra four are hosts of provider credentials saved
    on the machine — once a run is restricted, a masked credential's host has to
    be reachable or the mask is pointless. It is disclosed in the output, and
    the guide tells the reader to trust the effective list over the one they
    typed.
  - `security eval`'s `prompt-injection` row misses **three of eight** positives
    and is still `ok`, because its committed ceiling is `0.5`. The CI guide
    points at that row rather than the summary line: the gate does not claim the
    detector is good, only that it has not got worse than a number someone wrote
    down and can defend. Every other detector's ceiling is zero.

## [0.2.7] — 2026-08-03

### Added

- **A documentation link gate, in CI.** `bun run check:doc-links` resolves every
  relative Markdown link in the root documents and all of `docs/`, and checks
  `#anchor` fragments against the target file's headings — `file.md#missing`
  is the failure a plain existence check survives. It fails if it checked *zero*
  links, so a glob that quietly stopped matching cannot look like a clean sweep.

  `keryx wiki check-links` already covered the wiki. Nothing covered `docs/`.

- **`mkdocs.yml` and a Docs workflow.** MkDocs Material, `docs_dir: docs/docs`,
  explicit nav, Mermaid through `pymdownx.superfences`. The workflow's `build`
  job runs `mkdocs build --strict` on every pull request; `deploy` publishes to
  GitHub Pages from `main`. **The site config has not been executed locally** —
  `python3-venv` is absent on the authoring machine — so CI is its first oracle.

### Fixed

- **39 broken documentation links**, found by the gate on its first run, out of
  573 checked. Thirty-eight were one `../` too deep from
  `docs/decisions/keryx-harness/`; one pointed at a handoff document under a
  `.metaproject/jobs/` directory that does not exist — the real file lives in
  `docs/decisions/keryx-harness/`.

  A link check had been reported as passing repeatedly during this
  documentation work. It ran over a hand-picked file list, and the result was
  generalised to the repository.

## [0.2.6] — 2026-08-03

### Fixed

- **`keryx gdgraph build` was broken on every fresh install.** `init` copies a
  few `src/gdgraph/*.ts` files into `.metaproject/core/gdgraph/` so a scaffolded
  project can run the graph builder without the full toolkit. That list was
  hand-maintained, in two places, and nothing checked it against what those
  files import — so when `query.ts` gained `import … from "./target"` in
  `0.2.3`, the copied core stopped being import-closed:

  ```
  error: Cannot find module './target' from
    .metaproject/core/gdgraph/query.ts
  ```

  This is the **first "Next step" `init` prints**, and the suite stayed green
  throughout, because nothing ever ran the copied tree.

  The list is one shared constant now, and `core-sources.test.ts` computes the
  transitive closure of *runtime* imports from the entry points and asserts the
  list covers it. A new `import` in a copied file now fails a test instead of a
  stranger's first five minutes.

  Two things the guard gets right on purpose: type-only imports are excluded
  (they never reach runtime), and a `dynamic-import` is excluded because it is a
  deliberate lazy edge — `build.ts` reaches `enrich` that way *precisely* so it
  can run where `enrich` is absent, and that environment is the copied core
  itself.

### Documentation

- **The README now opens with what keryx removes, not what it contains**, and
  shows a real run on a freshly cloned `expressjs/express`: 139 nodes, 153
  edges, no cycles, and the dependency/dependent answer for `lib/express.js`.
  Every line of that output came from the run, which is also how the scaffold
  bug above was found — the walkthrough died on its second command.
- Adds **"Is this for you?"**, naming who should *not* install: people who want
  a hosted service, people on Linux who need the network allowlist, people who
  need remote approvals today, and people who expect it to do the thinking.

## [0.2.5] — 2026-08-03

### Fixed

- **Toggling any module silently deleted an enabled `mcp` from the manifest.**
  `keryx modules` knew eight of the ten modules, and a toggle re-invokes `init`
  with flags derived from that list — so the two it did not know were decided by
  the *absence* of a flag rather than by the operator.

  The two absences behaved differently, which is why one list could not describe
  both. `security` is default-**on**: no `--no-security` meant it survived, but
  it could never be disabled through this command and never appeared in
  `modules status`. `mcp` is default-**off**: `init` writes its manifest entry
  only when `--mcp` is passed, so a project with MCP enabled lost it on any
  unrelated toggle.

  Both are now in the list, and each module declares whether `init` scaffolds it
  by default. A default-off module re-sends its enable flag to survive.

  Demonstrated rather than asserted — on `0.2.4`, `init --yes --mcp` followed by
  `modules disable memory` leaves **no `mcp` entry at all**; with the fix the
  entry survives and `memory` alone changes. `modules status` now lists
  `security` and `mcp`.

### Added

- `keryx modules enable|disable security` and `… mcp` now work. `security` was
  reachable only through `init` flags before this.

## [0.2.4] — 2026-08-03

### Documentation

- **`docs/docs/architecture.md` now has five diagrams and no longer predates the
  architecture.** It was corrected rather than rewritten: most of its 310 lines
  were accurate, and replacing verified prose with new prose would have traded
  content for churn.

  The diagrams are Mermaid in Markdown, so they diff in git and need no build
  step. Every arrow is a named module or file and the decision nodes carry their
  `file:line`.

  Three of the five exist to correct something the source contradicted:

  - the system-context diagram had to stop the document saying "no HTTP server",
    which stopped being true when remote entry shipped;
  - the harness diagram is preceded by a **two-tool-systems table**, because a
    single picture of "the tool loop" is false in both directions — the durable
    `ToolExecutorPort` returns an `outputHash` and structurally cannot feed a
    live model, while the `InteractiveTool` layer the shell runs returns content.
    And no shipped path registers a tool at all;
  - the containment diagram makes the **macOS/Linux split structural**, because
    Tier 2 does not degrade on Linux — it refuses.

  The remote-entry diagram draws the nine-step ordered decision path rather than
  listing it, because `serve-turn.ts:3-7` states that *the order rather than the
  set is the control*.

- The module map gained eight missing rows — harness, sandbox, tui, session,
  serve, projects, metrics, contracts — plus a module-versus-command
  discriminator. A module has a manifest entry, a manifest file and a
  `src/<feature>` behind a verb; `review`, `serve`, `orient` and `sync` have none
  of that. Listing `serve` as a module was an error introduced in `0.2.0`.

- Layer 1 is described as the `CLI_ROUTES` table it is, not the "flat if-chain"
  it stopped being.

## [0.2.3] — 2026-08-03

### Fixed

- **`keryx ctx rg "pattern" src/one-file.ts` reported `(unknown)` and `0:0` for
  every hit.** ripgrep omits the filename whenever it is given a single explicit
  file path, which breaks the `file:line:col:text` shape `parseRgMatches`
  requires — so agents were handed matches they could not locate.
  `--with-filename` now joins the base argv unconditionally; it is a no-op for
  the multi-path and directory cases. (PR #211)
- **The code graph was under-resolving edges on this repository.** After the
  gdgraph fixes the same tree yields **1,873 edges against 1,397 before**, from
  649 nodes. (PR #211)
- Entropy and PII detector corrections, with fixture cases. (PR #211)

### Added

- **CI installs ripgrep.** One test spawns the real binary to prove ripgrep
  emits `file:line:col` for a single explicit path — an oracle about an external
  tool. Skipping it when the tool is absent would have left the assumption
  unverified while the job stayed green, so the tool is installed instead. This
  is what the pull request's red check actually was.

### Note on the merge

PR #211 was opened on 2026-07-26 and sat behind 24 commits. `buildRgCommand` had
been rewritten on `main` in the meantime to allowlist ripgrep flags — a caller's
`--pre=…` had reached arbitrary command execution through the one operation
agents are told to prefer over raw grep — and it now returns a result rather
than an argv. Both changes were kept: the security structure from `main`, the
`--with-filename` fix from the branch, asserted together so neither can be
dropped while the other still passes.

## [0.2.2] — 2026-08-03

### Security

- **A credential that merely exists no longer chooses the network posture of an
  unrelated command.** `keryx harness exec` decided "restricted network" from
  the count of mask inject-hosts. Those come from masks resolved against every
  provider key in the environment *and* in the user-global `auth.json` — so a
  saved key for a provider the command never touches silently widened the run to
  restricted networking with TLS termination on macOS, and blocked the command
  outright on Linux, where `restricted` is refused. The same
  `harness exec -- /bin/echo hi` worked or failed depending on whether an
  unrelated key existed on the machine.

  The posture is now decided by `resolveNetworkRestriction`, which takes the
  operator's intent and nothing derived from the environment: credentials are
  not a parameter, so they cannot reach the decision. Inject hosts still join
  the allowlist once a restricted run has been asked for — they no longer cause
  one.

  The five ways an operator can ask are a discriminated union with a total
  `switch`. The exhaustiveness was **verified, not assumed**: planting a sixth
  member fails `tsc` with `TS2366`. Nine unit tests cover each way, the fixed
  precedence, and the empty-list cases — `--allowed-domains ""` is not a request
  to restrict with no domains.

## [0.2.1] — 2026-08-03

### Security

- **The egress allowlist is now enforced inside terminated TLS tunnels.**
  Previously the allowlist was checked against the CONNECT target only. Once TLS
  termination was on, the decrypted request's `Host` header chose the upstream
  and was never re-checked — so a contained process could CONNECT to an
  allowlisted host and then address any other host from inside the tunnel. No
  decision was recorded for that inner hop either, so the egress was invisible
  in the reported rulings.

  The inner `Host` is now matched against the allowlist and passed through
  `decide(...)`, which closes both the bypass and the blind spot. Real
  credentials were never exposed — masks filter on their own inject-hosts — so
  this was a containment and observability failure, not a disclosure one.

  It ships with **a planted counter-example**: a test that sets a foreign `Host`
  inside the tunnel and asserts the refusal. Affects macOS only, because TLS
  termination is macOS only. (PR #210)

### Added

- **A macOS real-host CI job** covering the OS sandbox and the TUI pty launch.
  Until now the platform where the allowlist, credential masking and TLS
  termination actually run was the platform with no live containment test.
  (PR #210)

### Documentation

- A verification step in a flow plan is a task, not a sentence (PR #221).
- `shared-definitions` for the rules library, so places that agree connect by
  import instead of by restatement (PR #222).

## [0.2.0] — 2026-08-03

The first release since `v0.1.0`, covering 570 commits: the OS sandbox, the
agent harness and multi-agent engine, the OpenTUI shell, and the remote entry.

### Changed — packaging (read this before upgrading)

- **The npm package is now `@mrciphersmith/keryx`.** The unscoped name `keryx`
  on npm belongs to an unrelated, actively maintained project
  ([actionhero/keryx](https://github.com/actionhero/keryx)) — installing it gets
  you a different program. Install with:

  ```bash
  npm install -g @mrciphersmith/keryx
  ```

  The executable is still `keryx`; no command changes. The `curl` and `bun`
  installers described in the README are unaffected.
- `prepack` was removed. `prepare` alone builds `dist/`, so packing no longer
  runs the build twice (flagged in the 2026-07-10 readiness report).

### Added — remote entry (`keryx serve`)

- **A loopback-bound HTTP entry over the agent harness**, off by default. Bearer
  authentication compared in constant time, with only a salted hash persisted;
  `serve token issue | rotate | revoke`. Authentication runs *before* routing, so
  an unauthenticated caller cannot distinguish a known path from an unknown one.
  `refused` binds no socket at all — it is never a degraded listen.
  (R4b, flow 128, PR #216)
- **`POST /v1/turns` — remote turn submission with SSE streaming.** Idempotency
  keys are scoped per project, so two projects cannot collide on one key; turn
  records are durable; the remote policy profile is compared against the local
  one and may never be weaker; authentication failures are throttled. An `ask`
  decision terminates in a **recorded denial** — approvals are a later slice.
  (R4c, flow 133, PR #220)
- **`keryx projects` — a user-global project registry**, populated by
  `keryx init`, with `list | register | forget`. Nothing on the machine knew the
  project set before this. (R4a, flow 127, PR #215)

### Added — sandboxing and containment

- **A kernel-enforced OS sandbox under the policy engine:** workspace-write
  filesystem boundaries and secret read-deny via macOS Seatbelt and Linux
  bubblewrap, with network off / on / restricted. No new npm dependencies.
- **A loopback domain-allowlist proxy** reporting allow/deny rulings, plus opt-in
  TLS termination for HTTPS masking. Both are macOS-only and **refuse to run on
  Linux** rather than degrading to full host network.
- **Credential auto-masking**, defaulting to `auto` when the restricted sandbox
  is on, resolved env → project → global → built-in. Secrets come from the
  user-global `auth.json` only.
- **Harness hardening:** mask-without-TLS fails closed, spawn failures carry
  structured diagnostics (the exit-71 class), and a portable deep-probe script
  ships with a report schema.

### Added — the agent harness and multi-agent orchestration

- **A full execution loop** (`src/harness/`): append-only session store, an
  allow/ask/deny policy engine, a tool registry, a provider port with fake,
  Anthropic and Ollama adapters, resume and recovery, branching and compaction,
  guarded mutation with approval, replay, budget and monitoring.
  CLI: `keryx harness run | exec | extension | wave`.
- **Subagent orchestration**, reachable today through the interactive shell's
  spawn tool: a fail-closed child-model resolver, a policy-gated provider
  allowlist, depth and count caps against one shared run-scoped budget ledger
  including the cost dimension, and child-output injection quarantine (which
  flags, and never rewrites, child text).
  - Child containment rests on three things together: `shell_exec` is absent
    from a child's tool list, the child policy denies it, and the approver is
    hard-false.
- **Implemented and tested, but not yet wired to any caller:** cost-aware model
  escalation, git-worktree isolation, bounded peer messaging, and the
  orchestrator-state fold. Each of these modules is imported by exactly one file
  — its own test. They are extension points, not behaviour you get today.
  Scoped per-child credentials are in the same position: the provider option
  exists and is tested, but no production path passes it, so a live child reads
  the ambient environment.
- **A typed `MetaprojectPort`** with published schemas, so the harness, the
  interactive agent and the MCP server reach graph/wiki/memory/context in-process
  from one source instead of through subprocess wrappers.

### Added — interactive shell

- **A full-screen OpenTUI shell is now the default when `stdout` is a TTY**,
  replacing the line-based renderer; `--no-tui` and a graceful readline fallback
  remain. Adds a live `/` command composer, a persistent composer region,
  per-block collapse, and framed markdown with code and diff rendering.

### Added — observability

- **Provenance-aware execution metrics:** active-time accounting, per-run
  evidence, baseline-aware CI and a retry taxonomy. *No performance claim has
  been made* — the paired Keryx/no-Keryx protocol exists to make one honestly.

### Added

- Language-aware gdgraph import resolution: Java (Maven/Gradle source roots,
  fully-qualified-name → file mapping) and Python (dotted modules, `__init__.py`
  packages, and relative `from . import x`) source now produce real dependency
  edges instead of nodes-only graphs. TypeScript/JavaScript resolution is
  unchanged (byte-identical graph output). Seeds the Java/Python tree-sitter
  grammars on `init`/`update`.
- Symbol-aware graph navigation with `gdgraph find`, `symbol`, `path`,
  symbol-aware `affected`, and transitive caller impact via `symbol --impact`.
- Deterministically pinned tree-sitter grammar assets and explicit symbol-layer
  enable/disable/status commands.
- Hierarchical wiki collection with full module coverage, code-to-wiki backlinks,
  symbol-kind annotations, and an explicit draft-enrichment work front.
- Turn-start graph + wiki orientation hooks for Claude, Codex, and Cursor.
- Multi-runtime gdctx routing guards for Claude, Codex, Cursor, Windsurf,
  OpenCode, and other supported harnesses.
- Managed review packages for standalone reviews, flow-attached reviews, report
  ingestion, coverage tracking, decisions, and learning handoff.

### Changed

- Graph symbol resolution now disambiguates loose names and resolves cross-file
  calls before computing callers and impact.
- Agent bootstrap rules enforce the Metaproject hard gate before project work.
- Model-backed features remain opt-in, while deterministic fallbacks and asset
  availability are surfaced more clearly.
- The shipped `@xenova/transformers` runtime was removed, reducing the optional
  dependency footprint by roughly 230 MB; compatible transformer-style adapters
  can still be configured explicitly.

### Fixed

- Natural-language graph queries now redirect to the correct `find`, `ctx rg`,
  and `affected` workflow instead of silently producing low-value output.
- Wiki/code relationships and symbol caller graphs no longer under-report common
  cross-file references.
- gdgraph import-resolution metric no longer reports a false `100%` when zero
  imports were extracted (a `0/0` denominator); it reports `n/a` instead, and
  non-relative imports that fail to resolve are recorded as `unresolved` edges
  rather than silently dropped.

### Security

- The agent shell allowlist is a **boundary, not a string match**; the
  destructive risk class is wired into the shell approval gate; an approval is
  bound to the action it approves; and the agent can no longer grant itself
  shell permissions.
- Subagent isolation is pinned and a child's summary is bounded.
- Search argv is separated and caller-supplied paths are contained.
- Six adversarial review rounds on the remote-entry branch produced twelve
  blockers, all closed. Their single common cause is recorded as a durable
  lesson: [branching on a value whose domain you never wrote down](.metaproject/memory/lessons/branching-on-a-value-whose-domain-you-never-wrote-down.md).

### Documentation

- Refreshed public, developer, CLI, architecture, module, onboarding, workspace,
  and release-readiness documentation for the post-`v0.1.0` feature set.

### Known gaps

Recorded here rather than in a release announcement, because they are the things
a reader would otherwise discover by hitting them.

- **Approvals over the remote entry are not implemented.** Until they are, a
  remote turn that needs one is denied and the denial is recorded.
- **`GET /health` and cross-process liveness are absent.** No PID file exists, so
  `keryx serve status` reports configuration state only; `listening` and
  `draining` are knowable only over the authenticated `GET /v1/status`.
- **The domain allowlist, credential masking and TLS termination are macOS-only**
  and refuse to run on Linux rather than silently weakening.
- **`pii: { action: "allow" }` still redacts** — an open question about the
  policy resolver, not the detector.
- **The source-pattern guards in `src/lib/config-dir.ast.ts` are heuristics, not
  closures**, and carry a written list of known gaps as executable tests.

## [0.1.0] — 2026-07-10

First tagged release. `keryx` installs a deterministic, local, offline,
git-diffable `.metaproject/` workspace of agent-facing tooling, with an opt-in
capability seam for model/embedding features (disabled = byte-identical, zero
runtime dependencies, no sockets).

### Core modules

- **gdgraph** — code graph, symbols, and affected context. Parser-backed import
  resolution (`Bun.Transpiler.scanImports`, regex fallback), N-hop transitive
  `affected`, token-budgeted `repomap.md`, and an opt-in tree-sitter symbol layer.
- **gdctx** — token-aware wrappers for search, reads, diffs, and command output.
- **gdwiki** — project knowledge base. Deterministic `collect` derives real
  per-module signals (dependencies, key files by connectivity, entry points,
  exported symbols) as prose-first drafts; an agent enrich workflow fills the
  understanding on a cheap model; `collect --changed` for incremental runs.
- **gdskills** — bundled working skills plus project-skill create/route/verify/
  learn lifecycle, schema-governed orchestration (`subagent-dispatch` →
  `subagent-result`, STATUS protocol), and a `docpack-orchestrator` for
  requirements packages.
- **health** — aggregated code health, scoring, quality gate, and a
  churn × complexity hotspot signal.
- **testing** — test context, related-test selection, normalized reports, and an
  opt-in coverage-map TIA with an always-on smoke tier.
- **memory** — long-lived project memory with bitemporal facts, memory typing,
  optional local embedding rerank, and `--as-of`/`--class` search.
- **tasks (flow)** — agent-first flow lifecycle: frozen acceptance criteria,
  a strict status state machine, PR-gated completion (AC + PR checks + health +
  security), tracker adapters (`gh`), and natural-language discovery.

### Platform

- **Metaproject Standard** — `standard validate|doctor|capabilities|emit`, a
  self-describing manifest, and profiles.
- **MCP interop** — `keryx mcp serve [--http]`: a stdio-first server mapping
  Tools to `createXService()` methods and Resources to read-only artifacts;
  `llms.txt` and gdskills plugin export.
- **Metaproject Security** — agent input/output/artifact security: secrets, PII,
  prompt-injection and exfiltration/egress detection with HMAC-keyed hashing,
  safe redaction, a config-integrity self-protect, write-seam gates, multi-runtime
  hooks, and a red-team eval harness (advisory by default).
- **Capability seam** — `resolveCapability(id) → Adapter | null`, `optionalDependencies`
  + lazy import, deterministic fallback as a tested path, and an asset resolver
  (`assets.lock.json`, `assets list|verify|pull`).

### Tooling & UX

- `keryx init` / `update` / `modules` / `dashboard` — TTY-aware styled output
  (banners, module status, next steps) that degrades to clean plain text off-TTY.
- **Human dashboard** — a dark-first, navigable HTML admin view with a health-score
  ring, module cards, an "Attention" section, a Tasks/flows summary, and an in-page
  markdown modal for every linked `.md`.

### Reliability

- Atomic `.metaproject` writes (temp + rename) so a crash never corrupts a
  single-source-of-truth file.
- File locks (dependency-free, atomic `mkdir`) around flow mutations and gdskills
  manifest/learn read-mutate-write, so concurrent AI-agent sessions never lose
  updates.
- Serialized `process.chdir` in tests — no cross-file cwd races.

[0.1.0]: https://github.com/MrCipherSmith/keryx/releases/tag/v0.1.0
[0.2.0]: https://github.com/MrCipherSmith/keryx/compare/v0.1.0...v0.2.0
[0.2.1]: https://github.com/MrCipherSmith/keryx/compare/v0.2.0...v0.2.1
[0.2.2]: https://github.com/MrCipherSmith/keryx/compare/v0.2.1...v0.2.2
[0.2.3]: https://github.com/MrCipherSmith/keryx/compare/v0.2.2...v0.2.3
[0.2.4]: https://github.com/MrCipherSmith/keryx/compare/v0.2.3...v0.2.4
[0.2.5]: https://github.com/MrCipherSmith/keryx/compare/v0.2.4...v0.2.5
[0.2.6]: https://github.com/MrCipherSmith/keryx/compare/v0.2.5...v0.2.6
[0.2.7]: https://github.com/MrCipherSmith/keryx/compare/v0.2.6...v0.2.7
[0.2.8]: https://github.com/MrCipherSmith/keryx/compare/v0.2.7...v0.2.8
[0.2.9]: https://github.com/MrCipherSmith/keryx/compare/v0.2.8...v0.2.9
[0.2.10]: https://github.com/MrCipherSmith/keryx/compare/v0.2.9...v0.2.10
[0.2.11]: https://github.com/MrCipherSmith/keryx/compare/v0.2.10...v0.2.11
[0.2.12]: https://github.com/MrCipherSmith/keryx/compare/v0.2.11...v0.2.12
[0.2.13]: https://github.com/MrCipherSmith/keryx/compare/v0.2.12...v0.2.13
[0.2.14]: https://github.com/MrCipherSmith/keryx/compare/v0.2.13...v0.2.14
[0.2.15]: https://github.com/MrCipherSmith/keryx/compare/v0.2.14...v0.2.15
[0.2.16]: https://github.com/MrCipherSmith/keryx/compare/v0.2.15...v0.2.16
[0.2.17]: https://github.com/MrCipherSmith/keryx/compare/v0.2.16...v0.2.17
[0.2.18]: https://github.com/MrCipherSmith/keryx/compare/v0.2.17...v0.2.18
[0.2.19]: https://github.com/MrCipherSmith/keryx/compare/v0.2.18...v0.2.19
[0.2.20]: https://github.com/MrCipherSmith/keryx/compare/v0.2.19...v0.2.20
[0.2.21]: https://github.com/MrCipherSmith/keryx/compare/v0.2.20...v0.2.21
[0.2.22]: https://github.com/MrCipherSmith/keryx/compare/v0.2.21...v0.2.22
[0.2.23]: https://github.com/MrCipherSmith/keryx/compare/v0.2.22...v0.2.23
[0.2.24]: https://github.com/MrCipherSmith/keryx/compare/v0.2.23...v0.2.24
[0.2.25]: https://github.com/MrCipherSmith/keryx/compare/v0.2.24...v0.2.25
[0.2.26]: https://github.com/MrCipherSmith/keryx/compare/v0.2.25...v0.2.26
[0.2.27]: https://github.com/MrCipherSmith/keryx/compare/v0.2.26...v0.2.27
[0.2.28]: https://github.com/MrCipherSmith/keryx/compare/v0.2.27...v0.2.28
[0.2.29]: https://github.com/MrCipherSmith/keryx/compare/v0.2.28...v0.2.29
[0.2.30]: https://github.com/MrCipherSmith/keryx/compare/v0.2.29...v0.2.30
[0.2.31]: https://github.com/MrCipherSmith/keryx/compare/v0.2.30...v0.2.31
[0.2.32]: https://github.com/MrCipherSmith/keryx/compare/v0.2.31...v0.2.32
[0.2.33]: https://github.com/MrCipherSmith/keryx/compare/v0.2.32...v0.2.33
[0.2.34]: https://github.com/MrCipherSmith/keryx/compare/v0.2.33...v0.2.34
[0.2.35]: https://github.com/MrCipherSmith/keryx/compare/v0.2.34...v0.2.35
[0.2.36]: https://github.com/MrCipherSmith/keryx/compare/v0.2.35...v0.2.36
[0.2.37]: https://github.com/MrCipherSmith/keryx/compare/v0.2.36...v0.2.37
[Unreleased]: https://github.com/MrCipherSmith/keryx/compare/v0.2.37...HEAD
