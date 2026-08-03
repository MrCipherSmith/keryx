# Review pipeline: give reviewers the metaproject context and a memory of prior rounds

Status: formalized
Source: operator request after four review rounds on PR #216 (flow 128), each of
which found a defect inside the fix the previous round produced.

## Problem

Across flows 127 and 128 the review pipeline ran **seven** rounds on PR #215 and
**four** on PR #216. Rounds 1 and 2 of each *each shipped a new defect inside
the fix they were named for*. The recorded lesson
(`.metaproject/memory/lessons/a-fix-round-needs-its-own-review-…`) names the
root cause correctly — "the fix was applied where the finding pointed, not
everywhere the class lived" — and it did not stop the recurrence, because
nothing in the review pipeline reads it.

An inspection of the pipeline itself, rather than of its findings, located five
structural causes. Each was verified against the configuration, not inferred:

| # | Cause | Evidence |
|---|---|---|
| C1 | A reviewer is never told what the previous round found | `review-orchestrator/reviewer-input.schema.json` has `diff`, `base_sha`, `target_path`, `file_contents`, `context_doc`, `issue_url`, `rules` — and no field for prior findings. |
| C2 | Project memory is not in the review pipeline at all | Zero references to `.metaproject/memory` in the 831-line orchestrator or in any of the 15 reviewer skills. The four `memory` matches are memory-leak checklist items. |
| C3 | The managed review loop is implemented and unused | `keryx review attach\|start\|ingest\|status\|complete` exists and the orchestrator documents it at SKILL.md:97-101. `.metaproject/data/reviews/` does not exist. Eleven rounds produced no machine-readable finding. |
| C4 | A fix round is scoped to the fix commit | `.metaproject/data/RESUME.md` instructed round 4 to review "the newest commit alone". A fix that changes a guard, an instruction or a refusal invalidates every *other* site that names it, and those sites are outside the fix commit. |
| C5 | A finding anchors to one `file:line` and nothing asks for the class | Every reviewer skill's finding format carries a single anchor. The Iron Law about not flagging a pattern twice governs deduplication, not enumeration. |

The loop these produce: the reviewer sees only the fix → reports one site → the
fixer repairs that site → the next reviewer sees only the new fix → finds the
sibling that was broken all along. It reads as "reviewers keep finding problems
in fixes". It is actually "each round can only see one site at a time".

## Expected Outcome

Reviewers reach the metaproject as ordinary shared project context — memory,
wiki, graph and prior findings — and a finding states its class rather than one
site.

- `reviewer-input.schema.json` carries `prior_findings` and `metaproject`, and
  the orchestrator is required to populate both.
- The Context Pack step performs a memory search scoped to the changed paths and
  inlines matching **accepted** lessons and constraints into the reviewer input.
- Every round is recorded through `keryx review start` / `ingest`, so round N+1
  has something to diff against and `keryx memory ingest --from-review` becomes
  possible.
- A fix round reviews `merge-base..HEAD`, plus the set of files that *name*
  whatever the fix changed — never the fix commit alone.
- A finding carries `class_scope`: every site of the shape, and how the set was
  enumerated. A finding without it is a per-site claim.

## Decisions

### D1 — the metaproject is context, not a new reviewer capability

Reviewers do not gain graph/wiki/memory *tools*. The orchestrator already owns
the Context Pack; it gains the duty to put metaproject context *into* it. This
keeps the token budget in one place, keeps reviewers stateless, and means a
reviewer dispatched by any runtime gets the same context.

### D2 — memory is filtered by status, not pasted wholesale

Only `accepted` memory enters a reviewer prompt, and only entries whose recorded
scope intersects the changed files or modules. A draft lesson is a hypothesis;
putting it in front of a reviewer as project truth is how a wrong hypothesis
becomes a wrong finding. The flow-128 lesson is currently `draft` — promoting
it is part of this flow, with the evidence now available.

### D3 — `class_scope` is required for a `blocker` or `major`, optional below

Enumerating the class costs a grep. Requiring it on every `info` would produce
theatre. Requiring it where it matters is what would have caught the config
directory (one writer of five), the operator instructions (one of four), and the
unbounded readers (six of eight).

### D4 — the guard on this flow is itself class-shaped

This flow's own subject is "a per-site fix does not hold". Its acceptance
criteria must therefore not be satisfiable by editing one reviewer skill. A
source-level test enumerates every skill under
`.metaproject/skills/gdskills/review/` and asserts each one carries the required
contract sections — so adding a sixteenth reviewer without them fails.

### D5 — no change to what reviewers look for

This flow changes the *input* to reviewers and the *shape of a finding*. It does
not add, remove or reword a single review checklist item. Mixing the two would
make it impossible to tell which change moved the outcome.

## Out of Scope — with reasons

- **The nine findings from round 4 on PR #216** (unbounded session-store reads,
  the FIFO hang, the `<addr>` placeholder, three inaccurate comments). They are
  the *next* flow. Fixing the pipeline and fixing what the pipeline found in one
  branch would make it impossible to attribute either result.
- **`flow-reviewer`** (`docs/requirements/flow-reviewer/`, specification ready).
  It is the Task Manager-aware orchestrator that owns per-reviewer tasks and
  durable history, and it supersedes part of what this flow patches. This flow
  is deliberately the small version: make the existing stateless orchestrator
  carry context and record findings. It must not grow into implementing that
  package.
- **New reviewer skills, model routing, or budget policy.** Untouched.
- **Automatic promotion of memory from a review.** `keryx memory ingest
  --from-review` is wired as an available step and documented; deciding that a
  finding becomes an accepted lesson stays an operator action.
