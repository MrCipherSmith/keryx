# Review Orchestrator — detail

Overflow reference for `review/review-orchestrator`, linked from its SKILL.md.
Read the section SKILL.md points you to; nothing here overrides SKILL.md.

## Project-local reviewers

`keryx review reviewers --json` returns every project-skill under module
`review`. The routing tables in SKILL.md cannot name a project reviewer's
triggers, so each `project` entry carries its own. Use them; do not re-derive
them from the reviewer's prose.

### Selecting project reviewers — the same two filters, from the inventory

| Field | Use |
|---|---|
| `flags` | The reviewer's selection flags: `metadata.flags` from its frontmatter when it has at least one non-empty entry — then it takes precedence, even when none of its entries turns out to be a flag or it holds only `--all`, and the reviewer has no flags — otherwise the flags its description names. An empty `metadata.flags` (`[]`, `''`) leaves the description's flags in force. Already normalised (lower-case, `--` prefixed), so compare a passed flag with them as they are. A flag the user passed that is in this list selects the reviewer. Whether that selection is also exempt from the path gate depends on `familyFlags`. `--all` selects every project reviewer. |
| `flagWarnings` | One line per `metadata.flags` entry that was dropped because it is not a flag after normalising, plus one more when that left the reviewer with no flags. A list of only `--all` leaves no flags and no warning. Empty in the ordinary case. A dropped entry selects nothing: do not match a passed flag against the raw spelling in the reviewer's frontmatter. Dispatch the reviewer as its other fields say, and name the warnings once in the report — a reviewer its author meant to be flag-selectable is not. Never a finding against the code. |
| `familyFlags` | The subset of `flags` that at least one other project reviewer also carries. A passed flag listed here is a **family flag**: it selects this reviewer, and the reviewer stays path-gated. A passed flag that is in `flags` and not here is unique to this reviewer: the selection is **explicit** and never path-gated, like any flag-selected bundled reviewer. |
| `paths` | Its path triggers for the **path gate**. No file in scope A matches → `Skipped reviewers`, reason `no-matching-paths`. |
| `pathsSource` | `metadata` (declared `metadata.paths`) or `description` (globs read out of its description, and the literal file paths such as `src/utils/column-zone.ts` listed beside them; a cited `.md` / `.mdc` document and a `.metaproject/` path are not triggers). A description with no glob gives `none` even when it names a file: a literal path counts only beside a glob. `none` means there is nothing to gate on: **dispatch it** — ambiguity includes. |
| `stackRequires` | Apply stack scoping exactly as for a bundled reviewer carrying `metadata.stack_requires`. |
| `unresolvedRules` | Rules it cites that the project does not have. Dispatch it anyway, tell it in the prompt which rules are absent, and name them once in the report with the fix (`keryx review import --from <overlay> --only '<glob>'` copies them). Never a finding against the code. |
| `shadowedRules` | `[{ ref, resolved }]`: rules it cites by one path and must read from another. The project holds its own version of the rule at `resolved` — the reference's slot under `.metaproject/rules/project/`, the whole reference kept (`core/x.mdc` → `.metaproject/rules/project/core/x.mdc`) — which answers the reference before the file `ref` names. In the dispatch prompt, tell the reviewer to read `resolved` in place of `ref` — see "Dispatching a project reviewer" below. Not a defect and not reported as one. |
| `unresolvedReferences` | `[{ ref, reason }]`: other references in its text that will not hold. `missing` — a backticked `skills/…` or `rules/…` path ending `.md` / `.json` with no file under `.metaproject/`; `non-portable` — a rule cited by an absolute or `~` path, true on one machine at most. Dispatch it anyway, tell it in the prompt which references are absent, and name them once in the report. Never a finding against the code. |

`metadata.paths`, `metadata.flags` and `metadata.stack_requires` are read by
one frontmatter reader that supports a YAML subset (BOM and CRLF accepted,
trailing `# comments` dropped, `paths` and `flags` as a flow, block or
comma-separated list, `stack_requires` as a string, only keys directly under
`metadata:`); a shape outside it reads as not declared.
`reviewer-skill-creator`'s `SKILL.detail.md` lists the subset. The inventory
has already applied it — use the fields, not the raw frontmatter.

A description saying another entry point dispatches it ("Dispatched by
acme-review …") is its author's routing note, not a restriction: this
orchestrator dispatches it through the fields above.

### Family flags — why a shared flag does not lift the path gate

An overlay usually gives every reviewer it ships the same umbrella flag beside
the reviewer's own: eight reviewers all carrying `--acme`, each also carrying
`--acme-styling`, `--acme-testing` and so on. Read as explicit, `--acme` would
dispatch all eight against a diff that touches one of their path sets — the
waste the path gate exists to stop, brought back by a flag.

So the two cases are told apart by how many project reviewers carry the flag,
and the inventory reports the answer per reviewer in `familyFlags` rather than
leaving the orchestrator to count:

| Passed flag | In this reviewer's `familyFlags`? | Result |
|---|---|---|
| `--acme` | yes (shared) | selected, then path-gated on its `paths` |
| `--acme-styling` | no (unique to it) | selected explicitly, not path-gated |
| both | — | the unique flag wins: not path-gated |

A family member gated out goes to `Skipped reviewers` with reason
`no-matching-paths` like any other gated reviewer. `pathsSource: none` still
means dispatch. An inventory that has no `familyFlags` field comes from a keryx
that predates it: treat every passed flag as explicit, which is the earlier
behaviour, and say so once in the report.

### Dispatching a project reviewer — by its package, not by its name

Each `project` entry carries `path`, the directory its package is registered
at. Dispatch it with the absolute path of `<path>/SKILL.md` as `skill_path` in
the reviewer input, and state in the prompt that this file is the reviewer's
definition and overrides the built-in definition of any agent type with the
same name. `skill_path` in the reviewer input is set for project reviewers
only, and it carries that override. A bundled reviewer's input never has it:
when one runs through the `general-purpose` fallback, the prompt text names its
skill file and `review_context.review_plan.dispatch_plan` records the path, but nothing is
being overridden, so the input field stays out. This holds on every branch of "Agent Runtime Compatibility" in
SKILL.md: when a same-named agent type exists, dispatch it **with** the path
and the override sentence; when none exists, dispatch `general-purpose` with
the same two things.

The reason is a name collision nobody chose. A runtime can ship an agent type
whose name equals a project reviewer's — an earlier copy of the same reviewer,
or an unrelated one. Dispatched by name alone, the round runs that built-in
prompt and files its findings under the project reviewer's name, and nothing in
the report shows the project's own text was never read.

If `<path>/SKILL.md` does not exist, the reviewer is `BLOCKED`: record the
missing path, continue with the independent reviewers, and do not run the
same-named agent type or any other reviewer in its place. A substituted
reviewer reads as coverage the round did not have.

**Shadowed rules go into the same prompt.** For every entry in the reviewer's
`shadowedRules`, add one line to the dispatch: "where your text names `<ref>`,
read `<absolute path of resolved>` instead" — for a reviewer citing
`core/error-handling.mdc`, that is
`<project root>/.metaproject/rules/project/core/error-handling.mdc`. Take the
path from `resolved`; do not build it from the rule's filename, because the slot
keeps the reference's directory and a file lying directly in `rules/project/`
answers only a literal `project/<name>.mdc` citation. An import keeps an
overlay's rule in that slot whenever a file already answers the reference with
other content, or the name is one keryx also ships under `rules/core`, because
`keryx init`, `keryx update` and the legacy-profile `keryx skills install`
overwrite `rules/core` with keryx's own rules (the manifest form with
`--target keryx-shell` skips an existing file it did not record unless
`--force`; see "Skills present only when installed"). The reviewer's text was written against the overlay and
still says `core/<name>.mdc`, so followed literally it reads keryx's generic
rule of the same name and reviews against the wrong standard — silently, since
both files exist. The inventory computes the project-first order and reports
it; no loader applies it. This line in the dispatch is the only place it takes
effect, and a project reviewer run outside this orchestrator reads what its
text names.

