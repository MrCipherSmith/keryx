# Review pipeline: derive the finding's line from a quoted snippet, repair mechanical malformation, price the round

Status: draft
Source: `docs/analysis/review-pipeline/2026-09-15/report.md` — four gaps in the
review pipeline, each confirmed against our own code and our own records.

## Problem

Four gaps in the review pipeline, each confirmed against our own code rather
than inferred.

### A — `line` is a claim nobody checks

`src/gdskills/contracts/review-finding.schema.json:102-103`:

```json
"file": { "type": ["string", "null"] },
"line": { "type": ["integer", "null"], "minimum": 1 },
```

Both are asserted by the reviewer and nullable, and `keryx review ingest`
verifies neither against the tree at the round's head. On a fix round the file
has moved under the finding **by construction** — which is exactly when the
anchor is least trustworthy and most consequential.

The shape to copy is a pipeline that never asks the model for a line number at
all. The model quotes the code it is talking about; the pipeline locates that
quote by text match and the line is **derived**. A second, more expensive
resolution pass is worth spending only when the match fails, and it reverts when
the retry does not resolve either. Drift across file boundaries is a case common
enough to be worth naming in its own test.

### B — a mechanical omission kills the round

`keryx review ingest` refuses and the round is lost until the report is
re-emitted. On 2026-09-12 that cost three consecutive refusals on one round —
missing `id`, then missing `problem`, then missing `class_scope`. The first read:

> Refusing to record two findings under one key: …#undefined claimed by 5 findings.

The first two are mechanical: the pipeline had everything it needed to fill them
in. The shape worth copying is a repair with an ACCEPTANCE CHECK: the result
must introduce no field the schema does not define and must preserve the object
count, so a repair that overreaches is refused rather than recorded. A stable
identity derived from the report's own ordering is the other half — we derive
nothing today, which is why the key was `#undefined`.

### C — the round has no price

`keryx review budget` on this repository today:

```
spend_ceiling: 3 USD
spent: not recorded
spend_status: not-recorded
  `not recorded` is not `under`: nobody reported a spend, so staying inside
  the ceiling was never demonstrated.
```

The command is honest about being uninformed and nothing feeds it. A search for
`estimateTokens|tokenEstimate|estimateCost` across `src/review/` and
`src/commands/review.ts` returns nothing. The flow-260 round spent roughly 450k
subagent tokens on a 707-line diff and found a blocker — a good trade we cannot
demonstrate, because the number lives nowhere.

### D — related files are never grouped

A file-sharded pipeline has to bundle related files into one review unit, so a
paired change is seen whole by one reviewer. `keryx review scope` bounds and
drops but never groups.

This one fits us least: we fan out by **domain**, not by file, so a paired change
already reaches every reviewer. It is in scope here to be **decided and
recorded**, not to be implemented on principle — see AC6.

## Expected Outcome

A round whose findings carry anchors somebody verified, which does not die on a
forgotten `id`, and whose cost is visible before it is spent and recorded after.

## Where the work lands

The division is the one the pipeline already implies: **a skill instructs, the
CLI enforces.** `review-orchestrator/SKILL.md` says so against itself —
"Nothing refuses a dispatch that omits them … this is a requirement on you,
unenforced". So the enforcement for every item below goes into `keryx review`,
and the skills change only where the reviewer needs to be told what to produce.

| | schema | CLI (enforces) | skills (instruct) |
|---|---|---|---|
| A | quote field | `ingest` locates, derives `line`, marks `unlocatable` | output contract: quote the code, do not name a line |
| B | — | `ingest` repair pass ahead of validation | — |
| C | — | `scope` estimates · `ingest` records · `complete` prices | Step 6 prints the projection beside `review tier` |
| D | — | `scope` (grouping), if AC6 decides for it | — |

## Out of Scope

- The benchmark (report §2.1). It is the widest gap and it is a dataset, not a
  pipeline change; it deserves its own flow.
- A GitHub Action (report §4.5).
- Path-scoped prose rules (report §2.5) — worth doing, separable, own flow.
- Any change to what the completion gate refuses on substance: `class_scope`,
  evidence, verifier verdicts and SHA freshness stay exactly as strict.
