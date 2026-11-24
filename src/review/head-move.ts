// What a review does when its PR head moves: ask, follow, or stay behind.
import type { DeskRun } from "./desk-run-types";

export const ON_HEAD_MOVE = ["ask", "follow", "ignore"] as const;
export type OnHeadMove = (typeof ON_HEAD_MOVE)[number];

/** Manual and existing reviews ask; a rule-triggered (scheduled) review follows. */
export function defaultOnHeadMove(source: DeskRun["source"]): OnHeadMove {
  return source === "scheduled" ? "follow" : "ask";
}

/** Read a stored value; missing, null or unknown falls back to the source default. */
export function parseOnHeadMove(value: unknown, source: DeskRun["source"]): OnHeadMove {
  return ON_HEAD_MOVE.find((mode) => mode === value) ?? defaultOnHeadMove(source);
}

export type HeadMovePhase = "running" | "finished";
/** `update` applies only when no round is running: start the update round now. */
export type HeadMoveAction = "update-after-finish" | "stop-and-restart" | "update";

export type HeadMoveResponse =
  /** The review stays behind; nothing is offered or queued. */
  | { kind: "none" }
  /** Show the user these actions and wait for a choice. */
  | { kind: "offer"; actions: readonly HeadMoveAction[] }
  /** Queue an update round automatically, now or once the running round finishes. */
  | { kind: "queue-update"; when: "now" | "after-finish" };

/** The spec table: the mode and the round phase decide the response to a moved head. */
export function headMoveResponse(mode: OnHeadMove, phase: HeadMovePhase): HeadMoveResponse {
  if (mode === "ignore") return { kind: "none" };
  if (mode === "follow") {
    return { kind: "queue-update", when: phase === "running" ? "after-finish" : "now" };
  }
  return {
    kind: "offer",
    actions: phase === "running" ? ["update-after-finish", "stop-and-restart"] : ["update"],
  };
}
