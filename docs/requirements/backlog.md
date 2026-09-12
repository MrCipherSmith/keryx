# Backlog

Work found while doing something else and deliberately not done at the time.
Companion to `roadmap.md`: the roadmap tracks requirements packages and their
implementation state, this file tracks loose findings that have no package yet.

Every entry below was **measured**, not suspected, and each names the command or
the file:line that shows it. An entry that cannot say how it was found does not
belong here.

Opened 2026-09-12 from the skills-quality programme
(`docs/plans/skills-quality-program.md`, flows 256-259). Items fixed on the way
are not listed; these are the ones left.

## How to read an entry

**Why not then** is the load-bearing field. Most of these were found inside a
flow whose scope was something else, and doing them there would have widened a
change that was already under review. A few are breaking changes to a published
surface, which the CLI interface rule says ship with their consumers named
rather than as a rider.

---

## CLI surface

### 1. An unknown flag is ignored by most commands

`keryx review` refuses one with a message that says why — "Refused rather than
ignored — a flag that is silently dropped writes nothing and reports success"
(`src/commands/review.ts:315`). Measured on 2026-09-12: `keryx review scope
--bogus` exits 1 and names the flag, while `keryx modules status --bogus --json`
and `keryx skills verify --bundled --bogus` both exit **0** and ignore it. The
guard exists twice — `rejectUnknownFlags` (`review.ts:307-318`) and
`rejectUnknownOptions` (`src/commands/workspace.ts:296-300`) — and is applied
almost nowhere else.

A user who mistypes `--bundled` gets a successful-looking run over the wrong
scope. A script passing a flag a newer keryx removed keeps reporting success
while doing something else.

Also here: `--target-ref` (`review.ts:147`, `:409`) is a silent alias of `--ref`
with no help entry and no notice. Per
`rules/core/cli-interface-design.mdc`, either document it or refuse it by name.

**Why not then:** rolling it out is user-visible — a command that used to ignore
a flag starts failing — and it will surface real callers passing flags nothing
reads. Each of those is a finding that wants its own answer.

**Size:** one helper, then a sweep. Expect the sweep to be the work.

### 2. `--ref` is a two-dot diff in `review scope` and `review blast-radius`

`gitDiff` builds `git diff --no-color -U<n> <ref>` — that ref's tree against the
working tree — so every commit the base gained since the branch forked comes
back inverted: the base's additions read as your removals. `gitChangedFiles`,
which `blast-radius` uses, has the same shape.

Reproduced end to end: base adds three assertions after the fork, the branch
touches nothing, and the command reports them as removals. This is not
theoretical — it fired on flow 258's own branch and blamed it for two commits
`main` had gained meanwhile.

`keryx review floor` was fixed in `024df529` by resolving `git merge-base HEAD
<ref>` and diffing against that sha (deliberately not `<ref>...`, which ends at
HEAD and would drop the working tree). Reuse that helper.

**Why not then:** `floor` was unreleased, so its `--ref` could change meaning
for free. `scope` and `blast-radius` shipped in 0.2.96-0.2.98, so changing what
`--ref` selects changes what existing callers parse — enumerate the consumers
first, including the review orchestrator skills and the managed-review pipeline.

**Size:** small change, real blast radius.

### 3. `keryx health run` cannot say "I could not tell"

`runExitCode` (`src/commands/health.ts:120-132`) folds `incomplete` — a required
check missing, skipped or unparsed — into exit 1, the same code as a real
violation. So "eslint was skipped" is indistinguishable from "eslint found 40
errors", which is the failure mode the gate exists to prevent.

`keryx wiki sections resolve` (`src/commands/wiki.ts:561-570`) already runs the
0/1/2 convention with its reason in the code, and `keryx memory search` adopted
it. `rules/core/cli-interface-design.mdc` states it as the standard.

**Why not then:** changing an exit code is breaking for anything gating on it;
the consumers want enumerating first.

### 4. An unknown command writes its help to stdout

`src/cli.ts:147-152`: the diagnostic goes to stderr and then ~9.5 KB of help
goes to **stdout**. Measured: `keryx bogusverb` = 9,503 bytes on stdout,
`keryx wiki check --bogus` = 4,150. On the error path stdout is certainly not
the answer, so the help belongs on stderr.

