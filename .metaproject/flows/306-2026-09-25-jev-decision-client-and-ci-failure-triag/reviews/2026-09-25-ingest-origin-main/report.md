# Review — flow 306, Jev decision client and CI failure triage (PR #704)

An adversarial review ran against the flow 306 diff on the `feat/jev-ci-triage`
branch (`src/harness/decision/jev-client.ts`, `src/review/ci-triage.ts`,
`src/review/ci-port.ts`, `src/commands/review.ts`, `src/tui/ci-triage-inspector.ts`,
`src/tui/ci-triage-source.ts`, plus tests and docs), focused on data egress,
advisory-only guarantees, client robustness, TUI correctness, tests, import
zones and docs. It raised five findings — one major (no timeout/abort on the
Jev HTTP call), two minor (a redaction-completeness gap and a missing race
test), and two informational (AC14 not yet green at review time, and shallow
response-shape validation). All fixed findings were acted on before merge. PR
#704 squash-merged as `45df98bdafd11b292990addf50e311d2072a048c` into `main`;
CI 19/19 green at that commit (`typecheck-and-tests` confirmed completed
success after polling).

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "code-reviewer (ci-triage adversarial)",
    "severity": "major",
    "file": "src/harness/decision/jev-client.ts",
    "problem": "`callJevSystemOne` posted to the Jev/System-One endpoint with no `AbortController`, no `signal`, and no timeout of any kind on the `fetch` call.",
    "impact": "A hung or silently-dropped OpenRouter/TypeSafe response left `keryx review ci-triage` hanging forever with no feedback, and left a TUI `/ci` item stuck at \"triaging…\" indefinitely; closing the modal did not cancel the underlying request, which kept running in the background with no way to retry.",
    "suggested_fix": "Wire an `AbortController` with a bounded default timeout into the `fetch` call, map an abort to a distinct named error, and have the TUI abort the request when its modal closes.",
    "evidence": "`keryx ctx rg \"AbortController|signal:|timeout\"` across `jev-client.ts`, `ci-triage-source.ts`, `ci-triage-inspector.ts` and `review.ts` returned zero matches at commit ca5053c6; `callJevSystemOne`'s `fetchFn(JEV_ENDPOINT, {...})` call carried no `signal` option, and `ci-triage-inspector.ts`'s `onClose` handler did not touch the in-flight triage promise.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/harness/decision/jev-client.ts callJevSystemOne (the fetch call itself)",
        "src/tui/ci-triage-inspector.ts runTriage / onClose (the TUI caller awaiting the promise with no cancellation)"
      ],
      "enumeration_method": "grepped every fetch/AbortController/signal/timeout reference reachable from the CI-triage Jev call path (jev-client.ts, ci-triage-source.ts, review.ts, ci-triage-inspector.ts) via `keryx ctx rg`; callJevSystemOne's fetch call is the only site that issues the network request on this path, and ci-triage-inspector.ts's runTriage/onClose is its only TUI caller that awaits it — the class has exactly these two members."
    }
  },
  {
    "id": "F-002",
    "reviewer": "code-reviewer (ci-triage adversarial)",
    "severity": "minor",
    "file": "src/review/ci-triage.ts",
    "problem": "`buildCiTriageState` redacted `rawLog` through `redactSensitiveText` but interpolated `testName` and `jobName` into the returned `state` string unredacted.",
    "impact": "Structural inconsistency against the stated \"everything sent is redacted\" property, though low practical risk: `testName` was extracted by a narrow path/line-number regex incapable of representing a typical secret shape, and `jobName` came from CI-defined job names, not free-form user text.",
    "suggested_fix": "Run `testName`/`jobName` through `redactSensitiveText` too, for defence in depth.",
    "evidence": "At commit ca5053c6, `buildCiTriageState` read: `const redacted = redactSensitiveText(input.rawLog); ... return [\\`job: ${input.jobName}\\`, \\`failing test: ${input.testName}\\`, ...]` — only `rawLog` passed through the redactor.",
    "confidence": "high"
  },
  {
    "id": "F-003",
    "reviewer": "code-reviewer (ci-triage adversarial)",
    "severity": "minor",
    "file": "src/tui/ci-triage-inspector.test.ts",
    "problem": "No test closed the `/ci` modal while a triage request was still in flight and asserted no crash / no stale paint, despite the implementation guarding for exactly that case (`paint()`'s early `if (closed) return;`).",
    "impact": "The modal-closed-mid-triage race was unverified by any regression test; a future refactor could reintroduce a stale-paint or crash bug with nothing to catch it.",
    "suggested_fix": "Add a test that opens the modal, starts a triage with a controllable/never-resolving promise, closes the modal, then resolves the promise late and asserts no crash and no stale paint.",
    "evidence": "`keryx ctx rg \"closed before|closes mid|abort|mid-triage|race\" src/tui/ci-triage-inspector.test.ts` at commit ca5053c6 returned no matches.",
    "confidence": "high"
  },
  {
    "id": "F-004",
    "reviewer": "code-reviewer (ci-triage adversarial)",
    "severity": "info",
    "problem": "AC14 (\"CI is green on the pull request and `keryx health run` passes before merge\") was not yet satisfiable at review time.",
    "impact": "The `typecheck-and-tests` check on PR #704 was `IN_PROGRESS` at the moment of review (`gh pr view 704 --json statusCheckRollup`), with 18 other checks already green — nothing failing, just not yet complete.",
    "suggested_fix": "Wait for the run to finish green before merging and before confirming AC14.",
    "evidence": "`gh pr view 704 --json statusCheckRollup` at review time showed `typecheck-and-tests` with `status: IN_PROGRESS`, `conclusion: \"\"`.",
    "confidence": "high"
  },
  {
    "id": "F-005",
    "reviewer": "code-reviewer (ci-triage adversarial)",
    "severity": "info",
    "file": "src/harness/decision/jev-client.ts",
    "problem": "`callJevSystemOne` validated only that the top-level `answers` and `usage` fields were non-null objects, not that each individual answer entry carried a valid `type`/`noul` shape.",
    "impact": "Not independently exploitable — `computeCiTriageVerdict` defensively clamped a missing/non-finite `noul` to `0` — but a malformed per-criterion answer from the vendor would be read as a confident \"definitely not this bucket\" instead of surfacing as a vendor-response problem.",
    "suggested_fix": "Validate each requested answer key against the question that asked it (right `type`, and for `noul` a finite `0..1` value), raising a named error on a mismatch instead of silently deferring to a caller's defensive clamp.",
    "evidence": "At commit ca5053c6, `callJevSystemOne` only checked `typeof record.answers !== \"object\"` / `typeof record.usage !== \"object\"` before casting `record.answers as Record<string, JevAnswer>` directly, with no per-key validation.",
    "confidence": "high"
  }
]
```