### `drift` — the source moved, the reviewer did not

A project reviewer built from an external file — a rules file, a review profile,
a conventions doc — records where it came from and the hash of that file at
import. `keryx review reviewers` re-reads the source and reports:

| `drift` | Meaning | What to do this round |
|---|---|---|
| `none` | No origin recorded; written here. The text row reads `(no recorded origin)` | Nothing |
| `clean` | Source matches the import | Nothing |
| `changed` | Source has moved on since import | Dispatch it, and say so in the report |
| `missing` | Source can no longer be read | Dispatch it, and say so in the report |

**A drifted reviewer still runs.** It is a reviewer built from an older version
of its source, which is a fact about provenance, not a defect in its findings —
suppressing it would trade real coverage for tidiness. Record the drift in
`review_context` and name it once in the report, so the next person knows the
profile is due a re-read. Never file it as a finding against the code under
review: it is a fact about the review, not about the diff.

## Skills present only when installed

SKILL.md names five skills that the `minimal` and `recommended` profiles do not
install — they are in the `full` profile only (`src/gdskills/catalog.ts`):

| Skill | Reached through |
|---|---|
| `review-pr-feedback` | "A round never answers a pull request another skill is answering" |
| `code-ai-review` | `--code-ai`, `--legacy-profiles` |
| `code-learned-review` | `--learned`, `--legacy-profiles` |
| `code-style-review` | `--code-style`, `--legacy-profiles` |
| `code-mobx-store-review` | `--mobx-store`, `--legacy-profiles` |

Whether one is **present** is read from `keryx review reviewers --json`, and
the answer depends on the inventory's `bundledSource`, which says which tree
the `bundled` half was read from. Do not infer presence from the flag table,
which describes what keryx ships, not what this project has.

| `bundledSource` | What the `bundled` half is | Is a listed skill installed here? |
|---|---|---|
| `"project"` | this project's `.metaproject/skills/gdskills/review` | yes; one that is not listed is not installed |
| `"package"` | the review skills the keryx package itself ships | the list cannot say |
| `"not-found"` | empty — neither tree could be located (the command exits 1) | the list cannot say |

`"package"` means the project has no `.metaproject/skills/gdskills/review`
directory at all — a worktree or clone whose `.metaproject/` holds only data,
for instance. The inventory then lists every review skill in the package, all
five above included, whatever profile the project would install, and each
entry's `path` is relative to the keryx package (`src/gdskills/bundled/…`), not
to the project. Nothing is installed in this project in that state, so a name
being in the list is not evidence that it is, and a name missing from it is not
what `not-installed` means either. Decide each of the five by what can actually
be dispatched: if the runtime has an agent type of that exact name ("Agent
Runtime Compatibility" in SKILL.md), the skill is usable and is dispatched as
any other reviewer; if it does not, record `not-installed` with the command
below, because the project holds no skill file to hand a `general-purpose`
agent. Say once in the report that the bundled half came from the package, so
nobody reads the round's reviewer list as this project's install.

`"not-found"` is a failed inventory, not an empty install: report it and do not
record any reviewer as `not-installed` on its strength.

When one is absent:

- **A legacy reviewer a flag asked for** is not dispatched and not replaced.
  Record it in `Skipped reviewers` with reason `not-installed` and the command
  below. `--legacy-profiles` dispatches the legacy reviewers that are
  installed and records the others the same way; `--all` never selects them. Leave an absent reviewer out of
  the `Optional legacy/profile reviewers` preview: offering a flag that cannot
  run is worse than not offering it.
- **`review-pr-feedback`** changes nothing about a round. No caller can declare
  that it owns a pull request's reply, so this orchestrator owns the reply as it
  does by default. If the user wants existing pull-request comments interpreted
  and answered, say the skill is not installed and give the command; do not
  improvise its workflow from this file.

Adding one. The commands are `keryx skills install` in its two forms
(`src/commands/skills.ts`):

```bash
# everything the full profile holds, including all five
keryx skills install --profile full

# manifest installer: the generic review module only — review-pr-feedback,
# code-ai-review, code-learned-review and code-style-review among its skills
keryx skills install --profile core --target keryx-shell

# manifest installer: add the MobX component to a profile — code-mobx-store-review
keryx skills install --profile <manifest-profile> --with capability:mobx --target keryx-shell
```

What those flags do and do not reach:

- `--target keryx-shell` is what writes under `.metaproject/skills/gdskills/`,
  where the inventory looks. Without it the manifest installer targets `claude`
  and writes `.claude/skills/`.
- `--with <id>` is repeatable and takes a **component** id from
  `install-manifest.json` (`capability:mobx`, `framework:react`, …). It has no
  single-skill form: the smallest unit the manifest installs is a module.
  `review-pr-feedback` and the three `code-*` profile reviewers live in module
  `review-core-skills`, which belongs to no component and arrives through a
  profile that lists it (`core`, `full`).
- Add `--dry-run` first to read the plan. A file already on disk that the
  manifest installer did not write is left alone unless `--force` is passed.

What to expect from the exit code:

- **The manifest-installer forms can exit 1 after installing what was missing.**
  `applyInstall` (`src/gdskills/manifest/apply.ts`) writes every planned file
  whose destination is free, skips every planned file that already exists and
  is not recorded in the manifest installer's install-state (or has drifted from
  its recorded hash), and returns `ok: false` when it skipped anything;
  `src/commands/skills.ts` turns that into exit 1. The legacy installer, which
  `keryx init` uses, records no such state, so on a project it set up the output
  is a `Wrote N file(s)` line for the missing skills, then a `Skipped (existing
  file not recorded in install-state…)` list naming the skills already there,
  then exit 1. Running the command again gives the same skip list and the same
  exit code.
- **Judge the outcome by the inventory, not the exit code.** Run
  `keryx review reviewers --json`: with `bundledSource: "project"`, a skill in
  the `bundled` half is installed. (`"package"` after an install means the
  install did not write under `.metaproject/skills/gdskills/review` — check
  `--target`.) If it is there, continue. If it is not, read the `Skipped` and `Errors` lines
  for the skill's own path before doing anything else. `--force` makes the
  installer overwrite the skipped files with the bundled copies, local edits
  included, so it is the user's call, not a default retry.
- **`keryx skills install --profile full` does not behave this way.** With no
  manifest flag it takes the legacy route (`installGdskills`,
  `src/gdskills/install.ts`), which copies each bundled skill directory over the
  installed one without consulting install-state, and rewrites the project's
  skills catalog and gdskills module manifest for the `full` profile. It sets
  exit 1 only when `.metaproject/` is absent; a destination it will not write
  through (a symlink, a non-directory) is listed under `Warnings` with exit 0.
- **The dry-run's `Apply this plan:` hint is the whole command.** It repeats
  every plan-shaping flag (`--with`, `--without`, `--include-deprecated`,
  `--target`, `--profile`), so run it as printed.

Run `keryx review reviewers --json` again afterwards and dispatch from what it
returns.

## CLI-engine reviewers — dispatched as a command, not a sub-agent

