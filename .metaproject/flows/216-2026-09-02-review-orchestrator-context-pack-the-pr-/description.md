# review-orchestrator context pack: the PR description and cross-repo contracts are prose, not contract

Status: formalized
Source: user description

## Problem

`review-orchestrator`'s Review Context Pack (SKILL.md `## Review Context Pack`)
states two rules with real reasoning behind them, and neither is wired to
anything that can enforce or even carry it.

**The PR description.** The prose says to fetch it with
`gh pr view <n> --json title,body` into `review_context.pr.body`, hand it to
every reviewer, and file a `minor` finding when the description promises an
approach the diff does not take. But:

- `pr` in `review-context.schema.json` is `{"type":["object","null"],
  "additionalProperties":true}` with zero `properties`. `pr.body` is a naming
  convention, not a contract. Compare `memory`, which got typed fields when it
  was promoted from best-effort to required.
- The Step 1 checklist line reads `Build Review Context Pack (PR metadata,
  scope, rules, context_doc summary)`. It names neither the body, nor memory,
  nor cross-repo. The checklist is what an agent ticks.
- "Hand it to every reviewer" has no receiving end. `pr.body` / "PR description"
  appears in exactly three lines of the whole bundled skill set, all inside the
  orchestrator's own Context Pack section. No reviewer skill mentions it, so the
  description-vs-diff finding is unowned.
- The Stage 1 spec gate keys off `issue_url` or a task doc, never the body. A PR
  with no linked issue gets no spec gate at all, even when the body is the only
  written statement of intent.

**Cross-repo contracts.** The `### Cross-repo contracts are read, not assumed`
section models the producer as already committed somewhere: read it, pin the
SHA. A parallel *open* backend PR does not fit that model.

- The `cross_repo` example carries `repo`/`sha`/`reason`/`facts`. There is no
  field for the PR or branch the contract lives on, and none for whether it is
  merged. A branch SHA dies at squash/rebase, so a round-3 reviewer cites a
  commit that no longer exists.
- Merge ordering appears only as a one-line aside making a missing deploy note a
  `minor` finding about the *description*. The operational case — consumer
  merges before producer and breaks production — has no severity anywhere.
- Cross-repo facts are pinned once and never revalidated. The multi-round
  machinery is thorough for the local diff (`prior_findings`, mandatory
  dispositions, fix rounds, `blast-radius --previous`), and a parallel backend PR
  is precisely the thing that moves between rounds.
- `reviewer-finding.schema.json` has `file` and `line` and no `repo`. A
  cross-repo finding cannot say which repository its evidence is in, so the
  "`info` unless `file:line` at a pinned SHA" rule is unverifiable.
- `cross_repo` is absent from `review-context.schema.json` entirely — it
  survives only on `additionalProperties: true` — and the string appears nowhere
  in code, tests, or any other skill.

## Expected Outcome

The two rules are carried by the schemas and the checklist, and the
description-vs-diff check has a named owner:

- `pr` and `cross_repo` are typed in `review-context.schema.json`, with
  `cross_repo` able to describe an unmerged producer and a merge order.
- The Step 1 checklist names the body, memory, and cross-repo, so ticking it
  means they were collected.
- Some reviewer or gate owns the description-vs-diff comparison; a PR with no
  linked issue falls back to the body as its spec source.
- A finding can name the repository its evidence lives in.
- `cross_repo` entries whose producer is still open are revalidated per round
  rather than pinned once.

## Out of Scope

- A `keryx review context` CLI subcommand, or persisting the context pack
  through `review ingest`. Both are real gaps found during the analysis, but
  they are new CLI surface and belong in their own flow.
- Registering `review-context`/`reviewer-input` in the `keryx skills contracts`
  registry. Same reason: separate change, wider blast radius.
- Any change to reviewers' own domain rules beyond the description-vs-diff
  ownership added here.
