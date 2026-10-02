# Flow 364 review, round 2 — verification of round 1 at PR #821 head 8cb9cff7

Scope: round 1 (2026-10-01-ingest-821, 15 findings at c9f31fd9) re-verified at the PR head 8cb9cff75a0b505be3757f3973559f1efc316299, which contains the fix commit 2dd86da38063e40618bfa9e6e69aa6928e59f124. The fix commit itself was reviewed for new defects by an independent reviewer (claimKey's effect on other modals, runClose's paths, complete() unchanged, the effect fallback); it found 3, listed below. CI on the head: every check green.

- **L-006 (blocker)** — verifier: refuted by execution at the head.
- **L-001 (major)** — verifier: refuted by execution at the head.
- **L-002 (major)** — verifier: refuted by execution at the head.
- **L-003 (major)** — verifier: refuted by execution at the head.
- **T-001 (major)** — verifier: refuted by execution at the head.
- **T-002 (major)** — verifier: refuted by execution at the head.
- **T-003 (major)** — verifier: refuted by execution at the head.
- **T-004 (major)** — verifier: refuted by execution at the head.
- **A-001 (minor)** — verifier: refuted by execution at the head.
- **A-002 (minor)** — verifier: refuted by execution at the head.
- **A-003 (minor)** — verifier: refuted by execution at the head.
- **T-005 (minor)** — verifier: refuted by execution at the head.
- **T-006 (minor)** — verifier: refuted by execution at the head.
- **T-007 (info)** — verifier: refuted by execution at the head.
- **L-005 (info)** — verifier: refuted by execution at the head.
- **R2-001 (minor), new** — The prose fallback added in 2dd86da3 treated any leftover non-hint line as a stated effect: an empty list marker, a nested heading, a blockquoted hint, and the continuation line of a numbered item.
- **R2-002 (minor), new** — renderTab cleared a pending confirmation on every mount, and the Flows tab is re-mounted by a theme change, not only by a tab switch.
- **R2-003 (minor), new** — runClose's early return did not repaint, after confirmKey had already cleared the confirmation without painting.

