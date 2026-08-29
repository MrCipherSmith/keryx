# Specification — the three new capabilities
Version: 0.1.0

Three additions to `flow-orchestrator` and `review-orchestrator`:

1. **Deep review rounds** after the draft PR, covering the change *and* what
   the change can break.
2. **Completion gated on a clean final round** — `done` requires the last round
   to have returned nothing unresolved and to have confirmed the fixes.
3. **External PR comments** collected on every round, fixed like any other
   finding, and **replied to**.

All three depend on the durable review record surviving a round, which it does
not today (roadmap §1.1). That is a hard prerequisite, not a nicety.

---

## 1. Deep review rounds

### 1.1 The problem being solved

Today the PR review/fix loop reviews **the diff**. A diff review answers "is
this change good?" It does not answer "did this change break something that was
working." Those are different questions and only the first is currently asked.

### 1.2 The design problem, stated honestly

"Review the functionality so nothing breaks" naively means "review the whole
repository every round." That is unaffordable and, worse, actively harmful:
review quality decays as context grows — measured F1 **0.65 at round 2 → 0.29
at round 10**. An unbounded scope would make later rounds worse than earlier
ones.

So the second scope must be **derived, bounded and deterministic** — not "look
around and see."

### 1.3 Two scopes per round

Every deep round dispatches reviewers under exactly two scopes.

**Scope A — `diff`.** The changed hunks ± N context lines, after the
deterministic pre-filter (roadmap §2.1). This is today's behaviour, narrowed.
Question: *is this change correct?*

**Scope B — `blast-radius`.** Computed, not browsed:

1. `keryx gdgraph affected <each changed file>` → the dependent set.
2. Rank by edge distance from the change; keep distance ≤ `blast_radius_depth`
   (default **2**).
3. Cap at `blast_radius_max_files` (default **40**), keeping the closest first.
4. Add the tests that cover those paths, via the testing module's related-test
   intelligence.
5. Record the resulting set, the depth, and **everything dropped by the cap**,
   in the round manifest. A silent truncation would read as "we checked
   everything" when we did not.

Question for scope B is deliberately narrow: *does this change break an
existing behaviour in this set?* Not *is this code good* — the blast-radius set
is not under review, it is under regression check. Reviewers dispatched here
must not raise style, naming, or architectural findings about code the change
did not touch. That restriction is what keeps the round from turning into a
whole-repo audit.

### 1.4 A new reviewer dimension: `review-regression`

Scope B needs a reviewer that asks the regression question directly, because
none of the existing fourteen do. It receives:

- the diff,
- the blast-radius set with each file's dependency path back to the change,
- the acceptance criteria the flow froze,
- the previous round's findings.

It emits findings under the ordinary contract, with `class_scope` naming the
*caller* that breaks, not the changed line — because that is the site a human
has to look at.

### 1.5 Round composition

| Round | Scope A | Scope B | Verifier |
|---|---|---|---|
| 1 (first after draft PR) | yes | yes | annotate |
| 2..N | yes | recomputed only if the changed-file set changed | filter |
| final | yes | yes, forced recompute | filter |

The blast radius is recomputed when the changed-file set changes, and always on
the final round — otherwise a fix introduced in round 3 gets no regression check
at all.

### 1.6 Acceptance criteria

- **AC-D1** A deep round dispatches under both scopes, and the round manifest
  records the blast-radius set, the depth used, and every file dropped by the
  cap.
- **AC-D2** The blast-radius set is derived from `gdgraph affected`, not from a
  model's choice of files to open.
- **AC-D3** A finding raised under scope B that is not a regression — style,
  naming, or architecture in untouched code — is rejected by the orchestrator,
  not merely discouraged in prose.
- **AC-D4** The final round always recomputes the blast radius.
- **AC-D5** Every round's cost (tokens, wall-clock, file count per scope) is
  recorded, so the added scope can be shown to be affordable rather than assumed
  to be.

---

## 2. Completion gated on a clean final round

### 2.1 What "clean" must mean

A finding disappearing from round N+1 is **not** evidence it was fixed. It is
equally consistent with the reviewer not looking, the context being fuller, or
the sampling being different. Treating absence as proof is how a flow closes
green over a real defect.

So "clean" is defined positively, per finding, and never by omission:

