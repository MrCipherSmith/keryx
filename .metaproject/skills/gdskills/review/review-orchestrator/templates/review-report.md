# Review report (render)

The shape of the report a human reads at the end of a round, and of the PR
review when one is published. Machine contracts are unchanged: severity stays
`blocker | major | minor | info`, the output verdict stays
`APPROVE | APPROVE_WITH_SUGGESTIONS | REQUEST_CHANGES`, and the `keryx:findings`
block still rides after the prose in the ingested copy. This file says how that
record is *shown*.

Read `templates/pr-comment-frontend.md` or `templates/pr-comment-backend.md`
for the domain checklist. This file is the skeleton both share, and the slots a
project overlay may fill.

## Where it is posted

On a pull request the report is the **body of one formal review**, so it
counts as a review and not as a comment stream:

| Machine `verdict` | Review state |
|---|---|
| `REQUEST_CHANGES` | Request changes, if the reviewer may; on the reviewer's own PR GitHub rejects it, so Comment |
| `APPROVE` / `APPROVE_WITH_SUGGESTIONS` | Approve, if the reviewer may approve; else Comment |
| PR already merged or closed | a plain PR comment — a review state no longer gates anything |

One report per round, posted once. The `keryx:findings` block is never posted;
it lives in the copy `keryx review ingest` reads. If the body would exceed
GitHub's 65,536-character limit, post the visible part and link the follow-up
file for the rest.

## The skeleton

Sections in this order. Omit a heading that has no content. The visible part is
what a reader must act on; everything else is folded.

```markdown
<!-- slot:pre-verdict -->
**Changes requested — 1 Blocker, 2 Major, 4 Minor, 1 question.** <what holds, and where the risk is — one sentence.>
Reviewed `<head>` against `<base>` · round N · <files> files, +<add>/−<del> · CI <green | red: check names>.
<!-- slot:after-verdict -->

### Prior findings            (fix rounds only)
### Blocker
### Major
### Minor
### Questions

<details><summary><b>Pre-existing (not blocking)</b></summary> … </details>
<details><summary><b>Scope</b></summary> … </details>          (only when a pr-process note exists)
<details><summary><b>Verified clean</b></summary> … <!-- slot:verified-clean --> </details>
<details><summary><b>How this review was run</b></summary> … <!-- slot:how-run --> </details>
```

### The verdict line

Map the machine verdict, do not invent a fourth one:

| Machine `verdict` | First line |
|---|---|
| `REQUEST_CHANGES` | `**Changes requested — N Blocker, N Major, N Minor, N questions.**` |
| `APPROVE` | `**No blockers, merge-ready.**` |
| `APPROVE_WITH_SUGGESTIONS` | `**No blockers, merge-ready — N Minor, N questions.**` |

`N` counts findings **in the changed code** at that severity. A
`location_class: pre-existing` finding is not counted and does not flip the
verdict. Omit a zero count. A question is an `info` finding that needs an
author answer, rendered under Questions, not as a finding.

The second line is the context line: head, base, round, size, CI. If head moved
during the round, add `· unchecked: <commits>`.

## One finding

Blocker and Major as a paragraph, visible:

```markdown
**F-012. The guard is not called on the save path.** [`src/store.ts:88`](https://github.com/<owner>/<repo>/blob/<head>/src/store.ts#L88), in the diff.
`save()` awaits `api.put` and then writes the form with no `runInAction`. A response that lands after unmount still mutates the store. Probe: <what was run, and what it printed>.
Also at: `src/other.ts:12`, `src/third.ts:40`.
Fix: wrap the write in `runInAction`, and ignore the response when `disposed` is set.
```

Minor as one list item, proof and fix in one to three sentences:

```markdown
- **F-019. Icon button has no accessible name.** [`src/Toolbar.tsx:14`](…), in the diff — the control is an icon with no `aria-label`, so a screen reader announces nothing. Fix: add an `aria-label` from `t()`.
```

Rules:

- Bold first line is the claim, one sentence. Then `file:line` and the location
  class: `in the diff`, `pre-existing`, or `pr-process`.
- `file:line` links to the blob at the **reviewed head SHA**, not to a branch,
  so the link still points at the reviewed line after the author pushes.
- Proof is a traced path, a probe that was run (with what it printed), or a
  concrete failing scenario. Not "this looks wrong".
- A class with several sites is one finding with an `Also at:` line, never one
  finding per site.
- `Fix:` is concrete. A suggested fix is unchecked code: do not publish a fix
  you have not checked the same way you checked the finding. A GitHub
  `suggestion` block is allowed only for a fix that was checked.
- Finding ids (`F-NNN`) are stable across rounds: a re-raised finding keeps its
  id, a new one takes the next free number.
- No finding table. A table is allowed only for short cells: ids, `file:line`,
  counts, statuses, before/after, pass/fail. A cell longer than about ten words
  is not a table cell.

When there are more than five Minor findings, wrap the Minor list in
`<details open><summary><b>Minor (N)</b></summary>` so the page stays scannable.

## Prior findings (fix rounds)

On a round with `is_fix_round: true`, the disposition of every prior finding
comes before the new ones, as a short table:

