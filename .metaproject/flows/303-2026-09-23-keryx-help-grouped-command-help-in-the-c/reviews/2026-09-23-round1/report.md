# Review — flow 303 round 1, keryx help: grouped command help in the CLI and a tabbed /help modal in the TUI (PR #669)

Round 1 ran over the flow 303 diff after T1-T6: `src/standard/help-groups.ts`,
`src/commands/help.ts`, `src/tui/help-modal.ts`, `src/tui/help-first-run.ts`,
`src/tui/modal-host.ts`, `src/tui/tui-shell.ts`, `src/commands/shell.ts`, `src/acp/commands.ts`,
`src/cli.ts`, and the generated `docs/docs/commands-by-task.md`. It raised two HIGH, one MEDIUM
and four LOW findings. All seven were acted on in commit `481eafbe98598401705c4a150b712037ca5a49bf`
("fix(help): the first-run probe runs once, and a failed start leaves no spinner behind"), part of
PR #669, squash-merged to `main` as `0b4f4d64b61519486ab8c63e53c30ee572c251c2`.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "code-reviewer (flow 303 PR #669 round 1)",
    "severity": "major",
    "file": "src/tui/help-first-run.ts",
    "quote": "shouldOpenFirstRunHelp",
    "problem": "The first-run help marker was only ever written on the branch that opened the modal (a user with no provider connected). A user whose provider was already configured on their first `keryx shell` run never had the marker set, so `shouldOpenFirstRunHelp`'s probe re-ran on every subsequent launch forever.",
    "impact": "An already-connected user paid the network probe cost (detecting connected providers) on every single shell launch indefinitely, with no way to make it stop short of the marker file existing, which nothing on that path ever wrote.",
    "suggested_fix": "Fold the decision, the probe and the marker write into one function that always marks the first run as shown once it has decided, whichever branch it takes.",
    "evidence": "The pre-fix call site awaited the probe and only called `markHelpFirstRunShown()` inside the `if (tab !== undefined)` branch that opened the modal.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/tui/help-first-run.ts resolveFirstRunHelp", "src/tui/tui-shell.ts launchTuiAgentShell first-run call site"],
      "enumeration_method": "The first-run marker has exactly one writer (markHelpFirstRunShown) and exactly one call site that could reach it (the first-run branch in launchTuiAgentShell); before the fix that call site only reached the writer through the opens-modal path — the class has one member."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "resolveFirstRunHelp(opts: {shown, probe, mark}) in src/tui/help-first-run.ts now calls opts.mark() unconditionally after the probe resolves, before deciding which tab (or none) to open, per the comment '// ALWAYS, on every first run — connected or not'. src/tui/help-first-run.test.ts covers all three named cases (already-shown, connected, not-connected) plus a structural pin that the call site in tui-shell.ts is never awaited inline. bun test src/tui/help-first-run.test.ts: 26 pass, 0 fail (re-run against 6882b1ce). Fixing commit 481eafbe98598401705c4a150b712037ca5a49bf, part of PR #669, merged to main in 0b4f4d64b61519486ab8c63e53c30ee572c251c2.",
      "verifier": "flow-close verifier (flow 303 completion pass)"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "resolveFirstRunHelp folds decision+probe+mark into one function, mark() called unconditionally; commit 481eafbe98598401705c4a150b712037ca5a49bf, PR #669, merged to main as 0b4f4d64b61519486ab8c63e53c30ee572c251c2."
    }
  },
  {
    "id": "F-002",
    "reviewer": "code-reviewer (flow 303 PR #669 round 1)",
    "severity": "major",
    "file": "src/tui/tui-shell.ts",
    "quote": "mountStartupIndicator",
    "problem": "The never-blank startup indicator (AC14) was removed only on the success path after `opts.makeAgentDeps` and `createShellChrome` both resolved. If either threw, the indicator's setInterval kept firing and the spinner box stayed mounted on screen while the error propagated — a leaked timer and a stuck spinner on every startup failure.",
    "impact": "A startup error (a bad MCP server config, a provider that fails to initialize) left a spinning indicator on screen forever and a live timer keeping the process from exiting cleanly, turning a clean failure into a hang.",
    "suggested_fix": "Wrap the makeAgentDeps/createShellChrome region in try/finally so the indicator is always removed, whichever path is taken.",
    "evidence": "Pre-fix, `startupIndicator.remove()` was called only after both awaits succeeded, with no cleanup on the throw path.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/tui/tui-shell.ts launchTuiAgentShell startup indicator region"],
      "enumeration_method": "mountStartupIndicator has exactly one call site and its .remove() had exactly one call site before the fix, both in the same function — the class has one member."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/tui/tui-shell.ts:3394-3424: `deps`/`chrome` declared outside a try block, assigned inside it, with `startupIndicator.remove()` in the matching finally, comment 'must come down even if either await below throws'. src/tui/boot-animation.test.ts has a reject test proving the indicator is removed when the wrapped operation throws. bun test src/tui/boot-animation.test.ts src/tui/tui-shell.test.ts: 156+ pass (tui-shell.test.ts alone: 156 pass, 0 fail), re-run against 6882b1ce. Fixing commit 481eafbe98598401705c4a150b712037ca5a49bf, part of PR #669, merged to main in 0b4f4d64b61519486ab8c63e53c30ee572c251c2.",
      "verifier": "flow-close verifier (flow 303 completion pass)"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "try/finally wrap around makeAgentDeps/createShellChrome with startupIndicator.remove() in finally; commit 481eafbe98598401705c4a150b712037ca5a49bf, PR #669, merged to main as 0b4f4d64b61519486ab8c63e53c30ee572c251c2."
    }
  },
  {
    "id": "F-003",
    "reviewer": "code-reviewer (flow 303 PR #669 round 1)",
    "severity": "minor",
    "file": "src/cli.test.ts",
    "quote": "flat usage block",
    "problem": "AC5 required `keryx --help`/`-h`/bare `keryx` and the four rich group helps to print exactly what they printed before this flow, but moving `help` into its own `CLI_ROUTES` entry changed the flat usage block's own text (it now names `keryx help`), so the AC as originally worded was already violated by an intended change.",
    "impact": "A test written to the original wording would either falsely fail on an intended, desirable change (the new help pointer) or be written loosely enough to miss an unintended regression elsewhere in the same block.",
    "suggested_fix": "Amend AC5 to describe the flat block as pre-flow text plus exactly the lines that name the new `keryx help` verb, and pin against real fixtures captured by running the CLI at the pre-flow commit.",
    "evidence": "The flat `--help` output diff showed two new lines naming `keryx help` inside an otherwise-unchanged block, with no fixture capturing the pre-flow baseline to diff against.",
    "confidence": "medium",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "AC5 amended via `keryx flow ac update 303 --criterion AC5 ...` (journal: 'ac-updated: AC5' at 2026-09-23T13:45:06Z). fixtures/cli-help-pre-flow-303/{flat-help,flow-help,governance-help,serve-mcp-help,trigger-help}.txt captured by running src/cli.ts at commit 0d6ac030. src/cli.test.ts's new describe pins the current flat block == pre-flow fixture + exactly the 2 new keryx-help lines, and each rich help byte-identical to its pre-flow fixture. bun test src/cli.test.ts: passes (re-run against 6882b1ce, part of the 202-test run across all touched files: 202 pass, 0 fail). Fixing commit 481eafbe98598401705c4a150b712037ca5a49bf, part of PR #669, merged to main in 0b4f4d64b61519486ab8c63e53c30ee572c251c2.",
      "verifier": "flow-close verifier (flow 303 completion pass)"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "AC5 text amended, pre-flow fixtures captured and pinned against in src/cli.test.ts; commit 481eafbe98598401705c4a150b712037ca5a49bf, PR #669, merged to main as 0b4f4d64b61519486ab8c63e53c30ee572c251c2."
    }
  },
  {
    "id": "F-004",
    "reviewer": "code-reviewer (flow 303 PR #669 round 1)",
    "severity": "minor",
    "file": "src/tui/tui-shell.ts",
    "quote": "busy",
    "problem": "`/help` typed while a main turn was busy showed a plain busy notice instead of opening the modal, unlike every other read-only slash command.",
    "impact": "A user asking for help mid-turn — arguably the moment they most need it — got a generic 'busy' message instead of the grouped command reference.",
    "suggested_fix": "Let `/help` open the modal regardless of turn state, since reading help does not touch the busy turn.",
    "evidence": "The busy-dispatch table routed `/help` through the same busy-notice path as mutating commands.",
    "confidence": "medium",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/tui/busy-dispatch.test.ts covers `/help` opening the modal during a busy turn. bun test src/tui/busy-dispatch.test.ts: passes (part of the 202-test aggregate run, re-checked against 6882b1ce). Fixing commit 481eafbe98598401705c4a150b712037ca5a49bf, part of PR #669, merged to main in 0b4f4d64b61519486ab8c63e53c30ee572c251c2.",
      "verifier": "flow-close verifier (flow 303 completion pass)"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "`/help` now opens the modal during a busy turn; commit 481eafbe98598401705c4a150b712037ca5a49bf, PR #669, merged to main as 0b4f4d64b61519486ab8c63e53c30ee572c251c2."
    }
  },
  {
    "id": "F-005",
    "reviewer": "code-reviewer (flow 303 PR #669 round 1)",
    "severity": "minor",
    "file": "src/tui/modal-host.ts",
    "quote": "recolour",
    "problem": "A `/theme` switch while a modal was open recoloured only the modal's chrome (backdrop, frame), not its body content, leaving the help modal's command list in the old theme's colours until it was closed and reopened.",
    "impact": "A visible, if cosmetic, inconsistency: half the modal following the new theme and half not, specifically noticeable in the help modal's long grouped command list.",
    "suggested_fix": "Replay the body's own render on a theme_mode change, not only the chrome's.",
    "evidence": "modal-host.ts's theme_mode handler updated chrome styling but never called back into the body renderer.",
    "confidence": "medium",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/tui/modal-host.ts around line 587-595: comment 'this used to recolour only the CHROME ... so replaying it repaints the body in the new theme without' — the theme_mode handler now replays the body render. src/tui/modal-host.test.ts covers this. bun test src/tui/modal-host.test.ts: passes (part of the 202-test aggregate run, re-checked against 6882b1ce). Fixing commit 481eafbe98598401705c4a150b712037ca5a49bf, part of PR #669, merged to main in 0b4f4d64b61519486ab8c63e53c30ee572c251c2.",
      "verifier": "flow-close verifier (flow 303 completion pass)"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "theme_mode handler now replays the body render, not only chrome styling; commit 481eafbe98598401705c4a150b712037ca5a49bf, PR #669, merged to main as 0b4f4d64b61519486ab8c63e53c30ee572c251c2."
    }
  },
  {
    "id": "F-006",
    "reviewer": "code-reviewer (flow 303 PR #669 round 1)",
    "severity": "minor",
    "file": "src/acp/commands.ts",
    "quote": "Other",
    "problem": "An ACP slash command with no `HELP_GROUPS` entry fell into a synthetic 'Other' bucket that the render loop never visits, so it silently vanished from `/help` output instead of failing loudly.",
    "impact": "A future ACP command added to `ACP_SLASH_COMMANDS` without a matching `HELP_GROUPS` entry would disappear from help with no error and no test catching it.",
    "suggested_fix": "Throw, naming the command, when a command has no HELP_GROUPS entry, so the build fails instead of the command silently disappearing.",
    "evidence": "`acpCommandHelpText`'s grouping loop dropped any command whose `findSlashEntry` lookup returned undefined into a bucket `HELP_GROUP_ORDER` never iterates.",
    "confidence": "medium",
    "class_scope": {
      "sites": ["src/acp/commands.ts acpCommandHelpText"],
      "enumeration_method": "acpCommandHelpText is the sole ACP help-grouping function; its single grouping loop is the only place a command can be silently dropped — the class has one member."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/acp/commands.ts:175-193: acpCommandHelpText now throws an Error naming the command's /name when `findSlashEntry` returns undefined ('has no HELP_GROUPS entry ... add it to src/standard/help-groups.ts so it has a real group instead of silently vanishing from /help'). src/commands/help-grouped.test.ts covers all three surfaces (CLI, TUI modal, ACP) plus this throw for a synthetic unclassified command. bun test src/commands/help-grouped.test.ts src/acp/commands.test.ts: passes (part of the 202-test aggregate run, re-checked against 6882b1ce). Fixing commit 481eafbe98598401705c4a150b712037ca5a49bf, part of PR #669, merged to main in 0b4f4d64b61519486ab8c63e53c30ee572c251c2.",
      "verifier": "flow-close verifier (flow 303 completion pass)"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "acpCommandHelpText throws by name instead of dropping into an unrendered bucket; commit 481eafbe98598401705c4a150b712037ca5a49bf, PR #669, merged to main as 0b4f4d64b61519486ab8c63e53c30ee572c251c2."
    }
  },
  {
    "id": "F-007",
    "reviewer": "code-reviewer (flow 303 PR #669 round 1)",
    "severity": "minor",
    "file": "src/tui/help-modal.test.ts",
    "quote": "keypress-driven test",
    "problem": "AC6 requires a keypress-driven test proving tab switching, up/down movement, Enter detail toggle and Esc close, but the initial test pass had gaps: no narrow-terminal (40-column) case and no case for the modal receiving input while another element (e.g. a dialog) owns keyboard focus.",
    "impact": "AC6's behavioural guarantee was under-tested at the edges most likely to regress silently: a narrow terminal wrapping differently, and an input-blocked state the modal must not intercept keys during.",
    "suggested_fix": "Add a narrow-terminal (40-column) rendering case and an inputBlocked/keyboardOwnedElsewhere case to help-modal.test.ts.",
    "evidence": "help-modal.test.ts's original suite covered the happy-path key sequence but had no narrow-width or focus-ownership case.",
    "confidence": "low",
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/tui/help-modal.test.ts gained a narrow-terminal (40 cols) case and an inputBlocked/keyboardOwnedElsewhere case (per journal 'ac-confirmed: AC6' at 2026-09-23T14:13:04Z: 'new narrow-terminal (40 cols) and inputBlocked/keyboardOwnedElsewhere cases added post-review'). bun test src/tui/help-modal.test.ts: passes (part of the 202-test aggregate run, re-checked against 6882b1ce). Fixing commit 481eafbe98598401705c4a150b712037ca5a49bf, part of PR #669, merged to main in 0b4f4d64b61519486ab8c63e53c30ee572c251c2.",
      "verifier": "flow-close verifier (flow 303 completion pass)"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "narrow-terminal and inputBlocked/keyboardOwnedElsewhere test cases added to help-modal.test.ts; commit 481eafbe98598401705c4a150b712037ca5a49bf, PR #669, merged to main as 0b4f4d64b61519486ab8c63e53c30ee572c251c2."
    }
  }
]
```

## Coverage

Reviewed: `src/standard/help-groups.ts` (and its test), `src/commands/help.ts`,
`src/tui/help-modal.ts`, `src/tui/help-first-run.ts`, `src/tui/modal-host.ts`,
`src/tui/tui-shell.ts` (first-run wiring, startup indicator), `src/commands/shell.ts`
(plain-terminal starting line), `src/acp/commands.ts`, `src/cli.ts`/`src/cli.test.ts`, and the
generated `docs/docs/commands-by-task.md`. Not reviewed: unrelated modules outside this flow's
diff.

## Outcome

Seven findings (two high, one medium, four low), all acted on in commit
`481eafbe98598401705c4a150b712037ca5a49bf` (part of PR #669) and re-verified against the code at
the PR's final head `6882b1ce82af478f7230019e4ce5e3ec6c398ddb` (tree-identical to the squash-merge
commit `0b4f4d64b61519486ab8c63e53c30ee572c251c2`). None dismissed as wont-fix or out of scope.