`review-jev-rules` (flow 330), `review-jev-risk` and `review-jev-scenarios`
(both flow 332), `review-jev-docs` and `review-jev-comments` (flow 333), and
`review-jev-contract` (flow 335) are ADDITIONAL reviewers, never replacing
any other, and their dispatch mechanism differs from every reviewer named in
SKILL.md's Routing Table: there is no platform-native agent to invoke,
because each is a deterministic **keryx program**. Run them with `keryx
review jev-rules --scope <scope.json> --json`, `keryx review jev-risk
--scope <scope.json> --json`, and `keryx review jev-scenarios --scope
<scope.json> --json` — the SAME `scope.json` every other Wave A/B reviewer's
dispatch already reads, so each checks exactly the same hunks.
`review-jev-docs` and `review-jev-comments` take a diff/PR target instead:
`keryx review jev-docs (--diff <ref>|--pr <n>) --json` and `keryx review
jev-comments --pr <n> --repo <owner/repo> --json`. `review-jev-contract`
also takes a diff/PR target, plus an optional linked flow: `keryx review
jev-contract (--diff <ref>|--pr <n>) [--flow <id>] --json` — a `--pr` target
checks the description's own claims; `--flow <id>` additionally checks that
flow's frozen acceptance criteria (reusing flow 328's `check-ac.ts`, see its
own SKILL.md). Read each `--json` output as a `REVIEW_RESULT` and merge its
`findings` into the consolidated array exactly like a sub-agent reviewer's:
same Sub-Agent Report Quality Gate, same dedup, same Wave C verification.
`review-jev-risk` additionally emits `ranked` and `routingHints`;
`review-jev-scenarios` additionally emits `checklist`; `review-jev-contract`
additionally emits `claims`, `budget`, and (when `--flow` was given)
`acCheck` — see each reviewer's own SKILL.md for what to do with its extra.

Gate each BEFORE running its command, not after: skip it — recorded in
`Skipped reviewers` with the reason, never silently absent — when its own
opt-in (`review.jev.rules` / `review.jev.risk` / `review.jev.scenarios` /
`review.jev.docs` / `review.jev.comments` / `review.jev.contract`) is not
`true` in `.metaproject/tasks.config.json`, or when no Jev/OpenRouter
credential is resolvable. Either gate failing means the command itself would
refuse before any read or network call, so checking first saves a doomed
dispatch. The six opt-ins are independent: any subset may be on.
`review-jev-comments` additionally needs a comment ledger to already exist
(`keryx review comments collect` run first) — it refuses, before any read,
when there is none. When `review.jev.contract` is on, dispatch
`review-jev-contract` with `--pr` (never `--diff`, which has no description
to check) and let its `findings` cover the description-vs-diff claim, in
place of the by-eye Stage 1 judgement described in SKILL.md's "This gate owns
the description-vs-diff comparison" — see that section's own note.

`keryx review reviewers --json` marks a CLI-engine reviewer with
`"engine": "jev"` on its `bundled` entry — the field's presence, not its
absence, is what distinguishes it from the default (an LLM sub-agent
dispatch). A future engine-backed reviewer follows the same pattern: gate on
its own opt-in and reachability, dispatch as a command, merge its `--json`
output the same way.

### Measured verdicts (flow 344 — a live benchmark on a large production React/MobX frontend)

Gating them on is still a project's own choice; these are RESULTS, not a change to the gates above.

| Reviewer | Verdict | Measured |
|---|---|---|
| `review-jev-risk` | **Off by default** — measured weaker than a strong model | Top-3 recall 21% vs. "largest diff first" 30%; Sonnet 5 alone: 44%. |
| `review-jev-contract` | **Off by default** — measured weaker than a strong model | Caught 12.5% of false PR-description claims vs. Sonnet 5's 67.5%. |
| `review-jev-rules` | **Not useful on top of a strong reviewer** | Dispatched as an EXTRA reviewer beside an already-strong reviewer: +0 findings. |
| `review-jev-scenarios` | Experimental — not measured | — |
| `review-jev-docs` | Experimental — not measured | — |
| `review-jev-comments` | Experimental — not measured | — |

By contrast, `keryx review ci-triage` (Step 0b, not a reviewer) and `keryx
review jev-select` (Step 5c, not a reviewer either) both have a measured case
FOR them: CI triage cut developer minutes per failure from 30 to 15.4 under an
explicit cost model (38% vs. 25% flaky/regression/infra accuracy against
Sonnet 5 reading the same log, p=0.035); reviewer *selection* is the
unmeasured lever this benchmark named as most promising, which is why
`jev-select` ships recall-first and fails open rather than waiting for a
measurement that has not run yet. Full numbers, methodology and the cost
model: `docs/docs/jev-in-review.md`.

## `jev-triage` — advisory annotations, not a reviewer (Step 9b)

`review-jev-triage` (flow 340) is a DIFFERENT shape from every CLI-engine
reviewer above: it never produces a `findings` array of its own, and it is
never merged into the consolidated array. It runs AFTER the Sub-Agent Report
Quality Gate has already validated/merged/deduplicated the round's findings
(Step 9) and BEFORE the later Wave C passes (Step 10; the early verifier pass starts first, on the findings held then) — Step 9b in the Workflow
block — annotating the findings that already exist. It is advisory and
annotate-only by construction: nothing it returns drops or demotes a finding,
and no downstream step is permitted to treat its output as anything but a
hint.

Run it once per round, over the round's own consolidated findings:

```bash
keryx review jev-triage --report <this round's review package dir> --json
```

Gate it the same way as every other CLI-engine reviewer: skip it — recorded
in `Skipped reviewers` with the reason — when `review.jev.triage` is not
`true` in `.metaproject/tasks.config.json`, or when no Jev/OpenRouter
credential is resolvable. Either gate failing means the command itself would
refuse before any read or network call.

Its `--json` output is `{status, reviewer: "review-jev-triage", summary,
annotations, budget, tokens}` — never a `REVIEW_RESULT` merged into the
findings array. `annotations` carries three tracks, each read and used
differently in the report:

| Track | Shape | What to do with it |
|---|---|---|
| `severity_check` | `{id, p, flagged}` per blocker/major finding — `flagged` means `p < 0.4` | Show `flagged` findings as a soft note next to their existing severity ("Jev's own trigger+outcome check scored this low"). Never change the finding's `severity` field from this alone. |
| `merge_candidates` | `{id, a, b, reason, p}` per candidate pair | A high `p` is a suggestion to a human that `a` and `b` may be the same defect — surface it in the report as a note on both findings. Never merge, drop, or renumber either finding from this alone. |
| `verify_order` | `{id, p}`, sorted lowest-`p`-first | Feed this order into the later Wave C passes — verify the lowest-plausibility findings first — never as a reason to skip verifying any of them. |

`status` is `DONE_WITH_CONCERNS` — never `DONE` — when any `severity_check` is
`flagged` OR any `merge_candidates` pair scores `p >= 0.5`
(`LIKELY_DUPLICATE_THRESHOLD`, `src/commands/review-jev-triage.ts`). Live-check
calibration found same-file pairs that were NOT duplicates scoring around
0.6, so a merge candidate above the threshold is a prompt to look, never a
merge — the status flip is a nudge to read the pair, not a verdict that the
findings are duplicates.

Show its annotations in the report as their own subsection, next to (not
inside) the findings they annotate — same separation the finding schema
itself draws between a reviewer's claim (`severity`, `problem`, …) and what
became of it (`disposition`), which a reviewer never states and this pass
does not either.

## Clean context — why, the log, the three accepted paths

A review must be reproducible from its package: the same inputs give the same context, whoever runs it and whatever that agent remembers from earlier work. So the round starts empty and every input has a named source.

**Inputs.** Only the orchestrator's context stages (scope, Review Context Pack, the memory stage, layers) and, for a reviewer, its payload. The agent's session memory, the auto-memory index (`MEMORY.md`), remembered feedback and the earlier conversation are not inputs, and neither is a second memory search made "to double-check".

**The three accepted paths** are known and kept on the operator's decision (poll 179), not leaks:

1. `prior_findings` — findings of an earlier round of the same package enter by design from round 2 on.
2. Review-notes and skill learning — auto-accepted output of earlier reviews reaches a later one only through the memory stage, as accepted memory.
3. A reviewer's `memory_search` — the reviewer agents keep it as a lookup in the project's recorded lessons.

**One memory read, and the log.** The stage query is `keryx memory search "<changed modules and the concepts they touch>" --status accepted`, once. Pass the same text to `keryx review start … --memory-query "<query>"` so the manifest's `cleanContext` block holds it next to the start time. keryx writes the orchestrator log, `<package>/tool-calls/orchestrator.jsonl`, on its own: `keryx review start` and `keryx review attach` mark the package active, and every `keryx memory` command and every MCP memory tool (`memory_search`, `memory_handoff`, `memory_propose`) appends one line naming its caller. You do not write that file and must not edit it; a hand-written line is a forgery the readiness item cannot tell apart from a record. A call by a `spawn_subagent` child is recorded under the child's reviewer id and is not judged by item 10. A call from a host that names no caller is recorded as `unattributed`: it warns in the item's detail line and never blocks. Reviewer logs stay in their own files.

