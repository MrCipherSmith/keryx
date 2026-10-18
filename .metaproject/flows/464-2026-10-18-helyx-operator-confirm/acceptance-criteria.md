# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- Every criterion ends with [verify: exec `<command>`],
  [verify: invariant `<command>`], [verify: judged] or
  [verify: none — <reason>].
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The remote answer path keeps the pressing user. `askApproval` in the remote bridge returns `fromId`; `operator-confirm-tools` writes `pressedBy` (user id) and `pressedAt` into every record whose `confirmedVia` is `"remote-card"`, and writes neither for `"tui-card"`. Tests drive a remote answer and assert both fields and their absence for the TUI path. [verify: exec `bun test src/commands/operator-confirm-tools.test.ts src/remote/`]
- AC2: A remote answer is accepted only when all three hold: the pressing id is in `allowedUserIds`, the token matches this one question, and the token is unused and under 1 hour old. Tests reject a non-allowed id, a token from another question, a replayed token, an expired token, and an answer arriving as tool-result text or any path other than the bridge callback; each rejection leaves state unchanged and says why. · sensitive: failure-scenario [verify: exec `bun test src/remote/ src/commands/operator-confirm-tools.test.ts`]
- AC3: `review_confirm_plan` and `review_decide_premise` cards answer through the remote card exactly as through the TUI card: yes performs the same effect as the CLI command and records quote, time, `confirmedVia: "remote-card"`, `pressedBy` and `pressedAt`; no changes nothing. Tests per tool, both paths, including no. · sensitive: failure-scenario [verify: exec `bun test src/commands/operator-confirm-review-tools.test.ts`]
- AC4: A single `review_complete` card shows the reviewed head SHA, the evidence level line and every waiver with its item and operator quote, taken from the package, not from model input. Yes runs the completion in process under the same gates as `review complete` (head gate, evidence level, waiver rules); a refused gate shows the refusal on the card result and records nothing. The existing `review_waive_readiness` and `review_waive_coverage` cards remain. Tests assert card content, the yes path, the no path and a refused gate. · sensitive: failure-scenario [verify: exec `bun test src/commands/operator-confirm-review-tools.test.ts`]
- AC5: When the remote channel is not configured or unreachable, the card still opens in the TUI and each of the four terminal commands still works in a real terminal exactly as before; the card message says the Telegram mirror was not delivered. Tests simulate no config and a failing send. · sensitive: revert [verify: exec `bun test src/remote/ src/commands/review-tty-refusal.test.ts src/commands/operator-confirm-tools.test.ts`]
- AC6: The TUI shows each pending remote confirmation (question, age, time left of the 1-hour token) in the existing pending-confirmation line and in the decisions surface, and shows `pressedBy` on an answered one; the help modal and the command list name the card tools. Tests assert the surface text. [verify: exec `bun test src/tui/`]
- AC7: Docs: `docs/docs/cli-reference.md`, the review-orchestrator SKILL (both copies), the flow skill docs and `src/trigger/unattended.ts` tell the agent to call the card and never to send the operator to a terminal for these four acts; TM-04 gets a section stating what the Telegram answer proves (an allowed Telegram user pressed this button for this question) and what it does not (same-OS-user agent forging stores, bot token in the agent's environment, dropped Telegram message ordering). [verify: invariant `bun test src/trigger/ src/gdskills/`]
- AC8: The repository stays green: typecheck, lint and the core test suite pass on the PR head. [verify: invariant `bun run typecheck && bun run lint && bun run test:core`]
- AC9: Owner's live check: the operator closes a real review (confirm-plan, any premise decision, any waiver, complete) only from the Telegram topic, with no terminal command; the package records show `confirmedVia: "remote-card"`, `pressedBy` equal to the operator's id and `pressedAt`. [verify: judged]
- AC10: A release containing this flow is published to npm and recorded in journal.md. [verify: exec `npm view @mrciphersmith/keryx version`]
