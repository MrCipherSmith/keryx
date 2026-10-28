import type { Control } from "../../remote-control/protocol";
import type { NativeCommandContribution } from "./handlers";
const id: Control["ArgumentSchema"] = { type: "string", maxLength: 200 };
const object = (properties: Record<string, Control["ArgumentSchema"]>, required = Object.keys(properties)): Control["ArgumentSchema"] => ({ type: "object", properties, required, additionalProperties: false });
const schemas = {
  model: object({ candidateId: id }, []),
  "route.set": object({ enabled: { type: "boolean" } }),
  "routing.configure": object({ enabled: { type: "boolean" }, profileId: id, candidateIds: { type: "array", items: id, maxItems: 128 }, fallbackCandidateId: id }),
};
const version: Control["ArgumentSchema"] = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const timing = { configVersion: version, effectiveFromTurnOrdinal: version };
export const sessionConfigResultSchemas: Record<string, Control["ArgumentSchema"]> = {
  model: object({ ...timing, candidateIds: { type: "array", items: id, maxItems: 128 }, baselineCandidateId: id }),
  "route.set": object({ ...timing, enabled: { type: "boolean" } }),
  "routing.configure": object({ ...timing, enabled: { type: "boolean" }, profileId: id, candidateIds: { type: "array", items: id, maxItems: 128 }, fallbackCandidateId: id }),
};
export function sessionConfigCommandResult(name: string, config: Control["SessionConfig"], candidates: Control["RoutingAvailability"]["candidates"], ordinal: number): Control["BoundedJson"] {
  const timing = { configVersion: config.configVersion, effectiveFromTurnOrdinal: ordinal };
  if (name === "reasoning") return config.reasoningEffort;
  if (name === "model" || name === "connect.select") return { ...timing, baselineCandidateId: config.baselineCandidateId, candidateIds: candidates.filter((candidate) => candidate.available && candidate.reason === "none").map((candidate) => candidate.candidateId) };
  if (name === "route.set") return { ...timing, enabled: config.routing.enabled };
  return { ...timing, ...config.routing };
}
export function sessionSettingsCommands(): NativeCommandContribution[] {
  return Object.entries(schemas).map(([commandName, inputSchema]) => ({ entry: { commandName, summary: commandName === "model" ? "Inspect or select the locally permitted manual baseline" : "Change session routing for subsequent turns",
    handlerId: `native.config.${commandName}`, inputSchema, resultSchema: sessionConfigResultSchemas[commandName]!, mutationClass: "session", states: ["idle", "busy", "paused"],
    busyPolicy: "reject", confirmation: "none", availability: "available", reason: "exact-session-config-transaction" },
  structuredResult: true,
  async execute(context, request) { if (request.commandName !== "model" || Object.keys(request.arguments as object).length !== 0) throw new Error("host-config-transaction-required");
    return sessionConfigCommandResult("model", context.record.config, context.runtime.routing(context.record.config).availability().candidates, context.record.nextTurnOrdinal); } }));
}
export function sessionConfigProposal(command: Control["CommandInvoke"], config: Control["SessionConfig"]): Pick<Control["ConfigChange"], "baselineCandidateId" | "routing" | "reasoningEffort"> | undefined {
  const args = command.arguments;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  // `/connect` selection picks a locally allowed candidate exactly like a manual model pick: one idle-boundary config transaction.
  const picked = command.commandName === "model" ? args.candidateId : command.commandName === "connect.select" ? args.id : undefined;
  if (typeof picked === "string") return { baselineCandidateId: picked, reasoningEffort: config.reasoningEffort,
    routing: config.routing.enabled ? { ...config.routing, fallbackCandidateId: picked, candidateIds: [...new Set([...config.routing.candidateIds, picked])] }
      : { ...config.routing, candidateIds: [picked], fallbackCandidateId: picked } };
  if (command.commandName === "route.set" && typeof args.enabled === "boolean") return { baselineCandidateId: config.baselineCandidateId, reasoningEffort: config.reasoningEffort, routing: { ...config.routing, enabled: args.enabled } };
  if (command.commandName === "routing.configure") return { baselineCandidateId: config.baselineCandidateId, reasoningEffort: config.reasoningEffort, routing: args as Control["SessionConfig"]["routing"] };
  return undefined;
}
