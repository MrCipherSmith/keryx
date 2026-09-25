// Flow 331, AC2 — stub adapters for components still in flight in other
// worktrees. Each reports `not available` for BOTH arms, always, without
// attempting to invoke a CLI verb that does not exist yet in this worktree —
// no code dependency on flow 328/330/the later severity-calibration flow, as
// the flow 331 brief requires.
import type { ComponentAdapter, ComponentResult } from "../types";

function notAvailableAdapter(id: string, reason: string): ComponentAdapter {
  return {
    id,
    available: false,
    unavailableReason: reason,
    async run(arm): Promise<ComponentResult> {
      return { component: id, arm, available: false, reason };
    },
  };
}

/** Flow 328: `keryx flow check-ac`. */
export function flowCheckAcAdapter(): ComponentAdapter {
  return notAvailableAdapter("flow-check-ac", "flow 328 (`keryx flow check-ac`) has not landed in this worktree yet.");
}

/** Flow 330: `keryx review jev-rules`. */
export function reviewJevRulesAdapter(): ComponentAdapter {
  return notAvailableAdapter("review-jev-rules", "flow 330 (`keryx review jev-rules`) has not landed in this worktree yet.");
}

/** A later, not-yet-numbered flow: severity calibration and duplicate merge. */
export function severityCalibrationAdapter(): ComponentAdapter {
  return notAvailableAdapter("severity-calibration", "severity calibration / duplicate merge has not landed in this worktree yet (no flow number assigned as of flow 331).");
}