> A round is **clean** when every finding ever raised in this flow's review
> history has a terminal disposition, and every disposition is backed by
> evidence recorded at the time it was assigned.

Terminal dispositions:

| Disposition | Requires |
|---|---|
| `fixed` | a commit SHA, plus a verifier verdict of `refuted` **against that SHA** — i.e. the finding no longer reproduces |
| `refuted` | a verifier verdict of `refuted` with method and evidence — it was never real |
| `dismissed` | one of the four taxonomy reasons (roadmap §5.2) **and** a human decision recorded; the orchestrator may not dismiss on its own authority |

### 2.2 The gate

A sixth gate in `src/flow/service.ts` `complete()`, alongside
acceptance-criteria, PR-or-merge, health and security.

`review` gate passes when **all** hold:

1. A managed review record exists for this flow and has at least one **ingested**
   round. A round that was never ingested cannot be cited — nothing durable
   records what it found.
2. The latest round has **zero** findings without a terminal disposition, at
   severity ≥ `completion_severity_floor` (default `minor`; `info` never
   blocks).
3. The latest round ran against the **head commit of the PR**, not an earlier
   one. A clean round against a stale SHA proves nothing about what will merge.
4. There are **no unanswered external comments** (§3).
5. The verifier ran in `filter` mode on that round, and its `filter_stats` are
   recorded.

Failure reports which of the five conditions failed and for which findings —
never a bare "review gate: fail".

### 2.3 Interaction with the existing loop bound

Rounds are capped at 3 (roadmap §2.5). These two rules can conflict: the cap
can be reached while the gate is still unsatisfied. **That conflict resolves in
favour of not completing.** The flow stays `in-progress`, the blocker is
reported, and the operator decides. Forcing completion at the cap would
reintroduce exactly the failure this whole package exists to remove.

### 2.4 Acceptance criteria

- **AC-C1** `flow complete` fails when the latest ingested round has any
  non-terminal finding at or above the severity floor.
- **AC-C2** `flow complete` fails when the latest round's SHA is not the PR head.
- **AC-C3** A finding marked `fixed` without a verifier verdict against the
  fixing commit is rejected at gate time.
- **AC-C4** The orchestrator cannot assign `dismissed` without a recorded human
  decision.
- **AC-C5** Reaching the round cap with an unsatisfied gate leaves the flow
  `in-progress` and reports the blocker; it never completes.
- **AC-C6** The gate is enforced in TypeScript with tests. It does not go in a
  Markdown file.

---

## 3. External PR comments

### 3.1 Behaviour

When the flow has a PR URL, **every** round begins by collecting comments left
by anyone other than us, and ends by answering them.

**Collect.** Three sources, all of them:

- inline review comments — `GET /repos/{owner}/{repo}/pulls/{n}/comments`
- review submissions and their bodies — `GET .../pulls/{n}/reviews`
- PR-level discussion — `GET .../issues/{n}/comments`

**Filter.**

- Exclude comments authored by the identity the orchestrator is acting as.
- Exclude comments already in `handled_comments` — **unless** the thread has a
  newer reply from a non-us author, which makes it new again.
- Keep bot comments. A bot reviewer is a reviewer; CodeRabbit, Greptile and
  Copilot comments are handled exactly like a human's.

**Convert.** Each unhandled comment becomes a finding with:

```
source: "external"
external_ref: { id, author, url, path, line, thread_id, submitted_at }
```

Severity is **classified, never invented**: a comment attached to a review whose
state is `CHANGES_REQUESTED` starts at `major`; everything else starts at
`minor`. The orchestrator may lower a severity only by assigning a terminal
disposition with a reason — it may never silently drop an external comment.

**Fix.** External findings enter the same fix loop as internal ones. They carry
one extra property: they cannot be `refuted` by the verifier alone. A human
asked a question; a machine deciding the question was invalid is not an answer.
A verifier `refuted` verdict on an external finding produces the disposition
`answered-disagree`, which still requires a reply explaining why.

### 3.2 Replying — once, at the end, briefly

**Comments are collected every round. They are answered once, at the end.**

Not per round. A bot that replies on every round turns one review thread into
six, and the reviewer reads the noise before they read the answer. The work
happens continuously; the speaking happens once.

The reply pass runs after the final round and before the completion gate, so
that every reply states a settled outcome rather than an intention.

**Brevity is a hard rule, not a style preference.** See §5 — everything written
to GitHub is short; the reasoning lives in the flow package.

