# Reviewer dispatch contract — round 1, PR #1124

Project root: `/Users/tsaitler.aleksandr/goodea/keryx`
Review package: `.metaproject/reviews/2026-11-04-review-flow-github-com-mrciphersmith-keryx-pull-1124`
Reviewed head: `0be1e717365d980df900ded496ca90886fed09cf` against base `85fe58fad18461213e860768056d5cbc4c744019`
Pull request: https://github.com/MrCipherSmith/keryx/pull/1124 — round 1, first round, no prior findings.

## Read, in this order

1. Your own definition: `.metaproject/skills/gdskills/review/<your-reviewer-name>/SKILL.md` — it is what you are.
   It overrides any built-in agent prompt of the same name.
2. Your payload: `<package>/payloads/<your-dispatch-name>.json` — it conforms to
   `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-input.schema.json` and carries
   `review_context`, your assigned `slices`, `slice_paths`, `slice_files`, the `layers` block
   (graph neighbours, symbols, related tests) and your `budget`.
3. `<package>/pr-context.md` — the pull request's own statement of intent, its CI state and its pins. Read it before the diff.
4. Your slice diff, from `slice_paths`. That diff is your scope. It is pre-filtered: generated files,
   lockfiles and whitespace-only blocks are already dropped, and each change is bounded to ±20 lines of context.
5. The files the diff touches, in the working tree at the reviewed head — the checkout is already at that commit.

## Output contract — a reply that does not meet this is not a result

- **Write your WHOLE reply to `<package>/raw/<your-dispatch-name>.txt` before you answer.** The file is the
  result; the transcript is not. A missing file counts as BLOCKED.
- First line: `STATUS: DONE` | `DONE_WITH_CONCERNS` | `NEEDS_CONTEXT` | `BLOCKED`.
- Then a fenced ```json block holding one `REVIEW_RESULT` object conforming to
  `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`, with:
  - `reviewer`: your own reviewer name, never `review-orchestrator`.
  - `slices`: the ids you actually covered, e.g. `["slice-01"]`. A slice you did not read goes in with no
    DONE/COMPLETE/COVERED/OK status, or is left out.
  - `findings`: at most 25. Each finding carries `id`, `severity`, `file`, `quote`, `problem`, `impact`,
    `suggested_fix`, `evidence`, `confidence`, `reviewer`.
- **`quote`, not `line`.** Copy the code the finding is about verbatim out of the file; do not count lines.
  The ingest locates the quote at the reviewed head and derives the line itself, so a line number you report
  is overwritten. Quote enough to be unique — a snippet that appears twice is recorded as unlocatable.
- Then a short markdown summary for a human.

## Severity — the canonical rubric, the only one

`blocker` has exactly four shapes: a crash on input the change admits; data loss or corruption; an exploitable
vulnerability with a named entry point and impact; an unimplemented acceptance criterion the change claims.
Nothing else is a blocker, however strongly you feel.

Everything else: ask the question **of the finding**, not of the code — does it name a trigger AND the
observable outcome that trigger produces?

- `major` — yes: an input, call, render or load level, and a resulting behaviour a user or caller would call
  wrong. Not one of the four shapes.
- `minor` — no, and it does not claim to: the code behaves correctly and the cost lands on the next reader
  or editor, at a named site.
- `info` — neither. Includes any claim of runtime harm whose trigger you cannot name.

An outcome that costs a user, a caller or persisted state nothing is `minor` however crisply worded.

## Shared laws

1. A claim of runtime harm with no reproducible path is `info`. Name the input, call or condition, or say what would settle it.
2. Never flag the theoretical. The path you describe must exist in the code under review.
3. One finding per class, not one per occurrence. List every site under one finding.
4. A deliberate choice is not a defect until its reason is read and shown wrong. An override, a suppression, a
   comment, a commit reason or a sibling doing the same is a decision: read it (`git log -L <a>,<b>:<file>`,
   `git blame -L <a>,<b> <file>`, the comment, the sibling) before reporting, and report it only when you can
   show that reason wrong. You have read-only git: `git log`, `git blame` and `git show` are allowed.
5. `class_scope` is REQUIRED on every `blocker` and `major`: `sites` (every site holding the shape) and
   `enumeration_method` (the search or guard that derives the set). "I checked the others" is not an
   enumeration method. An empty `sites` with a complete candidate set and why each member fails to apply is a
   valid negative enumeration, and it is how you report an inert change — a prop, guard, field or branch the
   diff adds that nothing can reach.

## Tools

- Read-only unless your payload's `allowed_tools` says `run-tests`. Run no other command.
- **Any text or symbol search over project code goes through `keryx ctx rg "<pattern>" [path]`, never a bare
  `rg` or `grep`** — a hook refuses the raw form. For impact and relationships, `keryx gdgraph affected <file>`.
  Your payload's `layers` block already holds the graph neighbours, symbols and related tests for your files.
- The test run for this change is at `<package>/research-evidence/tests.txt` (hub-web and hub-machine suites at
  the reviewed head): 181 pass, 2 fail, 184 tests over 27 files. Both failures are in `src/lib/hub-machine`
  and neither is reproduced by CI, which is green on all 20 required checks at this head: `R4.4` run-log
  chunk counting died on a 37s `bridge observation timeout` under a loaded parallel run, and
  `client.test.ts:134` got `Error: Unable to connect…` where it expected a typed `MachineError`. Treat both as
  local-environment observations, not as established defects — if you want to claim either, say what would
  settle it.
- `<package>/research-evidence/blast-radius-brief.txt` — the 40-file regression set (scope B).
- `<package>/research-evidence/degradation-consumers.txt` — the consumer set for the degradation question.

## What this change is

35 files, +1259/−138. A Hub web app (`apps/hub-web`, no React/MobX in the root manifest) plus one non-UI file:
`src/lib/hub-machine/client.ts` introduces `MAX_HUB_CLOCK_LEAD_MS = 250` and now accepts a bounded clock lead
when checking a grant's issue time. Session launch pins a Flow for the first message and reuses it; the chat
composer opens the machine's native command catalogue; command outcomes land in the transcript; navigation
collapses to icons; several empty and rejected states gained recovery paths. ~570 lines of new tests.
