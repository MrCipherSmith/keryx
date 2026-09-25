# Flow 307 — CI triage v2 — review record

Two review rounds ran against this flow's implementation before it merged to
`main` as PR #710 (squash `f56f99d3e464a8b9d787b797a884f55b6d3ab353`), with one
follow-up round after merge, fixed in PR #713 (squash
`2aaf8372d51e418005f866f630e2943cb307f09c`).

## Round 1 (pre-merge, on PR #710)

Four majors, all fixed before merge: no timeout on the `gh`/`git` subprocess
calls in the CI read port, an unbounded number of failed jobs triaged per run,
a same-head rerun override applied at the run level instead of the job level,
and an OpenRouter 401 response body printed unredacted in the auth-rejection
error.

## Post-merge round (on PR #713)

Three gaps plus one minor, found after #710 merged and fixed in the
follow-up: the job-level same-head override could still credit the wrong job
when a later run has more than one job sharing the triaged job's name; the
`runsForHeadSha` read is paginated and could silently treat a run that
actually ran earlier as "later" when the triaged run's own entry fell off the
page; the `DETERMINISTIC: <reason>` verdict line was not passed through
redaction; and, as a minor efficiency gap (not a correctness defect),
`runInfo` for other runs discovered while computing signals was re-fetched
per job instead of cached and reused across every job of one triage
invocation.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "problem": "createGhCiPort's gh/git subprocess calls carried no timeout or output cap, so a hung process could block triage indefinitely.",
    "impact": "A single stalled gh/git call hangs `review ci-triage` (and anything driving it) with no bound.",
    "suggested_fix": "Add a spawn timeout and output cap to every CiPort read, with a labelled port error on expiry.",
    "evidence": "src/review/ci-port.ts: no timeout/killSignal/maxBuffer on the Bun.spawn calls behind runInfo/failedLog/priorAttempts.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/review/ci-port.ts"],
      "enumeration_method": "grep for Bun.spawn in ci-port.ts; every CiPort read method routes through one spawn helper"
    }
  },
  {
    "id": "F-002",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "problem": "runCiTriage triaged every failed job of a run with no cap, so a run with many failed jobs made an unbounded number of Jev calls and gh reads.",
    "impact": "A run with dozens of failed jobs could make dozens of paid Jev calls and dozens of extra gh reads in one invocation.",
    "suggested_fix": "Cap the number of failed jobs triaged per run, and list the remainder as not-triaged rather than dropping or triaging them silently.",
    "evidence": "src/commands/review.ts: failedJobs was triaged in full with no slice or cap.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/commands/review.ts"],
      "enumeration_method": "grep for failedJobs in review.ts; one triage loop, one call site (runCiTriage)"
    }
  },
  {
    "id": "F-003",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "problem": "The same-head rerun override treated a later run's overall (run-level) conclusion as evidence that THIS job was flaky, even when a different job in that later run was the one that stayed red.",
    "impact": "A job could be marked DETERMINISTIC flaky off a run-level green that never actually re-ran this job successfully.",
    "suggested_fix": "Match the later run's OWN job list by job name, and only credit the override when that specific job concluded success.",
    "evidence": "src/review/ci-triage.ts: same-head evidence read runs[].conclusion (run level) instead of runInfo.jobs[].conclusion for the matching job name.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/review/ci-triage.ts"],
      "enumeration_method": "grep for sameHeadLaterPassed in ci-triage.ts; one same-head evidence computation site"
    }
  },
  {
    "id": "F-004",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "problem": "When OpenRouter rejected the credential with HTTP 401, the response body was included verbatim in the thrown error, risking a credential or other sensitive text reaching logs.",
    "impact": "A 401 body from OpenRouter could carry sensitive text that then lands unredacted in error logs or terminal output.",
    "suggested_fix": "Redact the 401 response body the same way every other externally-sourced text on this path is redacted before it reaches an error message.",
    "evidence": "src/harness/decision/jev-client.ts: JevAuthRejectedError's message included the raw response text.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/harness/decision/jev-client.ts"],
      "enumeration_method": "grep for JevAuthRejectedError construction in jev-client.ts; one throw site"
    }
  },
  {
    "id": "F-005",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "problem": "The (now job-level) same-head override matched a later run's job by name with `.find()`, which can pick the wrong job when more than one job in that later run shares the triaged job's name (a matrix leg or a reused workflow) and credit a different job's success as evidence for this one.",
    "impact": "A job could still be marked DETERMINISTIC flaky off a same-named sibling job's success rather than its own.",
    "suggested_fix": "Treat more than one same-named job in the later run as ambiguous, withhold the override, and keep only an advisory-only evidence line.",
    "evidence": "src/review/ci-triage.ts: matchingJobs = laterInfo.jobs.filter(name match); .find()-shaped selection with no ambiguity check.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/review/ci-triage.ts"],
      "enumeration_method": "grep for matchingJobs in ci-triage.ts; one same-head job-matching loop"
    }
  },
  {
    "id": "F-006",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "problem": "runsForHeadSha is capped/paginated (-L 10 in the live gh adapter) and can come back without the triaged run's own entry in it. The old filter's fallback treated every success in that (incomplete) list as later than the triaged run, which could credit a run that actually ran BEFORE this one as same-head rerun evidence.",
    "impact": "A job could be marked DETERMINISTIC flaky off a run that never actually re-ran after the triaged run's own failure.",
    "suggested_fix": "When the triaged run's own entry is missing from the page, skip the same-head signal (no baseline to compare 'later' against) and surface a pagination-gap advisory line instead of guessing.",
    "evidence": "src/review/ci-triage.ts: no check for `current === undefined` before treating every listed success as later.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/review/ci-triage.ts"],
      "enumeration_method": "grep for sameHeadCurrentRunMissing / runsForHeadSha in ci-triage.ts; one same-head evidence computation path"
    }
  },
  {
    "id": "F-007",
    "reviewer": "sonnet-reviewer",
    "severity": "major",
    "problem": "The `DETERMINISTIC: <reason>` verdict line was built from job/run identifiers and printed without going through the same redaction the signals block and log excerpt already receive.",
    "impact": "A deterministic reason line could carry unredacted sensitive text into triage output, defeating the redaction the rest of the path enforces.",
    "suggested_fix": "Route the deterministic reason line through redactSensitiveText the same way the signals block lines already are.",
    "evidence": "src/review/ci-triage.ts: the DETERMINISTIC line was composed directly from verdict.deterministic.reason with no redaction call.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/review/ci-triage.ts"],
      "enumeration_method": "grep for redactSensitiveText in ci-triage.ts; two call sites now, the signals block and the deterministic line"
    }
  },
  {
    "id": "F-008",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "problem": "runInfo for other runs discovered while computing cross-branch/same-head signals (a lookup keyed on a run id different from the one being triaged) was re-fetched per job rather than cached and reused across every job of one triage invocation.",
    "impact": "Redundant gh reads across jobs of the same run; not a correctness defect, an efficiency gap.",
    "suggested_fix": "Share one runInfo cache (keyed by run id) across every job triaged in one invocation.",
    "evidence": "src/review/ci-triage.ts / src/commands/review.ts: computeCiSignals's own runInfo reads had no shared cache across jobs.",
    "confidence": "medium"
  }
]
```
