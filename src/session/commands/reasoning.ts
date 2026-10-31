import { isReasoningEffortLevel, type ReasoningEffortLevel } from "../../commands/agent";
import type { Control } from "../../remote-control/protocol";
import type { NativeCommandContribution } from "./handlers";

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

const effortSchema: Control["ArgumentSchema"] = { type: "string", maxLength: 16, enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] };
const versionSchema: Control["ArgumentSchema"] = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
/** `/reasoning` with no argument: the same shared operation shows the session's effective effort and the configuration version it belongs to. */
export function reasoningCommands(): NativeCommandContribution[] {
  return [{ entry: { commandName: "reasoning.show", summary: "Read this session's effective reasoning effort", handlerId: "native.reasoning.show",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] },
    resultSchema: { type: "object", additionalProperties: false, required: ["effort", "configVersion"], properties: { effort: effortSchema, configVersion: versionSchema } },
    mutationClass: "read", states: ["idle", "busy", "paused"], busyPolicy: "read-only", confirmation: "none", availability: "available", reason: "shared-reasoning-operation" },
  structuredResult: true,
  async execute(context) {
    const shown = executeReasoningCommand("", { current: context.record.config.reasoningEffort, commit() { throw new Error("reasoning-show-is-read-only"); } });
    if (!shown.ok) throw new Error("reasoning-show-refused");
    return { effort: shown.effort, configVersion: context.record.config.configVersion };
  } }];
}