| Outcome | Reply is |
|---|---|
| fixed | one sentence naming what changed, plus the commit SHA |
| answered-disagree | one or two sentences on why not, and a link to the flow's journal entry |
| out-of-scope / deferred | one sentence, and where it was recorded instead |

Budget: **≤ 2 sentences per comment.** No preamble, no restating the comment
back, no apology, no summary of the flow. If the explanation does not fit, the
reply carries the conclusion and a link — the detail belongs in the flow, where
it is durable and does not cost the reviewer anything to skip.

Rules:

- Replies go **in the thread** (`POST .../pulls/{n}/comments/{id}/replies`), not
  as new top-level comments.
- **Never resolve or hide someone else's thread.** Replying is ours; resolving
  is the reviewer's call. Auto-resolving is how a bot silences a human.
- Every collected comment gets exactly one reply. Silence is not an acceptable
  outcome for any comment, and neither is a second reply saying the same thing.
- Replies are capped (`max_replies_total`, default **30**); on overflow the
  orchestrator posts a single summary comment listing what was addressed and
  reports the backlog, rather than a wall of near-identical threads.

**The trade-off, stated.** A reviewer who comments early waits until the end for
an answer. That is deliberate: the alternative is answering with a
work-in-progress state that later changes, which is worse than waiting. If a
comment blocks progress rather than merely reporting a problem, the orchestrator
escalates it to the operator immediately instead of replying to it early.

### 3.3 State

Durable, in the flow package — because a round that forgets what it answered
will answer twice:

```json
"handled_comments": [
  {
    "id": "<comment id>",
    "thread_id": "<thread id>",
    "author": "<login>",
    "url": "<html url>",
    "first_seen_round": 1,
    "handled_at": "<iso-utc>",
    "sha": "<commit that addressed it, when fixed>",
    "disposition": "fixed | answered-disagree | out-of-scope | deferred",
    "reply_url": "<html url of our reply>"
  }
]
```

### 3.4 Acceptance criteria

- **AC-X1** All three comment sources are polled every round, and bot authors
  are handled identically to humans.
- **AC-X2** A comment is never dropped without a recorded disposition and a
  posted reply.
- **AC-X3** A thread with a new non-us reply is re-opened as unhandled.
- **AC-X4** The orchestrator never resolves or hides a thread it did not open.
- **AC-X5** Replies are threaded, not top-level.
- **AC-X6** `flow complete` fails while any collected comment lacks a
  disposition **or** lacks a posted reply (this is condition 4 of the §2.2
  gate).
- **AC-X7** Comment handling is idempotent across a resume: the same comment is
  never answered twice because the orchestrator's context was compacted.
- **AC-X8** No reply is posted before the final round. Exactly one reply exists
  per collected comment when the flow completes.
- **AC-X9** No reply exceeds two sentences, and none restates the comment it
  answers.

---

## 4. Adaptive model selection

### 4.1 The problem

Every dispatch today runs on whatever model the session runs on. A reviewer
scanning a 12-line diff and a regression reviewer reasoning across a 40-file
blast radius get the same model, and the cheap one pays flagship prices while
the hard one gets no more capability than the trivial one.

`subagent-dispatch.schema.json` already carries a `model.tier` field. It is
applied in exactly one narrow case. This makes it the general mechanism.

### 4.2 Tiers, not model names

Skills declare a **tier**, never a model name. A skill that names
`claude-opus-5` is wrong the day the provider changes, and unusable for anyone
running a different provider.

| Tier | For |
|---|---|
| `light` | mechanical, verifiable work — pre-filter, `class_scope` existence checks, comment collection, formatting a reply |
| `standard` | ordinary reviewing and implementation — the default |
| `deep` | genuinely hard reasoning — regression review across the blast radius, strategy change after a failed loop, synthesis across many findings |

### 4.3 Mapping tier to model, per provider family

Resolved at dispatch time from the active provider:

| Provider family | `light` | `standard` | `deep` |
|---|---|---|---|
| Claude | `sonnet` | `opus` | `fable` |
| Codex | `terra` | `terra` | `sol` |
| anything else, or undetectable | **the model the main agent is running on**, for every tier |

The fallback is the important row. A provider we cannot classify must **never**
cause a dispatch to fail, and must never cause a silent downgrade — it inherits
the session's model unchanged. Degrading capability because detection failed is
the worst of the three outcomes.

