# Review of PR 1058 (flow 467: operator acts answered by the host's own question)

Four waves, 17 reviewers, 109 raw findings (10 major, 67 minor, 32 info), consolidated into 16 canonical findings. No blockers.

## major

### HQ-01 — Free text is recorded as a yes on three of four verbs

- Where: src/commands/review-operator.ts:302
- Problem: confirm-plan, waive-mutation and override-reviewers check --answer-text only with refuseDecline, a deny-list on the first word (LEAD_DECLINE). Nothing requires an affirmative. The verb's own decline option ('keep', label 'Keep: run the mutation pass') is not in LEAD_DECLINE, and neither is a non-answer such as 'what does that mean?', 'uphold' or a negation after the first word ('don't waive it', 'I do not want to waive it'). decide-premise has refuseOtherChoice; the other three have no positive check. TM-04 6b, limitations.md and cli-reference.md say free text is not a decision.
- Impact: `keryx review waive-mutation --package P --reason r --answered-by claude-code:q --answer-text "Keep: run the mutation pass" --question-text "Waive the mutation pass?"` exits 0 and writes a mutation waiver with confirmedVia host-question; the journal then answers with choice 'waive'. The record states the opposite of what the operator chose. The same for override-reviewers and for confirm-plan with any non-decline text.
- Fix: Require a positive match per verb: an affirmative word set (en and ru) and refuse when the words name the verb's decline option or contain a negation anywhere. Derive the decline set from HOST_OPTIONS[verb].decline so the table and the check cannot drift. Cover with table-driven tests: 'Keep: run the mutation pass', 'what does that mean?', 'uphold', "don't waive it", 'I do not want to waive it', each refused with the package byte-identical.
- Merged from: review-architecture-w2:A2-001, review-clean-code-w2:CC2-001, review-logic-w2:F-001, review-security-code-w2:S2-SEC-001, review-testing-practices-w1:F-001, review-style-w2:STY-W2-001, review-logic-w1:F-002, review-logic-w2:F-002, review-testing-practices-w1:F-002, review-testing-practices-w1:F-008, review-testing-practices-w1:F-011

### HQ-02 — The recorded answer is not bound to the subject it answers

- Where: src/review/coverage.ts:690
- Problem: The terminal path binds the record to what was on screen (security review M4). The host-question path records any --question-text next to any --finding, mutant set or reviewer list. Nothing requires the question text to name the finding id, the unrun mutant ids or the left-out reviewers, so an answer given to one question can be recorded against another subject.
- Impact: An agent holding an operator's 'yes' to 'Run 34 dispatches?' can record it as a waiver of the mutation pass or as a dismissal of a held finding. The reviewer-visible record carries a question text that does not mention the subject, and coverage/readiness accept it as a confirmed decision.
- Fix: Before the first write, refuse unless --question-text names the subject: the finding id for decide-premise, every unrun mutant id for waive-mutation, every left-out reviewer for override-reviewers. Keep the stale-plan gate for confirm-plan. Add tests that a question naming another subject is refused with nothing recorded.
- Merged from: review-regression-w2:RG2-001, review-logic-w3:L3-4

### HQ-03 — The unattended shell floor is bypassed by common spellings and over-matches

- Where: src/trigger/unattended.ts:126
- Problem: recordsHostQuestion tests the verb names and the --answered-by flag separately over the whole command text after deleting only quotes and backslashes. Backslash-newline, ANSI-C quoting, a variable or brace spelling hide the verb or the flag, and a command that merely names a verb and the flag (an echo, a grep) is refused. The verb list and the flag name are retyped as regex literals although OPERATOR_COMMANDS owns them. The tests at review-host-question.test.ts:342/349 state a contract the code keeps in neither direction.
- Impact: An unattended agent shell can run `keryx review waive-mutation ... --answered-by ...` spelled so the floor does not see it (S4-001), while a harmless command that mentions both words is blocked (L4-1, R4-001). The PR body promises a floor for agent shells.
- Fix: Match a parsed `keryx review <verb>` invocation, not co-occurring words: normalise line continuations and the quoting forms before the test, derive the verb list from OPERATOR_COMMANDS, and test the verb and the flag as one command. Align the two tests with the behaviour, in both directions.
- Merged from: review-security-code-w4:S4-001, review-logic-w4:L4-1, review-regression-w4:R4-001, review-architecture-w4:A4-001, review-clean-code-w4:CC4-001, review-clean-code-w4:CC4-002, review-highload-w4:H4-001, review-style-w4:ST4-001, review-pr-contract-w2:PC2-002, review-pr-contract-w4:PC4-001

### HQ-04 — Host-question opens leak into the journal export, report, counts and TUI

