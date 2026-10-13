# PR 992 — review round 2

Verdict: request-changes

Head reviewed: d9ccfb6ce4d35aad1e790c0455b2f30c6ed503c7.

## Summary

Round 2 found two major problems and a set of minor ones around the `/mode auto` question axis. The operator-refusal memory, introduced for review-auto, was read and written in every mode, so a refusal under ask or trust became a standing "no" for the identical call (F-007). Under `auto` the model answered `ask_user` before the arbiter, the decision journal and the policy tags were consulted, including in a plain review-auto shell with no review run and in a turn that started in Telegram (F-008, and poll 153). The minor findings cover the test preload masking the leak (F-009), missing production-path tests (F-010, F-011, F-012), documentation claims about the journal and about `auto` never asking (F-013, F-014), hooks not consulted for a self-answer (F-015), the wording-based floor (F-016), terminal-unsafe text in the self-answer line (F-017), a stale bunfig comment (F-018), misleading comments (F-019), a duplicated default-option rule (F-020), ambient review-system state in the axis tests (F-021) and mixed responsibilities in the denial wrapper (F-022).

## Findings

```json keryx:findings
[
  {
    "id": "F-007",
    "reviewer": "review-regression",
    "severity": "major",
    "file": "src/commands/agent.ts",
    "line": 5581,
    "symbol": "executeCallUnbounded",
    "problem": "The F-003 fix records every non-approval in the process-wide refusal memory in every permission mode, but the delegate and write branches read that memory with no mode guard. A single refused write_file/apply_patch/spawn_subagent (or any stale, dismissed, race-lost, timed-out or unattended `false`) now blocks the identical call for the life of the process: the second request is answered `refused earlier: choose another path` and the operator is never asked. Nothing in production resets the memory (resetOperatorDenials has only test callers), it is not scoped to a session, and recording does not distinguish an operator's `no` from a facade `false` for a stale turn (foreground-operation.ts:279,281), a Telegram timeout, a dock Esc, or deniedUnattendedApproval.",
    "impact": "Ask mode, default: refuse a write once, say `ok, go ahead`, and the model's retry of the same call is refused without a prompt until the shell restarts. In trust and auto the same happens for any write/delegate call a floor forces to ask (credentials, untrusted origin, hook ask, protected path), and the memory also forces every permission-worded ask_user question to the human for the rest of the process (reviewAutoMayAnswer reads the set size). One session's refusal or stale-turn `false` poisons other sessions in the same process.",
    "suggested_fix": "Decouple the two uses. Keep the per-fingerprint set and its REFUSED_EARLIER reads (5574, 5686, 5821, 5868) exactly as before, written and read only under reviewAutoActive(), and give the question floor its own cheap `operator refused something` flag. Record only a genuine operator refusal: not the facade's !accepts() branch, not an unattended approver, not a dismissal or a timeout. Give the flag an owner and a production reset (new session, /clear, mode change). Add production-path tests in ask, trust and auto: turn 1 refuses a write, turn 2 repeats the identical call and approves, and the approver must be called twice; the same for risk delegate. Also correct the comment at 5570.",
    "evidence": "Wrapper at agent.ts:5568-5589 is now installed unconditionally and calls recordOperatorDenial(meta.fingerprint) and recordOperatorDenial(spelled) when !isApprovalFor(response, fingerprint) (5580-5582); at the merge-base 7f4059cf it was installed only under reviewAutoActive(). Unguarded reads: agent.ts:5821 (risk delegate) and 5868 (risk write); the shell read at 5686 is guarded by reviewAutoActive(). Four independent runs on head d9ccfb6c: (1) orchestrator repro, ask mode, same write call in two turns, first refused: second returns `refused earlier: choose another path`, baseline asks again. (2) review-regression repro, ask mode: PR approvals=1, outputs [not approved, refused earlier]; baseline 7f4059cf approvals=2, outputs [not approved, wrote]. (3) review-logic repro, same result. (4) review-highload repro through createForegroundAgentIoFacade: owner.invalidateSession() while the approval is pending, approver then resolves true -> session A: `patch not approved by the user`, session B identical call: `refused earlier` with asksB=0, and a second turn in trust mode is also refused. resetOperatorDenials callers outside tests: src/lib/test-preload-hooks.ts only. Mutants M14/M15 on the read guard were killed; no test repeats a call after a refusal.",
    "confidence": "high",
    "dedupe_key": "refusal-memory-every-mode-unguarded-reads",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/commands/agent.ts:5581 (write, fingerprint)",
        "src/commands/agent.ts:5582 (write, spelled)",
        "src/commands/agent.ts:5574 (read, guarded by reviewAuto)",
        "src/commands/agent.ts:5688 (read, shell branch, guarded by reviewAutoActive)",
        "src/commands/agent.ts:5821 (read, delegate, UNGUARDED)",
        "src/commands/agent.ts:5868 (read, write, UNGUARDED)",
        "src/review/review-system.ts:129 reviewAutoMayAnswer (reads set size)",
        "src/review/arbiter-floor.ts:32 askFloor operator-denial",
        "src/tui/ask-user-bridge.ts:80 and :95 (review-auto consumers of reviewAutoMayAnswer)",
        "src/lib/test-preload-hooks.ts:11 (only production-adjacent reset)"
      ],
      "enumeration_method": "keryx ctx rg -n 'operatorDenied\\(|recordOperatorDenial\\(|resetOperatorDenials\\(|reviewAutoMayAnswer\\(' src --glob '!*.test.ts' on head d9ccfb6c: 6 hits in agent.ts, 4 in review-system.ts, 2 in ask-user-bridge.ts, 1 in arbiter-floor.ts, 1 in test-preload-hooks.ts; the list is exhaustive for non-test code."
    }
  },
  {
    "id": "F-008",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/commands/agent.ts",
    "line": 2511,
    "symbol": "selfAnsweredQuestion",
    "problem": "Under /mode auto in an interactive shell with the review-auto system on (KERYX_REVIEW_SYSTEM=review-auto) there is no AutomaticReviewRun, so selfAnsweredQuestion does not stand aside. It answers a policy-tagged ask_user question with the recommended option before the question reaches journaledAskUser, consultArbiter and the decision journal. askFloor never reads request.policy, so nothing keeps the question for the arbiter's deny/escalate verdict or for the human. The two other answerers (the bridge and AutomaticReviewRun.answerAskUser) apply floor then arbiter; the new third answerer applies the floor only and sits ahead of both.",
    "impact": "The flow-425 guarantee that only the arbiter or a person answers policy questions in review-auto is lost in this combination: a scope-widening, gate-waiver or budget question that the arbiter would deny or escalate to the operator is answered with the model's own recommendation, the arbiter is never consulted, and no decision-journal row is written (flow 392). The same applies when KERYX_AUTONOMOUS_ANSWERS_FILE or KERYX_REVIEW_AUTO_ANSWER=1 is set: answerAutonomously' journal is bypassed. The new documentation sentence `An automatic review does not use this path` holds only for an AutomaticReviewRun turn.",
    "suggested_fix": "Give the answerers one order. Preferred: move the `auto answers with the recommended option` step out of agent.ts into the AskUserFn composition after journal, autonomous file, arbiter and floor, so agent.ts passes only the mode. Minimal: in selfAnsweredQuestion return undefined when request.policy !== undefined and (reviewAutoActive() || KERYX_REVIEW_AUTO_ANSWER === '1' || an autonomous answers file is configured). Add a runAgentTurn-level test: auto + setReviewSystem('review-auto') + no review run + a policy-tagged question + an arbiter deny -> the host is reached once. Decide, and document, whether a plain-auto self-answer is journaled.",
    "evidence": "agent.ts:2511 stands aside only for reviewRun !== undefined; askFloor (arbiter-floor.ts:28-34) has no policy rule; journaledAskUser (ask-user-bridge.ts:62-83) holds the only consultArbiter call and is reached only through tool.invoke, which a self-answer skips (agent.ts:4389-4401). Repros on d9ccfb6c, auto mode, setReviewSystem('review-auto'), policy-tagged question with a recommended option: orchestrator repro hostCalls 0 on the PR vs 1 on baseline 7f4059cf; review-regression: PR hostCalls 0 and output `[auto mode] chose this without asking the user: id=\"yes\" ... (recommended)`, baseline hostCalls 2 and `User selected id=\"no\"`; review-logic: hostCalls 0, selfAnswered=[{Which scope?, Full}]. The arbiter-allow/deny path with a configured arbiter model was read (review-arbiter-install.ts:54-71), not run. The three reviewers (security-code, architecture, style) reached the same result by reading. No test covers the combination (agent-question-axis.test.ts:285-309 pass an AutomaticReviewRun only).",
    "confidence": "high",
    "dedupe_key": "self-answer-before-arbiter-and-journal",
    "blocking_merge": true,
    "class_scope": {
      "sites": [
        "src/commands/agent.ts:2511 selfAnsweredQuestion (stand-aside condition)",
        "src/commands/agent.ts:4389-4401 (call site ahead of executeCall)",
        "src/review/arbiter-floor.ts:28-34 askFloor (no policy rule)",
        "src/tui/ask-user-bridge.ts:68-86 journaledAskUser (consultArbiter, reviewAutoAnswer, journal) - bypassed",
        "src/commands/review-arbiter-install.ts:54-71 consultArbiter - bypassed",
        "src/review/autonomous-answers.ts answerAutonomously (file journal) - bypassed",
        "docs/docs/guides/permission-modes.md:74 (claim that an automatic review does not use this path)"
      ],
      "enumeration_method": "Read of every answerer of ask_user reachable from runAgentTurnCore: keryx ctx rg -n 'consultArbiter|reviewAutoAnswer|answerAutonomously|answerAskUser|selfAnsweredQuestion' src --glob '!*.test.ts'; the AutomaticReviewRun path is already excluded by reviewRun !== undefined."
    }
  },
  {
    "id": "F-009",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/lib/test-preload-hooks.ts",
    "line": 11,
    "symbol": "beforeEach(() => resetOperatorDenials())",
    "problem": "The d9ccfb6c runner-only preload clears the process-wide refusal memory before every test in the suite, so no test can observe the production leak described in F-007: each test starts with an empty set, and the only refusal test (agent-question-axis.test.ts:187-207) refuses once and then asks a question. Nothing pins the preload itself either: dropping the second entry from bunfig.toml, or turning the hook into a no-op, fails no test in the targeted suites.",
    "impact": "The leak is invisible to CI by construction, and a later trim of bunfig.toml back to one preload would reintroduce order-dependent leaks that surface far from their cause. The preload is a workaround for a production design (module-level state with no owner); it hides the symptom a test would otherwise expose.",
    "suggested_fix": "Prefer removing the need: give the refusal memory an owner (per shell/session) so tests construct their own and no global reset exists. If the preload stays: add a pair of order-dependent tests in test-preload.test.ts (the first records a denial, the second asserts the memory is empty) and assert that bunfig.toml [test].preload lists ./src/lib/test-preload-hooks.ts; keep production-path tests that repeat a refused call (see F-007) so the reset cannot mask them.",
    "evidence": "keryx review mutate on the changed functions: M25-second-preload-dropped (bunfig.toml preload list without test-preload-hooks.ts) and M26-preload-reset-dropped (hook body replaced by an empty function) both survived the targeted suites (agent-question-axis, permission-mode, ask-user-tool, ask-user-bridge, foreground-operation, review-system, review-arbiter, agent-fewer-prompts, agent, test-preload): mutant:M26-preload-reset-dropped and mutant:M25-second-preload-dropped . test-preload.test.ts:40 asserts only the env contract of the first preload. review-testing-practices, review-architecture and review-clean-code read the same gap. Cost of the second preload measured by review-performance: about 1-2 ms per bun test process, within noise. keryx's own bunfig.toml already carried a preload at the merge-base, so PR 1000's rule that `bun test` is routine only when bunfig.toml has no `preload` key is not newly affected.",
    "confidence": "high",
    "dedupe_key": "preload-masks-and-unpinned",
    "blocking_merge": false
  },
  {
    "id": "F-010",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/commands/agent-question-axis.test.ts",
    "line": 285,
    "problem": "No test drives the question axis under auto + review-auto without an AutomaticReviewRun. The three review tests (285-309) pass an AutomaticReviewRun through extras.review; ask-user-bridge-arbiter.test.ts covers the arbiter at the bridge level only, never through runAgentTurn. The hostCalls 0 versus 1 divergence of F-008 therefore has no test on either side.",
    "impact": "Whichever behaviour is intended for the interactive review-auto shell, nothing fails if it changes.",
    "suggested_fix": "Add a runAgentTurn test with setReviewSystem('review-auto'), mode auto, no review run, a policy-tagged question and a spy host asserting the intended outcome (host reached once, or self-answer plus journal row); restore setReviewSystem('inherit') in afterEach.",
    "evidence": "Read of agent-question-axis.test.ts:285-309 and keryx ctx rg for setReviewSystem/KERYX_REVIEW_SYSTEM in that file (none). The orchestrator's scratch repro of the combination is the only run.",
    "confidence": "high",
    "dedupe_key": "no-test-auto-review-auto-no-run",
    "blocking_merge": false
  },
  {
    "id": "F-011",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/harness/tool/builtin/ask-user-tool.ts",
    "line": 162,
    "symbol": "selfAnswerAskUser",
    "problem": "Nothing pins the sentence `The user did not answer this question.` in the text the model reads after a self-answer. The unit test for selfAnswerAskUser checks the option id and one substring for the recommended case and only the id for the plain case; the agent-level test asserts the `[auto mode] chose this without asking the user` notice but not the disclaimer.",
    "impact": "The disclaimer is the part of the self-answer text that stops the model from reporting the choice as the user's own answer. A refactor can drop it without a red test.",
    "suggested_fix": "Assert in ask-user-tool.test.ts that result.output contains the notice and the `did not answer` disclaimer for both the recommended and the plain case, that `(recommended)` is absent for the plain case, and that isError is false.",
    "evidence": "keryx review mutate: mutant:M18-self-answer-says-user-answered (the sentence replaced by a bare period) survived every targeted suite. review-testing-practices read the same weak assertions at ask-user-tool.test.ts:98.",
    "confidence": "high",
    "dedupe_key": "self-answer-disclaimer-unpinned",
    "blocking_merge": false
  },
  {
    "id": "F-012",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/commands/agent.ts",
    "line": 5581,
    "symbol": "recordOperatorDenial(meta.fingerprint)",
    "problem": "No assertion distinguishes the two recordings in the denial wrapper: the exact fingerprint and the spelling-normalised one. Removing the exact-fingerprint recording changes no test result.",
    "impact": "A call repeated with a differently spelled but equivalent input (the case refusalFingerprint exists for) is the only place the two diverge, and no test repeats a refused call at all (see F-007). The mutant may be partly equivalent for identical re-spellings; it is reported as a survivor, not as proof of a bug.",
    "suggested_fix": "Add a review-auto test that refuses a shell/write call and repeats it spelled differently (flag order, quoting) and identically; assert REFUSED_EARLIER in both cases.",
    "evidence": "keryx review mutate: mutant:M10-denial-fingerprint-not-recorded (recordOperatorDenial(meta.fingerprint) replaced by void 0) survived; its sibling M11 (spelled form) was killed.",
    "confidence": "medium",
    "dedupe_key": "denial-fingerprint-recording-unpinned",
    "blocking_merge": false
  },
  {
    "id": "F-013",
    "reviewer": "review-style",
    "severity": "minor",
    "file": "src/gdskills/bundled/skills/planning/interviewer/SKILL.md",
    "line": 94,
    "problem": "Both interviewer SKILL.md copies (byte-identical, src/gdskills/bundled/... and .metaproject/skills/gdskills/...) and docs/docs/guides/recommendation-journal.md:347 still say that each ask_user question is recorded in the recommendation journal by the tool itself, and tell the interviewer not to record it. An auto self-answer returns before tool.invoke, so nothing is journaled. The SKILL.md line 93 also counts only `No one was asked`, cancelled and empty answers as non-answers: an `[auto mode] chose this without asking the user` reply reads as a confirmed user answer for the confidence rules.",
    "impact": "Under /mode auto the interviewer collects self-chosen answers, treats them as the user's confirmed context, and leaves no journal row, so the arm/recommendation/answer statistics the skill promises are silently incomplete. The style reviewer rated the journal claim major; it is kept minor here because the effect is a missing log row and an overconfident brief, not a wrong action, and it follows the open question of whether self-answers are journaled at all.",
    "suggested_fix": "Either journal the self-answer (source `auto-self-answer`) or state in both SKILL.md copies and recommendation-journal.md that the claim holds only when a person is asked; add one clause that an auto self-answer is an assumption, not the user's answer. Keep the two SKILL.md copies byte-identical.",
    "evidence": "SKILL.md:93-94 unchanged by the PR except for the no-host clause; journaled(request) is reached only through journaledAskUser (ask-user-bridge.ts:60-83); selfAnsweredQuestion returns at agent.ts:4401 before executeCall. md5 of both copies f00c7dd59a78c24bab5995cc8ee60c8f. Read, not run.",
    "confidence": "high",
    "dedupe_key": "docs-journal-claim-self-answer",
    "blocking_merge": false
  },
  {
    "id": "F-014",
    "reviewer": "review-style",
    "severity": "minor",
    "file": "docs/docs/guides/permission-modes.md",
    "line": 25,
    "problem": "The mode table still says `auto | Nothing asks, including destructive commands` (line 25) and `Never asks.` (line 43), contradicting the new section (lines 57-84) that keeps irreversible, action-tagged, untrusted-content and permission-after-refusal questions for the human. Line 74 says an automatic review does not use the self-answer path, which is wrong for an interactive review-auto shell (F-008).",
    "impact": "A reader concludes auto never interrupts, then meets an ask_user menu for an irreversible action; an operator enabling review-auto expects the arbiter to see policy questions.",
    "suggested_fix": "Say `Nothing asks for an approval` at line 25 and `Never asks for approval` at line 43 with a pointer to `Who answers a question`; make line 74 precise or fix F-008 so it becomes true.",
    "evidence": "Read of permission-modes.md:25,43,57-84 against arbiter-floor.ts:28-34 and agent.ts:2511.",
    "confidence": "high",
    "dedupe_key": "docs-auto-never-asks",
    "blocking_merge": false
  },
  {
    "id": "F-015",
    "reviewer": "review-security-code",
    "severity": "minor",
    "file": "src/commands/agent.ts",
    "line": 4389,
    "symbol": "selfAnsweredQuestion call site",
    "problem": "The self-answer returns before executeCall, so PreToolUse and PostToolUse hooks never see an auto-answered ask_user. A user hook that denies ask_user, a hook with decision `ask` on every tool, or an audit observer is honoured under ask and trust and silently skipped under auto.",
    "impact": "The policy `ask_user must go to a person` configured by a hook stops being a floor for this one tool under auto. The skip is documented in the code comment and in permission-modes.md, so it may be accepted.",
    "suggested_fix": "Fire firePreToolUseHook for the self-answer and stand aside on deny or ask, or at least fire PostToolUse as observe-only; if the skip is intended, say so in the hook documentation.",
    "evidence": "executeCall fires firePreToolUseHook before the risk branches (about agent.ts:5653) and the read branch honours a hook deny/ask (5972-5990); PostToolUse fires after invoke (6030). Read, not run.",
    "confidence": "medium",
    "dedupe_key": "self-answer-skips-hooks",
    "blocking_merge": false
  },
  {
    "id": "F-016",
    "reviewer": "review-security-code",
    "severity": "minor",
    "file": "src/review/review-system.ts",
    "line": 122,
    "symbol": "reviewAutoMayAnswer",
    "problem": "The operator-denial floor depends on the model's own wording: askFloor returns `operator-denial` only when the memory is non-empty AND the question or option text matches the PERMISSION_WORDS regex. permission-modes.md presents it as a guarantee (`when it asks for permission after you refused an action`).",
    "impact": "After the operator refuses a credentials or publish approval in auto, the model can ask `Go ahead and push the release branch?` with options Yes/No; no stem matches, the floor is undefined and the model answers Yes itself. Injected text only has to avoid about 15 English and Russian stems.",
    "suggested_fix": "Reword the docs to `may still go to you, when the question is worded as a permission request`, or make the floor stricter: any recorded refusal blocks all self-answers (simpler and not evadable by wording; pair with the scoped flag of F-007).",
    "evidence": "review-system.ts:129-139 and arbiter-floor.ts:32; docs permission-modes.md added section. Read, not run. M22 (floor rule removed) was killed, so the rule itself is tested; the wording gap is not.",
    "confidence": "medium",
    "dedupe_key": "operator-denial-floor-wording",
    "blocking_merge": false
  },
  {
    "id": "F-017",
    "reviewer": "review-security-code",
    "severity": "minor",
    "file": "src/commands/shell.ts",
    "line": 2257,
    "symbol": "onQuestionSelfAnswered handler",
    "problem": "The `answered without asking (auto)` line prints the model-controlled question and the chosen option's label verbatim, only length-truncated, without terminalSafe. The matching handler in tui-shell.ts:6186 builds the same line.",
    "impact": "Content injected through a web fetch can make the model ask a question whose label carries CR, ESC[2K or a newline plus a forged `auto-approved` line, overwriting or forging the operator's only record of a decision made on their behalf. Sibling handlers (onAutoApproved, onToolCall) follow the same raw pattern, so this is consistent with existing code.",
    "suggested_fix": "Pass question and answerLabel through terminalSafe(...).text (single line) in both handlers.",
    "evidence": "shell.ts:2257-2261 and tui-shell.ts:6186 read; src/lib/terminal-safe.ts exists for this. Not reproduced; rendering of raw ESC/CR in the TUI chunks was not verified.",
    "confidence": "medium",
    "dedupe_key": "self-answer-line-terminal-escapes",
    "blocking_merge": false
  },
  {
    "id": "F-018",
    "reviewer": "review-regression",
    "severity": "minor",
    "file": "bunfig.toml",
    "line": 3,
    "problem": "The header comment says `The only entry is a test preload that redirects the user-global keryx config directory`; the list now also holds ./src/lib/test-preload-hooks.ts, which resets the refusal memory before every test.",
    "impact": "A maintainer does not learn that a global beforeEach exists, which hides the leak behind F-007.",
    "suggested_fix": "Name both preloads and the reason for the second in the comment.",
    "evidence": "bunfig.toml:1-9 read at d9ccfb6c.",
    "confidence": "high",
    "dedupe_key": "bunfig-comment-stale",
    "blocking_merge": false
  },
  {
    "id": "F-019",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "file": "src/commands/agent.ts",
    "line": 5570,
    "problem": "Two comments say something the code does not do. Line 5570 says only review-auto answers from the refusal memory and grants, but the write and delegate branches (5821, 5868) read it in every mode (F-007). The comment at 4389 says `nothing ran, so the budget is untouched`, but reserveToolAttempt (4358) runs before the self-answer and has already counted the call; only the invocation budget is skipped.",
    "impact": "The first comment tells the next reader the opposite of F-007; the second makes a reader assume repeated self-answers are free, while the identical-call cap still applies.",
    "suggested_fix": "Correct both comments (after F-007 is fixed, the first becomes true or is deleted); reword the second to `the invocation budget is untouched; the attempt guard already counted this call`.",
    "evidence": "agent.ts:4358-4359, 4389, 5570-5574, 5821, 5868 read; state.attempts mutated at 2144.",
    "confidence": "high",
    "dedupe_key": "misleading-comments-agent",
    "blocking_merge": false
  },
  {
    "id": "F-020",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "file": "src/harness/tool/builtin/ask-user-tool.ts",
    "line": 157,
    "problem": "The rule `recommended option, else the first` is now written four times (ask-user-tool.ts:157 new, ask-user-bridge.ts:96, automatic-review.ts:325, autonomous-answers.ts:99 as a variant), and the `answered without asking` line with its 100-character truncation is built separately in shell.ts:2259 and tui-shell.ts:6187 (and a third time at tui-shell.ts:5976). The copies apply different gates: bridge and autonomous paths run floor, arbiter, default; the new one runs floor, default.",
    "impact": "A change to the tie-break or to a floor class lands in some paths and not others, and auto, review-auto and the automatic review diverge silently. Fixing F-008 with one ordering point removes most of this.",
    "suggested_fix": "Export one defaultAnswerOption(request) from the tool module and use it at all four sites; add formatSelfAnsweredNote(question, label) shared by both hosts.",
    "evidence": "keryx ctx rg found the four selections and the two truncations; read at d9ccfb6c.",
    "confidence": "medium",
    "dedupe_key": "duplicated-default-option-rule",
    "blocking_merge": false
  },
  {
    "id": "F-021",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/commands/agent-question-axis.test.ts",
    "line": 20,
    "problem": "The axis tests depend on ambient review-system state they neither set nor restore: the module-level setReviewSystem value and KERYX_REVIEW_SYSTEM. The file resets only the denial set, while the denial wrapper and the bridge branch on getReviewSystem().",
    "impact": "A shell with KERYX_REVIEW_SYSTEM=review-auto exported, or a sibling file that fails before its restore, changes what these tests mean without failing them for the right reason.",
    "suggested_fix": "beforeEach(() => { setReviewSystem('inherit'); delete process.env.KERYX_REVIEW_SYSTEM; }) with the saved value restored in afterEach, or the same normalisation in the global hook.",
    "evidence": "review-system.ts:8 and :23 read; other files (agent-fewer-prompts.test.ts, agent.test.ts) set and restore it by hand. The three related files pass together: 47 pass, 0 fail.",
    "confidence": "medium",
    "dedupe_key": "axis-tests-ambient-review-system",
    "blocking_merge": false
  },
  {
    "id": "F-022",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "file": "src/commands/agent.ts",
    "line": 5572,
    "symbol": "requestApproval wrapper / tool loop",
    "problem": "The denial wrapper is one closure with four responsibilities (refusal lookup, grant decision, human ask, denial recording) that also mutates refusedEarlier in the enclosing scope and relies on `spelled!`. The `already settled before executeCall` condition (precomputedResult === undefined && storedAnswer === undefined) is spelled at 4392 and 4447 and as the ladder at 4395-4402; the PR adds a third source (selfAnswered) to both.",
    "impact": "No failure demonstrated. F-007 shows the cost: changing who records is entangled with who answers from memory, and a fourth pre-execution source can be missed in one of the two conditions, storing an answer nobody gave.",
    "suggested_fix": "Extract withRefusalMemory(askHuman, {answerFromMemory, grants}) returning the approver and a refusedEarlier() accessor; resolve one `settled` value before the try block and use it at 4447.",
    "evidence": "agent.ts:4392-4402, 4447, 5572-5589 read.",
    "confidence": "low",
    "dedupe_key": "wrapper-and-loop-responsibilities",
    "blocking_merge": false
  }
]
```
