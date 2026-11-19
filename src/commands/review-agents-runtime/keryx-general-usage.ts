import type { ReviewAgentRequestObservation } from "../../review/agents/types";
import { usageCounts, validUsageCounts } from "../../review/run-usage";

// Only the dedicated worker writes stdout. Final review content is encoded in a
// JSON object, so text returned by the model cannot inject a telemetry line.
export const reviewUsagePrefix = "KERYX_REQUEST ";

export function readWorkerOutput(observe?: ReviewAgentRequestObservation): (chunk: string, eof?: boolean) => string {
  let pending = "";
  let resultStarted = false;
  return (chunk, eof = false) => {
    if (resultStarted) return chunk;
    pending += chunk;
    while (pending.startsWith(reviewUsagePrefix)) {
      const end = pending.indexOf("\n");
      if (end < 0 && !eof && pending.length <= 4096) return "";
      if (end < 0 || end > 4096) throw new Error("invalid external request observation");
      const frame = JSON.parse(pending.slice(reviewUsagePrefix.length, end));
      if (!Number.isSafeInteger(frame?.number) || frame.number < 1 ||
        (frame.usage !== undefined && !validUsageCounts(frame.usage))) throw new Error("invalid external request observation");
      observe?.(frame.number, frame.usage === undefined ? undefined : usageCounts(frame.usage));
      pending = pending.slice(end + 1);
    }
    if (!eof && reviewUsagePrefix.startsWith(pending)) return "";
    resultStarted = true;
    const final = pending;
    pending = "";
    return final;
  };
}
