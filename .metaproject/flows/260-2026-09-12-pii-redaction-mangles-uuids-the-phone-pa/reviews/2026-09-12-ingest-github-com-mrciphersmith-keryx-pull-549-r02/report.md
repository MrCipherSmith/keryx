# Review round 2 (fix round) — flow 260 / PR #549 (`2aa3d0e2`)

Target: `pr` · https://github.com/MrCipherSmith/keryx/pull/541 · head `dd7f3df0772bf548c34966f0392dd8c72456377c`
Scope A: 707-line diff, 4 source files (`src/security/detect/pii.ts` + 3 test files) plus CHANGELOG and flow state. Nothing dropped by the pre-filter.
Scope B: 34 files, computed by `keryx review blast-radius` at depth 2 from the 4 changed files.
Reviewers: `review-logic`, `review-security-code`, `review-testing-practices`, `review-regression`.
Model: `keryx review tier` returned `tier_resolution: session-fallback` — it could not rank the configured provider's catalogue ("the session model `grok-4.6` carries no size marker the hints recognise"), so it named the session's own provider/model rather than a tier. The dispatches ran on Sonnet at the operator's explicit instruction. Recorded as `model_assignment: session-fallback (unrankable)`, not as a computed tier.
External PR comments: collected against `52697b3e` — zero.

## What this round is

