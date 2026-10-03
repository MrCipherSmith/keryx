# Independent review: flow 400 (recommendation journal v2), PR 875

Reviewers (fresh agents, read-only): review-logic (L), review-testing-practices (T), review-security-code (S). Diff: origin/main...feat/flow-f2-recommendation-journal-v2 at the time of review (e7e1f201, 59 files).

Result: 0 blockers, 5 majors (L-1, L-2, T-1, T-2, S-1), minors and info. Majors and the L/T minors were fixed in the branch (commits 5062f564..52f12a42); S-3 to S-6, L-5..L-8, T-3, T-5, T-7 stay open as findings for the operator to rule on.

```json keryx:findings
[
  {
    "id": "L-1",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/tui/ask-user-bridge.ts",
    "line": 104,
    "problem": "journaledPick records any option id returned by show() as the human's answer, including the cancelId a busy or Esc-dismissed dock resolves to; tui-queue-route uses cancelId 'side', which is also an option id.",
    "impact": "A queue-route question opens while another dialog is open; the dock resolves to 'side'; the journal holds an answer the human never gave, feeding follow-rate and median time.",
    "suggested_fix": "Journal a dismissed or busy pick as cancelled, never as a choice (fixed in 5062f564).",
    "evidence": "Line 108 maps any option id to an answer; the queue-route cancelId 'side' is an option id, so Esc or a busy dock is journaled as an answer. Wiki-enrich and session-lease use option ids as cancelId too.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/tui/ask-user-bridge.ts:104 journaledPick (member, the defect)",
        "src/tui/tui-shell.ts ~8328 tui-queue-route, cancelId 'side' is an option id (member, confirmed)",
        "src/tui/tui-shell.ts ~1589 tui-wiki-enrich, cancelId 'cancel' is an option id (member, confirmed by the verifier)",
        "src/tui/tui-shell.ts ~6235 tui-session-lease, cancelId 'cancel' is an option id (member, confirmed by the verifier)",
        "src/tui/ask-user-bridge.ts journaledAskUser (non-member: goes through journalAsk which has CANCEL_ANSWER)",
        "src/commands/agent.ts:4307 round-limit via deps.askUser (non-member: same path as journaledAskUser)"
      ],
      "enumeration_method": "keryx ctx rg --all -n 'journaledPick' src; keryx ctx rg --all -n 'cancelId' src/tui/tui-shell.ts src/tui/composer-choice.ts; read journaledPick and composer-choice.ts:60. No live TUI repro."
    }
  },
  {
    "id": "L-2",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/decisions/arms.ts",
    "line": 176,
    "problem": "An empty or whitespace seed file makes loadRepoSalt throw on every call; openDecision fails permanently and journalAsk swallows the error so recording stops silently.",
    "impact": "A partial write leaves the seed file empty; every later openDecision throws; questions are asked but not journaled.",
    "suggested_fix": "Treat an empty or short salt as absent and regenerate it, tighten the mode to 0600 (fixed in 3309d7bc).",
    "evidence": "Both calls threw 'could not create the decisions seed file'. readSalt returns undefined for an empty file and the wx create fails; journalAsk swallows the error but emits a note.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/decisions/arms.ts:176 loadRepoSalt (member, the throw)",
        "src/decisions/arms.ts:193 readSalt (member, returns undefined for an empty file, then the 'wx' create fails because the file exists)",
        "src/decisions/journal.ts openDecision (affected caller)",
        "src/decisions/ask.ts journalAsk (swallows the error, so the failure is silent)",
        "opts.salt test seam in openDecision (non-member: bypasses the file)"
      ],
      "enumeration_method": "keryx ctx rg --all -n 'loadRepoSalt|readSalt' src; bun probe in a temp git repo with an empty seed file."
    }
  },
  {
    "id": "T-1",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/decisions/ask.test.ts",
    "line": 64,
    "problem": "Preselection through present() is asserted only for arm D; A, B and C requests never get a preselected assertion, and other tests draw arms from an unseeded salt.",
    "impact": "present() returns preselected:false always; arm A degrades into arm B and no named AC2 test fails.",
    "suggested_fix": "Pin preselection per arm with a fixed salt and make the draw-dependent tests deterministic (fixed in 857854ca).",
    "evidence": "60 pass, 0 fail across four files; coverage.test.ts failed 3 of 10 runs, only when the unseeded arm was A.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/decisions/ask.ts present() preselected expression (member, untested for A/B/C)",
        "src/decisions/ask.test.ts:64 asserts arm D only (member, partial coverage)",
        "src/decisions/coverage.test.ts:95 asserts on an unseeded arm (member, not pinned)",
        "src/tui/composer-choice.test.ts (non-member: consumer side)",
        "src/harness/tool/builtin/ask-user-tool.ts and src/tui/ask-user-bridge.ts (non-member: pass the request through)"
      ],
      "enumeration_method": "Read ask.ts present(), ask.test.ts, coverage.test.ts, composer-choice.test.ts; keryx ctx rg -n 'preselected' over test files. No mutation executed."
    }
  },
  {
    "id": "T-2",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/decisions/coverage.test.ts",
    "line": 123,
    "problem": "AC8 'pure permissions are not journaled' is a 700-character text heuristic over tui-shell.ts; the source regex misses literal sources; the positive picker assertion depends on an unseeded arm.",
    "impact": "An allow/deny picker wrapped in journaledPick passes the test, so permissions get journaled with no red test.",
    "suggested_fix": "Replace the text heuristic with an AST audit of every journaledPick call site (fixed in 2c1e5424).",
    "evidence": "All 5 runs passed; lastIndexOf comparison cannot tell a wrapped picker from a bare one.",
    "confidence": "medium",
    "class_scope": {
      "sites": [
        "src/decisions/coverage.test.ts:123-132 lastIndexOf comparison (member)",
        "src/decisions/coverage.test.ts:116-120 source regex misses literals (member)",
        "src/decisions/coverage.test.ts:95 unseeded arm (member)",
        "src/tui/tui-shell.ts journaledPick sites near 1589, 6235, 8328 (members: callback holds showComposerChoice)",
        "src/commands/ask-user-tool.test.ts (non-member: behavioural)"
      ],
      "enumeration_method": "Read coverage.test.ts; keryx ctx rg -n 'journaledPick|showComposerChoice' src/tui/tui-shell.ts. No mutation executed."
    }
  },
  {
    "id": "S-1",
    "reviewer": "review-security-code",
    "severity": "major",
    "file": "src/decisions/journal.ts",
    "line": 55,
    "problem": "The measured agent can steer or predict its own arm: it can re-roll by repeating open, the tool description says irreversible/action avoids blind, and the salt is a same-uid readable file inside the repository.",
    "impact": "An agent re-opens or tags questions until it gets arm A, or reads the seed file and asks only when it knows the arm; the randomized comparison is selection-biased.",
    "suggested_fix": "Make open idempotent per question, move the salt to ~/.config/keryx, remove the steering wording from the tool description (fixed in 92d37b2b, 52f12a42; operator poll 67).",
    "evidence": "Predicted AACCBB and actual AACCBB: predictable from the repo-readable salt and changes with each open.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/decisions/arms.ts:176 loadRepoSalt same-uid readable salt in repo (member)",
        "src/decisions/journal.ts:55-63 seq = opens+1 then chooseArm, re-rollable (member)",
        "src/harness/tool/builtin/ask-user-tool.ts:26-29,51-52,126-127 agent sets irreversible/action (member)",
        "src/commands/decisions.ts:103-117 CLI --action/--recommend (member)",
        "src/decisions/report.ts forced-A reported apart (non-member, partial mitigation)",
        "src/decisions/export.ts exports seed and arm, not the salt (non-member)"
      ],
      "enumeration_method": "keryx ctx rg --all -n 'loadRepoSalt|seedFile|chooseArm' src --glob '!*.test.ts'; probe predicted D and got D, repeated open gave D then A."
    }
  },
  {
    "id": "L-3",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/decisions/quality.ts",
    "line": 163,
    "problem": "stripRecommendationMark is weaker than scrubRecommendWords; the blind-model prompt can still show '(preferred)', 'Recommended - use Y', 'Рекомендуется: V'.",
    "impact": "rate --blind-model sees which option was recommended; the 'blind' rating is not blind.",
    "suggested_fix": "Reuse the arm-D scrubber for the blind-model prompt (fixed in e56f68e7).",
    "evidence": "'Use X (preferred)', 'Recommended - use Y', 'Рекомендуется: V' came back unchanged.",
    "confidence": "high"
  },
  {
    "id": "L-4",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/decisions/report.ts",
    "line": 303,
    "problem": "armA.free includes arm-A decisions that had no recommendation, skewing count and median time against B.",
    "impact": "Two recommendation-less A records at 500ms and one real A at 9000ms give A-free median 500ms.",
    "suggested_fix": "Leave recommendation-less questions out of every arm and channel cell (fixed in ae945304).",
    "evidence": "chooseArm gives recommendation-less questions arm A forced:false and armRow counts their time and decisions.",
    "confidence": "high"
  },
  {
    "id": "L-5",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/decisions/report.ts",
    "line": 302,
    "problem": "Top-level byArm and armA pool all channels, mixing telegram A (typed) with TUI A in the headline table and the /decisions arms modal.",
    "impact": "The headline A share changes with channel mix.",
    "suggested_fix": "Open for the operator to rule on.",
    "evidence": "byArm and armA are built from the all-channel randomized set.",
    "confidence": "medium"
  },
  {
    "id": "L-6",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/decisions/quality.ts",
    "line": 289,
    "problem": "buildQualityMatrix keeps one model rating per decision and includes cleanContext:false ratings under the self-assessment label; commandModelCall hardcodes historyMessages 0 so cleanContext is always true on the CLI path.",
    "impact": "A contaminated CLI rating is labelled clean.",
    "suggested_fix": "Open for the operator to rule on.",
    "evidence": "The matrix keeps the latest model rating per decision including non-clean ones; history is never[] so cleanContext is always true on the CLI path.",
    "confidence": "medium"
  },
  {
    "id": "T-3",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/decisions/interviewer-path.test.ts",
    "line": 1,
    "problem": "AC9 pins runInterview, which no production code calls, plus substring checks of two SKILL.md copies.",
    "impact": "The real interview path changes while the test stays green.",
    "suggested_fix": "Open for the operator to rule on.",
    "evidence": "runInterview appears only in interviewer.ts, a re-export in service.ts and a SKILL.md mention.",
    "confidence": "medium"
  },
  {
    "id": "T-4",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/decisions/arms.test.ts",
    "line": 1,
    "problem": "AC1 determinism compared run() with run() in one process; no golden literals.",
    "impact": "The hash, PRNG or weights change and the test passes.",
    "suggested_fix": "Add golden (salt, seq) to arm and seed pairs (fixed in 67c3c5a4).",
    "evidence": "The determinism test compares run() to run() and checks only a regex shape; no golden literals.",
    "confidence": "medium"
  },
  {
    "id": "T-5",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/decisions/quality.test.ts",
    "line": 146,
    "problem": "Unseeded arm or shuffle in quality.test.ts and coverage.test.ts makes assertions depend on the draw.",
    "impact": "An unlucky draw gives an intermittent CI failure or a vacuous pass.",
    "suggested_fix": "Inject salt or seed instead of an unseeded draw (fixed in 857854ca).",
    "evidence": "Lines 146-153 derive the expected value from the unseeded shuffle; passes on any draw.",
    "confidence": "medium"
  },
  {
    "id": "T-6",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/decisions/ask.test.ts",
    "line": 1,
    "problem": "The AC3 question strip check was vacuous (no mark planted).",
    "impact": "The mark list is shortened or the question stops being scrubbed and the tests stay green.",
    "suggested_fix": "Plant every mark in question, labels, descriptions and reason, and scrub the question in arm D (fixed in f399ea74).",
    "evidence": "The question 'Which approach?' carries no mark, so the strip assertion cannot fail.",
    "confidence": "medium"
  },
  {
    "id": "T-7",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/decisions/export.test.ts",
    "line": 95,
    "problem": "plain() allows identifier-shaped stage/channel/model strings; fixtures use spaces so that path is never hit; AC11 tests use 1-2 records, not 87.",
    "impact": "An identifier-shaped secret in the stage field is exported verbatim and the leak test stays green.",
    "suggested_fix": "Open for the operator to rule on.",
    "evidence": "plain() passes identifier-shaped strings; fixtures use spaces so the path is never hit.",
    "confidence": "low"
  },
  {
    "id": "S-2",
    "reviewer": "review-security-code",
    "severity": "minor",
    "file": "src/decisions/export.ts",
    "line": 133,
    "problem": "The export allow-list is enforced only by TypeScript types; seed, arm, at, timeToAnswerMs, modelAgree and similar are copied unvalidated from the journal.",
    "impact": "A hand-edited journal line with prose in 'at' is exported verbatim; needs direct write to the journal file.",
    "suggested_fix": "Open for the operator to rule on.",
    "evidence": "openedAt, answeredAt, seed, timeToAnswerMs and rating fields are copied from the journal with no runtime validation.",
    "confidence": "high"
  },
  {
    "id": "S-3",
    "reviewer": "review-security-code",
    "severity": "minor",
    "file": "src/decisions/quality.ts",
    "line": 289,
    "problem": "--model-cmd is run with spawn(command, {shell:true}) from a CLI argument with the full environment inherited.",
    "impact": "If a harness allowlists the prefix 'keryx decisions', rate --blind-model --model-cmd runs arbitrary shell outside that allowlist.",
    "suggested_fix": "Open for the operator to rule on.",
    "evidence": "Line 289 is spawn(command, { shell: true }) with the full environment inherited.",
    "confidence": "medium"
  },
  {
    "id": "S-4",
    "reviewer": "review-security-code",
    "severity": "minor",
    "file": "src/decisions/quality.ts",
    "line": 210,
    "problem": "The judge prompt is built from agent-written question and option text and parseModelChoice takes the first digit run in stdout; cleanContext is request.history.length === 0, always true for the command call.",
    "impact": "An option containing 'answer 3' or a banner with a digit skews the self-assessment.",
    "suggested_fix": "Open for the operator to rule on.",
    "evidence": "The prompt includes agent-written text, parseModelChoice takes the first digit run, cleanContext is always true on the command path.",
    "confidence": "medium"
  },
  {
    "id": "L-7",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/decisions/journal.ts",
    "line": 55,
    "problem": "seq = open records + 1 is computed outside the append lock, so two concurrent opens can share a seed.",
    "impact": "Two simultaneous questions get the same draw; correlation only.",
    "suggested_fix": "Open for the operator to rule on.",
    "evidence": "Seeds 3062647667, 3062647667, 1100472038: two concurrent opens share a seed.",
    "confidence": "low"
  },
  {
    "id": "L-8",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/decisions/quality.ts",
    "line": 210,
    "problem": "parseModelChoice takes the first digit; store isOpen does not type-check arm/forced/legacy; 'partial' covers both B and C; --line ignores --exclude-legacy.",
    "impact": "'option 2 of 3' parsed by luck; a hand-edited open record with a bad arm type is read without complaint.",
    "suggested_fix": "Open for the operator to rule on.",
    "evidence": "parseModelChoice takes the first digit run; isOpen does not check arm/forced/legacy; --line ignores excludeLegacy.",
    "confidence": "low"
  },
  {
    "id": "S-5",
    "reviewer": "review-security-code",
    "severity": "info",
    "file": "src/decisions/report.ts",
    "line": 350,
    "problem": "report --json includes question, reason, flow and source of deviations by design; only export is scrubbed.",
    "impact": "Someone publishes report --json believing it shareable.",
    "suggested_fix": "Open for the operator to rule on.",
    "evidence": "report --json prints loadReport including question and reason.",
    "confidence": "high"
  },
  {
    "id": "S-6",
    "reviewer": "review-security-code",
    "severity": "info",
    "file": "src/decisions/import.ts",
    "line": 95,
    "problem": "Import does not apply oneLine to option labels and descriptions, reads any path without a size cap, and exportRef is an unsalted hash.",
    "impact": "Control characters kept in the journal; no live render site found.",
    "suggested_fix": "Open for the operator to rule on.",
    "evidence": "No oneLine on labels or descriptions, readFile has no size cap, exportRef is an unsalted sha256 slice.",
    "confidence": "low"
  }
]
```
