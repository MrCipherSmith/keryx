# alibaba/open-code-review vs the keryx review skills

Read 2026-09-15 against `alibaba/open-code-review` at `main` (Go, Apache-2.0,
26,835 stars, created 2026-05-18, pushed the same day this was written) and
against keryx `main` at `b618e466` (22 bundled review skills, 0 project-local).

Everything below is read from their repository and ours. No head-to-head run was
performed, and their published numbers are self-reported — the README states the
claims but does not print the benchmark table, so the figures here are quoted as
claims, not as measurements we reproduced.

---

## 1. The one difference everything else follows from

**Where the review intelligence lives.**

| | open-code-review | keryx |
|---|---|---|
| Review logic | a compiled Go pipeline around **one** agent loop | **22 markdown reviewer skills**, dispatched as parallel subagents |
| What the skill does | `skills/open-code-review/SKILL.md` is a *driver*: it shells out to `ocr review --audience agent --background "…"` | the skills *are* the reviewers; there is no binary to drive |
| Where determinism sits | in **reviewing**: file selection, file bundling, rule matching, comment positioning, reflection | in **bounding and recording**: `review scope`, `review blast-radius`, `review tier`, `review ingest`, `review complete` |
| Host | own CLI, portable to any agent | whatever agent is executing the skills |

Neither is a subset of the other. They made the *review* deterministic and left
one agent to think; we left the *thinking* to many agents and made the
*perimeter* deterministic — what enters the round, what the round may look at,
and what the round is allowed to claim afterwards.

---

## 2. Where they are ahead of us

### 2.1 They have a benchmark. We do not.

AACR-Bench: **50 repositories, 200 real pull requests, 10 languages, 1,505
annotated ground-truth issues, cross-validated by 80+ senior engineers.** Claims
higher precision and F1 than a general-purpose agent on the same model, at
**~1/9 the tokens**, with recall deliberately traded away to suppress false
alarms.

Our equivalent is `scripts/review-precision-baseline.ts` over our own recorded
corpus — and the pipeline's own code says what that is worth: precision measured
over a corpus that logs only survivors "returns 100% by construction". We have
discipline about *recording* findings and no measurement of whether they are
*right*. That is the single widest gap in this comparison, and it is not a
tooling gap; it is a missing dataset.

### 2.2 Token cost is a design target for them and unbounded for us.

Their ~1/9 claim is an engineering goal with an architecture built for it: bundle
files, match rules, one agent, two rounds by default (`--effort medium`).

The round this repository ran on 2026-09-12 (flow 260, a 707-line diff) spent
roughly **450k subagent tokens across four reviewers plus a verifier**, then a
second verification round on top. That bought a real blocker — see §3.1 — but
nothing in our pipeline *budgets* it, warns about it, or reports cost per
finding. `review budget` exists as a command; no gate consults it.

### 2.3 Line-level positioning is an explicit, checked step for them.

They name the failure directly: AI review comments "frequently don't match the
actual code location, with line numbers or file references drifting off target",
and answer it with an independent **comment-positioning** module and a
**comment-reflection** module.

We have no such check. `review-finding.schema.json` requires `file` and `line`;
nothing verifies that the line still points at the code the finding describes. On
a fix round — where the file has moved under the finding by construction — that
is exactly when it is most likely to be wrong.

### 2.4 Distribution.

`action.yml` (GitHub Action), GitLab CI, GitFlic, Gerrit, a VSCode extension, a
Claude Code plugin, `install.sh`/`install.ps1`, an npm package. Our review
pipeline runs where `keryx` runs and nowhere else.

### 2.5 Path-scoped prose rules.

`.opencodereview/rule.json` is a list of `{path, rule, merge_system_rule}`. Their
own entry for `internal/llm/providers.go` is worth reading in full: it dictates
field order in a struct literal, forbids extracting single-use constants, lists
four documentation files that must change in the same PR, and names the exact
test function a new provider must add.

That is *project convention as data*, matched by path, merged into the prompt.
Our nearest equivalent is a repo-local convention reviewer — a whole skill, with
a whole dispatch — and we have **zero** of them registered. Theirs costs a JSON
object.

---

## 3. Where we are ahead of them

### 3.1 Adversarial verification by a different actor.

Their reflection module is the same pipeline checking its own comment. Ours is a
separate agent, forbidden from verifying a finding it raised, required to state
`method` (`execution` / `site-check` / `reasoning`) and `evidence`, where
`reasoning` forces the verdict `unverifiable`.

