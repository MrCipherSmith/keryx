import { isReasoningEffortLevel, type ReasoningEffortLevel } from "../../commands/agent";

export interface ReasoningCommandHost {
  current: string | undefined;
  commit(effort: ReasoningEffortLevel): void;
  permitted?: (effort: ReasoningEffortLevel) => boolean;
}
/** Shared application operation; each local/session adapter owns persistence scope and rendering. */
export function executeReasoningCommand(wanted: string, host: ReasoningCommandHost):
  { ok: true; effort: string; changed: boolean } | { ok: false; error: "invalid-arguments" | "policy-denied" } {
  if (wanted.length === 0) return { ok: true, effort: host.current ?? "off", changed: false };
  if (!isReasoningEffortLevel(wanted)) return { ok: false, error: "invalid-arguments" };
  if (host.permitted !== undefined && !host.permitted(wanted)) return { ok: false, error: "policy-denied" };
  host.commit(wanted);
  return { ok: true, effort: wanted, changed: true };
}