Item 10, `memory-outside-stage`, reads that log. Outside the stage is: a memory search with a different query, a search without `--status accepted`, any other memory command or MCP memory tool, and a stage call stamped before the round started. The same query repeated is the stage. Repair is to rerun from a session whose only memory read is the stage; only the operator's waiver lifts it: in keryx shell call `review_waive_readiness` (the operator answers a card, never a terminal), then call `review_complete`; outside keryx shell `keryx review complete <package> --waive memory-outside-stage "<operator quote>"` in a terminal; unattended, record Not run. With no orchestrator log the item passes and its evidence says it could not see your reads; with a log that holds no memory call it passes and says so. Outside keryx shell, `keryx review start` prints a caller token (`export KERYX_REVIEW_CALLER_TOKEN=…`): export it on this session's keryx calls so they are attributed to you; without it the item reads "not observable on this host" rather than a clean pass. Only calls that go through keryx are visible: a read through a tool keryx does not wrap is not in the log.

**Open questions.** One general rule, replacing per-fork wording: the answer is in this skill or `SKILL.detail.md`, or it is the user's. Interactive: one `AskUserQuestion`, or one `send_poll` when the operator is in Telegram. Unattended: the whole output is one line, `STATUS: BLOCKED question — <the question>`, and you stop. A guess and a recollection are both wrong answers.

**Named limit.** An agent runtime that loads its memory before this skill starts cannot be prevented by keryx. The guarantee is instruction plus detection, not isolation, and reads of the agent's personal memory outside `keryx memory` are not visible to the log.

## Start questions (Step 5) — once per round, after the context pack

The round asks its operator three questions, once, in one interaction, after
Step 1 (context pack) and Step 3 (scope) — never before them: the counterpart
question cannot be answered well until the context pack has looked for the
other side. On Claude Code that is one `AskUserQuestion` call carrying the
three questions (one `send_poll` for a Telegram operator); on any other host, the lettered prompt below. An unattended
round (job pipeline, trigger, schedule) asks nothing, applies the defaults and
records them under `### How this review was run`.

1. **Reviewers** — default the set `keryx review required --depth auto` prints
   (light, or the full set the engine detects plus every project and convention
   reviewer its gates admit); `--all` only when the operator asks. Narrowing is an explicit
   choice (tests only, one domain, a custom list). Flags the caller passed
   answer this question and skip it. Convention reviewers are part of this
   question; the job setting `convention_reviewers` still answers it in a
   `job-orchestrator` pipeline.
2. **Counterpart** — the other side of every contract the diff consumes or
   mirrors: the backend for a frontend change, the frontend and other consumers
   for a backend change. Before asking, the context pack looks for it:
   endpoints, DTOs and rules the diff calls or mirrors, a paired PR
   (`gh pr list --repo <counterpart> --search <branch-or-feature>`), the
   producer at a freshly fetched SHA. The question shows what was found —
   "no link found" included — and one checkbox, **verify the counterpart**, ON
   by default even when nothing was found. Verification is not limited to a
   paired PR: the other side's contracts and logic are re-read at a pinned SHA
   every round. When the round cannot locate that code itself (repository,
   handler, validator), it asks the operator where it is; it never records
   `state: unavailable` on its own. Skipping verification takes a reason, and
   the reason goes in the report.
3. **Models** — the complexity the round already holds signals for (changed
   files and lines, the risk class from Depth floor below, domains, scope B),
   the per-role tier `keryx review tier` prints for each planned dispatch, and
   the model each tier resolves to on this host. Choices: accept the plan (the
   default), all `deep`, or custom. The plan is shown once per round, never per
   dispatch (`rules/core/model-selection.mdc`). Skills, rules and this file name
   tiers only; model ids appear in the rendered question and the report.

```text
Context: <PR or branch>, <N> files / <N> lines, <domains>; risk: <class>

1) Reviewers     A) the `required --depth auto` set (default)  B) --all  C) tests only  D) <domain> only  E) choose
2) Counterpart   found: <endpoints, rules, paired PR — or "no link found">
                 A) verify <backend|frontend> (default)  B) skip — give a reason
3) Models        complexity: <low|medium|high>; <role>: <tier> → <model>, …
                 A) accept (default)  B) all deep  C) custom

> answers (default: 1A 2A 3A)
```

## Policy questions mid-round — the `policy` tag and the arbiter

A question the round raises with `ask_user` about scope, budget, partial coverage, a smaller slice, slice order or
which option to take carries a `policy` tag: `{ kind, facts }`. `kind` is one of `scope`, `budget`,
`option_choice`, `partial_coverage`, `smaller_slice`, `slice_order`. `facts` holds only numbers and booleans that
describe the **recommended** option (for `budget`: `budgetUsedPercent`, `raisesBudget`; the guide lists the rest).
Nothing from the diff, a finding or a PR comment goes into the facts: the arbiter builds its prompt from the tag and
nothing else, so a quote there is dropped, and a question that carries one is shaped by outside content, which the
arbiter does not decide.

In `review-auto` and in an unattended run the review arbiter answers a tagged question from its numbered rules and
writes `arbiter.log` into the package; `allow` takes the recommended option, `deny` and `escalate` refuse in an
unattended run and ask the operator in `review-auto`. An untagged question keeps the old behaviour. A release, a
merge, a credential, a destructive action or a publish is never tagged and never the arbiter's: those ask a person,
and in an unattended run they are refused. In an interactive `ask` round the operator is asked, tagged or not.

## Depth floor — a gating round does not degrade

A round is **gating** when its verdict lets a change move: the review step of a
flow (`flow-orchestrator` Phase 3), a pre-merge or pre-ship review, a
re-request after fixes. A gating round runs the composition the start questions
selected.

- **No dispatch tool, no review.** A host with no spawn tool hands the round to
  the autonomous runner (`keryx review run --autonomous --target pr --ref <pull
  request URL>`, or `--target branch --ref <base> [--head <commit>]`), which
  spawns the reviewers itself; a nested session whose depth budget is spent
  returns `STATUS: BLOCKED` with reason `nested_dispatch_unavailable` and no
  verdict. Neither reviews the diff alone and calls that a round. Measured (flow 405):
  a single-agent round on a 150-line frontend PR wrote "did not dispatch any
  sub-reviewers", approved it with two cosmetic minors, and the next human round
  filed six real findings, every one reachable from the diff and the backend at
  a pinned SHA.
- **Size never lowers depth below the risk class.** The budget table sizes the
  context, not the depth. Outside the risk class a small change does not need the
  whole roster: `keryx review required --depth auto` picks the **light** round —
  `review-logic`, `review-testing-practices` and the stack-conventions reviewer
  only — when the diff is at most 5 files and 300 changed lines, matches no risk
  path gate, and is neither `--all` nor gating. Auto needs a file list AND a line
  count: `--scope <scope.json>` gives both (`review start|ingest --scope` stores
  the count in `scope-files.json`, so `--package <review-dir>` has both too);
  with either missing the round is full. Light is only ever granted by those auto
  checks; `--all`, gating and `--depth full` force full. A light round records `Not run: mutation
  (light round)` instead of the mutation gate and says so in the report. Inside the
  risk class the round is full.
- **High-risk includes a client-side mirror of a server rule** — validation,
  limits, permissions, uniqueness, reserved names — beside the triggers the main
  file lists.

## Counterpart verification — the contract is enumerated, not summarised

For an **input rule** the diff mirrors or depends on (what the server accepts
for a name, a value, a role), the `cross_repo` entry records the producer's
complete check set in `checks` and how that set was found in
`enumeration_method` (`review-context.schema.json`):

