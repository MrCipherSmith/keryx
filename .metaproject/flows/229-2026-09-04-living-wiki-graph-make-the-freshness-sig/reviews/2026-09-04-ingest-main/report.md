# Flow 229 Managed Review — Round 1

Target: `feat/lwg-agent-reachable` at `e8959bf1`
Base: `main`
Fix round: true

Reviewers: security-code, architecture.

## Outcome

- 0 blockers, 1 major, 1 minor — both fixed on the branch and re-verified.
- External comments: collection ran against PR #460 head `e8959bf1`; zero comments.
- Suite: 6787 pass, 48 fail — the same 48 that fail at the branch base. All
  four failures this change introduced were fixed, not suppressed.

## Note

The major was caught by an existing guard in the repository, not by me. I had
written a comment justifying the wrong value. That is worth recording plainly:
a rationale next to a flag is not evidence the flag is right, and the guard
was the thing that knew better.

```json keryx:findings
[
  {
    "id": "F-NEW-001",
    "reviewer": "review-security-code",
    "severity": "major",
    "problem": "`wiki freshness` was registered with read: true while declaring that it writes data/wiki/freshness/latest.{json,md}.",
    "impact": "The `read` flag feeds isAutoAllowable, so an agent could have invoked a writing command with no approval. The justification written at the time \u2014 read-only 'in the sense that matters to a caller' \u2014 treated a permission claim as a description of intent.",
    "suggested_fix": "read: false, with the reasoning recorded at the site; the MCP surface is the genuinely read-only path.",
    "evidence": "command-registry.coverage.test.ts: 'no descriptor claims read-only while declaring side effects' failed on the new entry.",
    "confidence": "high",
    "file": "src/standard/command-registry.ts",
    "line": 129,
    "class_scope": {
      "sites": [
        "src/standard/command-registry.ts:129"
      ],
      "enumeration_method": "All four new descriptors reviewed for the same claim; only this one made it."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed at e8959bf1 (merged as 576c6535): read: false with an at-site note explaining why the earlier reasoning was wrong. The registry guard passes."
    }
  },
  {
    "id": "F-NEW-002",
    "reviewer": "review-architecture",
    "severity": "minor",
    "problem": "Adding wikiFreshness as a required MetaprojectPort method broke eight test fakes and the adapter.",
    "impact": "A required method forces every existing implementation to change for a capability most do not have, and would have made this change far larger than the value it adds.",
    "suggested_fix": "Make it optional, following the existing loadSkill precedent, and have the caller report unavailability rather than fabricate an empty report.",
    "evidence": "Eight typecheck errors across test fakes plus metaproject-adapter.ts on the first attempt.",
    "confidence": "high",
    "file": "src/harness/tool/metaproject-port.ts",
    "line": 330,
    "class_scope": {
      "sites": [
        "src/harness/tool/metaproject-port.ts:330"
      ],
      "enumeration_method": "The port has one other optional method, loadSkill, which set the precedent."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "Made optional at e8959bf1 (merged as 576c6535); the operation returns an explicit unavailable message that says it is not evidence of freshness."
    }
  }
]
```
