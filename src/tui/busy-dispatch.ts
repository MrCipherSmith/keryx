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
  | "think"
  | "expand"
  | "copy"
  | "mode"
  | "game"
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
}): BusyDispatchTarget {
  const { line, commandName, isSessionInfo, isFlows, isWorkspace, isReview, isMcp } = params;
  if (commandName === "/exit") return "exit";
  if (commandName === "/help") return "help";
  if (commandName === "/interrupt") return "interrupt";
  if (commandName === "/queue") return "queue";
  if (commandName === "/delegate") return "delegate";
  if (commandName === "/think") return "think";
  if (commandName === "/expand") return "expand";
  if (commandName === "/copy") return "copy";
  if (commandName === "/mode") return "mode";
  if (commandName === "/game") return "game";
  const isBusyReadonlyCommand = isSessionInfo || isFlows || isWorkspace || isReview || isMcp;
  if (isBusyReadonlyCommand && isSessionInfo) return "session-info";
  if (isBusyReadonlyCommand && isFlows) return "flows";
  if (isBusyReadonlyCommand && isWorkspace) return "workspace";
  if (isBusyReadonlyCommand && isReview) return "review";
  if (isBusyReadonlyCommand && isMcp) return "mcp";
  if (commandName !== undefined || line.startsWith("/")) return "deferred";
  return "not-a-command";
}
