// Pure classification of `runLine`'s busy-branch dispatch (flow 172 T5,
// operator-requested test-coverage addendum; see
// docs/requirements/keryx-tui-busy-command-allowlist/trd.md §8).
//
// This is a straight transcription of the busy branch's `if`-chain ordering
// in `tui-shell.ts` (`if (chrome.isBusy()) { ... }`) into a returned tag, so
// the dispatch logic can be unit-tested directly without mounting any
// renderer/chrome. Deliberately has ZERO dependency on `@opentui/core`, any
// renderer, or `chrome` — keep it that way.

/** Every distinct outcome `runLine`'s busy branch can dispatch to. */
export type BusyDispatchTarget =
  | "exit"
  | "help"
  | "interrupt"
  | "queue"
  /**
   * `/delegate` (flow 176 T18): starting an external child WHILE the main agent
   * works is the point of the command, not an edge case — the operator hands a
   * side investigation to a vendor CLI precisely so it runs alongside. Deferring
   * it to a side worker would silently turn a paid external run into an
   * in-process one.
   */
  | "delegate"
  | "session-info"
  | "flows"
  | "workspace"
  | "review"
  | "mcp"
  | "mcp-consumer"
  | "think"
  | "expand"
  | "copy"
  | "mode"
  | "plan"
  /**
   * `/demote` (flow 266 AC8): moving a running task to the background is most
   * useful precisely WHILE the main agent is busy — a turn blocked on its own
   * command is the case the command exists for. Deferring it would make the
   * capability available only when it is not needed.
   */
  | "demote"
  | "game"
  /**
   * `/bus` (flow 273, specification §7.2): messaging and viewing peers on the
   * project agent bus is read-only from this instance's own point of view —
   * the same reasoning as `/status`/`/flows` above — and an operator override
   * of a `turns` lease has to reach the bus from a held instance, so it must
   * never be deferred.
   */
  | "bus"
  /**
   * `/governance` and `/triggers` (flow 300): opening either modal is
   * read-only, and each one's action — a governance report written in this
   * process, or `keryx trigger run` in a CHILD process — never touches the main
   * turn, so neither waits for it.
   */
  | "governance"
  | "triggers"
  | "deferred"
  | "not-a-command";

/**
 * Classifies a submitted line into the busy-branch dispatch target
 * `runLine` would route it to, while a main agent turn is in progress.
 * Order matters and mirrors the live `if`-chain exactly.
 */
export function classifyBusyDispatch(params: {
  line: string;
  commandName: string | undefined;
  isSessionInfo: boolean;
  isFlows: boolean;
  isWorkspace: boolean;
  isReview: boolean;
  isMcp: boolean;
  /** `/mcp`, the consumer view. Read-only, so allowed while busy. */
  isMcpConsumer: boolean;
}): BusyDispatchTarget {
  const { line, commandName, isSessionInfo, isFlows, isWorkspace, isReview, isMcp, isMcpConsumer } = params;
  if (commandName === "/exit") return "exit";
  if (commandName === "/help") return "help";
  if (commandName === "/interrupt") return "interrupt";
  if (commandName === "/queue") return "queue";
  if (commandName === "/delegate") return "delegate";
  if (commandName === "/think") return "think";
  if (commandName === "/expand") return "expand";
  if (commandName === "/copy") return "copy";
  if (commandName === "/mode") return "mode";
  if (commandName === "/plan") return "plan";
  if (commandName === "/demote") return "demote";
  if (commandName === "/game") return "game";
  if (commandName === "/bus") return "bus";
  if (commandName === "/governance") return "governance";
  if (commandName === "/triggers") return "triggers";
  const isBusyReadonlyCommand = isSessionInfo || isFlows || isWorkspace || isReview || isMcp || isMcpConsumer;
  if (isBusyReadonlyCommand && isSessionInfo) return "session-info";
  if (isBusyReadonlyCommand && isFlows) return "flows";
  if (isBusyReadonlyCommand && isWorkspace) return "workspace";
  if (isBusyReadonlyCommand && isReview) return "review";
  // BEFORE `isMcp`, mirroring the live if-chain, which this function
  // exists to predict. The two must stay in the same order or this
  // classifier answers for a route the shell does not take.
  if (isBusyReadonlyCommand && isMcpConsumer) return "mcp-consumer";
  if (isBusyReadonlyCommand && isMcp) return "mcp";
  if (commandName !== undefined || line.startsWith("/")) return "deferred";
  return "not-a-command";
}
