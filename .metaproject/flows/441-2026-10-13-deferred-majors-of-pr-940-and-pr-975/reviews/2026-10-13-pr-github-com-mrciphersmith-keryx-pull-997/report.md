# Review report: PR 997 (flow 441 T1, result parser)

Orchestrator: vantage-review. Generic engine: review-orchestrator (.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md, projection read from /home/altsay/keryx-fdm-t1). Round 1 of 3. Head 141c88521316be6ae903c319fbd48d8d746ac2ae, base 01e0dbfe44d1f2423720e0040655dab4bef5721a. Mode all.

Verdict: request changes. 0 blockers, 2 majors, 8 minors, 1 pre-existing minor. Verifier: 11 confirmed, 0 refuted. Mutation pass: 22 mutants, 11 killed, 11 survived.

## Findings by severity

### Major
- **F-001** (major) `src/review/ledger.ts:152` The candidate pool switches to fenced objects whenever any fenced code block holds any JSON object, even one that is not a reviewer result. Impact: Trigger: a reply without a labelled REVIEW_RESULT fence that quotes a JSON or code excerpt in a code fence (a package.json excerpt, a payload example, `const o = {"a":1}`) before or after its bare result. Fix: Choose the fenced subset only among candidates that pass isReviewerResult (fenced reviewer-result candidates first, else all reviewer-result candidates), and apply the ambiguity check to the same pool.
- **F-002** (major) `src/review/ledger.ts:149` Fail-closed is keyed on any unclosed object-looking fragment (`{"`, `{}`-prefixed) anywhere in a reply that has no labelled fence, and on the last bare REVIEW_RESULT marker followed by a brace anywhere in a marked reply, with no fallthrough to an earlier marker or to the scan. Impact: Trigger: a bare or json-fenced reply (no labelled REVIEW_RESULT fence) whose prose, before or after the result, holds an unbalanced `{"` or the marker followed by a brace (common when a reviewer discusses JSON or this parser). Fix: Treat an unclosed candidate as truncation only when it precedes every complete reviewer-shaped object or carries a status key; on the marker branch fall back to earlier markers and then to the object scan when the last marker's object is not a reviewer result.