```markdown
### Prior findings
| Id | Finding | Status | Evidence |
|---|---|---|---|
| F-003 | Delete frame dropped on cache miss | closed | probe at `<head>`: handler fires |
| F-007 | Pending key built by hand | partial | 2 of 4 sites |
```

Statuses: `closed`, `open`, `partial`, `regressed`, `withdrawn`. A withdrawn
finding names what made it wrong, in one sentence, and is listed first. A defect
a fix introduced is a new finding, rendered under its severity with
`regressed from F-NNN`.

## Questions and pre-existing

`info` is not published as a finding. If it needs an author answer, render it
as a numbered question. Otherwise drop it from the prose (it stays in the
`keryx:findings` block).

Pre-existing code does not block the merge. Render it under Pre-existing and
say so. A serious one may *suggest* a follow-up issue. Do not open the issue.

## Verified clean

One line per check that was actually run and held: what was checked, and how.
Do not list a checklist item that was not checked. Do not praise.

```markdown
- MobX write after `await` — every `await` in the diff is followed by `runInAction` or an early return on `disposed`.
- i18n — `t()` appears only in render; no `defaultValue`.
```

## How this review was run

A factual run inventory, not an author or account signature. List only steps
confirmed by the run record; never infer an operator identity from `gh auth`,
git config, a credential or a PR author. Use `not recorded` when evidence for
a tool, skill or model is unavailable; use `none` only when the run proves none.

```markdown
- **Workflow:** `review-orchestrator`; severity and lanes per the repository review rules, else the canonical rubric in this skill.
- **Scope:** `<base>..<head>`, round N, PR #N. Unchecked commits: <list or none>.
- **Models:** <actual model names and the reviewers that ran on each; or not recorded>.
- **Tools:** <tools actually invoked for this review and their roles; or not recorded>.
- **Skills:** <skills actually loaded or executed and their roles; or not recorded>.
- **Subagents:** <dispatched subagents, their reviewer roles and actual models; or none when confirmed, otherwise not recorded>.
- **Fallback:** <reviewer> via `general-purpose` because <native agent type unavailable | no bundled agent>. Or `none`.
- **Not run:** <reviewer> — <short reason>. Or `none`.
- **Selection:** <explicit flags | start questions: reviewers <`--all` | narrowed to …>, counterpart <verified at <sha> | skipped: reason>, models <accepted | all deep | custom> | defaults (unattended)>
- **Verification:** <mode>. Confirmed N, refuted N, unverifiable N, unverified N. Removed N (always 0 outside `filter`).
- **Stage counts:** pre-filter dropped <files>/<blocks>/<lines> (or `not recorded`). Retained N.
- **Context:** <job/context path, or none>
- **Follow-up file:** <path or link, or none> — <one sentence on what it holds>
- **Reviewed at:** <UTC timestamp>
```

Model rules:

- Name the model that actually ran. Never write `adaptive`, `inherit`,
  `unsupported`, or `current-session` in the model slot.
- Group reviewers under the model they ran on. One bullet per model.
- `Model strategy` (`ask` or `adaptive`) goes under Selection, never in
  place of an actual model name.
- Keep **Run** complete. If Not run is long, group it with counts and notable
  names; the full list belongs in the follow-up file.

## Formatting rules

- Lead with the conclusion. Nothing above the verdict except a `pre-verdict`
  slot an overlay fills.
- Visible part: verdict, context line, prior findings, Blocker, Major, Minor,
  Questions. Everything else is inside `<details>`.
- Leave a blank line after every `<summary>…</summary>` and before
  `</details>`; GitHub renders the Markdown inside only then.
- Code, paths, flags and identifiers in backticks. No screenshots of code.
- No `## AI Review Report`, `# AI Review Report`, `## AI Summary`,
  `## Positive Notes`, or any heading that names the tool instead of the
  subject. No `Generated with`, no bot signature, no co-author trailer. A model
  name appears only in **How this review was run**, as the model that ran,
  never as an author.

## Overlay slots

A project overlay (for example a repository facade over this engine) extends the
report **only** by filling these slots. It may not reorder, rename or remove a
base section, add a severity level, or change the verdict mapping.

| Slot | Where | Typical content |
|---|---|---|
| `pre-verdict` | above the verdict line | a scope verdict that comes before severity, e.g. "Mis-scoped: split" |
| `after-verdict` | right after the context line | round status, round cap, review-state rationale, a table of other reviewers' open items |
| `verified-clean` | end of Verified clean | the project's mandatory checks, each with how it was checked |
| `how-run` | end of How this review was run | project orchestrator name, overlays selected and skipped, project packages applied, rule files read |

An overlay may also map the review state more strictly (for example "any Major
→ Request changes"), never more loosely than the table in *Where it is posted*.
An empty slot leaves no trace in the output. The `<!-- slot:… -->` markers are
rendering guides and are not posted.

## Follow-up file

When publication is `comment-and-ai-artifact`, write the long form beside the
job, not into the PR review:

```text
jobs/reviews/pr-<number>/review-report.md
.metaproject/jobs/<job-name>/ai/review-report.md
```

Same section order as the review. YAML front matter may keep the machine
verdict (`APPROVE | APPROVE_WITH_SUGGESTIONS | REQUEST_CHANGES`) because ingest
reads it. The visible title is the subject of the change, never a tool name.
No co-author line in the file either.

## Language

English, regardless of chat language or reviewer output language.
