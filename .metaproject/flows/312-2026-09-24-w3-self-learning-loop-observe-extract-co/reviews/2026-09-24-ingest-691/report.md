# PR #691 (flow 312, W3) review round 1 — relayed by the top orchestrator

Worktree /Users/Goodea/goodea/keryx-ape-312-w3, branch flow/312-w3. 294 learning tests pass. Hygiene clean (no trailers, no external names, schema byte-identical to docs copy, no MCP/ACP learning, analyze unchanged, ctx hook stdin uncapped, agents verify accepts graduated candidate).

Verdict: 1 BLOCKER (consent invariant broken), 3 major, 5 minor.

```json keryx:findings
[
  {
    "id": "R1-F1",
    "severity": "blocker",
    "file": "src/learning/store.ts",
    "line": 65,
    "title": "readPattern/listPatterns do not bind stored id/scope to the file; writePattern's 'already accepted' exemption lets a planted project-store file rewrite a human-accepted user-scope record via non-TTY extract; accept writes to the wrong store; filename/id mismatch accepts a different id than logged",
    "impact": "Wave-3 consent invariant broken: accepted text changes without TTY accept; project-dir writer escalates to user-wide store; bypasses promote's >=2-identity rule; decisions/index diverge from stores.",
    "suggested_fix": "readPattern: parsed.id!==id or parsed.scope!==scope → learning-record-invalid (listPatterns skips). writePattern no-capability path: under the scope lock, require stored accepted record's id/scope/trigger/action/domain/project/reviewerProfile equal the new record (only evidence/confidence/confidenceLevel/graduation/updatedAt may change). Regression tests for p1 and p5.",
    "evidence": "scratchpad/r691/p5.ts: 'user-scope record now: accepted | Skip the integration suite entirely and push straight to main'. p1.ts: accept p1 wrote ~/.keryx/learning/patterns/p1.json, project file stayed candidate; p2.json holding id p2other accepted p2other while logging p2; auditAcceptedRecords flagged both.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "store.ts:65 readPattern",
        "store.ts listPatterns",
        "store.ts:180 writePattern accepted exemption",
        "extract.ts decayExistingRecords/upsertDraft",
        "accept.ts acceptPattern/rejectPattern",
        "graduate.ts runGraduate member writes",
        "prune.ts expireCandidates",
        "promote.ts readPattern"
      ],
      "enumeration_method": "keryx ctx rg 'writePattern\\(|readPattern\\(|listPatterns\\(' src/learning (non-test)"
    }
  },
  {
    "id": "R1-F2",
    "severity": "major",
    "file": "src/learning/graduate.ts",
    "line": 175,
    "title": "clusterRecords keys by id only → one pattern accepted at project and user scope forms a 2-member cluster ([X,X]) → skill proposal from a single pattern",
    "impact": "Normal promote → user accept path yields proposals the cluster-size rule forbids.",
    "suggested_fix": "Key by scope+id and dedupe same id across scopes (count once) or cluster per scope; include scope in members; readMember resolves by scope.",
    "evidence": "p1.ts P2: members [\"dup\",\"dup\"]",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "graduate.ts:175 clusterRecords",
        "graduate.ts classify/proposalIdFor",
        "graduate.ts readMember"
      ],
      "enumeration_method": "read of graduate.ts id-keyed structures"
    }
  },
  {
    "id": "R1-F3",
    "severity": "major",
    "file": "src/commands/learn.ts",
    "line": 583,
    "title": "--dry-run=<v> / --refresh=<v> pass unknownFlags but are read via args.includes → destructive action runs (prune deleted files with --dry-run=true; apply --dry-run=1 writes skill; accept --refresh=1 full accept; review learn --reviewer --dry-run=1 writes .mdc)",
    "impact": "Preview silently becomes durable/destructive write.",
    "suggested_fix": "Reject '--flag=value' for boolean flags in unknownFlags (or parse booleans properly); CLI tests for '=' spelling.",
    "evidence": "keryx learn prune --dry-run=true → 'deleted 1 observation file(s), expired 2 candidate(s)'",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "learn.ts:413 --refresh",
        "learn.ts:458 apply --dry-run",
        "learn.ts:583 prune --dry-run",
        "learn.ts --json in extract/list/graduate/prune",
        "review.ts:1437 runLearnReviewer --dry-run"
      ],
      "enumeration_method": "grep args.includes(\"--…\") in learn.ts and PR hunks of review.ts"
    }
  },
  {
    "id": "R1-F4",
    "severity": "major",
    "file": "src/learning/reviewer-id.ts",
    "line": 45,
    "title": "generalizeLesson \\b…\\b never matches logins ending in ']' (bot logins) → login persists in action/trigger, printed by learn review, copied into graduated agent bodies",
    "impact": "Violates the no-literal-login guardrail for stored records and graduated agents.",
    "suggested_fix": "Lookaround boundaries (?<![\\w-])login(?![\\w-]); run case-insensitive substring refusal on draft trigger/action before persisting in extract and before graduate apply.",
    "evidence": "p4.ts: generalizeLesson(\"As copilot-reviewer[bot] notes, …\", [\"copilot-reviewer[bot]\"]) unchanged",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "reviewer-id.ts:45 generalizeLesson",
        "signals/reviewer-comment.ts drafts (action + shortHint trigger)",
        "graduate.ts buildAgentCandidate body"
      ],
      "enumeration_method": "traced consumers of generalizeLesson output"
    }
  },
  {
    "id": "R1-F5",
    "severity": "minor",
    "file": "src/commands/learn.ts",
    "line": 142,
    "title": "positional() takes a flag's value as the id when the flag precedes it (review/reject --scope user foo → 'user'; apply --skill m/n <id>)",
    "suggested_fix": "Skip values of value-taking flags (--scope, --skill, --domain, --status, --since) or use parseArgs.",
    "confidence": "high",
    "impact": "positional() takes a flag's value as the id when the flag precedes it (review/reject --scope user foo → 'user'; apply --skill m/n <id>)",
    "evidence": "positional() takes a flag's value as the id when the flag precedes it (review/reject --scope user foo → 'user'; apply --skill m/n <id>)"
  },
  {
    "id": "R1-F6",
    "severity": "minor",
    "file": "src/learning/identity.ts",
    "line": 21,
    "title": "normalizeRemoteUrl gives https/scp/ssh:// spellings of one repo different identities (comment claims otherwise) → one repo can satisfy promote's >=2 rule",
    "suggested_fix": "Canonicalize to host/path (drop scheme, user, default port; scp ':'→'/') before hashing; fix comment and tests.",
    "confidence": "high",
    "impact": "normalizeRemoteUrl gives https/scp/ssh:// spellings of one repo different identities (comment claims otherwise) → one repo can satisfy promote's >=2 rule",
    "evidence": "normalizeRemoteUrl gives https/scp/ssh:// spellings of one repo different identities (comment claims otherwise) → one repo can satisfy promote's >=2 rule"
  },
  {
    "id": "R1-F7",
    "severity": "minor",
    "file": "src/learning/extract.ts",
    "line": 156,
    "title": "read-modify-write of records and index outside the file lock (extract can revert an accept; concurrent accepts drop index entries)",
    "suggested_fix": "updatePattern(root,id,scope,mutator) doing read-compare-write inside withFileLock; same for the index.",
    "confidence": "medium",
    "impact": "read-modify-write of records and index outside the file lock (extract can revert an accept; concurrent accepts drop index entries)",
    "evidence": "read-modify-write of records and index outside the file lock (extract can revert an accept; concurrent accepts drop index entries)"
  },
  {
    "id": "R1-F8",
    "severity": "minor",
    "file": "src/learning/extract.ts",
    "line": 165,
    "title": "decay floors whole days and resets updatedAt → remainder lost each run (~33% under-decay at 36h cadence)",
    "suggested_fix": "Advance a lastDecayAt baseline by the whole days applied instead of resetting to now.",
    "confidence": "medium",
    "impact": "decay floors whole days and resets updatedAt → remainder lost each run (~33% under-decay at 36h cadence)",
    "evidence": "decay floors whole days and resets updatedAt → remainder lost each run (~33% under-decay at 36h cadence)"
  },
  {
    "id": "R1-F9",
    "severity": "minor",
    "file": "src/learning/schema.ts",
    "line": 1,
    "title": "validator errors when supersededBy is absent though the schema doesn't require it",
    "suggested_fix": "Treat undefined like null in the non-superseded branch (or require it in both schema copies).",
    "confidence": "high",
    "impact": "validator errors when supersededBy is absent though the schema doesn't require it",
    "evidence": "validator errors when supersededBy is absent though the schema doesn't require it"
  }
]
```
Probes: scratchpad/r691/ (mkproj.ts, p1.ts, p3.ts, p4.ts, p5.ts).
