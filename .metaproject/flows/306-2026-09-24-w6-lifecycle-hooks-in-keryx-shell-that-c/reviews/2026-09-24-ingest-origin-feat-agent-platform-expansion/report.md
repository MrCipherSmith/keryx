STATUS: DONE

# PR #678 (flow 306, W6 lifecycle hooks): verification review, round 5 (narrow)

Reviewer: opus-verification-r5. Head: ef2bed7e3bce173f259e1cae35f4df3fa8c02d5e (flow/306-w6, base origin/feat/agent-platform-expansion). Under review: 8a740ef8 (hermetic agent-hooks test) and d7693df1 (T22, "an approved impact-evidence ask acknowledges the file, security warnings reach the operator, rename sources are gated"), diffed as 2e6a57b8..ef2bed7e. ef2bed7e itself changes only flow bookkeeping.

**Verdict:** all five round-4 findings (F-001..F-005) are fixed. Each fix has a test that would fail on the parent. The `acknowledgement: "operator-approved"` marker matches W8's real contract: `provider.ts:374` accepts any non-empty trimmed string. Only an interactive operator's approval can produce it. A hook, a model tool input, a child runtime and an unattended run all cannot. T22 introduces no loosening, crash path, fail-open, or cross-file/session/child leak. Three new infos, no blockers, majors or minors.

**Checks run:**
- Targeted suites, KERYX_HOOKS=off: `bun test src/harness/hooks src/commands/agent-hooks.test.ts src/commands/agent-lifecycle-hooks.test.ts src/lib/impact-evidence-hook-adapter.test.ts src/commands/hooks.test.ts src/security/impact-evidence`. Result: 457 pass, 0 fail.
- CI-shaped hermeticity run. `PATH` was only bun's dir, `/usr/bin` and `/bin`, and I confirmed `keryx` was not on it. `HOME=/nonexistent-home`, `KERYX_HOME=/nonexistent-kh`, `KERYX_DISABLE_IMPACT_GATE` unset. Ran `agent-hooks.test.ts` and `agent-lifecycle-hooks.test.ts` with `--rerun-each 2`: 80/80 pass.
- Probe `scratchpad/r5probe.ts`. It runs the real W8 `createImpactEvidenceProvider` (strict config, fake `computeEvidence`) through the real adapter (`createShellImpactEvidenceProvider`) and the real `createHookRuntime`, and calls `acknowledgeImpactEvidence` / `extractFilePathsFromToolInput` directly. Results:
  - **Strict, interactive:** `[ask, (acknowledge) none+evidence, none with no provider call]`. `computeEvidence` ran twice.
  - **Strict, mixed batch:** acknowledging only `a`, then patching `a`+`b`, gives `ask`. Acknowledging both, then the same batch, gives `none`.
  - **Strict, unattended:** `[ask, ask, ask]`, each folded to deny, as by design.
  - **Child:** after the parent acknowledged `a`, `forChild` still gets `ask`.
  - **Supervised service failure:** the first and second fires both call W8 (`computeCalls` 2), and the warning reaches `additionalContext`.
  - **Rename and copy sources:** extracted.

## Verification of round-4 findings

