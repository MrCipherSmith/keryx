# Review round 2 — PR #692 (structured)

Source: review-r2.md

```keryx:findings
[
 {
  "id": "R2-1",
  "severity": "major",
  "file": ".metaproject/flows/314-2026-09-24-wave-4-batch-1-stack-packs-and-agent-pai/acceptance-criteria.md",
  "line": 15,
  "problem": "AC3/AC5/AC11 text was never rewritten (the stale global keryx binary ignored --criterion/--text); the criteria still claim stable packs, a llama3.1 gate and eight agents.",
  "impact": "The flow gate would require confirming false criteria.",
  "evidence": "grep deepseek acceptance-criteria.md = 0; ac-updated history events carry reasons only",
  "suggested_fix": "Rewrite with --criterion/--text through the local CLI.",
  "class_scope": {
   "sites": [
    "AC3",
    "AC5",
    "AC11",
    "description.md",
    "plan.md"
   ],
   "enumeration_method": "flow.json ac-updated history, acceptance-criteria.md git log, grep of the flow package"
  },
  "reviewer": "review-orchestrator",
  "confidence": "high"
 },
 {
  "id": "R2-2",
  "severity": "minor",
  "file": "docs/requirements/keryx-agent-platform-expansion/workstreams/W1-stack-catalog.md",
  "line": 596,
  "problem": "react-testing mock-network-boundary 0.6 is not listed as failing; cli-reference gives the wrong --scope default; wording says 're-runs'.",
  "impact": "Docs misreport the outcome.",
  "evidence": "react-floor.ts",
  "suggested_fix": "Correct W1, the react agent-refs note and cli-reference.",
  "reviewer": "review-orchestrator",
  "confidence": "high"
 },
 {
  "id": "R2-3",
  "severity": "minor",
  "file": "src/commands/agents-catalog.ts",
  "line": 552,
  "problem": "generate writes the auditor before checking the fixer target, so it can leave a half-written pair.",
  "impact": "Partial output on refusal.",
  "evidence": "gen-escape2.ts symlinked fixer case",
  "suggested_fix": "Validate both targets first, then write; add a test.",
  "reviewer": "review-orchestrator",
  "confidence": "high"
 },
 {
  "id": "R2-4",
  "severity": "minor",
  "file": "src/agents/generate.test.ts",
  "line": 236,
  "problem": "The real-tree test is vacuous with zero gate-cleared packs; stale NOTE.",
  "impact": "Test asserts nothing.",
  "evidence": "gateCleared empty",
  "suggested_fix": "Assert the shipped state explicitly, add a fixture positive, drop the NOTE.",
  "reviewer": "review-orchestrator",
  "confidence": "high"
 },
 {
  "id": "R2-5",
  "severity": "minor",
  "file": "src/commands/skills-governance.test.ts",
  "line": 293,
  "problem": "The no-credential test does not clear ANTHROPIC_API_KEY; the integrity test header carries a scratchpad path and session context.",
  "impact": "Env-dependent test, misleading header.",
  "evidence": "test-preload.ts does not isolate provider env",
  "suggested_fix": "Clear and restore the env var; clean the header.",
  "reviewer": "review-orchestrator",
  "confidence": "high"
 },
 {
  "id": "R2-6",
  "severity": "info",
  "file": "src/gdskills/governance/eval.ts",
  "line": 858,
  "problem": "The gate does not pin provider/model; the digest covers only the skill's own files; there is no guard that anti-patterns stay named.",
  "impact": "Follow-up scope for grader reliability.",
  "evidence": "gate2.ts forged provenance passes",
  "suggested_fix": "Grader-reliability follow-up flow.",
  "reviewer": "review-orchestrator",
  "confidence": "high"
 }
]
```
