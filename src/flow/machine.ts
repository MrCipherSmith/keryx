import type { FlowStatus } from "./types";

// Strict status state machine (spec section 6). The CLI is the only writer of
// flow state, and every transition must be listed here.
const TRANSITIONS: Record<FlowStatus, FlowStatus[]> = {
  initializing: ["ready", "blocked"],
  ready: ["in-progress", "blocked"],
  "in-progress": ["implemented", "blocked"],
  implemented: ["completing", "blocked"],
  completing: ["done", "in-progress", "blocked"],
  blocked: [], // unblock restores previousStatus explicitly
  done: [],
};

export function canTransition(from: FlowStatus, to: FlowStatus): boolean {
  if (to === "blocked") {
    return from !== "done" && from !== "blocked";
  }
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: FlowStatus, to: FlowStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Invalid flow transition: ${from} -> ${to}. Allowed from ${from}: ${[
        ...(TRANSITIONS[from] ?? []),
        ...(from !== "done" && from !== "blocked" ? ["blocked"] : []),
      ].join(", ") || "(none)"}`,
    );
  }
}