This is not theoretical. On 2026-09-12 a keryx fix shipped a guard that
suppressed a phone-number match whenever the surrounding token held any letter.
Every test passed. Two reviewers, working from different lenses, independently
constructed the inverse case — a real phone number beside a word — and showed the
detector had stopped redacting it. A precision-tuned single pass optimising for
"do not raise false alarms" is structurally unlikely to go looking for that: the
defect was invisible from the direction the author was facing, and only a
*second, differently-pointed* reader found it.

Their deliberate recall sacrifice is the right trade for the job they are
doing — reviewing hundreds of PRs a day at scale, where a false alarm costs a
human's attention. It is the wrong trade for ours.

### 3.2 The round is a durable record with a gate behind it.

A keryx round writes `manifest.json`, `scope.md`, `coverage.md`, `report.md`,
`findings.json`, `learning.md`, `decisions.md` under the flow, and the flow's
completion gate refuses to close while:

- a finding at or above `minor` has no terminal disposition;
- a disposition claims `acted-on` with no verifier verdict behind it;
- a verdict's evidence does not cite the commit being merged;
- the round ran against a stale SHA;
- external PR comments were never collected.

That gate refused flow 260 **twice**, correctly, and both refusals produced work
rather than an argument. `ocr session list` / `--resume` records sessions; it does
not gate anything on what the session found.

### 3.3 The drop list is part of the record.

`keryx review scope --json` reports what the pre-filter removed **and why, per
drop**, and `review ingest` refuses `--scope` input that carries only counts.
`blast-radius` reports every file the 40-file cap removed. The stated reason: a
scope that shrank without saying so reads afterwards as "we reviewed everything".
Their `--preview` shows which files *will* be reviewed; we could not find an
equivalent record of what was excluded and on what ground.

### 3.4 Scope B.

`review blast-radius` walks `gdgraph affected` outward from each changed file and
asks a different question — *did this change break something that was working* —
under rules that reject a finding which is merely an opinion about untouched
code. Their pipeline reviews the diff and the files it bundles with it.

---

## 4. What to take, concretely

1. **Build the benchmark.** Nothing else on this list matters as much. Without a
   labelled corpus we cannot tell a pipeline improvement from a prompt that got
   luckier. AACR-Bench's shape — real PRs, human-annotated ground truth, held
   out from the people tuning the reviewer — is the shape to copy.
2. **Add a positioning check.** Cheap version: on ingest, assert that the
   finding's `file` exists at the round's head and that `line` is within it;
   stronger version: that the line's text still contains the token the finding
   names. A finding that cannot be located is a finding nobody can act on.
3. **Adopt path-scoped rules as data.** A `rule.json`-shaped file, matched by
   path and merged into each reviewer's prompt, gives us per-file convention
   enforcement without inventing a skill per convention. It composes with the
   reviewer fan-out rather than replacing it.
4. **Make cost visible per round.** Record tokens spent and findings retained in
   `manifest.json`, and print cost-per-retained-finding at `review complete`.
   We cannot argue our fan-out is worth its price while refusing to name the
   price.
5. **Ship a GitHub Action.** The review pipeline is our most differentiated
   asset and it is reachable only from our own CLI.

## 5. What not to take

- **Their recall trade.** See §3.1.
- **One agent.** The fan-out is where the blocker came from.
- **Reflection as verification.** Self-check is a quality pass, not evidence.
  Keep the never-self-verify rule.

---

## 5a. Read against the code — four changes, with the lines they touch

Added after a second pass that read their Go packages and our corresponding
TypeScript rather than their README.

### A. Derive `line` from a quoted snippet; stop accepting it as a claim

**Theirs.** The model does not report a line number. It reports
`existing_code` — a snippet of the code the comment is about — and
`ResolveComment` (`internal/diff/resolver.go`) locates that snippet by text
match against the diff. The line is *derived*. Only when matching fails does
`internal/diff/relocation.go` spend a second LLM call asking for a more precise
snippet, and it reverts on failure:

```go
original := cm.ExistingCode
cm.ExistingCode = code
if ResolveComment(cm, d) { return true, resp }
cm.ExistingCode = original
```

They also carry `internal/diff/relocate_across_files_test.go` — drift across
file boundaries is a case they hit often enough to name.

**Ours.** `src/gdskills/contracts/review-finding.schema.json:102-103`:

```json
"file": { "type": ["string", "null"] },
"line": { "type": ["integer", "null"], "minimum": 1 },
```