**Size:** small, and mostly a sweep for per-command equivalents.

### 5. The `keryx skills --json` envelopes carry no version

Eleven `JSON.stringify` sites in `src/commands/skills.ts` (`:222 :288 :398 :693
:735 :785 :822 :883 :935 :989 :1101`). Three print a type that declares
`schemaVersion`; eight print nothing versioned, and the **envelopes** are
unversioned in all eleven. `skills verify --all --json` returns a bare array,
which contradicts `rules/core/skills-storage-workflow.mdc:181` ("One top-level
JSON object only") and can never grow the field later.

`src/gdskills/export.ts:167-193` is the standard to follow: it bumped
`schemaVersion` for a field removal, with the reason in the code and a test
pinning it.

---

## Review machinery

### 6. Review package ids collide across flows

A package id is minted from the date and the ref, so two flows reviewed on the
same day against the same base both get `2026-09-12-ingest-origin-main`. On
2026-09-12 `keryx review complete <id>` for flow 258 resolved to **flow 257's**
package. Nothing was corrupted, because the command refused to overwrite
evidence that was already recorded — that refusal is the only thing that caught
it.

Addressing a package by path works (`.metaproject/flows/<flow>/reviews/<id>`),
so this is a defect in id minting or in resolution, not a missing capability.

**Suggested:** include the flow id in the package id, or refuse an ambiguous id
and name the candidates.

### 7. `keryx review floor` — declared gaps

Not defects; recorded so nobody rediscovers them as bugs. The module's own
NOT DETECTED list is the source of truth, and it names: a threshold renamed in
the same edit; a bar named only by the assertion around it (`expect(score.recall).toBe(1)`
becoming `toBe(0)`); an assertion weakened in place rather than deleted; a
deletion that nets out against an addition in the same region; a test table
built by a call (`describe.each(build(x)).skip(`); anything the scope pre-filter
drops, including lockfiles and generated paths.

The narrowing that produced most of these was measured: over the 200 commits
ending at `5d5e1acc`, threshold findings fall from 25 to 2, and 22 of the 25
were renumbered markdown lists or step headings.

---

## Contracts

### 8. The `task-implementer` output contract has no reader

`enforcement.kind` is `"none"` (`src/gdskills/contracts.ts:368-380`): the skill
writes the file and no keryx command reads it back. The three fields added in
flow 258 — `noticed_not_touched`, `assumptions`, `not_touched` — are therefore
declared and unread, and no version field was added precisely because a version
nobody branches on is decoration.

The honest trigger for both is the first consumer that reads the file back. If
one is planned, it changes `enforcement.kind`, which
`contract-enforcement.test.ts` guards.

---

## Attribution

### 9. Flow 257's adapted techniques carry no credit

`docs/plans/skills-quality-program.md` lists what was consciously adapted from
[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT).
Flows 256 and 258 placed inline credits by the convention
`docs/skills/rejected-skill-changes.md` established; flow 257 merged without
them.

Owed, one line each:

- `src/gdskills/bundled-eval.ts` — one credit covering the required anatomy
  lint, the length budget and description discipline, all implemented there;
- `src/commands/routing-corpus.ts` — the corpus shape: positives per skill plus
  negatives naming the owner that must outrank them.

**Not owed**, and the reasons matter as much as the debts:
`src/commands/routing-baseline.ts`, whose device — record current behaviour
*including what is wrong* before touching the scorer — is traced in its own
header to a local failure across three review rounds; and
`src/gdskills/skill-length-ceilings.ts`, a data table for a check living
elsewhere and governed by our own down-only policy. Crediting those two would
credit a topic rather than an adaptation.

---

## Programme

### 10. Flow 259 — behavioural evals with a control arm

The last flow of `docs/plans/skills-quality-program.md`, not started. What
distinguishes it from the source it adapts: a **without-skill control arm** and
repeated runs, so the effect of a skill is measured rather than asserted. It
also owes an honest update to the bundled-eval layer status, which still
describes layers two and three as not built.

Depends on 257 and 258, both merged.
