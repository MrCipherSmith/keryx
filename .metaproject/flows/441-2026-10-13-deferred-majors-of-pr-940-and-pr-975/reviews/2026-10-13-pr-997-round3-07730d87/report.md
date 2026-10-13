# Review report: PR 997 round 3 (flow 441 T1, result parser)

Orchestrator: vantage-review. Generic engine: review-orchestrator (/home/altsay/keryx-fdm-t1/.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md). Keryx projection path: /home/altsay/keryx-fdm-t1/.metaproject. Round 3 of 3 (final, cap). Head 07730d87d952b2c0eaf16418e40ff978480c9a70 (production code identical to 44bed779; 07730d87 adds only the round-2 review package), base 01e0dbfe. Mode all. Review id 2026-10-13-pr-997-round3-07730d87. Model assignment: adaptive (tier deep, inherit; no model id pinned).

Vantage overlays: none selected. The repository is a Bun CLI with no Vantage frontend, core, flow, sigma, domains, styling, temporal or design-system paths (scope A is src/review/ledger.ts, src/commands/review-ledger.ts, src/commands/review-slice.ts and their tests, plus src/flow/verify-exec-files.test.ts). Vantage rule files read: none. Project-local reviewer packages: none registered (the project half of the reviewer inventory is empty), so the global definitions applied.

Verdict: request changes (the operator may instead accept F-001 as a documented residual, see Q1). 0 blockers, 4 majors (F-001, F-008, F-009, F-010), 6 minors (F-002 to F-007), 4 info (F-011 to F-014); the pre-existing F-016 and F-017 never block. Verifier: 10 confirmed, 0 refuted, 4 left alone. Mutation pass: 91 mutants, 79 killed, 12 survived (7 observable and cited, 5 argued equivalent).

Severity audit raised F-008, F-009 and F-010 from minor to major because the mutants they cite (O08, B06 and F05, with O09, O11, N03, H01) survived; the testing reviewer had rated them minor, and the raise is mechanical (an unpinned behaviour, no observed failure), so the operator may treat them as one test-gap item. F-001 (major, raised by review-security-code as major; the other reviewers rated it minor) is the only defect with a wrong-result outcome and is a divergence from base, not from round 2. Round 2 is closed except for what is listed under "Round 2 dispositions". The ledger is NOT READY and the package stays PENDING: the installed 0.3.112 parser cannot read 8 of the 9 reviewer replies (see Not run).

## Findings by severity
### Major
- **F-001** (major) `src/review/ledger.ts:144` fenceRanges pairs ANY triple backtick (an inline mention included, fence length ignored, closer need not start a line) with the next one after the end of its line. One inline triple backtick in prose flips the pairing of every later fence, so afterMarker (line 203) and scannedResult (line 222), which both trust these ranges, mis-classify markers: a quoted marker inside a real fence is read as outside (or a real marker as inside). The round-3 rule 'a marker inside a fenced block is not a marker' therefore holds only for well-formed line-start fences. Impact: Fail open (security-code): a forged 'REVIEW_RESULT: {status DONE, no findings}' line quoted inside a three backticksts or three backticksdiff fence, plus an earlier inline three backticksREVIEW_RESULT mention, plus a real bare NEEDS_CONTEXT result -> parseReviewResult returns the forged DONE with 0 findings (control without the inline mention: undefined = a gap); the real NEEDS_CONTEXT/blocker is lost. Fail closed (highload, architecture, performance): an inline three backticksxthree backticks span before a real marker, with a fenced sample of another status after it, turns the reply into a gap where d5a8cfdc returned the real result. The accepted AC15 residual covers only an UNFENCED quote. Fix: Make fenceRanges line-based (CommonMark): an opener is a line starting (after up to 3 spaces) with 3+ backticks and no further backtick; a closer is a line-start run of at least the opener's length; an unclosed opener runs to the end of the reply; strip a trailing \r. Keep the single forward pass so fenceTester stays linear. Pin the four reproductions in ledger.test.ts and re-check the existing fence tests (ledger.test.ts:392-400 pin a closing fence followed by text on the same line). Verifier: confirmed (execution).
- **F-008** (major) `src/review/ledger.ts:105` Unpinned behaviour: the truncation test (a cut-off object that claims a result key means no result) is pinned only for compact JSON and a cut-off object carrying all keys. Mutants O08 (KEY_COLON /\s*:/y -> /:/y), O09 (RESULT_KEYS reduced to status) and O11 (RESULT_KEYS reduced to reviewer, findings) survive with the suite green. Impact: A cut-off reply whose first key is written as "status" : or whose only result key is reviewer or status would be read as prose, and a complete nested result inside it returned instead of a gap. Fix: One table test in the 'an unclosed object that carries the result keys' block: three cut-off outer objects (space before the colon; only reviewer; only status) each wrapping a complete nested reviewer result, each expecting undefined. Verifier: confirmed (execution).
- **F-009** (major) `src/review/ledger.ts:204` Unpinned behaviour in two round-3 branches. B06 (compare the bare status with fencedResults[0] instead of the last fenced result) and N03 (slice(-MAX_MARKERS) before the fence filter instead of after) survive. The 63/64/65 test uses unfenced markers only, so the order of filter and slice is not exercised. Impact: N03: a real marker followed by a fenced block quoting 64 or more marker lines would be lost and the reply becomes a gap. B06: with two differing fenced samples, the ambiguity check would compare against the wrong one. Fix: N03: extend the 'only the last 64 markers' test with one real marker plus 64 fenced marker lines expecting the real result. B06: two fenced results with different statuses plus a bare result equal to the last one, expecting the last fenced result. Verifier: confirmed (execution).
- **F-010** (major) `src/review/ledger.ts:149` Unpinned behaviour: F05 (closing-fence search starting at open + 3 instead of the next line) and H01 (hasStatus accepting any defined status, not a string) survive. The rule that the closing fence is searched after the opening line, so an inline three backticks pair in prose is read as an opener, has no test either way (related to F-001). Impact: F05 changes which object counts as fenced when a prose line holds an inline three backticksxthree backticks span. H01: a numeric status in a labelled fence would be accepted as a result. Fix: H01: assert that a labelled fence with {"status":1} gives undefined. F05: pin the intended outcome of an inline three backticks span on a prose line (together with the F-001 fix). Verifier: confirmed (execution).

