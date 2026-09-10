# Review Report - MrCipherSmith/keryx#510

## Verdict: APPROVE_WITH_SUGGESTIONS

## Summary

Three findings against a change whose entire subject is mechanisms that claim
what they cannot establish. Two of the three are claims the change itself made.

The first is the one to read. #510 added a schema conditional and said it closed
a gap where a rule lived only in a property description "no validator reads".
The rule was already enforced twenty lines above, by a top-level `else` covering
every non-fix mode. The payload presented as newly refused had always been
refused, and none of the sixteen tests shipped alongside could tell: removing
the conditional left them all green.

The second: the guard that makes a `production` claim checkable was a substring
match, satisfied by a commented-out call or a dead branch. The third: the new
enforcement was recorded as `production` while sitting behind an optional flag
that no documented invocation passed.

All three fixed in a9cbc590 and independently re-checked there by a verifier that
neither raised nor fixed them.

## Findings

### R1-LOGIC-001 - a redundant conditional described as a fix

Fixed in a9cbc590: the conditional is removed and all three schema copies are
byte-identical to the state before #510, because that conditional was the only
change made to them. The rule is now guarded by a test on the rule rather than
on any construct expressing it - `refuted` at a9cbc590, and deleting the
pre-existing `else` fails it.

### R1-ARCH-002 - the guard was fooled by a substring

Fixed in a9cbc590: comments are stripped, and every contract claiming a refusal
must be named in `LIVE_REFUSAL_TESTS`, checked by the guard. `refuted` at
a9cbc590 for the comment and docstring cases.

The unreachable-call case is NOT closed by the static check and is not claimed
to be. The verifier confirmed this directly: a dead-branch call with a properly
paired live test yields no problems from the static guard, and it is the paired
CLI-spawning test's own run that catches the unreachable call. That layering is
what the fix claims and what the verifier found.

### R1-ARCH-003 - one word for two guarantees

Fixed in a9cbc590: a third kind, `opt-in`, carrying what switches it on, and
`--result` wired into the documented Step 10 invocation and its mirrored copy.
`refuted` at a9cbc590: the refusal fires through the real CLI, and the only place
the two kinds are grouped is a schema-regression pin whose comment states why.

## Verification

Independent verifier, method `execution`, at a9cbc590. It ran the real CLI
from source, mutated each mechanism to confirm the guards are load-bearing, and
restored every file it touched.

## The structured findings

```json keryx:findings
[
  {
    "id": "R1-LOGIC-001",
    "reviewer": "review-pr510",
    "severity": "blocker",
    "problem": "The allOf conditional added to review-pr-feedback-output's schema (analyze mode implies fix must be null) was fully redundant with a pre-existing top-level if/then/else whose else branch already required it. The commit's central claim - that the rule lived only in a description no validator reads - was false.",
    "impact": "The PR's flagship demonstration did not demonstrate what it claimed: the AC2 payload was already refused at the parent commit. None of the sixteen new tests could tell the difference - removing the conditional left them all green - so a change that altered no behaviour shipped described as closing a gap, in a PR whose whole subject is unverified claims.",
    "suggested_fix": "Remove the redundant conditional and correct the narrative, or rewrite it to constrain something the existing else branch does not, with a test proving the new code is load-bearing.",
    "evidence": "Read the schema at parent commit ea0b396c: it already carried if mode==fix then fix:object else fix:null. Validated the AC2 payload against that PRE-PR schema with the project's own validateJson: already rejected with $.fix: Expected type null, got object. Deleted only the new allOf item and re-ran all three new test files: 16 pass, 0 fail.",
    "confidence": "high",
    "file": "src/gdskills/bundled/skills/review/review-pr-feedback/output-contract.schema.json",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/review/review-pr-feedback/output-contract.schema.json",
        ".metaproject/core/gdskills/contracts/review-pr-feedback-output-contract.schema.json",
        ".metaproject/skills/gdskills/review/review-pr-feedback/output-contract.schema.json"
      ],
      "enumeration_method": "Diffed the three schema copies for byte parity, read the full pre-PR schema at the parent commit, and validated payloads against it directly."
    },
    "global_id": "2026-09-10-ingest-510#R1-LOGIC-001",
    "source": "internal"
  },
  {
    "id": "R1-ARCH-002",
    "reviewer": "review-pr510",
    "severity": "major",
    "problem": "The enforcement guard checked its production claim with a raw substring match for loadSchema(\"<name>\"), which is satisfied by a commented-out call, a docstring example, or a call inside dead code.",
    "impact": "The registry's central promise - that a production claim is checked rather than trusted - was weaker than stated. Proved on live code: inserting return; above the real loadSchema call left it unreachable and fully disabled the new enforcement, and the guard still passed every assertion.",
    "suggested_fix": "Strip comments before searching, and pair every enforced contract with a test that drives the refusal through the real path, since static reading cannot establish reachability.",
    "evidence": "Handed enforcementProblems three fabricated modules - comment, docstring, dead branch - and got zero problems from all three. Then inserted return; at the top of refuseInvalidResult in src/commands/review.ts: contract-enforcement.test.ts still passed, and only review-result-contract.test.ts, which spawns the real CLI, failed.",
    "confidence": "high",
    "file": "src/gdskills/contract-enforcement.test.ts",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/gdskills/contract-enforcement.test.ts - enforcementProblems, the loadSchema substring check"
      ],
      "enumeration_method": "Read the guard's implementation, then verified empirically with synthetic registrations and a real mutation of the module backing the new claim."
    },
    "global_id": "2026-09-10-ingest-510#R1-ARCH-002",
    "source": "internal"
  },
  {
    "id": "R1-ARCH-003",
    "reviewer": "review-pr510",
    "severity": "major",
    "problem": "review-pr-feedback-output was recorded as kind: production while its enforcement sits behind an optional --result flag that no documented invocation passed.",
    "impact": "The registry used one word for two different guarantees. job-orchestrator-state, review-finding and subagent-result validate on every real call because keryx performs the write; this one validated only if a caller remembered a flag that nothing told them to pass - so in the documented workflow a self-contradictory result was never actually refused.",
    "suggested_fix": "Wire --result into the documented invocations, or introduce a distinct enforcement kind so the registry stops labelling always-checked and checked-on-request identically.",
    "evidence": "Enumerated every documented comments reply invocation - review-pr-feedback, review-orchestrator and job-orchestrator's five per-agent copies, seven in total - and found --result in none. Confirmed the check itself is real when the flag IS passed: the CLI refused with $.fix: Expected type null, got object, exit 1, while a conforming payload passed the contract check and failed later on an unrelated 404.",
    "confidence": "high",
    "file": "src/commands/review.ts",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/gdskills/bundled/skills/review/review-pr-feedback/SKILL.md",
        "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md",
        "src/gdskills/bundled/skills/orchestration/job-orchestrator/SKILL.md and its four per-agent copies"
      ],
      "enumeration_method": "keryx ctx rg over src for every file referencing the command; each documented invocation block read directly to check for the flag."
    },
    "global_id": "2026-09-10-ingest-510#R1-ARCH-003",
    "source": "internal"
  }
]
```
