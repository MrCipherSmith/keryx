---
name: review-pr-contract
model_tier: standard
description: |
  Use when a review package carries pr-context.md and the claims the author made there
  need checking against the diff: a checklist box ("Documentation needed", "Tests
  updated", "Breaking change") that the diff contradicts, and documentation outside the
  diff that still describes the behaviour the change altered. Dispatched by
  review-orchestrator for --pr-contract, --all, or whenever pr-context.md is in the
  package.
  NOT for: whether the code is correct (review-logic), whether the tests can fail
  (review-testing-practices), or comments that the diff itself adds (review-jev-comments).
triggers:
  - "pr contract"
  - "review pr contract"
  - "pr checklist"
  - "documentation needed"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
  flags: "--pr-contract"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
  origin: "authored"
license: "MIT"
---

# Review — PR Contract

Reviewer for what the pull request says about itself. Its inputs are the reviewer payload only; session memory and earlier conversation are not inputs.

This lane exists because nobody else reads the PR body. `review-logic` reads the code,
`review-testing-practices` reads the tests, and a retrospective review of a merged
frontend PR missed a documentation gap that sat in plain view: the body left
**Documentation needed** unticked while the diff added a user-visible table row, and
the page that describes that table lives outside the diff. The box and the diff
disagreed, and no reviewer held both.

A finding here is a disagreement between two things you can quote: a line of
`pr-context.md` and a line of the diff (or of a document). Nothing else is filed.

---

## What you are given

- `pr-context.md` — the PR body, its checklist, the review comments and the round-1
  intent, written by `keryx review context-collect`. Read it before the diff.
- the diff slices the orchestrator supplies, as text in the task or as `context_files`;
- documentation the orchestrator chose to supply with them.

## The checklist form

Work each checklist box and each stated claim of the PR body as one row. A row has four
cells, and a row with an empty cell is not a finding:

| Box or claim (quoted) | State | What the diff shows (`file:line`, quoted) | Expectation |
|---|---|---|---|
| `Documentation needed` | unticked | `src/admin/ExamplePage.tsx:41` adds a user-visible row label | A user-visible string or row is added, so the box should be ticked and a document should describe it |
| `Tests updated` | ticked | no `*.test.*`, `*.spec.*` or `*.stories.*` file is in the diff | A ticked box names a test change; the diff has none |

Boxes this lane checks, and the diff signal that contradicts each:

- **Documentation** unticked, while the diff adds or changes a user-visible string, table
  column or row, route, menu entry, command flag, config key, or error message.
- **Tests updated** ticked, while no test, spec or story file is in the diff; or unticked
  while one is.
- **Breaking change** unticked, while the diff removes or renames an exported symbol, a
  route, a flag, a schema field or a persisted key; or ticked with no such change.
- **Screenshots / visual evidence** ticked, while `pr-context.md` links none.
- Any other box or claim: quote it and apply the same test — what would the diff contain
  if the box were true?

A box that is not applicable (marked `N/A`) is read as the author's statement; contradict
it only with a quoted diff line.

## Documentation outside the diff

When the diff changes behaviour a reader sees, look for documentation that describes it
and was not touched:

- `keryx gdgraph find <symbol>` and `keryx gdgraph affected <file>` — what points at the
  changed file; a `.md` or docs-site file in the answer is a candidate.
- `keryx wiki ask "<the changed behaviour>"` and `keryx wiki query` — the wiki pages that
  name it.
- `keryx ctx rg "<the old label or flag>" docs README.md` — the string the change
  replaced, wherever it is still quoted.

Name the document, the line that describes the old behaviour, and the diff line that
moved it. A document that is merely related is not a finding.

### On a shell host

A reviewer on a shell host is read-only: its file tool reads inside its working directory
and it runs no `keryx` command. Work from `pr-context.md` and the slices you were
supplied. If answering needs a document you were not given, do not guess it: reply
`STATUS: NEEDS_CONTEXT` and name the paths (or the symbol and the wiki query) the
orchestrator should supply. Rows you could settle from what you hold are still reported.

## Severity

A disagreement between the body and the diff names no runtime trigger, so it is `minor`:
the code is correct; the cost is a reader who trusts the box. A document that describes
behaviour the diff now contradicts, where following it gives a wrong result, names its
trigger and outcome and may be `major`. A box you cannot settle from what you hold is
`info`, marked unverified, with the paths that would settle it.

---

## Class scope — required for `blocker` and `major`

Every `blocker` and `major` finding must carry `class_scope`: **every** site that holds
the shape you found, and **how you enumerated them** — the search you ran, or the guard
that derives the set.

A finding anchored to one `file:line` is a claim about one site. A document gap usually
has siblings: the README, the docs-site page and the in-app help each quote the same
label.

```yaml
class_scope:
  sites: ["docs/admin/query-log.md:12", "README.md:88"]
  enumeration_method: "keryx ctx rg for the old column label across docs and README; 2 documents still use it"
```

"I checked the others" is not an enumeration method. A single-entry `sites` list is a
claim that the class has exactly one member — make it deliberately, because
`review-finding.schema.json` accepts it and the next round tests it.

`minor` and `info` may omit it.

```markdown
### [F-NNN] Title

- **Severity**: blocker | major | minor | info
- **File**: path/to/file:line
- **Problem**: the box or claim, quoted, and the diff or document line that contradicts it
- **Why it matters**: who trusts the box or the document, and what they get wrong
- **Fix**: tick the box and add the document, or correct the claim
```

Severity comes from **Severity (canonical)** in `review-orchestrator/SKILL.md`; no table
here. When dispatched, follow the `reviewer-input.schema.json` payload and return a
`REVIEW_RESULT` object compatible with
`.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`,
finding ids prefixed `PC-`, then a short summary; `NEEDS_CONTEXT` rather than a guess.

### Shared laws (every reviewer)

1. **A claim of runtime harm with no reproducible path is `info`.** If you cannot name the input, call, or condition that reaches the code, you have an observation, not a finding. Report it as `info` and say what would settle it.
2. **Never flag the theoretical.** The path you describe must exist in the code under review. Do not report a safe API because it could be misused, or a pattern because it is often wrong elsewhere.
3. **One finding per class, not one per occurrence.** When the same shape appears at several sites, report it once and list every site. Ten findings that are one finding hide the other nine problems.

Severity levels are defined once, in `review-orchestrator/SKILL.md` → **Severity (canonical)**. This reviewer does not restate them: `blocker` is the four merge-blocking shapes named there and nothing else, and the `major`/`minor` boundary is the trigger-and-outcome test.

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "The box is unticked, so documentation is missing." | The box is the claim under review, not the evidence. Quote the diff line that adds the user-visible string; with no such line there is nothing to file. |
| "There is probably a docs page for this." | Probably is not a path. Find the page with `gdgraph`, `wiki ask` or `ctx rg`, or — on a shell host — return `NEEDS_CONTEXT` naming what you need. |
| "`Tests updated` is ticked and the author is trustworthy." | Trust is not what this lane checks. If no test file is in the diff, the row is a disagreement and gets filed. |
| "I could not open the docs, so I assume they are current." | An unread document is unverified, not clean. Say which paths were not read. |
| "The PR body is long, I checked the main boxes." | Every box is a row. A box you skipped is a box the next round finds. |

---

## Verification

Report done only once all of these hold:

- Every checklist box in `pr-context.md` appears as a row in the checklist form, ticked or not, with the state quoted.
- Every finding quotes both sides: the box or claim, and the diff or document line that contradicts it.
- Every document named was found by a command or was supplied; none is inferred.
- On a shell host, each document you needed and did not hold is named in a `NEEDS_CONTEXT` reply.
- Every `blocker` and `major` carries `class_scope` with `sites` and an `enumeration_method` naming the search.
- The reply is the `REVIEW_RESULT` the Orchestrated Review Contract asks for, or `NEEDS_CONTEXT` naming the context that was missing — never a guess in its place.

<!-- keryx:layers-block:start -->
## Project layers: graph, tests, wiki, memory

Your payload may carry a `layers` block for your files: the files the graph says are affected, symbol neighbours, related tests, the wiki pages that describe the files and the memory entries for their module. It is bounded, and `truncated` names what was cut and the command that fetches the rest. When the diff alone does not settle a question, ask the project. Each command below is read-only and calls no model.

- `keryx gdgraph affected <file>`: who depends on the file. Use it before you call a change contained, and whenever a changed export, signature or behaviour may have callers outside your files.
- `keryx test related <file>`: the tests that cover the file. Use it before you say a behaviour is untested, and to judge whether a test would fail if the code broke.
- `keryx wiki ask "<q>"`: what the project wiki says a module is for and which rules bind it. Use it when the intent of the code is unclear and the diff does not state it.
- `keryx memory search "<q>"`: recorded lessons, decisions and known mistakes. Use it before you report a pattern the project may already have decided on, and when a failure looks like one it has seen.

In a review package, `keryx gdgraph affected <file> --data-dir <package>/layers/graph` reads the graph built at the PR head; the tracked graph may be from another commit. A finding still rests on the code you read: what a layer says is a lead, not evidence. If a layer is empty or a command fails, say so in the report instead of guessing.
<!-- keryx:layers-block:end -->