> **Confirm before implementing:** the Claude ordering above is taken from the
> operator's instruction as given (`sonnet, opus, fable`) and read as ascending
> capability; the Codex names (`terra`, `sol`) likewise. Both mappings are
> configuration, not code, precisely so that a wrong guess here is a one-line
> fix rather than a rewrite.

### 4.4 Assigning a tier

Tier is assigned by the orchestrator per dispatch, from properties it already
has — not by asking a model to rate its own difficulty:

| Signal | Effect |
|---|---|
| scope is `blast-radius` | at least `deep` |
| fix attempt ≥ 2 on the same finding | raise one tier |
| forced strategy change after the loop cap | `deep` |
| finding count in scope ≤ 3 **and** diff ≤ 50 lines | allow `light` |
| verifier method is "run a command" | `light` — the evidence comes from execution, not from reasoning |
| any security-severity finding | never below `standard` |

### 4.5 Replaces the current rule

`.metaproject/rules/core/model-selection.mdc` is stale in two ways and must be
rewritten with this: it lists Codex model names that no longer match the
environment, and its "Mandatory Behavior" says *"Always ask user before changing
model for sub-agents"* — which makes adaptive selection impossible by
construction. The confirmation requirement moves to configuration: the operator
sets the mapping once, and dispatch applies it without asking.

### 4.6 Acceptance criteria

- **AC-M1** No skill file names a concrete model. Tiers only.
- **AC-M2** An unrecognised or undetectable provider inherits the session model
  for every tier, and the dispatch succeeds.
- **AC-M3** Tier assignment is deterministic from the signals in §4.4 and
  recorded in the dispatch, so a run can be explained after the fact.
- **AC-M4** The tier→model mapping is configuration; changing a provider's
  models requires no code change.
- **AC-M5** `model-selection.mdc` no longer requires asking the user per
  dispatch.

---

## 5. Everything written to GitHub is brief

A cross-cutting rule, stated once and applied to every surface that posts
outward: **PR bodies, PR comments, review replies, issue comments, and commit
messages going to a PR.**

- Lead with the conclusion. No preamble, no restating the question.
- Say what changed and where. Link, do not paste.
- The reasoning, the evidence, the rejected alternatives and the round history
  live in the flow package (`journal.md`, `context.md`, the review artifacts) —
  which is durable, searchable, and costs a reader nothing to skip.
- A GitHub artifact that needs more than a short paragraph is a signal that the
  detail belongs in the flow with a link out, not that the paragraph should grow.

This is deliberately asymmetric: **verbose in the flow, terse on GitHub.** The
flow is written for whoever resumes the work; GitHub is written for someone who
did not ask for our reasoning and is reading between other tasks.

- **AC-B1** No PR comment or reply written by the orchestrator exceeds two
  sentences without containing a link to the flow artifact carrying the detail.
- **AC-B2** The detail that a GitHub artifact omits exists in the flow package
  and is linked from it.

---

## Configuration

Added to the flow-orchestrator input contract, with defaults chosen so the
conservative behaviour is the default:

| Key | Default | Meaning |
|---|---|---|
| `deep_review.enabled` | `true` when a PR exists | run both scopes |
| `deep_review.blast_radius_depth` | `2` | gdgraph edge distance |
| `deep_review.blast_radius_max_files` | `40` | cap, with drops recorded |
| `completion.severity_floor` | `minor` | what blocks `flow complete` |
| `completion.require_clean_round` | `true` | the §2.2 gate |
| `pr_comments.enabled` | `true` when a PR exists | collect every round, reply once at the end |
| `pr_comments.max_replies_total` | `30` | on overflow, one summary comment plus a reported backlog |
| `pr_comments.max_sentences_per_reply` | `2` | §5 brevity, enforced not advised |
| `verification_mode` | `annotate` | `off` / `annotate` / `filter` |
| `models.tier_map` | see §4.3 | provider family → `{light, standard, deep}` |
| `models.on_unknown_provider` | `inherit-session` | never `downgrade`, never `fail` |

## Sources

Telegram-, GitHub- and model-behaviour claims in this package are cited inline
in [roadmap.md](roadmap.md). GitHub API shapes are from the REST reference for
pull request review comments, reviews, and issue comments.
