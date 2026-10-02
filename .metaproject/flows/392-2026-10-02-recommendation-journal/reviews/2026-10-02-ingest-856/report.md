Independent review of PR #856 (flow 392, recommendation journal): no blockers, four major findings (the reason prompt blocks the tool result and cannot take text, the ask_user path never records a flow or a stage, the irreversible matcher misses non-English and non-prefix phrasings) and seven minor ones. AC2, AC7 and AC10 hold on reading; AC4, AC6 and AC9 do not hold on the ask_user path.

```json keryx:findings
[
  {
    "id": "F-001",
    "severity": "major",
    "problem": "journalAsk awaits the deviation-reason question before it returns `chosen`. ask_user's tool result (and so the agent turn) is held until the human answers a second picker that no one asked for.",
    "impact": "AC9 / the operator's rule that nothing blocks and nothing slows a question: the human picks an option that differs from the recommendation, the tool call stays pending, the TUI sits in 'waiting for your answer' on a second dock, and the turn does not resume until they press an option or Esc. The same ask is shown on every deviation. docs/docs/guides/recommendation-journal.md ('It never blocks or delays a question') and the CHANGELOG say the opposite.",
    "suggested_fix": "Return `chosen` first and ask for the reason afterwards without holding the tool result (fire-and-forget, errors swallowed), or collect the reason through a non-blocking surface (the /decisions modal or a transcript prompt). Fix the docs to say what actually happens.",
    "evidence": "Read src/decisions/ask.ts at the PR head: line 100 `if (result.askReason) await askReasonOnce(ask, deps, opened.id);` runs inside the async wrapper before `return chosen` at the end of the function, and askReasonOnce itself `await ask(...)`s the host picker with no timeout.",
    "confidence": "high",
    "file": "src/decisions/ask.ts",
    "line": 100,
    "quote": "      if (result.askReason) await askReasonOnce(ask, deps, opened.id);",
    "class_scope": {
      "sites": [
        "src/decisions/ask.ts:100 await askReasonOnce(...) before return chosen",
        "docs/docs/guides/recommendation-journal.md 'What it does not do' first bullet",
        "CHANGELOG.md 0.3.62 'Journaling never blocks or delays a question'"
      ],
      "enumeration_method": "keryx ctx rg 'askReasonOnce|await ask\\(' src/decisions, and keryx ctx rg 'never blocks|never delays' docs/docs CHANGELOG.md; the wrapper has one awaited second question and two places that deny it"
    },
    "reviewer": "flow392-pr856-review"
  },
  {
    "id": "F-002",
    "severity": "major",
    "problem": "The reason question asks with `allowFreeform: true`, but the only host (askUserInteractive in tui-shell.ts) takes `question` and `options` only and renders a composer-choice picker; no host anywhere reads allowFreeform. The human can only pick 'No reason' or 'Not now' (or Esc), so the reason can never be typed.",
    "impact": "AC6 in the real TUI: the human deviates from a recommendation, gets the reason picker with two buttons and no text field, picks 'No reason', and the deviation is recorded with no reason. Every deviation in the report reads 'reason: (none given)', and the AC11 judgement ('why I deviate') has no data. A reason typed as the literal word skip or later would also be discarded as a sentinel.",
    "suggested_fix": "Give the host a free-text path (or have the wrapper use the existing composer for the reason) and cover it with a test that goes through the TUI host, not a stub `ask` that returns text. Use out-of-band sentinels instead of the strings 'skip' and 'later'.",
    "evidence": "Read src/decisions/ask.ts lines 107-125 and src/tui/tui-shell.ts askUserInteractive (line 5636, parameter type has no allowFreeform; showComposerChoice is called with options only). `keryx ctx rg allowFreeform src` outside tests lists only ask-user-tool.ts and ask.ts: nothing consumes it.",
    "confidence": "high",
    "file": "src/decisions/ask.ts",
    "line": 117,
    "quote": "      allowFreeform: true,",
    "class_scope": {
      "sites": [
        "src/decisions/ask.ts askReasonOnce ask({... allowFreeform: true })",
        "src/tui/tui-shell.ts askUserInteractive (setAskUserHost) ignores allowFreeform",
        "src/harness/tool/builtin/ask-user-tool.ts allow_freeform forwarded to the same host, also unused"
      ],
      "enumeration_method": "keryx ctx rg 'allowFreeform|allow_freeform' src --glob '!*.test.ts' lists three files, and none of them is a host that renders a text field"
    },
    "reviewer": "flow392-pr856-review"
  },
  {
    "id": "F-003",
    "severity": "major",
    "problem": "On keryx's own ask_user path the flow comes only from the KERYX_FLOW environment variable, which nothing in src sets, and the stage is the constant 'ask_user'. Every TUI question is therefore recorded with flow null and stage 'ask_user'.",
    "impact": "AC9 and AC1/AC7: the operator works in flow 392 in the TUI and answers a question; the record has flow=null, journalToFlow returns at once, and no line reaches the flow's journal.md. The report's 'by stage' table is a single row 'ask_user' for the whole journal, so the stage dimension the PRD asks for does not exist for the one path that produces most records. The flow is also read once when the tool is built, not per question.",
    "suggested_fix": "Resolve the active flow and stage per question from the session (the TUI knows the flow it is working on), or let the ask_user tool carry them; read the environment lazily if it stays a fallback. Add a test that goes through journaledAskUser with a flow active and asserts the journal.md line.",
    "evidence": "keryx ctx rg 'KERYX_FLOW\\b' src finds only decisions.ts, ask-user-bridge.ts and command-registry.ts, all readers; no writer. src/decisions/ask.ts line 80 `stage: deps.stage ?? \"ask_user\"` and journaledAskUser never passes a stage.",
    "confidence": "high",
    "file": "src/tui/ask-user-bridge.ts",
    "line": 42,
    "quote": "    flow: process.env[\"KERYX_FLOW\"] !== undefined && process.env[\"KERYX_FLOW\"].length > 0 ? process.env[\"KERYX_FLOW\"] : undefined,",
    "class_scope": {
      "sites": [
        "src/tui/ask-user-bridge.ts journaledAskUser flow from KERYX_FLOW, read at construction",
        "src/decisions/ask.ts stage defaults to 'ask_user' for every question",
        "src/commands/decisions.ts runOpen reads KERYX_FLOW (CLI path, fine where an agent sets it)"
      ],
      "enumeration_method": "keryx ctx rg 'KERYX_FLOW\\b' src and keryx ctx rg 'deps.stage|stage:' src/decisions/ask.ts; the single caller of journalAsk is journaledAskUser, which passes neither a per-question flow nor a stage"
    },
    "reviewer": "flow392-pr856-review"
  },
  {
    "id": "F-004",
    "severity": "major",
    "problem": "Irreversible matching looks only at the question text (and an --action tag the ask_user path never passes), by English word prefix. Questions that are not written with release/delete/push/publish/deploy at the start of a word are asked blind.",
    "impact": "AC4: with the built-in list, isIrreversible is false for 'Выкатываем релиз 0.3.62?', 'Удалить ветку feature/x?', 'Опубликовать пакет в npm?', 'Unpublish 0.3.61 from npm?' (the n before publish is a letter), 'Merge PR 856 into main?' and 'Drop the users table?', and for 'How should we handle the old branch?' whose options are 'Delete it' and 'Keep it'. Each of these is drawn blind one time in three, so a release or delete decision can be asked with no recommendation mark. The operator writes to the agent in Russian, so the likeliest phrasing is the one that is not covered. The documented fail direction ('when in doubt, irreversible') does not hold for any word the list does not name.",
    "suggested_fix": "Match option labels and descriptions as well as the question, and match inside words for the English stems (unpublish, prerelease); ship Russian stems (релиз, удал, опублик, выкат) and merge/drop/remove/overwrite/reset in the defaults, or invert the rule so blind is allowed only when a question is positively marked reversible. Pass `action` from the ask_user path or drop the claim that the tag is matched.",
    "evidence": "Ran isIrreversible(DEFAULT_IRREVERSIBLE, q) from src/decisions/blind.ts on those strings: false for all of them above; true for 'Force-push the rebased branch?'. src/decisions/ask.ts never passes `action` to openDecision.",
    "confidence": "high",
    "file": "src/decisions/blind.ts",
    "line": 52,
    "quote": "  const haystacks = [question, action ?? \"\"].map((text) => text.toLowerCase());",
    "class_scope": {
      "sites": [
        "src/decisions/blind.ts isIrreversible haystacks: question and action only",
        "src/decisions/blind.ts DEFAULT_IRREVERSIBLE five English words",
        "src/decisions/ask.ts openDecision call without an action"
      ],
      "enumeration_method": "keryx ctx rg 'isIrreversible|DEFAULT_IRREVERSIBLE|action' src/decisions --glob '!*.test.ts'; the one matcher is called from openDecision, whose only inputs are the question text and an action tag that the wrapper leaves undefined"
    },
    "reviewer": "flow392-pr856-review"
  },
  {
    "id": "F-005",
    "severity": "minor",
    "problem": "answerDecision records any non-empty --choice, without checking it is one of the options of the opened decision, and writes it raw (multi-line allowed) into the tracked flow journal.md.",
    "impact": "`keryx decisions answer d-1 --choice Fix` (the label, not the id `fix`) is stored as an answer, counted as a deviation from recommendation `fix`, triggers 'ask the human once for a reason', and shows up in the report as 'chose Fix'. A --choice containing a newline writes extra lines into journal.md, which the flow journal format treats as separate entries.",
    "suggested_fix": "Reject a choice that is not an option id (freeform only where the question allowed it) and collapse whitespace before writing the journal.md line.",
    "evidence": "Read src/decisions/journal.ts answerDecision (line 95 trims only) and journalToFlow (line 157 interpolates answer.choice); appendJournal in src/flow/store.ts line 261 writes `- ${at} - ${line}\\n` unchanged.",
    "confidence": "high",
    "file": "src/decisions/journal.ts",
    "line": 95,
    "quote": "  const choice = input.choice.trim();",
    "reviewer": "flow392-pr856-review"
  },
  {
    "id": "F-006",
    "severity": "minor",
    "problem": "readRecords accepts any parsed line whose kind is open/answer/reason and which has string id and at, without checking the rest of the shape. A record such as {\"kind\":\"open\",\"id\":\"x\",\"at\":\"t\"} gets into buildReport and answerDecision.",
    "impact": "`keryx decisions report` and the /decisions modal throw `TypeError: undefined is not an object (evaluating 'open.recommendation.optionId')` for the whole journal as soon as one such line exists (a hand edit, a truncated write, or a record from another keryx version). Reproduced by calling buildReport on that open plus an answer.",
    "suggested_fix": "Validate open records (options array, order array, recommendation null or an object, mode) in isRecord, and skip the ones that do not fit, as the header comment already promises for damaged lines.",
    "evidence": "Ran buildReport([{kind:'open',id:'x',at:'t'}, {kind:'answer',id:'x',at:'t',seq:1,choice:'a',timeToAnswerMs:1,changed:false}]) from src/decisions/report.ts: threw the TypeError above.",
    "confidence": "high",
    "file": "src/decisions/store.ts",
    "line": 27,
    "quote": "function isRecord(value: unknown): value is DecisionRecord {",
    "reviewer": "flow392-pr856-review"
  },
  {
    "id": "F-007",
    "severity": "minor",
    "problem": "On the ask_user path the recorded 'reason' for the recommendation is the recommended option's description, because the tool has no reason field.",
    "impact": "AC1 asks for the agent's recommendation and its reason. A question whose recommended option is described 'Grants another allotment of rounds' is journaled, and revealed in blind mode, with that sentence as the agent's reasoning; the report's 'recommended' reason never says why the agent preferred it over the others.",
    "suggested_fix": "Add an optional `recommendation_reason` to the ask_user input and record that, falling back to the description only when absent, and say so in the docs.",
    "evidence": "Read src/decisions/ask.ts line 79 and the ask_user input schema in src/harness/tool/builtin/ask-user-tool.ts: options carry id, label, description, recommended and nothing else.",
    "confidence": "medium",
    "file": "src/decisions/ask.ts",
    "line": 79,
    "quote": "        recommendation: recommended === undefined ? undefined : { optionId: recommended.id, reason: recommended.description },",
    "reviewer": "flow392-pr856-review"
  },
  {
    "id": "F-008",
    "severity": "minor",
    "problem": "journaledAskUser never passes onNote, so every journaling failure on the ask_user path (cannot open, cannot record, cannot record the reason) is dropped without a word. The docs say a failure 'is reported on one line'.",
    "impact": "With .metaproject/data unwritable (a read-only checkout, a full disk) every question is asked ordinarily with the mark and nothing is recorded or shown; the operator finds out only after two weeks, when AC11's 20 decisions are not in the report.",
    "suggested_fix": "Wire onNote to the same transcript sink as notify (once per session is enough), or correct the docs.",
    "evidence": "Read src/tui/ask-user-bridge.ts journaledAskUser: the options object has cwd, flow and notify only; src/decisions/ask.ts note() is a no-op when onNote is undefined; docs/docs/guides/recommendation-journal.md line 89-90.",
    "confidence": "high",
    "file": "src/tui/ask-user-bridge.ts",
    "line": 40,
    "quote": "  const journaled = journalAsk(invokeAskUserHost, {",
    "reviewer": "flow392-pr856-review"
  },
  {
    "id": "F-009",
    "severity": "minor",
    "problem": "The project-wide journal is a git-ignored file under the working directory (cwd/.metaproject/data/decisions), so each checkout and each git worktree has its own, and removing a worktree deletes it. With F-003 the flow's journal.md line, the only tracked copy, is also not written on the ask_user path.",
    "impact": "The operator runs flows in worktrees such as /home/altsay/keryx-wF. Questions answered there are written to that worktree's journal; `git worktree remove` after the merge deletes it, and `keryx decisions report` in the main checkout never sees them. The 'at least 20 decisions after two weeks' of AC11 can only be met if everything is asked in one long-lived checkout.",
    "suggested_fix": "Resolve the journal under the common project root (the main worktree) or a user-level data dir, or document the limit in the guide next to the .gitignore line.",
    "evidence": "Read src/decisions/store.ts decisionsDir(cwd) = join(cwd, '.metaproject', 'data', 'decisions') and the .gitignore entry added in this PR; callers pass opts.session?.cwd ?? process.cwd().",
    "confidence": "medium",
    "file": "src/decisions/store.ts",
    "line": 13,
    "quote": "export function decisionsDir(cwd: string): string {",
    "reviewer": "flow392-pr856-review"
  },
  {
    "id": "F-010",
    "severity": "minor",
    "problem": "Blind mode hides only the boolean `recommended` flag. The option label, description and question text are shown as the agent wrote them.",
    "impact": "The ask_user description tells the model to 'mark one recommended', and the Claude-style convention for such questions is a label such as 'Increase limit (Recommended)'. In a blind question that label reaches the human intact, so the question is counted as blind while the mark is plainly visible, and the blind/ordinary comparison is contaminated without any record of it.",
    "suggested_fix": "In blind mode strip a trailing '(recommended)' marker from labels and descriptions, and add a test; or record `leaked: true` when the text of the recommended option contains the word.",
    "evidence": "Read present() in src/decisions/ask.ts (it only destructures `recommended` away) and the tool description in src/harness/tool/builtin/ask-user-tool.ts and src/commands/agent.ts line 1786.",
    "confidence": "medium",
    "file": "src/decisions/ask.ts",
    "line": 59,
    "quote": "    const { recommended: _hidden, ...rest } = option;",
    "reviewer": "flow392-pr856-review"
  },
  {
    "id": "F-011",
    "severity": "minor",
    "problem": "On the ask_user path the reveal is a one-way transcript line. Nothing offers the human a chance to change the answer, so the 'changed' answer of AC5 can only be produced by calling `keryx decisions answer` a second time by hand.",
    "impact": "A blind question in the TUI: the human picks B, the transcript shows 'The agent recommended A', and the tool result has already gone back to the agent. `changed` is always false for every TUI record and the report's 'Changed after the reveal' stays 0, so the contamination the report is built to separate out can never appear.",
    "suggested_fix": "Decide whether the ask_user path should hold the result for a short revision step (and then it is a delay, see F-001), or state in the docs and AC notes that a changed answer exists only on the CLI path.",
    "evidence": "Read src/decisions/ask.ts lines 89-105: one answerDecision per question, then return; tests in src/decisions/decisions.test.ts exercise a second answerDecision directly, not through the wrapper.",
    "confidence": "medium",
    "file": "src/decisions/ask.ts",
    "line": 94,
    "quote": "      if (result.recommendation !== null && opened.mode === \"blind\") {",
    "reviewer": "flow392-pr856-review"
  }
]
```
