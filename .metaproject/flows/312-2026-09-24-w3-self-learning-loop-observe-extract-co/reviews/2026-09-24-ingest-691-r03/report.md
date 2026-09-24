# PR #691 (flow 312, W3) review round 3 (final) — relayed by the top orchestrator

Reviewed fixes 04779534, f66a5e8d, 6a34df6e; pre-fix tree 33fc41b3 extracted to scratchpad/r691/r3/pre/; probes c1.ts c2.ts v1.ts v2.ts p4.ts e1.ts in scratchpad/r691/r3/. 440 tests pass.

Round-2 status: R2-F1 fixed for reported shapes (regressions → R3-F1); R2-F2 fixed, no test; R2-F3 fixed; R2-F4 fixed (writeRecordUnlocked text check untested); R2-F5 fixed; R2-F6 fixed but too broad (R3-F2) + regression (R3-F3); R2-F7 fixed, no test; R2-F8 fixed, no test. test:core includes src/learning; import ratchet passes; consent invariant holds (only accept.ts:245 mints the capability behind isTerminal).

Verdict: 0 blocker, 0 major, 4 minor, 1 info.

```json keryx:findings
[
  {
    "id": "R3-F1",
    "severity": "minor",
    "file": "src/learning/preview-scrub.ts",
    "line": 265,
    "title": "findUnbalancedQuoteRun treats any lone apostrophe as an unclosed quote: path with apostrophe leaks a directory name (regression: 'cp /Users/bob/it's-secret/y.txt /tmp/z' → 'cp it's-secret/y.txt z'); scrubUnclosedRun collapses everything after a prose apostrophe into one basename ('don't: /tmp/a/b then 2 fail and 3 pass in src/x/y.test.ts' → 'don't: y.test.ts'), destroying failure counts extraction reads; ';', '|', '&', '@' prefixes still not delimiters ('make&&/Users/bob/secret/run.sh' unchanged)",
    "suggested_fix": "' opens a quote only at token start (start/whitespace/= ( [ {), not between word chars; limit unclosed-run collapse to the path-shaped run up to the next non-continuing whitespace token; add ; | & @ to delimiters; tests for it's-secret, can't … N fail, &&/abs/path",
    "class_scope": {
      "sites": [
        "preview-scrub.ts:265 findUnbalancedQuoteRun",
        "preview-scrub.ts:287 scrubUnclosedRun",
        "preview-scrub.ts:205 EMBEDDED_PATH_RE",
        "preview-scrub.ts:313 scrubPathsInText",
        "observe.ts:163/189/213/226"
      ],
      "enumeration_method": "every function added in 04779534, probed pre vs head in r3/v1.ts, r3/v2.ts"
    },
    "confidence": "high",
    "impact": "findUnbalancedQuoteRun treats any lone apostrophe as an unclosed quote: path with apostrophe leaks a directory name (regression: 'cp /Users/bob/it's-secret/y.txt /tmp/z' → 'cp it's-secret/y.txt z'); scrubUnclosedRun collapses everything after a prose apostrophe into one basename ('don't: /tmp/a/b then 2 fail and 3 pass in src/x/y.test.ts' → 'don't: y.test.ts'), destroying failure counts extraction reads; ';', '|', '&', '@' prefixes still not delimiters ('make&&/Users/bob/secret/run.sh' unchanged)",
    "evidence": "findUnbalancedQuoteRun treats any lone apostrophe as an unclosed quote: path with apostrophe leaks a directory name (regression: 'cp /Users/bob/it's-secret/y.txt /tmp/z' → 'cp it's-secret/y.txt z'); scrubUnclosedRun collapses everything after a prose apostrophe into one basename ('don't: /tmp/a/b then 2 fail and 3 pass in src/x/y.test.ts' → 'don't: y.test.ts'), destroying failure counts extraction reads; ';', '|', '&', '@' prefixes still not delimiters ('make&&/Users/bob/secret/run.sh' unchanged)"
  },
  {
    "id": "R3-F2",
    "severity": "minor",
    "file": "src/learning/reviewer-id.ts",
    "line": 49,
    "title": "containsConfiguredLogin is a plain substring match: short logins (rob, ed, al, max, dev) drop ordinary lessons and hard-refuse apply/graduate apply; graduate role template contains 'graduated' so author 'ed' blocks every graduate apply",
    "suggested_fix": "bounded match (?<![A-Za-z0-9-])login(?![A-Za-z0-9-]) for refusal gates; substring caution only for logins ≥5 chars if wanted; graduate check over member trigger/action only, not the fixed template; tests with a short login",
    "class_scope": {
      "sites": [
        "reviewer-id.ts:49",
        "reviewer-id.ts:96",
        "extract.ts:267",
        "apply.ts:194",
        "graduate.ts:549-552 (templates 480-496)",
        "reviewer-profile.ts:127 refuseIfAttributed"
      ],
      "enumeration_method": "keryx ctx rg 'containsConfiguredLogin|refuseIfAttributed' src/learning; r3/p4.ts"
    },
    "confidence": "high",
    "impact": "containsConfiguredLogin is a plain substring match: short logins (rob, ed, al, max, dev) drop ordinary lessons and hard-refuse apply/graduate apply; graduate role template contains 'graduated' so author 'ed' blocks every graduate apply",
    "evidence": "containsConfiguredLogin is a plain substring match: short logins (rob, ed, al, max, dev) drop ordinary lessons and hard-refuse apply/graduate apply; graduate role template contains 'graduated' so author 'ed' blocks every graduate apply"
  },
  {
    "id": "R3-F3",
    "severity": "minor",
    "file": "src/learning/extract.ts",
    "line": 418,
    "title": "login gates load review-learning config unguarded: a malformed config breaks extract (any domain), apply and graduate apply; extract throws after decay already wrote (half-done run)",
    "suggested_fix": "catch config validation errors for the attribution gate (fall back to raw authors if readable, or refuse only review-conventions work); load config before decayExistingRecords",
    "class_scope": {
      "sites": [
        "extract.ts:418",
        "graduate.ts:549",
        "apply.ts:~190"
      ],
      "enumeration_method": "keryx ctx rg 'loadReviewLearningConfig' src/learning; r3/e1.ts pre vs head"
    },
    "confidence": "high",
    "impact": "login gates load review-learning config unguarded: a malformed config breaks extract (any domain), apply and graduate apply; extract throws after decay already wrote (half-done run)",
    "evidence": "login gates load review-learning config unguarded: a malformed config breaks extract (any domain), apply and graduate apply; extract throws after decay already wrote (half-done run)"
  },
  {
    "id": "R3-F4",
    "severity": "minor",
    "file": "src/commands/learn.test.ts",
    "line": 1,
    "title": "no regression tests for: per-verb -h/arity and single-dash refusal, review learn parsing (--pr … --dry-run=1, repeated/empty --reviewer), prune dry-run wording, extract/apply/graduate login gates, writeRecordUnlocked accepted-text check",
    "suggested_fix": "add learn.test.ts, review.test.ts, extract/apply/graduate and store.test.ts cases as listed",
    "confidence": "high",
    "impact": "no regression tests for: per-verb -h/arity and single-dash refusal, review learn parsing (--pr … --dry-run=1, repeated/empty --reviewer), prune dry-run wording, extract/apply/graduate login gates, writeRecordUnlocked accepted-text check",
    "evidence": "no regression tests for: per-verb -h/arity and single-dash refusal, review learn parsing (--pr … --dry-run=1, repeated/empty --reviewer), prune dry-run wording, extract/apply/graduate login gates, writeRecordUnlocked accepted-text check"
  },
  {
    "id": "R3-F5",
    "severity": "info",
    "file": "src/learning/preview-scrub.ts",
    "line": 205,
    "title": "embedded '~' alternative rewrites semver ranges ('~4.17.21' → [home]) and bash '=~'",
    "suggested_fix": "treat '~' as home only when followed by '/', '\\\\' or end of run",
    "impact": "embedded '~' alternative rewrites semver ranges ('~4.17.21' → [home]) and bash '=~'",
    "evidence": "embedded '~' alternative rewrites semver ranges ('~4.17.21' → [home]) and bash '=~'",
    "confidence": "medium"
  }
]
```
