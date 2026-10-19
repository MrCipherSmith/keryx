// Where an approval of a turn typed in the shell is answered (flow 419, AC1 and AC2).
//
// The dock opens in the terminal; when remote control is on, the same question is posted to the topic at
// the moment the dock opens (a call that is auto-approved never reaches the topic). The first answer wins and
// the other place is taken down: a press in the topic aborts the dock, an answer in the dock aborts the topic
// leg, which tells serve to remove the buttons. Silence in the topic (a timeout, no connection) never ends
// the question; the dock stays. Kept apart from the TUI so the race can be tested without a renderer.

import type { RemoteApprovalAnswer } from "../remote/shell-bridge";

/** What the dock-opening code in the shell sees of the race. */
export interface DockRace {
  /** Aborted when the turn stops or the topic answered first: the dock closes. */
  readonly signal: AbortSignal;
  /** The dock just opened: the topic leg starts (once). */
  opened(): void;
  /** The topic answered first. The dock's own result is then to be thrown away. */
  topicWon(): boolean;
}

export type ApprovalRaceOutcome<V> = { from: "dock"; result: V } | { from: "topic"; answer: RemoteApprovalAnswer };

/** An explicit press in the topic: an allow, or a deny that names who pressed. A timeout or an abort is neither. */
export function isTopicPress(answer: RemoteApprovalAnswer): boolean {
  return answer.decision === "allow" || answer.fromId !== undefined;
}

export async function raceApproval<V>(options: {
  /** Runs the dock; resolves with its verdict, or early when `race.signal` aborted it. */
  dock: (race: DockRace) => Promise<V>;
  /** Asks in the topic; the answer is judged by {@link isTopicPress}. `signal` aborts it, with the reason "shell" or "cancelled". */
  topic: (signal: AbortSignal) => Promise<RemoteApprovalAnswer>;
  /** The turn stopped: both places are closed, the topic one as cancelled. */
  turnSignal: AbortSignal;
  /** Flow 464: the topic leg ended because the question never reached the topic; the dock stays and is the only place. */
  onUndelivered?: () => void;
}): Promise<ApprovalRaceOutcome<V>> {
  const dockAbort = new AbortController();
  const topicAbort = new AbortController();
  let topicAnswer: RemoteApprovalAnswer | undefined;
  let settled = false;
  let started = false;
  const race: DockRace = {
    signal: AbortSignal.any([options.turnSignal, dockAbort.signal]),
    opened: () => {
      if (started || settled) return;
      started = true;
      void options
        .topic(topicAbort.signal)
        .then((answer) => {
          if (settled) return;
          if (answer.undelivered === true) options.onUndelivered?.();
          if (!isTopicPress(answer)) return;
          topicAnswer = answer;
          dockAbort.abort("topic");
        })
        .catch(() => undefined);
    },
    topicWon: () => topicAnswer !== undefined,
  };
  try {
    const result = await options.dock(race);
    if (topicAnswer !== undefined) return { from: "topic", answer: topicAnswer };
    return { from: "dock", result };
  } finally {
    settled = true;
    // answered in the dock: serve says "answered in the shell"; the turn stopped: "cancelled". A leg that
    // already ended ignores the abort, so a press that won keeps its own final state.
    if (topicAnswer === undefined) topicAbort.abort(options.turnSignal.aborted ? "cancelled" : "shell");
  }
}
