# PR #790 review (flow358-pr790-review)

No blockers. Three findings above info; all three were fixed in 0841fe8b.

```json keryx:findings
[
 {
  "id": "F-001",
  "reviewer": "flow358-pr790-review",
  "severity": "minor",
  "problem": "Dated model ids get no version: in claude-sonnet-4-20250514 the tokens 4 and 20250514 merge into one group that the all-short-digits check rejects.",
  "impact": "Generation ordering silently does not apply to dated Anthropic ids, the main real-world case.",
  "suggested_fix": "Drop a trailing date-like token (6 or 8 digits) before grouping.",
  "evidence": "Probe on the PR branch: parseModelVersion returned undefined for claude-sonnet-4-20250514, claude-sonnet-4-5-20250929, claude-opus-4-1-20250805 and claude-3-5-haiku-20241022.",
  "confidence": "medium",
  "file": "src/gdskills/model-version.ts",
  "line": 175,
  "quote": "if (!tokens.every((t) => SHORT_DIGITS_TOKEN.test(t))) return undefined;",
  "class_scope": {
   "sites": [
    "src/gdskills/model-version.ts:parseModelVersion",
    "src/harness/routing/derive-default-table.ts:compareStrengthById"
   ],
   "enumeration_method": "read the module and its consumers in full"
  }
 },
 {
  "id": "F-002",
  "reviewer": "flow358-pr790-review",
  "severity": "minor",
  "problem": "The 20 s timeout only stops waiting: no AbortSignal reaches runModelTurn, and no baseUrl is passed.",
  "impact": "A slow provider finishes a billed call whose answer is discarded; a provider baseUrl override is ignored.",
  "suggested_fix": "Create an AbortController per call, pass signal and baseUrl into run(), abort on timeout.",
  "evidence": "tier-rank-agent.ts run() call passed neither signal nor baseUrl; withTimeout in model-tier.ts only cleared its timer.",
  "confidence": "medium",
  "file": "src/harness/routing/tier-rank-agent.ts",
  "line": 165,
  "quote": "const result = await run({",
  "class_scope": {
   "sites": [
    "src/harness/routing/tier-rank-agent.ts:createTierRankAgent",
    "src/gdskills/model-tier.ts:withTimeout"
   ],
   "enumeration_method": "read the module and its consumers in full"
  }
 },
 {
  "id": "F-003",
  "reviewer": "flow358-pr790-review",
  "severity": "major",
  "problem": "The failure memo covers only a thrown error: rejected answers are never memoised, there is no in-flight dedupe, and the candidate list is uncapped against a 512-token output cap.",
  "impact": "Every refused or ambiguous spawn pays another call; concurrent spawns all pay; a large catalogue truncates the answer.",
  "suggested_fix": "Share the in-flight promise per catalogue key, memoise unusable outcomes, cap candidates.",
  "evidence": "failures.set was reachable only from the catch block; buildRankPrompt listed every candidate.",
  "confidence": "medium",
  "file": "src/harness/routing/tier-rank-agent.ts",
  "line": 188,
  "quote": "failures.set(key, { at: now(), message",
  "class_scope": {
   "sites": [
    "src/harness/routing/tier-rank-agent.ts:createTierRankAgent",
    "src/gdskills/model-tier.ts:buildRankPrompt"
   ],
   "enumeration_method": "read the module and its consumers in full"
  }
 }
]
```
