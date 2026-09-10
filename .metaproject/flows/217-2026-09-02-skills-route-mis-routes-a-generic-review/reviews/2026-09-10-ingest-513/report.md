# Review Report - MrCipherSmith/keryx#513

## Verdict: APPROVE_WITH_SUGGESTIONS

## Summary

Two findings, both against guards this flow added, and both the same defect the
guards exist to catch: a measurement described as something it is not.

The PR's deliverable IS the guards, so a guard that cannot fail is the whole
failure. Review attacked them on that basis and found that the one-word probe
was answered by the verbatim scan rather than the path its docstring named.
Verification of THAT fix then found the replacement test could be answered by a
sibling trigger rather than by the inflection it probed.

Both are minor in blast radius and exact in kind. Neither was found by the
author.

## Findings

### R1-TEST-001 - the one-word probe measured the verbatim path

Fixed in dfb2bb9c: the docstring now states what each branch measures and why
they differ by arity, and the inflected property has its own test instead of
being assumed from a reachability set that would stay green through exactly
that regression. `refuted` at dfb2bb9c - disabling `matchesInflected` fails the
new test while the reachability snapshot passes, which is the blindness the
finding named, now covered.

### R2-TEST-001 - a sibling trigger could answer for the one under test

Fixed in 847cdb3c: scored against an entry carrying only the trigger under
test. `refuted` at 847cdb3c, with the numbers reproduced independently - 18 of
19 caught before, 19 of 19 after, and the single survivor identified as
review-orchestrator::ревью exactly as described.

## Verification

Two independent verifiers, method `execution`, neither of them the author of
the fix it checked. Each mutated the mechanism, counted, and restored.

## What this flow leaves standing

AC5's reachable set is empty and proved non-vacuous by 36 stranded triggers.
AC9's project-skill emission is asserted end to end through the CLI in both
directions. AC8 is recorded as a decision, not an implementation, because
`keryx orient` was not taught to read the prompt and inventing one to make a
checkbox true is the failure this flow was restarted to avoid.

## The structured findings

```json keryx:findings
[
  {
    "id": "R1-TEST-001",
    "reviewer": "review-pr513",
    "severity": "minor",
    "problem": "reachableOutOfOrder's one-word probe (please <word> it now) is satisfied by containsPhrase's verbatim word-boundary scan, never by the order-free fallback the file exists to watch. Its docstring claimed that branch exercised the inflected-matching property an earlier regression cost 29 one-word triggers.",
    "impact": "For the twenty one-word triggers in the catalog, the guard measured a different path from the one it named. A regression confined to the order-free handling of short triggers would not be caught there, reproducing the invisible-loss failure mode AC5 exists to prevent, for a narrower class.",
    "suggested_fix": "State what each branch actually measures, and give the inflected property its own test rather than assuming it from a reachability set that would stay green through exactly that regression.",
    "evidence": "containsPhrase reimplemented standalone, without the fallback, satisfies the probe for all 20 one-word triggers. Cross-checked from the other side: none of the 36 triggers stranded by reinstating the historical rule is one word, so that branch had never exercised the mechanism it claimed.",
    "confidence": "high",
    "file": "src/commands/trigger-reachability.test.ts",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/commands/trigger-reachability.test.ts - reachableOutOfOrder, the one-word branch"
      ],
      "enumeration_method": "Reimplemented containsPhrase verbatim and ran it against the one-word probe for every one-word trigger in BUNDLED_GDSKILLS, then cross-referenced the 36 stranded triggers reproduced by mutation."
    },
    "global_id": "2026-09-10-ingest-513#R1-TEST-001",
    "source": "internal"
  },
  {
    "id": "R2-TEST-001",
    "reviewer": "independent-verifier-514",
    "severity": "minor",
    "problem": "The inflection test added for R1-TEST-001 scored its probe against the whole skill entry, and scoreBundledSkillRoute computes its trigger hit across ALL of an entry's triggers - so a sibling trigger could answer for the one under test.",
    "impact": "review-orchestrator::\u0440\u0435\u0432\u044c\u044e passes through RU synonym expansion, which injects `review` and satisfies the sibling ENGLISH trigger by the order-free path - a different mechanism from the inflection the test names. That trigger would have stayed 'not lost' with matchesInflected broken for it: a case counted as measured while something else did the answering, which is the same defect the test was written to catch.",
    "suggested_fix": "Score against an entry carrying only the trigger under test.",
    "evidence": "With matchesInflected disabled, 18 of 19 one-word triggers landed in the lost set and the single survivor was review-orchestrator::\u0440\u0435\u0432\u044c\u044e.",
    "confidence": "high",
    "file": "src/commands/trigger-reachability.test.ts",
    "blocking_merge": false,
    "class_scope": {
      "sites": [
        "src/commands/trigger-reachability.test.ts - the one-word inflection test's scoring call"
      ],
      "enumeration_method": "Disabled matchesInflected and diffed the full one-word trigger set against the reported lost set, isolating the single survivor."
    },
    "global_id": "2026-09-10-ingest-513#R2-TEST-001",
    "source": "internal"
  }
]
```
