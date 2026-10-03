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
  | "setup"
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
  /**
   * `/product` (flow 362): a read-only list over the derived intent index. It
   * never rebuilds the index and never touches the main turn.
   */
  | "product"
  /**
   * `/reviews`: the managed pull request reviews and what the bot's findings
   * came to. Read-only over the packages on disk; never touches the main turn.
   */
  | "reviews"
  /**
   * `/remote-control` (flow 376): the status modal, turning it off, and turning it on
   * all work WHILE a turn runs, the same reason as `/bus`: the operator reaches for it
   * from a shell that is busy, often a turn that came from Telegram. It never touches
   * the main turn.
   */
  | "remote-control"
  /**
   * `/history` (flow 399): posts the session's last messages to the remote-control topic. It only
   * reads the session and writes to the topic, so it works while a turn runs, like its sibling.
   */
  | "history"
  /**
   * `/channels` (flow 377): connect, test or disconnect Telegram for this machine. It talks to
   * `keryx serve` and the user-global config, never to the main turn, so it works while one runs.
   */
  | "channels"
  /**
   * `/remote-policy` (flow 396): the saved Telegram defaults. It edits a file and the bridge's own copy;
   * it never touches the main turn or the shell's mode, so it works while a turn runs.
   */
  | "remote-policy"
  /**
   * `/schedules` (flow 295): the Schedules list and detail modals. Opening them is
   * read-only; their actions (pause, resume, delete, run-now as a CHILD process)
   * never touch the main turn.
   */
  | "schedules"
  /**
   * `/approvals` (flow 369): the pending remote approvals. Listing is read-only and an
   * answer is one call, once, in the store; neither touches the main turn.
   */
  | "approvals"
  /**
   * `/permissions` (flow 396): the saved shell rules. Listing and removing one edit a file on disk and
   * the shell's own rule set; neither touches the main turn.
   */
  | "permissions"
  /**
   * `/decisions` (flow 392): the recommendation journal's report. A read-only look at
   * a file on disk; it never touches the main turn.
   */
  | "decisions"
  /**
   * `/external-diff` (flow 370): claude write runs awaiting review. Landing cuts a new local
   * branch in a throwaway worktree, so it never touches the main turn's checkout.
   */
  | "external-diff"
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
  if (commandName === "/setup") return "setup";
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
  if (commandName === "/product") return "product";
  if (commandName === "/reviews") return "reviews";
  if (commandName === "/remote-control") return "remote-control";
  if (commandName === "/history") return "history";
  if (commandName === "/channels") return "channels";
  if (commandName === "/remote-policy") return "remote-policy";
  if (commandName === "/schedules") return "schedules";
  if (commandName === "/approvals") return "approvals";
  if (commandName === "/permissions") return "permissions";
  if (commandName === "/decisions") return "decisions";
  if (commandName === "/external-diff") return "external-diff";
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
