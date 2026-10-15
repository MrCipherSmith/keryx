# Review report: PR 997 round 2 (flow 441 T1, result parser)

Orchestrator: vantage-review. Generic engine: review-orchestrator (/home/altsay/keryx-fdm-t1/.metaproject/skills/gdskills/review/review-orchestrator/SKILL.md). Keryx projection path: /home/altsay/keryx-fdm-t1/.metaproject. Round 2 of 3. Head d5a8cfdc8a4978a36027caab63c5d6c469e3425c, base dd46d218. Mode all. Review id 2026-10-13-pr-997-round2-d5a8cfdc.

Vantage overlays: none selected. The repository is a Bun CLI with no Vantage frontend, core, flow, sigma, domains, styling, temporal or design-system paths. Vantage rule files read: none. Project-local reviewer packages: none registered (.metaproject/project-skills/review does not exist), so the global definitions applied.

Verdict: request changes. 0 blockers, 6 majors (F-001, F-002, F-011, F-012, F-014, F-015), 9 minors (F-003 to F-010 and F-013), 2 pre-existing (F-016 major, F-017 minor; they never block). Verifier: 17 confirmed, 0 refuted. Mutation pass: 57 mutants, 24 killed, 33 survived.

Severity audit raised F-011, F-012, F-014 and F-015 from minor to major because the mutants they cite (D01, W01, P02, L05) survived; the reviewers had rated them minor, and the raise is mechanical (an unpinned behaviour, no observed failure), so the operator may treat them as one test-gap item. Round 1 is closed except for what is listed under "Round 1 dispositions". F-001 and F-002 are cases where the base parser returned the real result and the head does not.

## Findings by severity

