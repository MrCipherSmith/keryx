# Flow 209 — the review round

Eleven regressions from the 2026-08-31 measurement, plus four the fixing uncovered —
including one the measurement itself recorded as already fixed.

```json keryx:findings
[
  {
    "id": "r209-01",
    "reviewer": "review-core-boundaries",
    "severity": "blocker",
    "file": "src/gdskills/bundled-eval.ts",
    "line": 482,
    "scope": "diff",
    "problem": "keryx skills verify --bundled returned 0 skills from an installed copy: the root resolved to dist/bundled while the tree ships at src/gdskills/bundled.",
    "impact": "A mechanism that measured nothing, a claim nothing enforced, or a name that resolved nowhere.",
    "suggested_fix": "Wire it or delete the claim; prove each fix with a mutation.",
    "evidence": "Found by the 2026-08-31 measurement, or by the guards written to fix it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 9ef30c6f (PR #417). Twelve mutations across the two halves, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        "src/gdskills/bundled-eval.ts"
      ],
      "enumeration_method": "Enrolment computed from the filesystem; the catalogue guard scans both skill and rule trees including harness builds."
    }
  },
  {
    "id": "r209-02",
    "reviewer": "review-core-boundaries",
    "severity": "major",
    "file": "src/gdskills/build-parity.test.ts",
    "line": 1,
    "scope": "diff",
    "problem": "Build parity was enforced on 1 skill of 37; 36 diverged, and the harness builds were stale ancestors of their own SKILL.md.",
    "impact": "A mechanism that measured nothing, a claim nothing enforced, or a name that resolved nowhere.",
    "suggested_fix": "Wire it or delete the claim; prove each fix with a mutation.",
    "evidence": "Found by the 2026-08-31 measurement, or by the guards written to fix it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 9ef30c6f (PR #417). Twelve mutations across the two halves, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        "src/gdskills/build-parity.test.ts"
      ],
      "enumeration_method": "Enrolment computed from the filesystem; the catalogue guard scans both skill and rule trees including harness builds."
    }
  },
  {
    "id": "r209-03",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/gdskills/bundled/skills/orchestration/task-implementer",
    "line": 1,
    "scope": "diff",
    "problem": "Four of five builds omitted the reporting contract while production code throws unless a child's first line is STATUS: <TOKEN>.",
    "impact": "A mechanism that measured nothing, a claim nothing enforced, or a name that resolved nowhere.",
    "suggested_fix": "Wire it or delete the claim; prove each fix with a mutation.",
    "evidence": "Found by the 2026-08-31 measurement, or by the guards written to fix it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 9ef30c6f (PR #417). Twelve mutations across the two halves, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/orchestration/task-implementer"
      ],
      "enumeration_method": "Enrolment computed from the filesystem; the catalogue guard scans both skill and rule trees including harness builds."
    }
  },
  {
    "id": "r209-04",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/commands/providers.ts",
    "line": 598,
    "scope": "diff",
    "problem": "cross_family_review shipped with no consumer, in the commit whose own AC3 forbids fields nothing reads.",
    "impact": "A mechanism that measured nothing, a claim nothing enforced, or a name that resolved nowhere.",
    "suggested_fix": "Wire it or delete the claim; prove each fix with a mutation.",
    "evidence": "Found by the 2026-08-31 measurement, or by the guards written to fix it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 9ef30c6f (PR #417). Twelve mutations across the two halves, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        "src/commands/providers.ts"
      ],
      "enumeration_method": "Enrolment computed from the filesystem; the catalogue guard scans both skill and rule trees including harness builds."
    }
  },
  {
    "id": "r209-05",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/job/plans.ts",
    "line": 22,
    "scope": "diff",
    "problem": "The dangling agent label code-review lived in code as well as prose, writing an unresolvable name into every implement job on disk.",
    "impact": "A mechanism that measured nothing, a claim nothing enforced, or a name that resolved nowhere.",
    "suggested_fix": "Wire it or delete the claim; prove each fix with a mutation.",
    "evidence": "Found by the 2026-08-31 measurement, or by the guards written to fix it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 9ef30c6f (PR #417). Twelve mutations across the two halves, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        "src/job/plans.ts"
      ],
      "enumeration_method": "Enrolment computed from the filesystem; the catalogue guard scans both skill and rule trees including harness builds."
    }
  },
  {
    "id": "r209-06",
    "reviewer": "review-regression",
    "severity": "major",
    "file": "src/gdskills/bundled/skills",
    "line": 1,
    "scope": "diff",
    "problem": "subagent_type: general \u2014 a value no dispatcher accepts \u2014 was live in twelve files across both trees, in a class the 2026-08-31 measurement had recorded as fixed.",
    "impact": "A mechanism that measured nothing, a claim nothing enforced, or a name that resolved nowhere.",
    "suggested_fix": "Wire it or delete the claim; prove each fix with a mutation.",
    "evidence": "Found by the 2026-08-31 measurement, or by the guards written to fix it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 9ef30c6f (PR #417). Twelve mutations across the two halves, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills"
      ],
      "enumeration_method": "Enrolment computed from the filesystem; the catalogue guard scans both skill and rule trees including harness builds."
    }
  },
  {
    "id": "r209-07",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/review/loop.ts",
    "line": 1,
    "scope": "diff",
    "problem": "Loop detection could never fire: finding identity was led by a per-round global_id, and the date-keyed review id let a second same-day round overwrite the first.",
    "impact": "A mechanism that measured nothing, a claim nothing enforced, or a name that resolved nowhere.",
    "suggested_fix": "Wire it or delete the claim; prove each fix with a mutation.",
    "evidence": "Found by the 2026-08-31 measurement, or by the guards written to fix it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 9ef30c6f (PR #417). Twelve mutations across the two halves, each observed red and restored."
    },
    "class_scope": {
      "sites": [
        "src/review/loop.ts"
      ],
      "enumeration_method": "Enrolment computed from the filesystem; the catalogue guard scans both skill and rule trees including harness builds."
    }
  },
  {
    "id": "r209-08",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/flow/machine.ts",
    "line": 1,
    "scope": "diff",
    "problem": "dependsOn and attempts.count were written and read by nothing \u2014 the fourth sighting of that shape.",
    "impact": "A mechanism that measured nothing, a claim nothing enforced, or a name that resolved nowhere.",
    "suggested_fix": "Wire it or delete the claim; prove each fix with a mutation.",
    "evidence": "Found by the 2026-08-31 measurement, or by the guards written to fix it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 9ef30c6f (PR #417). Twelve mutations across the two halves, each observed red and restored."
    }
  },
  {
    "id": "r209-09",
    "reviewer": "review-core-boundaries",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills",
    "line": 1,
    "scope": "diff",
    "problem": "Nine SKILL.claude.md files shipped in 0.2.72 that no runtime addresses.",
    "impact": "A mechanism that measured nothing, a claim nothing enforced, or a name that resolved nowhere.",
    "suggested_fix": "Wire it or delete the claim; prove each fix with a mutation.",
    "evidence": "Found by the 2026-08-31 measurement, or by the guards written to fix it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 9ef30c6f (PR #417). Twelve mutations across the two halves, each observed red and restored."
    }
  },
  {
    "id": "r209-10",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md",
    "line": 538,
    "scope": "diff",
    "problem": "A false sentence claimed the schema rejects a dispatch missing prior_findings; nothing loads that schema.",
    "impact": "A mechanism that measured nothing, a claim nothing enforced, or a name that resolved nowhere.",
    "suggested_fix": "Wire it or delete the claim; prove each fix with a mutation.",
    "evidence": "Found by the 2026-08-31 measurement, or by the guards written to fix it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 9ef30c6f (PR #417). Twelve mutations across the two halves, each observed red and restored."
    }
  },
  {
    "id": "r209-11",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "docs/requirements/keryx-orchestrator-hardening/README.md",
    "line": 1,
    "scope": "diff",
    "problem": "The status block still claimed only phases 0 and 1 were delivered.",
    "impact": "A mechanism that measured nothing, a claim nothing enforced, or a name that resolved nowhere.",
    "suggested_fix": "Wire it or delete the claim; prove each fix with a mutation.",
    "evidence": "Found by the 2026-08-31 measurement, or by the guards written to fix it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 9ef30c6f (PR #417). Twelve mutations across the two halves, each observed red and restored."
    }
  }
]
```
