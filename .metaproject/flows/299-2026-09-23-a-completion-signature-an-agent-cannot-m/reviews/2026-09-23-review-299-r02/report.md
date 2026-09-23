# Review — flow 299, terminal confirmation token and a way out of `completing` (PR #661)

Two adversarial security review rounds covered the flow 299 diff:
- the token store, check and spend (`src/flow/confirm-token.ts`);
- the confirmation gate, `confirmMint` and `recover` (`src/flow/service.ts`), and `src/flow/store.ts`;
- `flow confirm` / `flow recover` (`src/commands/flow.ts`);
- the approval and unattended floors (`src/lib/command-risk.ts`, `src/lib/shell-permissions.ts`,
  `src/commands/shell-approval.ts`, `src/trigger/unattended.ts`);
- the registry descriptors, and the TM-03 decision record.

The review was held against TM-03's own claim, "friction and an honest record, not proof". Its five
documented bypasses were out of scope and are not reported: a faked pty, a forged hash store,
obfuscated command text, agents outside keryx, and a hand-edited opt-in flag.

**Round 1** (against 283dd7ba) raised six findings:
- two of medium weight (recorded here as `major`): a remembered shell grant silently answering the
  `flow confirm` approval prompt, and a token not bound to the completion target the operator was
  shown;
- four low ones.

It also confirmed what held up:
- `complete()` is the only path to `done`;
- concurrent completes serialize on the flow lock;
- a spent token cannot be replayed after `flow recover`;
- the plaintext token never reaches disk, history or the journal;
- `flow recover` refuses correctly while a live `complete` holds the lock (probed with two
  processes).

**Round 2** (against fix commit 084380c9) found all six fixed and raised two LOW notes: that
`--merged` binds no commit, and that the `flow confirm` descriptor had agent-facing intents. Both
were addressed in head `21c29e76`.

PR #661 squash-merged into `main` as `dbacee36c553946b1026a33956ade21f5f2e2a39`. Every finding
below was re-checked against that merge commit. The flow-299-owned files are identical between head
`21c29e76` and the merge; the only difference in `src/flow` is `src/flow/templates.ts`, from another
PR.

Two re-review questions turned out not to be defects:
- **Two spellings of one PR URL** (e.g. a trailing slash) make `target` differ. The completion then
  fails closed with `token_target_mismatch`, at the cost of one re-mint. Two different PRs cannot
  match: the comparison is an exact string compare on the same `flow.pr.url` field.
- **A store minted before `target` existed** is rejected by `parseStoredToken` as
  `token_unreadable`. It fails closed, and the 10-minute TTL makes it moot in practice.