| Item | Fix in T22 | Probe / reading | Test that fails without the fix |
|---|---|---|---|
| F-001 (minor): strict mode re-asked forever; an operator approval was never an acknowledgement | `agent.ts:4003-4005`: after `isApprovalFor` succeeds in the write-risk branch, and only if `keryx.impact-evidence` itself returned `ask`, call `runtime.acknowledgeImpactEvidence(extractFilePathsFromToolInput(input))`. `runtime.ts:634-646` sends `acknowledgement: "operator-approved"` only when every file in the call is acknowledged. The adapter forwards it to `ImpactEvidenceRequest.acknowledgement`. | Real W8 strict: the edit after an approval is allowed. W8 clears `pendingAck` and marks the file touched. Later edits never reach W8. Mixed batches still ask. Unattended stays deny. Children never inherit. | `agent-lifecycle-hooks.test.ts` "F-001 (round 4): an interactive approval … not asked again": `seenAcks` would be `[undefined, undefined]`. The "refused ask does not acknowledge" test covers the negative. `runtime.test.ts` "acknowledgeImpactEvidence forwards…" covers the mixed batch. "a CHILD runtime never inherits…" covers children. All use a fake port that models W8's ack contract. The real-W8 path is confirmed by my probe, not by a checked-in test (see note under F-001 below). |
| F-002 (minor): non-deny W8 warnings invisible | `runtime.ts:691-694`: warnings are also folded into `additionalContext` as `[keryx.impact-evidence] …`. `executeCall` appends that to the tool result (`agent.ts:4068-4072`) for every executed call. The deny message still uses `record.reason`. | Probe: the supervised service-failure warning appears in `additionalContext`. | `runtime.test.ts` "a non-deny impact-evidence outcome's warnings are folded into additionalContext": the `additionalContext` assertion fails on the parent. |
| F-003 (minor): rename sources dodged the gate | `runtime.ts:262-297` `extractRenameSourcePaths` adds `rename from` / `copy from` paths and dedupes them with `parsePatchTargets` output. `patch-risk.ts` is intentionally untouched. | rename+modify gives `[new, old]`. A pure-rename section riding with another hunk gives `[other, old]`. `copy from` is extracted. | `runtime.test.ts`: the two F-003 tests would see `["src/new.ts"]` and `["src/other.ts"]` on the parent. |
| F-004 (info): `keryx hooks test` used its own extractor | `hooks.ts:521-522` reuses `extractFilePathsFromToolInput`, with the synthetic file as fallback only. Warnings are included in the report and printed. | Reading confirms it. | `hooks.test.ts` "F-004 … apply_patch-shaped payload": the parent would pass `["hooks-test-synthetic-file.ts"]` and report no `warnings`. |
| F-005 (info): supervised service failure marked clean | `runtime.ts:677-682`: a result whose warnings start with `impact-evidence service failed:` is not marked clean. | The probe confirms the prefix matches the real W8 text through the adapter (`provider.ts:459`), and the retry calls W8 again. Coupling is by message prefix. If W8 rewords the message, W6 falls back to the old mark-clean behaviour, which is not a loosening. | `runtime.test.ts` "a supervised evidence-service-failure allow does not mark the file clean": `calls` would be 1 on the parent. |
| 8a740ef8: CI failure with no `keryx` on PATH | The test's project `hooks.json` disables `keryx.security-check-output` and `keryx.ctx-guard`, and the deny assertion is filtered to `keryx.impact-evidence`. | Passes with no `keryx` on PATH (run above). | n/a (hermeticity) |

### Can `acknowledgement` come from anything but an operator approval?

No. I checked each source.

- **Model tool input:** `ImpactEvidenceInput` is built only in `runBuiltinHook`. `acknowledgement` there is derived from the runtime-private `acknowledgedImpactEvidenceFiles` set. No `toolInput` field is forwarded, and the adapter copies `input.acknowledgement` only.
- **A hook:**
  - Command hooks cannot reach the runtime object. Their output is parsed into decisions, context and anomalies only.
  - A `failureEffect` never yields `ask` (`semantics.ts:50-87`). So a crashed or timed-out impact-evidence call cannot produce the `ask` that the agent.ts check keys on.
  - Another gate hook's `ask` does not count: the check filters on `hookId === "keryx.impact-evidence"`.
- **Approval path:**
  - `acknowledgeImpactEvidence` has exactly one production caller (`agent.ts:4004`), and it runs only after `isApprovalFor(response, fingerprint)` succeeds.
  - A `keryx.impact-evidence` ask sets `hookAsked`, and `tightenOutcome` keeps it off `auto`, so the approver is always consulted.
  - The approvers ask a human every time. The TUI apply_patch prompt (`tui-shell.ts:4672-4727`) and the readline prompt (`shell.ts:1850-1876`) always prompt. ACP forwards to the client (`acp/agent-io.ts:243-283`). `hookAsk` blocks allowlist and remember paths (`shell-approval.ts:91-97,132`, `acp/permission.ts:93`).
