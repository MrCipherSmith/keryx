# Phase 7 audit — the review round

Five auditors over disjoint ranges of a 1,759-line skill that had never been read.
217 mechanisms inventoried: 6 wired, 132 prose-only, 79 advisory.

Full inventory with file:line evidence: `inventory.md`.

```json keryx:findings
[
  {
    "id": "audit-01",
    "reviewer": "review-core-boundaries",
    "severity": "blocker",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": 609,
    "scope": "diff",
    "problem": "Sections 2.4.1-2.8 \u2014 the entire implement/review/fix/verify core \u2014 contained zero mechanisms reachable from a production code path.",
    "impact": "Documented as behaviour while nothing implemented it; read by agents as a guarantee.",
    "suggested_fix": "Wire the mechanism or delete the claim. Softening the verb was explicitly not permitted.",
    "evidence": "Enumerated in inventory.md with the search that established it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 6a9d611c (PR #414). Verified by re-running the enumeration at that commit."
    },
    "class_scope": {
      "sites": [
        "sections 2.4.1 through 2.8"
      ],
      "enumeration_method": "Five auditors classified all 217 mechanisms; this range returned zero wired."
    }
  },
  {
    "id": "audit-02",
    "reviewer": "review-core-boundaries",
    "severity": "blocker",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/input-contract.schema.json",
    "line": 114,
    "scope": "diff",
    "problem": "code-boss-review was a DEFAULT reviewer in the input contract and existed nowhere in the repository, so every default job run dispatched a missing agent.",
    "impact": "Documented as behaviour while nothing implemented it; read by agents as a guarantee.",
    "suggested_fix": "Wire the mechanism or delete the claim. Softening the verb was explicitly not permitted.",
    "evidence": "Enumerated in inventory.md with the search that established it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 6a9d611c (PR #414). Verified by re-running the enumeration at that commit."
    },
    "class_scope": {
      "sites": [
        "input-contract.schema.json:114",
        "task-implementer/input-contract.schema.json",
        "jobs-documentation.mdc",
        "review-logic/SKILL.md",
        "git-merge-base.md",
        "5 job-orchestrator builds",
        "orchestrator-prompt.md"
      ],
      "enumeration_method": "keryx ctx rg -l over src/ returned 16 referencing files and no skill directory."
    }
  },
  {
    "id": "audit-03",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": 627,
    "scope": "diff",
    "problem": "Every implementation wave was dispatched as agent `wave-executor`, which is not a skill or an agent type.",
    "impact": "Documented as behaviour while nothing implemented it; read by agents as a guarantee.",
    "suggested_fix": "Wire the mechanism or delete the claim. Softening the verb was explicitly not permitted.",
    "evidence": "Enumerated in inventory.md with the search that established it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 6a9d611c (PR #414). Verified by re-running the enumeration at that commit."
    },
    "class_scope": {
      "sites": [
        "SKILL.md:627"
      ],
      "enumeration_method": "find over bundled/skills lists 8 orchestration skills; wave-executor is not among them."
    }
  },
  {
    "id": "audit-04",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": 649,
    "scope": "diff",
    "problem": "subagent_type: \"general\" appeared 41 times; no dispatcher accepts that value.",
    "impact": "Documented as behaviour while nothing implemented it; read by agents as a guarantee.",
    "suggested_fix": "Wire the mechanism or delete the claim. Softening the verb was explicitly not permitted.",
    "evidence": "Enumerated in inventory.md with the search that established it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 6a9d611c (PR #414). Verified by re-running the enumeration at that commit."
    },
    "class_scope": {
      "sites": [
        "41 occurrences across the 5 builds"
      ],
      "enumeration_method": "keryx ctx rg 'subagent_type' returned 41 hits, all markdown."
    }
  },
  {
    "id": "audit-05",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": 73,
    "scope": "diff",
    "problem": "The whole job-documentation layer \u2014 state.json, job-documenter, per-step status, the resumption promise \u2014 was prose. `.metaproject/jobs/` was an empty directory created by install.ts and written by nothing.",
    "impact": "Documented as behaviour while nothing implemented it; read by agents as a guarantee.",
    "suggested_fix": "Wire the mechanism or delete the claim. Softening the verb was explicitly not permitted.",
    "evidence": "Enumerated in inventory.md with the search that established it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 6a9d611c (PR #414). Verified by re-running the enumeration at that commit."
    },
    "class_scope": {
      "sites": [
        "SKILL.md:73",
        "1.2",
        "2.1.4",
        "2.1.5",
        "2.1.6"
      ],
      "enumeration_method": "keryx ctx rg 'JOBS_ROOT' over *.ts returned 0; ls -A .metaproject/jobs returned empty."
    }
  },
  {
    "id": "audit-06",
    "reviewer": "review-regression",
    "severity": "major",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": 828,
    "scope": "diff",
    "problem": "Sections 2.6/2.7 described a review pipeline two releases stale: a PR driven by this orchestrator failed all five conditions of the completion gate shipped in 0.2.71.",
    "impact": "Documented as behaviour while nothing implemented it; read by agents as a guarantee.",
    "suggested_fix": "Wire the mechanism or delete the claim. Softening the verb was explicitly not permitted.",
    "evidence": "Enumerated in inventory.md with the search that established it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 6a9d611c (PR #414). Verified by re-running the enumeration at that commit."
    },
    "class_scope": {
      "sites": [
        "2.6.0",
        "2.6.1",
        "2.6.2",
        "2.6.3",
        "2.7"
      ],
      "enumeration_method": "Each of the five gate conditions traced to the command that satisfies it and found absent from these sections."
    }
  },
  {
    "id": "audit-07",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": 1504,
    "scope": "diff",
    "problem": "code-review was the default review_mode and is not bundled or catalogued.",
    "impact": "Documented as behaviour while nothing implemented it; read by agents as a guarantee.",
    "suggested_fix": "Wire the mechanism or delete the claim. Softening the verb was explicitly not permitted.",
    "evidence": "Enumerated in inventory.md with the search that established it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 6a9d611c (PR #414). Verified by re-running the enumeration at that commit."
    },
    "class_scope": {
      "sites": [
        "SKILL.md:792",
        "SKILL.md:1504"
      ],
      "enumeration_method": "ls bundled/skills/review lists code-ai, code-b091, code-mobx-store, code-style; no code-review."
    }
  },
  {
    "id": "audit-08",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": 741,
    "scope": "diff",
    "problem": "A step defaulted 'if no response in 60s'. No timer exists and a model cannot observe wall-clock passing while a user does not answer, so the default could never fire.",
    "impact": "Documented as behaviour while nothing implemented it; read by agents as a guarantee.",
    "suggested_fix": "Wire the mechanism or delete the claim. Softening the verb was explicitly not permitted.",
    "evidence": "Enumerated in inventory.md with the search that established it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 6a9d611c (PR #414). Verified by re-running the enumeration at that commit."
    }
  },
  {
    "id": "audit-09",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": 744,
    "scope": "diff",
    "problem": "Statuses `paused` and `timeout` were claimed as persisted; state.schema.json has no status property and additionalProperties: false. Five further fields were claimed as recorded and equally illegal.",
    "impact": "Documented as behaviour while nothing implemented it; read by agents as a guarantee.",
    "suggested_fix": "Wire the mechanism or delete the claim. Softening the verb was explicitly not permitted.",
    "evidence": "Enumerated in inventory.md with the search that established it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 6a9d611c (PR #414). Verified by re-running the enumeration at that commit."
    }
  },
  {
    "id": "audit-10",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": 1074,
    "scope": "diff",
    "problem": "Two consecutive sections were both numbered 2.8.1, and 2.5 did not exist while 2.5.1 and 2.5.5 did.",
    "impact": "Documented as behaviour while nothing implemented it; read by agents as a guarantee.",
    "suggested_fix": "Wire the mechanism or delete the claim. Softening the verb was explicitly not permitted.",
    "evidence": "Enumerated in inventory.md with the search that established it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 6a9d611c (PR #414). Verified by re-running the enumeration at that commit."
    }
  },
  {
    "id": "audit-11",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": 1115,
    "scope": "diff",
    "problem": ".metaproject/scripts/detect-models.sh was named as the model-detection mechanism and has never existed in git history.",
    "impact": "Documented as behaviour while nothing implemented it; read by agents as a guarantee.",
    "suggested_fix": "Wire the mechanism or delete the claim. Softening the verb was explicitly not permitted.",
    "evidence": "Enumerated in inventory.md with the search that established it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 6a9d611c (PR #414). Verified by re-running the enumeration at that commit."
    },
    "class_scope": {
      "sites": [
        "SKILL.md:1115",
        "flow-orchestrator/SKILL.md:388"
      ],
      "enumeration_method": "keryx ctx rg 'detect-models' returned 2 hits, both prose; ls .metaproject/scripts does not exist."
    }
  },
  {
    "id": "audit-12",
    "reviewer": "review-core-boundaries",
    "severity": "major",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": 42,
    "scope": "diff",
    "problem": "SKILL.md carried three hunks the four sibling builds lacked since the bootstrap commit, while all five declared the same version and compatible_harnesses; no guard compared build against build.",
    "impact": "Documented as behaviour while nothing implemented it; read by agents as a guarantee.",
    "suggested_fix": "Wire the mechanism or delete the claim. Softening the verb was explicitly not permitted.",
    "evidence": "Enumerated in inventory.md with the search that established it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 6a9d611c (PR #414). Verified by re-running the enumeration at that commit."
    },
    "class_scope": {
      "sites": [
        "SKILL.md vs SKILL.{codex,cursor,opencode,zed}.md"
      ],
      "enumeration_method": "diff of all five builds; git blame traced the divergence to fd43d35a."
    }
  },
  {
    "id": "audit-13",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md",
    "line": 671,
    "scope": "diff",
    "problem": "Three sub-agent prompts loaded from skills/<name>/SKILL.md, a path that stopped resolving when the tree was namespaced; one was hedged '(if it exists)' so the miss was silent.",
    "impact": "Documented as behaviour while nothing implemented it; read by agents as a guarantee.",
    "suggested_fix": "Wire the mechanism or delete the claim. Softening the verb was explicitly not permitted.",
    "evidence": "Enumerated in inventory.md with the search that established it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Resolved in 6a9d611c (PR #414). Verified by re-running the enumeration at that commit."
    }
  }
]
```