The same probes confirmed that SAC's `workspace confirm-review` path is still never auto-approved,
and that the new word-bounded marker matches `keryx flow  confirm` (several spaces), a tab and
uppercase.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "security-reviewer (flow 299)",
    "severity": "major",
    "file": "src/commands/shell-approval.ts",
    "quote": "evaluateShellApproval",
    "problem": "The interactive approver recomputed its human-confirmation flag with `touchesSacConfirmReview` only. So after `executeCall` forced `ask` for `keryx flow confirm`, a session pattern such as `keryx flow *`, or a remembered exact grant, auto-approved it. `validateShellPattern` accepted storing it, and readline offered `A=always`.",
    "impact": "One 'always' answer, or a broad `keryx flow *` grant, meant the approval prompt TM-03 §2 promised 'in every permission mode' never fired again for `flow confirm`. The TTY requirement still blocked a captured shell_exec from minting, so the friction layer was lost, not the gate.",
    "suggested_fix": "Use `touchesHumanConfirmation` at every approver site: evaluateShellApproval, validateShellPattern, isShellCommandAllowed and suggestShellPatterns.",
    "evidence": "Probe (round 1): evaluateShellApproval('keryx flow confirm 299') with sessionAllow {'keryx flow *'} returned autoApprove: true; the same with the exact grant; validateShellPattern returned ok: true for both.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/commands/shell-approval.ts evaluateShellApproval",
        "src/lib/shell-permissions.ts validateShellPattern",
        "src/lib/shell-permissions.ts isShellCommandAllowed",
        "src/lib/shell-permissions.ts suggestShellPatterns",
        "src/commands/shell.ts rememberable (reads evaled.sacReviewConfirmation)"
      ],
      "enumeration_method": "keryx ctx rg over src for touchesSacConfirmReview / sacReviewConfirmation outside tests: agent.ts, acp-permission.ts and supervise-mcp.ts had already switched to touchesHumanConfirmation; the listed sites were every remaining caller."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "Fix commit 084380c9; merged in dbacee36 (#661): shell-approval.ts:74, shell-permissions.ts:144, :411, :477 all use touchesHumanConfirmation."
    }
  },
  {
    "id": "F-002",
    "reviewer": "security-reviewer (flow 299)",
    "severity": "major",
    "file": "src/flow/confirm-token.ts",
    "quote": "mintConfirmationToken",
    "problem": "The mint showed the operator a completion target: the PR URL, or 'direct merge' for --merged. But the stored binding was only {flowId, kind, acChecksum}, so the target the operator confirmed was not enforced at `flow complete`.",
    "impact": "A token minted while looking at pull/1 could complete the flow after it was re-pointed: a failed attempt returns it to in-progress, then `flow implemented --pr pull/999`. A token minted for a PR completion could also be spent on `--merged`.",
    "suggested_fix": "Record the target (`pr:<url>` or `merged`) in the store and in the signature's boundTo, and fail a mismatch with a named reason.",
    "evidence": "Probe P1 (round 1): mint on pull/1, complete without a token (fails, back to in-progress), implemented --pr pull/999, then complete --confirm-token <same> passed, with pr.url = pull/999.",
    "confidence": "high",
    "class_scope": {
      "sites": [
        "src/flow/service.ts confirmMint (producer of the binding)",
        "src/flow/service.ts confirmationGate / src/flow/confirm-token.ts checkConfirmationToken (the only consumer)",
        "src/flow/confirm-token.ts consumeConfirmationToken (the signature's boundTo)"
      ],
      "enumeration_method": "The store has exactly one writer (mintConfirmationToken, called only from confirmMint; pinned by confirm-floors.test.ts) and one reader (checkConfirmationToken, called only from confirmationGate); consumeConfirmationToken is the only producer of SignatureConfirmation."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "Fix commit 084380c9; merged in dbacee36 (#661): confirm-token.ts:192 returns token_target_mismatch; service.ts:878 (complete) and :1197 (confirmMint) both derive the target from completionTarget()."
    }
  },
  {
    "id": "F-003",
    "reviewer": "security-reviewer (flow 299)",
    "severity": "minor",
    "file": "src/lib/command-risk.ts",
    "quote": "touchesFlowConfirm",
    "problem": "The `flow confirm` marker was a plain substring match with no word boundary, and the unattended floor refused any command naming the bare stem `confirm-token`.",
    "impact": "`git commit -m \"ci: workflow confirmation step\"` and `echo overflow confirmed` forced `ask` even in auto mode. Unattended runs refused `bun test src/flow/confirm-token.test.ts` and `cat src/sac/review-confirm-token.ts`.",
    "suggested_fix": "Use a word-bounded regex (/\\bflow\\s+confirm\\b/i), and make the unattended marker the file name `confirm-token.json`.",
    "evidence": "Probe (round 1): touchesHumanConfirmation returned true for both false-positive strings, and unattendedShellRefusal refused both commands.",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fix commit 084380c9; merged in dbacee36 (#661): command-risk.ts:382 FLOW_CONFIRM_MARKER = /\\bflow\\s+confirm\\b/i; unattended.ts:96 marker is \"confirm-token.json\"."
    }
  },
  {
    "id": "F-004",
    "reviewer": "security-reviewer (flow 299)",
    "severity": "minor",
    "file": "src/flow/confirm-token.ts",
    "quote": "checkConfirmationToken",
    "problem": "A corrupt store failed closed, but under the wrong reason. `null` threw a TypeError that the gate recorded as a generic 'could not be evaluated'; `[]`, `{}` and `42` reported token_mismatch. A missing or invalid `expiresAt` compared as NaN and would never expire. The token_other_flow prefix check hard-coded 3-digit flow ids.",
    "impact": "The named-reason contract of AC2 was broken for an unreadable store. A store without a valid expiry would have been accepted indefinitely.",
    "suggested_fix": "Validate the store's shape before trusting it (token_unreadable), treat an unparsable expiry as unreadable, and accept any number of digits in the flow-id prefix.",
    "evidence": "Probe P3 (round 1): null gave 'confirmation gate could not be evaluated'; [], {} and 42 gave token_mismatch.",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fix commit 084380c9; merged in dbacee36 (#661): confirm-token.ts:139 parseStoredToken, :150 !isInstant(record[\"expiresAt\"]), :172 /^\\d+$/ prefix check."
    }
  },
  {
    "id": "F-005",
    "reviewer": "security-reviewer (flow 299)",
    "severity": "minor",
    "file": "src/flow/service.ts",
    "quote": "isLockHeld(lock)",
    "problem": "After a `complete` process was killed, its lock stayed fresh for ~30s. During that window `flow recover` refused with 'a `flow complete` is probably still running', and `flow status` showed no hint.",
    "impact": "The operator was told a crashed completion was still running. The wording was misleading; the behaviour was correct.",
    "suggested_fix": "Say that a crashed completion becomes recoverable once its lock goes stale, and show an in-progress line in `flow status`.",
    "evidence": "Two-process probe (round 1): kill -9 the complete, then recover within 30s: refused with the misleading message; after 31s, recovered.",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fix commit 084380c9; merged in dbacee36 (#661): service.ts:1232 refusal names the stale-lock window; store.ts:38 completionInProgressLine shown by flow status."
    }
  },
  {
    "id": "F-006",
    "reviewer": "security-reviewer (flow 299)",
    "severity": "minor",
    "file": "docs/decisions/keryx-harness/TM-03-terminal-confirmation-token.md",
    "quote": "Older keryx",
    "problem": "Every completion attempt now records a `confirmation` gate outcome, even when skipped. An older keryx's `flow check` validates gateOutcome.name against a closed enum without it, so TM-03 §8's 'additive' held only for readers at 299 or later, and the record did not say so.",
    "impact": "Older keryx binaries report a schema issue on every flow completed by 299+. That is expected, as with `owner` before, but it was undocumented.",
    "suggested_fix": "State in TM-03 §8 that older keryx flags the new gate name, and that old code reading new flows is not a goal.",
    "evidence": "Reasoned from src/flow/schema.ts gateOutcome.name enum and the flow check validation path (service.ts, validateAgainstSchemaObject(flowStateSchema(), raw)).",
    "confidence": "medium",
    "disposition": {
      "state": "acted-on",
      "evidence": "Fix commit 084380c9; merged in dbacee36 (#661): TM-03-terminal-confirmation-token.md:182 'Older keryx' paragraph."
    }
  },
  {
    "id": "F-007",
    "reviewer": "security-reviewer (flow 299)",
    "severity": "minor",
    "file": "docs/decisions/keryx-harness/TM-03-terminal-confirmation-token.md",
    "quote": "--merged",
    "problem": "A token minted with --merged binds only `merged`, not a commit, and TM-03 did not say so. `flow confirm --merged` is also accepted on an `implemented` flow that records a PR.",
    "impact": "A reader of TM-03 could take a --merged token to pin the merged commit. It does not: complete --merged <any commit> passes the confirmation gate.",
    "suggested_fix": "Say it in TM-03 §2 and the CLI reference.",
    "evidence": "Probe P2b (round 2, on 084380c9): mint --merged, then complete --merged 0000000 gave confirmation = pass.",
    "confidence": "high",
    "disposition": {
      "state": "acted-on",
      "evidence": "Head 21c29e76; merged in dbacee36 (#661): TM-03-terminal-confirmation-token.md:29 Mint row 'With `--merged` the token binds only `merged`, not a commit'; docs/docs/cli-reference.md:2116 carries the same sentence."
    }
  },
  {
    "id": "F-008",
    "reviewer": "security-reviewer (flow 299)",
    "severity": "info",
    "file": "src/standard/command-registry.ts",
    "quote": "command: \"flow confirm\"",
    "problem": "The new `flow confirm` descriptor advertised agent-facing intents ('confirm flow completion'), which pointed an agent asked to confirm a completion at a human-only verb.",
    "impact": "Friction only: the approval floor and the TTY check stop the attempt, but the agent is steered toward a prompt it cannot satisfy.",
    "suggested_fix": "Make the descriptor operator-phrased, and tell an agent to ask the operator to run it.",
    "evidence": "Registry read (round 2, on 084380c9): intent included 'confirm flow completion' and 'подтверди завершение флоу'.",
    "confidence": "medium",
    "disposition": {
      "state": "acted-on",
      "evidence": "Head 21c29e76; merged in dbacee36 (#661): command-registry.ts:530-539 summary tells an agent to ask the operator; intents are ['flow confirm', 'operator mints flow confirmation token']."
    }
  }
]
```