- **Unattended and serve:**
  - `deniedUnattendedApproval` always returns `false` (`trigger-dispatch.ts:498-517`), and trigger-agent-task uses the same function.
  - serve runs the harness with `interactive: false` and never calls agent.ts's `executeCall` approval branch (`serve-turn.ts:708-729`).
- **Child runtimes:** `acknowledgedImpactEvidenceFiles` is per runtime instance and `forChild` starts empty (probe plus the child test). A general child whose approvals proxy to the parent operator would record on its own runtime only, and that is still a real operator approval.
- **Across sessions and files:**
  - The set is in memory, per runtime, and the runtime's `sessionId` is fixed.
  - The ack is sent only when every file in the call is covered, so it never spans an unapproved file.
  - Keys are the same raw extraction on both sides (`toolInput: input` at `agent.ts:3624`), so a key mismatch can only fail closed, as another ask.

## Review of the T22 diff (new-bug hunt)

**Loosening:** none.
- The ack is W8's own contract value. The allow that follows is exactly what W8 strict does for an acknowledged request.
- When the approved call itself fails and the model retries with different content, W8 allows under the ack. The permission mode still gates the write, and the evidence was already appended to the failed result (`agent.ts:4068`), so W8's acknowledgement semantics hold.

**Crash:** none.
- `extractRenameSourcePaths` is a line regex over a string that has already been type-checked.
- `acknowledgeImpactEvidence` is optional-chained at the call site.

**Fail-open:** none.
- The service-failure change only stops marking a file clean.
- The warnings change only adds context.

**Leakage:** none (see above).

## Findings