- every check the producer runs on that input: validators, restriction
  utilities, uniqueness queries, reserved-name registries, and the storage bound
  (column width, index, a downstream identifier);
- for each check: its `source` (`file:line` at the pinned SHA), whether it is
  case-sensitive, and the `paths` it runs on (create, update, rename, copy,
  import, move, …).

Put these rules in every reviewer dispatch:

- **The facts are a starting point, not a boundary.** A reviewer may read the
  producer itself and file what the entry missed.
- **"The producer has no limit" is a question, not a fact.** Find what bounds
  the value — that is where an over-long or unexpected value fails, usually as a
  server error.
- **Build the surfaces × checks matrix**: every surface that sends the input
  against every check, each cell `same`, `missing`, `stricter` or `looser`.
  `missing` is a refusal the user meets late; `stricter` blocks legal input; a
  check the producer lacks but storage enforces is a producer defect — filed as
  pre-existing, or fixed by a paired change.
- **Every refusal the producer can return is shown where the user can act on
  it** — next to the field, not as a generic toast.

## Round obligations — always on, never asked

These apply to every round without a question:

1. **Enumerate before concluding.** Every caller and surface of a changed value
   is found with `keryx ctx rg` or gdgraph, and the query is recorded — never
   taken from the diff's own list.
2. **Quantified claims are checked.** "Every", "all", "only" and "never" in the
   PR body or the commits are compared with that enumeration; an over-claim is a
   `minor` finding, the same class as the description-versus-diff rule.
3. **A verified-clean line names its sites.** Each line of the `Verified clean`
   lane names the files, sites or commands it rests on; "the frontend does the
   same" without them is not verified.
4. **A pre-existing defect gets a disposition.** Every pre-existing defect the
   round finds in the contract the change touches is recorded with one: fixed in
   the change (small, same contract), named out of scope in the PR body, or a
   recommended issue. Found and dropped is the failure this rule exists for.
5. **Red on the parent, per test.** Every added test fails with the parent
   commit's production files restored; the run is the evidence.
6. **A threaded value is pinned per site.** A parameter, key or prop passed at
   several render sites is asserted at each site, or centralised so there is
   one.
7. **One rule, one implementation.** The same check implemented twice is a
   finding, even while both copies agree.
8. **"Do not re-raise" needs a record.** A dispatch may exclude an item only by
   citing the PR comment, issue or decision that settled it — never a whole
   surface ("X has no test; covered elsewhere").

### Runtime research-completion ledger

New managed packages carry `research.json`, initially pending. Before closing a round, enumerate unresolved observations from raw reviewers and the changed-file/consumer census, assign stable obligation IDs, and investigate them. Run the probe or inspect the relevant source and assertions: merely proposing a check does not resolve it. An unexecuted probe is not a verified claim. `keryx review ledger build` writes the ledger from the saved raw results and turns each raw finding into an obligation; it closes one only from a matching canonical finding or a `--dispositions` entry that carries evidence and a reason, and it leaves everything else `unresolved`.

Supply the ledger using `keryx review ingest --research <ledger.json>` alongside the report and findings. Format: `version: 1`, `scopeReviewed: true`, `rawReconciled: true`, `obligations: [...]`. Each obligation requires `id`, `source`, `question`, `status`, `evidence`, `reason`. Status `finding` additionally requires `finding` pointing to exactly one canonical finding ID or global ID. Other terminal statuses are `refuted` and `out-of-scope`, both requiring evidence and reason. Preserve distinct scenarios when deduplicating. Assert census/reconciliation flags only after performing those checks; an empty obligations array is valid only if the actual census found no open observations.

Open, deferred and unverifiable obligations block completion. If context, runtime or budget prevents resolution, retain the obligation and report incomplete; do not relabel it refuted or out-of-scope. Completion and the flow gate re-read the ledger even when the manifest says closed. Legacy packages without this artifact remain compatible, not proven complete. This gate validates the declared ledger, not the truth or exhaustiveness of its census; independent source/raw audits remain necessary.

## Why Wave C verifies instead of re-scoring

Wave C used to run `review-strict`: a meta-pass that re-read the consolidated
findings and **adjusted their severity with no new evidence**, under an elevation
table biased 3:1 toward escalation. It was **removed, not improved**, and the
reason is measured rather than stylistic:

- **GPT-4 on GSM8K across self-correction rounds: 95.5 → 91.5 → 89.0.**
  **GPT-3.5 on CommonSenseQA: 75.8 → 38.1.** Among the answers that changed,
  correct → incorrect exceeded incorrect → correct (Huang et al., *Large Language
  Models Cannot Self-Correct Reasoning Yet*, ICLR 2024, arXiv:2310.01798).
- **Self-Refine (arXiv:2303.17651): +49.2 on dialogue response generation, +0.2
  on maths.** Self-refinement gains are on subjective tasks and vanish on
  verifiable reasoning. Judging whether a null-guard is missing is verifiable
  reasoning.

Re-scoring a finding by re-reading it is therefore not a rigour pass; it is a
coin flip weighted toward more findings. **Do not restore it because it looks
obviously useful — it looked obviously useful the first time.**

`review-verifier` occupies the slot and differs in exactly one way that matters:
**it runs something.** Verification that executes rejects 85–96% of false reports
against 4–15% unaided while finding 30–44% more true bugs (AnyPoC,
arXiv:2604.11950); Meta's TestGen-LLM funnel discards 75% of its own output
(75% build → 57% build and pass → 25% improve coverage) and the surviving quarter
reaches 73% human acceptance (arXiv:2402.09171).

## Scope B — bounds, rejections and recompute

It walks `gdgraph affected` outward from every changed file, ranks by edge
distance, keeps distance ≤ 2, cuts at 40 files closest-first, and adds a changed
file's naming-related tests when the graph did not already reach them. Requires a
built graph — run `keryx gdgraph build` if it refuses.

**Do not pick the files yourself, and do not widen it.** "Review the
functionality so nothing breaks" naively means "review the whole repository every
round", which is unaffordable *and* actively harmful: review quality decays as
context grows — measured F1 0.65 at round 2 falling to 0.29 at round 10. An
unbounded scope B makes later rounds worse than earlier ones.

The bounds are measured on this repository, not guessed: at depth 2 the set is a
median of 19 files (p90 65); depth 3 buys eight more in the median and doubles
the p90. The 40-file cap fires on 25% of commits and removes only hop-2 entries
on all but 2 of 80, so it almost never costs a direct dependent — and when it
does, it says so.

**Record the whole thing.** `--out "<review-package>/blast-radius.md"` writes the
set, the depth, and **every file the cap removed**. A truncation nobody can see
reads afterwards as "we checked everything", which is the claim this pipeline
exists to stop making. An empty radius is reported as `unresolved`, not as clean:
the graph indexes code, so a change to a skill, a rule or a schema has no blast
radius at all and that is a different fact from "nothing depends on it".

### The scope-B question, and what is rejected

> Does this change break an existing behaviour **at these sites**?

Nothing else. The blast-radius set is **under regression check, not under
review**. A finding about style, naming or architecture in code the change did
not touch is refused **by the orchestrator in code** — not discouraged here —
under three rules, every one of them a fact about the claim rather than about who
made it:

| Rule | Refused because |
|---|---|
| `outside-set` | the file is neither in the computed set nor in the changed set; the reviewer went browsing |
| `non-regression-severity` | below `major`. Under the canonical rubric `minor` states the code behaves correctly and `info` names neither trigger nor outcome; neither can be a claim that something broke |
| `no-link-to-change` | nothing in the finding names a changed file, module or symbol. A regression claim says THE CHANGE broke this site |

Rejections are **recorded, not deleted** — raise the observation under scope A or
as a separate review. Pass `--brief` output verbatim into the scope-B dispatch:
the code rejection is the enforcement, but a reviewer told afterwards has already
spent the round producing findings that will all be refused.

