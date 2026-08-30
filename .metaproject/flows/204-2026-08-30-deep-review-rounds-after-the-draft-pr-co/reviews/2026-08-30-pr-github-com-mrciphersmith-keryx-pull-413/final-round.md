# Flow 204 — final review round

Six rounds over pull request #413, two scopes (`diff` and `blast-radius`),
24 findings, every one verified against a named commit before being called
fixed.

This flow's own deliverable is the loop that produced it. The strongest evidence
that the loop does something is not that it found defects in the original change
— it is that **two of the four fix rounds introduced a defect the next round
caught**:

- Round 1's fixes wired the scope-B screen and created an unescapable refusal
  loop (blocker) and a rule that deleted real regressions (major).
- Round 3's fix exempted `blocker` from a rule and left the record asserting
  that the exempted findings had been judged.

A single review pass would have shipped both.

## Findings, by round

| round | raised | reviewer(s) |
|---|---|---|
| 1 | 12 | review-logic, review-testing-practices, review-regression, review-core-boundaries |
| 2 | 6 | fresh-eyes over the fix commit |
| 4 | 3 | fresh-eyes over the fix commit |
| 5 | 3 | fresh-eyes over the fix commit |
| 6 | 0 | closing verification + completeness sweep |

Rounds 3 and 6 were verification-only.

## Dispositions

Every finding is `acted-on`. Not one was dismissed, and no dismissal reason was
used anywhere in this flow — so the requirement that a dismissal carry a recorded
human decision was never exercised, which is stated here rather than left to be
inferred from its absence.

One finding required an operator decision and got one: `logic-07`
(`flow complete --merged` could not accept a squash merge) was NOT dismissed —
the operator confirmed squash is this project's merge strategy, so it was fixed
by comparing commit trees instead of ancestry.

## The recurring defect class

Found five separate times, in five different modules:

> A mechanism documented as enforcement that nothing calls.

`buildTierMap`, `assignTier`, `decideDispatchModel`, `screenBlastRadiusFindings`,
and the `--max-chars` ceiling were each described in a skill, a schema or a rule
as running, while being reachable only from their own tests. Its cousin appeared
twice more:

> A record that asserts something the code did not establish.

The scope-B screen claiming every finding was judged when the blocker exemption
had skipped rule 3; and `tier_resolution: session-ranked` claiming a ranking
worked when nothing had been ranked.

Both classes share one property, which is the reason this programme exists: they
are invisible to a green test suite, because a test over a hand-built fixture
exercises the reader and can never see that the writer is missing.

## Commits

| commit | what |
|---|---|
| `ccaf4d82` | the change under review |
| `06e0f2ac` | self-review fixes |
| `dfb9ca4a` | tasks closed, 20 acceptance criteria confirmed |
| `23b43c38` | round 1's twelve findings |
| `d0290d4b` | the engine-dependent regex, and a mirror left unstaged |
| `fd7d752c` | round 2's six, including the two the fixes introduced |
| `2fdc8eff` | squash-merge verification by tree; a suite that lied about its exit code |
| `336d8dda` | round 4's three |
| `dbcc7b53` | round 5's three |

## Carried out of this flow, deliberately

**`src/sac/fwk-service.ts` — historical ledger tampering is not always
detected.** `fastCheckpointState` trusts the checkpoint whenever `identityMatches`
holds and then verifies only the tail record; `identityMatches` reads
`ledgerBytes`, `device`, `inode`, `modifiedNs`, `changedNs`. A same-size rewrite
of a historical receipt that lands in the same filesystem timestamp tick is
therefore invisible. Measured: an in-place same-size rewrite left both `mtimeNs`
and `ctimeNs` unchanged in **189 of 200** attempts.

This is why `same-size historical receipt corruption invalidates the checkpoint
and refuses append` is nondeterministic (3 of 6 isolated runs). **The test is
correct and must not be quarantined** — it is catching a real hole, intermittently.

Not fixed here: it is a change to a security mechanism, in a subsystem this flow
does not touch, and it needs its own flow and an operator decision.