- Where: src/decisions/export.ts:270
- Problem: A host question is an OpenRecord with an optional hostQuestion field, and the generic readers still treat it as a live decision: buildExportWithSummary iterates every open, hostQuestionRow takes the choice from the latest answer, the report keeps the opens out of the arm and match numbers inconsistently, decisionCount adds the host opens to report.total while its doc comment still says it returns live decisions, and the TUI decisions row and arms row (decisions-surface.ts:559, 629-663) feed on that count.
- Impact: The sidebar shows a decision count that includes answers nobody can act on, the export lists host questions as decisions, and a reader of decisionCount's comment is misled. The /decisions modal and the report disagree about how many decisions exist.
- Fix: Pick one model: host-question opens are a separate, labelled kind. Filter them explicitly in export.ts and the report arm/match numbers, give decisionCount a stated meaning (live decisions only) with its comment updated, and show the host questions on their own row in the TUI. Add a test per reader.
- Merged from: review-architecture-w3:A3-001, review-logic-w3:L3-1, review-logic-w3:L3-2, review-highload-w3:H3-001, review-architecture-w3:A3-004, review-clean-code-w3:CC3-001, review-logic-w3:L3-3, review-regression-w3:R3-001

### HQ-05 — Stale terminal-only wording left at sites the rewrite did not touch

- Where: .metaproject/skills/gdskills/review/review-orchestrator/SKILL.md:124
- Problem: The change rewrote the terminal-only wording for the four acts where it edited, and left it at other sites: flow-orchestrator SKILL.md:440, review-orchestrator Hosts table and line 124, readiness.ts:266, operator-decisions.ts:309, and the Hosts-table row that should name only the four verbs. An agent reading those sites is told the act is a card or terminal only.
- Impact: On Claude Code and Codex an agent reads 'the operator runs it in their terminal' and never uses the verb this PR adds, or tells the operator to leave the chat for a terminal. The two skill copies (.metaproject and src/gdskills/bundled) must change together.
- Fix: Rewrite each stale site to name the card first where one exists, then the host question plus the verb for the four acts, and the terminal for `review complete`. Edit both skill copies; keep within the length ceilings (no net added lines).
- Merged from: review-architecture-w1:F-001, review-clean-code-w1:F-001, review-regression-w1:RG-001, review-architecture-w3:A3-003, review-style-w3:ST3-003, review-clean-code-w1:F-005, review-style-w1:F-005

## minor

### HQ-06 — Schema does not enforce what its description says; sources restated without a parity test

- Where: src/gdskills/contracts/review-finding.schema.json
- Problem: hostQuestion is described as set with confirmedVia host-question only, but the schema has no if/then coupling in either copy. operator.quote still names only the terminal and the card. The set of sources lives in the schema enum, HOST_QUESTION_SOURCES, the help strings, the skills, docs and TM-04, and nothing pins them equal.
- Impact: A record with hostQuestion and confirmedVia terminal validates; renaming a source updates the parser and leaves the help text, docs and schema stating the old set.
- Fix: Add the if/then coupling to both schema copies, update the operator.quote description, build the help source list from HOST_QUESTION_SOURCES, and add a parity test over the enum, the constant and the docs list.
- Merged from: review-architecture-w1:F-002, review-clean-code-w1:F-003, review-core-boundaries-w1:CB-001, review-core-boundaries-w1:CB-002, review-core-boundaries-w1:CB-003, review-logic-w1:F-003, review-security-code-w1:SEC-004, review-architecture-w1:F-005, review-clean-code-w2:CC2-003, review-style-w2:STY-W2-007, review-clean-code-w1:F-004, review-style-w1:F-003

### HQ-07 — Source guidance: ask_user as keryx-shell source, reply-question hosts, ref convention

- Where: .metaproject/skills/gdskills/review/review-orchestrator/SKILL.md
- Problem: The skill lists keryx shell's ask_user as a host question tool and keryx-shell as a valid source, but keryx shell has a card and the card is the stronger path; the text never says how a host that asks in a reply (Codex without a question tool) forms the <ref>. The 'card first wherever one exists' sentence and the ask_user mention disagree.
- Impact: An agent on keryx shell records a host question where a card exists; an agent on a reply-question host invents a ref.
- Fix: State that on keryx shell the card is used and keryx-shell is not a source to offer an agent; give the ref convention for reply-question hosts (the message id or a short label); drop or qualify the ask_user mention in the skill, docs, schema, TM-04 and help.
- Merged from: review-logic-w1:F-004, review-security-code-w1:SEC-003, review-architecture-w1:F-003, review-logic-w1:F-005

### HQ-08 — The confirm-plan question does not carry the plan numbers in the skill

- Where: .metaproject/skills/gdskills/review/review-orchestrator/SKILL.md
- Problem: The skill says to put the question 'as you would put it on a card' and never says that for confirm-plan it must contain the dispatch count and the min/max minutes; the code refuses a stale plan when they are missing. Both stale fixtures share no number with the current plan, so the gate is untested for a question that has some.
- Impact: An agent that follows the skill asks 'Run the plan?' and the verb refuses it as stale with a message it cannot predict.
- Fix: Say it in the skill (both copies) and test a question that carries the numbers, and one that carries only some.
- Merged from: review-logic-w1:F-001, review-testing-practices-w1:F-005

### HQ-09 — Stored text is uncapped, the ref is free, the command template invites quoting trouble

- Where: src/commands/review-operator.ts:864
- Problem: requireText rejects only blank text; --answer-text and --question-text are stored verbatim with no length cap (MAX_OPERATOR_TEXT_LENGTH exists), the ref is only trimmed, and the skill's command template puts verbatim question text, derived from reviewed code and premise-judge output, into a shell command without saying how to pass it safely.
- Impact: An oversize or crafted text bloats the package, the report and the journal; text from reviewed code reaches a shell command line.
- Fix: Cap answer and question texts and the ref before the first write; say in the skill to pass the texts as separate quoted arguments, never interpolated; test the cap.
- Merged from: review-highload-w2:HL-W2-002, review-security-code-w3:S3-001, review-security-code-w3:S3-002, review-security-code-w1:SEC-002

