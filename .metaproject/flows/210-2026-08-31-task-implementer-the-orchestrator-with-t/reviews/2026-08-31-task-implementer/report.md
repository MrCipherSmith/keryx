# Flow 210 — the review round

The fourth orchestrator, measured and then fixed. 7 wired of 109 becomes 55,
and a data-loss hazard the audit named was fixed rather than carried.

```json keryx:findings
[
  {
    "id": "ti-01",
    "reviewer": "review-core-boundaries",
    "severity": "blocker",
    "file": "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md",
    "line": 397,
    "scope": "diff",
    "problem": "Every build instructed the implementer to run `git reset --hard` on fatal failure, while job-orchestrator dispatches implementers in parallel waves sharing one worktree \u2014 destroying a wave-mate's uncommitted work.",
    "impact": "A documented guarantee nothing enforced, or an instruction whose blast radius exceeded the agent's ownership.",
    "suggested_fix": "Wire the mechanism or delete the claim; scope the destructive command to the agent's own files.",
    "evidence": "Enumerated in inventory.md with the search that classified each row.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 67b2f536 / e4692960 (PR #418). Thirteen mutations, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/orchestration/task-implementer/SKILL.md"
      ],
      "enumeration_method": "Full inventory of all 109 documented mechanisms; the destructive-git guard sweeps every shipped document with a non-empty denominator assertion."
    }
  },
  {
    "id": "ti-02",
    "reviewer": "review-core-boundaries",
    "severity": "major",
    "file": "src/gdskills/bundled/skills/orchestration/task-implementer",
    "line": 1,
    "scope": "diff",
    "problem": "102 of 109 documented mechanisms were prose or advisory; only 7 were reachable from production code, the worst ratio of the four orchestrators.",
    "impact": "A documented guarantee nothing enforced, or an instruction whose blast radius exceeded the agent's ownership.",
    "suggested_fix": "Wire the mechanism or delete the claim; scope the destructive command to the agent's own files.",
    "evidence": "Enumerated in inventory.md with the search that classified each row.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 67b2f536 / e4692960 (PR #418). Thirteen mutations, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/orchestration/task-implementer"
      ],
      "enumeration_method": "Full inventory of all 109 documented mechanisms; the destructive-git guard sweeps every shipped document with a non-empty denominator assertion."
    }
  },
  {
    "id": "ti-03",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/gdskills/contracts.ts",
    "line": 1,
    "scope": "diff",
    "problem": "Both contract schemas declared minItems and maximum while the hand-rolled validator silently ignored them, so registering them would have enforced less than the schema claims.",
    "impact": "A documented guarantee nothing enforced, or an instruction whose blast radius exceeded the agent's ownership.",
    "suggested_fix": "Wire the mechanism or delete the claim; scope the destructive command to the agent's own files.",
    "evidence": "Enumerated in inventory.md with the search that classified each row.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 67b2f536 / e4692960 (PR #418). Thirteen mutations, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        "src/gdskills/contracts.ts"
      ],
      "enumeration_method": "Full inventory of all 109 documented mechanisms; the destructive-git guard sweeps every shipped document with a non-empty denominator assertion."
    }
  },
  {
    "id": "ti-04",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/gdskills/bundled/skills/orchestration/task-implementer/output-contract.schema.json",
    "line": 1,
    "scope": "diff",
    "problem": "The output contract was additionalProperties: false while refusing skill_drift, the field its own skill is instructed to emit.",
    "impact": "A documented guarantee nothing enforced, or an instruction whose blast radius exceeded the agent's ownership.",
    "suggested_fix": "Wire the mechanism or delete the claim; scope the destructive command to the agent's own files.",
    "evidence": "Enumerated in inventory.md with the search that classified each row.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 67b2f536 / e4692960 (PR #418). Thirteen mutations, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/orchestration/task-implementer/output-contract.schema.json"
      ],
      "enumeration_method": "Full inventory of all 109 documented mechanisms; the destructive-git guard sweeps every shipped document with a non-empty denominator assertion."
    }
  },
  {
    "id": "ti-05",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "docs/requirements/keryx-orchestrator-hardening/measurement-2026-08-31.md",
    "line": 1,
    "scope": "diff",
    "problem": "The measurement recorded 2 wired of 88; the reproduction is 7 of 109. It credited only the STATUS: contract, counted twice, and never enumerated task-request.template.md.",
    "impact": "A documented guarantee nothing enforced, or an instruction whose blast radius exceeded the agent's ownership.",
    "suggested_fix": "Wire the mechanism or delete the claim; scope the destructive command to the agent's own files.",
    "evidence": "Enumerated in inventory.md with the search that classified each row.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 67b2f536 / e4692960 (PR #418). Thirteen mutations, each observed red and restored."
    }
  }
]
```
