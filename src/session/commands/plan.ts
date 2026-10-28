import type { Control } from "../../remote-control/protocol";
import type { NativeCommandContribution } from "./handlers";
export interface SessionRestriction { enabled: boolean; configVersion: number; effectiveFromTurnOrdinal: number; restrictionDigest: string }
/** The shipped local clients and native host share this exact readonly state operation. Authority and idle admission belong to their host. */
export function executePlanCommand(input: string, state: { current: boolean; commit(enabled: boolean): void }): { ok: true; enabled: boolean } | { ok: false } {
  if (input === "") return { ok: true, enabled: state.current };
  if (input !== "on" && input !== "off") return { ok: false };
  const enabled = input === "on"; state.commit(enabled); return { ok: true, enabled };
}
export const planResultSchema: Control["ArgumentSchema"] = { type: "object", additionalProperties: false, required: ["enabled", "configVersion", "effectiveFromTurnOrdinal", "restrictionDigest"], properties: {
  enabled: { type: "boolean" }, configVersion: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  effectiveFromTurnOrdinal: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, restrictionDigest: { type: "string", maxLength: 64 },
} };
export function planCommands(): NativeCommandContribution[] {
  return ["plan", "plan.set"].map((commandName) => ({ entry: { commandName, summary: commandName === "plan" ? "Inspect the versioned readonly restriction" : "Change readonly restriction at an idle boundary", handlerId: `native.${commandName}`,
    inputSchema: commandName === "plan" ? { type: "object", additionalProperties: false, properties: {}, required: [] } : { type: "object", additionalProperties: false, properties: { enabled: { type: "boolean" } }, required: ["enabled"] },
    resultSchema: planResultSchema, mutationClass: commandName === "plan" ? "read" : "session", states: ["idle", "busy", "paused"], busyPolicy: commandName === "plan" ? "read-only" : "reject",
    confirmation: "none", availability: "available", reason: "versioned-session-readonly-restriction" }, structuredResult: true,
    async execute(context) { if (commandName !== "plan" || context.restriction === undefined) throw new Error("host-readonly-transaction-required"); return context.restriction(); },
  }));
}
