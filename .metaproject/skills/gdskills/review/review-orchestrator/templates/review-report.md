# Review report (render)

The shape of the report a human reads at the end of a round, and of the PR
comment when one is published. Machine contracts are unchanged: severity stays
`blocker | major | minor | info`, the output verdict stays
`APPROVE | APPROVE_WITH_SUGGESTIONS | REQUEST_CHANGES`, and the `keryx:findings`
block still rides after the prose. This file says how that record is *shown*.

Read `templates/pr-comment-frontend.md` or `templates/pr-comment-backend.md`
for the domain checklist. This file is the skeleton both share.

## How the visible verdict is chosen

Map the machine verdict, do not invent a fourth one:

| Machine `verdict` | First line |
|---|---|
| `REQUEST_CHANGES` | `**Changes requested — N Blocker, N Major, N Minor, N questions.**` |
| `APPROVE` | `**No blockers, merge-ready.**` |
| `APPROVE_WITH_SUGGESTIONS` | `**No blockers, merge-ready — N Minor, N questions.**` |

`N` is the count of findings **in the changed code** at that severity. A
`location_class: pre-existing` finding is not in that count and does not flip
the verdict. Omit a zero Blocker count. A question is an `info` finding that
needs an author answer, rendered under Questions, not as a finding.

Then one sentence: what holds, and where the risk is. Name the commits
reviewed: `Reviewed <head> against <base> (round N).` If head moved during the
round, name the commits not checked.

## Section order

1. Verdict line.
2. Blocker, then Major. Omit a heading that has no findings.
3. Minor.
4. Questions.
5. Pre-existing (not blocking). Omit if empty.
6. Scope — only when a process note exists (`location_class: pr-process`).
7. Verified clean. Required. Not a list of compliments.
8. How this review was run.
9. The `keryx:findings` fence, after the prose, unchanged.

No `## AI Review Report`, `# AI Review Report`, `## AI Summary`, `## Positive
Notes`, or any heading that names the tool instead of the subject. No
`Generated with`, no bot signature, no co-author trailer. A model name appears
only in **How this review was run**, as the model that ran, never as an author.

## One finding

Blocker and Major, as a paragraph:

```markdown
**F-012. The guard is not called on the save path.** `src/store.ts:88`, in the diff.
`save()` awaits `api.put` and then writes the form with no `runInAction`. A response that lands after unmount still mutates the store.
Fix: wrap the write in `runInAction`, and ignore the response when `disposed` is set.
```

Minor, as one list item, proof and fix in one to three sentences:

```markdown
- **F-019. Icon button has no accessible name.** `src/Toolbar.tsx:14`, in the diff — the control is an icon with no `aria-label`, so a screen reader announces nothing. Fix: add an `aria-label` from `t()`.
```

Rules:

- Bold first line is the claim, one sentence. Then `file:line` and the location
  class: `in the diff`, `pre-existing`, or `pr-process`.
- Proof is a traced path, a probe that was run, or a concrete failing scenario.
  Not "this looks wrong".
- `Fix:` is concrete. A suggested fix is unchecked code: do not publish a fix
  you have not checked the same way you checked the finding.
- No finding table. A table is allowed only for short cells: ids, `file:line`,
  counts, statuses, before/after, pass/fail. A cell longer than about ten words
  is not a table cell.

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
### Verified clean
- MobX write after `await` — every `await` in the diff is followed by `runInAction` or an early return on `disposed`.
- i18n — `t()` appears only in render; no `defaultValue`.
```

## How this review was run

A list, not a meta table. Keep every fact the old Meta table carried.

```markdown
### How this review was run
- **Run by:** @<gh-login> with `review-orchestrator`. Severity and lanes per the repository review rules, else the canonical rubric in this skill.
- **Scope:** `<base>..<head>`, round N, PR #N. Unchecked commits: <list or none>.
- **Orchestrator:** `review-orchestrator`
- **<actual model name>:** <reviewers dispatched on it, comma-separated>
- **Fallback:** <reviewer> via `general-purpose` because <native agent type unavailable | no bundled agent>. Or `none`.
- **Not run:** <reviewer> — <short reason>. Or `none`.
- **Selection:** <auto-detected scope | explicit flags | optional groups the user picked>
- **Verification:** <mode>. Confirmed N, refuted N, unverifiable N, unverified N. Removed N (always 0 outside `filter`).
- **Stage counts:** pre-filter dropped <files>/<blocks>/<lines> (or `not recorded`). Retained N.
- **Context:** <job/context path, or none>
- **Follow-up file:** <path or link, or none> — <one sentence on what it holds>
- **Reviewed at:** <UTC timestamp>
```

Model rules, unchanged from the old metadata table:

- Name the model that actually ran. Never write `adaptive`, `inherit`,
  `unsupported`, or `current-session` in the model slot.
- Group reviewers under the model they ran on. One bullet per model.
- `Model strategy` (`ask` or `adaptive`) goes on the Run by line or under
  Selection, not in place of a model name.
- Keep **Run** complete. If Not run is long, group it with counts and notable
  names; the full list belongs in the follow-up file.

## Follow-up file

When publication is `comment-and-ai-artifact`, write the long form beside the
job, not into the PR comment:

```text
jobs/reviews/pr-<number>/review-report.md
.metaproject/jobs/<job-name>/ai/review-report.md
```

Same section order as the comment. YAML front matter may keep the machine
verdict (`APPROVE | APPROVE_WITH_SUGGESTIONS | REQUEST_CHANGES`) because ingest
reads it. The visible title is the subject of the change, never a tool name.
No co-author line in the file either.

## Language

English, regardless of chat language or reviewer output language.
