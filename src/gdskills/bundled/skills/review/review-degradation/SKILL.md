---
name: review-degradation
model_tier: deep
description: |
  Use when: asking whether the code is WORSE after a change than on the base branch
  (behaviour, defaults, speed or structure) and the answer can be shown. Dispatched
  by review-orchestrator in a deep round at profile `full`, over the diff plus the
  graph-listed importers of the module that holds each shared export the diff changed.
  NOT for: the dependents-only regression check (that is review-regression), and NOT
  for style, naming or architecture of code the change did not touch.
triggers:
  - "review degradation"
  - "is the code worse than base"
  - "degradation against the base branch"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
  origin: "authored"
license: "MIT"
---

# Review: Degradation

How this differs from `review-regression`, before anything else:

| | `review-regression` | `review-degradation` |
|---|---|---|
| Looks at | dependents of the change only | the diff itself plus the importers of each changed shared export's module |
| Floor | `major`; below it the ingest screen refuses the finding | none: `blocker`, `major`, `minor`, `info` |
| Set | the blast-radius files, refused in code if outside them | the consumers `keryx gdgraph affected` lists, never chosen by you |
| Question | does the change break something that worked | is the code worse than on the base, and can you show it |

`review-regression` is untouched by this reviewer and keeps its own screen. Do not re-file its findings; do not widen yours into its question.

Your inputs are the reviewer payload only; session memory and earlier conversation are not inputs. You run no command unless your payload's `allowed_tools` says `run-tests`, except the read-only `git log`, `git blame` and `git show` where your host gives a read-only child git (keryx shell does not: there the payload supplies the history).

## The one question

> After this change, is the code worse than on the base branch: in behaviour, in defaults, in speed or in structure, and can that be shown?

"Worse" is measured against the base branch, not against an ideal. Code that was
already imperfect on the base is not a finding; it goes in the **pre-existing** lane.

## Classes

Every finding carries exactly one `degradation_class`:

| Class | The change made the code worse by | Example shape |
|---|---|---|
| `behaviour-delta` | behaving differently from base on an input or event | an Escape key press handled by a nested popup now closes the parent |
| `default-change` | moving a default or a normalisation | an empty value now falls to a different placeholder in every consumer of a shared component |
| `diff-vs-description` | the description and the diff disagreeing | the description says shared code is unchanged, the diff edits it |
| `debt` | adding structure that must be paid back | a second data model beside the existing one, a dead branch, a leftover of the old surface |
| `performance` | making a path slower | every keystroke rebuilds all rows |
| `cross-pr` | conflicting with another open change | whichever lands second silently drops the other's fix |
| `blind-test` | a test that cannot see the regression | it uses the one input that works, or pins a neighbour of the changed symbol |

## Evidence

A finding is a claim; evidence is what makes it one. Every non-pre-existing
minor, major or blocker carries one `evidence_kind`, and `evidence` says what you ran or read:

| Kind | What it is |
|---|---|
| `probe` | you ran the code, or a script against it, on head and on base, and the outputs differ |
| `consumer-trace` | you followed a consumer of the changed symbol to its effect, file by file |
| `merge-trace` | you merged two heads (or traced the merge) and showed what the second drops |
| `red-test` | you wrote or named a test that fails on the head and passes on the base |
| `base-diff` | you read the same path on base and on head and quote both |

`probe`, `red-test` and `merge-trace` run code, so they need `allowed_tools` to include
`run-tests`. Without it, `consumer-trace` and `base-diff` are still evidence: when the trigger
and the outcome both follow from code you read, that is a finding, `minor` or `major`. A question
is for what the code you can read cannot answer (a backend reply, data, timing), not for what you did not run.

This is enforced, not requested. `keryx review ingest` lowers a `major` or
`blocker` of this reviewer that has no `evidence_kind` to `info`, marks it unproven
and lists it in `scope.md` under `## Degradation evidence screen` with the rule
`degradation-no-evidence`. It is not rejected: a true claim survives, labelled. A
finding with evidence keeps its severity; findings of other reviewers are not touched.
Without a way to show it, file `info`, or a question.

## What you are given

- the diff, and the PR description when there is one;
- the importers of the module that holds each changed shared export (and of a barrel
  that re-exports it), from the code graph, under one cap shared by all exports, with
  what it dropped. Trace those first. If the cap dropped consumers, say so in your summary;
  do not imply a complete sweep. Where the graph lists no importers for a changed export
  (a barrel, a re-export, a file it has no node for), search for the users of the symbol,
  mark them `search-derived` in `enumeration_method`, and name in the summary the exports the graph could not answer;
- the flow's frozen acceptance criteria, and the previous round's findings.

## How to look

1. Read the diff against the description. Anything the description calls unchanged
   and the diff edits is a `diff-vs-description` candidate.
2. For each changed shared symbol, read its consumers before the symbol: the
   assumption sits at the consumer, and the change moves what the consumer receives.
3. Compare behaviour, not text. An event, a default, a fallback, an ordering, a
   number of times a step runs: show it on head and on base.
4. Count work per trigger: what runs on each keystroke, render, request.
5. For each test the change added or leaned on, ask whether it would fail if the
   regression were real.

## Output lanes

Four lanes, no more:

- **Findings**: worse than base, with a class, evidence and `class_scope`.
- **Questions**: `info` with `publication: "question"` when you suspect and cannot
  show. A question is not a weak finding; it is a different thing to the reader.
- **Pre-existing**: `location_class: "pre-existing"`. True, not caused by this change, not blocking.
- **Verified clean**: in `summary`, one line per thing traced, and each line names
  what was traced (the symbol, the consumers, the command). Silence must not read as "nothing found".