### HQ-10 — Journal entry quality: synthesized options, no flow context, twin merge, retry, write failure

- Where: src/commands/review-operator.ts:426
- Problem: The decisions-journal entry is opened with option ids and labels from the static HOST_OPTIONS table, without flow or flowSource, findOpenTwin can merge two distinct host questions that share a question hash, a retry of the same call has no idempotency key, and a journal write failure after the review record only warns.
- Impact: The journal can show options the operator was never offered, lose the flow link, merge two answers into one entry, or double-record on retry; a failed journal write leaves a record with no journal entry.
- Fix: Mark the options as synthesized, pass the flow context, give host-question opens a distinct id (or open and answer under one lock), make a retry with the same <source>:<ref> a no-op, and test the journal-failure path.
- Merged from: review-architecture-w2:A2-002, review-logic-w2:F-005, review-highload-w2:HL-W2-001, review-highload-w2:HL-W2-003, review-highload-w2:HL-W2-004, review-security-code-w3:S3-003

### HQ-11 — Docs and help disagree with the code

- Where: docs/docs/limitations.md:212
- Problem: limitations.md:212 and review-with-a-record.md:612 state the unattended and nested-keryx refusal and the four verbs without the qualification the code has; TM-04 §6b says 'for the others a yes' and does not say the /decisions modal shows the source; recommendation-journal.md:221 lacks the Host questions block; cli-reference usage lines omit --answer for three verbs; the help text does not call the card the stronger path; `--answer yes` is refused although docs say a yes.
- Impact: The docs site and the CLI help promise behaviour the verb does not have, and AC10 (docs match the change) is not met.
- Fix: Update limitations.md, review-with-a-record.md, TM-04 §6b, recommendation-journal.md, cli-reference.md and the help strings together with the code fix of HQ-01 and HQ-04; state the per-verb option ids and that the card is the stronger path.
- Merged from: review-pr-contract-w1:PC-001, review-pr-contract-w1:PC-002, review-pr-contract-w2:PC2-001, review-pr-contract-w3:PC3-001, review-clean-code-w2:CC2-005, review-logic-w2:F-004, review-logic-w2:F-003, review-security-code-w1:SEC-001, review-style-w1:F-001, review-clean-code-w1:F-002

### HQ-12 — recordHostQuestion is one 95-line function with casts; shape checks and types duplicated

- Where: src/commands/review-operator.ts:343
- Problem: recordHostQuestion mixes gates, per-verb validation, a deferred write and the journal write, and narrows with `as` casts that are safe only because of a check 40 lines earlier. isHostQuestion (estimate.ts) and validHostQuestion (premise.ts) are the same shape check; the conditional spread that carries hostQuestion appears at several sites; HostQuestionOpen/HostQuestionRow/OpenRecord naming overlaps; renderReport repeats its tail in three branches; the NEGATIONS fragments have no comment.
- Impact: Cost to the next editor; reordering the checks turns the casts into silent undefined access.
- Fix: Split into per-verb prepare functions taking narrowed inputs, share one hostQuestion validator, one spread helper, one render tail, and a comment on the negation fragments.
- Merged from: review-clean-code-w2:CC2-002, review-style-w2:STY-W2-002, review-style-w2:STY-W2-003, review-architecture-w3:A3-002, review-clean-code-w3:CC3-003, review-style-w3:ST3-002, review-clean-code-w3:CC3-002, review-style-w3:ST3-001, review-clean-code-w3:CC3-005, review-style-w3:ST3-004, review-style-w3:ST3-005, review-clean-code-w3:CC3-006, review-style-w3:ST3-006, review-style-w2:STY-W2-006, review-clean-code-w3:CC3-004

### HQ-13 — Tests that cannot fail, are slow, or leave branches unpinned

- Where: src/commands/review-host-question.test.ts
- Problem: The unknown-flag assertion cannot fail (the real text is 'Unknown option(s)'); the arg-stripping expression is pasted three times; a test asserts a copy of a constant has four elements; one test passes no env seam; the journal-failure catch, the card suffix (operator-confirm-review.ts:509/759) and the reader-side hostQuestion validation have no test; two AC2 tests assert less than they promise; one test calls complete() five times; spawning tests have no timeout.
- Impact: A regression in these paths passes the suite; the test file is costly to edit.
- Fix: Fix the assertion, add withoutHostFlags, drop the constant test, pass env: {}, add tests for the journal failure, the card suffix and reader-side validation, assert the subject head and items, split the complete() test, add 60_000 timeouts to spawning tests.
- Merged from: review-clean-code-w2:CC2-004, review-style-w2:STY-W2-004, review-style-w2:STY-W2-005, review-performance-w2:PERF-W2-001, review-testing-practices-w1:F-003, review-testing-practices-w1:F-004, review-testing-practices-w1:F-006, review-testing-practices-w1:F-007, review-testing-practices-w1:F-009, review-testing-practices-w1:F-010