### Minor
- **F-002** (minor) `src/review/ledger.ts:105` Carried round-2 F-004, unchanged. objectEnd documents claimsResult as 'the object itself (not an object nested in it)', but topLevelObjects re-enters every unclosed fragment (start += 1), so a nested cut-off object carrying a result key still ends the scan as truncated. Neither the topLevelObjects doc nor a test says so. Impact: A complete bare result followed by prose like {"meta":{"status":"ok" gives no result (re-dispatch), while {"meta":{"x":1 is read. Fails closed, never a wrong result. Fix: One sentence in the topLevelObjects doc (a nested cut-off object is met again at its own brace, so a result key anywhere in a cut-off fragment ends the scan) and one test pinning the first case. Verifier: confirmed (execution).
- **F-003** (minor) `src/review/ledger.ts:208` Carried round-2 F-008, unchanged. objectEnd is both a brace matcher and a result-key detector; afterMarker discards claimsResult yet the detector runs per marker candidate. KEY_COLON (l.86) and OBJECT_START (l.83) are module-level sticky regexes whose lastIndex every caller must set before use. The try { JSON.parse } catch pair is written three times (l.137, 188, 210-213). Impact: Maintainability only: a fourth caller can forget to reset lastIndex; changing the parse-failure policy means three edits. No behaviour defect found. Fix: Pass the key detector to objectEnd as an optional callback or split it; add a tryParse(raw, from, to) helper; build the colon test locally. Verifier: not checked (info or maintainability; no executable check).
- **F-004** (minor) `src/review/ledger.test.ts:388` Titles at lines 388 ('a fence that never closes fences nothing: its object is bare, so two statuses stay ambiguous') and 392 ('an object right after a closing fence is bare, not fenced') name a rule their assertion cannot fail on: both inputs hold two reviewer-shaped objects with different statuses, so the reply is undefined whether the object is counted as fenced or as bare. Line 397 does discriminate. Impact: A regression in the unclosed-fence rule or the closing-fence boundary leaves these two green while their titles claim to guard it. Another test pins the unclosed-fence rule (line 407), so this is a title/assertion mismatch, not a coverage hole. Fix: Give the object in question the same status as the other and assert which reviewer wins, or retitle both to what they assert. Verifier: confirmed (execution).
- **F-005** (minor) `src/review/ledger.test.ts:435` good_json (added in 44bed779) is a snake_case helper in a camelCase codebase, declared at file level after the describe that uses it (lines 377-379), and redundant: the enclosing describe at line 262 already holds goodJson (same fields, another key order). Impact: Naming-convention break and a second spelling of one fixture. Fix: Delete good_json and use goodJson at lines 377-379. Verifier: confirmed (site-check).
- **F-006** (minor) `src/flow/verify-exec-files.test.ts:2` Carried round-2 STY-4, unchanged. The header comment 'A command naming a missing file passes vacuously in `bun test`, so the gate proves nothing.' is false for a command that names a single missing file. Impact: A maintainer reads the guard as covering a hazard that does not exist for single-file commands and misses the real one (a missing file next to an existing one). Fix: Reword: bun test skips a missing file when the command also names other test files, so the gate passes without running it. Verifier: confirmed (execution).
- **F-007** (minor) `src/flow/verify-exec-files.test.ts:15` Carried round-2 F-010 / ARCH-3 (a). AC18 (acceptance-criteria.md:49) says the test fails when a named *.test.ts file does not exist; the four flow-375 KNOWN_MISSING exemptions make it pass for files that do not exist. The PR body states the list and 'Not done: F-010', but no operator decision on the AC18 deviation is recorded (PR body, flow journal). Impact: AC18 is met only through an unsigned exemption; the frozen criterion and the test disagree. Fix: Record the operator's decision on flow 375 (write the four tests, or re-seal with keryx flow ac update) before merge, or state in the PR body that AC18 is met with the named exemption by operator decision. Verifier: confirmed (site-check).

### Info
- **F-011** (info) `src/review/ledger.ts:195` Doc precision. MARKER's comment says 'after at most a quote, list or heading prefix' while the class [ \t>*#-]* takes any run of blanks and > * # -; an ordered-list prefix '1. ', bold '**REVIEW_RESULT:** {', an em dash or a code span is not a marker (fails closed: read by the scan, a gap if a differing bare object exists). Rule 2 of the parseReviewResult doc omits the prefix class; scannedResult's one-line summary omits that a differing bare object cancels the fenced one. Impact: A reader may expect numbered lists or bold markers to count. None at run time. Fix: Word the comment 'any run of blanks and > * # -'; add the prefix clause to rule 2; comment the lookbehind as 'start of input or after a newline'. Verifier: not checked (info or maintainability; no executable check).
- **F-012** (info) `src/review/ledger.ts:173` The now exported isReviewerResult is also a private function in src/review/managed.ts:1676 with a different contract (findings array only, no status). Same directory, same name, two meanings. Impact: Auto-import or a copy between the files picks the wrong guard; nothing wrong today. Fix: Optional rename of one of the two (isAttributableResult or isReviewerReply). Verifier: confirmed (site-check).
- **F-013** (info) `src/review/ledger.ts:118` Worst-case latency scales with MAX_UNCLOSED + MAX_MARKERS = 64 + 64 scans to the end of the reply. Measured: 1 MB with 64 unclosed prose braces 122 ms (8 braces 15.7 ms, one scan 3.1 ms); 64 unclosed markers 236 ms at 1 MB and 941 ms at 4 MB (linear, 4.0x). An adversarial 11 KB reply takes 0.29 ms. No quadratic path in any of 46 shapes tried at 1-8 MB. Impact: Visible only at 1 MB+ on a reviewer reply (typical 5-10 KB). The 64 caps cost 8x the old 8 only in that regime. The comment 'about 3 ms per MB' is accurate per scan. Fix: None needed. Optional: reword the comment to '3 ms per MB per scan'. Verifier: not checked (info or maintainability; no executable check).
- **F-014** (info) `src/review/ledger.test.ts:376` Three small title/assertion drifts. Line 376: the third input ({"verdict":"DONE"}) is valid JSON without a status. Line 74: the title states a REVIEW_RESULT fence needs a status and a json fence a reviewer or findings, but the body asserts neither refusal (pinned at 174-184). Lines 284 and 423 repeat the same prefix list, and 283/421 overlap. Impact: Reading cost only. Fix: Title 376 'a labelled fence that does not hold a result decides'; shorten 74; one shared PREFIXES constant. Verifier: not checked (info or maintainability; no executable check).


## Questions

### Q1 (operator): the fence-pairing defect (F-001)
fenceRanges pairs any triple backtick, an inline mention in prose included, so one such mention flips the pairing of every later fence. Two outcomes, both proven by execution (the verifier re-ran them at 07730d87, d5a8cfdc and base 01e0dbfe): fail open (a forged marker quoted inside a real fence plus an earlier inline mention plus a real bare NEEDS_CONTEXT result returns the forged DONE with 0 findings) and fail closed (an inline span before a real marker, with a fenced sample of another status after it, gives a gap where d5a8cfdc returned the real result). Relative to round 2 the exposure is narrower (d5a8cfdc fails open on all these inputs, including the controls without the inline mention); relative to base it is a divergence. The accepted AC15 residual covers only an unfenced quote on its own line, not this. Suggested fix: make fenceRanges line-based (a fence opens on a line that starts with three or more backticks and closes on a line-start run at least as long; an unclosed fence runs to the end of the reply), keep the single forward pass, and update the existing tests that pin a closing fence followed by text on the same line (ledger.test.ts about 392-400). Decision for the operator: fix it in this PR (the final round allows no round 4, so it would need a fix commit and a spot check), or accept it as a documented residual next to the AC15 one and record that in the PR.

### Q2 (operator): the AC18 deviation (F-007)
The four flow-375 KNOWN_MISSING exemptions still make AC18 pass for files that do not exist, and no operator decision is recorded in the PR body or the flow journal. Either write the four board tests or re-seal flow 375 with keryx flow ac update, or state in the PR body that AC18 is met with the named exemption by operator decision. The AC18 text is at line 49 of acceptance-criteria.md (the architecture reviewer wrote 55; the verifier corrected it).

### Q3 (informational): caps and cost
MAX_UNCLOSED and MAX_MARKERS are now 64 and pinned at 63, 64 and 65 (T03 to T05, T07, A05 to A07 killed). Worst case 64 plus 64 scans: 122 ms for 1 MB with 64 unclosed braces, 236 ms at 1 MB and 941 ms at 4 MB with 64 unclosed markers (linear), against 5 to 10 KB for a typical reply. No quadratic path in 46 shapes at 1 to 8 MB, and 20000 unclosed markers took 53 ms (F-013, info).

## Pre-existing (never block)
- F-016 (triple backtick inside a JSON string of the labelled fence makes the lazy fence regex stop early; fails closed, same in base and head; it now hits 8 of this round's 9 own raws, which blocks the research ledger, see Not run) and F-017 (two bare reviewer-shaped objects with the same status are not ambiguous; the last wins, same on main) are carried from round 2 and were not re-raised (out of scope by the operator). Review-logic and review-security-code add that F-017 also reaches the fenced path (a fenced sample with the same status and empty findings beats a real bare result with findings).
- The AC15 residual (a forged marker alone on its own line, and a plain line-start quote before a bare real result) was accepted by the operator and is not re-raised.

## Round 2 dispositions
- R2 F-001 (marker only at a line start, outside fences): partial. Closed for well-formed line-start fences and unfenced quotes (MARKER needs a line start; M01 to M11 killed). The outside-fence rule is bypassed when an inline triple backtick flips the pairing: this round's F-001.
- R2 F-002 (fenced reviewer-shaped sample against a bare real result): closed. Different statuses give undefined in both orders (ledger.ts:229, tests 219-231; S01 to S05 and B01 to B05 killed). B06 survives (F-009).
- R2 F-003 (cap treated as truncation): closed. Caps are 64 with the boundaries pinned at 63, 64 and 65. Reaching a cap is still read as truncation and fails closed; that is documented in the comments.
- R2 F-004 (nested cut-off key fragment): open, unchanged: this round's F-002.
- R2 F-005 (review-slice error text): closed. The text now names the accepted shapes.
- R2 F-006 (loadRaws negation of isReviewerResult): closed. loadRaws uses the exported isReviewerResult. A same-name private function with another contract exists in managed.ts (F-012, info).
- R2 F-007 (comments): closed. Residue is doc precision, F-011 (info).
- R2 F-008 (objectEnd does two jobs): open, unchanged: this round's F-003.
- R2 F-009 (test titles and duplicates): closed. Residue is F-004 and F-014.
- R2 F-010 (AC18 and verify-exec-files): open: (a) is F-007, the header comment (d) is F-006; (b) latent and (c) accepted as a cost of AC18's design.
- R2 F-011 (fenced status-only result unpinned end to end): closed (review-ledger.test.ts:215, 230; D01 to D03 killed).
- R2 F-012 (wholeFileResult unpinned): closed (review-slice.test.ts whole-file, marker and stdin cases; W02, W03, W04, W06 killed). W01 survives and is argued equivalent: a whole file that is one JSON object parses to the same object either way, and a status-only object is rejected by parseReviewResult and then taken by wholeFileResult.
- R2 F-013 (caps exercised only far over the cap): closed (63, 64, 65 for both caps).
- R2 F-014 (marker forms unpinned): closed (A01 to A03, A10, A13, P02 killed).
- R2 F-015 (labelled-fence and fence-pairing cases unpinned): closed (L01 to L06, L08, F02 to F04, T01, T02, L05 killed; F05 remains, F-010).
- R2 F-016, F-017: carried as pre-existing, not re-raised.

## Regressions the round-2 fixes introduced
- F-001: the round-3 fence filter is the fix for R2 F-001 and it is incomplete rather than a new regression: an inline triple backtick flips the pairing. Relative to d5a8cfdc the fail-open surface is smaller; relative to base 01e0dbfe a forged marker or a gap replaces the real result.
- No quadratic behaviour, fence-range cursor bug, CRLF problem or unclosed-fence problem was found by probes: CRLF markers and fences parse, an unclosed fence does not hide a following marker, 20000 unclosed markers 53 ms, 50000 fences 2 ms, 50000 prose braces 30 ms.

## Mutation survivors (12 of 91)
The pass ran `keryx review mutate` over ledger.test.ts, review-slice.test.ts, review-ledger.test.ts and verify-exec-files.test.ts: killed 79, survived 12, timeout 0, invalid 0. D01, W01, P02 and L05 were re-anchored; all but W01 are killed.

| Mutant | Where | Change | Covered by |
|---|---|---|---|
| O08 | `src/review/ledger.ts:86` | KEY_COLON `/\s*:/y` to `/:/y` | F-008 |
| O09 | `src/review/ledger.ts:85` | RESULT_KEYS reduced to status | F-008 |
| O11 | `src/review/ledger.ts:85` | RESULT_KEYS reduced to reviewer, findings | F-008 |
| B06 | `src/review/ledger.ts:229` | compare the bare status with fencedResults[0] | F-009 |
| N03 | `src/review/ledger.ts:204` | slice(-MAX_MARKERS) before the fence filter | F-009 |
| F05 | `src/review/ledger.ts:149` | closing-fence search from open + 3 | F-010 |
| H01 | `src/review/ledger.ts:169` | hasStatus accepts any defined status | F-010 |
| F06 | `src/review/ledger.ts:151` | range end close, not close + 3 | not cited: judged equivalent by the reviewer (the three closing backticks hold no object start and no marker start), not independently verified |
| F07 | `src/review/ledger.ts:163` | position > open | not cited: judged equivalent by the reviewer (the opening backtick is never an object or marker start), not independently verified |
| N04 | `src/review/ledger.ts:204` | test the marker end, not its start | not cited: judged equivalent by the reviewer (the marker text between has no backtick), not independently verified |
| M12 | `src/review/ledger.ts:195` | lookbehind also excludes carriage return | not cited: judged equivalent for CRLF and LF input by the reviewer; differs only after a lone carriage return, not independently verified |
| W01 | `src/commands/review-slice.ts:171` | parseReviewResult before wholeFileResult | not cited: judged equivalent by the reviewer, see R2 F-012, not independently verified |

## Verified clean
- Round-3 delta killed by tests: the line-start lookbehind (M01, M02), every prefix class member (M03 to M09), the plus quantifier (M10), a lax prefix (M11), the fence filter on and inverted (N01, N02), marker scan order (N06), separators (A01 to A03), pass-over of cut-off and non-JSON markers (A10, A13, A07), and the fenced-versus-bare comparison (S01 to S05, B01 to B05, B07).
- Parser cost is linear and bounded; no RangeError escapes; the base parser's quadratic regexes stay removed.
- Dependency direction is clean (commands import the ledger, not the reverse); no path is built from reply content and nothing in a reply is executed.
- verify-exec-files: the stale-entry test keeps the allowlist honest; 89 tests pass in ledger.test.ts at head.
- isReviewerResult is used by loadRaws and exported once; the attribution check in buildLedger still raises a named gap for a null or empty reviewer.

## Not run
- Other Vantage overlays: none apply (no Vantage paths in scope A).
- review-backend, review-frontend, review-frontend-conventions: stack-excluded by `keryx review required`. review-core-boundaries, review-flow-graph, review-layout: path-gated, no matching paths. Installed `ledger build` may still list the excluded reviewers as "no result recorded"; that is a tool limit, not a dispatch gap.
- Mutation survivors F06, F07, N04, M12 and W01 are the reviewer's equivalence judgement and were not independently re-run by the verifier. The verifier left F-003, F-011, F-013 and F-014 alone (info or maintainability, nothing to run).
- The scope-B ref-based blast radius over 01e0dbfe includes unrelated tui and session commits; scope A was built from the 7 files of the PR and reviewers were told to focus on the T1 sites.
- Ledger: research.json is NOT READY. `keryx review ledger build` (installed 0.3.112) reports "no parseable REVIEW_RESULT block" for 8 of the 9 raws (all but review-regression); the head parser in the worktree returns undefined for the same 8. Cause: the labelled fence in each reply holds a literal triple backtick inside a JSON string (the findings discuss this parser), the pre-existing F-016. So no raw finding became an obligation, rawReconciled and scopeReviewed are false, the dispatch block lists every reviewer as not run, and the package stays PENDING on dispatch evidence. The raws were not altered. The 8 replies were read by the orchestrator and consolidated into the 14 findings above; reconciling them in the ledger needs either F-016 fixed in the parser or the replies re-saved without inline triple backticks.
- Review-package side effects: gdctx and gdgraph artifacts and an untracked pr-comments file in the worktree are tool output, not source edits.

## Stage counts
Reviewers dispatched 9 (review-architecture, review-clean-code, review-highload, review-logic, review-performance, review-regression, review-security-code, review-style, review-testing-practices): consolidated 14 findings (1 major, 9 minor, 4 info as reviewed; 4 major, 6 minor, 4 info after the severity audit); verifier checked 10 (7 execution, 3 site-check), confirmed 10, refuted 0, removed 0.

Routing audit: graph_used no (not relevant: scope came from the PR file list), wiki_used no (not relevant), ctx_used yes, raw_rg_used no.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-security-code",
    "severity": "major",
    "problem": "fenceRanges pairs ANY triple backtick (an inline mention included, fence length ignored, closer need not start a line) with the next one after the end of its line. One inline triple backtick in prose flips the pairing of every later fence, so afterMarker (line 203) and scannedResult (line 222), which both trust these ranges, mis-classify markers: a quoted marker inside a real fence is read as outside (or a real marker as inside). The round-3 rule 'a marker inside a fenced block is not a marker' therefore holds only for well-formed line-start fences.",
    "impact": "Fail open (security-code): a forged 'REVIEW_RESULT: {status DONE, no findings}' line quoted inside a three backticksts or three backticksdiff fence, plus an earlier inline three backticksREVIEW_RESULT mention, plus a real bare NEEDS_CONTEXT result -> parseReviewResult returns the forged DONE with 0 findings (control without the inline mention: undefined = a gap); the real NEEDS_CONTEXT/blocker is lost. Fail closed (highload, architecture, performance): an inline three backticksxthree backticks span before a real marker, with a fenced sample of another status after it, turns the reply into a gap where d5a8cfdc returned the real result. The accepted AC15 residual covers only an UNFENCED quote.",
    "suggested_fix": "Make fenceRanges line-based (CommonMark): an opener is a line starting (after up to 3 spaces) with 3+ backticks and no further backtick; a closer is a line-start run of at least the opener's length; an unclosed opener runs to the end of the reply; strip a trailing \\r. Keep the single forward pass so fenceTester stays linear. Pin the four reproductions in ledger.test.ts and re-check the existing fence tests (ledger.test.ts:392-400 pin a closing fence followed by text on the same line).",
    "evidence": "bun against exported parseReviewResult, T = three backticks. (1) 'The parser reads T REVIEW_RESULT T fences.\\n\\nT ts\\nREVIEW_RESULT: <forged DONE>\\nT\\n\\n<real NEEDS_CONTEXT bare object>' -> DONE, 0 findings; control without the first sentence -> undefined. (2) clean-code: 'the T json convention\\nREVIEW_RESULT: ok(DONE)\\nT json\\nok(BLOCKED)\\nT' -> undefined, without the inline T -> DONE. (3) highload P1: 'I used T foo T inline.\\n\\nREVIEW_RESULT {DONE}\\n\\nExample:\\nT json\\n{BLOCKED}\\nT' -> undefined at 44bed779, DONE at d5a8cfdc. Scripts under scratchpad/review-security-code/{a,b}.ts, review-highload/probe.ts, review-clean-code/t2.ts. Also raised by review-performance PERF-R3-1; review-clean-code F-001; review-highload HL3-1; review-architecture ARCH-R3-1; review-logic F-018. Verifier (review-verifier, execution): at 07730d87 the fail-open input returns the forged DONE with 0 findings; the same inputs at d5a8cfdc return the forged DONE even without the inline mention, and at base 01e0dbfe the real NEEDS_CONTEXT result. Round 3 narrowed the exposure relative to round 2 but it is still a divergence from base.",
    "confidence": "high",
    "file": "src/review/ledger.ts",
    "line": 144,
    "class_scope": {
      "sites": [
        "src/review/ledger.ts:144 fenceRanges",
        "src/review/ledger.ts:158 fenceTester",
        "src/review/ledger.ts:203 afterMarker",
        "src/review/ledger.ts:222 scannedResult"
      ],
      "enumeration_method": "keryx ctx rg fenceTester|fenceRanges: one producer of ranges, two consumers; labelledFence uses its own regex and is unaffected."
    },
    "global_id": "2026-10-13-pr-997-round3-07730d87#F-001"
  },
  {
    "id": "F-002",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "problem": "Carried round-2 F-004, unchanged. objectEnd documents claimsResult as 'the object itself (not an object nested in it)', but topLevelObjects re-enters every unclosed fragment (start += 1), so a nested cut-off object carrying a result key still ends the scan as truncated. Neither the topLevelObjects doc nor a test says so.",
    "impact": "A complete bare result followed by prose like {\"meta\":{\"status\":\"ok\" gives no result (re-dispatch), while {\"meta\":{\"x\":1 is read. Fails closed, never a wrong result.",
    "suggested_fix": "One sentence in the topLevelObjects doc (a nested cut-off object is met again at its own brace, so a result key anywhere in a cut-off fragment ends the scan) and one test pinning the first case.",
    "evidence": "bun: 'ok(DONE)\\n{\"meta\":{\"status\":\"ok\"' -> undefined; 'ok(DONE)\\n{\"meta\":{\"x\":1' -> the result. Script scratchpad/review-clean-code/t3.ts.",
    "confidence": "high",
    "file": "src/review/ledger.ts",
    "line": 105,
    "class_scope": {
      "sites": [
        "src/review/ledger.ts:88-91 objectEnd doc",
        "src/review/ledger.ts:120-124 topLevelObjects doc"
      ],
      "enumeration_method": "the two comments describing claimsResult; one behaviour"
    },
    "global_id": "2026-10-13-pr-997-round3-07730d87#F-002"
  },
  {
    "id": "F-003",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "problem": "Carried round-2 F-008, unchanged. objectEnd is both a brace matcher and a result-key detector; afterMarker discards claimsResult yet the detector runs per marker candidate. KEY_COLON (l.86) and OBJECT_START (l.83) are module-level sticky regexes whose lastIndex every caller must set before use. The try { JSON.parse } catch pair is written three times (l.137, 188, 210-213).",
    "impact": "Maintainability only: a fourth caller can forget to reset lastIndex; changing the parse-failure policy means three edits. No behaviour defect found.",
    "suggested_fix": "Pass the key detector to objectEnd as an optional callback or split it; add a tryParse(raw, from, to) helper; build the colon test locally.",
    "evidence": "ledger.ts lines 83, 86, 105-107, 137, 186-188, 208-213 at head 07730d87.",
    "confidence": "medium",
    "file": "src/review/ledger.ts",
    "line": 208,
    "class_scope": {
      "sites": [
        "l.83",
        "l.86",
        "l.137",
        "l.188",
        "l.210-213"
      ],
      "enumeration_method": "read of the whole file"
    },
    "global_id": "2026-10-13-pr-997-round3-07730d87#F-003"
  },
  {
    "id": "F-004",
    "reviewer": "review-style",
    "severity": "minor",
    "problem": "Titles at lines 388 ('a fence that never closes fences nothing: its object is bare, so two statuses stay ambiguous') and 392 ('an object right after a closing fence is bare, not fenced') name a rule their assertion cannot fail on: both inputs hold two reviewer-shaped objects with different statuses, so the reply is undefined whether the object is counted as fenced or as bare. Line 397 does discriminate.",
    "impact": "A regression in the unclosed-fence rule or the closing-fence boundary leaves these two green while their titles claim to guard it. Another test pins the unclosed-fence rule (line 407), so this is a title/assertion mismatch, not a coverage hole.",
    "suggested_fix": "Give the object in question the same status as the other and assert which reviewer wins, or retitle both to what they assert.",
    "evidence": "Standalone copy of ledger.ts in scratchpad/review-style3. Mutant A (fenceRanges closes an unclosed fence at end of input): 388 still gives undefined. Mutant B (fenceTester treats the end position as inside): 392 still gives undefined while 397 changes to reviewer 'bare'.",
    "confidence": "high",
    "file": "src/review/ledger.test.ts",
    "line": 388,
    "class_scope": {
      "sites": [
        "src/review/ledger.test.ts:388",
        "src/review/ledger.test.ts:392"
      ],
      "enumeration_method": "read of the fences describe, each title checked against a mutant"
    },
    "global_id": "2026-10-13-pr-997-round3-07730d87#F-004"
  },
  {
    "id": "F-005",
    "reviewer": "review-style",
    "severity": "minor",
    "problem": "good_json (added in 44bed779) is a snake_case helper in a camelCase codebase, declared at file level after the describe that uses it (lines 377-379), and redundant: the enclosing describe at line 262 already holds goodJson (same fields, another key order).",
    "impact": "Naming-convention break and a second spelling of one fixture.",
    "suggested_fix": "Delete good_json and use goodJson at lines 377-379.",
    "evidence": "git log -S good_json: only 44bed779. goodJson is declared at ledger.test.ts:262, an ancestor scope of line 358.",
    "confidence": "high",
    "file": "src/review/ledger.test.ts",
    "line": 435,
    "class_scope": {
      "sites": [
        "src/review/ledger.test.ts:435",
        "src/review/ledger.test.ts:377-379"
      ],
      "enumeration_method": "git log -S good_json plus rg"
    },
    "global_id": "2026-10-13-pr-997-round3-07730d87#F-005"
  },
  {
    "id": "F-006",
    "reviewer": "review-style",
    "severity": "minor",
    "problem": "Carried round-2 STY-4, unchanged. The header comment 'A command naming a missing file passes vacuously in `bun test`, so the gate proves nothing.' is false for a command that names a single missing file.",
    "impact": "A maintainer reads the guard as covering a hazard that does not exist for single-file commands and misses the real one (a missing file next to an existing one).",
    "suggested_fix": "Reword: bun test skips a missing file when the command also names other test files, so the gate passes without running it.",
    "evidence": "bun test src/nope/missing.test.ts exits 1; bun test src/nope/missing.test.ts src/flow/verify-exec-files.test.ts exits 0 (run in the worktree).",
    "confidence": "high",
    "file": "src/flow/verify-exec-files.test.ts",
    "line": 2,
    "class_scope": {
      "sites": [
        "src/flow/verify-exec-files.test.ts:2"
      ],
      "enumeration_method": "the one header comment"
    },
    "global_id": "2026-10-13-pr-997-round3-07730d87#F-006"
  },
  {
    "id": "F-007",
    "reviewer": "review-architecture",
    "severity": "minor",
    "problem": "Carried round-2 F-010 / ARCH-3 (a). AC18 (acceptance-criteria.md:49) says the test fails when a named *.test.ts file does not exist; the four flow-375 KNOWN_MISSING exemptions make it pass for files that do not exist. The PR body states the list and 'Not done: F-010', but no operator decision on the AC18 deviation is recorded (PR body, flow journal).",
    "impact": "AC18 is met only through an unsigned exemption; the frozen criterion and the test disagree.",
    "suggested_fix": "Record the operator's decision on flow 375 (write the four tests, or re-seal with keryx flow ac update) before merge, or state in the PR body that AC18 is met with the named exemption by operator decision.",
    "evidence": "acceptance-criteria.md:49; PR 997 body 'Not done: F-008 (refactor), F-010 (KNOWN_MISSING kept as is)'; journal.md of flow 441 has no entry for the exemption.",
    "confidence": "medium",
    "file": "src/flow/verify-exec-files.test.ts",
    "line": 15,
    "class_scope": {
      "sites": [
        "src/flow/verify-exec-files.test.ts:15",
        ".metaproject/flows/441-.../acceptance-criteria.md:49"
      ],
      "enumeration_method": "KNOWN_MISSING entries"
    },
    "global_id": "2026-10-13-pr-997-round3-07730d87#F-007"
  },
  {
    "id": "F-008",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "problem": "Unpinned behaviour: the truncation test (a cut-off object that claims a result key means no result) is pinned only for compact JSON and a cut-off object carrying all keys. Mutants O08 (KEY_COLON /\\s*:/y -> /:/y), O09 (RESULT_KEYS reduced to status) and O11 (RESULT_KEYS reduced to reviewer, findings) survive with the suite green.",
    "impact": "A cut-off reply whose first key is written as \"status\" : or whose only result key is reviewer or status would be read as prose, and a complete nested result inside it returned instead of a gap.",
    "suggested_fix": "One table test in the 'an unclosed object that carries the result keys' block: three cut-off outer objects (space before the colon; only reviewer; only status) each wrapping a complete nested reviewer result, each expecting undefined.",
    "evidence": "keryx review mutate (mutation-1.md in the package): O08, O09, O11 survived. Inputs: {\"status\" : \"DONE\", \"slices\":[<complete nested result> -> original undefined, mutant returns the nested result; same for {\"reviewer\":\"r\",\"slices\":[...] and {\"status\":\"DONE\",\"slices\":[...]. mutant:O08 mutant:O09 mutant:O11",
    "confidence": "high",
    "file": "src/review/ledger.ts",
    "line": 105,
    "class_scope": {
      "sites": [
        "src/review/ledger.ts:85 RESULT_KEYS",
        "src/review/ledger.ts:86 KEY_COLON"
      ],
      "enumeration_method": "surviving mutants O08, O09, O11"
    },
    "global_id": "2026-10-13-pr-997-round3-07730d87#F-008"
  },
  {
    "id": "F-009",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "problem": "Unpinned behaviour in two round-3 branches. B06 (compare the bare status with fencedResults[0] instead of the last fenced result) and N03 (slice(-MAX_MARKERS) before the fence filter instead of after) survive. The 63/64/65 test uses unfenced markers only, so the order of filter and slice is not exercised.",
    "impact": "N03: a real marker followed by a fenced block quoting 64 or more marker lines would be lost and the reply becomes a gap. B06: with two differing fenced samples, the ambiguity check would compare against the wrong one.",
    "suggested_fix": "N03: extend the 'only the last 64 markers' test with one real marker plus 64 fenced marker lines expecting the real result. B06: two fenced results with different statuses plus a bare result equal to the last one, expecting the last fenced result.",
    "evidence": "keryx review mutate: B06 and N03 survived. N03 input: 'REVIEW_RESULT {DONE}' then a fence holding 64 lines 'REVIEW_RESULT {BLOCKED}': original DONE, mutant undefined. B06 input: fence DONE, fence BLOCKED, bare BLOCKED: original BLOCKED, mutant undefined. mutant:B06 mutant:N03",
    "confidence": "high",
    "file": "src/review/ledger.ts",
    "line": 204,
    "class_scope": {
      "sites": [
        "src/review/ledger.ts:204",
        "src/review/ledger.ts:229"
      ],
      "enumeration_method": "surviving mutants B06, N03"
    },
    "global_id": "2026-10-13-pr-997-round3-07730d87#F-009"
  },
  {
    "id": "F-010",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "problem": "Unpinned behaviour: F05 (closing-fence search starting at open + 3 instead of the next line) and H01 (hasStatus accepting any defined status, not a string) survive. The rule that the closing fence is searched after the opening line, so an inline three backticks pair in prose is read as an opener, has no test either way (related to F-001).",
    "impact": "F05 changes which object counts as fenced when a prose line holds an inline three backticksxthree backticks span. H01: a numeric status in a labelled fence would be accepted as a result.",
    "suggested_fix": "H01: assert that a labelled fence with {\"status\":1} gives undefined. F05: pin the intended outcome of an inline three backticks span on a prose line (together with the F-001 fix).",
    "evidence": "keryx review mutate: F05 and H01 survived. H01 input: 'three backticksREVIEW_RESULT\\n{\"status\":1}\\nthree backticks': original undefined, mutant {\"status\":1}. F05 input: 'see three backticksxthree backticks {DONE reviewer line1}\\nthree backticksjson\\n{DONE reviewer fenced}\\nthree backticks': original line1, mutant fenced. mutant:F05 mutant:H01",
    "confidence": "high",
    "file": "src/review/ledger.ts",
    "line": 149,
    "class_scope": {
      "sites": [
        "src/review/ledger.ts:149",
        "src/review/ledger.ts:169"
      ],
      "enumeration_method": "surviving mutants F05, H01"
    },
    "global_id": "2026-10-13-pr-997-round3-07730d87#F-010"
  },
  {
    "id": "F-011",
    "reviewer": "review-clean-code",
    "severity": "info",
    "problem": "Doc precision. MARKER's comment says 'after at most a quote, list or heading prefix' while the class [ \\t>*#-]* takes any run of blanks and > * # -; an ordered-list prefix '1. ', bold '**REVIEW_RESULT:** {', an em dash or a code span is not a marker (fails closed: read by the scan, a gap if a differing bare object exists). Rule 2 of the parseReviewResult doc omits the prefix class; scannedResult's one-line summary omits that a differing bare object cancels the fenced one.",
    "impact": "A reader may expect numbered lists or bold markers to count. None at run time.",
    "suggested_fix": "Word the comment 'any run of blanks and > * # -'; add the prefix clause to rule 2; comment the lookbehind as 'start of input or after a newline'.",
    "evidence": "bun: '1. REVIEW_RESULT: ok(DONE)\\nok(BLOCKED)' -> undefined; '**REVIEW_RESULT:** ok(DONE)\\nok(BLOCKED)' -> undefined; '- > # * REVIEW_RESULT: ok(DONE)\\nok(BLOCKED)' -> DONE. Also raised by review-style STY-R3-5; review-architecture ARCH-R3-4; review-logic F-019.",
    "confidence": "medium",
    "file": "src/review/ledger.ts",
    "line": 195,
    "class_scope": {
      "sites": [
        "src/review/ledger.ts:194",
        "src/review/ledger.ts:218",
        "src/review/ledger.ts:239"
      ],
      "enumeration_method": "comments of the round-3 delta compared with code"
    },
    "global_id": "2026-10-13-pr-997-round3-07730d87#F-011"
  },
  {
    "id": "F-012",
    "reviewer": "review-architecture",
    "severity": "info",
    "problem": "The now exported isReviewerResult is also a private function in src/review/managed.ts:1676 with a different contract (findings array only, no status). Same directory, same name, two meanings.",
    "impact": "Auto-import or a copy between the files picks the wrong guard; nothing wrong today.",
    "suggested_fix": "Optional rename of one of the two (isAttributableResult or isReviewerReply).",
    "evidence": "keryx ctx rg isReviewerResult src: ledger.ts:173 (status plus reviewer string or findings array), managed.ts:1676 (findings array).",
    "confidence": "high",
    "file": "src/review/ledger.ts",
    "line": 173,
    "class_scope": {
      "sites": [
        "src/review/ledger.ts:173",
        "src/review/managed.ts:1676"
      ],
      "enumeration_method": "keryx ctx rg isReviewerResult src"
    },
    "global_id": "2026-10-13-pr-997-round3-07730d87#F-012"
  },
  {
    "id": "F-013",
    "reviewer": "review-performance",
    "severity": "info",
    "problem": "Worst-case latency scales with MAX_UNCLOSED + MAX_MARKERS = 64 + 64 scans to the end of the reply. Measured: 1 MB with 64 unclosed prose braces 122 ms (8 braces 15.7 ms, one scan 3.1 ms); 64 unclosed markers 236 ms at 1 MB and 941 ms at 4 MB (linear, 4.0x). An adversarial 11 KB reply takes 0.29 ms. No quadratic path in any of 46 shapes tried at 1-8 MB.",
    "impact": "Visible only at 1 MB+ on a reviewer reply (typical 5-10 KB). The 64 caps cost 8x the old 8 only in that regime. The comment 'about 3 ms per MB' is accurate per scan.",
    "suggested_fix": "None needed. Optional: reword the comment to '3 ms per MB per scan'.",
    "evidence": "scratchpad/review-performance/bench.ts, scratchpad/review-highload/hl.ts. Also raised by review-highload HL3-2.",
    "confidence": "high",
    "file": "src/review/ledger.ts",
    "line": 118,
    "class_scope": {
      "sites": [
        "src/review/ledger.ts:117-118 MAX_UNCLOSED",
        "src/review/ledger.ts:192 MAX_MARKERS"
      ],
      "enumeration_method": "the two caps"
    },
    "global_id": "2026-10-13-pr-997-round3-07730d87#F-013"
  },
  {
    "id": "F-014",
    "reviewer": "review-style",
    "severity": "info",
    "problem": "Three small title/assertion drifts. Line 376: the third input ({\"verdict\":\"DONE\"}) is valid JSON without a status. Line 74: the title states a REVIEW_RESULT fence needs a status and a json fence a reviewer or findings, but the body asserts neither refusal (pinned at 174-184). Lines 284 and 423 repeat the same prefix list, and 283/421 overlap.",
    "impact": "Reading cost only.",
    "suggested_fix": "Title 376 'a labelled fence that does not hold a result decides'; shorten 74; one shared PREFIXES constant.",
    "evidence": "ledger.test.ts:74-79, 283-287, 376-380, 421-426.",
    "confidence": "medium",
    "file": "src/review/ledger.test.ts",
    "line": 376,
    "class_scope": {
      "sites": [
        "src/review/ledger.test.ts:74",
        "283-287",
        "376",
        "421-426"
      ],
      "enumeration_method": "read of the test file"
    },
    "global_id": "2026-10-13-pr-997-round3-07730d87#F-014"
  }
]
```
