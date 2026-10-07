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
vantage-review …") is its author's routing note, not a restriction: this
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
  below. `--legacy-profiles` and `--all` dispatch the legacy reviewers that are
  installed and record the others the same way. Leave an absent reviewer out of
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
(Step 9) and BEFORE Wave C verification (Step 10) — Step 9b in the Workflow
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
| `verify_order` | `{id, p}`, sorted lowest-`p`-first | Feed this order into Wave C's own dispatch — verify the lowest-plausibility findings first — never as a reason to skip verifying any of them. |

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

## Default budget guidance

Linked from SKILL.md § "Token and Context Budget Management".

| Review size | Detection | Context mode | Dispatch style |
|---|---|---|---|
| small | <= 5 files and <= 300 changed lines | `light` | full relevant diff to selected reviewers |
| medium | <= 20 files or <= 2,000 changed lines | `light` | per-domain filtered diff |
| large | > 20 files or > 2,000 changed lines | ask `full` | staged waves by domain |
| high-risk | auth/API/core/security/data migrations | ask `full` | staged waves, verifier included |

## Scope before severity

Linked from SKILL.md § "Severity (canonical)" → `### Scope before severity`, and
from the Review Context Pack's owner-intent input. The ownership rules it applies
— who decides scope, what counts as settled — live in
`.metaproject/rules/core/owner-intent.mdc`.

**The question.** Before any finding is graded: should this change exist in this
PR? A fix PR that carries a new shared mechanism or an architecture change — a
new store, framework or audit tool, wiring every caller must adopt — answers no.
It is reported first as `Mis-scoped: split`, naming what stays in this PR and
what moves out to its own owner-agreed PR (owner-intent rule 4).

**Why it is not a severity.** The ladder grades how wrong the code is. A
mechanism that should not be in the PR can be correct at every site, so the
ladder files it as `minor` or `info` ("architecture opinion"), and a round that
fixes every `minor` then hardens the mechanism instead of questioning it. That
is how a fix PR grows round over round while every reviewer's findings are
"addressed".

**What escalates.** "Who owns this", "this belongs elsewhere", "a second
mechanism next to the existing one", "this should be its own PR". Reviewers
that see one report it under this verdict, never as `minor`.

**What happens to it.** It is never auto-fixed: the round stops and asks the
operator, and a fix loop does not dispatch a task for it. Only the part that
stays is reviewed further.

**Record.** `location_class: pr-process`, title starting `Mis-scoped: split`,
machine verdict `REQUEST_CHANGES`; the visible first line is in
`templates/review-report.md`. The schema's `severity` field holds `info` only
because it is required — it is not counted, sorted or capped. This is a prose
contract; no CLI enforces it yet.

**Owner intent in the brief.** The context pack's `requirements.owner_intent`
carries the owning spec's open questions and the code owner's and reviewers'
latest comments on the PR and its linked issue. The author's issue, PR body and
same-PR doc edits are the author's position, not a settled one (owner-intent
rule 5). Every architecture, core-boundary and design reviewer is asked the
scope question first. A brief never sets "other reviewers must find nothing" as
its goal: that goal turns every round into hardening the current approach.
