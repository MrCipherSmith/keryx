import type { NativeContextReset } from "./host-context";
import type { SessionRestriction } from "./commands/plan";
import type { Control, ProtocolResult } from "../remote-control/protocol";

export interface NativeForkHistorySeed {
  sourceSessionId: string; nativeSessionId: string; throughHistoryCursor: number; nativeArchiveCount: number; nativeArchiveDigest: string;
  contextResets?: NativeContextReset[]; nativeContextDigest?: string;
  messages: Control["SessionMessage"][]; nativeBoundaries: [number, number][];
}
export type SessionLifecycleCommand = "new" | "clear" | "sessions.resume" | "sessions.fork";
export interface SessionLifecycleInput {
  operationId: string; payloadDigest: string; actorId: string; command: Control["CommandInvoke"];
  /** Direct owner handoff, called only after the bridge has validated server child allocation and checkout policy. */
  releaseSource(): Promise<Control["SessionRecord"]>;
  resumeSource(): Promise<Control["SessionRecord"]>;
  forkNative(input: { throughHistoryCursor: number; expectedHistoryVersion: number; targetCwd: string; title: string }): Promise<{ nativeSessionId: string; archiveCount: number; messageCount: number; historySeed: NativeForkHistorySeed }>;
  readonlyRestriction: SessionRestriction;
  source: Control["SessionRecord"]; sourceNativeSessionId: string; sourceCwd: string; sourceDataDir?: string;
}
/** Local machine materialization only. The callback verifies original immutable human command
 * authority and obtains the server-selected receipt/record; it never calls a human endpoint. */
export interface SessionLifecyclePort {
  apply(input: SessionLifecycleInput): Promise<ProtocolResult<Control["SessionOperationReceipt"]>>;
  list(input: SessionLifecycleInput): Promise<ProtocolResult<Control["SessionRecord"][]>>;
  open(input: SessionLifecycleInput): Promise<ProtocolResult<Control["SessionRecord"]>>;
}
export interface SessionAttachmentLink {
  sessionId: string; sessionVersion: number; machineId: string; checkoutId: string; title: string; readOnly: true; controllerGranted: false;
}
const id: Control["ArgumentSchema"] = { type: "string", maxLength: 200 };
const version: Control["ArgumentSchema"] = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const object = (properties: Record<string, Control["ArgumentSchema"]>, required = Object.keys(properties)): Control["ArgumentSchema"] => ({ type: "object", properties, required, additionalProperties: false });
const empty = object({});
export const lifecycleCommandSchemas: Record<SessionLifecycleCommand | "sessions" | "resume" | "sessions.open", Control["ArgumentSchema"]> = {
  new: empty, clear: empty, sessions: empty, resume: empty,
  "sessions.open": object({ sessionId: id, expectedSessionVersion: version }),
  "sessions.resume": object({ sessionId: id, expectedSessionVersion: version,
    controller: object({ controllerLeaseId: id, expectedControllerVersion: version }), expectedHistoryVersion: version,
    expectedWorkspaceBaseline: { type: "string", maxLength: 64 } }),
  "sessions.fork": object({ throughHistoryCursor: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, expectedHistoryVersion: version,
    targetCheckoutId: id, expectedInventoryVersion: version, expectedHeadSha: { type: "string", maxLength: 64 }, title: { type: "string", maxLength: 200 } }),
};
export const sessionAttachmentSchema: Control["ArgumentSchema"] = object({ sessionId: id, sessionVersion: version, machineId: id, checkoutId: id,
  title: { type: "string", maxLength: 200 }, readOnly: { type: "boolean" }, controllerGranted: { type: "boolean" } });
export const lifecycleMutationCommands = new Set<string>(["new", "clear", "sessions.resume", "sessions.fork"]);

import type { NativeCommandContribution } from "./commands/handlers";
export function lifecycleCommands(enabled = false): NativeCommandContribution[] {
  return Object.entries(lifecycleCommandSchemas).map(([commandName, inputSchema]) => ({
    entry: { commandName, summary: commandName === "clear" ? "Start a new native child while retaining this transcript" : `Native session ${commandName}`,
      handlerId: `native.lifecycle.${commandName}`, inputSchema,
      resultSchema: lifecycleMutationCommands.has(commandName) ? { type: "null" } : commandName === "sessions.open" ? sessionAttachmentSchema : { type: "array", maxItems: 100, items: sessionAttachmentSchema },
      mutationClass: lifecycleMutationCommands.has(commandName) ? "session" : "read", states: commandName === "sessions.resume" ? ["idle", "closed"] : ["idle"], busyPolicy: "reject", confirmation: "none",
      availability: enabled ? "available" : "setup-required", reason: enabled ? "authenticated-machine-lifecycle-port" : "machine-lifecycle-port-required" },
    structuredResult: true,
    async execute(context, request) {
      if (context.lifecycle === undefined || context.lifecycleInput === undefined) throw new Error("machine-lifecycle-port-required");
      const result = request.commandName === "sessions.open" ? await context.lifecycle.open(context.lifecycleInput) : await context.lifecycle.list(context.lifecycleInput);
      if (!result.ok) throw new Error(result.error.code);
      const link = (record: Control["SessionRecord"]): SessionAttachmentLink => ({ sessionId: record.sessionId, sessionVersion: record.version, machineId: record.machineId,
        checkoutId: record.checkoutId, title: record.title, readOnly: true, controllerGranted: false });
      return Array.isArray(result.value) ? result.value.map(link) : link(result.value);
    },
  }));
}
