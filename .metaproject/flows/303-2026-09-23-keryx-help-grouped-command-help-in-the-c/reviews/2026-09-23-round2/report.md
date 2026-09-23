# Review — flow 303 round 2, keryx help: grouped command help in the CLI and a tabbed /help modal in the TUI (PR #669)

Round 2 re-reviewed the round-1 fixes (commit `481eafbe98598401705c4a150b712037ca5a49bf`), focused
on `src/tui/help-first-run.ts` and `src/tui/tui-shell.ts`'s first-run wiring. It raised two
findings, both about the background first-run task's failure handling, neither caught by round 1's
own tests because both require a probe or marker failure to manifest. Both were acted on in commit
`6882b1ce82af478f7230019e4ce5e3ec6c398ddb` ("fix(help): the first-run help can neither crash the
shell nor open on a closed one"), the PR's final head, part of PR #669, squash-merged to `main` as
`0b4f4d64b61519486ab8c63e53c30ee572c251c2`.

```keryx:findings
[
  {
    "id": "F-101",
    "reviewer": "code-reviewer (flow 303 PR #669 round 2)",
    "severity": "major",
    "file": "src/tui/help-first-run.ts",
    "quote": "opts.mark()",
    "problem": "Round 1's fix made resolveFirstRunHelp call opts.mark() unconditionally after the probe, but neither opts.probe() nor opts.mark() was wrapped: a probe that threw (e.g. a filesystem or network error while checking connected providers) or a mark that threw (a marker file that could not be written — read-only home, full disk) propagated out of resolveFirstRunHelp as an unhandled rejection, since the call site in tui-shell.ts fires it in the background without a .catch.",
    "impact": "A first-run help check that could not complete — for reasons entirely unrelated to the user's actual work — crashed the whole shell process via an unhandled promise rejection, turning a courtesy onboarding feature into a hard failure mode.",
    "suggested_fix": "Wrap the probe call and the mark call each in their own try/catch: a failed probe opens and marks nothing (next launch asks again); a failed mark is silently ignored (the worst case is one extra probe on the next launch).",
    "evidence": "resolveFirstRunHelp's body called `await opts.probe()` and `opts.mark()` with no try/catch around either, and the caller in tui-shell.ts attached only a `.then()`, no `.catch()`.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/tui/help-first-run.ts resolveFirstRunHelp (probe call, mark call)"],
      "enumeration_method": "resolveFirstRunHelp has exactly one probe call and one mark call, both unguarded before this finding; the class has two sites, one function."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/tui/help-first-run.ts:89-105 (commit 6882b1ce): `opts.probe()` wrapped in try/catch returning `undefined` (opens/marks nothing) on failure; `opts.mark()` wrapped in its own try/catch that swallows the error (comment: 'must not take the shell down; the worst case is that the next launch probes once more'). src/tui/help-first-run.test.ts gained coverage for both failure paths per commit 6882b1ce's diff (+30 lines). bun test src/tui/help-first-run.test.ts: passes (part of the 202-test aggregate run against 6882b1ce). Fixing commit 6882b1ce82af478f7230019e4ce5e3ec6c398ddb, PR #669, merged to main in 0b4f4d64b61519486ab8c63e53c30ee572c251c2.",
      "verifier": "flow-close verifier (flow 303 completion pass)"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "probe() and mark() each wrapped in their own try/catch in resolveFirstRunHelp; commit 6882b1ce82af478f7230019e4ce5e3ec6c398ddb, PR #669, merged to main as 0b4f4d64b61519486ab8c63e53c30ee572c251c2."
    }
  },
  {
    "id": "F-102",
    "reviewer": "code-reviewer (flow 303 PR #669 round 2)",
    "severity": "major",
    "file": "src/tui/tui-shell.ts",
    "quote": "openHelp(tab)",
    "problem": "The first-run probe runs in the background and can outlive the shell (the user quits before it resolves). Its .then() callback called openHelp(tab) unconditionally when a tab was returned, with no check that the renderer/shell was still alive — opening a modal on a torn-down renderer.",
    "impact": "A user who quit keryx shell quickly after the first-run probe started could trigger a modal-open call against a destroyed renderer, which is exactly the shape of bug that produces a confusing crash or a silent no-op depending on what OpenTUI does with a call on a torn-down instance — undefined behaviour either way.",
    "suggested_fix": "Guard the openHelp call with the shell's own `!destroyed` flag, and add a .catch on the whole chain so a probe/mark failure (F-101) cannot surface as an unhandled rejection either.",
    "evidence": "The `.then((tab) => { if (tab !== undefined) { openHelp(tab); } })` chain had no liveness check and no `.catch`.",
    "confidence": "high",
    "class_scope": {
      "sites": ["src/tui/tui-shell.ts launchTuiAgentShell first-run .then() callback"],
      "enumeration_method": "The first-run resolveFirstRunHelp() call has exactly one .then() chain attached to it in launchTuiAgentShell; the class has one member."
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "src/tui/tui-shell.ts:4589-4602 (commit 6882b1ce): the `.then((tab) => {...})` callback now reads `if (tab !== undefined && !destroyed) { openHelp(tab); }` with the comment 'The probe can outlive the shell: never open a modal on a renderer the user already closed', and a `.catch((error: unknown) => { debugEvent('help.first-run-failed', ...); })` is chained after it so nothing here can end the shell as an unhandled rejection. bun test src/tui/tui-shell.test.ts: 156 pass, 0 fail (re-run against 6882b1ce). Fixing commit 6882b1ce82af478f7230019e4ce5e3ec6c398ddb, PR #669, merged to main in 0b4f4d64b61519486ab8c63e53c30ee572c251c2.",
      "verifier": "flow-close verifier (flow 303 completion pass)"
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "openHelp guarded by `!destroyed`, and `.catch` added to the first-run promise chain, logging via debugEvent instead of throwing; commit 6882b1ce82af478f7230019e4ce5e3ec6c398ddb, PR #669, merged to main as 0b4f4d64b61519486ab8c63e53c30ee572c251c2."
    }
  }
]
```

## Coverage

Reviewed: `src/tui/help-first-run.ts` and `src/tui/tui-shell.ts`'s first-run background-task
wiring, specifically the failure and lifecycle handling round 1's fix left unaddressed. Not
reviewed: the rest of the flow 303 diff, already covered by round 1.

## Outcome

Two findings (both high), both about the background first-run task's failure/lifecycle handling,
acted on in commit `6882b1ce82af478f7230019e4ce5e3ec6c398ddb` — the PR's final head. Re-verified
against that same commit (tree-identical to the squash-merge commit
`0b4f4d64b61519486ab8c63e53c30ee572c251c2`). None dismissed as wont-fix or out of scope. No
further defects found in this pass.