### Major
- **F-001** (major) `src/review/ledger.ts:189` afterMarker matches REVIEW_RESULT anywhere in the reply (mid-line, blockquote, list item, diff line, inside a code fence), not only where a reviewer wrote the marker, and takes the last one whose object is reviewer-shaped. A quoted contract line or fixture 'REVIEW_RESULT: {status, reviewer, findings}' therefore replaces the reviewer's real bare result. Impact: Trigger: a reviewer that writes its result as a bare marker plus object (no fence) and whose prose, before or after it, quotes a marker line from untrusted PR text, a fixture or this parser's docs. Outcome: the quoted object is the result. Proven: a real INCOMPLETE result with one blocker and slices became DONE with no findings; buildLedger then gave run.status=complete, obligations=0, rawReconciled=true, no gaps. A quote BEFORE the real result is a regression of this PR (the base parser returned the real result); a quote AFTER was already so on main. The REVIEW_RESULT fence the contract mandates is immune. Fix: Count a marker only where it starts its line (spaces, tabs and the quote or list prefixes > * # - allowed) and lies outside a ``` fence, using a forward cursor over fenceRanges so it stays linear: /(?<![^\n])[ \t>*#-]*REVIEW_RESULT(?:[ \t]*[:=])?\s*(?=\{)/g. Tried on scratch copies by two reviewers: the verifier re-ran it: ledger.test.ts 64/64 and review-slice plus review-ledger tests 24/24 stay green. A forged marker on its own plain line still wins; it cannot be told from a real corrected result without breaking frozen AC15 (ledger.test.ts:227-231). Verifier note: with this fix a quote on its OWN line before a bare real result (no marker) still returns the quote, so the regression is narrowed to a plain line-start quote, not closed; closing it needs the position or ambiguity rule of F-002.
- **F-002** (major) `src/review/ledger.ts:217` scannedResult prefers any fenced reviewer-shaped object over the real bare result, even when the fence is not a labelled REVIEW_RESULT fence. The residual of round-1 F-001: that fix keeps a non-result fenced object from hiding the real result, but a fenced REVIEWER-SHAPED sample (status plus reviewer or findings) still wins. The pre-PR parser took the last object with a status, i.e. the real result when it came last. Pinned by ledger.test.ts:233 ('a fenced result wins over a differing bare object'), which AC11-AC18 do not freeze. Impact: Trigger: a saved raw reply with no labelled fence and no marker, whose real result is a bare object and which also quotes a reviewer-shaped sample in a json fence. Outcome through loadRaws and buildLedger: the raw is attributed to the sample's reviewer name; gaps 'review-logic: no result recorded' and 'review-logic:EX-1: raw finding is not in the canonical findings' appear, the sample's finding becomes an obligation and the real finding never enters the ledger; retry-plan --result takes the sample's status and slices. Likelihood on real data is low: 0 of 98 replayed replies trigger it. Fix: Operator decision, because a frozen-looking test pins the current rule. Narrowest: when a fenced reviewer-shaped result and a bare reviewer-shaped result both exist and differ in reviewer or status, return undefined (ambiguous) and update the test at ledger.test.ts:233. Alternative: choose by position (the last reviewer-shaped object), the pre-PR rule.
- **F-011** (major) `src/review/ledger.test.ts:183` The parser accepts a status-only object inside a labelled fence (AC13 as amended) and this test pins that, but nothing pins what the ledger does with it: loadRaws drops such a result without a gap. Neither side of the guard is exercised end to end. Impact: A fenced {"status":"DONE"} reply is accepted by the parser, contributes nothing to the ledger and raises no gap. Changing or removing that branch passes every test, so the amended AC13 is unpinned end to end. Fix: One test in src/commands/review-ledger.test.ts: a raw file holding a fenced status-only result produces a named gap or an explicitly asserted no-op.
- **F-012** (major) `src/commands/review-slice.test.ts:None` Only the refusal side of wholeFileResult is tested. A whole file that is one JSON object with a status and no reviewer, read with --reviewer, is accepted, while the same object after a bare marker is a gap in the parser; that divergence has no test. The stdin path of readResult is also unexercised, and a bare-status retry reply saved as raw/<reviewer>.txt now makes ledger build NOT READY where it was silently ignored, which the PR text does not say. Impact: Changing wholeFileResult to require a reviewer, to accept an object without a status, or reordering it behind parseReviewResult keeps the suite green. Fix: Add a whole-file status-only case with --reviewer (assert written), the same object after a bare marker (assert exit 2, nothing written) and a stdin case; add a line to the PR text about the ledger change.
- **F-014** (major) `src/review/ledger.test.ts:227` Marker forms and the marker fallback are thinly pinned: the separators (=, newline after the colon, space only: A01-A03), the order of the marker and scan rules (P02), a cut-off last marker object falling back to the earlier marker (A10, fail-open) and a trailing 'see REVIEW_RESULT {contract}' fragment (A13). No test pins the quoted-prose residual of F-001 either. Impact: A10 (a cut-off last marker object returns the earlier marker's result) changes silently in either direction; so does the precedence between the marker and the scan. Fix: Tests for the colon-newline and colon-less forms, a truncated last marker with an earlier valid marker, a trailing prose mention, and a marker plus a differing bare object (AC15 ordering).
- **F-015** (major) `src/review/ledger.test.ts:86` Labelled-fence and fence-pairing edge cases are unpinned: two labelled fences with the last one winning (L05, L04), CRLF after the label (L02), trailing space (L03), lower-case label (L01), an invalid labelled fence followed by a bare result (L08, P01), pairing around a later unlabelled fence (F02, F03, F04), a pretty-printed multi-line bare object (T02, T01). The labelled-fence regex is the code the last fix commit rewrote. Impact: A regression in the fence regex or the pairing logic would not fail a test; for L05 a labelled fence taking the first block instead of the last would pass. Fix: One table-driven test over these inputs.
- **F-016** (major) `src/review/ledger.ts:None` Pre-existing, in both base and head. When a JSON string inside the labelled fence contains a literal triple backtick (a reviewer quoting the fence label), the lazy fence regex stops at it, JSON.parse fails, and labelledFence decides alone with no fallback to the scan. 10 of 26 real fenced replies parse to undefined in base and head; taking the block up to a closing fence at line start, all 10 parse to complete valid results. Three of this round's own nine raws (review-security-code, review-style, review-testing-practices) are this shape: the head parser returns undefined for them. Impact: Trigger: a reviewer reply whose REVIEW_RESULT block quotes a triple backtick inside a string (common when a finding discusses this parser or the fence contract). Outcome: 'no parseable REVIEW_RESULT block' gap for a complete, valid reply, a re-dispatch or a manual fix; retry-plan --result exits 2. Fails closed. Not caused by this PR, so it never blocks it. Fix: Fall back to the scan (afterMarker, scannedResult) when the labelled block fails JSON.parse; the existing test at ledger.test.ts about line 520 (an invalid labelled block followed by a status-only object stays undefined) would still pass. Or close the block at a fence at line start.

### Minor
- **F-003** (minor) `src/review/ledger.ts:133` Reaching a count cap is treated as truncation, the same as an unclosed fragment that carries a result key. Nine or more unclosed non-result prose fragments (MAX_UNCLOSED = 8) discard a genuine bare result; a genuine marker result followed by 8 or more later 'REVIEW_RESULT {"status":...}' lines whose objects carry differing statuses is pushed out of the MAX_MARKERS = 8 window and the scan then sees conflicting statuses. The cost the caps bound is about 3 ms per MB per scan, far below what 8 allows. Impact: A bare reply (no fence, no marker) with 9 or more '{"' prose fragments before or after the result, or a marker reply with 8 or more trailing marker lines carrying differing statuses (verifier: 7 parse, 8 and 9 do not; plain 'REVIEW_RESULT {contract}' lines without a status do not trip it), gives undefined: loadRaws raises 'no parseable REVIEW_RESULT block' and the reviewer is re-dispatched, retry-plan --result exits 2. Fails closed, never a wrong result; the base parser returned the result for the fragment half (in the conflicting-status marker case it returned the last status-only object). The fenced form is immune. Fix: At the cap return truncated: false and keep truncated: true only for a fragment claiming a result key (verified on a scratch copy, 64/64), or bound the work by scanned characters instead of fragment count, or use a flat cap near 64; apply the same to the marker window.
- **F-004** (minor) `src/review/ledger.ts:105` The objectEnd doc says claimsResult is true only when the object itself (not an object nested in it) carries a result key. topLevelObjects then does start += 1 on every unclosed fragment, so the scan re-enters the nested object at its own '{"', where its keys sit at depth 1 and count. The depth === 1 test cannot do the job the comment gives it. Related: an odd quote count in prose after the result plus an earlier non-result '{"' fragment makes that candidate close at a stray '}', fail JSON.parse and be skipped whole (AC12), so the real result inside it is never revisited. Impact: A complete genuine bare result followed by the prose fragment '{"meta":{"status":"ok"' gives undefined; the same reply with '{"meta":{"x":1' returns the result. Fails closed (gap, re-dispatch); the base parser returned the result. Rated minor, not major as review-clean-code raised it: the outcome is the same gap as F-003, never a wrong result. Fix: Drop the depth test and say 'any result key in the fragment, nested included', or make topLevelObjects skip the content of a prose fragment instead of re-entering it; pin the nested-key case with a test.
- **F-005** (minor) `src/commands/review-slice.ts:None` The parenthesis misstates the rules it summarises: a ```REVIEW_RESULT fence needs only a status (a fence with reviewer and findings but no status is refused), the bare-object reply (status plus reviewer or findings, no marker) is omitted, and 'holds no usable reviewer result' is still circular. The test pins the substring 'a truncated or ambiguous reply is refused', so the prose is part of the contract. Impact: An operator whose saved reply was refused is told a rule that is wrong for the fence and incomplete for bare replies and cannot tell which field is missing. Fix: Name the accepted shapes: a JSON object with a status; a ```REVIEW_RESULT block with a status; or a reply holding one object with a status and a reviewer or findings (bare, or after a REVIEW_RESULT marker); a truncated or ambiguous reply is refused. Ideally build it from one constant next to parseReviewResult; update review-slice.test.ts:80 and :91 with it.
- **F-006** (minor) `src/commands/review-ledger.ts:99` loadRaws hand-writes a looser negation of the private isReviewerResult (reviewer === undefined instead of typeof reviewer === 'string'). The attribution half is written three times and the copies differ: isReviewerResult (ledger.ts:166), this line, and ledger.ts:279 (!text(raw.result.reviewer)). Round-1 F-007, still open; shared-definitions.mdc says a comment is not sufficient to connect two places that must agree. loadRaws also never compares the declared reviewer with the driver or file stem (retry-plan does). Impact: A fence of {"status":"DONE"} is dropped silently into ignored; a fence of {"status":"DONE","reviewer":null} becomes a raw with a result, then the gap 'names no reviewer'. Both outcomes are non-passing; the cost is a silent drift when the parser's definition changes. Fix: Export isReviewerResult and use !isReviewerResult(result) here, keeping the comment as the why. Optionally require result.reviewer to equal the driver's reviewer when the driver names the file.
- **F-007** (minor) `src/review/ledger.ts:203` Comments say less or something else than the code does. scannedResult says 'No label and no marker' but also runs when markers exist and none gave a reviewer result. Rule 3 of the parseReviewResult doc says prose braces are skipped 'a few times' and never says the ninth gives no result, and item 3 is one run-on sentence with a broken wrap. MAX_MARKERS says markers are tried but not that older ones are ignored and the scan runs, the opposite of MAX_UNCLOSED where passing the cap means no result. The ambiguity clause covers every bare object with a status, so a quoted {"id":"S1","status":"fixed"} counts. Decision gives the chain two 'not applicable' conventions, hasStatus declares a type guard that checks only status, and inFence relies on an undocumented ascending start order. Impact: A maintainer cannot predict: marker {"status":"X"} then a real bare result -> undefined; a real result then 'example {"id":"S1","status":"fixed"}' -> undefined; a real marker result then 9 later marker lines -> undefined, with 7 it parses. Reading cost only. Fix: Edit the comments only: state the real precedence including the caps, the ambiguity rule and the ascending-start requirement.
- **F-008** (minor) `src/review/ledger.ts:193` objectEnd does two jobs: it finds the closing brace and detects result keys for the truncation decision. afterMarker discards claimsResult, yet the key detection runs on every marker candidate. The module-level sticky regexes KEY_COLON and OBJECT_START are shared mutable state (lastIndex) that callers must reset, and the try { JSON.parse } catch pair is written three times. Impact: Linear and small cost; a half-meaningless return value and a trap for the next editor. Fix: Keep objectEnd a pure brace matcher or give it an optional onKey callback; add a tryParse helper; build the sticky regex locally.
- **F-009** (minor) `src/review/ledger.test.ts:74` Titles no longer match assertions and tests repeat. (a) Line 74: a ```json fence is now accepted only with a reviewer or findings, so 'carries a status' is wrong (a status-only json fence gives undefined). (b) Line 188, AC15: the last two assertions (truncated marker object, status-only marker object) test AC11 and AC13/AC14. (c) Lines 129 and 248 are titled 'linear time' but assert a wall-clock bound under 2000 ms. (d) Lines 179-180 repeat lines 223-224 exactly; lines 81 and 207 (escaped quote and brace) and lines 125 and 238 (a fenced non-result beside the bare result) are near-duplicates. Impact: A failing test names the wrong rule (the F-011 pattern of round 1, again), the duplicates add maintenance with no coverage, and a timing bound in a test titled 'linear' will read as a parser regression on a slow runner (low flake risk: milliseconds against two seconds). Fix: Retitle line 74 to 'takes the last fenced block that is a result (a REVIEW_RESULT fence needs a status, a json fence a reviewer or findings)'; move the two extra AC15 assertions to the AC11 and AC13 tests; delete the exact duplicate and merge the two near-duplicates; retitle the timing tests 'finish within two seconds'.
- **F-010** (minor) `src/flow/verify-exec-files.test.ts:None` Round-1 F-009 is only partly closed. (a) The four flow-375 exemptions deviate from the frozen AC18 text (the test fails when a named file does not exist) and no operator decision is recorded. (b) TEST_FILE is unchanged: it needs whitespace on both sides, so a quoted path, trailing comma, .spec.ts, glob, .test.js or a command with '; echo' after the file is skipped without a trace. (c) Every historical frozen AC now depends on src: 415 git-tracked flow directories cannot be edited, so renaming a test file named by an old verify line fails this test. (d) The comment 'passes vacuously' is imprecise: bun test with only a missing file exits 1; it passes only when the command also names an existing file. Impact: (a) AC18 is satisfied only with an unsigned exemption, so flow 375 keeps the vacuous gate AC18 exists to prevent. (b) Latent today: a future exec line in one of those shapes naming a missing file passes. (c) Lasting cost of AC18's design. (d) A reader may conclude single-file lines are also at risk. Fix: (a) Record the operator's decision on flow 375 in the PR (write the four tests, or re-seal flow 375 with keryx flow ac update). (b) Widen the token regex or assert every [verify: exec line yields a token or has no .test. text. (c) Say in the header that renaming needs a KNOWN_MISSING entry. (d) Reword: 'bun test skips a missing file when the command names other test files, so the gate passes without running it.'
- **F-013** (minor) `src/review/ledger.test.ts:97` MAX_UNCLOSED = 8 and MAX_MARKERS = 8 are exercised only by inputs far over the cap. Witness inputs show behavioural differences for MAX_UNCLOSED 7 and 9 (T03, T04), 1 (T05) and MAX_MARKERS 7 and 9 (A05, A06) and for slice(-8) against slice(0, 8) (A04). Impact: A drift of a cap by one, or reversing which end of the marker list is kept, passes; the caps decide whether a genuine result is skipped (F-003). Fix: Boundary tests: 8 unclosed non-result fragments then a valid result is read, 9 gives the documented outcome; the same for 8 and 9 invalid markers after a valid marker.
- **F-017** (minor) `src/review/ledger.ts:None` Round-1 F-010, unchanged and now documented. The ambiguity gate compares only the status string, so two bare reviewer-shaped objects with the same status and different findings are not ambiguous and the last wins; same on main. Impact: A findings: [] echo with the same status after the real result with findings drops the real findings. Fix: Treat two reviewer-shaped objects as ambiguous unless deep-equal, or count only trailing objects.

## Questions

### Q1 (operator): is the later-marker-wins residual exploitable, and what is the narrowest fix?
Yes, it is reachable, but narrower than on main. Exposed: a real bare-marker result followed by a quoted `REVIEW_RESULT: {status, reviewer, findings}` object (already so on main); a real unmarked bare result with a quoted marker object before it (a regression of this PR, the base parser returned the real result); a real result with a fenced reviewer-shaped sample before it (F-002). Not exposed: the contract's ```REVIEW_RESULT fence; a forged marker before a real marker result (last marker wins); quotes inside the JSON strings of the real object. Proven consequence: a real INCOMPLETE result with a blocker and slices became DONE with no findings, and buildLedger then reported run.status complete with no gaps (security-code's proof; the verifier re-ran only the parse). A reviewer that quotes untrusted PR text can therefore, by accident or by content, replace its own result.
Narrowest fix consistent with the frozen AC11 to AC18 (F-001): count a marker only at a line start (spaces, tabs and the > * # - prefixes) and outside ``` fences, with a forward cursor over the fence ranges so the scan stays linear. Reviewers and the verifier ran it on scratch copies: ledger.test.ts 64/64 and review-slice plus review-ledger tests 24/24 stay green. It does not close everything: a forged marker alone on its own line cannot be told from a real corrected result without breaking AC15 (ledger.test.ts:227-231), and a quote alone on its own line before a bare real result still wins (verifier). Closing those needs the position or ambiguity rule asked for under Q4. An attribution check in loadRaws (the object's reviewer must equal the file's reviewer) is a cheap complement, but it does not stop a forger who copies the real reviewer name.

### Q2 (operator): the 8-fragment skip cap and 2 MB hostile inputs
The caps (MAX_UNCLOSED = 8, MAX_MARKERS = 8) only ever turn a genuine result into undefined, which loadRaws reports as a gap and the operator re-dispatches. They never produce a wrong result, and the labelled fence is immune. Verified at the boundary: 8 unclosed fragments parse, 9 give undefined (F-003); the marker cap trips at 8 later marker lines and only when their objects carry differing statuses. Performance is linear: worst cases of 133 ms at 2 MB (584 ms at 8 MB) for review-performance, 142 to 394 ms for security and logic, about 1.1 s for highload's worst combination (about 0.55 s per MB, +150 MB RSS per 2 MB of `{}`). No RangeError escapes and there is no crash at 333k-deep nesting. The base parser was quadratic; this PR removes that (12.7 s to 1.5 ms; marker regex on 200 KB of spaces 79.7 s to 2.2 ms; labelled-fence regex 33.8 s to 1.4 ms). Suggested adjustment (F-003): return truncated:false at the cap, or use a scanned-character budget or a cap near 64. Optionally put a 1 MiB ceiling outside the parser (info, HL-1 and HL-2).

### Q3 (operator): the AC13 wording amended via flow ac update
Parser, tests and wording agree with the amended AC13: a status-only object after a bare marker is a gap, while the labelled fence still accepts it. Gaps: the fenced status-only result is silently ignored by loadRaws with no gap and no test (F-006, F-011); the wholeFileResult asymmetry has no test (F-012); the error text at review-slice.ts:172 is imprecise (F-005). One line worth putting in the PR text: a bare status-only retry-reply saved as raw/<reviewer>.txt now makes `ledger build` report NOT READY where it was silently ignored.

### Q4 (decision for the operator, F-002)
ledger.test.ts:233 pins "a fenced reviewer-shaped result beats a bare one". Keeping it means a quoted example in a code fence replaces the real bare result. Options: (a) keep the pin and require reviewers to use the labelled fence (the contract already says so); (b) change the rule to "last reviewer-shaped object wins, fenced or not", which needs an AC amendment; (c) treat fenced plus bare reviewer-shaped objects with different statuses as ambiguous (undefined). Recommended: (c), the cheapest that closes the replacement.

## Pre-existing (never block)


## Round 1 dispositions
- R1 F-001 (fenced pool): closed for non-result fences (review-logic, review-architecture); partial for a reviewer-shaped fenced sample (now F-002).
- R1 F-002 (fail-closed too broad): partial. The broad case is fixed, but the caps still fail closed on benign input (F-003) and a nested key fragment still fails closed (F-004).
- R1 F-003 (quadratic regexes): closed, with numbers under Q2.
- R1 F-004 (AC11/AC12 fixtures): closed.
- R1 F-005 (error text): partial. The parenthesis is still wrong for the fence and the bare reply (F-005).
- R1 F-006 (doc comment): partial. The comment still diverges from the code (F-007).
- R1 F-007 (acceptance rule in four places): open. Restated in F-006 and F-008.
- R1 F-008 (three strategies in one function): partial. Residual in F-008.
- R1 F-009 (KNOWN_MISSING): partial. Restated in F-010.
- R1 F-010 (same-status echo, pre-existing): open, restated as F-017.
- R1 F-011 (test title): closed. The same pattern recurs at ledger.test.ts:74 (F-009).

## Regressions the round-1 fixes introduced
- F-001: a quote before a bare real result replaces it (base returned the real result).
- F-002: a fenced reviewer-shaped sample before a bare real result replaces it (base returned the real result; the sample-after case was already so).
- F-003 and F-004: benign prose now yields a gap where the base parser returned the result.

## Mutation survivors (33 of 57)
| Mutant | Where | Change | Covered by |
|---|---|---|---|
| P01 | `src/review/ledger.ts:236` | `if (labelled !== undefined) return labelled.result;` to `if (labelled !== undefined && labelled.result !== undefined)` | F-015 |
| P02 | `src/review/ledger.ts:237` | `return afterMarker(raw) ?? scannedResult(raw);` to `return scannedResult(raw) ?? afterMarker(raw);` | F-014 |
| O08 | `src/review/ledger.ts:86` | `const KEY_COLON = /\s*:/y;` to `const KEY_COLON = /:/y;` | not cited: judged equivalent or unreachable by the reviewer (TEST-8), not independently verified |
| O09 | `src/review/ledger.ts:85` | `const RESULT_KEYS = new Set(["status", "reviewer", "findings` to `const RESULT_KEYS = new Set(["status"]);` | not cited: judged equivalent or unreachable by the reviewer (TEST-8), not independently verified |
| O11 | `src/review/ledger.ts:85` | `const RESULT_KEYS = new Set(["status", "reviewer", "findings` to `const RESULT_KEYS = new Set(["reviewer", "findings"]);` | not cited: judged equivalent or unreachable by the reviewer (TEST-8), not independently verified |
| T01 | `src/review/ledger.ts:83` | `const OBJECT_START = /\{\s*["}]/y;` to `const OBJECT_START = /\{/y;` | F-015 |
| T02 | `src/review/ledger.ts:83` | `const OBJECT_START = /\{\s*["}]/y;` to `const OBJECT_START = /\{"/y;` | F-015 |
| T03 | `src/review/ledger.ts:118` | `const MAX_UNCLOSED = 8;` to `const MAX_UNCLOSED = 7;` | F-013 |
| T04 | `src/review/ledger.ts:118` | `const MAX_UNCLOSED = 8;` to `const MAX_UNCLOSED = 9;` | F-013 |
| T05 | `src/review/ledger.ts:118` | `const MAX_UNCLOSED = 8;` to `const MAX_UNCLOSED = 1;` | F-013 |
| F02 | `src/review/ledger.ts:150` | `if (close === -1) break;` to `if (close === -1) { ranges.push([open, raw.length] as const)` | F-015 |
| F03 | `src/review/ledger.ts:152` | `open = raw.indexOf("```", close + 3);` to `open = raw.indexOf("```", close);` | F-015 |
| F04 | `src/review/ledger.ts:210` | `ranges[next]![1] <= start` to `ranges[next]![1] < start` | F-015 |
| R03 | `src/review/ledger.ts:166` | `typeof object.reviewer === "string"` to `object.reviewer !== undefined` | not cited: judged equivalent or unreachable by the reviewer (TEST-8), not independently verified |
| H01 | `src/review/ledger.ts:159` | `typeof (value as { status?: unknown }).status === "string"` to `(value as { status?: unknown }).status !== undefined` | not cited: judged equivalent or unreachable by the reviewer (TEST-8), not independently verified |
| L01 | `src/review/ledger.ts:173` | `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/gi` to `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/g` | F-015 |
| L02 | `src/review/ledger.ts:173` | `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/gi` to `/```REVIEW_RESULT[ \t]*\n([\s\S]*?)```/gi` | F-015 |
| L03 | `src/review/ledger.ts:173` | `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/gi` to `/```REVIEW_RESULT\r?\n([\s\S]*?)```/gi` | F-015 |
| L04 | `src/review/ledger.ts:173` | `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*?)```/gi` to `/```REVIEW_RESULT[ \t]*\r?\n([\s\S]*)```/gi` | F-015 |
| L05 | `src/review/ledger.ts:176` | `labelled[labelled.length - 1]![1]!` to `labelled[0]![1]!` | F-015 |
| L08 | `src/review/ledger.ts:178` | `catch { return { result: undefined }; }` to `catch { return undefined; }` | F-015 |
| A01 | `src/review/ledger.ts:189` | `/REVIEW_RESULT(?:[ \t]*[:=])?\s*(?=\{)/g` to `/REVIEW_RESULT(?:[ \t]*[:])?\s*(?=\{)/g` | F-014 |
| A02 | `src/review/ledger.ts:189` | `/REVIEW_RESULT(?:[ \t]*[:=])?\s*(?=\{)/g` to `/REVIEW_RESULT(?:[ \t]*[:=])?[ \t]*(?=\{)/g` | F-014 |
| A03 | `src/review/ledger.ts:189` | `/REVIEW_RESULT(?:[ \t]*[:=])?\s*(?=\{)/g` to `/REVIEW_RESULT(?:[ \t]*[:=])\s*(?=\{)/g` | F-014 |
| A04 | `src/review/ledger.ts:189` | `.slice(-MAX_MARKERS)` to `.slice(0, MAX_MARKERS)` | F-013 |
| A05 | `src/review/ledger.ts:182` | `const MAX_MARKERS = 8;` to `const MAX_MARKERS = 7;` | F-013 |
| A06 | `src/review/ledger.ts:182` | `const MAX_MARKERS = 8;` to `const MAX_MARKERS = 9;` | F-013 |
| A10 | `src/review/ledger.ts:194` | `if (end === undefined) continue;` to `if (end === undefined) return undefined;` | F-014 |
| A13 | `src/review/ledger.ts:198` | `catch { /* prose after the word: try the marker before */ }` to `catch { return undefined; }` | F-014 |
| W01 | `src/commands/review-slice.ts:171` | `const parsed = wholeFileResult(raw) ?? parseReviewResult(raw` to `const parsed = parseReviewResult(raw) ?? wholeFileResult(raw` | F-012 |
| W06 | `src/commands/review-slice.ts:164` | `async function readResult(source: string): Promise<ReviewerR` to `async function readResult(source: string): Promise<ReviewerR` | F-012 |
| D01 | `src/commands/review-ledger.ts:99` | `result.reviewer === undefined && !Array.isArray(result.findi` to `false` | F-011 |
| D03 | `src/commands/review-ledger.ts:100` | `ignored.push(`raw/${name}`);
      continue;` to `ignored.push(`raw/${name}`);` | F-011 |

The commutative O-series, O02, F01 and similar are equivalent mutants (TEST-8) and are not counted as gaps.

## Verified clean
- Replay of 98 saved reviewer replies: 97 parse identically on base and head, 1 differs (a review-verifier reply with a status-only object in a code excerpt; the intended AC13/AC14 change). 0 of 98 trigger F-002.
- AC11, AC12, AC14, AC15, AC17 behaviours hold at the parser level; AC13 holds as amended.
- objectEnd and topLevelObjects are linear and bounded; no RangeError escapes.
- Dependency direction is clean (commands import the ledger, not the reverse); no path is built from reply content; no dynamic execution of reply content.
- verify-exec-files: 3 pass, the stale-entry test keeps the allowlist honest.

## Not run
- Other Vantage overlays: none apply.
- review-backend, review-frontend, review-frontend-conventions: stack-excluded by `keryx review required`. Installed 0.3.112 `ledger build` still lists them as "no result recorded"; this is a tool limit, not a dispatch gap.
- review-core-boundaries, review-flow-graph, review-layout: path-gated, no matching paths.
- AC16 replay (T4); a buildLedger re-run of the F-001 consequence (only the parse was re-run by the verifier); the F-010 AC18 deviation; the 10/26 replay and the quote-parity variant; mutants A01-A03, A13, L02-L04, L08, P01, F02-F04, T01, T02 were not re-run by the verifier (they survived in the official mutation pass).
- Ledger: research.json is NOT READY. Three raws (review-security-code, review-style, review-testing-practices) carry a labelled fence holding a literal triple backtick inside a JSON string and are unparseable by the head parser (this is F-016 hitting this round's own raws; the raws were not altered). The package stays PENDING on dispatch evidence.

## Stage counts
Reviewers dispatched 9 (review-architecture, review-clean-code, review-highload, review-logic, review-performance, review-regression, review-security-code, review-style, review-testing-practices): about 40 raw findings, consolidated 17, verifier confirmed 17, removed 0.

Routing audit: graph_used no (not relevant), wiki_used no (not relevant), ctx_used yes, raw_rg_used no.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "afterMarker matches REVIEW_RESULT anywhere in the reply (mid-line, blockquote, list item, diff line, inside a code fence), not only where a reviewer wrote the marker, and takes the last one whose object is reviewer-shaped. A quoted contract line or fixture 'REVIEW_RESULT: {status, reviewer, findings}' therefore replaces the reviewer's real bare result.",
    "impact": "Trigger: a reviewer that writes its result as a bare marker plus object (no fence) and whose prose, before or after it, quotes a marker line from untrusted PR text, a fixture or this parser's docs. Outcome: the quoted object is the result. Proven: a real INCOMPLETE result with one blocker and slices became DONE with no findings; buildLedger then gave run.status=complete, obligations=0, rawReconciled=true, no gaps. A quote BEFORE the real result is a regression of this PR (the base parser returned the real result); a quote AFTER was already so on main. The REVIEW_RESULT fence the contract mandates is immune.",
    "suggested_fix": "Count a marker only where it starts its line (spaces, tabs and the quote or list prefixes > * # - allowed) and lies outside a ``` fence, using a forward cursor over fenceRanges so it stays linear: /(?<![^\\n])[ \\t>*#-]*REVIEW_RESULT(?:[ \\t]*[:=])?\\s*(?=\\{)/g. Tried on scratch copies by two reviewers: the verifier re-ran it: ledger.test.ts 64/64 and review-slice plus review-ledger tests 24/24 stay green. A forged marker on its own plain line still wins; it cannot be told from a real corrected result without breaking frozen AC15 (ledger.test.ts:227-231). Verifier note: with this fix a quote on its OWN line before a bare real result (no marker) still returns the quote, so the regression is narrowed to a plain line-start quote, not closed; closing it needs the position or ambiguity rule of F-002.",
    "evidence": "Probes in scratchpad r2/review-logic/p2.ts:34-43, p3.ts:39-40 and r2/review-security-code/proof.ts cases A-G: 'real BLOCKED bare result, then a line starting REVIEW_RESULT: {DONE, name}' returns DONE; 'quoted marker then real bare BLOCKED' returns the quoted one in the head parser and the real one in the base parser. Raised independently by review-logic (major) and review-security-code (minor), review-regression reproduced the after-case. Verifier (review-verifier) reproduced: quote line before a bare real result: head q/DONE/0 findings, base r/INCOMPLETE/1 finding.",
    "confidence": "high",
    "file": "src/review/ledger.ts",
    "line": 189,
    "quote": "const markers = [...raw.matchAll(/REVIEW_RESULT(?:[ \\t]*[:=])?\\s*(?=\\{)/g)].slice(-MAX_MARKERS);",
    "locator": {
      "state": "derived",
      "method": "exact",
      "reported_line": 189
    },
    "class_scope": {
      "sites": [
        "src/review/ledger.ts:189 (afterMarker, the only marker matcher)",
        "src/review/ledger.ts:237 (parseReviewResult step 2, sole caller)",
        "src/commands/review-slice.ts:171 (readResult)",
        "src/commands/review-ledger.ts:92 (loadRaws)"
      ],
      "enumeration_method": "keryx ctx rg for REVIEW_RESULT, afterMarker and parseReviewResult across src: every reviewer-reply parse goes through parseReviewResult and only afterMarker matches the bare marker."
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-001",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "bun p1.ts / p2.ts (scratch copy, head vs base). Real marker result (INCOMPLETE, 1 blocker, slices) followed by a line 'REVIEW_RESULT: {DONE,q,findings:[]}': head q/DONE/0 findings, base also q/DONE (already so on main). Quote line BEFORE a BARE real result (no marker): head q/DONE/0, base r/INCOMPLETE/1 finding, so a regression of this PR. Quote then real MARKER result: head r/INCOMPLETE (last marker wins), not affected. Suggested fix applied in a scratch copy (line-start, outside-fence marker regex plus fence cursor): bun test src/review/ledger.test.ts -> 64 pass 0 fail; src/commands/review-slice.test.ts + review-ledger.test.ts -> 24 pass 0 fail (review-slice.test.ts alone has 4 tests, so the finding's 68/68 is ledger 64 + review-slice 4). With the fix, mid-line and in-fence quotes no longer win (real marker + mid-line quote -> r/INCOMPLETE, + quote in ```text fence -> r/INCOMPLETE), but a quote on its OWN line before a bare real result still returns q/DONE, so the fix does not close the regression case with a line-start quote. buildLedger consequence (run.status complete) not re-run; only the parse was.",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-002",
    "reviewer": "review-regression",
    "severity": "major",
    "problem": "scannedResult prefers any fenced reviewer-shaped object over the real bare result, even when the fence is not a labelled REVIEW_RESULT fence. The residual of round-1 F-001: that fix keeps a non-result fenced object from hiding the real result, but a fenced REVIEWER-SHAPED sample (status plus reviewer or findings) still wins. The pre-PR parser took the last object with a status, i.e. the real result when it came last. Pinned by ledger.test.ts:233 ('a fenced result wins over a differing bare object'), which AC11-AC18 do not freeze.",
    "impact": "Trigger: a saved raw reply with no labelled fence and no marker, whose real result is a bare object and which also quotes a reviewer-shaped sample in a json fence. Outcome through loadRaws and buildLedger: the raw is attributed to the sample's reviewer name; gaps 'review-logic: no result recorded' and 'review-logic:EX-1: raw finding is not in the canonical findings' appear, the sample's finding becomes an obligation and the real finding never enters the ledger; retry-plan --result takes the sample's status and slices. Likelihood on real data is low: 0 of 98 replayed replies trigger it.",
    "suggested_fix": "Operator decision, because a frozen-looking test pins the current rule. Narrowest: when a fenced reviewer-shaped result and a bare reviewer-shaped result both exist and differ in reviewer or status, return undefined (ambiguous) and update the test at ledger.test.ts:233. Alternative: choose by position (the last reviewer-shaped object), the pre-PR rule.",
    "evidence": "scratchpad r2/review-regression/disp.ts and raws.ts: a fenced reviewer-shaped sample BEFORE the real bare result: base review-logic/DONE, head example/DONE; a sample with a different status: base review-logic/DONE, head example/BLOCKED.",
    "confidence": "medium",
    "file": "src/review/ledger.ts",
    "line": 217,
    "quote": "if (fencedResults.length > 0) return fencedResults[fencedResults.length - 1];",
    "locator": {
      "state": "derived",
      "method": "exact",
      "reported_line": 217
    },
    "class_scope": {
      "sites": [
        "src/review/ledger.ts:216-217 (scannedResult fenced preference)",
        "src/commands/review-ledger.ts:92 (loadRaws)",
        "src/commands/review-slice.ts:171 (readResult)"
      ],
      "enumeration_method": "keryx ctx rg for parseReviewResult, hasStatus and ParsedResult under src: the only production importers are loadRaws and readResult; both reach scannedResult only when no labelled fence and no marker result applies."
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-002",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "bun p1.ts: ```json fence {BLOCKED,reviewer:example,findings:[EX-1]} then a bare {DONE,review-logic,findings:[]}, no label, no marker: head example/BLOCKED/1, base review-logic/DONE/0. Sample AFTER the bare result: both parsers example/BLOCKED. So the 'sample before' case is a regression of this PR, the 'after' case was already so on main. Test ledger.test.ts:233 pins the fenced-wins rule (read at the site).",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-003",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "Reaching a count cap is treated as truncation, the same as an unclosed fragment that carries a result key. Nine or more unclosed non-result prose fragments (MAX_UNCLOSED = 8) discard a genuine bare result; a genuine marker result followed by 8 or more later 'REVIEW_RESULT {\"status\":...}' lines whose objects carry differing statuses is pushed out of the MAX_MARKERS = 8 window and the scan then sees conflicting statuses. The cost the caps bound is about 3 ms per MB per scan, far below what 8 allows.",
    "impact": "A bare reply (no fence, no marker) with 9 or more '{\"' prose fragments before or after the result, or a marker reply with 8 or more trailing marker lines carrying differing statuses (verifier: 7 parse, 8 and 9 do not; plain 'REVIEW_RESULT {contract}' lines without a status do not trip it), gives undefined: loadRaws raises 'no parseable REVIEW_RESULT block' and the reviewer is re-dispatched, retry-plan --result exits 2. Fails closed, never a wrong result; the base parser returned the result for the fragment half (in the conflicting-status marker case it returned the last status-only object). The fenced form is immune.",
    "suggested_fix": "At the cap return truncated: false and keep truncated: true only for a fragment claiming a result key (verified on a scratch copy, 64/64), or bound the work by scanned characters instead of fragment count, or use a flat cap near 64; apply the same to the marker window.",
    "evidence": "probe.ts (review-performance): 1 and 8 unclosed prose fragments then a genuine bare result -> reviewer r; 9 and 12 -> undefined, base returned r. review-logic p2fix.ts and p3fix.ts verified the fix.",
    "confidence": "high",
    "file": "src/review/ledger.ts",
    "line": 133,
    "quote": "if (claimsResult || (unclosed += 1) > MAX_UNCLOSED) return { found, truncated: true };",
    "locator": {
      "state": "derived",
      "method": "exact",
      "reported_line": 133
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-003",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "bun p1.ts: bare result with N prose fragments 'note i {\"x' before: N=1,7,8 -> review-logic/DONE, N=9,12 -> UNDEFINED (base returns the result at all N); after: 8 -> result, 9,12 -> UNDEFINED. bun p2.ts marker half: 'REVIEW_RESULT: <real INCOMPLETE>' + N later lines 'REVIEW_RESULT {\"status\":\"Xi\"}': N=6,7 -> r/INCOMPLETE, N=8,9 -> UNDEFINED (real marker leaves the slice(-8) window, the scan then sees conflicting statuses). Correction: the marker half trips at 8 later lines, not 9, and only when the later marker objects carry differing statuses; with plain 'REVIEW_RESULT {contract i}' lines (no status) 7/8/9 all still return the result because the scan finds a single bare object. In that conflicting-status case the base parser also did not return the real result (it returned the last status-only object), so 'base returned the result' holds for the fragment half only.",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-004",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "problem": "The objectEnd doc says claimsResult is true only when the object itself (not an object nested in it) carries a result key. topLevelObjects then does start += 1 on every unclosed fragment, so the scan re-enters the nested object at its own '{\"', where its keys sit at depth 1 and count. The depth === 1 test cannot do the job the comment gives it. Related: an odd quote count in prose after the result plus an earlier non-result '{\"' fragment makes that candidate close at a stray '}', fail JSON.parse and be skipped whole (AC12), so the real result inside it is never revisited.",
    "impact": "A complete genuine bare result followed by the prose fragment '{\"meta\":{\"status\":\"ok\"' gives undefined; the same reply with '{\"meta\":{\"x\":1' returns the result. Fails closed (gap, re-dispatch); the base parser returned the result. Rated minor, not major as review-clean-code raised it: the outcome is the same gap as F-003, never a wrong result.",
    "suggested_fix": "Drop the depth test and say 'any result key in the fragment, nested included', or make topLevelObjects skip the content of a prose fragment instead of re-entering it; pin the nested-key case with a test.",
    "evidence": "scratchpad r2/review-clean-code/t.ts: nestedCut -> undefined, outerCutNoKey -> the real result; review-logic p2.ts line 19 and p3.ts line 16 for the quote-parity variant.",
    "confidence": "high",
    "file": "src/review/ledger.ts",
    "line": 105,
    "quote": "if (depth === 1 && !claimsResult && RESULT_KEYS.has(raw.slice(keyFrom, end))) {",
    "locator": {
      "state": "derived",
      "method": "exact",
      "reported_line": 105
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-004",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "bun p1.ts: real bare result + '\\nlog: {\"meta\":{\"status\":\"ok\"' -> head UNDEFINED, base review-logic/DONE; same with '{\"meta\":{\"x\":1' -> head and base review-logic/DONE. The quote-parity variant was not run.",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-005",
    "reviewer": "review-style",
    "severity": "minor",
    "problem": "The parenthesis misstates the rules it summarises: a ```REVIEW_RESULT fence needs only a status (a fence with reviewer and findings but no status is refused), the bare-object reply (status plus reviewer or findings, no marker) is omitted, and 'holds no usable reviewer result' is still circular. The test pins the substring 'a truncated or ambiguous reply is refused', so the prose is part of the contract.",
    "impact": "An operator whose saved reply was refused is told a rule that is wrong for the fence and incomplete for bare replies and cannot tell which field is missing.",
    "suggested_fix": "Name the accepted shapes: a JSON object with a status; a ```REVIEW_RESULT block with a status; or a reply holding one object with a status and a reviewer or findings (bare, or after a REVIEW_RESULT marker); a truncated or ambiguous reply is refused. Ideally build it from one constant next to parseReviewResult; update review-slice.test.ts:80 and :91 with it.",
    "evidence": "parseReviewResult measured via bun (scratchpad r2/review-style/t.ts): fence {reviewer,findings} without status -> undefined; fence {status} -> object; ```json fence {status} -> undefined; bare {status,reviewer} -> object; marker {reviewer,findings} without status -> undefined.",
    "confidence": "high",
    "file": "src/commands/review-slice.ts",
    "line": null,
    "quote": "result holds no usable reviewer result (a JSON object with a status, or a reply with a REVIEW_RESULT block carrying a reviewer or findings; a truncated or ambiguous reply is refused)",
    "locator": {
      "state": "unlocatable",
      "reason": "the quote does not appear in the file",
      "reported_line": 172
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-005",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "bun p1.ts head: ```REVIEW_RESULT fence {reviewer,findings} no status -> UNDEFINED; fence {status} only -> object; ```json fence {status} only -> UNDEFINED (base returned the object); bare {status,reviewer} -> object; marker {reviewer,findings} no status -> UNDEFINED. Message text at src/commands/review-slice.ts:172 reads '(a JSON object with a status, or a reply with a REVIEW_RESULT block carrying a reviewer or findings; a truncated or ambiguous reply is refused)', and 'truncated or ambiguous' is matched in review-slice.test.ts by keryx ctx rg (3 matches over the two files).",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-006",
    "reviewer": "review-architecture",
    "severity": "minor",
    "problem": "loadRaws hand-writes a looser negation of the private isReviewerResult (reviewer === undefined instead of typeof reviewer === 'string'). The attribution half is written three times and the copies differ: isReviewerResult (ledger.ts:166), this line, and ledger.ts:279 (!text(raw.result.reviewer)). Round-1 F-007, still open; shared-definitions.mdc says a comment is not sufficient to connect two places that must agree. loadRaws also never compares the declared reviewer with the driver or file stem (retry-plan does).",
    "impact": "A fence of {\"status\":\"DONE\"} is dropped silently into ignored; a fence of {\"status\":\"DONE\",\"reviewer\":null} becomes a raw with a result, then the gap 'names no reviewer'. Both outcomes are non-passing; the cost is a silent drift when the parser's definition changes.",
    "suggested_fix": "Export isReviewerResult and use !isReviewerResult(result) here, keeping the comment as the why. Optionally require result.reviewer to equal the driver's reviewer when the driver names the file.",
    "evidence": "scratchpad r2/review-architecture/probe.ts: fencedStatusOnly parse=result ledger=ignored; fencedReviewerNull parse=result ledger=raw+result then gap at ledger.ts:279.",
    "confidence": "high",
    "file": "src/commands/review-ledger.ts",
    "line": 99,
    "quote": "if (result !== undefined && result.reviewer === undefined && !Array.isArray(result.findings)) {",
    "locator": {
      "state": "derived",
      "method": "exact",
      "reported_line": 99
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-006",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "bun p3.ts through loadRaws (src/commands/review-ledger.ts) with three raw files: fence {\"status\":\"DONE\"} -> ignored ['raw/review-a.txt']; fence {\"status\":\"DONE\",\"reviewer\":null} -> raws entry with result {status:DONE,reviewer:null}; fence with reviewer string -> raws entry. parseReviewResult returns an object for all three. Line 99 quote exists as cited.",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-007",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "problem": "Comments say less or something else than the code does. scannedResult says 'No label and no marker' but also runs when markers exist and none gave a reviewer result. Rule 3 of the parseReviewResult doc says prose braces are skipped 'a few times' and never says the ninth gives no result, and item 3 is one run-on sentence with a broken wrap. MAX_MARKERS says markers are tried but not that older ones are ignored and the scan runs, the opposite of MAX_UNCLOSED where passing the cap means no result. The ambiguity clause covers every bare object with a status, so a quoted {\"id\":\"S1\",\"status\":\"fixed\"} counts. Decision gives the chain two 'not applicable' conventions, hasStatus declares a type guard that checks only status, and inFence relies on an undocumented ascending start order.",
    "impact": "A maintainer cannot predict: marker {\"status\":\"X\"} then a real bare result -> undefined; a real result then 'example {\"id\":\"S1\",\"status\":\"fixed\"}' -> undefined; a real marker result then 9 later marker lines -> undefined, with 7 it parses. Reading cost only.",
    "suggested_fix": "Edit the comments only: state the real precedence including the caps, the ambiguity rule and the ascending-start requirement.",
    "evidence": "scratchpad r2/review-clean-code/t.ts: markerThenScan, ambig, markerCap9bad -> undefined; markerCap7bad, eightUnclosed -> the real result; nineUnclosed -> undefined.",
    "confidence": "high",
    "file": "src/review/ledger.ts",
    "line": 203,
    "quote": "/** No label and no marker: the reviewer-shaped objects at the top level, fenced ones first. */",
    "locator": {
      "state": "derived",
      "method": "exact",
      "reported_line": 203
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-007",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "bun p5.ts head: 'REVIEW_RESULT: {\"status\":\"X\"}' then real bare -> UNDEFINED; real bare then 'example {\"id\":\"S1\",\"status\":\"fixed\"}' -> UNDEFINED; real marker + 7 later marker lines -> r/DONE, + 8 or 9 -> UNDEFINED; 7 and 8 unclosed fragments -> result, 9 -> UNDEFINED. Comment at ledger.ts:203 reads 'No label and no marker' while scannedResult also runs after a marker that gave no reviewer result (parseReviewResult line 237). Count of 'later lines' is 8, not 9 (see F-003).",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-008",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "problem": "objectEnd does two jobs: it finds the closing brace and detects result keys for the truncation decision. afterMarker discards claimsResult, yet the key detection runs on every marker candidate. The module-level sticky regexes KEY_COLON and OBJECT_START are shared mutable state (lastIndex) that callers must reset, and the try { JSON.parse } catch pair is written three times.",
    "impact": "Linear and small cost; a half-meaningless return value and a trap for the next editor.",
    "suggested_fix": "Keep objectEnd a pure brace matcher or give it an optional onKey callback; add a tryParse helper; build the sticky regex locally.",
    "evidence": "Reading of the three call sites; afterMarker at ledger.ts:193 ignores claimsResult.",
    "confidence": "medium",
    "file": "src/review/ledger.ts",
    "line": 193,
    "quote": "const { end } = objectEnd(raw, start);",
    "locator": {
      "state": "derived",
      "method": "exact",
      "reported_line": 193
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-008",
    "verification": {
      "verdict": "confirmed",
      "method": "site-check",
      "evidence": "Read ledger.ts at the cited lines: afterMarker line 193 'const { end } = objectEnd(raw, start);' ignores claimsResult; module-level sticky regexes OBJECT_START (line 83) and KEY_COLON (line 86) with lastIndex set by callers (lines 129, 106); try { JSON.parse } catch appears three times (lines 137, 175-178, 195-198). This establishes the code shape only, not any consequence.",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-009",
    "reviewer": "review-style",
    "severity": "minor",
    "problem": "Titles no longer match assertions and tests repeat. (a) Line 74: a ```json fence is now accepted only with a reviewer or findings, so 'carries a status' is wrong (a status-only json fence gives undefined). (b) Line 188, AC15: the last two assertions (truncated marker object, status-only marker object) test AC11 and AC13/AC14. (c) Lines 129 and 248 are titled 'linear time' but assert a wall-clock bound under 2000 ms. (d) Lines 179-180 repeat lines 223-224 exactly; lines 81 and 207 (escaped quote and brace) and lines 125 and 238 (a fenced non-result beside the bare result) are near-duplicates.",
    "impact": "A failing test names the wrong rule (the F-011 pattern of round 1, again), the duplicates add maintenance with no coverage, and a timing bound in a test titled 'linear' will read as a parser regression on a slow runner (low flake risk: milliseconds against two seconds).",
    "suggested_fix": "Retitle line 74 to 'takes the last fenced block that is a result (a REVIEW_RESULT fence needs a status, a json fence a reviewer or findings)'; move the two extra AC15 assertions to the AC11 and AC13 tests; delete the exact duplicate and merge the two near-duplicates; retitle the timing tests 'finish within two seconds'.",
    "evidence": "ledger.test.ts lines 74, 81 vs 207, 125 vs 238, 179-180 vs 222-225, 188-193, 129-136, 248-255; status-only json fence checked in scratchpad r2/review-style/t.ts.",
    "confidence": "high",
    "file": "src/review/ledger.test.ts",
    "line": 74,
    "quote": "test(\"reads a REVIEW_RESULT fence and a json fence, and takes the last block that carries a status\", () => {",
    "locator": {
      "state": "derived",
      "method": "exact",
      "reported_line": 74
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-009",
    "verification": {
      "verdict": "confirmed",
      "method": "site-check",
      "evidence": "Read ledger.test.ts: line 74 title says 'takes the last block that carries a status' and bun p1.ts shows a ```json fence {status} only gives UNDEFINED; lines 191-192 (inside the AC15 test at 188) assert a truncated marker object and a status-only marker object (AC11/AC13 material); lines 129 and 248 are titled 'linear time' and assert performance.now() delta < 2000. Duplicates: lines 179-180 and 223-224 are the exact same two assertions; lines 81 and 207 test the same escaped-quote rule with different strings, and lines 125 and 238 differ in the fenced object (238 carries a status), so those two are near-duplicates, not identical.",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-010",
    "reviewer": "review-architecture",
    "severity": "minor",
    "problem": "Round-1 F-009 is only partly closed. (a) The four flow-375 exemptions deviate from the frozen AC18 text (the test fails when a named file does not exist) and no operator decision is recorded. (b) TEST_FILE is unchanged: it needs whitespace on both sides, so a quoted path, trailing comma, .spec.ts, glob, .test.js or a command with '; echo' after the file is skipped without a trace. (c) Every historical frozen AC now depends on src: 415 git-tracked flow directories cannot be edited, so renaming a test file named by an old verify line fails this test. (d) The comment 'passes vacuously' is imprecise: bun test with only a missing file exits 1; it passes only when the command also names an existing file.",
    "impact": "(a) AC18 is satisfied only with an unsigned exemption, so flow 375 keeps the vacuous gate AC18 exists to prevent. (b) Latent today: a future exec line in one of those shapes naming a missing file passes. (c) Lasting cost of AC18's design. (d) A reader may conclude single-file lines are also at risk.",
    "suggested_fix": "(a) Record the operator's decision on flow 375 in the PR (write the four tests, or re-seal flow 375 with keryx flow ac update). (b) Widen the token regex or assert every [verify: exec line yields a token or has no .test. text. (c) Say in the header that renaming needs a KNOWN_MISSING entry. (d) Reword: 'bun test skips a missing file when the command names other test files, so the gate passes without running it.'",
    "evidence": "bun test src/flow/verify-exec-files.test.ts: 3 pass; git ls-files shows 415 flow directories; AC18 text at acceptance-criteria.md:49; bun 1.4.2: 'bun test src/nope/missing.test.ts' exit 1, the same plus an existing file exit 0.",
    "confidence": "medium",
    "file": "src/flow/verify-exec-files.test.ts",
    "line": null,
    "quote": "const KNOWN_MISSING: Record<string, readonly string[]> = {",
    "locator": {
      "state": "unlocatable",
      "reason": "no such file at this round's head: src/flow/verify-exec-files.test.ts",
      "reported_line": 15
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-010",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "bun test src/flow/verify-exec-files.test.ts -> 3 pass 0 fail. In a scratch dir: bun test src/nope/missing.test.ts -> exit 1; bun test src/nope/missing.test.ts ok.test.ts -> exit 0 (1 pass), so the 'passes vacuously' wording is only true when an existing file is also named. TEST_FILE regex run on commands: quoted path \"src/a/b.test.ts\" -> [], single-quoted -> [], 'foo.spec.ts' -> [], 'b.test.js' -> [], glob 'src/a/**/*.test.ts' -> [], 'src/a/b.test.ts; echo done' -> [] (token needs whitespace/end after), trailing comma 'b.test.ts,' -> [] for that token. git ls-files .metaproject/flows lists 415 flow directories. Part (a), deviation from the frozen AC18 text, was not checked.",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-011",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "problem": "The parser accepts a status-only object inside a labelled fence (AC13 as amended) and this test pins that, but nothing pins what the ledger does with it: loadRaws drops such a result without a gap. Neither side of the guard is exercised end to end.",
    "impact": "A fenced {\"status\":\"DONE\"} reply is accepted by the parser, contributes nothing to the ledger and raises no gap. Changing or removing that branch passes every test, so the amended AC13 is unpinned end to end.",
    "suggested_fix": "One test in src/commands/review-ledger.test.ts: a raw file holding a fenced status-only result produces a named gap or an explicitly asserted no-op.",
    "evidence": "mutant:D01 survived (guard replaced by false); D03 survived (the continue removed). review-ledger.ts:98-102.",
    "confidence": "high",
    "file": "src/review/ledger.test.ts",
    "line": 183,
    "quote": "test(\"AC14: a ```REVIEW_RESULT fence keeps the status-only rule\", () => {",
    "locator": {
      "state": "derived",
      "method": "exact",
      "reported_line": 183
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-011",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "Scratch copy wt-m, mutants from research-evidence/mutants.json applied one at a time, bun test src/review/ledger.test.ts src/commands/review-slice.test.ts src/commands/review-ledger.test.ts (baseline 88 pass 0 fail): D01 (guard at review-ledger.ts:99 replaced by false) -> exit 0, 88 pass 0 fail, survived; D03 (continue removed) -> exit 0, 88 pass, survived. Control: W02 -> exit 1, 87 pass 1 fail, killed.",
      "verifier": "review-verifier"
    },
    "severity_audit": {
      "from": "minor",
      "to": "major",
      "evidence": "mutation-1.json#D01"
    }
  },
  {
    "id": "F-012",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "problem": "Only the refusal side of wholeFileResult is tested. A whole file that is one JSON object with a status and no reviewer, read with --reviewer, is accepted, while the same object after a bare marker is a gap in the parser; that divergence has no test. The stdin path of readResult is also unexercised, and a bare-status retry reply saved as raw/<reviewer>.txt now makes ledger build NOT READY where it was silently ignored, which the PR text does not say.",
    "impact": "Changing wholeFileResult to require a reviewer, to accept an object without a status, or reordering it behind parseReviewResult keeps the suite green.",
    "suggested_fix": "Add a whole-file status-only case with --reviewer (assert written), the same object after a bare marker (assert exit 2, nothing written) and a stdin case; add a line to the PR text about the ledger change.",
    "evidence": "mutant:W01 survived (wholeFileResult and parseReviewResult swapped); W06 survived (stdin source token); W02 killed.",
    "confidence": "high",
    "file": "src/commands/review-slice.test.ts",
    "line": null,
    "quote": "test(\"a plain JSON file without a status is refused, and the reason is the exit code 2 contract\", async () => {",
    "locator": {
      "state": "unlocatable",
      "reason": "no such file at this round's head: src/commands/review-slice.test.ts",
      "reported_line": 59
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-012",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "Same harness: W01 (parseReviewResult(raw) ?? wholeFileResult(raw), order swapped) -> exit 0, 88 pass 0 fail, survived; W06 (stdin token '-' changed) -> exit 0, 88 pass, survived. Control W02 killed (87 pass 1 fail).",
      "verifier": "review-verifier"
    },
    "severity_audit": {
      "from": "minor",
      "to": "major",
      "evidence": "mutation-1.json#W01"
    }
  },
  {
    "id": "F-013",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "problem": "MAX_UNCLOSED = 8 and MAX_MARKERS = 8 are exercised only by inputs far over the cap. Witness inputs show behavioural differences for MAX_UNCLOSED 7 and 9 (T03, T04), 1 (T05) and MAX_MARKERS 7 and 9 (A05, A06) and for slice(-8) against slice(0, 8) (A04).",
    "impact": "A drift of a cap by one, or reversing which end of the marker list is kept, passes; the caps decide whether a genuine result is skipped (F-003).",
    "suggested_fix": "Boundary tests: 8 unclosed non-result fragments then a valid result is read, 9 gives the documented outcome; the same for 8 and 9 invalid markers after a valid marker.",
    "evidence": "Survivors T03, T04, T05, A04, A05, A06 in research-evidence/mutation-1.md.",
    "confidence": "high",
    "file": "src/review/ledger.test.ts",
    "line": 97,
    "quote": "test(\"an unclosed fragment that does not carry the result keys is skipped, before or after the result\", () => {",
    "locator": {
      "state": "derived",
      "method": "exact",
      "reported_line": 130
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-013",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "Same harness: T03 (MAX_UNCLOSED 7), T04 (9), T05, A04 (slice(0, MAX_MARKERS) instead of slice(-MAX_MARKERS)), A05, A06 all exit 0, 88 pass 0 fail, survived. Behavioural witness: bun p5.ts shows 8 unclosed fragments parse and 9 do not, so the cap is observable but unpinned.",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-014",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "problem": "Marker forms and the marker fallback are thinly pinned: the separators (=, newline after the colon, space only: A01-A03), the order of the marker and scan rules (P02), a cut-off last marker object falling back to the earlier marker (A10, fail-open) and a trailing 'see REVIEW_RESULT {contract}' fragment (A13). No test pins the quoted-prose residual of F-001 either.",
    "impact": "A10 (a cut-off last marker object returns the earlier marker's result) changes silently in either direction; so does the precedence between the marker and the scan.",
    "suggested_fix": "Tests for the colon-newline and colon-less forms, a truncated last marker with an earlier valid marker, a trailing prose mention, and a marker plus a differing bare object (AC15 ordering).",
    "evidence": "mutant:P02 survived (scannedResult tried before afterMarker); A01, A02, A03, A10, A13 survived. A10 verified in a scratch copy.",
    "confidence": "high",
    "file": "src/review/ledger.test.ts",
    "line": 227,
    "quote": "test(\"the last marker wins when a reply names the result twice\", () => {",
    "locator": {
      "state": "derived",
      "method": "exact",
      "reported_line": 227
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-014",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "Same harness: P02 (scannedResult tried before afterMarker) -> exit 0, 88 pass 0 fail, survived; A10 (cut-off last marker object returns undefined instead of continuing) -> exit 0, 88 pass, survived. A01-A03 and A13 were not run.",
      "verifier": "review-verifier"
    },
    "severity_audit": {
      "from": "minor",
      "to": "major",
      "evidence": "mutation-1.json#P02"
    }
  },
  {
    "id": "F-015",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "problem": "Labelled-fence and fence-pairing edge cases are unpinned: two labelled fences with the last one winning (L05, L04), CRLF after the label (L02), trailing space (L03), lower-case label (L01), an invalid labelled fence followed by a bare result (L08, P01), pairing around a later unlabelled fence (F02, F03, F04), a pretty-printed multi-line bare object (T02, T01). The labelled-fence regex is the code the last fix commit rewrote.",
    "impact": "A regression in the fence regex or the pairing logic would not fail a test; for L05 a labelled fence taking the first block instead of the last would pass.",
    "suggested_fix": "One table-driven test over these inputs.",
    "evidence": "mutant:L05 survived (labelled[0] instead of the last); L01-L04, L08, P01, F02-F04, T01, T02 survived.",
    "confidence": "high",
    "file": "src/review/ledger.test.ts",
    "line": 86,
    "quote": "test(\"a bare object before a fence is not fenced: two bare objects with different statuses stay ambiguous\", () => {",
    "locator": {
      "state": "derived",
      "method": "exact",
      "reported_line": 86
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-015",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "Same harness: L05 (labelled[0] instead of last labelled fence) -> exit 0, 88 pass 0 fail, survived; L01 (case-insensitivity mutant from the list) -> exit 0, 88 pass, survived. Other cited mutants (L02-L04, L08, P01, F02-F04, T01, T02) were not run.",
      "verifier": "review-verifier"
    },
    "severity_audit": {
      "from": "minor",
      "to": "major",
      "evidence": "mutation-1.json#L05"
    }
  },
  {
    "id": "F-016",
    "reviewer": "review-regression",
    "severity": "major",
    "problem": "Pre-existing, in both base and head. When a JSON string inside the labelled fence contains a literal triple backtick (a reviewer quoting the fence label), the lazy fence regex stops at it, JSON.parse fails, and labelledFence decides alone with no fallback to the scan. 10 of 26 real fenced replies parse to undefined in base and head; taking the block up to a closing fence at line start, all 10 parse to complete valid results. Three of this round's own nine raws (review-security-code, review-style, review-testing-practices) are this shape: the head parser returns undefined for them.",
    "impact": "Trigger: a reviewer reply whose REVIEW_RESULT block quotes a triple backtick inside a string (common when a finding discusses this parser or the fence contract). Outcome: 'no parseable REVIEW_RESULT block' gap for a complete, valid reply, a re-dispatch or a manual fix; retry-plan --result exits 2. Fails closed. Not caused by this PR, so it never blocks it.",
    "suggested_fix": "Fall back to the scan (afterMarker, scannedResult) when the labelled block fails JSON.parse; the existing test at ledger.test.ts about line 520 (an invalid labelled block followed by a status-only object stays undefined) would still pass. Or close the block at a fence at line start.",
    "evidence": "scratchpad r2/review-regression replay over 26 real fenced replies; the round-2 raw review-style.txt is one of them.",
    "confidence": "high",
    "file": "src/review/ledger.ts",
    "line": null,
    "quote": "/```REVIEW_RESULT[ \\t]*\\r?\\n([\\s\\S]*?)```/gi",
    "locator": {
      "state": "unlocatable",
      "reason": "the quote does not appear in the file",
      "reported_line": 173
    },
    "class_scope": {
      "sites": [
        "src/review/ledger.ts:172-179 (labelledFence, decides alone)",
        "src/commands/review-ledger.ts:92 (loadRaws)",
        "src/commands/review-slice.ts:171 (readResult)"
      ],
      "enumeration_method": "keryx ctx rg for labelledFence and parseReviewResult under src; one decision site and the two production callers."
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-016",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "bun p1.ts: ```REVIEW_RESULT fence whose JSON string contains a literal ``` -> head UNDEFINED and base UNDEFINED (pre-existing). bun rawcheck.ts on the three round-2 raws (review-security-code.txt, review-style.txt, review-testing-practices.txt) -> UNDEFINED for all three. bun p4.ts: the lazy fence regex block fails JSON.parse for all three, while a block closed at a ``` at line start parses to review-security-code/DONE_WITH_CONCERNS, review-style/DONE, review-testing-practices/DONE_WITH_CONCERNS. The 10-of-26 replay was not re-run.",
      "verifier": "review-verifier"
    }
  },
  {
    "id": "F-017",
    "reviewer": "review-security-code",
    "severity": "minor",
    "problem": "Round-1 F-010, unchanged and now documented. The ambiguity gate compares only the status string, so two bare reviewer-shaped objects with the same status and different findings are not ambiguous and the last wins; same on main.",
    "impact": "A findings: [] echo with the same status after the real result with findings drops the real findings.",
    "suggested_fix": "Treat two reviewer-shaped objects as ambiguous unless deep-equal, or count only trailing objects.",
    "evidence": "Reproduced by review-security-code and review-logic; behaviour identical on main.",
    "confidence": "high",
    "file": "src/review/ledger.ts",
    "line": null,
    "quote": "new Set(bare.filter(hasStatus).map((value) => value.status)).size > 1",
    "locator": {
      "state": "unlocatable",
      "reason": "the quote does not appear in the file",
      "reported_line": 218
    },
    "global_id": "2026-10-13-pr-997-round2-d5a8cfdc#F-017",
    "verification": {
      "verdict": "confirmed",
      "method": "execution",
      "evidence": "bun p1.ts: two bare {status:DONE,reviewer:r} objects, first with findings:[{id:A}], second findings:[] -> head r/DONE/0 findings (last wins), base identical (pre-existing).",
      "verifier": "review-verifier"
    }
  }
]
```