### F-001 (info): in a mixed batch, W6 withholds the ack from the whole request, so W8 counts an already-approved file as never-acknowledged
- **Where:** `src/harness/hooks/runtime.ts:634-637`.
- **Problem:** W8's `acknowledgement` is request-level. W6 correctly sends it only when every file is acknowledged. But when the batch mixes an approved file `a` with a new file `b`, W8 treats `a` as still pending: it is a `pendingReAsk`, and W8 bumps `denials[a]` (`provider.ts:389-403`) even though the operator already approved it.
- **Scenario:** two such mixed batches reach `dampenAfter` (2). `a`'s evidence then collapses to the "dampened after repeated denials" notice for the rest of the session, although nobody denied it.
- **Related cost (W8's own behaviour):** the acknowledged request recomputes and re-injects the full evidence block once more (`computeEvidence` ran twice in the probe). That is contrary to the spirit of W8 spec line 266.
- **Test gap:** all T22 tests use a fake port modelling W8. No checked-in test drives the real strict provider across ask, approve, then ack.
- **Fix (optional):** split a mixed batch's ack per file, or have W8 accept a per-file acknowledgement list. Add one runtime test against the real `createImpactEvidenceProvider` in strict mode (the r5probe scenario).

### F-002 (info): the "acknowledgement" is an approval of a diff card that shows neither the evidence nor that impact-evidence asked. The spec deviation is recorded only in code comments.
- **Where:**
  - `src/commands/agent.ts:4003-4005`.
  - Approval cards at `src/tui/tui-shell.ts:4672-4727` and `src/commands/shell.ts:1850-1876`.
- **Problem:** W8 spec lines 271-275 define strict mode as the agent's next call carrying an acknowledgement that references the injected evidence. T22 substitutes the operator's approval instead. That is a reasonable and stricter-in-kind choice, since it needs a human.
- **What the operator sees:** the apply_patch card renders only the diff (plus destructive/credentials notes). `hookAsk` is not displayed. The evidence (`additionalContext`) reaches the model only after execution (`agent.ts:4068`), so neither party sees it before the approved edit runs.
- **Documentation gap:** neither W6-shell-hooks.md nor W8-harness-security-audit.md records the substitution.
- **Fix:** show "impact-evidence asked" plus the evidence text, or a condensed form, on the approval card when an impact-evidence `ask` is present. Record the operator-approval-as-acknowledgement rule in the W6/W8 spec (OQ-W8.3 is the natural place).

### F-003 (info): C-quoted `rename from` / `copy from` paths are passed with their quotes
- **Where:** `src/harness/hooks/runtime.ts:262-297`.
- **Problem:** git C-quotes paths containing `"`, `\`, control characters or (with the default `core.quotePath`) non-ASCII characters, e.g. `rename from "d\303\251j\303\240.ts"`. `extractRenameSourcePaths` takes the captured text verbatim.
- **Probe:** `rename from "sp ace.ts"` produced the target `"sp ace.ts"` with the quotes included.
- **Impact:** the gate still fires, because the entry exists, but W8 computes evidence for a path that does not exist. The reported importers are then empty and misleading. `parsePatchTargets` shares the same limitation for quoted `---`/`+++` headers, so this is a shared parser gap, not a T22 regression.
- **Fix:** unquote git C-style paths (strip the surrounding quotes, decode octal and backslash escapes) in both `extractRenameSourcePaths` and `parsePatchTargets`.

Also noted, not raised as a finding: F-005's fix couples W6 to W8's warning text by prefix. An exported constant, or a machine-readable `serviceFailed` flag on `ImpactEvidenceResult`, would make that coupling explicit. A drift would fail back to the pre-fix behaviour, never open.

## Round history
- **Round 1:** 1 blocker (unsandboxed hooks not refused when isolation is required), 4 majors and 8 minors across the runner, the spawn-failure path, non-tool gate events and hookAsk. All fixed in T17/T18.
- **Round 2:** confirmed those fixes. Found 1 major (hookAsk dropped under the default `ask` mode), 5 minors, and a CI profiles-guard failure. All fixed in T19.
- **Round 3:** verified the core W6 runtime and every round-1/2 fix. Found 2 majors and 1 minor in the new W8 impact-evidence wiring: apply_patch never gated, a refused first edit disarmed the gate, and a W8 deny became ask with warnings dropped. Also a Linux-CI-only test failure. All fixed in T21.
- **Round 4:** verified T21. Found 3 minors (the strict-mode re-ask loop, non-deny warnings invisible, rename sources dodging the gate) and 2 infos (`keryx hooks test` extractor drift, service-failure-as-clean). Fixed in T22 plus 8a740ef8 (a CI test depending on `keryx` on PATH).
- **Round 5 (this round):** all round-4 items are verified fixed, with discriminating tests, and the CI test is hermetic without `keryx` on PATH. The operator-approved acknowledgement matches W8's contract and cannot be produced by a hook, a model input, a child runtime or an unattended/serve run. No loosening, crash, fail-open or leak. 3 infos, no blockers, majors or minors.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "opus-verification-r5",
    "severity": "info",
    "file": "src/harness/hooks/runtime.ts",
    "line": 635,
    "quote": "files.length > 0 && files.every((f) => this.acknowledgedImpactEvidenceFiles.has(f))",
    "symbol": "HookRuntimeImpl.runBuiltinHook",
    "problem": "W8's acknowledgement is request-level, so W6 correctly withholds it when any file in the call lacks an approval. As a result, in a batch mixing an already-approved file with a new one, W8 treats the approved file as a pendingReAsk and bumps its never-acknowledged denial counter (provider.ts:389-403), even though the operator approved it. The acknowledged follow-up request also recomputes and re-injects the full evidence block once more. All T22 tests use a fake port; no checked-in test drives the real strict provider across ask, approve, then ack.",
    "impact": "Two mixed batches reach dampenAfter (2), after which the approved file's evidence collapses to the 'dampened after repeated denials' notice for the rest of the session although nobody denied it. There is also one extra evidence computation and injection per acknowledged file. No loosening.",
    "suggested_fix": "Split a mixed batch's acknowledgement per file, or let W8 accept a per-file acknowledgement list. Add a runtime test against the real createImpactEvidenceProvider in strict mode covering ask, acknowledgeImpactEvidence, allow, then no further call.",
    "evidence": "Probe scratchpad/r5probe.ts with the real createImpactEvidenceProvider (strict) through createShellImpactEvidenceProvider and createHookRuntime. Acknowledging only a.ts and then patching a.ts+b.ts gives ask. Acknowledging both and repeating the batch gives none with full evidence for both. The strict interactive sequence ran computeEvidence twice for one file. provider.ts:389-403 bumps denials for pendingReAsk when there is no acknowledgement.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "F-002",
    "reviewer": "opus-verification-r5",
    "severity": "info",
    "file": "src/commands/agent.ts",
    "line": 4004,
    "quote": "hooks?.runtime.acknowledgeImpactEvidence?.(extractFilePathsFromToolInput(input));",
    "symbol": "executeCall",
    "problem": "W8 spec lines 271-275 define strict-mode acknowledgement as the agent's next call referencing the injected evidence. T22 instead treats the operator's approval as the acknowledgement. But the apply_patch approval card (tui-shell.ts:4672-4727, shell.ts:1850-1876) shows only the diff: neither the impact evidence nor the fact that keryx.impact-evidence asked. The evidence reaches the model only after execution (agent.ts:4068). The substitution is documented only in code comments, not in the W6/W8 specs.",
    "impact": "The acknowledgement attests that a human approved the diff, not that anyone saw the evidence before the edit ran. This is not a loosening, since a human is required, but strict mode's intent (the evidence is read before the edit proceeds) is only partly met, and the spec does not record the deviation.",
    "suggested_fix": "When an impact-evidence ask is present, show 'impact-evidence asked' plus the evidence, or a condensed form, on the approval card. Record the operator-approval-as-acknowledgement rule in W6-shell-hooks.md and W8-harness-security-audit.md (OQ-W8.3).",
    "evidence": "Read of agent.ts:3974-4005 and 4068-4072, tui-shell.ts:4672-4727, shell.ts:1850-1876, and W8-harness-security-audit.md:269-275. git diff 2e6a57b8..ef2bed7e touches no docs.",
    "confidence": "high",
    "blocking_merge": false
  },
  {
    "id": "F-003",
    "reviewer": "opus-verification-r5",
    "severity": "info",
    "file": "src/harness/hooks/runtime.ts",
    "line": 262,
    "quote": "const RENAME_FROM_LINE = /^rename from (.+)$/;",
    "symbol": "extractRenameSourcePaths",
    "problem": "git C-quotes paths containing a double quote, a backslash, control characters or (by default) non-ASCII characters, for example rename from \"d\\303\\251j\\303\\240.ts\". extractRenameSourcePaths takes the captured text verbatim, quotes and escapes included.",
    "impact": "The gate still fires, but W8 computes evidence for a path that does not exist, so the reported importers are empty and misleading for exactly the renamed file. parsePatchTargets has the same gap for quoted ---/+++ headers, so this is a shared parser limitation.",
    "suggested_fix": "Unquote git C-style quoted paths (strip the surrounding quotes, decode octal and backslash escapes) in extractRenameSourcePaths and parsePatchTargets. Add a test with a quoted rename source.",
    "evidence": "Probe scratchpad/r5probe.ts: extractFilePathsFromToolInput on a patch containing 'rename from \"sp ace.ts\"' returned [\"a.ts\", \"\\\"sp ace.ts\\\"\"].",
    "confidence": "medium",
    "blocking_merge": false
  }
]
```
