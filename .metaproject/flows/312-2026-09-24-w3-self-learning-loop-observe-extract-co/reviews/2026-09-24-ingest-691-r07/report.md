# PR #691 verification at 50644f34 (opus) — R9

R8-F1..F4 closed.

```json keryx:findings
[
{"id":"R9-F1","severity":"minor","title":"Apply-time token re-check refuses the fixed fallback name learned-<domain>","file":"src/learning/graduate.ts","line":730,"detail":"extraTokens splits suggestedName; the fallback learned-<domain> tokens collide with login pieces (alice-review → 'review').","class_scope":{"sites":["graduate.ts:313","graduate.ts:723-739","reviewer-id.ts:282"],"enumeration_method":"every extraTokens source traced; r14/p.ts RC_NOKW"},"impact":"Clean graduation permanently refused.","suggested_fix":"Do not re-check stored tokens; recompute name/summary from members with current logins at apply time.","evidence":"r14/p.ts RC_NOKW alice-review REFUSED","confidence":"high"},
{"id":"R9-F2","severity":"minor","title":"extraTokens re-check refuses ordinary keywords equal to a login piece, incl. non-review clusters","file":"src/learning/reviewer-id.ts","line":282,"detail":"Login configured after runGraduate: alice-review refuses 'review', code-bot refuses 'code', edit refuses a reverted-edit cluster.","class_scope":{"sites":["reviewer-id.ts:281-286","graduate.ts:723-739"],"enumeration_method":"r14/p.ts + q.ts login × cluster matrix"},"impact":"Clean graduations refused.","suggested_fix":"Recompute topKeywords/suggestedName from members with current logins at apply; use the recomputed values for the agent.","evidence":"r14/p.ts RC_REVIEW, CS_CODE; q.ts REVERTED_EDIT after → REFUSED","confidence":"high"},
{"id":"R9-F3","severity":"info","title":"60-char slug cut can split a glued login into a standalone id segment","file":"src/learning/extract.ts","line":107,"detail":"Slugging the full trigger then truncating cuts 'alicestyle' to 'alice'.","class_scope":{"sites":["extract.ts:102-117"],"enumeration_method":"values derived from trigger/action persisted outside text fields; r14/t.ts"},"impact":"Narrow login fragment in ids.","suggested_fix":"Slug the prefix-stripped hint and cut at a word boundary.","evidence":"r14/t.ts id ends '-abc-alice-5199172c'","confidence":"medium"}
]
```