`class_scope` on a scope-B finding names the **caller that breaks**, not the
changed line, because that is the site a human has to look at.

### When it is recomputed

| Round | Scope A | Scope B |
|---|---|---|
| 1 (first after the draft PR) | yes | yes |
| 2..N | yes | recomputed only if the changed-file set moved |
| final | yes | **yes, always** |

Do not decide this by memory:

```bash
keryx review blast-radius --ref "${BASE_SHA}" --previous blast-radius.json [--final]
```

It prints the decision and the reason, and reuses the previous record when
nothing moved. The final round recomputes whatever the file set did — otherwise a
fix introduced in round 3 gets no regression check at all, and the round that
certifies the flow is the one that checked the least.

## Readiness — the checklist behind `completed` and behind publishing

`keryx review readiness <review-id-or-path> [--json]` reads the package and prints every readiness item, READY or NOT READY, each with the evidence and the command that repairs it. It writes nothing, and exits non-zero when the verdict is NOT READY. Only item 9 reaches GitHub (the PR's own file list); the TUI and `review status` read the package alone.

1. `files-covered` — every changed file is in a wave or carries a recorded waiver.
2. `blast-radius` — no file the blast radius cut is left unreviewed. A cut radius writes `chunks.json`; run `keryx review chunks plan`, `estimate`, `next`/`record`, `merge`. In an unattended run every wave runs without a question, up to the 25-pass ceiling; in an interactive run the operator is asked once: in keryx shell call `review_chunks_answer` (a card, never a terminal); elsewhere the operator runs `keryx review chunks estimate --package <dir> --answer yes --quote "<their words>"` in their terminal; unattended, record Not run.
3. `reviewers` — every planned reviewer was dispatched and its result ingested.
4. `verifier` — the verifier checked every finding it should, or the report says how many it did not.
5. `ledger` — the ledger is READY.
6. `coverage-md` — coverage.md does not list a reviewer as `run` that the dispatch record says did not finish. Re-run `keryx review ingest` for the package.
7. `head` — the report's head is the PR head.
8. `report-names` — pending mutation candidates and parity warnings are named in the report.
9. `pr-files` — the changed-file count equals the PR's own file list. A recount more than 3x the recorded scope is refused: it came from the wrong base. Recount with `keryx review blast-radius --package <ref> --changed <the PR's files>`.
10. `memory-outside-stage` — the orchestrator read memory only in its memory stage ("Clean context" above). Outside keryx shell it reads "not observable on this host" unless this session's keryx calls carry the caller token `keryx review start` printed.
11. `premise-decisions` — every finding `review-premise` held (`challenged` or `owner-decision`) has an operator decision: in keryx shell the card `review_decide_premise`; elsewhere ask the operator with the host's question tool and record the answer with `keryx review decide-premise --package <dir> --finding <global_id> --answer uphold|dismiss --reason "<why>" --answered-by <source>:<ref> --answer-text "<their words>" --question-text "<the question>"` (SKILL.md "Wave D"; the record reads `confirmedVia: "host-question"`). Not waivable: each held finding needs its own answer, and `review_waive_readiness` / `--waive` refuse this item.
12. `quotes-located` — every open finding whose quote `review ingest` could not place (absent from the file at the reviewed head, or in it more than once) has a disposition. Ingest keeps such a finding with no line, flagged `quote_unlocated` and listed in scope.md, instead of refusing the round. Re-quote one distinct line and re-ingest, record a disposition, or the operator waives the item.

`keryx review complete` refuses status `completed` while any item fails. A failing item other than `premise-decisions` is waived only by the operator. In keryx shell call `review_waive_readiness` for the item: the operator answers it as a card, the waiver is recorded with the card text and the time, and then you call the `review_complete` card (the operator answers it in the shell or in the Telegram topic). An agent completes a review only through that card; `keryx review complete` is for a human in a terminal. Never send the operator to a terminal. Outside keryx shell the operator runs `keryx review complete --waive <item> "<their own words>"` in a terminal, repeatable. Unattended, record the item as Not run. `keryx review publish` is held by the same checklist. Publishing is the operator's decision too: in keryx shell call `review_publish` (a card shows the target and the body; never send the operator to a terminal). A not-ready package goes to GitHub only as a partial review (`review_publish` with `partial: true`, or `keryx review publish --partial`), which puts a "Partial review" header on the post and never approves. The shell guard stops a publish command that runs through the keryx shell; a publisher outside it (CI, another agent, a script file) is not stopped, and that limit is named, not hidden.

## Fix rounds — dispositions, regressions, withdrawal

### Every prior finding leaves the round with a disposition

A fix round that reports only new findings is unreadable: the author cannot tell
which of their fixes landed. Close the loop explicitly — one line per prior
finding, in the report, before the new findings:

| Disposition | Meaning |
|---|---|
| `closed` | Checked against the code, not against the commit message, and the defect is gone |
| `open` | The fix does not reach the defect; say what is still true |
| `partial` | One site of the class was fixed and the enumeration named others |
| `regressed` | The fix removed this defect and introduced another — file the new one separately |
| `withdrawn` | The finding was wrong. See below |

**Check the code, not the commit message.** A commit titled *"report an abandoned
sync as abandoned"* is a claim; the disposition is whether the branch it renamed
is reachable and pinned. On a recorded round, two such commits asserted behaviour
on lines no test could reach.

### Delta rounds — what `review start` hands you

`keryx review start` detects the round and writes `<package>/round.json` and `<package>/prior_findings.json`. It searches every source, because the earlier round may have run on another machine: the local package, git history (tracked package files), the PR's `keryx round` block, PR comments, and the flow's packages. `round.json` carries `round`, `source`, `sourcesTried`, `previous`, `mode`, `range`, `fixHunks`, `newHunks` and `carried`.

| `mode` | `range` | Review |
|---|---|---|
| `first` | merge-base..head | A first round. `sourcesTried` records what was searched when nothing was found. |
| `delta` | previous head..head | `fix` slices (a hunk that answers a prior finding): `review-logic`, `review-regression`, the authors of the attached findings, `review-security-code` when one of them is a security finding, the roles the fix lines themselves route by content (e.g. `review-security-code` for a fix that spawns a process), and the verifier, each with its `prior_findings`. `new` slices: round 1, with the roles the slice names. Unchanged code: not re-reviewed. `carried` findings keep their dispositions. |
| `fallback-first` | merge-base..head | The previous head is not an ancestor (force-push, rebase). Review the whole range with the prior findings attached. |

A fix hunk still has a radius: enumerate what names the thing it changed (`review_context.scope.files`), as in any fix round. The attached findings are the contract: each leaves the round with a disposition, below.

A reviewer on a FIX slice reports those dispositions itself: its `REVIEW_RESULT` carries `prior_dispositions: [{id, disposition}]` with one entry for every attached finding id (`disposition` is `closed`, `open`, `partial`, `regressed` or `withdrawn`), judged against the code. `keryx review ingest` reads the array into the ledger; an attached id with no entry stays undisposed.

### A fix is a change, and changes get reviewed

The most expensive class in a multi-round review is **the defect the fix
introduced**. It is systematically under-found, for a structural reason: the fix
arrives framed as the answer to a finding, so it is read as an answer rather than
as new code. It is new code.

So scope A of a fix round includes the fix, reviewed on its own merits, and the
report carries its own section:

```markdown
## Regressions the fixes introduced
<[F-NNN] — the finding it was answering, and the new defect it created>
```

Recorded shapes, all from fixes that correctly closed the finding they answered:
an early return added to stop a fall-through, which then skipped the work the
caller needed; a persistence call added to save expanded state, which then
persisted the broken state on the error path too. Both were closed correctly and
both shipped a new bug in the same commit.

### Withdrawing your own earlier finding

A finding from a previous round that this round disproves is **withdrawn**,
explicitly, at the top of the report, with the evidence — before any new finding.

This is not a courtesy. An uncorrected wrong finding costs the author a fix they
did not need, and it stays in `prior_findings` steering later rounds. Withdrawal
is also the one self-correction this pipeline permits, and it is permitted because
it is asymmetric: it *deletes* a claim, so it cannot inflate the finding count,
which is the failure mode that removed the re-scoring pass from Wave C.

State what made the original claim wrong, in one sentence, and if the same
reasoning error has now happened twice in one review, say that too. A reviewer
that names its own recurring error is calibrating; one that quietly drops a
finding is hiding a result.

## Job Context Awareness

When dispatched by `job-orchestrator` or called with an explicit context path, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: .metaproject/jobs/<job-name>/ai/context.md
```

If provided and the file exists, read the context document **before** running scope detection.
Use it to understand:
- Intentionally chosen libraries and patterns (do not flag as issues)
- Architectural decisions already agreed upon, and acceptance criteria driving the Stage 1 spec compliance gate

If absent, proceed normally — context is optional and non-blocking.

## The mutation pass — `keryx review mutate`

Attended, the pass is not optional once mutants were proposed. The testing reviewer writes
each proposed mutant to `<review-dir>/research-evidence/mutants.json`:
`{ "mutants": [{ "id", "file", "anchor", "replacement" }] }`. `anchor` is exact text that
occurs once in `file`; `"runnable": false` at the top level says the suite cannot run here.

The testing reviewer's contract is `mutant_candidates` for **every changed branch**, including
code downstream of the diff that the diff makes reachable differently. The main session writes
that list to `mutants.json` unchanged. It may not narrow, drop or merge candidates to fit a
budget: a smaller pass is a cap (below), stated, never a smaller list.

Run `keryx review mutate --test "<the nearest suite command>" --package <review-dir>`. It
applies each mutant in a scratch copy of the worktree (never in the worktree), refuses to
start when the baseline is red, and writes the table to `research-evidence/mutation-<n>.md`
and `.json`. A mutant is `killed` (the suite went red), `survived` (nothing pins that
behaviour), `timeout`, or `invalid` (anchor missing or not unique, file outside the copy).
A survivor is evidence for the finding that names it.

When `--test` is a plain `[env] [NAME=value] bun test <paths>` command, each mutant runs with
`--bail` inserted right after `bun test`: the first red test ends that run, so a killed mutant
costs the time to its first failure, not the whole suite. The baseline always runs in full, and
a green run is the same with or without the flag, so a survivor stays a survivor. One verdict can move: a mutant that fails an early test and would hang in a later one is `killed` with bail and `timeout` without it. Any other command shape
(`sh script`, quotes, pipes, `bunx`) runs as given. `--no-bail` turns this off. The `.json` record
then carries `bail: true` when it was applied, and, for the next measurement, `startedAt`, `head`
and `treeHash` (the commit and a hash of the uncommitted state judged; absent outside git),
`loadavg` (at the end of the pass), `copyMs` and `mutantsMs`. Records written before these fields
exist stay valid.

`keryx review complete` refuses while proposed mutants are unrun on an attended round, unless the
operator waived the pass themselves: the `review_waive_mutation` card in keryx shell, or their answer to
the host question recorded with `keryx review waive-mutation --package <review-dir> --reason "<why>"
--answered-by … --answer-text … --question-text …` (it writes `operator-decisions.json`; a `dispatch.mutationWaiver` quote you write is not enough on a package
`keryx review start` created). Attended is what the start recorded in `run-profile.json`: every round
except `review start --unattended` and `keryx review run --autonomous`, which record `Not run: mutation
pass` without asking.

These operator gates (cards, terminal commands, host questions, plan confirmation, decision records) keep a
cooperating agent from cutting corners and make every decision visible and attributable; they do not
stop a hostile same-user agent, which can fake a pty, invent a host-question answer or write the JSON
records itself (the TM-03/TM-04 boundary). The autonomous runner's mutation-gate exemption predates flow 457 and is kept on purpose.

`keryx review mutate --cap <n>` runs the first `n` candidates and records `cap` and `not_reached`
in `mutation-<n>.json`. The table then prints `Not run: N candidates` (and the report must carry
that line, see `keryx review report-parity`). A candidate the cap left out is still pending, so it
keeps blocking the coverage gate until a later pass runs it; a cap moves work to the next pass, it
never closes it.

### Severity audit — `keryx review severity-audit`

A reviewer that argues a finding from a mutant writes `mutant:<id>` in the finding's `evidence`.
After the mutation pass run `keryx review severity-audit --package <review-dir>`: a cited mutant
that survived on a file the review changed moves a minor finding up to major only when no mutant
in that file was `killed` (or `timeout`) in any recorded pass, because then nothing in the suite
exercises the changed behaviour. It records `severity_audit {from, to, evidence: "mutation-<n>.json#<id>"}`.
When the file has a killed mutant, the suite covers the code, the survivor is a gap in covered
code, and the severity is held (see below). A survivor shows a missing assertion, not wrong
behaviour. A finding that cites a mutant no
run executed stays minor (a major is capped at minor) and gets the label `unproven`. The audit
never deletes a finding and never touches a blocker; it is a separate pass from the verifier,
which can only delete. `--dry-run` prints the changes without writing `findings.json`.

Each mutant in `mutants.json` carries a `kind`: `behavior` (the default, and what a record written
before the field reads as) or `presentation` (it changes only what a reader sees: a label, a
column, copy, spacing). A behavior survivor in a file with no killed mutant raises as above. When
the only survivors a finding cites are `presentation`, or every behavior survivor sits in a file
with a killed mutant, the severity stays, and the finding gets
`severity_audit {held: {severity, mutant, kind: "presentation" | "covered", evidence, reason}}` instead of
`{from, to}`. A held note is not a raise and not a deletion; it is the record that a survivor was
seen and did not move the severity, so the report must say so.

`keryx review report-parity <review-dir>` prints what the round left behind as Markdown to paste
into `report.md`: the `Not run: N candidates` line, each held note, and each follow-up still open
as `Not verified: <text>`. The same lines show in `keryx review status`, in the shell
`/review parity` view and in the sidebar. `keryx review complete` warns, and does not refuse, when
any of them exists and the report names none.

### Layout measurements on a shell host

A shell reviewer cannot start a browser. Before dispatching `review-layout` the main session runs
the browser measurements itself (Playwright, or Storybook with its test runner) for the changed
components and passes the output files as `context_files` in the **first** dispatch. A measurement
counts as evidence for `review-layout` when it names the command and the viewport it ran at; one
without them is context, not evidence.

`src/review/retry-plan.ts` treats `NEEDS_CONTEXT` as one refill: the first one re-dispatches the
role with what it asked for. A second `NEEDS_CONTEXT` from the same role that covered no new slice and
asks nothing new is `notRun`; the reason is `layout: no engine` for `review-layout` and `no engine` for any other
role when its questions ask for a browser or engine and name no route without one, else `no progress after one
context refill`, and the round goes on. A second one that covered a new slice or asked a new question still gets its refill.

### Pull request context — `keryx review context-collect`

A pull-request review starts with `keryx review context-collect --repo <o/r> --pr <n> --package <review-dir>`.
It writes `pr-context.json` and `pr-context.md` into the package: every review comment in full (the
800-character cut applies only to a finding's `problem`), the round-1 intent (kept when a later round
collects a new head), the CI status (`--checks <file>` or `gh pr checks`; `unknown` when neither is
available) and the backend pins the pull request names (refs on lines that talk about the backend).
Set `pr_context` in every reviewer payload to the `.md` path; reviewers read it before the diff.
`keryx review dispatch-check --payload <file> --pr-context` refuses a payload without it
(`REVIEWER_INPUT_NO_PR_CONTEXT`).

## Preflight 4 — PR state, depth and estimate before dispatch

Two 2026-10-15 rounds took 2 h and 3.5 h. One verdict was ready at minute 55, was held to
minute 119, and the PR merged first; the other re-dispatched a finished wave and ended at 27 of
41 slices. The operator can only act on a risk they were told about.

1. On a PR target read merged / approved / CI (`gh pr view <n> --json state,reviewDecision,statusCheckRollup`). Say in one line what the state means for the round: an approved PR with green CI can merge any minute, and a merged PR makes the rest of the round a post-merge audit.
2. **Later, once the package and slices exist** (after `review scope`, `review start` and `review slice --package`, before the first reviewer starts): `keryx review required --mode all --scope .metaproject/data/review/scope.json --depth auto --package <review-dir>` prints the reviewer set and the depth it chose (see "Depth floor"); auto needs the file list and a line count, else the round is full. `keryx review estimate --package <review-dir> [--manifest <slices/manifest.json>]` prints assignments, waves and a duration range; the manifest defaults to `<package>/slices/manifest.json`, then `.metaproject/data/review/slices/manifest.json`.
3. Show the operator depth + estimate and the merge risk before the first dispatch. Attended: let them choose `full` over a light default. Unattended: record both in the report and continue.
4. **An over-threshold plan waits for the operator.** `estimate` flags a plan over `reviewPlan.maxDispatches` (default 40) or `reviewPlan.maxMinutes` (default 90) in `routing.config.json`; `dispatch-check --package` and `ledger build` refuse it (`REVIEWER_INPUT_PLAN_UNCONFIRMED`) until `<review-dir>/plan-confirmation.json` exists. Only the operator writes it: the `review_confirm_plan` card in keryx shell, or the operator's answer to the host question recorded with `keryx review confirm-plan --package <review-dir> --answered-by <source>:<ref> --answer-text "<their words>" --question-text "<the question>"` (`confirmedVia: "host-question"`), or `keryx review confirm-plan` / `keryx review estimate --package <review-dir> --confirm --quote "<their words>"` in their terminal (the terminal forms refuse without a TTY). Unattended, the plan is not dispatched: report the estimate and stop.

## Early verdict — the verdict is interim until `complete`

As soon as every reviewer result and the verifier's are on disk, save each verifier pass to `research-evidence/verifications.json` first (without it a refuted finding still counts), then run `keryx review verdict <id|path> [--json]`: it reads `<package>/raw`, where every host keeps the round's results (`--raw <dir>` only for results kept elsewhere; the shared `.metaproject/data/review/raw` mixes in other rounds' replies). It prints the interim verdict and writes `verdict-interim.md` into the package. Give the operator that verdict in the same message; do not hold it for the mutation pass, the ledger or `complete`.

The tail keeps running after it: the mutation pass (`keryx review mutate`), `ledger build`, `ingest`, `readiness` and the `review_complete` card (`keryx review complete` for a human at a terminal). Every managed round finishes them. The round is **not done** until `complete`: the verdict you gave is interim, and the report says so and names what the tail may still change (a surviving mutant, a verifier refutation, a late reviewer result). A light round has no mutation pass: its tail is `ledger build`, `ingest`, `readiness`, `complete`.

## Early verifier — start on the first blocker or major

Do not wait for the last reviewer. When the first `blocker` or `major` finding arrives, dispatch `review-verifier` over the findings you hold, while the other reviewers keep running. Each later blocker or major starts another verifier pass over just the new findings (each pass is its own run; Wave C overlaps A and B here, and Step 9b's `verify_order` orders the later passes), so verification finishes within minutes of the last reviewer. The verifier stays delete-only and never verifies a finding its own reviewer raised; the merge still comes from `keryx review ingest --verifications <file>`, once per pass.

## Recovery — collect, validate, ingest, dispatch only what is missing

After a timeout, a crash or a resumed session, in this order:

1. **Collect.** `keryx review retry-plan --manifest <package>/slices/manifest.json --package <package> --reviewer <id> --next-wave` reads `<package>/raw/` first and collects late reviewer results; it prints `collected late: N` and never re-hands a slice that is finished.
2. **Validate** each collected reply (a `STATUS:` line and a `REVIEW_RESULT` block matching `reviewer-finding.schema.json`), **ingest** it, and rebuild `research.json` with `ledger build`; run `ingest --research` once it prints READY.
3. **Dispatch only what is missing:** the wave `retry-plan` prints. A wave whose results are on disk is never dispatched again.
4. **A second timeout of the same reviewer changes the task, not only the diff size:** fewer slices per dispatch, a narrower focus (one concern or one directory), or a lighter model tier for a mechanical slice. Two results in a row with nothing new are `Not run`, as `retry-plan` prints.

## dispatch-check on every payload

Before any mass dispatch run `keryx review dispatch-check --payload <file> --manifest <dir>/manifest.json` on every payload, on every host. It fails `REVIEWER_INPUT_PATH_MISSING` when a `skill_path` or `context_doc` names a file that is not there, and still fails a payload that names no slice, exceeds the wave ceiling or breaks `reviewer-input.schema.json`. Fix the payload; a dead path costs a whole wave of refusals. Related: `review mutate` runs in a scratch copy under the repo and prints the baseline's tail when the baseline is red; `review start --graph-timeout <s>` bounds the graph build.

## Review Plan Preview — legacy groups

```text
Optional legacy/profile reviewers:
  - code-ai-review: available via --code-ai or --legacy-profiles
  - code-learned-review: available via --learned or --legacy-profiles
  - code-style-review: available via --code-style or --legacy-profiles
  - code-mobx-store-review: auto-suggest when *.store.ts or MobX patterns are present; available via --mobx-store or --legacy-profiles

Skipped reviewers:
  - code-ai-review: profile reviewer, not selected unless --code-ai/--legacy-profiles
  - code-learned-review: profile reviewer, not selected unless --learned/--legacy-profiles
  - code-style-review: legacy style profile, not selected unless --code-style/--legacy-profiles
  - code-mobx-store-review: not selected unless --mobx-store/--legacy-profiles or MobX store files are detected
```

## Token and context budget

The orchestrator owns the token budget. Sub-reviewers receive only the context their domain needs.

Budget rules:
- Compute a scope digest before dispatch: file list, diff stats, module map, and top risks.
- Send full diffs only for files relevant to each reviewer.
- For large files, send changed hunks plus nearby symbols first; include the full file only when path mode or the reviewer requires whole-file context.
- Never send generated files, lockfiles, snapshots, build output, or vendored code unless the reviewer is specifically about that file type.
- Cap each reviewer prompt with the `per_reviewer` budget when provided; otherwise use the smallest prompt that preserves evidence.
- Record omitted files and truncation in `review_context.token_policy.omissions`.
- If a reviewer returns `NEEDS_CONTEXT`, provide only the missing targeted context, not the entire repository.

Default budget guidance:

| Review size | Detection | Context mode | Dispatch style |
|---|---|---|---|
| small | <= 5 files and <= 300 changed lines | `light` | full relevant diff to selected reviewers |
| medium | <= 20 files or <= 2,000 changed lines | `light` | per-domain filtered diff |
| large | > 20 files or > 2,000 changed lines | ask `full` | staged waves by domain |
| high-risk | auth/API/core/security/data migrations | ask `full` | staged waves, verifier included |

## Everything written to GitHub is brief

One rule, applied to every outward surface: **PR bodies, PR comments, review
replies, issue comments, and commit messages going to a PR.**

- Lead with the conclusion. No preamble, no restating the question, no apology,
  no summary of the flow.
- Say what changed and where. **Link, do not paste.**
- The reasoning, the evidence, the rejected alternatives and the round history live
  in the flow package — `journal.md`, `context.md`, the review artifacts — which is
  durable, searchable, and costs a reader nothing to skip.
- A GitHub artifact that needs more than a short paragraph is a signal that the
  detail belongs in the flow with a link out, **not** that the paragraph should
  grow.
- No orchestrator-written PR comment or reply exceeds two sentences without
  carrying a link to the artifact holding the detail. The reply pass enforces
  this; for anything else you write outward, hold yourself to it.

This is deliberately asymmetric: **verbose in the flow, terse on GitHub.** The
flow is written for whoever resumes the work; GitHub is read by someone who did
not ask for our reasoning and is reading between other tasks.
