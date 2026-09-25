# PR #691 head round at 3953e040 (merged as 08af367c)

The PR head 3953e040 differs from the last verified code head c4aa5867 (T29) only in `.metaproject/flows/312-…` files. `git diff --name-only c4aa5867 3953e040` lists flow files only, and src/ and docs/ are identical between 3953e040 and the squash commit 08af367c.

The code-level verification is round r08 (R10, opus, read-only, one bypass attempt per sink). This round restates the two findings still open at the head, so that each carries a disposition naming the human decision. The owner merged W3 as an explicit exception; these findings are deferred to a follow-up flow. R10-F3 and R10-F4 (info) are not carried.

```json keryx:findings
[
{"id":"R10-F1","severity":"minor","title":"Stale skill/rule graduation proposals are never re-checked against later-configured logins; graduate apply echoes their nextSteps","file":"src/learning/graduate.ts","line":439,"detail":"runGraduate skips already-proposed ids before the login gate; applyGraduation for skill/rule targets prints stored nextSteps.","class_scope":{"sites":["graduate.ts:437-441","graduate.ts:676-681"],"enumeration_method":"carried from round r08 (R10); code unchanged since c4aa5867"},"impact":"A later-configured login survives in proposal files and the suggested scout command.","suggested_fix":"Re-gate and recompute already-proposed proposals on rerun; recompute nextSteps from members at apply.","evidence":"scratchpad/r691/r16/b.ts SINK 4 (round r08)","confidence":"high"},
{"id":"R10-F2","severity":"minor","title":"Model-backed draft metadata (extractor label, evidence sourceRef) persisted without a login gate","file":"src/learning/extract.ts","line":353,"detail":"gateReviewerText checks only trigger/action; model-backed drafts supply their own extractor label and sourceRef.","class_scope":{"sites":["extract.ts:329","extract.ts:349","extract.ts:353"],"enumeration_method":"carried from round r08 (R10); code unchanged since c4aa5867"},"impact":"A model-backed extractor could write a login into stored metadata (no in-tree implementation ships).","suggested_fix":"Fixed label for model-backed drafts; gate or shape-check sourceRef.","evidence":"scratchpad/r691/r16/c.ts (round r08)","confidence":"medium"}
]
```