### HQ-14 — Skill prose: one 450-word bullet, overlong wrapped lines

- Where: .metaproject/skills/gdskills/review/review-orchestrator/SKILL.md
- Problem: The Operator decisions bullet is one list item of roughly 450 words holding three separate topics, the job-orchestrator edit pushes two wrapped lines well over the surrounding column, and the unchanged closing sentence says the agent never writes an operator quote.
- Impact: The most important instruction is hard to find; the closing sentence now conflicts with the host-question path.
- Fix: Split the bullet by topic without adding lines beyond the ceilings, rewrap the job-orchestrator lines, and qualify the closing sentence.
- Merged from: review-style-w1:F-002, review-style-w1:F-004, review-architecture-w1:F-004

## info

### HQ-15 — Rebuilt gdgraph artifacts are committed in the PR

- Where: .metaproject/data/gdgraph/artifacts/summary.md
- Problem: The tracked graph artifacts (provenance, module-map, summary) were rebuilt in the worktree and committed; the summary's skipped-directories list changed for reasons unrelated to the change.
- Impact: Noise in the diff and a graph that describes the worktree.
- Fix: Drop the gdgraph artifact changes from the PR.
- Merged from: review-architecture-w1:F-006, review-clean-code-w1:F-007, review-style-w1:F-006

### HQ-16 — AC12 is not in the frozen format

- Where: .metaproject/flows/467-2026-10-19-operator-acts-answered-by-the-host-s-own/acceptance-criteria.md
- Problem: AC12 is written `- AC12 (operator-only): ...`; the file's format is `- ACn: <criterion>`, so the parser skips it and flow.json acKinds ends at AC11.
- Impact: AC12 is invisible to flow tooling.
- Fix: Write it as `- AC12: (operator-only) ...` and re-seal with `keryx flow ac update`.
- Merged from: review-clean-code-w1:F-006, review-logic-w1:F-006

**Not run:** mutation pass runs after the verifier (see the round tail).

