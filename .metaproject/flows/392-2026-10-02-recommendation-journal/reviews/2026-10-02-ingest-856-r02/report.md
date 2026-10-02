Second-round independent review of PR #856 at 15c52808: F-001..F-004, F-006..F-010 and F-011 (as a record) hold, with tests that pass (79 pass, 2 skip, 0 fail). The fixes introduce one regression and leave small gaps: the widened irreversible matcher marks most coding questions irreversible so blind mode rarely triggers (major), round 1 F-005 is only partly fixed because free-form text still lands multi-line in journal.md, and the change/reason follow-ups and AC6 wording have misleading or loose behaviour (minor). No blockers; AC4 and AC3 are at risk by measurement, AC6 differs from its frozen text.

```json keryx:findings
[
  {
    "id": "F-001",
    "severity": "major",
    "problem": "The F-004 fix widened the irreversible matcher so far that ordinary engineering questions are classed irreversible. isIrreversible now scans the question, the --action tag and every option's id, label and description, and the built-in list gained generic verbs (remove, drop, merge, force, push, deploy, delete, publish) that match at the start of any word.",
    "impact": "AC3 and AC11: the operator answers a coding question such as 'How should the config loader be structured?' with an option 'Merge both loaders', or a cache question whose option says 'can drop old rows with TTL', or 'Remove duplication' under a refactor question. Each is flagged irreversible, mode is forced to ordinary, and the question is never blind. In a coding agent's questions these words are routine, so the share of blind questions falls well below 1/3 and the 'at least 5 of 20 blind' bar in AC11 is not reachable by chance; the report still prints a blind share, computed over a biased subset. The operator also gets no signal that blind mode is being suppressed (blindRefused is returned but never shown on the ask_user path).",
    "suggested_fix": "Match the irreversible list against the question text and the --action tag, and at most the recommended option's label; do not scan every option description. Drop the generic verbs (remove, drop, merge, force) from the defaults or require an object (force push, drop table, merge to main). Count and show, in the report, how many questions were refused blind, so suppression is visible.",
    "evidence": "Ran src/decisions/blind.ts isIrreversible with DEFAULT_IRREVERSIBLE on five plausible questions: 'How should the config loader be structured?' (option 'Merge both loaders') true; 'Which cache should we use?' (option description 'Persistent, can drop old rows with TTL') true; 'Refactor approach?' (option 'Remove duplication') true; 'Which test strategy?' (description 'will force a rebuild of the fixtures') true; the same question without that phrase false. 4 of 5 ordinary questions irreversible. Russian root 'отправ' also flags 'Как поступить с отправной точкой?'. Round 1 F-004 itself is fixed (the Russian, Unpublish and merge examples return true); this is the regression it introduced.",
    "confidence": "medium",
    "file": "src/decisions/blind.ts",
    "line": 89,
    "quote": "const haystacks = [question, action ?? \"\", ...options.flatMap((option) => [option.id, option.label ?? \"\", option.description ?? \"\"])]",
    "class_scope": {
      "sites": [
        "src/decisions/blind.ts haystacks built from every option's id, label and description",
        "src/decisions/blind.ts DEFAULT_IRREVERSIBLE generic verbs: remove, drop, merge, force, push, deploy, delete, publish",
        "src/decisions/journal.ts openDecision: irreversible forces mode ordinary and only sets blindRefused in the result",
        "src/decisions/ask.ts journalAsk: blindRefused is never read or shown"
      ],
      "enumeration_method": "keryx ctx rg 'isIrreversible|blindRefused|DEFAULT_IRREVERSIBLE' src --glob '!*.test.ts' lists the matcher, its one caller in journal.ts and the unread result field; the sample run above shows the match rate."
    },
    "reviewer": "flow392-pr856-review-r2"
  },
  {
    "id": "F-002",
    "severity": "minor",
    "problem": "A free-form ask_user answer is written verbatim, newlines included, into the tracked flow journal.md and into the report. The F-005 fix validated option ids and added --other, but the free-form text path still goes through answerDecision with `chose ${answer.choice}` and no whitespace normalisation, which is the multi-line write that finding F-005 named.",
    "impact": "The operator answers a question with free text pasted over two lines ('line1' newline '- 2099-01-01 - forged line'). The report prints 'chose line1' and a second line that reads as a separate bullet, and the flow's journal.md gets a second line that looks like a journal entry with a forged timestamp. The journal.md is tracked, so the stray line is committed.",
    "suggested_fix": "Collapse whitespace (the existing oneLine helper) in the text written to journal.md and in the report's 'chose' column; keep the raw text only in the JSONL record, and cap its length.",
    "evidence": "Ran answerDecision with other:true and choice 'line1\\n- 2099-01-01 - forged line' in a temp project, then renderReport: the output shows 'recommended a, chose line1' followed by a line '- 2099-01-01 - forged line' on its own row. src/decisions/journal.ts journalToFlow interpolates answer.choice directly into the line passed to appendJournal (src/flow/store.ts appendFile `- ${at} - ${line}`).",
    "confidence": "high",
    "file": "src/decisions/journal.ts",
    "line": 166,
    "quote": "      `decision ${open.id} [${open.stage}, ${open.mode}]: chose ${answer.choice}${changed}; ${verdict}`,",
    "class_scope": {
      "sites": [
        "src/decisions/journal.ts journalToFlow chose ${answer.choice}",
        "src/decisions/report.ts renderReport deviation row 'chose'",
        "src/decisions/journal.ts answerDecision stores `choice` trimmed but not single-lined"
      ],
      "enumeration_method": "keryx ctx rg 'answer.choice|dev.chose|chose ' src/decisions --glob '!*.test.ts' lists the two renderers; both take the raw string."
    },
    "reviewer": "flow392-pr856-review-r2"
  },
  {
    "id": "F-003",
    "severity": "minor",
    "problem": "`/decisions change` appends a second answer, but on the ask_user path the tool result has already gone back to the agent with the first answer, and the confirmation says nothing about that. The wording ('Answer for decision ... changed to X. Both answers stay on record') reads as if the choice was changed for the agent as well.",
    "impact": "Blind question, the human picks B, the reveal shows A was recommended, the human runs `/decisions change A` and believes the agent will now follow A. The agent already received B and carries on with it. The journal says the final answer is A, the flow's journal.md says '(changed answer)', and the code that the human thinks was chosen is not the code that gets written. AC5 (both entries written, changed flag) holds; the message is what misleads.",
    "suggested_fix": "Say in the confirmation that the agent already has the first answer and that this only corrects the record, or hand the correction to the agent through the transcript so it can act on it.",
    "evidence": "src/tui/decisions-surface.ts runDecisionsFollowup change branch calls changeAnswer and says only that both answers stay on record and that the report counts the first. src/decisions/ask.ts journalAsk returns `chosen` before any follow-up can happen (the F-001 fix), so the agent cannot see the later answer.",
    "confidence": "high",
    "file": "src/tui/decisions-surface.ts",
    "line": 76,
    "quote": "    say(`Answer for decision ${result.id} changed to ${result.choice}. Both answers stay on record; the report counts the first one.`);",
    "class_scope": {
      "sites": [
        "src/tui/decisions-surface.ts runDecisionsFollowup change confirmation",
        "src/decisions/ask.ts reveal line 'To change your answer: /decisions change <option>.'",
        "docs/docs/guides/recommendation-journal.md description of /decisions change"
      ],
      "enumeration_method": "keryx ctx rg 'decisions change|changeAnswer' src docs/docs --glob '!*.test.ts' lists the three places that describe the change without saying the agent already acted."
    },
    "reviewer": "flow392-pr856-review-r2"
  },
  {
    "id": "F-004",
    "severity": "minor",
    "problem": "Frozen AC6 says the human 'is asked once for a reason' after a deviation. The F-001 fix replaced the question with a one-line transcript hint (`/decisions reason <why>`), so nobody is asked; the criterion text was not updated through `flow ac update`.",
    "impact": "A human who deviates and does not read or act on a transcript line gives no reason, and the report reads 'reason: (none given)' for nearly every deviation, so the 'why I deviate' half of AC11's judgement has little data. Separately, the frozen file and the implementation now disagree, and `flow ac confirm AC6` would confirm text that is not what was built.",
    "suggested_fix": "Operator decision: either amend AC6 with `keryx flow ac update` to say the reason is offered after the answer through a hint and a command, or give the offer a surface that actually asks (for example a composer line after the turn ends) without holding the tool result.",
    "evidence": "src/decisions/ask.ts only pushes the string 'If you want, add a reason (once): /decisions reason <why>.' into a transcript notification when result.askReason is true; there is no ask call left after the answer. Frozen file .metaproject/flows/392-2026-10-02-recommendation-journal/acceptance-criteria.md AC6 still reads 'the human is asked once for a reason'.",
    "confidence": "medium",
    "file": "src/decisions/ask.ts",
    "line": 147,
    "quote": "      if (result.askReason) parts.push(\"If you want, add a reason (once): /decisions reason <why>.\");",
    "class_scope": {
      "sites": [
        "src/decisions/ask.ts transcript hint replaces the ask",
        "src/decisions/journal.ts answerDecision askReason flag, now only a hint",
        "acceptance-criteria.md AC6 wording"
      ],
      "enumeration_method": "keryx ctx rg 'askReason' src --glob '!*.test.ts' lists the producer and the hint; no consumer asks a question."
    },
    "reviewer": "flow392-pr856-review-r2"
  },
  {
    "id": "F-005",
    "severity": "minor",
    "problem": "`/decisions reason` and `/decisions change` without an id fall back to the latest answered decision in the whole journal when this TUI session has not answered any question. After F-009 that journal is shared by every worktree and session of the repository.",
    "impact": "Session A (worktree keryx-wF) answers a question; the operator opens session B in another worktree, answers nothing there, and types `/decisions change X`. The command appends a changed answer to session A's decision (resolved by option label, so a matching label makes it succeed) and the confirmation names only the decision id. Nothing is rewritten, but the record of another session's question is altered by a command that was meant for none.",
    "suggested_fix": "Without a session-local last decision id, refuse and ask for an explicit id (or list the latest few), instead of falling back to the repository-wide latest.",
    "evidence": "src/decisions/followup.ts resolveOpen: `id ?? lastId ?? (await latestAnsweredDecision(cwd))`; src/decisions/store.ts journalRoot makes cwd resolve to the main checkout, so latestAnsweredDecision reads every session's records; src/tui/ask-user-bridge.ts lastDecisionId is module state set only by this session's journaled questions.",
    "confidence": "high",
    "file": "src/decisions/followup.ts",
    "line": 23,
    "quote": "  const wanted = id ?? lastId ?? (await latestAnsweredDecision(cwd));",
    "class_scope": {
      "sites": [
        "src/decisions/followup.ts resolveOpen fallback",
        "src/decisions/followup.ts giveReason and changeAnswer both use resolveOpen"
      ],
      "enumeration_method": "keryx ctx rg 'latestAnsweredDecision|resolveOpen' src --glob '!*.test.ts' lists the one fallback and its two callers."
    },
    "reviewer": "flow392-pr856-review-r2"
  },
  {
    "id": "F-006",
    "severity": "minor",
    "problem": "When the branch names no flow, resolveFlowContext attributes the question to the only flow whose status is in-progress, even if the operator is not working on it. That flow then receives a line in its tracked journal.md.",
    "impact": "The operator works on main or on an unrelated branch while one stale flow is left in-progress (a long-lived flow is normal here). Every ask_user question is recorded with that flow and stage, and each answer appends a line to that flow's journal.md, leaving the main checkout with a modified tracked file and putting questions about other work into that flow's by-stage numbers.",
    "suggested_fix": "Use the in-progress fallback only when the branch matched nothing AND the flow's own branch or worktree is the current one; otherwise record no flow. Alternatively mark the guess in the record (flow_source) so the report can exclude it.",
    "evidence": "src/decisions/context.ts resolveFlowContext: when KERYX_FLOW is unset and fromBranch yields nothing, `dir ??= await onlyInProgress(cwd, dirs)` picks any single in-progress flow of the 30 newest. On /home/altsay/keryx (main) it returned no flow only because several flows are in progress at once, which is luck rather than a rule.",
    "confidence": "medium",
    "file": "src/decisions/context.ts",
    "line": 93,
    "quote": "      dir ??= await onlyInProgress(cwd, dirs);",
    "class_scope": {
      "sites": [
        "src/decisions/context.ts onlyInProgress fallback",
        "src/decisions/journal.ts journalToFlow appends to the resolved flow's journal.md",
        "src/commands/decisions.ts runOpen uses the same resolver"
      ],
      "enumeration_method": "keryx ctx rg 'resolveFlowContext|onlyInProgress' src --glob '!*.test.ts' lists the resolver and its two callers (ask_user bridge and decisions open)."
    },
    "reviewer": "flow392-pr856-review-r2"
  }
]
```