```json keryx:findings
[
  {
    "id": "logic-01",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/flow/review-gate.ts",
    "line": 819,
    "scope": "diff",
    "problem": "Condition 4 passed on a stale collection: `rounds_collected > 0` was taken as proof of freshness while PrCommentState recorded no timestamp and no commit.",
    "impact": "Recorded in the flow journal; fixed in 23b43c38.",
    "suggested_fix": "See 23b43c38.",
    "evidence": "Raised and reproduced by a review round; fixed in 23b43c38 and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 23b43c38. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    },
    "class_scope": {
      "sites": [
        "src/flow/review-gate.ts:820",
        "src/flow/review-gate.ts:827",
        "src/review/pr-comments.ts:1479",
        "src/review/pr-comments.ts:1460",
        "src/commands/review.ts:543"
      ],
      "enumeration_method": "keryx ctx rg 'rounds_collected|unansweredComments|collected: true' src/ --glob '!*.test.ts' \u2014 five sites decide or feed condition 4; rounds_collected === 0 was the only freshness test any applied."
    }
  },
  {
    "id": "logic-02",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/gdskills/model-tier.ts",
    "line": 496,
    "scope": "diff",
    "problem": "screenBlastRadiusFindings, buildTierMap, assignTier and decideDispatchModel were documented as enforcement and had no production caller.",
    "impact": "Recorded in the flow journal; fixed in fd7d752c.",
    "suggested_fix": "See fd7d752c.",
    "evidence": "Raised and reproduced by a review round; fixed in fd7d752c and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in fd7d752c. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    },
    "class_scope": {
      "sites": [
        "src/review/blast-radius.ts:764",
        "src/review/blast-radius.ts:943",
        "src/gdskills/model-tier.ts:496",
        "src/gdskills/model-tier.ts:592",
        "src/gdskills/model-tier.ts:674"
      ],
      "enumeration_method": "keryx ctx rg 'screenBlastRadiusFindings|renderBlastRadiusScreenMarkdown|buildTierMap|decideDispatchModel|assignTier\\(' src/ .metaproject/skills \u2014 71 hits over 6 files; every hit outside the two test files was a definition or a prose claim that the mechanism runs."
    }
  },
  {
    "id": "logic-03",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/review/pr-comments.ts",
    "line": 1568,
    "scope": "diff",
    "problem": "postReplyPass skipped on row existence while two sibling readers skipped on reply existence, so a settled row with reply_url null could never be cleared.",
    "impact": "Recorded in the flow journal; fixed in 23b43c38.",
    "suggested_fix": "See 23b43c38.",
    "evidence": "Raised and reproduced by a review round; fixed in 23b43c38 and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 23b43c38. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    }
  },
  {
    "id": "logic-04",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/flow/review-gate.ts",
    "line": 1077,
    "scope": "diff",
    "problem": "Condition 5 refused only verification_mode off; annotate with zero claims passed while printing that nothing was verified.",
    "impact": "Recorded in the flow journal; fixed in 23b43c38.",
    "suggested_fix": "See 23b43c38.",
    "evidence": "Raised and reproduced by a review round; fixed in 23b43c38 and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 23b43c38. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    }
  },
  {
    "id": "logic-05",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/gdskills/model-tier.ts",
    "line": 106,
    "scope": "diff",
    "problem": "parseModelTier returned inherited Object.prototype keys, bypassing the AC14 guard and then resolving as a silent light downgrade.",
    "impact": "Recorded in the flow journal; fixed in 23b43c38.",
    "suggested_fix": "See 23b43c38.",
    "evidence": "Raised and reproduced by a review round; fixed in 23b43c38 and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 23b43c38. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    }
  },
  {
    "id": "logic-06",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/review/pr-comments.ts",
    "line": 908,
    "scope": "diff",
    "problem": "The abbreviation mask under-counted a sentence-final `etc.`, the direction the code's own comment names as dangerous.",
    "impact": "Recorded in the flow journal; fixed in d0290d4b.",
    "suggested_fix": "See d0290d4b.",
    "evidence": "Raised and reproduced by a review round; fixed in d0290d4b and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in d0290d4b. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    }
  },
  {
    "id": "logic-07",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/flow/review-gate.ts",
    "line": 1006,
    "scope": "diff",
    "problem": "flow complete --merged could not accept a squash merge; commit ancestry does not exist for a squash by construction.",
    "impact": "Recorded in the flow journal; fixed in 2fdc8eff.",
    "suggested_fix": "See 2fdc8eff.",
    "evidence": "Raised and reproduced by a review round; fixed in 2fdc8eff and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 2fdc8eff. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    }
  },
  {
    "id": "logic-08",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/gdskills/model-tier.ts",
    "line": 441,
    "scope": "diff",
    "problem": "resolveTierFromRanking anchored deep/light at rank 0 when the ranking carried no session rank.",
    "impact": "Recorded in the flow journal; fixed in 23b43c38.",
    "suggested_fix": "See 23b43c38.",
    "evidence": "Raised and reproduced by a review round; fixed in 23b43c38 and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 23b43c38. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    }
  },
  {
    "id": "test-01",
    "reviewer": "review-testing-practices",
    "severity": "blocker",
    "file": "src/gdskills/model-tier.ts",
    "line": 496,
    "scope": "diff",
    "problem": "The tier module was a producer with no consumer: nothing in the shipped runtime called it, so tier selection had no effect on a real dispatch.",
    "impact": "Recorded in the flow journal; fixed in 23b43c38.",
    "suggested_fix": "See 23b43c38.",
    "evidence": "Raised and reproduced by a review round; fixed in 23b43c38 and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 23b43c38. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    },
    "class_scope": {
      "sites": [
        "src/gdskills/model-tier.ts:496",
        "src/gdskills/model-tier.ts:674",
        "src/gdskills/model-tier.ts:592"
      ],
      "enumeration_method": "keryx ctx rg 'buildTierMap|decideDispatchModel' over the repository and 'assignTier\\(' over src/ \u2014 all matches confined to model-tier.ts and its test; zero in any dispatch, orchestration or CLI path."
    }
  },
  {
    "id": "test-02",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/commands/review.ts",
    "line": 973,
    "scope": "diff",
    "problem": "review blast-radius and review comments collect had no test driving them through the real CLI; a throw at the top of the handler left the suite green.",
    "impact": "Recorded in the flow journal; fixed in fd7d752c.",
    "suggested_fix": "See fd7d752c.",
    "evidence": "Raised and reproduced by a review round; fixed in fd7d752c and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in fd7d752c. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    },
    "class_scope": {
      "sites": [
        "src/commands/review.ts:973",
        "src/commands/review.ts:525"
      ],
      "enumeration_method": "keryx ctx rg for the two subcommand literals in src/commands/review.test.ts (0 matches each), then for the handler names across src/ \u2014 called only from the reviewCommand dispatcher, never from a test. Confirmed by inserting a throw at the top of the handler and observing the whole suite stay green."
    }
  },
  {
    "id": "test-03",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/commands/review.ts",
    "line": 588,
    "scope": "diff",
    "problem": "--max-sentences had no coverage at any level and --max-replies none through argv; disconnecting the parse site left 87/87 green.",
    "impact": "Recorded in the flow journal; fixed in 23b43c38.",
    "suggested_fix": "See 23b43c38.",
    "evidence": "Raised and reproduced by a review round; fixed in 23b43c38 and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 23b43c38. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    },
    "class_scope": {
      "sites": [
        "src/commands/review.ts:587",
        "src/commands/review.ts:588"
      ],
      "enumeration_method": "keryx ctx rg 'maxReplies|maxSentences|max-replies|max-sentences' over src/review/pr-comments.test.ts and src/commands/review.ts; confirmed by mutating the forwarding to a no-op and re-running the pr-comments and CLI suites (87/87 still green)."
    }
  },
  {
    "id": "regr-01",
    "reviewer": "review-regression",
    "severity": "major",
    "file": "src/review/loop.ts",
    "line": 275,
    "scope": "blast-radius",
    "problem": "External comments carry a dedupe key stable across rounds, so an unanswered comment read as a reviewer in a loop and review loop exited 1 from round 2.",
    "impact": "Recorded in the flow journal; fixed in 23b43c38.",
    "suggested_fix": "See 23b43c38.",
    "evidence": "Raised and reproduced by a review round; fixed in 23b43c38 and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 23b43c38. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    },
    "class_scope": {
      "sites": [
        "src/review/loop.ts:275",
        "src/commands/review.ts:717"
      ],
      "enumeration_method": "keryx ctx rg 'readFlowReviewRounds|detectReviewLoop' over the repository: 5 files, of which only src/commands/review.ts is a production consumer. Both sites \u2014 where the signal is emitted and where it becomes a non-zero exit \u2014 not a sample."
    }
  },
  {
    "id": "r2-01",
    "reviewer": "review-logic",
    "severity": "blocker",
    "file": "src/review/managed.ts",
    "line": 439,
    "scope": "diff",
    "problem": "The scope-B refusal was an unescapable trap: the message named a path the reader does not read, and following it created the package directory so the next ingest allocated -r02 and refused identically.",
    "impact": "Recorded in the flow journal; fixed in fd7d752c.",
    "suggested_fix": "See fd7d752c.",
    "evidence": "Raised and reproduced by a review round; fixed in fd7d752c and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in fd7d752c. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    },
    "class_scope": {
      "sites": [
        "src/review/managed.ts:427",
        "src/review/managed.ts:439",
        "src/review/managed.ts:470",
        "src/review/managed.ts:1936",
        "src/review/managed.ts:453"
      ],
      "enumeration_method": "grep -nE 'screenScopeBFindings|readPackageBlastRadius|BLAST_RADIUS_ARTIFACT' over src/review/managed.ts plus the allocatePackage body; confirmed by executing createManagedReviewPackage twice in a temp cwd and observing the identical refusal."
    }
  },
  {
    "id": "r2-02",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/review/blast-radius.ts",
    "line": 865,
    "scope": "diff",
    "problem": "no-link-to-change built tokens only from changed files while admitting findings anchored anywhere in the radius, so a correctly anchored blocker about a dependent was deleted.",
    "impact": "Recorded in the flow journal; fixed in fd7d752c.",
    "suggested_fix": "See fd7d752c.",
    "evidence": "Raised and reproduced by a review round; fixed in fd7d752c and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in fd7d752c. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    },
    "class_scope": {
      "sites": [
        "src/review/blast-radius.ts:865",
        "src/review/blast-radius.ts:741",
        "src/review/managed.ts:258",
        "src/review/managed.ts:448"
      ],
      "enumeration_method": "keryx ctx rg 'screenBlastRadiusFindings' src/ \u2014 the only non-test caller is managed.ts, reached from createManagedReviewPackage; verified by running the ingest with an inline blastRadius and observing the blocker rejected."
    }
  },
  {
    "id": "r2-03",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/review/review-orchestrator/SKILL.md",
    "line": 180,
    "scope": "diff",
    "problem": "The orchestrator skill listed --blast-radius as optional while omitting it hard-fails, and review-regression claimed no rule reads the reviewer's name while membership does.",
    "impact": "Recorded in the flow journal; fixed in fd7d752c.",
    "suggested_fix": "See fd7d752c.",
    "evidence": "Raised and reproduced by a review round; fixed in fd7d752c and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in fd7d752c. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    }
  },
  {
    "id": "r2-04",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/flow/review-gate.ts",
    "line": 869,
    "scope": "diff",
    "problem": "flow complete conflated a stale collection with an unreachable tracker, reporting both as unobserved with advice fitting only one.",
    "impact": "Recorded in the flow journal; fixed in fd7d752c.",
    "suggested_fix": "See fd7d752c.",
    "evidence": "Raised and reproduced by a review round; fixed in fd7d752c and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in fd7d752c. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    }
  },
  {
    "id": "r2-05",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/gdskills/model-tier.ts",
    "line": 460,
    "scope": "diff",
    "problem": "An eight-line explanatory comment was duplicated verbatim.",
    "impact": "Recorded in the flow journal; fixed in fd7d752c.",
    "suggested_fix": "See fd7d752c.",
    "evidence": "Raised and reproduced by a review round; fixed in fd7d752c and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in fd7d752c. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    }
  },
  {
    "id": "r2-06",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/commands/review.ts",
    "line": 395,
    "scope": "diff",
    "problem": "An unreachable scope-B screen printer branch that could never print.",
    "impact": "Recorded in the flow journal; fixed in fd7d752c.",
    "suggested_fix": "See fd7d752c.",
    "evidence": "Raised and reproduced by a review round; fixed in fd7d752c and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in fd7d752c. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    }
  },
  {
    "id": "r4-01",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/review/blast-radius.ts",
    "line": 907,
    "scope": "diff",
    "problem": "The blocker exemption left no trace, and the renderer then asserted every scope-B finding had been judged.",
    "impact": "Recorded in the flow journal; fixed in 336d8dda.",
    "suggested_fix": "See 336d8dda.",
    "evidence": "Raised and reproduced by a review round; fixed in 336d8dda and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 336d8dda. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    }
  },
  {
    "id": "r4-02",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/commands/review.ts",
    "line": 691,
    "scope": "diff",
    "problem": "--catalog failed with a message naming neither the flag nor the file.",
    "impact": "Recorded in the flow journal; fixed in 336d8dda.",
    "suggested_fix": "See 336d8dda.",
    "evidence": "Raised and reproduced by a review round; fixed in 336d8dda and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 336d8dda. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    }
  },
  {
    "id": "r4-03",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/flow/review-gate.ts",
    "line": 798,
    "scope": "diff",
    "problem": "Condition 3 printed condition 4's remedy for no-tracker, naming a seam condition 3 never reads.",
    "impact": "Recorded in the flow journal; fixed in 336d8dda.",
    "suggested_fix": "See 336d8dda.",
    "evidence": "Raised and reproduced by a review round; fixed in 336d8dda and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in 336d8dda. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    }
  },
  {
    "id": "r5-01",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/review/blast-radius.ts",
    "line": 1120,
    "scope": "diff",
    "problem": "The exemption heading was never closed, so a rejected finding rendered under a heading saying it was admitted.",
    "impact": "Recorded in the flow journal; fixed in dbcc7b53.",
    "suggested_fix": "See dbcc7b53.",
    "evidence": "Raised and reproduced by a review round; fixed in dbcc7b53 and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in dbcc7b53. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    }
  },
  {
    "id": "r5-02",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/flow/review-gate.ts",
    "line": 807,
    "scope": "diff",
    "problem": "The shared-remedy guarantee had no guard: branching a second arm left 567 tests green.",
    "impact": "Recorded in the flow journal; fixed in dbcc7b53.",
    "suggested_fix": "See dbcc7b53.",
    "evidence": "Raised and reproduced by a review round; fixed in dbcc7b53 and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in dbcc7b53. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    }
  },
  {
    "id": "r5-03",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/sac/fwk-service.test.ts",
    "line": 341,
    "scope": "repo",
    "problem": "A commit message characterised the known SAC failure as file-isolation dependent; it is nondeterministic.",
    "impact": "Recorded in the flow journal; fixed in dbcc7b53.",
    "suggested_fix": "See dbcc7b53.",
    "evidence": "Raised and reproduced by a review round; fixed in dbcc7b53 and verified against it.",
    "confidence": "high",
    "source": "internal",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fixed in dbcc7b53. A verifier re-ran the reproduction at that commit and returned `refuted` by execution; the fix was additionally proved load-bearing by a mutation that turns a named test red."
    }
  }
]
```