```json keryx:findings
[
  {
    "class_scope": {
      "sites": [
        "src/commands/review-operator.ts: confirm-plan branch of recordHostQuestion (refuseDecline only)",
        "src/commands/review-operator.ts: waive-mutation and override-reviewers branch (refuseDecline only)"
      ],
      "enumeration_method": "Read recordHostQuestion branch by branch: decide-premise also calls refuseOtherChoice; the other three verbs' only content check on --answer-text is refuseDecline; confirmed by running the three verbs (verify-HQ-01-1.txt)."
    },
    "id": "HQ-01",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/commands/review-operator.ts",
    "line": 302,
    "problem": "Free text is recorded as a yes on three of four verbs. confirm-plan, waive-mutation and override-reviewers check --answer-text only with refuseDecline, a deny-list on the first word (LEAD_DECLINE). Nothing requires an affirmative. The verb's own decline option ('keep', label 'Keep: run the mutation pass') is not in LEAD_DECLINE, and neither is a non-answer such as 'what does that mean?', 'uphold' or a negation after the first word ('don't waive it', 'I do not want to waive it'). decide-premise has refuseOtherChoice; the other three have no positive check. TM-04 6b, limitations.md and cli-reference.md say free text is not a decision.",
    "impact": "`keryx review waive-mutation --package P --reason r --answered-by claude-code:q --answer-text \"Keep: run the mutation pass\" --question-text \"Waive the mutation pass?\"` exits 0 and writes a mutation waiver with confirmedVia host-question; the journal then answers with choice 'waive'. The record states the opposite of what the operator chose. The same for override-reviewers and for confirm-plan with any non-decline text.",
    "suggested_fix": "Require a positive match per verb: an affirmative word set (en and ru) and refuse when the words name the verb's decline option or contain a negation anywhere. Derive the decline set from HOST_OPTIONS[verb].decline so the table and the check cannot drift. Cover with table-driven tests: 'Keep: run the mutation pass', 'what does that mean?', 'uphold', \"don't waive it\", 'I do not want to waive it', each refused with the package byte-identical.",
    "evidence": "src/commands/review-operator.ts refuseDecline/LEAD_DECLINE/NEGATIONS/HOST_OPTIONS and the three call sites in recordHostQuestion; TM-04 §6b; limitations.md; the review-host-question tests cover --answer keep and lead declines only. Merged from: review-architecture-w2:A2-001, review-clean-code-w2:CC2-001, review-logic-w2:F-001, review-security-code-w2:S2-SEC-001, review-testing-practices-w1:F-001, review-style-w2:STY-W2-001, review-logic-w1:F-002, review-logic-w2:F-002, review-testing-practices-w1:F-002, review-testing-practices-w1:F-008, review-testing-practices-w1:F-011.",
    "confidence": "high"
  },
  {
    "class_scope": {
      "sites": [
        "src/commands/review-operator.ts: decide-premise branch (finding id not required in the question)",
        "src/commands/review-operator.ts: waive-mutation branch (mutant ids not required)",
        "src/commands/review-operator.ts: override-reviewers branch (left-out reviewers not required)"
      ],
      "enumeration_method": "The four verbs' subjects are a finding, a mutant set, a reviewer list and a plan; only confirm-plan binds (dispatch count and minutes). Read each branch of recordHostQuestion."
    },
    "id": "HQ-02",
    "reviewer": "review-regression",
    "severity": "major",
    "file": "src/review/coverage.ts",
    "line": 690,
    "problem": "The recorded answer is not bound to the subject it answers. The terminal path binds the record to what was on screen (security review M4). The host-question path records any --question-text next to any --finding, mutant set or reviewer list. Nothing requires the question text to name the finding id, the unrun mutant ids or the left-out reviewers, so an answer given to one question can be recorded against another subject.",
    "impact": "An agent holding an operator's 'yes' to 'Run 34 dispatches?' can record it as a waiver of the mutation pass or as a dismissal of a held finding. The reviewer-visible record carries a question text that does not mention the subject, and coverage/readiness accept it as a confirmed decision.",
    "suggested_fix": "Before the first write, refuse unless --question-text names the subject: the finding id for decide-premise, every unrun mutant id for waive-mutation, every left-out reviewer for override-reviewers. Keep the stale-plan gate for confirm-plan. Add tests that a question naming another subject is refused with nothing recorded.",
    "evidence": "src/review/coverage.ts:690/759/808/829 (confirmedDecision/decisionCovers accept host-question records); recordHostQuestion binds only the confirm-plan numbers. Merged from: review-regression-w2:RG2-001, review-logic-w3:L3-4.",
    "confidence": "high"
  },
  {
    "class_scope": {
      "sites": [
        "src/trigger/unattended.ts:121-127 (HOST_QUESTION_VERBS and recordsHostQuestion)",
        "src/trigger/unattended.ts:176 (the refusal call)"
      ],
      "enumeration_method": "grep of --answered-by and the four verb names in src/trigger and src/commands; the floor is one function, called from one place; tested with five command spellings (verify-HQ-03-1.txt)."
    },
    "id": "HQ-03",
    "reviewer": "review-security-code",
    "severity": "major",
    "file": "src/trigger/unattended.ts",
    "line": 126,
    "problem": "The unattended shell floor is bypassed by common spellings and over-matches. recordsHostQuestion tests the verb names and the --answered-by flag separately over the whole command text after deleting only quotes and backslashes. Backslash-newline, ANSI-C quoting, a variable or brace spelling hide the verb or the flag, and a command that merely names a verb and the flag (an echo, a grep) is refused. The verb list and the flag name are retyped as regex literals although OPERATOR_COMMANDS owns them. The tests at review-host-question.test.ts:342/349 state a contract the code keeps in neither direction.",
    "impact": "An unattended agent shell can run `keryx review waive-mutation ... --answered-by ...` spelled so the floor does not see it (S4-001), while a harmless command that mentions both words is blocked (L4-1, R4-001). The PR body promises a floor for agent shells.",
    "suggested_fix": "Match a parsed `keryx review <verb>` invocation, not co-occurring words: normalise line continuations and the quoting forms before the test, derive the verb list from OPERATOR_COMMANDS, and test the verb and the flag as one command. Align the two tests with the behaviour, in both directions.",
    "evidence": "src/trigger/unattended.ts:121-127,176 (HOST_QUESTION_VERBS, recordsHostQuestion); src/commands/review-host-question.test.ts:342,349. Merged from: review-security-code-w4:S4-001, review-logic-w4:L4-1, review-regression-w4:R4-001, review-architecture-w4:A4-001, review-clean-code-w4:CC4-001, review-clean-code-w4:CC4-002, review-highload-w4:H4-001, review-style-w4:ST4-001, review-pr-contract-w2:PC2-002, review-pr-contract-w4:PC4-001.",
    "confidence": "high"
  },
  {
    "class_scope": {
      "sites": [
        "src/decisions/export.ts:270,290",
        "src/decisions/report.ts:442,443,481,729,742",
        "src/decisions/service.ts:18,67-70",
        "src/tui/decisions-surface.ts:559,629-663,656"
      ],
      "enumeration_method": "Followed every reader of OpenRecord.hostQuestion and decisionCount from journal.ts through the report, export, service and the TUI surface."
    },
    "id": "HQ-04",
    "reviewer": "review-architecture",
    "severity": "major",
    "file": "src/decisions/export.ts",
    "line": 270,
    "problem": "Host-question opens leak into the journal export, report, counts and TUI. A host question is an OpenRecord with an optional hostQuestion field, and the generic readers still treat it as a live decision: buildExportWithSummary iterates every open, hostQuestionRow takes the choice from the latest answer, the report keeps the opens out of the arm and match numbers inconsistently, decisionCount adds the host opens to report.total while its doc comment still says it returns live decisions, and the TUI decisions row and arms row (decisions-surface.ts:559, 629-663) feed on that count.",
    "impact": "The sidebar shows a decision count that includes answers nobody can act on, the export lists host questions as decisions, and a reader of decisionCount's comment is misled. The /decisions modal and the report disagree about how many decisions exist.",
    "suggested_fix": "Pick one model: host-question opens are a separate, labelled kind. Filter them explicitly in export.ts and the report arm/match numbers, give decisionCount a stated meaning (live decisions only) with its comment updated, and show the host questions on their own row in the TUI. Add a test per reader.",
    "evidence": "src/decisions/export.ts:270,290; src/decisions/report.ts:442,443,481,729,742; src/decisions/service.ts:18,67-70; src/tui/decisions-surface.ts:559,629-663,656. Merged from: review-architecture-w3:A3-001, review-logic-w3:L3-1, review-logic-w3:L3-2, review-highload-w3:H3-001, review-architecture-w3:A3-004, review-clean-code-w3:CC3-001, review-logic-w3:L3-3, review-regression-w3:R3-001.",
    "confidence": "high"
  },
  {
    "class_scope": {
      "sites": [
        ".metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md:440",
        ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.md:124 and the Hosts table",
        "src/review/readiness.ts:266",
        "src/review/operator-decisions.ts:309-313",
        "the matching copies under src/gdskills/bundled/skills/"
      ],
      "enumeration_method": "keryx ctx rg for 'terminal' near premise, waive, override, confirm in src/review and the skills (verify-HQ-05-1.txt)."
    },
    "id": "HQ-05",
    "reviewer": "review-architecture",
    "severity": "major",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.md",
    "line": 124,
    "problem": "Stale terminal-only wording left at sites the rewrite did not touch. The change rewrote the terminal-only wording for the four acts where it edited, and left it at other sites: flow-orchestrator SKILL.md:440, review-orchestrator Hosts table and line 124, readiness.ts:266, operator-decisions.ts:309, and the Hosts-table row that should name only the four verbs. An agent reading those sites is told the act is a card or terminal only.",
    "impact": "On Claude Code and Codex an agent reads 'the operator runs it in their terminal' and never uses the verb this PR adds, or tells the operator to leave the chat for a terminal. The two skill copies (.metaproject and src/gdskills/bundled) must change together.",
    "suggested_fix": "Rewrite each stale site to name the card first where one exists, then the host question plus the verb for the four acts, and the terminal for `review complete`. Edit both skill copies; keep within the length ceilings (no net added lines).",
    "evidence": "flow-orchestrator/SKILL.md:440; review-orchestrator SKILL.md:124 and the Hosts table; src/review/readiness.ts:266; src/review/operator-decisions.ts:309. Merged from: review-architecture-w1:F-001, review-clean-code-w1:F-001, review-regression-w1:RG-001, review-architecture-w3:A3-003, review-style-w3:ST3-003, review-clean-code-w1:F-005, review-style-w1:F-005.",
    "confidence": "high"
  },
  {
    "id": "HQ-06",
    "reviewer": "review-core-boundaries",
    "severity": "minor",
    "file": "src/gdskills/contracts/review-finding.schema.json",
    "line": null,
    "problem": "Schema does not enforce what its description says; sources restated without a parity test. hostQuestion is described as set with confirmedVia host-question only, but the schema has no if/then coupling in either copy. operator.quote still names only the terminal and the card. The set of sources lives in the schema enum, HOST_QUESTION_SOURCES, the help strings, the skills, docs and TM-04, and nothing pins them equal.",
    "impact": "A record with hostQuestion and confirmedVia terminal validates; renaming a source updates the parser and leaves the help text, docs and schema stating the old set.",
    "suggested_fix": "Add the if/then coupling to both schema copies, update the operator.quote description, build the help source list from HOST_QUESTION_SOURCES, and add a parity test over the enum, the constant and the docs list.",
    "evidence": "src/gdskills/contracts/review-finding.schema.json and .metaproject/core/gdskills/contracts/review-finding.schema.json; src/review/types.ts:106; review-operator.ts help strings. Merged from: review-architecture-w1:F-002, review-clean-code-w1:F-003, review-core-boundaries-w1:CB-001, review-core-boundaries-w1:CB-002, review-core-boundaries-w1:CB-003, review-logic-w1:F-003, review-security-code-w1:SEC-004, review-architecture-w1:F-005, review-clean-code-w2:CC2-003, review-style-w2:STY-W2-007, review-clean-code-w1:F-004, review-style-w1:F-003.",
    "confidence": "high"
  },
  {
    "id": "HQ-07",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.md",
    "line": null,
    "problem": "Source guidance: ask_user as keryx-shell source, reply-question hosts, ref convention. The skill lists keryx shell's ask_user as a host question tool and keryx-shell as a valid source, but keryx shell has a card and the card is the stronger path; the text never says how a host that asks in a reply (Codex without a question tool) forms the <ref>. The 'card first wherever one exists' sentence and the ask_user mention disagree.",
    "impact": "An agent on keryx shell records a host question where a card exists; an agent on a reply-question host invents a ref.",
    "suggested_fix": "State that on keryx shell the card is used and keryx-shell is not a source to offer an agent; give the ref convention for reply-question hosts (the message id or a short label); drop or qualify the ask_user mention in the skill, docs, schema, TM-04 and help.",
    "evidence": "review-orchestrator SKILL.md Operator decisions bullet and Hosts table; TM-04 §6b. Merged from: review-logic-w1:F-004, review-security-code-w1:SEC-003, review-architecture-w1:F-003, review-logic-w1:F-005.",
    "confidence": "medium"
  },
  {
    "id": "HQ-08",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.md",
    "line": null,
    "problem": "The confirm-plan question does not carry the plan numbers in the skill. The skill says to put the question 'as you would put it on a card' and never says that for confirm-plan it must contain the dispatch count and the min/max minutes; the code refuses a stale plan when they are missing. Both stale fixtures share no number with the current plan, so the gate is untested for a question that has some.",
    "impact": "An agent that follows the skill asks 'Run the plan?' and the verb refuses it as stale with a message it cannot predict.",
    "suggested_fix": "Say it in the skill (both copies) and test a question that carries the numbers, and one that carries only some.",
    "evidence": "review-orchestrator SKILL.md; review-operator.ts stale-plan check ~378-384. Merged from: review-logic-w1:F-001, review-testing-practices-w1:F-005.",
    "confidence": "medium"
  },
  {
    "id": "HQ-09",
    "reviewer": "review-security-code",
    "severity": "minor",
    "file": "src/commands/review-operator.ts",
    "line": 864,
    "problem": "Stored text is uncapped, the ref is free, the command template invites quoting trouble. requireText rejects only blank text; --answer-text and --question-text are stored verbatim with no length cap (MAX_OPERATOR_TEXT_LENGTH exists), the ref is only trimmed, and the skill's command template puts verbatim question text, derived from reviewed code and premise-judge output, into a shell command without saying how to pass it safely.",
    "impact": "An oversize or crafted text bloats the package, the report and the journal; text from reviewed code reaches a shell command line.",
    "suggested_fix": "Cap answer and question texts and the ref before the first write; say in the skill to pass the texts as separate quoted arguments, never interpolated; test the cap.",
    "evidence": "review-operator.ts requireText/parseAnsweredBy; readiness.ts:253; premise.ts:700; SKILL.md command template. Merged from: review-highload-w2:HL-W2-002, review-security-code-w3:S3-001, review-security-code-w3:S3-002, review-security-code-w1:SEC-002.",
    "confidence": "medium"
  },
  {
    "id": "HQ-10",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/commands/review-operator.ts",
    "line": 426,
    "problem": "Journal entry quality: synthesized options, no flow context, twin merge, retry, write failure. The decisions-journal entry is opened with option ids and labels from the static HOST_OPTIONS table, without flow or flowSource, findOpenTwin can merge two distinct host questions that share a question hash, a retry of the same call has no idempotency key, and a journal write failure after the review record only warns.",
    "impact": "The journal can show options the operator was never offered, lose the flow link, merge two answers into one entry, or double-record on retry; a failed journal write leaves a record with no journal entry.",
    "suggested_fix": "Mark the options as synthesized, pass the flow context, give host-question opens a distinct id (or open and answer under one lock), make a retry with the same <source>:<ref> a no-op, and test the journal-failure path.",
    "evidence": "review-operator.ts:343-430; src/decisions/journal.ts:65,113,124. Merged from: review-architecture-w2:A2-002, review-logic-w2:F-005, review-highload-w2:HL-W2-001, review-highload-w2:HL-W2-003, review-highload-w2:HL-W2-004, review-security-code-w3:S3-003.",
    "confidence": "medium"
  },
  {
    "id": "HQ-11",
    "reviewer": "review-pr-contract",
    "severity": "minor",
    "file": "docs/docs/limitations.md",
    "line": 212,
    "problem": "Docs and help disagree with the code. limitations.md:212 and review-with-a-record.md:612 state the unattended and nested-keryx refusal and the four verbs without the qualification the code has; TM-04 §6b says 'for the others a yes' and does not say the /decisions modal shows the source; recommendation-journal.md:221 lacks the Host questions block; cli-reference usage lines omit --answer for three verbs; the help text does not call the card the stronger path; `--answer yes` is refused although docs say a yes.",
    "impact": "The docs site and the CLI help promise behaviour the verb does not have, and AC10 (docs match the change) is not met.",
    "suggested_fix": "Update limitations.md, review-with-a-record.md, TM-04 §6b, recommendation-journal.md, cli-reference.md and the help strings together with the code fix of HQ-01 and HQ-04; state the per-verb option ids and that the card is the stronger path.",
    "evidence": "docs/docs/limitations.md:210-219; docs/docs/guides/review-with-a-record.md:612-621; docs/docs/guides/recommendation-journal.md:221; docs/docs/cli-reference.md:4926; TM-04 §6b. Merged from: review-pr-contract-w1:PC-001, review-pr-contract-w1:PC-002, review-pr-contract-w2:PC2-001, review-pr-contract-w3:PC3-001, review-clean-code-w2:CC2-005, review-logic-w2:F-004, review-logic-w2:F-003, review-security-code-w1:SEC-001, review-style-w1:F-001, review-clean-code-w1:F-002.",
    "confidence": "high"
  },
  {
    "id": "HQ-12",
    "reviewer": "review-clean-code",
    "severity": "minor",
    "file": "src/commands/review-operator.ts",
    "line": 343,
    "problem": "recordHostQuestion is one 95-line function with casts; shape checks and types duplicated. recordHostQuestion mixes gates, per-verb validation, a deferred write and the journal write, and narrows with `as` casts that are safe only because of a check 40 lines earlier. isHostQuestion (estimate.ts) and validHostQuestion (premise.ts) are the same shape check; the conditional spread that carries hostQuestion appears at several sites; HostQuestionOpen/HostQuestionRow/OpenRecord naming overlaps; renderReport repeats its tail in three branches; the NEGATIONS fragments have no comment.",
    "impact": "Cost to the next editor; reordering the checks turns the casts into silent undefined access.",
    "suggested_fix": "Split into per-verb prepare functions taking narrowed inputs, share one hostQuestion validator, one spread helper, one render tail, and a comment on the negation fragments.",
    "evidence": "review-operator.ts:343-430; src/review/estimate.ts:206-221; src/review/premise.ts:700; src/review/operator-decisions.ts:6,258; src/decisions/report.ts:442,729,742; src/decisions/types.ts:1,111; src/decisions/service.ts:18. Merged from: review-clean-code-w2:CC2-002, review-style-w2:STY-W2-002, review-style-w2:STY-W2-003, review-architecture-w3:A3-002, review-clean-code-w3:CC3-003, review-style-w3:ST3-002, review-clean-code-w3:CC3-002, review-style-w3:ST3-001, review-clean-code-w3:CC3-005, review-style-w3:ST3-004, review-style-w3:ST3-005, review-clean-code-w3:CC3-006, review-style-w3:ST3-006, review-style-w2:STY-W2-006, review-clean-code-w3:CC3-004.",
    "confidence": "medium"
  },
  {
    "id": "HQ-13",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/commands/review-host-question.test.ts",
    "line": null,
    "problem": "Tests that cannot fail, are slow, or leave branches unpinned. The unknown-flag assertion cannot fail (the real text is 'Unknown option(s)'); the arg-stripping expression is pasted three times; a test asserts a copy of a constant has four elements; one test passes no env seam; the journal-failure catch, the card suffix (operator-confirm-review.ts:509/759) and the reader-side hostQuestion validation have no test; two AC2 tests assert less than they promise; one test calls complete() five times; spawning tests have no timeout.",
    "impact": "A regression in these paths passes the suite; the test file is costly to edit.",
    "suggested_fix": "Fix the assertion, add withoutHostFlags, drop the constant test, pass env: {}, add tests for the journal failure, the card suffix and reader-side validation, assert the subject head and items, split the complete() test, add 60_000 timeouts to spawning tests.",
    "evidence": "src/commands/review-host-question.test.ts lines ~205, 258, 293, 342, 349, 365, 419, 428, 456, 489, 496; src/commands/operator-confirm-review.ts:509,759. Merged from: review-clean-code-w2:CC2-004, review-style-w2:STY-W2-004, review-style-w2:STY-W2-005, review-performance-w2:PERF-W2-001, review-testing-practices-w1:F-003, review-testing-practices-w1:F-004, review-testing-practices-w1:F-006, review-testing-practices-w1:F-007, review-testing-practices-w1:F-009, review-testing-practices-w1:F-010.",
    "confidence": "high"
  },
  {
    "id": "HQ-14",
    "reviewer": "review-style",
    "severity": "minor",
    "file": ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.md",
    "line": null,
    "problem": "Skill prose: one 450-word bullet, overlong wrapped lines. The Operator decisions bullet is one list item of roughly 450 words holding three separate topics, the job-orchestrator edit pushes two wrapped lines well over the surrounding column, and the unchanged closing sentence says the agent never writes an operator quote.",
    "impact": "The most important instruction is hard to find; the closing sentence now conflicts with the host-question path.",
    "suggested_fix": "Split the bullet by topic without adding lines beyond the ceilings, rewrap the job-orchestrator lines, and qualify the closing sentence.",
    "evidence": "review-orchestrator SKILL.md Hosts table; job-orchestrator SKILL.md. Merged from: review-style-w1:F-002, review-style-w1:F-004, review-architecture-w1:F-004.",
    "confidence": "medium"
  },
  {
    "id": "HQ-15",
    "reviewer": "review-architecture",
    "severity": "info",
    "file": ".metaproject/data/gdgraph/artifacts/summary.md",
    "line": null,
    "problem": "Rebuilt gdgraph artifacts are committed in the PR. The tracked graph artifacts (provenance, module-map, summary) were rebuilt in the worktree and committed; the summary's skipped-directories list changed for reasons unrelated to the change.",
    "impact": "Noise in the diff and a graph that describes the worktree.",
    "suggested_fix": "Drop the gdgraph artifact changes from the PR.",
    "evidence": ".metaproject/data/gdgraph/.provenance.json, artifacts/module-map.json, artifacts/summary.md. Merged from: review-architecture-w1:F-006, review-clean-code-w1:F-007, review-style-w1:F-006.",
    "confidence": "high"
  },
  {
    "id": "HQ-16",
    "reviewer": "review-clean-code",
    "severity": "info",
    "file": ".metaproject/flows/467-2026-10-19-operator-acts-answered-by-the-host-s-own/acceptance-criteria.md",
    "line": null,
    "problem": "AC12 is not in the frozen format. AC12 is written `- AC12 (operator-only): ...`; the file's format is `- ACn: <criterion>`, so the parser skips it and flow.json acKinds ends at AC11.",
    "impact": "AC12 is invisible to flow tooling.",
    "suggested_fix": "Write it as `- AC12: (operator-only) ...` and re-seal with `keryx flow ac update`.",
    "evidence": "acceptance-criteria.md; flow.json acKinds. Merged from: review-clean-code-w1:F-006, review-logic-w1:F-006.",
    "confidence": "high"
  }
]
```