Round 1 reviewed `dd7f3df0` and raised five findings, one of them a blocker.
`ea40936d` (merged as `52e7cbcc`, PR #549) answers all five. This round carries
the same five findings forward and attaches `review-verifier`'s verdicts,
obtained against the repaired tree by an agent that raised none of them.

**Every one is `refuted` — none of the five still reproduces.** The verifier's
own measurement of F-002 puts the guard at or below the unguarded baseline
(0.95–0.99x across three input sizes), rather than the ~9% the repair claimed;
its F-001 reproducer was shown decisive by failing 6/6 against the pre-repair
file.

## Verdict on round 1

**The change under review is wrong in the direction that matters.** It repaired a
false positive by introducing a false negative in a PII detector, and the
statement in its own CHANGELOG and PR body — "the phone corpus is unchanged, so
every number the detector caught before it still catches" — is false.

Two reviewers reached this independently, each with a before/after execution
against `dd7f3df0` and its parent. The orchestrator reproduced it a third time
before accepting it.

## Findings

### F-001 `blocker` — a real phone number next to a word stopped being redacted

`isIdentifierFragment` suppressed the match whenever the enclosing
`[0-9A-Za-z_-]` token carried any letter. The reasoning ("a dialling sequence
never contains a letter") is true of the sequence and false of the token around
it. Measured, against the merged commit:

```
MISSED  "contact-415-555-0199-primary"
MISSED  "ticket TCK-415-555-0199-open"
MISSED  "call 415-555-0199-ext205 now"
MISSED  "a-415-555-0199"
MISSED  "{\"phone-415-555-0199-key\":\"value\"}"
```

Every one of those returned `["415-555-0199"]` before the guard existed. A
single adjacent letter was sufficient, which also makes it a deliberate evasion:
wrap a number in a slug and it is no longer redacted.

### F-002 `major` — the outward scan was unbounded

`enclosingToken` walked to the true ends of the token, once per surviving
candidate. On an adversarial blob (one large identifier-shaped run holding many
phone-shaped candidates) that added ~60% to an already-quadratic path — 46.5 s
against 28.8 s at 272 KB. The underlying quadratic is the phone regex's own
backtracking and predates this change; the added term does not.

### F-003 `minor` — the digit-count branch was unreachable

`return countDigits(token) > 15` could never decide an outcome: the pre-existing
`digits > 15` gate rejects such a match before `isIdentifierFragment` is called,
and for a letter-free token the enclosing token's digit count equals the match's.
Proven by mutation — replacing the branch with `return false` left 17/17 tests
passing. The test whose comment claimed to cover it
(`"20260912-3668-4760-9056-00112233445566"`) never reaches the guard at all.

### F-004 `minor` — the parity test named a surface it does not exercise

The new test is titled "the MCP redaction seam…" and calls `redactToolOutput`,
whose only caller in the tree is that test. The live path is
`dispatchCallTool` → `validateToolOutput(result, tool.outputSchema)`. Both
converge on the same `validateOutputForTransport` floor, so the regression is
genuinely pinned — but the title claims more than the assertion does.

### F-005 `minor` — a known SSN hole pinned as expected behaviour, untracked

`detectPii("release-123-45-6789-hotfix")` still redacts `123-45-6789` as an SSN:
the same bug class, in `pii.ssn`, whose `\b` boundary a hyphen also satisfies.
Documenting it in a test comment was right; leaving it with no tracked follow-up
meant the gap had no path back to anyone.

### Scope B — no regression

`review-regression` returned an empty array over the 34-file blast radius. No
consumer of `detectPii` asserts on a `pii.phone` finding count, gate decision or
mask that this change alters, and no persisted format embeds the redacted form.

## Dispositions

| Finding | Disposition | Where |
|---|---|---|
| F-001 | acted-on | guard rewritten to positive hex-identifier evidence; 6 regression cases asserted |
| F-002 | acted-on | scan bounded to 64 chars each way; overhead 60% → 9% re-measured |
| F-003 | acted-on | branch deleted; the test's comment corrected to name the gate that actually rejects the input |
| F-004 | acted-on | test renamed and its scope stated in the comment |
| F-005 | acted-on | flow 261 opened; the sweep test now points at it |

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "file": "src/security/detect/pii.ts",
    "line": 261,
    "title": "isIdentifierFragment treats any adjacent letter as proof of identifier, un-redacting real phone numbers",
    "problem": "isIdentifierFragment treats any adjacent letter as proof of identifier, un-redacting real phone numbers.",
    "impact": "A real phone number adjacent to a letter across a hyphen is no longer redacted anywhere the PII detector is the last line of defence — MCP tool output, keryx security check-output, session transcripts. A single letter suffices, so it is also a trivial deliberate evasion.",
    "evidence": "Before/after execution against dd7f3df0 and parent 558c5e9e: contact-415-555-0199-primary, ticket TCK-415-555-0199-open, call 415-555-0199-ext205, a-415-555-0199 and a JSON-key form all returned [\"415-555-0199\"] before and [] after. Reproduced independently by review-logic and by the orchestrator.",
    "suggested_fix": "Require positive evidence of an identifier — the whole token being a UUID, or a hex run of 8+ characters carrying an a-f beside the match — rather than the presence of any letter.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/security/detect/pii.ts:256 (isIdentifierFragment)", "src/security/detect/pii.ts:311 (its sole call site)"],
      "enumeration_method": "keryx ctx rg \"isIdentifierFragment\" src returned exactly two matches: the definition and one call site, gating pii.phone only. That is the complete reachable set."
    }
  },
  {
    "id": "F-002",
    "reviewer": "review-security-code",
    "severity": "major",
    "file": "src/security/detect/pii.ts",
    "line": 233,
    "title": "enclosingToken's unbounded outward scan adds a second quadratic term on adversarial input",
    "problem": "enclosingToken's unbounded outward scan adds a second quadratic term on adversarial input.",
    "impact": "detectPii runs on every tool output, including externally-influenced text. On a 272 KB adversarial blob the guard added ~60% to an already-quadratic cost (46.5s vs 28.8s).",
    "evidence": "Timed on dd7f3df0 vs parent 558c5e9e with identical input construction; ~4x per doubling in both, so the quadratic itself predates the change and the added term does not.",
    "suggested_fix": "Cap the outward scan to a small fixed window each direction; the evidence the guard needs is local.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/security/detect/pii.ts:231 (enclosingToken)", "src/security/detect/pii.ts:311 (the only path that reaches it)"],
      "enumeration_method": "enclosingToken is a private helper with one caller, isIdentifierFragment, which itself has one call site (verified by reading the whole file and by keryx ctx rg). No other rule reaches this scan."
    }
  },
  {
    "id": "F-003",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/security/detect/pii.ts",
    "line": 264,
    "title": "The countDigits(token) > 15 branch is unreachable, and the test claiming to cover it never reaches the guard",
    "problem": "The countDigits(token) > 15 branch is unreachable, and the test claiming to cover it never reaches the guard.",
    "impact": "A future author trusting this branch as a safety net for long all-digit identifiers is wrong, and no test would catch a refactor that garbled it.",
    "evidence": "Mutating the branch to `return false` left 17/17 tests passing. The cited test input produces one greedy 34-digit match, rejected by the pre-existing digits>15 gate before isIdentifierFragment is called.",
    "suggested_fix": "Delete the branch, or add an input that actually reaches it.",
    "confidence": "high"
  },
  {
    "id": "F-004",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/sac/proposal-lifecycle-parity.test.ts",
    "line": 93,
    "title": "The new parity test names the MCP dispatch path but calls a wrapper nothing else calls",
    "problem": "The new parity test names the MCP dispatch path but calls a wrapper nothing else calls.",
    "impact": "A regression confined to the dispatchCallTool/outputSchema wiring — the surface the title names — would not be caught here.",
    "evidence": "redactToolOutput's only caller in the tree is this test; dispatchCallTool calls validateToolOutput(result, tool.outputSchema). Both reach validateOutputForTransport, so the flow-260 regression itself is pinned.",
    "suggested_fix": "Rename and re-scope the comment, or route the assertion through buildMcpContext/dispatchCallTool as the untouched first test does.",
    "confidence": "high"
  },
  {
    "id": "F-005",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/security/detect/pii-identifier-sweep.test.ts",
    "line": 68,
    "title": "A live SSN identifier-fragment false positive is pinned as expected behaviour with no tracked follow-up",
    "problem": "A live SSN identifier-fragment false positive is pinned as expected behaviour with no tracked follow-up.",
    "impact": "The same data-corrupting bug class, in pii.ssn, recorded only in a code comment with no forward pointer, so it can persist indefinitely.",
    "evidence": "detectPii(\"release-123-45-6789-hotfix\") returns pii.ssn \"123-45-6789\"; the ssn regex is bounded by \\b, which a hyphen satisfies.",
    "suggested_fix": "Open a tracked flow for it and reference the id from the test comment.",
    "confidence": "medium"
  }
]
```
