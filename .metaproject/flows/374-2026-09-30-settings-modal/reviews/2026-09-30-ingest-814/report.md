Independent review of PR #814 (flow 374, /settings modal): no blockers, one major input-ownership gap on the mouse path and five minor findings, all fixed in f240da30.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "flow374-pr814-review",
    "severity": "major",
    "problem": "The modal's inputBlocked guard covered keys only. The row and button mouse handlers ignored it, and the sidebar mode-row click opened the modal without checking for an active overlay.",
    "impact": "With a shell_exec approval dock pending, two clicks on [auto] (arm, commit) would switch the permission mode to auto without any dialog.",
    "suggested_fix": "Refuse the sidebar click while an overlay is active or a turn is running, and return early from every mouse callback and from press() when inputBlocked is true.",
    "evidence": "Read src/tui/settings-modal.ts and the sidebar handler in src/tui/tui-shell.ts at c926382d: only the key handler read options.inputBlocked. Fixed in f240da30 with a test that clicks and Enters change nothing while blocked.",
    "confidence": "high",
    "file": "src/tui/settings-modal.ts",
    "line": 132,
    "quote": "        onMouseDown: (event: { stopPropagation: () => void }) => {",
    "class_scope": {"sites": ["src/tui/settings-modal.ts row onMouseDown (select)", "src/tui/settings-modal.ts button callback passed to smallActionButton (press)", "src/tui/tui-shell.ts sb-mode-v onMouseDown (showSettings)"], "enumeration_method": "keryx ctx rg for onMouseDown and showSettings( across src/tui/settings-modal.ts and src/tui/tui-shell.ts at c926382d; the modal has one row handler and one button handler, the shell opens the modal from the sidebar click only"}
  },
  {
    "id": "F-002",
    "reviewer": "flow374-pr814-review",
    "severity": "minor",
    "problem": "A held Enter auto-repeats, so arming and confirming `auto` could both happen within one physical key press.",
    "impact": "The two-step confirmation for the mode that skips confirmation could be bypassed by holding Enter.",
    "suggested_fix": "Ignore a confirming Enter that arrives within about 400 ms of the arming one, with an injectable clock for tests.",
    "evidence": "Read src/tui/settings-modal.ts press(): the armed check has no time component. Fixed in f240da30 (CONFIRM_MIN_GAP_MS) with fast and slow second-Enter tests.",
    "confidence": "high",
    "file": "src/tui/settings-modal.ts",
    "line": 181,
    "quote": "    if (action.confirm && (armed?.id !== row.id || armed.action !== selectedAction)) {"
  },
  {
    "id": "F-003",
    "reviewer": "flow374-pr814-review",
    "severity": "minor",
    "problem": "The reasoning row was labelled saved, but after a press its source became session and, with KERYX_REASONING_EFFORT set, the environment value wins again after a restart.",
    "impact": "The row could promise a persistence the precedence (session, then env, then saved) does not deliver.",
    "suggested_fix": "Make the scope and detail follow the real precedence and say when the environment variable wins on restart.",
    "evidence": "Read src/tui/settings-model.ts and resolveReasoningEffort in src/commands/agent.ts. Fixed in f240da30 with one model test per source.",
    "confidence": "medium",
    "file": "src/tui/settings-model.ts",
    "line": 83,
    "quote": "  session: \"set this session\","
  },
  {
    "id": "F-004",
    "reviewer": "flow374-pr814-review",
    "severity": "minor",
    "problem": "A typed /settings during a turn is deferred, while the sidebar click opened the modal mid-turn and its buttons ran commands that are deferred when typed.",
    "impact": "Two entry points to the same screen followed different busy rules.",
    "suggested_fix": "Keep /settings deferred while busy and refuse the sidebar click with a short message.",
    "evidence": "Read src/tui/busy-dispatch.ts (no settings target) and the sidebar click in src/tui/tui-shell.ts. Fixed in f240da30 (settingsOpenDecision) with a test pinning the deferral.",
    "confidence": "high",
    "file": "src/tui/tui-shell.ts",
    "line": 4063,
    "quote": "      onMouseDown: () => {"
  },
  {
    "id": "F-005",
    "reviewer": "flow374-pr814-review",
    "severity": "minor",
    "problem": "A rejection from runExternalAgentsCommand, or a synchronous throw from a settings handler, was dropped silently.",
    "impact": "A failed button press showed no message and the rows did not rebuild.",
    "suggested_fix": "Catch in the action runner and report through the same system-message path; report run and load failures from the modal.",
    "evidence": "Read src/tui/settings-modal.ts (await options.run, options.load) and runSettingsAction in src/tui/tui-shell.ts. Fixed in f240da30 (onError, runSettingsCommand) with tests at both layers.",
    "confidence": "high",
    "file": "src/tui/settings-modal.ts",
    "line": 189,
    "quote": "      await options.run(action.command);"
  },
  {
    "id": "F-006",
    "reviewer": "flow374-pr814-review",
    "severity": "minor",
    "problem": "runSettingsAction was private to the shell and the modal tests used a fake run, so the /mode auto bypass of the composer dialog, the /external project-override path, the no-disk-write claim for mode and plan, and the readline /settings branch had no tests.",
    "impact": "The riskiest behaviours of the modal were asserted only by reading the code.",
    "suggested_fix": "Extract the action runner into a testable module and add tests for each path plus the readline table.",
    "evidence": "Read src/tui/settings-modal.test.ts and src/commands/shell-agent-repl.test.ts at c926382d. Fixed in f240da30: src/tui/settings-actions.ts with settings-actions.test.ts and readline cases.",
    "confidence": "high",
    "file": "src/tui/settings-modal.test.ts",
    "line": 1,
    "quote": "settings"
  }
]
```
