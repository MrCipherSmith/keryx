import type { NormalizedMessage } from "../harness/provider/types";
import { recordSlateSessionTouch, type SlateSessionRef } from "./slate-lifecycle";
import { anchorsAnnouncement } from "./anchors-announce";

/** Shared native model-switch lifecycle used by the shipped TUI and headless SessionHost. */
export async function applyRuntimeSwitchToSlate(params: {
  slateSession: SlateSessionRef | undefined;
  runtime: { provider: string; model: string };
  history: NormalizedMessage[];
  onHistoryChange?: ((kind: "user" | "assistant_delta" | "assistant_final" | "tool") => void) | undefined;
}): Promise<boolean> {
  if (params.slateSession === undefined || !params.slateSession.opened) {
    return false;
  }
  const result = await recordSlateSessionTouch(params.slateSession, [], { runtime: params.runtime });
  if (result === undefined || !result.changed) {
    return false;
  }
  // Flow 387 T9: a runtime switch is a delta (`runtime:` line) once the model
  // has seen a full block; the full block only when history holds none.
  const announcement = anchorsAnnouncement(params.history, result.slate.anchors);
  if (announcement === undefined) {
    return false;
  }
  params.history.push(announcement);
  params.onHistoryChange?.("tool");
  return true;
}
