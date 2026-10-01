**Changes requested — 1 Blocker, 7 Major, 5 Minor, 2 info.** Reviewed `c9f31fd9` against `ec701224` (round 1, PR #821, flow 364). The extraction of the completion gates is sound. `complete()` keeps its gate order, attempt records, signature head commit and token spending. `checkComplete` writes nothing. The risk is in delivery and the modal. The CLI command AC4 names is refused by the router. The typed close confirmation cannot be entered for ids containing 1 or 2. The close offer can be stale against live flow state. Several frozen AC8 behaviours are not pinned by any test that can fail.

### Blocker
**L-006. `keryx flow check-complete` is refused by the CLI router (AC4 not delivered).** `src/lib/group-subcommands.ts`, in the diff (the missing entry).
The `flow` entry of GROUP_SUBCOMMANDS has no `check-complete`, so `bun src/cli.ts flow check-complete 364 --json` exits 1 with `Unknown command: check-complete`. This holds even though `flow --help` and `keryx commands --json` advertise the command. The existing guard test `src/lib/group-subcommands-flow.test.ts` fails on this branch; the PR's local run did not include `src/lib`.
Fix: add `"check-complete"` next to `"complete"`, and add a routing assertion.

### Major
**L-001. The typed close confirmation cannot be entered for any flow id containing 1 or 2.** `src/tui/governance-inspector.ts`, in the diff.
modal-host reads the digits as tab jumps (the tab strip has focus and there are two tabs) and stops propagation. Flow 312 never closes: `2` switches to the Report tab and Enter cancels. Left, right and Tab also hide a pending confirmation instead of cancelling it. Both the author's probe and the verifier's own probe confirm this.

**L-002. A prose, numbered or empty `## Outcome criteria` section renders as `not stated (only the template hint)`.** `src/governance/flow-narrative.ts`, in the diff.
`outcomeBulletsFrom` reads only `-` and `*` bullets, and every empty result is labelled `hint-only`. A stated effect is reported as absent, with a false reason. The verifier's probe confirms this.

**L-003. The close offer's staleness test uses the stored report's `updatedAt`, not live flow state.** `src/tui/governance-flows.ts`, in the diff.
Suppose the flow changes on disk after `c` passes and the report is not re-run. `d` plus the typed id still runs `flow complete`. The probe saw `calls == [check 364, close 364]`. complete() re-gates, so the harm is a failed attempt that demotes the flow to in-progress, not a wrong completion.

**T-001. The AC8 test "blocked keypress does not close" passes vacuously.** `src/tui/governance-inspector.test.ts`.
No test is blocked while a confirmation is open. If the guard is moved below the `confirming` dispatch, the suite stays green.

**T-002. AC6 "any other key cancels" is not pinned.** `src/tui/governance-inspector.ts`.
Deleting the fall-through cancel in `confirmKey` keeps the suite green.

**T-003. The status-transition term is unpinned in both `checkComplete.passed` and `closeOffer`.** `src/tui/governance-flows.ts`, `src/flow/service.ts`.
Dropping both terms keeps 137 tests green.

**T-004. The merge-state mapping's direct-merge and tracker-throws arms have no test.** `src/flow/service.ts`.
This is a named AC8 sub-item. Forcing either arm to `merged` keeps the suite green.

### Minor
- **A-001. checkComplete re-encodes complete()'s admission rule by hand.** `src/flow/service.ts`. A change to `machine.ts` TRANSITIONS would make the check drift silently.
- **A-002. completionFixHint regex-parses the human-readable `gate.detail`.** `src/flow/service.ts`. Rewording a gate detail would silently drop the fix hints.
- **A-003. `flow check-complete --json` emits no JSON on error paths.** `src/commands/flow.ts`. Exit 1 there is the same code as `passed: false`.
- **T-005. The clickable action row (AC5) and its guard are untested.** `src/tui/governance-inspector.ts`.
- **T-006. `c` on a done flow is not tested to do nothing.** `src/tui/governance-inspector.ts`.

### Questions
1. **L-005.** AC6's "or the flow records a merged commit" cannot occur from the modal: `flow.merged` is only written by a passing complete(). Should a direct-merge flow show "close from the terminal with --merged"?
2. **T-007.** Stored-report compatibility is pinned only at the render layer, not through `readLatestGovernanceReport`. Is a fixture-based test wanted?

### Verified clean
- complete() is unchanged by the extraction. review-logic and review-regression compared it line by line with merge-base: gate order, catch arms, `unevaluableGate` names, `evaluatedHeadCommit`, token consumed only on the passing path, lock, transition, attempt record and `returnToInProgress` all match.
- checkComplete writes nothing. Every callee was traced: confirmationGate uses `checkConfirmationToken` only, there is no lock or save, and the review, health and security gates only read. Mutation 13 (forcing a write) turns check-complete.test.ts red.
- Checks are keyed by flow id. A check for flow A is never offered for flow B, and the confirmation captures its id at `d`.
- `inputBlocked()` gates every governance keypress and the action-row click.
- `outcomeBulletsFrom` matches the removed product/extract.ts loop character for character, so product output is unchanged.
- Scope B (40 blast-radius files) found no regressions. `tsc --noEmit` is clean.

### How this review was run
- **Workflow:** `review-orchestrator`, managed (attached to flow 364)
- **Scope:** `ec701224..c9f31fd9`, round 1, PR #821; scope A from `keryx review scope --json`, scope B from `keryx review blast-radius --json` (40 of 349 candidates; 309 cut by the cap; 17 changed files not in the graph, radius unknown)
- **Models:** `keryx review tier` returned standard/inherit; every reviewer ran on the session model (Claude Opus 5.5); model assignment adaptive
- **Tools:** keryx review comments collect/scope/blast-radius/reviewers/tier, keryx memory search, keryx ctx rg/run/diff, gh pr view, bun test (targeted), tsc
- **Skills:** review-orchestrator
- **Subagents:** review-logic, review-architecture, review-testing-practices, review-regression (scope B), review-verifier (Wave C)
- **Not run:** Jev CLI-engine reviewers, because there is no `.metaproject/tasks.config.json` and so no opt-in. Also not run: review-security-code, review-frontend/frontend-conventions (stack has no React/MobX), and review-style.
- **External comments:** collected at `c9f31fd9`: 0 comments
- **CI:** no checks reported on the PR at review time; ci-triage was not run (not opted in)
- **Merged duplicates:** L-004 was merged into T-001 and T-007, and T-008 into L-005.
- **Verification:** annotate; confirmed 15, refuted 0, unverifiable 0, unverified 0

## Skill Learning
- none

```json keryx:findings
[
  {
    "id": "L-006",
    "severity": "blocker",
    "file": "src/lib/group-subcommands.ts",
    "quote": "      \"implemented\",\n      \"complete\",\n      \"confirm\",",
    "problem": "`keryx flow check-complete` is refused by the CLI router: commands/flow.ts adds `case \"check-complete\"`, and printHelp, cli.test.ts and command-registry.ts advertise it, but the `flow` entry of GROUP_SUBCOMMANDS in src/lib/group-subcommands.ts was not updated, and cli-registry.ts refuses any flow subcommand missing from it. The handler is reachable only by calling flowCommand directly, which is what the PR's tests do.",
    "impact": "Trigger: a user or agent runs `keryx flow check-complete 364 --json` as AC4, `keryx flow --help` and `keryx commands --json` instruct. Outcome: exit 1 with `Unknown command: check-complete. Run \\`keryx flow --help\\` for the list.` and no check runs. The AC4 CLI surface is not delivered. The existing guard test src/lib/group-subcommands-flow.test.ts fails on this branch.",
    "suggested_fix": "Add \"check-complete\" to the `flow` entry of GROUP_SUBCOMMANDS next to \"complete\", and add an end-to-end routing assertion (e.g. `flow check-complete 001 --json` never prints `Unknown command`).",
    "evidence": "From the root at HEAD c9f31fd9: `bun src/cli.ts flow check-complete 364 --json` and without --json both exit 1 with stderr `Unknown command: check-complete`. `bun src/cli.ts flow --help` lists the usage line; `bun src/cli.ts commands --json --module tasks` lists `flow check-complete` json:true read:true. `bun test --timeout 30000 src/lib/group-subcommands-flow.test.ts` -> 1 pass 1 fail ('every subcommand commands/flow.ts dispatches is listed for the router', received [\"check-complete\"]). PR's local runs did not include src/lib.",
    "confidence": "high",
    "reviewer": "review-logic",
    "class_scope": {
      "sites": [
        "src/lib/group-subcommands.ts GROUP_SUBCOMMANDS flow entry (missing check-complete)",
        "src/cli-registry.ts `return GROUP_SUBCOMMANDS.get(command);` (router that refuses)",
        "src/commands/flow.ts `case \"check-complete\":` (dispatch present)",
        "src/commands/flow.ts printHelp check-complete usage line",
        "src/standard/command-registry.ts `flow check-complete` descriptor",
        "src/cli.test.ts help pin for check-complete (no routing assertion)"
      ],
      "enumeration_method": "keryx ctx rg --all \"GROUP_SUBCOMMANDS|groupSubcommands|Unknown command:\" src: the only router consumer is cli-registry.ts and the only definition is src/lib/group-subcommands.ts; cross-checked every advertisement site the diff adds; confirmed with the real CLI entry and the existing guard test."
    }
  },
  {
    "id": "L-001",
    "severity": "major",
    "file": "src/tui/governance-inspector.ts",
    "quote": "if (/^[0-9]$/.test(sequence) && confirming.typed.length < confirming.id.length) {",
    "problem": "The typed close confirmation cannot be entered for any flow id containing the digit 1 or 2. modal-host registers its keypress handler (ensureHost) before openGovernanceReport registers its own; with focus on the tab strip (inBody false) and two tabs, modal-host treats '1'/'2' as tab jumps, calls mountTab + stopPropagation, and the governance handler never sees the digit. Left/right/Tab are taken the same way, so a pending confirmation survives a tab switch invisibly on the Report tab instead of being cancelled.",
    "impact": "Trigger: select flow 312 (any id with a 1 or 2, e.g. every id 100-299), press c (check passes, PR merged), press d, type 3 1 2, Enter. Outcome: '1' is swallowed, '2' switches to the Report tab, buffer stays '3', Enter compares '3' with '312' and cancels; flow complete never runs. Close from the modal is impossible for those ids. The shipped test uses id 364 only.",
    "suggested_fix": "While `confirming` is set, keep digits (and left/right/tab) away from modal-host: focus a renderable inside the modal body so inBody is true, or give OpenModalInput a way to claim digits like onArrowKeys claims arrows. Make a tab switch cancel or be refused during a confirmation. Add a test confirming a flow whose id contains 1 and 2.",
    "evidence": "Probe test /private/tmp/claude-502/-Users-operator-aleksandr-goodea-keryx/6d936496-d76c-4d37-8e47-d165d9e389d6/scratchpad/digit-probe.test.ts against the real modal (mountChrome + keypressSource, flow id '312', fake actions, passing merged check): after '1' buffer '3' tab flows; after '2' buffer '3' tab report; after Enter calls == [\"check 312\"]. Traced modal-host.ts digit-jump branch `if (inBody || state.tabs.length < 2) return;` then mountTab + stopPropagation; openModal focuses the tab strip.",
    "confidence": "high",
    "reviewer": "review-logic",
    "class_scope": {
      "sites": [
        "src/tui/governance-inspector.ts confirmKey digit branch",
        "src/tui/modal-host.ts digit tab-jump branch",
        "src/tui/modal-host.ts left/right/tab switch branches"
      ],
      "enumeration_method": "Read every early-return/stopPropagation branch in modal-host's keypress handler (escape, x, left/right claim, tab switch, digit jump) and checked which can fire while governance `confirming` is set; probe-confirmed '1' and '2'."
    }
  },
  {
    "id": "L-002",
    "severity": "major",
    "file": "src/governance/flow-narrative.ts",
    "quote": "if (first === undefined) return { stated: false, reason: \"hint-only\" };",
    "problem": "outcomeBulletsFrom recognises only '-'/'*' bullets, so an Outcome criteria section written as prose, as a numbered list, or left empty yields []; summarizeEffect maps every [] to reason 'hint-only' even when the OUTCOME_HINT line is absent. AC1 defines effect as the first usable statement, with only the untouched hint counting as none.",
    "impact": "Trigger: description.md with `## Outcome criteria` followed by a prose sentence, a `1.` item, or nothing. Outcome: governance markdown and the modal print `effect: not stated (only the template hint)` — a stated effect reported as absent, with a false reason.",
    "suggested_fix": "Distinguish 'hint present' from 'no bullets': fall back to the first non-hint prose line (and accept numbered items), or at minimum return a distinct reason (`no-bullets`/`empty`) and use `hint-only` only when OUTCOME_HINT was actually present.",
    "evidence": "Probe /private/tmp/claude-502/-Users-operator-aleksandr-goodea-keryx/6d936496-d76c-4d37-8e47-d165d9e389d6/scratchpad/effect-probe.test.ts: prose, empty section and numbered item all returned {stated:false, reason:'hint-only'} and rendered 'effect: not stated (only the template hint)'.",
    "confidence": "high",
    "reviewer": "review-logic",
    "class_scope": {
      "sites": [
        "src/governance/flow-narrative.ts summarizeEffect hint-only arm",
        "src/flow/description-intent.ts outcomeBulletsFrom"
      ],
      "enumeration_method": "Traced every caller of outcomeBulletsFrom (summarizeEffect, product/extract.ts outcomeCriterionFrom); only summarizeEffect attaches a reason, extract.ts returns null as before the PR."
    }
  },
  {
    "id": "L-003",
    "severity": "major",
    "file": "src/tui/governance-flows.ts",
    "quote": "if (check.updatedAt < flow.updatedAt) return { kind: \"none\", reason: \"the flow changed since the check — press c again\" };",
    "problem": "The close offer's staleness test compares the check with the stored report's FlowGovernance.updatedAt, which only refreshes on `r` or after a close; confirmKey's Enter does not re-evaluate the offer. A flow.json change made after the check (another session runs `flow ac update`, reopens a task) is invisible, so close stays offered.",
    "impact": "Trigger: c passes; another terminal mutates the flow so a gate now fails; no report re-run; d + typed id + Enter. Outcome: close runs although AC6 says it must not be offered; the real flow complete fails its gates, records a failed completionAttempt and moves an implemented flow back to in-progress. Nothing completes wrongly (complete re-gates).",
    "suggested_fix": "At beginClose and again at Enter in confirmKey, read the live flow.json updatedAt (or re-run checkComplete) and withdraw the offer if it is newer than check.updatedAt.",
    "evidence": "Read closeOffer, offerFor, beginClose, confirmKey and reload in governance-inspector.ts: the checks Map persists across reloads and nothing reads live flow state between check and close. Not run end to end.",
    "confidence": "medium",
    "reviewer": "review-logic",
    "class_scope": {
      "sites": [
        "src/tui/governance-flows.ts closeOffer staleness comparison",
        "src/tui/governance-inspector.ts confirmKey Enter branch"
      ],
      "enumeration_method": "Enumerated every path from an offer to flowActions().close: action-row onMouseDown -> beginClose, key d -> beginClose, Enter in confirmKey -> runClose; only beginClose consults offerFor, and only against the stored report."
    }
  },
  {
    "id": "T-001",
    "severity": "major",
    "file": "src/tui/governance-inspector.test.ts",
    "quote": "let blocked = true;",
    "problem": "AC8 'a keypress while inputBlocked() is true neither checks nor closes': the 'closes' half passes vacuously. The blocked phase uses a non-merged fake and presses d before any check, so no close is offered regardless of the guard; no test is blocked while a typed confirmation is open, the only state where a key reaches runClose. (Also raised by review-logic as L-004, merged here.)",
    "impact": "Trigger: a refactor moves the blocked-input guard below the `confirming` dispatch. Outcome: while a permission prompt owns the keyboard during an open close confirmation, Enter reaches confirmKey and runs the real flow complete (or cancels it); the suite stays green.",
    "suggested_fix": "Unblocked: c on a passing merged check, d, type the id; then block, press Enter and x, assert calls is still ['check <id>'] and the confirmation is unchanged; unblock, Enter, assert close runs.",
    "evidence": "Mutation 2 (guard moved below `if (confirming !== undefined) { confirmKey(...); return; }`): governance-inspector.test.ts 7 pass / 0 fail. Mutation 1 (guard removed) goes red only via the c assertion.",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "class_scope": {
      "sites": [
        "src/tui/governance-inspector.test.ts AC8 blocked-keyboard test",
        "src/tui/governance-inspector.ts keypress handler inputBlocked guard"
      ],
      "enumeration_method": "Read every inputBlocked reference in governance-inspector.ts (keypress handler, onMouseDown) and every `blocked` use in the test; mutation-tested the guard placement."
    }
  },
  {
    "id": "T-002",
    "severity": "major",
    "file": "src/tui/governance-inspector.ts",
    "quote": "if (/^[0-9]$/.test(sequence) && confirming.typed.length < confirming.id.length) {",
    "problem": "AC6 'any other key cancels' the typed close confirmation is not pinned by any test: only wrong-id+Enter and right-id+Enter are exercised. Deleting the trailing cancel in confirmKey keeps the suite green.",
    "impact": "Trigger: a regression removes the fall-through cancel. Outcome: a user pressing x/c to back out leaves the confirmation open with its digits; a later digit + Enter runs the flow complete they tried to cancel; CI stays green.",
    "suggested_fix": "In the AC5-AC7 inspector test, after d and typing part of the id, press x, assert the confirmation is gone, then type the rest + Enter and assert no close call.",
    "evidence": "Mutation 4 (removed `confirming = undefined; paint();` at the end of confirmKey): governance-inspector.test.ts 7 pass / 0 fail.",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "class_scope": {
      "sites": [
        "src/tui/governance-inspector.ts confirmKey fall-through cancel"
      ],
      "enumeration_method": "Enumerated the four branches of confirmKey (enter, backspace, digit, other) against keys pressed in governance-inspector.test.ts; only enter and digit are exercised."
    }
  },
  {
    "id": "T-003",
    "severity": "major",
    "file": "src/tui/governance-flows.ts",
    "quote": "const othersPass = check.transition.allowed && check.gates.every((gate) => gate.name === \"confirmation\" || gate.status !== \"fail\");",
    "problem": "The status-transition requirement is unpinned at both sites: `passed: allowed && ...` in checkComplete (src/flow/service.ts) and `check.transition.allowed &&` in closeOffer's confirmation branch. The only transition-disallowed fixture also fails the pull-request gate, and every closeOffer fixture has transition.allowed true.",
    "impact": "Trigger: a regression drops either term; a flow demoted to in-progress by a failed complete, with a merged PR and all gates now passing, is checked. Outcome: the check reports 'complete would pass' / the modal offers close or confirm-in-terminal, but the real flow complete throws on the in-progress -> completing transition; CI stays green.",
    "suggested_fix": "check-complete.test.ts: an in-progress flow with a PR and all gates passing -> assert transition.allowed false and passed false. governance-flows.test.ts: closeOffer with transition.allowed false (confirmation and non-confirmation) -> kind 'none'.",
    "evidence": "Mutation 16 (`passed: allowed && ...` -> `passed: ...`): check-complete.test.ts 7 pass / 0 fail. Mutation 10 (dropped `check.transition.allowed &&`): flows + inspector tests 16 pass / 0 fail.",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "class_scope": {
      "sites": [
        "src/flow/service.ts checkComplete passed computation",
        "src/tui/governance-flows.ts closeOffer othersPass"
      ],
      "enumeration_method": "Searched every consumer of transition.allowed / allowed in the check path (service.ts checkComplete, governance-flows.ts closeOffer/formatCheckLines) and mutation-tested each term."
    }
  },
  {
    "id": "T-004",
    "severity": "major",
    "file": "src/flow/service.ts",
    "quote": "? { state: \"merged\", detail: `direct merge: ${merge.detail}` }",
    "problem": "Merge-state mapping (a named AC8 sub-item): the merged-commit (direct merge) arm and the unevaluable (tracker throws -> unknown) arm of prMergeState have no test; no test calls checkComplete with mergedCommit.",
    "impact": "Trigger: a regression makes the merged-commit arm ignore the main-merge gate result; `keryx flow check-complete <id> --merged <sha-not-on-main>`. Outcome: prints `merge: merged (direct merge: ...)` and JSON consumers read merge.state 'merged' for a commit that never landed; CI stays green.",
    "suggested_fix": "Extend the merge-state test: mainMergeGate stubbed pass/fail with mergedCommit -> 'merged'/'unknown'; a tracker whose prStatus throws -> 'unknown' with detail 'the tracker call failed'.",
    "evidence": "Mutation 15 (`merge?.status === \"pass\"` -> `true`): check-complete + governance-flows tests 16 pass / 0 fail. keryx ctx rg mergedCommit over check-complete.test.ts: no call passes it.",
    "confidence": "high",
    "reviewer": "review-testing-practices",
    "class_scope": {
      "sites": [
        "src/flow/service.ts prMergeState merged-commit arm",
        "src/flow/service.ts prMergeState unevaluable arm"
      ],
      "enumeration_method": "Enumerated every PrObservation kind in prMergeState (no-pr, merged-commit, tracker-unavailable, unevaluable, observed x5) against the cases array and fixtures in check-complete.test.ts."
    }
  },
  {
    "id": "A-001",
    "severity": "minor",
    "file": "src/flow/service.ts",
    "quote": "const allowed = flow.status === \"implemented\" || (flow.status === \"in-progress\" && merged);",
    "problem": "The gates are shared but the admission rule is not: complete() decides via transition(..., 'completing') through machine.ts assertTransition plus the in-progress+mergedCommit branch, while checkComplete re-encodes it as a hand-written boolean.",
    "impact": "Correct today. Maintenance cost: an edit to TRANSITIONS in src/flow/machine.ts or to complete()'s merged branch leaves check-complete reporting the old transition.allowed/passed with nothing failing — the drift AC4 removed for the gates.",
    "suggested_fix": "One helper, e.g. completionAdmission(flow, merged) built on canTransition(flow.status, 'completing') || (merged && in-progress), asserted by complete() and reported by checkComplete.",
    "evidence": "checkComplete builds `allowed` inline; complete() uses `mergedCommit && flow.status === \"in-progress\"` then transition(...,'completing'); machine.ts TRANSITIONS implemented: ['completing','blocked'].",
    "confidence": "high",
    "reviewer": "review-architecture"
  },
  {
    "id": "A-002",
    "severity": "minor",
    "file": "src/flow/service.ts",
    "quote": "const unconfirmed = /^unconfirmed: (.+)$/.exec(gate.detail)?.[1]?.split(\", \") ?? [];",
    "problem": "completionFixHint recovers structured facts by regex-parsing human-readable gate.detail (`unconfirmed: ...`) and comparing `gate.detail === \"no PR recorded\"`.",
    "impact": "Correct today. Maintenance cost: rewording either gate detail silently drops the fix hint from flow check-complete and the /governance Flows tab with no type error.",
    "suggested_fix": "Carry structured remedy facts (e.g. missing: string[] or remedy) on GateOutcome / CompletionGateEvaluation and derive the hint from them.",
    "evidence": "completionFixHint acceptance-criteria and pull-request arms vs. detail strings built in evaluateCompletionGates gates 1 and 2; consumers src/commands/flow.ts runCheckComplete and src/tui/governance-flows.ts formatCheckLines.",
    "confidence": "high",
    "reviewer": "review-architecture"
  },
  {
    "id": "A-003",
    "severity": "minor",
    "file": "src/commands/flow.ts",
    "quote": "const result = await getService().checkComplete({",
    "problem": "`flow check-complete --json` (registry json:true, read:true) emits no JSON on its error paths: a missing or unknown id reaches flowCommand's catch, which prints coloured text to stderr and sets exit 1 — the same exit code as a valid `passed: false` result. Matches the sibling flow commands' existing convention.",
    "impact": "Trigger: an agent following `keryx commands --json` runs `keryx flow check-complete 999 --json`. Outcome: empty stdout, exit 1; an agent mapping exit 1 to 'gates failed, parse stdout' gets a parse error instead of a structured reason. No wrong result on a valid flow.",
    "suggested_fix": "Under --json, catch around checkComplete and print {\"error\":{\"message\":...}} with a distinct exit code (e.g. 2), or document the stderr-only error contract in the descriptor.",
    "evidence": "src/commands/flow.ts runCheckComplete and flowCommand catch `console.error(...); process.exitCode = 1;`; src/standard/command-registry.ts check-complete descriptor json: true.",
    "confidence": "medium",
    "reviewer": "review-architecture"
  },
  {
    "id": "T-005",
    "severity": "minor",
    "file": "src/tui/governance-inspector.ts",
    "quote": "if (closed || options.inputBlocked?.() === true || confirming !== undefined) return;",
    "problem": "The clickable action row (AC5) and its blocked/confirming guard have no test: action.onMouseDown is never invoked; reducing the guard to `if (closed) return;` keeps the suite green.",
    "impact": "Maintenance cost: the clickable label can regress silently; worst case under a blocked keyboard is a read-only check or an opened confirmation, not a wrong close.",
    "suggested_fix": "Find the gov-actions renderable and call onMouseDown(): assert a check runs when unblocked, nothing runs when blocked, and a click after a passing check opens the confirmation.",
    "evidence": "Mutation 5: inspector + flows tests 16 pass / 0 fail; no onMouseDown or gov-actions reference in governance-inspector.test.ts.",
    "confidence": "high",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "T-006",
    "severity": "minor",
    "file": "src/tui/governance-inspector.ts",
    "quote": "if (flow === undefined || flow.status === \"done\" || checkingId !== undefined || closingId !== undefined) return;",
    "problem": "`c` on a done flow is not tested to do nothing: the AC3 test selects done flow 363 and asserts only the action-line text; removing the done guard from runCheck keeps the suite green.",
    "impact": "Maintenance cost: AC5's 'not offered for a done flow' is pinned only as label text; a regression would run a read-only check on a done flow and paint a confusing verdict. No state corrupted.",
    "suggested_fix": "In the AC3 inspector test, on 363 press c, settle, assert calls is [].",
    "evidence": "Mutation 6: governance-inspector.test.ts 7 pass / 0 fail.",
    "confidence": "high",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "T-007",
    "severity": "info",
    "file": "src/governance/flow-narrative.test.ts",
    "quote": "expect(markdown).toContain(\"effect: not recorded\");",
    "problem": "Stored-report backward compatibility (AC1 'still loads') is pinned only at the render layer: nothing writes a pre-364 latest.json and reads it back through readLatestGovernanceReport and the Flows tab. (Also raised by review-logic in L-004, merged here.)",
    "impact": "None today: readLatestGovernanceReport validates only schemaVersion, generatedAt and projects. A future per-flow validation rejecting old reports would pass CI.",
    "suggested_fix": "Write a latest.json fixture with a flow lacking effect/summary, open the modal (or call readLatestGovernanceReport), assert `effect: not recorded`.",
    "evidence": "Read src/governance/report.ts readLatestGovernanceReport and flow-narrative.test.ts 'AC2: the markdown report carries both lines'.",
    "confidence": "medium",
    "reviewer": "review-testing-practices"
  },
  {
    "id": "L-005",
    "severity": "info",
    "file": "src/tui/governance-flow-actions.ts",
    "quote": "check: (id) => service.checkComplete({ cwd, id }),",
    "problem": "AC6's 'or the flow records a merged commit' alternative cannot occur from the modal: the modal never passes mergedCommit, and flow.merged is written only on complete()'s passing path, so a not-done direct-merge flow always reads no-pr and is never offered close. (Also raised by review-testing-practices as T-008, merged here.)",
    "impact": "No wrong action; a direct-merge flow must be closed from the terminal with `flow complete --merged <sha>`, which the modal does not say.",
    "suggested_fix": "Drop the parenthetical from the modal's description or let the modal accept a merged sha; at minimum make the action row say 'direct merge: close from the terminal with --merged'.",
    "evidence": "keryx ctx rg for flow.merged writers: only service.ts `flow.merged = { commit: mergedCommit, ref: \"origin/main\", at: now() };` on the passing path.",
    "confidence": "high",
    "reviewer": "review-logic"
  }
]
```