Both are asserted by the model, both nullable, and nothing in `review ingest`
checks either against the tree at the round's head. On a fix round the file has
moved under the finding *by construction*, which is exactly when the anchor is
least trustworthy and most consequential.

**Change.** Require the finding to quote the code it is about, locate that quote
at the round's head, and derive `line` from the match. A finding whose quote
cannot be found is recorded as `unlocatable` rather than silently carrying a
number that points at something else. This is the single highest-value item on
the list: it converts a claim into a derived fact, and it needs no model call in
the common case.

### B. Repair mechanical malformation, with an acceptance test

**Theirs.** `internal/tool/comment_args_repair.go` — 9.6 KB of code against
25.6 KB of tests — repairs one specific failure: the model serialised an array
as a string and under-escaped the quotes inside prose, "so the batch fails to
parse and every comment is lost". Crucially the repair is *gated*: the result
must contain only fields the schema defines, and the count of `"content":`
occurrences must match the original, because "a `"content":` inside prose
inflates the count and so makes the check stricter, which is the safe
direction."

**Ours.** `review ingest` refuses and the round is lost until the report is
re-emitted. On 2026-09-12 that cost three consecutive refusals on one round —
missing `id`, then missing `problem`, then missing `class_scope` — each a
mechanical omission, none of them a judgement the pipeline could not have made
itself. The first refusal is worth quoting because it names the cost: *"Refusing
to record two findings under one key: …#undefined claimed by 5 findings."*

**Change.** A bounded repair pass in front of ingest for omissions that are
mechanical only: assign `F-00N` by report order when `id` is absent, derive
`problem` from `title`. Gate it the way they gate theirs — accept the repair
only if the result validates and introduces no field the schema does not define.
Keep refusing everything judgemental: `class_scope`, evidence, dispositions. A
gate that refuses a missing *argument* teaches nothing; a gate that refuses a
missing *claim* teaches a lot.

Related: `internal/agent/identity.go` plus `retry_identity_test.go` in three
separate packages. They derive a stable identity so a retried request does not
duplicate findings. We have no derivation at all — hence `#undefined`.

### C. Estimate before spending, and record what was spent

**Theirs.** `internal/agent/estimate.go`, `internal/agent/budget_test.go`,
`internal/scan/budget_exceeded_test.go`, `internal/agent/preview.go`, and
`internal/llmloop/compression.go` — estimate, budget, preview and in-loop
context compression are all first-class, tested concerns.

**Ours.** `keryx review budget` prints, today, on this repository:

```
spend_ceiling: 3 USD
spent: not recorded
spend_status: not-recorded
  `not recorded` is not `under`: nobody reported a spend, so staying inside
  the ceiling was never demonstrated.
```

The command is honest about being uninformed, which is the right shape — but
nothing feeds it, and a search for `estimateTokens|tokenEstimate|estimateCost`
across `src/review/` and `src/commands/review.ts` returns nothing.

**Change.** Three small pieces: estimate prompt tokens from the scoped diff and
print a per-reviewer projection before dispatch; record actual usage into the
round's `manifest.json` at ingest; have `review complete` print cost per
retained finding. We cannot argue the fan-out earns its price while declining to
name the price — and §2.2's 450k-token round is the argument we currently
cannot make.

### D. (Optional) Deterministic grouping of related files

`internal/agent/grouping.go` — 14 KB against 26.8 KB of tests — bundles related
files into one review unit so a paired change (their example:
`message_en.properties` beside `message_zh.properties`) is seen whole by one
reviewer. Our `review scope` bounds and drops but never groups; every reviewer
receives the same flat scoped diff.

Listed last because it fits us least: we fan out by *domain*, not by file, so a
paired change already reaches every reviewer. It becomes worth doing only if we
ever shard by file.

## 6. Honest limits of this analysis

- No head-to-head run on the same diff. The strongest next step would be to run
  `ocr` over flow 260's `dd7f3df0` and see whether it finds the blocker our
  round found.
- Their benchmark numbers are claims from the README; the table is not published
  there and we did not reproduce it.
- We read their architecture from the README, `skills/open-code-review/SKILL.md`,
  `.opencodereview/rule.json`, `ASSURANCE_CASE.md` and the `internal/` package
  layout, not from their Go source.
- One thing we did not evaluate at all: they publish a full **security assurance
  case** with a threat model that treats git diffs as semi-trusted adversarial
  content and names DNS rebinding against their local viewer. Our security module
  detects injection in tool output; whether we have an equivalent *document* is a
  separate question this report did not open.
