# Independent review, flow 399 (PRs 870 and 871)

Scope: the code merged by PR 870 (topic history restore) and PR 871 (table-part splitter), read at origin/main 54eb6561a997215acfc7b7946d1f6643469f2156.
Reviewers (fresh agents, none of them wrote the code): review-logic, review-security-code, review-testing-practices, review-architecture. Verifier: review-verifier, which can only delete.

## Outcome

20 findings: 0 blockers, 2 majors (T-1, T-2, both test gaps), 7 minors, 11 info. The verifier confirmed all 20; none was deleted. All findings are recorded as open: only the operator dismisses a finding.
Targeted test runs passed (259 pass, 10 skip, 0 fail). Splitter fuzzing found 0 parts over 4096 rendered characters in about 4,300 parts. Security found no leak outside the live session; history restore is capped (/history N at 20, 1500 characters per turn). Health: PASS (score 94).

```json keryx:findings
[
  {
    "id": "T-1",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/remote/topic-history.test.ts",
    "line": 169,
    "problem": "The redactSensitiveText path in formatHistoryItem is never exercised: every fixture is caught earlier by looksLikeSecret.",
    "impact": "Removing the redaction call at history.ts:134 leaves the suite green, so a regression that sends an unredacted restored turn to Telegram would not be caught.",
    "suggested_fix": "Add fixtures AKIAIOSFODNN7EXAMPLE, ghp_ plus 36 alphanumerics, and one secret straddling the 1500-character cut.",
    "evidence": "Verifier replaced redactSensitiveText(item.text) with item.text in a disposable copy; topic-history.test.ts and history.test.ts stayed 58 pass, 0 fail. A class survey of all 22 production call sites in src/remote found 11 that survive the same mutation.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/remote/history.ts:134 — member: survives (finding site)",
        "src/remote/http-surface.ts:595 — member: survives; redacts the visible text of an operator-supplied inline button, no test checks it",
        "src/remote/rendering.ts:94 — member: survives; stored fallback reason, callers already pass redacted text, so a second layer (paired mutation not run)",
        "src/remote/rendering.ts:101 — member: survives; stored pause reason, a second layer (paired mutation not run)",
        "src/remote/rendering.ts:161 — member: survives; describe() of a non-BotApiError, redacted again at :94 (paired mutation not run)",
        "src/remote/rendering.ts:163 — member: survives; describe() of a BotApiError description, redacted again at :94/:101 (paired mutation not run)",
        "src/remote/hub.ts:160 — member: survives; not read, relevance not assessed",
        "src/remote/hub.ts:743 — member: survives; not read, relevance not assessed",
        "src/remote/channels.ts:45 — member: survives; not read, relevance not assessed",
        "src/remote/bot-api-http.ts:52 — member: survives; not read, relevance not assessed",
        "src/remote/pairing.ts:76 — member: survives; not read, relevance not assessed",
        "src/remote/poller.ts:183 — member: survives; not read, relevance not assessed",
        "src/remote/outbound-queue.ts:266 — member: survives; not read, relevance not assessed",
        "src/remote/http-surface.ts:622 — non-member: killed by 'approval through the topic > prompts and replies are redacted'",
        "src/remote/http-surface.ts:650 — non-member: killed by 'the Always button (AC9, AC10) > a secret in the pattern is redacted'",
        "src/remote/http-surface.ts:682 — non-member: killed by 'approval through the topic > prompts and replies are redacted'",
        "src/remote/http-surface.ts:785 — non-member: killed by 'callback_data of a picker button (AC5) > a label with a secret is redacted'",
        "src/remote/http-surface.ts:828 — non-member: killed by the same AC5 picker-button test (run alone, both runs)",
        "src/remote/shell-bridge.ts:166 — non-member: killed by 'events never carry a secret from a line'",
        "src/remote/shell-bridge.ts:172 — non-member: killed by four 'no secret reaches the topic (AC11)' tests",
        "src/remote/shell-bridge.ts:198 — non-member: killed by 'the approval prompt is redacted and within the server limit'",
        "src/remote/telegram-permission.ts:86 — non-member: killed by 'a pattern that redaction would change is never offered (AC6)'"
      ],
      "enumeration_method": "keryx ctx rg --all -n \"redactSensitiveText\\(\" src/remote --glob '!*.test.ts' (22 sites; without --all the output hides http-surface.ts:785 and :828). Each site was mutated one at a time, replacing redactSensitiveText(X) with (X), in a disposable copy of origin/main 54eb6561, running bun test src/remote src/tui/remote-control-surface.test.ts (baseline 1198 pass, 0 fail, 69 files, 16.6 s); a failure was rerun once and counted as killed only when it failed twice. Result: 11 killed, 11 survived. history.ts:134 was confirmed earlier by the verifier and not rerun. Scope limits: src/tui is out of the survey (grep found redactSensitiveText/looksLikeSecret production sites in src/remote only for this class; tui sites were not mutated); looksLikeSecret call sites are a different shape and are not in this class."
    }
  },
  {
    "id": "T-2",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/remote/topic-history.test.ts",
    "line": 41,
    "problem": "AC6 'resumed' mapping (-r, -c, /resume true; /new false) lives in tui-shell.ts host wiring that no test covers; the tests fake the host.",
    "impact": "Breaking the mapping at tui-shell.ts:6077-6078 or 9937 would not fail any test, although AC6 depends on it.",
    "suggested_fix": "Extract the mapping into a pure host adapter and unit-test it.",
    "evidence": "Verifier: no reference to sessionEntered or sessionResumed in tui-shell.test.ts; topic-history.test.ts fakes the host at lines 271 and 678.",
    "confidence": "medium",
    "class_scope": {
      "sites": [
        "src/tui/tui-shell.ts:6077-6078 — member: sessionResumed = opened.resumed; sessionEntered(opened.resumed ? 'resumed' : 'new'): the AC6 mapping, no behavioural test",
        "src/tui/tui-shell.ts:9937 — member: sessionResumed: () => sessionResumed, only read through the faked host",
        "src/tui/tui-shell.ts:9936 — member: history: archive when non-empty, else history; only text/fake coverage",
        "src/tui/tui-shell.ts:9818-9823 — member: isBusy, a five-way OR over shell state, no test builds the real one",
        "src/tui/tui-shell.ts:9827 — member: turnRunning, chrome.isBusy() || foregroundOperation.isActive, no test of the real closure",
        "src/tui/tui-shell.ts:9832-9847 — member: recordOn/recordOff, lease guard plus try/catch, no behavioural test",
        "src/tui/tui-shell.ts:9854-9868 — member: busyRefusal, classifyBusyDispatch result mapped to BUSY_REASON, only the classifier is tested",
        "src/tui/tui-shell.ts:9869-9928 — member: listProviders, listModels, switchModel, listSessions, resumeSession: mapping closures; tests assert on source text of resumeSessionInteractive (tui-shell.test.ts:4104, tui-bus.test.ts:503, tui-session-lease.test.ts:595), not on the host closures",
        "src/tui/tui-shell.ts:9816,9817,9828-9831,9850,9853,9929-9933 — non-member: sessionId, project, runLine, enqueue, notice, cancelTurn, dropQueuedTelegramLines, runCommand, onChange are one-call delegates with no mapping of their own; the delegated code has its own tests (remote-queue-wiring.test.ts)",
        "src/remote/service.ts:191 — non-member: a second host literal for the service, not the TUI wiring; out of AC6 scope"
      ],
      "enumeration_method": "keryx ctx rg --all -n \"createRemoteBridge|new RemoteBridge|host: \\{|RemoteBridgeHost\" src --glob '!*.test.ts' (24 matches: the TUI wiring is tui-shell.ts:9814-9939, service.ts:191 is a separate host, the rest are test helpers and unrelated modal hosts); then Read of tui-shell.ts 9810-9960 to list every member of the host literal; keryx ctx rg --all -n -c \"RemoteBridge|remoteBridge|remote-control\" src/tui --glob '*.test.ts' (3 files: remote-control-surface.test.ts and tui-shell.test.ts fake or text-check, remote-queue-wiring.test.ts covers the queue only); keryx ctx rg --all -n \"busyRefusal|turnRunning|sessionResumed|recordRemote|listProviders|switchModel|resumeSession|listSessions|dropQueuedTelegramLines\" src/tui/tui-shell.test.ts src/tui/tui-bus.test.ts src/tui/tui-session-lease.test.ts (9 matches, all slicing source text of resumeSessionInteractive). Membership is by absence of a behavioural test of the real closure; not mutation-verified."
    }
  },
  {
    "id": "S-1",
    "reviewer": "review-security-code",
    "severity": "minor",
    "file": "src/remote/format.ts",
    "line": 170,
    "problem": "pushLine cuts a stacked table cell line longer than 4096 characters; a continuation piece that starts with '# ', '- ' or a code fence is parsed as block syntax.",
    "impact": "Cell text of an agent reply can render as a heading, list item or fence in the second part of a split message; no secret or command effect, formatting only.",
    "suggested_fix": "Escape the first character of continuation pieces that match block syntax.",
    "evidence": "Verifier probe on origin/main: formatReply on a table whose cell is a 4078-4085 character run followed by ' # tail', '- tail' or a fence produced such a continuation piece (12 hits).",
    "confidence": "high"
  },
  {
    "id": "T-3",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/remote/topic-history.test.ts",
    "line": 82,
    "problem": "AC7 'reasoning is never posted' has no fixture with a reasoning field.",
    "impact": "A change that starts posting reasoning would pass the suite.",
    "suggested_fix": "Add a history item carrying reasoning and assert it never reaches the sender.",
    "evidence": "Verifier: no 'reasoning' string in topic-history.test.ts; the only mention in history code is a comment at history.ts:12.",
    "confidence": "high"
  },
  {
    "id": "T-4",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/remote/topic-history.test.ts",
    "line": 770,
    "problem": "The AC10 429 test never asserts that the 429 fired or that the queue paused.",
    "impact": "The test would pass even if the rate-limit path were never reached.",
    "suggested_fix": "Assert the 429 was returned and the queue was paused before checking the final sent list.",
    "evidence": "Verifier: test at lines 770-781 calls rateLimitNext but checks only the final sent list.",
    "confidence": "high"
  },
  {
    "id": "T-5",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/remote/topic-history.test.ts",
    "line": 351,
    "problem": "Absence checks use fixed real sleeps (lines 351, 359, 366, 374, 387, 735, 753, 780).",
    "impact": "Slow and timing-dependent; a loaded CI runner can make an absence check pass for the wrong reason.",
    "suggested_fix": "Use the fake clock or await a deterministic quiescence signal.",
    "evidence": "Verifier: setTimeout sleeps at the listed lines.",
    "confidence": "high"
  },
  {
    "id": "T-6",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/tui/remote-control-surface.test.ts",
    "line": 579,
    "problem": "POSTED_AT is built in local time while clock() uses UTC, so two tests fail outside UTC-adjacent time zones.",
    "impact": "A contributor in Pacific/Auckland or America/New_York sees two failures on an unchanged tree.",
    "suggested_fix": "Build POSTED_AT with Date.UTC.",
    "evidence": "Verifier ran TZ=Pacific/Auckland bun test src/tui/remote-control-surface.test.ts: 40 pass, 2 fail (got 17:52:11 and 17:52, expected 06:52:11 and 06:52).",
    "confidence": "high"
  },
  {
    "id": "T-7",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/remote/format-table-pins.test.ts",
    "line": 236,
    "problem": "The AC5 4096-character bound is measured with the production renderedLength imported from ./format.",
    "impact": "The check is circular: a defect in renderedLength would hide itself.",
    "suggested_fix": "Measure with an independent function or the real renderer output.",
    "evidence": "Verifier: line 236 asserts renderedLength(part) <= 4096 with renderedLength imported at line 20.",
    "confidence": "medium"
  },
  {
    "id": "T-8",
    "reviewer": "review-testing-practices",
    "severity": "info",
    "file": "src/remote/format-table-pins.test.ts",
    "line": 329,
    "problem": "AC5 part order is checked only as array order, not through the real send path.",
    "impact": "A reordering in the send path would not be detected.",
    "suggested_fix": "Assert send order through the sender fake.",
    "evidence": "Verifier: test at 329-340 loops over parts in array order and asserts only fallback and call counts.",
    "confidence": "medium"
  },
  {
    "id": "T-9",
    "reviewer": "review-testing-practices",
    "severity": "info",
    "file": "src/tui/remote-control-surface.test.ts",
    "line": 47,
    "problem": "otuiTest is skipped when @opentui is not loadable (10 skipped in the reviewer's run).",
    "impact": "Coverage of those cases depends on the environment; related to T-2.",
    "suggested_fix": "Make the skip visible in CI or cover the host wiring without @opentui.",
    "evidence": "Verifier: line 47 defines otuiTest = test.skipIf(OTUI === undefined), used from line 73.",
    "confidence": "low"
  },
  {
    "id": "T-10",
    "reviewer": "review-testing-practices",
    "severity": "info",
    "file": "src/remote/topic-history.test.ts",
    "line": 641,
    "problem": "Duplicate test block: 641-658 repeats 695-711.",
    "impact": "No coverage added; maintenance noise.",
    "suggested_fix": "Remove one copy.",
    "evidence": "Verifier: identical describe 'the client reports whether the topic was new' and identical first test at both ranges.",
    "confidence": "high"
  },
  {
    "id": "A-1",
    "reviewer": "review-architecture",
    "severity": "info",
    "file": "src/remote/command-router.ts",
    "line": 180,
    "problem": "History done/failed is decided by comparing the answer string with HISTORY_EMPTY_MESSAGE.",
    "impact": "A wording change silently flips the outcome.",
    "suggested_fix": "Return a HistoryOutcome instead of a string.",
    "evidence": "Verifier: command-router.ts:180 uses answer === HISTORY_EMPTY_MESSAGE ? 'done' : 'failed'.",
    "confidence": "high"
  },
  {
    "id": "A-2",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/remote/client.ts",
    "line": 294,
    "problem": "The public getter reusedAtStart has no production use; StartResult.reused carries the value.",
    "impact": "Dead public surface that only tests keep alive.",
    "suggested_fix": "Remove the getter and assert on StartResult.reused in the tests.",
    "evidence": "Verifier: defined at client.ts:294; only other references are topic-history.test.ts:723 and 733.",
    "confidence": "high"
  },
  {
    "id": "A-3",
    "reviewer": "review-architecture",
    "severity": "info",
    "file": "src/remote/format.ts",
    "line": 231,
    "problem": "lineBlocks and Piece.blocks duplicate countBlocks in format-rich.ts and can drift (nested '> - item' estimated 2 versus about 4).",
    "impact": "Drift degrades gracefully through RichRenderError, so the cost is an extra fallback, not a failure.",
    "suggested_fix": "Reuse countBlocks or pin the two against each other in a test.",
    "evidence": "Verifier: lineBlocks at format.ts:231 and countBlocks at format-rich.ts:189 are separate implementations.",
    "confidence": "medium"
  },
  {
    "id": "A-4",
    "reviewer": "review-architecture",
    "severity": "info",
    "file": "src/remote/format.ts",
    "line": 47,
    "problem": "The splitter imports the rich-only 500-block limit; html and plain modes split tall tables earlier than they must.",
    "impact": "Documented trade-off; more parts than strictly necessary for html/plain.",
    "suggested_fix": "None required; document in the module header if desired.",
    "evidence": "Verifier: format.ts:47 imports RICH_LIMITS and line 60 derives BLOCK_BUDGET from it.",
    "confidence": "high"
  },
  {
    "id": "A-5",
    "reviewer": "review-architecture",
    "severity": "info",
    "file": "src/remote/history.ts",
    "line": 118,
    "problem": "looksLikeSecret is a second secret heuristic applied only on the history path.",
    "impact": "Two heuristics can disagree; the history path is stricter than the normal reply path.",
    "suggested_fix": "Decide whether to share the heuristic with the main redaction path.",
    "evidence": "Verifier: defined at history.ts:118, called only at history.ts:133.",
    "confidence": "medium"
  },
  {
    "id": "A-6",
    "reviewer": "review-architecture",
    "severity": "info",
    "file": "src/tui/tui-shell.ts",
    "line": 6823,
    "problem": "The expression line.trim().split(/\\s+/).slice(1).join(' ') is duplicated in tui-shell.ts and remote-control-surface.ts.",
    "impact": "Minor duplication of argument slicing.",
    "suggested_fix": "Extract a shared helper.",
    "evidence": "Verifier: same expression at tui-shell.ts:6823 and remote-control-surface.ts:65. The reviewer's cited line 9936 was wrong; the duplication holds.",
    "confidence": "medium"
  },
  {
    "id": "L-1",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/remote/history.ts",
    "line": 108,
    "problem": "looksLikeSecret treats any 32+ character [A-Za-z0-9_-] run containing upper, lower and a digit as a token, so long mixed-case identifiers match.",
    "impact": "A restored turn that merely mentions such an identifier is replaced wholesale by the secret placeholder; history silently loses legitimate turns (fail-safe direction, no leak).",
    "suggested_fix": "Add an entropy or character-class-transition check, or redact only the matching run.",
    "evidence": "Verifier: looksLikeSecret('see createManagedReviewPackageForVersion2Handler for details') returned true; without the digit it returned false.",
    "confidence": "high"
  },
  {
    "id": "L-2",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/remote/shell-bridge.ts",
    "line": 465,
    "problem": "enabledOnce is set on the first enable() of the process and never reset on a session switch, so a /resume after an earlier enable gets no auto-restore.",
    "impact": "AC6 mentions /resume while AC12 says first enable() of the process; the behaviour is an ambiguity between the two criteria.",
    "suggested_fix": "Clarify the criteria wording, or reset enabledOnce on session switch if per-session restore is intended.",
    "evidence": "Verifier: enabledOnce declared at shell-bridge.ts:283, set at 465-466, nothing resets it.",
    "confidence": "medium"
  },
  {
    "id": "L-3",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/remote/format.ts",
    "line": 60,
    "problem": "BLOCK_BUDGET (498) is also applied to a single unlabeled message, so a table of 497-498 blocks is split although it fits in 500.",
    "impact": "Conservative over-splitting only; every part stays valid.",
    "suggested_fix": "Optionally use the full limit when the reply fits one part.",
    "evidence": "Verifier probe: a 497 or 498 row table renders whole through renderRichMessage but formatReply returns 2 parts. Reviewer fuzzing of about 4,300 parts found 0 over 4096 characters and 0 rejected by checkRichMessage.",
    "confidence": "high"
  }
]
```
