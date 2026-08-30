# Dynamic local reviewer — the review round

Keryx ships the mechanism and no people. Findings are the defects this flow removed,
including one the flow's own guard caught in CI after the rebase.

```json keryx:findings
[
  {
    "id": "dyn-01",
    "reviewer": "review-core-boundaries",
    "severity": "blocker",
    "file": "src/gdskills/bundled/skills/review/code-learned-review/SKILL.md",
    "line": 1,
    "scope": "diff",
    "problem": "The shipped reviewer and its profile carried one specific person's review style \u2014 team conventions and that reviewer's own speech markers \u2014 in a public repository.",
    "impact": "Published user-specific knowledge, or a mechanism claimed without a wire.",
    "suggested_fix": "Ship the mechanism, not the person; wire or delete.",
    "evidence": "Established by enumeration over the bundled tree and by running the loop end to end.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in ff9dd071 / 1014f292 (PR #415), each pinned by a test proved to bite."
    },
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/review/code-learned-review/SKILL.md"
      ],
      "enumeration_method": "bundled-no-persona.test.ts sweeps the whole bundled tree for the persona word and home-directory paths, with a non-vacuity assertion."
    }
  },
  {
    "id": "dyn-02",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/review/pr-comments.ts",
    "line": 1,
    "scope": "diff",
    "problem": "The durable comment record stored author, url and timestamps but not comment bodies, so the configured join had nothing to learn from and would have had to re-fetch.",
    "impact": "Published user-specific knowledge, or a mechanism claimed without a wire.",
    "suggested_fix": "Ship the mechanism, not the person; wire or delete.",
    "evidence": "Established by enumeration over the bundled tree and by running the loop end to end.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in ff9dd071 / 1014f292 (PR #415), each pinned by a test proved to bite."
    },
    "class_scope": {
      "sites": [
        "src/review/pr-comments.ts"
      ],
      "enumeration_method": "bundled-no-persona.test.ts sweeps the whole bundled tree for the persona word and home-directory paths, with a non-vacuity assertion."
    }
  },
  {
    "id": "dyn-03",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/gdskills/bundled/skills/review/review-strict-profile.mdc",
    "line": 1,
    "scope": "diff",
    "problem": "A second orphaned copy of the same persona shipped in review-strict-profile.mdc.",
    "impact": "Published user-specific knowledge, or a mechanism claimed without a wire.",
    "suggested_fix": "Ship the mechanism, not the person; wire or delete.",
    "evidence": "Established by enumeration over the bundled tree and by running the loop end to end.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in ff9dd071 / 1014f292 (PR #415), each pinned by a test proved to bite."
    },
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/review/review-strict-profile.mdc"
      ],
      "enumeration_method": "bundled-no-persona.test.ts sweeps the whole bundled tree for the persona word and home-directory paths, with a non-vacuity assertion."
    }
  },
  {
    "id": "dyn-04",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/gdskills/learn.ts",
    "line": 1,
    "scope": "diff",
    "problem": "Nothing named src/gdskills/bundled as a rejected target, so containment of learned content was enforced but unproven.",
    "impact": "Published user-specific knowledge, or a mechanism claimed without a wire.",
    "suggested_fix": "Ship the mechanism, not the person; wire or delete.",
    "evidence": "Established by enumeration over the bundled tree and by running the loop end to end.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in ff9dd071 / 1014f292 (PR #415), each pinned by a test proved to bite."
    },
    "class_scope": {
      "sites": [
        "src/gdskills/learn.ts"
      ],
      "enumeration_method": "bundled-no-persona.test.ts sweeps the whole bundled tree for the persona word and home-directory paths, with a non-vacuity assertion."
    }
  },
  {
    "id": "dyn-05",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md",
    "line": 1,
    "scope": "diff",
    "problem": "Step 7 told agents to identify a senior reviewer by judgement and hand-edit a rule file \u2014 a path applyLearningProposal refuses.",
    "impact": "Published user-specific knowledge, or a mechanism claimed without a wire.",
    "suggested_fix": "Ship the mechanism, not the person; wire or delete.",
    "evidence": "Established by enumeration over the bundled tree and by running the loop end to end.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in ff9dd071 / 1014f292 (PR #415), each pinned by a test proved to bite."
    }
  },
  {
    "id": "dyn-06",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md",
    "line": 822,
    "scope": "diff",
    "problem": "The flag selecting the reviewer kept the persona name after the skill lost it; caught by this flow's own AC1 guard in CI, not by a skill-name search.",
    "impact": "Published user-specific knowledge, or a mechanism claimed without a wire.",
    "suggested_fix": "Ship the mechanism, not the person; wire or delete.",
    "evidence": "Established by enumeration over the bundled tree and by running the loop end to end.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in ff9dd071 / 1014f292 (PR #415), each pinned by a test proved to bite."
    }
  }
]
```