### Minor
- **F-003** (minor) `src/review/ledger.ts:137` Three scans in parseReviewResult are superlinear and new in this diff: the marker regex (overlapping [ \t]* and \s*), the fence regex at line 150 (/```[^\n]*\n[\s\S]*?```/g) and the per-object fences.some filter at line 151. Impact: parseReviewResult is synchronous. Fix: Use /REVIEW_RESULT(?:[ \t]*[:=])?\s*(?=\{)/g for the marker; compute fence ranges once and walk found and fences with one pointer; bound the fence opener with [^\n`]*.
- **F-004** (minor) `src/review/ledger.test.ts:92` The AC11 and AC12 fixtures nest slice entries with only id and status, so the AC14 filter alone rejects them: the truncation and skip-whole logic can be removed with the suites green. Impact: The next edit to objectEnd, topLevelObjects, the marker choice or the fence preference passes CI unnoticed; the parser decides whether a reviewer reply counts at all. Fix: Give nested slice entries in both fixtures a findings array or reviewer so only truncation logic can reject them; add one fixture per surviving mutant (escaped quote in a summary, unbalanced prose brace before the result, reviewer-only object without status, two markers, json fence beside a differing bare object, whole-file JSON with no status through the command).
- **F-005** (minor) `src/commands/review-slice.ts:172` The error text is circular, its parenthesis is ambiguous, and it describes the parseReviewResult rule although wholeFileResult accepts a whole-file object with a status alone (deliberate, per the retry-plan help and --reviewer). Impact: An operator whose reply is truncated or ambiguous is told it lacks a reviewer or findings and may add fields that are already there. Fix: Reword: 'result holds no usable reviewer result (plain JSON with a status, or a reply with a REVIEW_RESULT block or a bare object carrying a reviewer or findings; a truncated or ambiguous reply is refused)'; update the JSDoc and the toContain assertion at review-slice.test.ts:80 together.
- **F-006** (minor) `src/review/ledger.ts:125` The parseReviewResult doc comment is inexact on the rules the PR exists to define: 'the only status' contradicts the accepted same-status-twice case (last wins); 'the last fenced block' is the last fenced object passing isReviewerResult; the labelled-fence branch keeps the status-only rule, so 'only a top-level object that carries reviewer or findings counts' does not hold for it; the no-fallthrough marker rule is not stated. Impact: The next editor reads the comment as the contract and is misled on the AC13 ambiguity rule. Fix: Rewrite as a precedence list: (1) last labelled fence, status required; (2) object after the last bare marker, status plus reviewer or findings, no fallthrough; (3) otherwise the last reviewer-shaped object among fenced objects or, if none are fenced, all top-level objects, where differing statuses among unfenced objects or an unclosed object give no result.
- **F-007** (minor) `src/commands/review-slice.ts:180` The acceptance rule for a reviewer result lives in four places that differ: the labelled-fence branch (ledger.ts:133, status only), isReviewerResult (ledger.ts:116-119, status plus reviewer or findings, private), the scan's status collection (ledger.ts:153, via a cast) and wholeFileResult (status only, a 130-column one-liner). Impact: A later change to the rule (for example the AC14 status-only decision) must be repeated by hand in each place; nothing ties the intentional status-only exceptions together. Fix: Export a small hasStatus helper from ledger.ts, build isReviewerResult on it, use it at ledger.ts:133 and :153 and in wholeFileResult; comment the loadRaws filter.
- **F-008** (minor) `src/review/ledger.ts:128` parseReviewResult runs three selection strategies in 30 lines (labelled fence, bare marker, top-level scan with fence-offset arithmetic and a status Set), repeating the slice-and-JSON.parse pair of topLevelObjects. Impact: Each future rule change must be threaded through one function that holds all three decision trees; the prose-brace guard behind the 'prose brace before the result' test is easy to simplify away. Fix: Split into labelledResult, markedResult and scannedResult plus an inFence helper; comment OBJECT_START or replace it with a looksLikeObjectStart helper.
- **F-009** (minor) `src/flow/verify-exec-files.test.ts:15` AC18 says the test fails when a named *.test.ts file does not exist; KNOWN_MISSING exempts four flow-375 files (board, board-stale, board-model, board-dashboard), which the criteria do not authorise and the PR does not record as an operator decision. Impact: Flow 375 keeps the vacuous gate AC18 exists to prevent. Fix: Record the operator's decision in the PR (write the four tests or re-seal flow 375 with keryx flow ac update), and strip quotes and trailing punctuation or assert on skipped tokens.
- **F-011** (minor) `src/review/ledger.test.ts:114` The title says only objects with reviewer or findings count, but the last assertion of the test asserts the opposite for a labelled fence (status-only accepted), inside a describe named for bare replies. Impact: A failure report names a rule the test partly contradicts. Fix: Move the fenced assertion into its own test titled 'AC14: a fenced REVIEW_RESULT block keeps the status-only rule'.

## Questions
- Q1 (F-002): AC11 requires fail-closed for a truncated result. The code also fails closed on an unclosed fragment or a prose marker anywhere in an unlabelled reply, which the old parser recovered. Does the operator accept that cost, or should an unclosed candidate count as truncation only when it precedes every complete reviewer-shaped object? AC16 (T4 replay) warns against tuning the parser to keep a lucky file parsing, so the line is the operator's.
- Q2 (AC13/AC14): AC13 read literally returns the object after a marker; AC14 rejects a status-only object. The code follows AC14 and the schema (a marker before a status-only object gives undefined; a labelled fence still accepts it). Confirm the reading and clarify AC15 wording if the asymmetry is unintended.
- Q3 (AC18): the four-file KNOWN_MISSING exemption is outside AC18's wording and the PR body does not record an operator decision. Write the four flow-375 board tests, re-seal flow 375, or record the exemption.

## Pre-existing (never block)
- **F-010** (minor) `src/review/ledger.ts:154` The ambiguity gate compares only the status string, so two reviewer-shaped objects with the same status and different findings are not ambiguous and the last wins; a same-status fixture echoed after the real result replaces it. Impact: A findings: [] echo after a real result with findings drops the real findings. Fix: Treat two reviewer-shaped objects as ambiguous unless they are deep-equal, or count only trailing objects.
The labelled-fence regex at ledger.ts:129 has the same quadratic shape as the marker regex (security-code measured 6.7 s at 100 KB); it is on main.

## Verified clean
- AC11, AC12, AC13 (two statuses), AC14, AC15 each have a test that fails when the named gate is removed, except the gates listed under F-004.
- AC17: the three behaviours are killed by the suite (M20/M25 result read through the command, M23 exit code 2, M26/M27 same-size scopeFingerprint change).
- Labelled ```REVIEW_RESULT fenced branch is unchanged and unaffected by surrounding prose; braces and escaped quotes inside strings parse correctly; nested finding objects with their own status are not mistaken for the result.
- Dependency direction is clean (commands import the ledger, not the reverse); no path built from reply content; no dynamic execution of reply content.
- objectEnd and topLevelObjects are linear (2 MB of braces under 100 ms) and faster than main on unclosed braces (10.8 s on main vs 1 ms at 128 KB).
- verify-exec-files scan: 300 exec lines, 0 missed test tokens; the stale-entry test keeps the allowlist honest.
- Baseline: 5 suites, 152 tests green on the head; 51 pass in the three changed test files.

## Not run
- review-vantage-testing (Vantage frontend doctrine; this is a Bun CLI, covered by review-testing-practices) and the other Vantage overlays: the repository has no Vantage frontend, core, flow, sigma, domains, styling, temporal or design-system paths.
- review-backend, review-frontend, review-frontend-conventions and review-core-boundaries: no NestJS or React stack, stack scoping excluded them.
- AC16 replay of closed rounds: T4; the checked-in review packages hold no raw replies.
- Research ledger (ledger build): the reviewers' raw replies were returned in-session and were not saved as raw/*.txt, so the package stays PENDING on raw reconciliation and dispatch evidence.

## Stage counts
Reviewers dispatched 9 (all returned a REVIEW_RESULT): raw findings 33 (1 blocker 0, major 3, minor 19, info 11 before dedupe), consolidated 11, verifier confirmed 11, removed 0.

```json keryx:findings
[
  {
    "id": "F-001",
    "severity": "major",
    "file": "src/review/ledger.ts",
    "line": 152,
    "quote": "const pool = fenced.length > 0 ? fenced : found;",
    "problem": "The candidate pool switches to fenced objects whenever any fenced code block holds any JSON object, even one that is not a reviewer result. A complete bare result outside the fence is then never considered. If the fenced object is not reviewer-shaped the parse gives undefined; if it is a reviewer-shaped sample, the sample is returned instead of the real result.",
    "impact": "Trigger: a reply without a labelled REVIEW_RESULT fence that quotes a JSON or code excerpt in a code fence (a package.json excerpt, a payload example, `const o = {\"a\":1}`) before or after its bare result. Outcome: old parser returned the real result; the new one returns undefined (loadRaws raises the 'no parseable REVIEW_RESULT block' gap, or silently sets an unnamed file aside; retry-plan --result exits 2) or, for a reviewer-shaped sample, ingests the sample under the wrong reviewer name.",
    "suggested_fix": "Choose the fenced subset only among candidates that pass isReviewerResult (fenced reviewer-result candidates first, else all reviewer-result candidates), and apply the ambiguity check to the same pool.",
    "evidence": "Probes against old-parser.ts and the head parser (regression probe4/probe5, logic probe2 cases A-D, J): '```json\\n{\"retries\": 3}\\n```\\n<full result>' old DONE/review-logic, new undefined; fenced {status:DONE,reviewer:example,findings:[]} before the real result old DONE/review-logic, new DONE/example. No existing test fences a non-result object.",
    "confidence": "high",
    "reviewer": "review-regression",
    "class_scope": {
      "sites": [
        "src/review/ledger.ts:150-156",
        "src/commands/review-ledger.ts:92",
        "src/commands/review-slice.ts:171"
      ],
      "enumeration_method": "The fenced/unfenced pool choice has one site; the two production callers of parseReviewResult found with keryx ctx rg."
    },
    "pre_existing": false
  },
  {
    "id": "F-002",
    "severity": "major",
    "file": "src/review/ledger.ts",
    "line": 149,
    "quote": "if (truncated) return undefined;",
    "problem": "Fail-closed is keyed on any unclosed object-looking fragment (`{\"`, `{}`-prefixed) anywhere in a reply that has no labelled fence, and on the last bare REVIEW_RESULT marker followed by a brace anywhere in a marked reply, with no fallthrough to an earlier marker or to the scan. Neither is evidence that the reviewer's own result is truncated. A later prose mention 'REVIEW_RESULT: {...}' also takes over: undefined when it does not parse, or the mentioned object when it is reviewer-shaped.",
    "impact": "Trigger: a bare or json-fenced reply (no labelled REVIEW_RESULT fence) whose prose, before or after the result, holds an unbalanced `{\"` or the marker followed by a brace (common when a reviewer discusses JSON or this parser). Outcome: a complete, valid result is reported as a parse gap and the reviewer is re-dispatched or marked not run; main recovered these replies. It fails closed, never accepts a wrong result in the unbalanced case. AC11 requires fail-closed only for a truncated result object, which this check cannot tell from a stray fragment; the operator may accept the trade-off (see Questions).",
    "suggested_fix": "Treat an unclosed candidate as truncation only when it precedes every complete reviewer-shaped object or carries a status key; on the marker branch fall back to earlier markers and then to the object scan when the last marker's object is not a reviewer result.",
    "evidence": "Probes: result + 'note {\"x' -> undefined (old DONE); 'I saw {\"x then' + result -> undefined; result + prose 'REVIEW_RESULT: {see above}' -> undefined; result + prose 'REVIEW_RESULT: {\"status\":\"BLOCKED\",\"reviewer\":\"x\"}' -> BLOCKED/x (security probe); fenced REVIEW_RESULT branch unaffected. Six reviewers reproduced it independently (regression, logic, architecture, testing-practices, highload, security-code).",
    "confidence": "high",
    "reviewer": "review-regression",
    "class_scope": {
      "sites": [
        "src/review/ledger.ts:109",
        "src/review/ledger.ts:139-146",
        "src/review/ledger.ts:149",
        "src/commands/review-ledger.ts:92",
        "src/commands/review-slice.ts:171"
      ],
      "enumeration_method": "Every undefined return after the labelled-fence branch of parseReviewResult, plus the two production callers."
    },
    "pre_existing": false
  },
  {
    "id": "F-003",
    "severity": "minor",
    "file": "src/review/ledger.ts",
    "line": 137,
    "quote": "const markers = [...raw.matchAll(/REVIEW_RESULT[ \\t]*[:=]?\\s*(?=\\{)/g)];",
    "problem": "Three scans in parseReviewResult are superlinear and new in this diff: the marker regex (overlapping [ \\t]* and \\s*), the fence regex at line 150 (/```[^\\n]*\\n[\\s\\S]*?```/g) and the per-object fences.some filter at line 151. The labelled-fence regex at line 129 has the same shape and is pre-existing on main.",
    "impact": "parseReviewResult is synchronous. Measured: 'REVIEW_RESULT' + N spaces not followed by a brace takes 12.7 s at 100 KB and does not finish at 300 KB; 32,000 fenced one-line objects (640 KB) take 4.0 s (main 6 ms); a 150 KB realistic reply takes 0 ms. Only a degenerate or adversarial reply triggers it, so minor (review-security-code rated the whitespace case major; review-performance, highload and the author-side reachability argued minor).",
    "suggested_fix": "Use /REVIEW_RESULT(?:[ \\t]*[:=])?\\s*(?=\\{)/g for the marker; compute fence ranges once and walk found and fences with one pointer; bound the fence opener with [^\\n`]*.",
    "evidence": "bun probes in the scratchpad (perfrev/probe.ts, p/): time roughly quadruples per doubling for markerws, fencedobjs, interleaved, barefences; old parser under 10 ms on the same inputs. Linear: objectEnd and topLevelObjects (2 MB of braces under 100 ms).",
    "confidence": "high",
    "reviewer": "review-performance",
    "pre_existing": false
  },
  {
    "id": "F-004",
    "severity": "minor",
    "file": "src/review/ledger.test.ts",
    "line": 92,
    "quote": "const truncated = 'Result: {\"status\":\"DONE\",\"reviewer\":\"r\",\"slices\":[{\"id\":\"slice-01\",\"status\":\"DONE\"},{\"id\":\"slice-02\",\"status\":\"DONE\"}';",
    "problem": "The AC11 and AC12 fixtures nest slice entries with only id and status, so the AC14 filter alone rejects them: the truncation and skip-whole logic can be removed with the suites green. In the official mutation pass M06 (unclosed object skipped), M09 (unparseable candidate entered), M01 (objectEnd returns the last index) and M15 (truncation ignored once any object is found) survive. Further decisions are unpinned: M03 (escape flag), M07 (re-entering nested objects), M08 (OBJECT_START), M12 (status clause), M13 (first marker instead of last), M16 (fenced preference), M21 (wholeFileResult status guard).",
    "impact": "The next edit to objectEnd, topLevelObjects, the marker choice or the fence preference passes CI unnoticed; the parser decides whether a reviewer reply counts at all. The code is correct today, and no shipped reply reaches a wrong result through these gaps.",
    "suggested_fix": "Give nested slice entries in both fixtures a findings array or reviewer so only truncation logic can reject them; add one fixture per surviving mutant (escaped quote in a summary, unbalanced prose brace before the result, reviewer-only object without status, two markers, json fence beside a differing bare object, whole-file JSON with no status through the command).",
    "evidence": "keryx review mutate (mutation-1.md): 22 mutants, 11 killed, 11 survived: M01 M03 M06 M07 M08 M09 M12 M13 M15 M16 M21.",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "class_scope": {
      "sites": [
        "src/review/ledger.test.ts:92",
        "src/review/ledger.test.ts:105",
        "src/commands/review-slice.test.ts"
      ],
      "enumeration_method": "Mutation pass over the six changed functions, survivors listed in mutation-1.md."
    },
    "pre_existing": false
  },
  {
    "id": "F-005",
    "severity": "minor",
    "file": "src/commands/review-slice.ts",
    "line": 172,
    "quote": "result holds no reviewer result (a JSON object with a status and a reviewer or findings)",
    "problem": "The error text is circular, its parenthesis is ambiguous, and it describes the parseReviewResult rule although wholeFileResult accepts a whole-file object with a status alone (deliberate, per the retry-plan help and --reviewer). The same message covers truncated or ambiguous replies without saying so. The readResult JSDoc at line 163 still lists only 'plain JSON or a REVIEW_RESULT block'. retry-plan --result accepts a status-only file that ledger build records as a gap.",
    "impact": "An operator whose reply is truncated or ambiguous is told it lacks a reviewer or findings and may add fields that are already there.",
    "suggested_fix": "Reword: 'result holds no usable reviewer result (plain JSON with a status, or a reply with a REVIEW_RESULT block or a bare object carrying a reviewer or findings; a truncated or ambiguous reply is refused)'; update the JSDoc and the toContain assertion at review-slice.test.ts:80 together.",
    "evidence": "review-slice.ts:163-182 against review-ledger.ts:90-105; review-slice.test.ts:80 asserts toContain(\"holds no reviewer result\").",
    "confidence": "high",
    "reviewer": "review-style",
    "pre_existing": false
  },
  {
    "id": "F-006",
    "severity": "minor",
    "file": "src/review/ledger.ts",
    "line": 125,
    "quote": "the last fenced block when there are fenced blocks, else the only status the reply holds.",
    "problem": "The parseReviewResult doc comment is inexact on the rules the PR exists to define: 'the only status' contradicts the accepted same-status-twice case (last wins); 'the last fenced block' is the last fenced object passing isReviewerResult; the labelled-fence branch keeps the status-only rule, so 'only a top-level object that carries reviewer or findings counts' does not hold for it; the no-fallthrough marker rule is not stated.",
    "impact": "The next editor reads the comment as the contract and is misled on the AC13 ambiguity rule.",
    "suggested_fix": "Rewrite as a precedence list: (1) last labelled fence, status required; (2) object after the last bare marker, status plus reviewer or findings, no fallthrough; (3) otherwise the last reviewer-shaped object among fenced objects or, if none are fenced, all top-level objects, where differing statuses among unfenced objects or an unclosed object give no result.",
    "evidence": "ledger.ts:122-157 against the test 'AC13: the same status twice is not ambiguous'.",
    "confidence": "high",
    "reviewer": "review-clean-code",
    "pre_existing": false
  },
  {
    "id": "F-007",
    "severity": "minor",
    "file": "src/commands/review-slice.ts",
    "line": 180,
    "quote": "return whole !== null && typeof whole === \"object\" && !Array.isArray(whole) && typeof (whole as { status?: unknown }).status === \"string\" ? whole as ReviewerResult : undefined;",
    "problem": "The acceptance rule for a reviewer result lives in four places that differ: the labelled-fence branch (ledger.ts:133, status only), isReviewerResult (ledger.ts:116-119, status plus reviewer or findings, private), the scan's status collection (ledger.ts:153, via a cast) and wholeFileResult (status only, a 130-column one-liner). loadRaws keeps a fifth post-filter at review-ledger.ts:98 that now guards only the fenced branch.",
    "impact": "A later change to the rule (for example the AC14 status-only decision) must be repeated by hand in each place; nothing ties the intentional status-only exceptions together.",
    "suggested_fix": "Export a small hasStatus helper from ledger.ts, build isReviewerResult on it, use it at ledger.ts:133 and :153 and in wholeFileResult; comment the loadRaws filter.",
    "evidence": "keryx ctx rg for the status guards: ledger.ts:119, 133, 153 and review-slice.ts:180.",
    "confidence": "high",
    "reviewer": "review-architecture",
    "pre_existing": false
  },
  {
    "id": "F-008",
    "severity": "minor",
    "file": "src/review/ledger.ts",
    "line": 128,
    "quote": "export function parseReviewResult(raw: string): ParsedResult | undefined {",
    "problem": "parseReviewResult runs three selection strategies in 30 lines (labelled fence, bare marker, top-level scan with fence-offset arithmetic and a status Set), repeating the slice-and-JSON.parse pair of topLevelObjects. OBJECT_START (line 82) is a shared sticky regex whose lastIndex the caller mutates, with no comment on why only a brace followed by a quote or brace is a candidate.",
    "impact": "Each future rule change must be threaded through one function that holds all three decision trees; the prose-brace guard behind the 'prose brace before the result' test is easy to simplify away.",
    "suggested_fix": "Split into labelledResult, markedResult and scannedResult plus an inFence helper; comment OBJECT_START or replace it with a looksLikeObjectStart helper.",
    "evidence": "ledger.ts:82, 105-112, 128-157.",
    "confidence": "medium",
    "reviewer": "review-clean-code",
    "pre_existing": false
  },
  {
    "id": "F-009",
    "severity": "minor",
    "file": "src/flow/verify-exec-files.test.ts",
    "line": 15,
    "quote": "const KNOWN_MISSING: Record<string, readonly string[]> = {",
    "problem": "AC18 says the test fails when a named *.test.ts file does not exist; KNOWN_MISSING exempts four flow-375 files (board, board-stale, board-model, board-dashboard), which the criteria do not authorise and the PR does not record as an operator decision. The scan (TEST_FILE needs whitespace on both sides) silently skips quoted, glob, punctuation-adjacent and .spec/.test.js paths, and a bracketed exec line without backticks.",
    "impact": "Flow 375 keeps the vacuous gate AC18 exists to prevent. The exemption is guarded (the stale-entry test fails when a listed file appears or is no longer missing; a fifth missing file still fails). No quoted or glob path exists among the 300 current exec lines, so the scan gap is latent.",
    "suggested_fix": "Record the operator's decision in the PR (write the four tests or re-seal flow 375 with keryx flow ac update), and strip quotes and trailing punctuation or assert on skipped tokens.",
    "evidence": "Four files absent from src/product; all 300 exec lines scanned with the test's own regexes: 0 missed test tokens (logic, architecture, security probes).",
    "confidence": "medium",
    "reviewer": "review-architecture",
    "pre_existing": false
  },
  {
    "id": "F-010",
    "severity": "minor",
    "file": "src/review/ledger.ts",
    "line": 154,
    "quote": "if (fenced.length === 0 && statuses.size > 1) return undefined;",
    "problem": "The ambiguity gate compares only the status string, so two reviewer-shaped objects with the same status and different findings are not ambiguous and the last wins; a same-status fixture echoed after the real result replaces it.",
    "impact": "A findings: [] echo after a real result with findings drops the real findings. Main also took the last object.",
    "suggested_fix": "Treat two reviewer-shaped objects as ambiguous unless they are deep-equal, or count only trailing objects.",
    "evidence": "Probe: real DONE_WITH_CONCERNS with one finding then an echoed same-status object with findings [] returns the echo.",
    "confidence": "high",
    "reviewer": "review-security-code",
    "pre_existing": true
  },
  {
    "id": "F-011",
    "severity": "minor",
    "file": "src/review/ledger.test.ts",
    "line": 114,
    "quote": "test(\"AC14: only an object with `reviewer` or a `findings` array counts\", () => {",
    "problem": "The title says only objects with reviewer or findings count, but the last assertion of the test asserts the opposite for a labelled fence (status-only accepted), inside a describe named for bare replies.",
    "impact": "A failure report names a rule the test partly contradicts.",
    "suggested_fix": "Move the fenced assertion into its own test titled 'AC14: a fenced REVIEW_RESULT block keeps the status-only rule'.",
    "evidence": "ledger.test.ts:114 (title) and :119 (status-only assertion) inside the describe at :88.",
    "confidence": "high",
    "reviewer": "review-style",
    "pre_existing": false
  }
]
```
