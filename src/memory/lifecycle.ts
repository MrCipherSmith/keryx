import type { MemoryStatus } from "./types";

export type LifecycleError = {
  code: "invalid-transition" | "terminal-state";
  from: MemoryStatus;
  to: MemoryStatus;
  message: string;
};

export type LifecycleTransition =
  | { ok: true; changed: boolean }
  | { ok: false; error: LifecycleError };

const ALLOWED: Record<MemoryStatus, readonly MemoryStatus[]> = {
  draft: ["accepted", "conflict", "deprecated"],
  accepted: ["draft", "conflict", "deprecated"],
  conflict: ["draft", "accepted", "deprecated"],
  deprecated: ["draft"],
  superseded: [],
};

/** Pure lifecycle transition table. Supersession is a separate pair operation. */
export function transitionMemoryStatus(from: MemoryStatus, to: MemoryStatus): LifecycleTransition {
  if (from === to) {
    return { ok: true, changed: false };
  }
  if (from === "superseded") {
    return {
      ok: false,
      error: {
        code: "terminal-state",
        from,
        to,
        message: "A superseded memory entry is terminal and cannot be transitioned.",
      },
    };
  }
  if (!ALLOWED[from].includes(to)) {
    return {
      ok: false,
      error: {
        code: "invalid-transition",
        from,
        to,
        message: `Cannot transition memory entry from ${from} to ${to}.`,
      },
    };
  }
  return { ok: true, changed: true };
}
