import { appendFileSync } from "node:fs";

export const ENV_PHASE_TRACE = "KERYX_PHASE_TRACE";

/** Appends one timestamped line to the file named by `KERYX_PHASE_TRACE`; a no-op without it. */
export function tracePhase(label: string, env: Record<string, string | undefined> = process.env): void {
  const target = env[ENV_PHASE_TRACE];
  if (target === undefined || target === "") return;
  try {
    appendFileSync(target, `${new Date().toISOString()} ${label}\n`);
  } catch {
    // a trace that cannot be written must never disturb the turn it describes
  }
}
