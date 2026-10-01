# Review round 2 (verifier-only) — flow 357, PR #788

- Round ref: `c623d5c8b6a6e39439fc1f64c887f7c9ae591d29..aa3973c3ed1da505ced9a99c100190b72820a89e` (PR #788 head).
- Round 1 (`2026-09-28-ingest-c623d5c8b6a6e39439fc1f64c887f7c9ae591d29`) raised F-001. It was fixed in
  `77bc5e79`; the CI test fix `aa3973c3` followed. This round re-reports F-001 under its original
  `global_id` with the verifier's `refuted` verdict.
- verification_mode: `filter`

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "flow357-pr788-review",
    "severity": "minor",
    "problem": "DENIED_CAUSE_MARKERS was one flat, agent-unscoped regex list; the PR added two loose markers written for antigravity-cli's wording that also applied to codex-cli and claude-cli failures.",
    "impact": "A codex-cli or claude-cli failure whose vendor text contained 'waiting for approval' style wording would have been labelled Denied instead of Error.",
    "suggested_fix": "Match only antigravity's own exact tag and add a cross-agent regression test.",
    "evidence": "Original finding, round 1 (2026-09-28-ingest-c623d5c8b6a6e39439fc1f64c887f7c9ae591d29). Re-verified against PR head aa3973c3: the two loose regexes are gone, replaced by the single exact tag /\\(blocked on approval\\)/ that only the antigravity codec emits (codec/antigravity-cli.ts lines 254 and 303); a codex turn.failed mentioning 'waiting for approval' stays Error (antigravity-cli.runtime.test.ts).",
    "confidence": "high",
    "file": "src/harness/external/runtime.ts",
    "line": 188,
    "quote": "/waiting (for|on) .*(approval|permission)/i,\n/blocked (on|waiting) .*(approval|permission)/i,",
    "class_scope": {
      "sites": [
        "src/harness/external/runtime.ts DENIED_CAUSE_MARKERS",
        "src/harness/external/codec/antigravity-cli.ts classifyAntigravityFailure / parseResultEvent (the only emitters of the tag)"
      ],
      "enumeration_method": "keryx ctx rg for 'blocked on approval' across src/harness/external/: the tag appears only in the antigravity codec and the one marker in runtime.ts."
    },
    "reviewer_note": "re-reported for round-2 re-verification of the fix; content unchanged from round 1.",
    "global_id": "2026-09-28-ingest-c623d5c8b6a6e39439fc1f64c887f7c9ae591d29#F-001"
  }
]
```