## Class scope: required for `blocker` and `major`

`class_scope` lists **every** site with the shape, and how you enumerated them. For
this reviewer the sites are usually consumers; the enumeration is the walk over the
graph's consumer list. "I checked the others" is not a method.

```yaml
class_scope:
  sites: ["src/screens/a.ts:40", "src/screens/b.ts:12"]
  enumeration_method: "every consumer of the changed component in the payload; 2 of 9 pass no value"
```

```markdown
### [F-NNN] Title

- **Severity**: blocker | major | minor | info
- **Class**: behaviour-delta | default-change | diff-vs-description | debt | performance | cross-pr | blind-test
- **Evidence kind**: probe | consumer-trace | merge-trace | red-test | base-diff
- **File**: path/to/file.ts:line
- **Problem**: what is worse than on base
- **Why it matters**: impact
- **Fix**: concrete suggestion
```

Severity comes from **Severity (canonical)** in `review-orchestrator/SKILL.md`; no table here. When dispatched, follow the `reviewer-input.schema.json` payload and return a `REVIEW_RESULT` object compatible with
`.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`, then a short summary; `NEEDS_CONTEXT` rather than a guess. On a FIX slice, also return `prior_dispositions: [{id, disposition}]` for every attached finding id.

### Shared laws (every reviewer)

1. **A claim of runtime harm with no reproducible path is `info`.** If you cannot name the input, call, or condition that reaches the code, you have an observation, not a finding. Report it as `info` and say what would settle it.
2. **Never flag the theoretical.** The path you describe must exist in the code under review. Do not report a safe API because it could be misused, or a pattern because it is often wrong elsewhere.
3. **One finding per class, not one per occurrence.** When the same shape appears at several sites, report it once and list every site. Ten findings that are one finding hide the other nine problems.
4. **A deliberate choice is not a defect until its reason is read and shown wrong.** An explicit override, suppression or exemption, a comment or commit giving a reason, or a sibling doing the same is a decision: read its reason (the comment, `git log -L` or `git blame`, the sibling) before you report it, and report it only when you can show that reason wrong. A project rule is checked against accepted platform practice and its known exceptions before a deviation from it is reported.

Severity levels are defined once, in `review-orchestrator/SKILL.md` → **Severity (canonical)**. This reviewer does not restate them: `blocker` is the four merge-blocking shapes named there and nothing else, and the `major`/`minor` boundary is the trigger-and-outcome test.

---

## Red Flags

| Rationalization | Why it is wrong |
|----------------|-----------------|
| "It looks worse, so it is a `major`." | Without an `evidence_kind` the ingest lowers it to `info` and marks it unproven. Show it, or file it as a question. |
| "This code was already messy, and the change sits next to it." | Worse than the base is the question. Pre-existing goes in its own lane, not in findings. |
| "I will name the consumers I think matter." | The graph's list comes first. A model-chosen set is the sweep that misses the consumer nobody thought of; extra users you find by search are added, labelled `search-derived`. |
| "I could not run it, so it is only a question." | A traced trigger and outcome is a finding without a run. Ask only what the code cannot answer. |
| "The set was capped, but I covered the important ones." | The cap is recorded. If it dropped consumers, say so; a report that implies a full sweep over a truncated set is a false claim about coverage. |
| "The description says nothing changed, so I will trust it." | Reading the description against the diff is the check. `diff-vs-description` is a class because the two disagree often. |
| "The new test passes, so the change is covered." | A test that uses the one input that works cannot see the regression. Ask whether it fails when the behaviour is wrong. |
| "No findings, so I will say nothing about what I looked at." | Silence reads as "nothing found". Every verified-clean line names what was traced. |

---

## Verification

Report done only once all of these hold:

- Every finding has one `degradation_class` and one `evidence_kind`, and `evidence` says what was run or read.
- Every `blocker` and `major` carries `class_scope` whose `enumeration_method` is the walk over the graph's consumer list.
- Every consumer in the payload was traced, or the summary says which were not and why, and whether the cap dropped any.
- Anything you could neither trace nor show is `info`, a question, or pre-existing, not a `major`.
- The summary has a verified-clean line for each thing traced without a finding, naming what was traced.

<!-- keryx:layers-block:start -->
## Project layers: graph, tests, wiki, memory

Your payload may carry a `layers` block for your files: the files the graph says are affected, symbol neighbours, related tests, the wiki pages that describe the files and the memory entries for their module. It is bounded, and `truncated` names what was cut and the command that fetches the rest. When the diff alone does not settle a question, ask the project. Each command below is read-only and calls no model.

- `keryx gdgraph affected <file>`: who depends on the file. Use it before you call a change contained, and whenever a changed export, signature or behaviour may have callers outside your files.
- `keryx test related <file>`: the tests that cover the file. Use it before you say a behaviour is untested, and to judge whether a test would fail if the code broke.
- `keryx wiki ask "<q>"`: what the project wiki says a module is for and which rules bind it. Use it when the intent of the code is unclear and the diff does not state it.
- `keryx memory search "<q>"`: recorded lessons, decisions and known mistakes. Use it before you report a pattern the project may already have decided on, and when a failure looks like one it has seen.

In a review package, `keryx gdgraph affected <file> --data-dir <package>/layers/graph` reads the graph built at the PR head; the tracked graph may be from another commit. A finding still rests on the code you read: what a layer says is a lead, not evidence. If a layer is empty or a command fails, say so in the report instead of guessing.
<!-- keryx:layers-block:end -->
