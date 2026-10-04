// Where an ask_user question of a Telegram-started turn is answered (flow 401, AC7).
//
// The operator may be at the keyboard or in the topic, so the question is shown in both: the dock and a
// topic message with the own-answer button. The first answer wins and the other place is closed. Silence in
// the topic (a timeout, no connection, a closed message) never ends the question here: the dock stays.
//
// Kept apart from the TUI so the race can be tested without a renderer.

import type { AskUserAnswer } from "../harness/tool/builtin/ask-user-tool";

export type AskRaceOutcome<D> = { from: "dock"; result: D } | { from: "topic"; answer: AskUserAnswer };

export async function raceAskUser<D>(options: {
  /** Shows the dock; resolves when it was answered, or when `signal` aborted it. */
  dock: (signal: AbortSignal) => Promise<D>;
  /** Asks in the topic; resolves undefined when nobody answered there. Absent: the dock alone. */
  topic?: (signal: AbortSignal) => Promise<AskUserAnswer | undefined>;
  /** The turn stopped: both places are closed, the topic one as cancelled. */
  turnSignal: AbortSignal;
}): Promise<AskRaceOutcome<D>> {
  const dockAbort = new AbortController();
  const topicAbort = new AbortController();
  const stop = (): void => {
    topicAbort.abort("cancelled");
    dockAbort.abort("cancelled");
  };
  if (options.turnSignal.aborted) {
    stop();
  } else {
    options.turnSignal.addEventListener("abort", stop, { once: true });
  }
  let topicWon = false;
  try {
    const dockRun = options.dock(dockAbort.signal).then((result): AskRaceOutcome<D> => ({ from: "dock", result }));
    if (options.topic === undefined) {
      return await dockRun;
    }
    const topicRun = options
      .topic(topicAbort.signal)
      .catch(() => undefined)
      .then((answer) => (answer === undefined ? new Promise<AskRaceOutcome<D>>(() => undefined) : { from: "topic" as const, answer }));
    const first = await Promise.race([dockRun, topicRun]);
    if (first.from === "dock") {
      // answered (or stopped) at the keyboard: the topic message is closed as answered in the shell
      topicAbort.abort(options.turnSignal.aborted ? "cancelled" : "shell");
    } else {
      // answered in the topic: the dock is taken down, and its own (cancel) result is dropped
      topicWon = true;
      dockAbort.abort("topic");
      await dockRun;
    }
    return first;
  } finally {
    options.turnSignal.removeEventListener("abort", stop);
    // however the race ended (a dock leg that rejected included) neither place is left open; an abort
    // after the fact is a no-op, so a place already closed keeps the reason it was closed with
    dockAbort.abort("cancelled");
    if (!topicWon) topicAbort.abort("cancelled");
  }
}