```json keryx:findings
[
  {
    "id": "L-006",
    "reviewer": "review-logic",
    "severity": "blocker",
    "file": "src/lib/group-subcommands.ts",
    "quote": "      \"implemented\",\n      \"complete\",\n      \"confirm\",",
    "problem": "`keryx flow check-complete` is refused by the CLI router: commands/flow.ts adds `case \"check-complete\"`, and printHelp, cli.test.ts and command-registry.ts advertise it, but the `flow` entry of GROUP_SUBCOMMANDS in src/lib/group-subcommands.ts was not updated, and cli-registry.ts refuses any flow subcommand missing from it. The handler is reachable only by calling flowCommand directly, which is what the PR's tests do.",
    "impact": "Trigger: a user or agent runs `keryx flow check-complete 364 --json` as AC4, `keryx flow --help` and `keryx commands --json` instruct. Outcome: exit 1 with `Unknown command: check-complete. Run \\`keryx flow --help\\` for the list.` and no check runs. The AC4 CLI surface is not delivered. The existing guard test src/lib/group-subcommands-flow.test.ts fails on this branch.",
    "suggested_fix": "Add \"check-complete\" to the `flow` entry of GROUP_SUBCOMMANDS next to \"complete\", and add an end-to-end routing assertion (e.g. `flow check-complete 001 --json` never prints `Unknown command`).",
    "confidence": "high",
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
    },
    "global_id": "2026-10-01-ingest-821#L-006",
    "evidence": "Round 1: From the root at HEAD c9f31fd9: `bun src/cli.ts flow check-complete 364 --json` and without --json both exit 1 with stderr `Unknown command: check-complete`. `bun src/cli.ts flow --help` lists the usage line; `bun src/cli.ts commands --json --module tasks` lists `flow check-complete` json:true read:true. `bun test --timeout 30000 src/lib/group-subcommands-flow.test.ts` -> 1 pass 1 fail ('every subcommand commands/flow.ts dispatches is listed for the router', received [\"check-complete\"]). PR's local runs did not include src/lib. Post-fix: fixed in 2dd86da38063e40618bfa9e6e69aa6928e59f124, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299. src/lib/group-subcommands.ts lists \"check-complete\" for flow; src/lib/group-subcommands-flow.test.ts passes; check-complete.test.ts \"review L-006\" spawns the real CLI (bun src/cli.ts flow check-complete 999 --json): no \"Unknown command\", exit 2 with a JSON error."
  },
  {
    "id": "L-001",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/tui/governance-inspector.ts",
    "quote": "if (/^[0-9]$/.test(sequence) && confirming.typed.length < confirming.id.length) {",
    "problem": "The typed close confirmation cannot be entered for any flow id containing the digit 1 or 2. modal-host registers its keypress handler (ensureHost) before openGovernanceReport registers its own; with focus on the tab strip (inBody false) and two tabs, modal-host treats '1'/'2' as tab jumps, calls mountTab + stopPropagation, and the governance handler never sees the digit. Left/right/Tab are taken the same way, so a pending confirmation survives a tab switch invisibly on the Report tab instead of being cancelled.",
    "impact": "Trigger: select flow 312 (any id with a 1 or 2, e.g. every id 100-299), press c (check passes, PR merged), press d, type 3 1 2, Enter. Outcome: '1' is swallowed, '2' switches to the Report tab, buffer stays '3', Enter compares '3' with '312' and cancels; flow complete never runs. Close from the modal is impossible for those ids. The shipped test uses id 364 only.",
    "suggested_fix": "While `confirming` is set, keep digits (and left/right/tab) away from modal-host: focus a renderable inside the modal body so inBody is true, or give OpenModalInput a way to claim digits like onArrowKeys claims arrows. Make a tab switch cancel or be refused during a confirmation. Add a test confirming a flow whose id contains 1 and 2.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/tui/governance-inspector.ts confirmKey digit branch",
        "src/tui/modal-host.ts digit tab-jump branch",
        "src/tui/modal-host.ts left/right/tab switch branches"
      ],
      "enumeration_method": "Read every early-return/stopPropagation branch in modal-host's keypress handler (escape, x, left/right claim, tab switch, digit jump) and checked which can fire while governance `confirming` is set; probe-confirmed '1' and '2'."
    },
    "global_id": "2026-10-01-ingest-821#L-001",
    "evidence": "Round 1: Probe test /private/tmp/claude-502/-Users-tsaitler-aleksandr-goodea-keryx/6d936496-d76c-4d37-8e47-d165d9e389d6/scratchpad/digit-probe.test.ts against the real modal (mountChrome + keypressSource, flow id '312', fake actions, passing merged check): after '1' buffer '3' tab flows; after '2' buffer '3' tab report; after Enter calls == [\"check 312\"]. Traced modal-host.ts digit-jump branch `if (inBody || state.tabs.length < 2) return;` then mountTab + stopPropagation; openModal focuses the tab strip. Post-fix: fixed in 2dd86da38063e40618bfa9e6e69aa6928e59f124, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299. modal-host.ts gains claimKey, called before the x-close, tab and digit-jump branches; governance-inspector passes it while a confirmation is open. Round 1's own probe (digit-probe.test.ts) re-run at the head: after 1 tab flows, after 2 tab flows, calls [\"check 312\",\"check 312\",\"close 312\"]. governance-inspector.test.ts \"review L-001\" (id 312) passes."
  },
  {
    "id": "L-002",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/governance/flow-narrative.ts",
    "quote": "if (first === undefined) return { stated: false, reason: \"hint-only\" };",
    "problem": "outcomeBulletsFrom recognises only '-'/'*' bullets, so an Outcome criteria section written as prose, as a numbered list, or left empty yields []; summarizeEffect maps every [] to reason 'hint-only' even when the OUTCOME_HINT line is absent. AC1 defines effect as the first usable statement, with only the untouched hint counting as none.",
    "impact": "Trigger: description.md with `## Outcome criteria` followed by a prose sentence, a `1.` item, or nothing. Outcome: governance markdown and the modal print `effect: not stated (only the template hint)` — a stated effect reported as absent, with a false reason.",
    "suggested_fix": "Distinguish 'hint present' from 'no bullets': fall back to the first non-hint prose line (and accept numbered items), or at minimum return a distinct reason (`no-bullets`/`empty`) and use `hint-only` only when OUTCOME_HINT was actually present.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/governance/flow-narrative.ts summarizeEffect hint-only arm",
        "src/flow/description-intent.ts outcomeBulletsFrom"
      ],
      "enumeration_method": "Traced every caller of outcomeBulletsFrom (summarizeEffect, product/extract.ts outcomeCriterionFrom); only summarizeEffect attaches a reason, extract.ts returns null as before the PR."
    },
    "global_id": "2026-10-01-ingest-821#L-002",
    "evidence": "Round 1: Probe /private/tmp/claude-502/-Users-tsaitler-aleksandr-goodea-keryx/6d936496-d76c-4d37-8e47-d165d9e389d6/scratchpad/effect-probe.test.ts: prose, empty section and numbered item all returned {stated:false, reason:'hint-only'} and rendered 'effect: not stated (only the template hint)'. Post-fix: fixed in 2dd86da38063e40618bfa9e6e69aa6928e59f124, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299. summarizeEffect falls back to prose and numbered lines, and labels an empty section empty-section. Round 1's probe (effect-probe.test.ts) re-run at the head: prose -> stated, numbered -> stated \"Users close flows from the modal.\", empty -> {stated:false, reason:\"empty-section\"}. flow-narrative.test.ts \"review L-002\" passes."
  },
  {
    "id": "L-003",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/tui/governance-flows.ts",
    "quote": "if (check.updatedAt < flow.updatedAt) return { kind: \"none\", reason: \"the flow changed since the check — press c again\" };",
    "problem": "The close offer's staleness test compares the check with the stored report's FlowGovernance.updatedAt, which only refreshes on `r` or after a close; confirmKey's Enter does not re-evaluate the offer. A flow.json change made after the check (another session runs `flow ac update`, reopens a task) is invisible, so close stays offered.",
    "impact": "Trigger: c passes; another terminal mutates the flow so a gate now fails; no report re-run; d + typed id + Enter. Outcome: close runs although AC6 says it must not be offered; the real flow complete fails its gates, records a failed completionAttempt and moves an implemented flow back to in-progress. Nothing completes wrongly (complete re-gates).",
    "suggested_fix": "At beginClose and again at Enter in confirmKey, read the live flow.json updatedAt (or re-run checkComplete) and withdraw the offer if it is newer than check.updatedAt.",
    "confidence": "medium",
    "class_scope": {
      "sites": [
        "src/tui/governance-flows.ts closeOffer staleness comparison",
        "src/tui/governance-inspector.ts confirmKey Enter branch"
      ],
      "enumeration_method": "Enumerated every path from an offer to flowActions().close: action-row onMouseDown -> beginClose, key d -> beginClose, Enter in confirmKey -> runClose; only beginClose consults offerFor, and only against the stored report."
    },
    "global_id": "2026-10-01-ingest-821#L-003",
    "evidence": "Round 1: Read closeOffer, offerFor, beginClose, confirmKey and reload in governance-inspector.ts: the checks Map persists across reloads and nothing reads live flow state between check and close. Not run end to end. Post-fix: fixed in 2dd86da38063e40618bfa9e6e69aa6928e59f124, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299. runClose re-runs the check through flowActions (the real one reads flow.json via checkComplete) and completes only if updatedAt is unchanged and closeOffer is still \"close\". governance-inspector.test.ts \"review L-003\" (live updatedAt moves before Enter): calls [\"check 364\",\"check 364\"], no close, the error line shown. Round 1's verifier-l003 probe cannot show it: its fake check ignores disk, a limit of the probe not of the fix."
  },
  {
    "id": "T-001",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/tui/governance-inspector.test.ts",
    "quote": "let blocked = true;",
    "problem": "AC8 'a keypress while inputBlocked() is true neither checks nor closes': the 'closes' half passes vacuously. The blocked phase uses a non-merged fake and presses d before any check, so no close is offered regardless of the guard; no test is blocked while a typed confirmation is open, the only state where a key reaches runClose. (Also raised by review-logic as L-004, merged here.)",
    "impact": "Trigger: a refactor moves the blocked-input guard below the `confirming` dispatch. Outcome: while a permission prompt owns the keyboard during an open close confirmation, Enter reaches confirmKey and runs the real flow complete (or cancels it); the suite stays green.",
    "suggested_fix": "Unblocked: c on a passing merged check, d, type the id; then block, press Enter and x, assert calls is still ['check <id>'] and the confirmation is unchanged; unblock, Enter, assert close runs.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/tui/governance-inspector.test.ts AC8 blocked-keyboard test",
        "src/tui/governance-inspector.ts keypress handler inputBlocked guard"
      ],
      "enumeration_method": "Read every inputBlocked reference in governance-inspector.ts (keypress handler, onMouseDown) and every `blocked` use in the test; mutation-tested the guard placement."
    },
    "global_id": "2026-10-01-ingest-821#T-001",
    "evidence": "Round 1: Mutation 2 (guard moved below `if (confirming !== undefined) { confirmKey(...); return; }`): governance-inspector.test.ts 7 pass / 0 fail. Mutation 1 (guard removed) goes red only via the c assertion. Post-fix: fixed in 2dd86da38063e40618bfa9e6e69aa6928e59f124, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299. governance-inspector.test.ts \"review T-001\": confirmation open, keyboard blocked, Enter -> no close and the confirmation kept; unblocked Enter -> [\"check 364\",\"check 364\",\"close 364\"]."
  },
  {
    "id": "T-002",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/tui/governance-inspector.ts",
    "quote": "if (/^[0-9]$/.test(sequence) && confirming.typed.length < confirming.id.length) {",
    "problem": "AC6 'any other key cancels' the typed close confirmation is not pinned by any test: only wrong-id+Enter and right-id+Enter are exercised. Deleting the trailing cancel in confirmKey keeps the suite green.",
    "impact": "Trigger: a regression removes the fall-through cancel. Outcome: a user pressing x/c to back out leaves the confirmation open with its digits; a later digit + Enter runs the flow complete they tried to cancel; CI stays green.",
    "suggested_fix": "In the AC5-AC7 inspector test, after d and typing part of the id, press x, assert the confirmation is gone, then type the rest + Enter and assert no close call.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/tui/governance-inspector.ts confirmKey fall-through cancel"
      ],
      "enumeration_method": "Enumerated the four branches of confirmKey (enter, backspace, digit, other) against keys pressed in governance-inspector.test.ts; only enter and digit are exercised."
    },
    "global_id": "2026-10-01-ingest-821#T-002",
    "evidence": "Round 1: Mutation 4 (removed `confirming = undefined; paint();` at the end of confirmKey): governance-inspector.test.ts 7 pass / 0 fail. Post-fix: fixed in 2dd86da38063e40618bfa9e6e69aa6928e59f124, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299. governance-inspector.test.ts AC5-AC7 now presses 3 then c mid-confirmation, and x mid-confirmation (modal stays open), and asserts no close call follows."
  },
  {
    "id": "T-003",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/tui/governance-flows.ts",
    "quote": "const othersPass = check.transition.allowed && check.gates.every((gate) => gate.name === \"confirmation\" || gate.status !== \"fail\");",
    "problem": "The status-transition requirement is unpinned at both sites: `passed: allowed && ...` in checkComplete (src/flow/service.ts) and `check.transition.allowed &&` in closeOffer's confirmation branch. The only transition-disallowed fixture also fails the pull-request gate, and every closeOffer fixture has transition.allowed true.",
    "impact": "Trigger: a regression drops either term; a flow demoted to in-progress by a failed complete, with a merged PR and all gates now passing, is checked. Outcome: the check reports 'complete would pass' / the modal offers close or confirm-in-terminal, but the real flow complete throws on the in-progress -> completing transition; CI stays green.",
    "suggested_fix": "check-complete.test.ts: an in-progress flow with a PR and all gates passing -> assert transition.allowed false and passed false. governance-flows.test.ts: closeOffer with transition.allowed false (confirmation and non-confirmation) -> kind 'none'.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/flow/service.ts checkComplete passed computation",
        "src/tui/governance-flows.ts closeOffer othersPass"
      ],
      "enumeration_method": "Searched every consumer of transition.allowed / allowed in the check path (service.ts checkComplete, governance-flows.ts closeOffer/formatCheckLines) and mutation-tested each term."
    },
    "global_id": "2026-10-01-ingest-821#T-003",
    "evidence": "Round 1: Mutation 16 (`passed: allowed && ...` -> `passed: ...`): check-complete.test.ts 7 pass / 0 fail. Mutation 10 (dropped `check.transition.allowed &&`): flows + inspector tests 16 pass / 0 fail. Post-fix: fixed in 2dd86da38063e40618bfa9e6e69aa6928e59f124, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299. check-complete.test.ts \"review T-003\": in-progress flow with PR and every gate passing -> transition.allowed false, passed false; governance-flows.test.ts \"review T-003\": closeOffer with transition.allowed false is none, with and without confirmationRequired."
  },
  {
    "id": "T-004",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/flow/service.ts",
    "quote": "? { state: \"merged\", detail: `direct merge: ${merge.detail}` }",
    "problem": "Merge-state mapping (a named AC8 sub-item): the merged-commit (direct merge) arm and the unevaluable (tracker throws -> unknown) arm of prMergeState have no test; no test calls checkComplete with mergedCommit.",
    "impact": "Trigger: a regression makes the merged-commit arm ignore the main-merge gate result; `keryx flow check-complete <id> --merged <sha-not-on-main>`. Outcome: prints `merge: merged (direct merge: ...)` and JSON consumers read merge.state 'merged' for a commit that never landed; CI stays green.",
    "suggested_fix": "Extend the merge-state test: mainMergeGate stubbed pass/fail with mergedCommit -> 'merged'/'unknown'; a tracker whose prStatus throws -> 'unknown' with detail 'the tracker call failed'.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/flow/service.ts prMergeState merged-commit arm",
        "src/flow/service.ts prMergeState unevaluable arm"
      ],
      "enumeration_method": "Enumerated every PrObservation kind in prMergeState (no-pr, merged-commit, tracker-unavailable, unevaluable, observed x5) against the cases array and fixtures in check-complete.test.ts."
    },
    "global_id": "2026-10-01-ingest-821#T-004",
    "evidence": "Round 1: Mutation 15 (`merge?.status === \"pass\"` -> `true`): check-complete + governance-flows tests 16 pass / 0 fail. keryx ctx rg mergedCommit over check-complete.test.ts: no call passes it. Post-fix: fixed in 2dd86da38063e40618bfa9e6e69aa6928e59f124, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299. check-complete.test.ts \"review T-004\": mergedCommit with mainMergeGate pass -> merged, fail -> unknown with the gate detail; merge-state test adds a throwing prStatus -> {state:\"unknown\", detail:\"the tracker call failed\"}."
  },
  {
    "id": "A-001",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/flow/service.ts",
    "quote": "const allowed = flow.status === \"implemented\" || (flow.status === \"in-progress\" && merged);",
    "problem": "The gates are shared but the admission rule is not: complete() decides via transition(..., 'completing') through machine.ts assertTransition plus the in-progress+mergedCommit branch, while checkComplete re-encodes it as a hand-written boolean.",
    "impact": "Correct today. Maintenance cost: an edit to TRANSITIONS in src/flow/machine.ts or to complete()'s merged branch leaves check-complete reporting the old transition.allowed/passed with nothing failing — the drift AC4 removed for the gates.",
    "suggested_fix": "One helper, e.g. completionAdmission(flow, merged) built on canTransition(flow.status, 'completing') || (merged && in-progress), asserted by complete() and reported by checkComplete.",
    "confidence": "high",
    "global_id": "2026-10-01-ingest-821#A-001",
    "evidence": "Round 1: checkComplete builds `allowed` inline; complete() uses `mergedCommit && flow.status === \"in-progress\"` then transition(...,'completing'); machine.ts TRANSITIONS implemented: ['completing','blocked']. Post-fix: fixed in 2dd86da38063e40618bfa9e6e69aa6928e59f124, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299. completionAdmitted(status, merged) = canTransition(status, \"completing\") || (merged && in-progress) in src/flow/service.ts; checkComplete reports it, complete() keeps its own two arms unchanged."
  },
  {
    "id": "A-002",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/flow/service.ts",
    "quote": "const unconfirmed = /^unconfirmed: (.+)$/.exec(gate.detail)?.[1]?.split(\", \") ?? [];",
    "problem": "completionFixHint recovers structured facts by regex-parsing human-readable gate.detail (`unconfirmed: ...`) and comparing `gate.detail === \"no PR recorded\"`.",
    "impact": "Correct today. Maintenance cost: rewording either gate detail silently drops the fix hint from flow check-complete and the /governance Flows tab with no type error.",
    "suggested_fix": "Carry structured remedy facts (e.g. missing: string[] or remedy) on GateOutcome / CompletionGateEvaluation and derive the hint from them.",
    "confidence": "high",
    "global_id": "2026-10-01-ingest-821#A-002",
    "evidence": "Round 1: completionFixHint acceptance-criteria and pull-request arms vs. detail strings built in evaluateCompletionGates gates 1 and 2; consumers src/commands/flow.ts runCheckComplete and src/tui/governance-flows.ts formatCheckLines. Post-fix: fixed in 2dd86da38063e40618bfa9e6e69aa6928e59f124, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299. UNCONFIRMED_PREFIX and NO_PR_DETAIL constants are used both where the gates write the detail and where completionFixHint reads it."
  },
  {
    "id": "A-003",
    "reviewer": "review-architecture",
    "severity": "minor",
    "file": "src/commands/flow.ts",
    "quote": "const result = await getService().checkComplete({",
    "problem": "`flow check-complete --json` (registry json:true, read:true) emits no JSON on its error paths: a missing or unknown id reaches flowCommand's catch, which prints coloured text to stderr and sets exit 1 — the same exit code as a valid `passed: false` result. Matches the sibling flow commands' existing convention.",
    "impact": "Trigger: an agent following `keryx commands --json` runs `keryx flow check-complete 999 --json`. Outcome: empty stdout, exit 1; an agent mapping exit 1 to 'gates failed, parse stdout' gets a parse error instead of a structured reason. No wrong result on a valid flow.",
    "suggested_fix": "Under --json, catch around checkComplete and print {\"error\":{\"message\":...}} with a distinct exit code (e.g. 2), or document the stderr-only error contract in the descriptor.",
    "confidence": "medium",
    "global_id": "2026-10-01-ingest-821#A-003",
    "evidence": "Round 1: src/commands/flow.ts runCheckComplete and flowCommand catch `console.error(...); process.exitCode = 1;`; src/standard/command-registry.ts check-complete descriptor json: true. Post-fix: fixed in 2dd86da38063e40618bfa9e6e69aa6928e59f124, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299. runCheckComplete under --json catches and prints {\"error\":{\"message\"}} with exit 2; check-complete.test.ts \"review L-006\" asserts exit 2 and the JSON error for an unknown id."
  },
  {
    "id": "T-005",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/tui/governance-inspector.ts",
    "quote": "if (closed || options.inputBlocked?.() === true || confirming !== undefined) return;",
    "problem": "The clickable action row (AC5) and its blocked/confirming guard have no test: action.onMouseDown is never invoked; reducing the guard to `if (closed) return;` keeps the suite green.",
    "impact": "Maintenance cost: the clickable label can regress silently; worst case under a blocked keyboard is a read-only check or an opened confirmation, not a wrong close.",
    "suggested_fix": "Find the gov-actions renderable and call onMouseDown(): assert a check runs when unblocked, nothing runs when blocked, and a click after a passing check opens the confirmation.",
    "confidence": "high",
    "global_id": "2026-10-01-ingest-821#T-005",
    "evidence": "Round 1: Mutation 5: inspector + flows tests 16 pass / 0 fail; no onMouseDown or gov-actions reference in governance-inspector.test.ts. Post-fix: fixed in 2dd86da38063e40618bfa9e6e69aa6928e59f124, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299. governance-inspector.test.ts \"review T-005\" clicks gov-actions with clickNode: blocked -> nothing; unblocked -> check; again -> the confirmation opens."
  },
  {
    "id": "T-006",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "file": "src/tui/governance-inspector.ts",
    "quote": "if (flow === undefined || flow.status === \"done\" || checkingId !== undefined || closingId !== undefined) return;",
    "problem": "`c` on a done flow is not tested to do nothing: the AC3 test selects done flow 363 and asserts only the action-line text; removing the done guard from runCheck keeps the suite green.",
    "impact": "Maintenance cost: AC5's 'not offered for a done flow' is pinned only as label text; a regression would run a read-only check on a done flow and paint a confusing verdict. No state corrupted.",
    "suggested_fix": "In the AC3 inspector test, on 363 press c, settle, assert calls is [].",
    "confidence": "high",
    "global_id": "2026-10-01-ingest-821#T-006",
    "evidence": "Round 1: Mutation 6: governance-inspector.test.ts 7 pass / 0 fail. Post-fix: fixed in 2dd86da38063e40618bfa9e6e69aa6928e59f124, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299. governance-inspector.test.ts AC3 presses c on done flow 003 and asserts no check call."
  },
  {
    "id": "T-007",
    "reviewer": "review-testing-practices",
    "severity": "info",
    "file": "src/governance/flow-narrative.test.ts",
    "quote": "expect(markdown).toContain(\"effect: not recorded\");",
    "problem": "Stored-report backward compatibility (AC1 'still loads') is pinned only at the render layer: nothing writes a pre-364 latest.json and reads it back through readLatestGovernanceReport and the Flows tab. (Also raised by review-logic in L-004, merged here.)",
    "impact": "None today: readLatestGovernanceReport validates only schemaVersion, generatedAt and projects. A future per-flow validation rejecting old reports would pass CI.",
    "suggested_fix": "Write a latest.json fixture with a flow lacking effect/summary, open the modal (or call readLatestGovernanceReport), assert `effect: not recorded`.",
    "confidence": "medium",
    "global_id": "2026-10-01-ingest-821#T-007",
    "evidence": "Round 1: Read src/governance/report.ts readLatestGovernanceReport and flow-narrative.test.ts 'AC2: the markdown report carries both lines'. Post-fix: fixed in 2dd86da38063e40618bfa9e6e69aa6928e59f124, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299. report.test.ts \"review T-007\" writes latest.json without effect/summary, reads it back through readLatestGovernanceReport, and the markdown reads not recorded for both."
  },
  {
    "id": "L-005",
    "reviewer": "review-logic",
    "severity": "info",
    "file": "src/tui/governance-flow-actions.ts",
    "quote": "check: (id) => service.checkComplete({ cwd, id }),",
    "problem": "AC6's 'or the flow records a merged commit' alternative cannot occur from the modal: the modal never passes mergedCommit, and flow.merged is written only on complete()'s passing path, so a not-done direct-merge flow always reads no-pr and is never offered close. (Also raised by review-testing-practices as T-008, merged here.)",
    "impact": "No wrong action; a direct-merge flow must be closed from the terminal with `flow complete --merged <sha>`, which the modal does not say.",
    "suggested_fix": "Drop the parenthetical from the modal's description or let the modal accept a merged sha; at minimum make the action row say 'direct merge: close from the terminal with --merged'.",
    "confidence": "high",
    "global_id": "2026-10-01-ingest-821#L-005",
    "evidence": "Round 1: keryx ctx rg for flow.merged writers: only service.ts `flow.merged = { commit: mergedCommit, ref: \"origin/main\", at: now() };` on the passing path. Post-fix: fixed in 2dd86da38063e40618bfa9e6e69aa6928e59f124, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299. closeOffer for an in-progress flow whose check reads no-pr says to run keryx flow complete <id> --merged <sha> in a terminal; governance-flows.test.ts \"review L-005\" passes."
  },
  {
    "id": "R2-001",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/governance/flow-narrative.ts",
    "quote": "const stated = lines.filter((line) => line !== OUTCOME_HINT).map((line) => line.replace(/^\\d+[.)]\\s+/, \"\"));",
    "problem": "The prose fallback added in 2dd86da3 treated any leftover non-hint line as a stated effect: an empty list marker, a nested heading, a blockquoted hint, and the continuation line of a numbered item.",
    "impact": "An Outcome criteria section holding only `- ` reported `effect: -`; `### Metric` reported `effect: ### Metric`; `1. p95 under\\n   2s on the dashboard` reported `effect: p95 under (+1 more)`.",
    "suggested_fix": "Skip headings, blockquotes and empty markers; fold a numbered item's continuation lines into it; keep the hint as hint-only.",
    "evidence": "Probed by the fix-commit reviewer at 2dd86da3. Fixed in 8eaec2ee4a0bd5a736fbe4d6c9f226a9c0461a84, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299: proseEntries in flow-narrative.ts; flow-narrative.test.ts \"review L-002\" now asserts all four inputs.",
    "confidence": "high"
  },
  {
    "id": "R2-002",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/tui/governance-inspector.ts",
    "quote": "confirming = undefined;",
    "problem": "renderTab cleared a pending confirmation on every mount, and the Flows tab is re-mounted by a theme change, not only by a tab switch.",
    "impact": "A theme change while the user was typing the flow id silently discarded the typed confirmation (fail-safe: nothing closed, but the user had to start over).",
    "suggested_fix": "Cancel only when a tab other than Flows is mounted.",
    "evidence": "Fixed in 8eaec2ee4a0bd5a736fbe4d6c9f226a9c0461a84, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299: `if (tabId !== \"flows\") confirming = undefined;`; governance-inspector.test.ts \"review round 2\" changes the theme mid-confirmation and completes, then shows leaving the tab cancels.",
    "confidence": "high"
  },
  {
    "id": "R2-003",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/tui/governance-inspector.ts",
    "quote": "if (offeredOn === undefined || flow === undefined) return;",
    "problem": "runClose's early return did not repaint, after confirmKey had already cleared the confirmation without painting.",
    "impact": "If a report rebuild dropped the selected flow during the confirmation, Enter did nothing visible and the stale \"type the flow id\" prompt stayed on screen.",
    "suggested_fix": "Paint on the early return and say why nothing happened.",
    "evidence": "Fixed in 8eaec2ee4a0bd5a736fbe4d6c9f226a9c0461a84, contained in PR head 8cb9cff75a0b505be3757f3973559f1efc316299: the early return records \"not completed: press c to check again first\" when the flow is still listed and paints.",
    "confidence": "high"
  }
]
```
