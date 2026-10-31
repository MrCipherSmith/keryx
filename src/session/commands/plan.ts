import { canonicalDigest, type Control } from "../../remote-control/protocol";
import type { NativeCommandContribution } from "./handlers";
/** `approvalMode: "ask"` is the host-owned approval narrowing (`/mode ask`): once set for a config version, every later version keeps it. */
export interface SessionRestriction { enabled: boolean; configVersion: number; effectiveFromTurnOrdinal: number; restrictionDigest: string; approvalMode?: "ask" }
/** Binds a restriction to the session's local policy. A readonly-only restriction keeps the digest it always had. */
export function sessionRestrictionDigest(restriction: { enabled: boolean; approvalMode?: "ask" | undefined }, policyDigest: string): string {
  return canonicalDigest({ enabled: restriction.enabled, policyDigest, ...(restriction.approvalMode === undefined ? {} : { approvalMode: restriction.approvalMode }) });
}
export { executePlanCommand } from "./plan-command";
export const planResultSchema: Control["ArgumentSchema"] = { type: "object", additionalProperties: false, required: ["enabled", "configVersion", "effectiveFromTurnOrdinal", "restrictionDigest"], properties: {
  enabled: { type: "boolean" }, configVersion: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  effectiveFromTurnOrdinal: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, restrictionDigest: { type: "string", maxLength: 64 },
  approvalMode: { type: "string", maxLength: 8, enum: ["ask"] },
} };
const empty: Control["ArgumentSchema"] = { type: "object", additionalProperties: false, properties: {}, required: [] };
export function planCommands(): NativeCommandContribution[] {
  return ["plan", "plan.set"].map((commandName) => ({ entry: { commandName, summary: commandName === "plan" ? "Inspect the versioned readonly restriction" : "Change readonly restriction at an idle boundary", handlerId: `native.${commandName}`,
    inputSchema: commandName === "plan" ? empty : { type: "object", additionalProperties: false, properties: { enabled: { type: "boolean" } }, required: ["enabled"] },
    resultSchema: planResultSchema, mutationClass: commandName === "plan" ? "read" : "session", states: ["idle", "busy", "paused"], busyPolicy: commandName === "plan" ? "read-only" : "reject",
    confirmation: "none", availability: "available", reason: "versioned-session-readonly-restriction" }, structuredResult: true,
    async execute(context) { if (commandName !== "plan" || context.restriction === undefined) throw new Error("host-readonly-transaction-required"); return context.restriction(); },
  }));
}
/**
 * `/mode ask`: a narrowing only (specification 3.1 admits no permission-floor or trust widening through chat commands). The host
 * applies it at an idle boundary as a new config version; no native command lifts it, and the other permission modes stay local.
 */
export function approvalModeCommands(): NativeCommandContribution[] {
  return [{ entry: { commandName: "mode.ask", summary: "Ask for approval before every mutating tool call from the next turn on", handlerId: "native.mode.ask",
    inputSchema: empty, resultSchema: planResultSchema, mutationClass: "session", states: ["idle", "busy", "paused"], busyPolicy: "reject",
    confirmation: "none", availability: "available", reason: "versioned-session-approval-restriction" }, structuredResult: true,
    async execute() { throw new Error("host-approval-transaction-required"); } }];
}
