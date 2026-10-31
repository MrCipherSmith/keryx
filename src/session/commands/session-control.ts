import type { NativeCommandContribution } from "./handlers";

/** Shared shipped terminal/native interrupt domain operation: cancel only the current foreground operation. */
export function requestSessionInterrupt(operation: { isActive: boolean; cancel(reason: string): void }): boolean {
  if (!operation.isActive) return false;
  operation.cancel("interrupted by user"); return true;
}
export function sessionControlCommands(): NativeCommandContribution[] {
  return [{ entry: { commandName: "interrupt", summary: "Stop this session's current owned turn", handlerId: "native.session.interrupt",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] }, resultSchema: { type: "object", additionalProperties: false,
      properties: { status: { type: "string", enum: ["stopped", "unknown", "too-late"], maxLength: 16 } }, required: ["status"] },
    mutationClass: "session", states: ["idle", "busy", "paused"], busyPolicy: "reject", confirmation: "none", availability: "available", reason: "current-owned-foreground-operation" },
  structuredResult: true, async execute(context, request) {
    if (context.authorizeOwnedControl === undefined || context.interrupt === undefined) throw new Error("owned-control-required");
    await context.authorizeOwnedControl("interrupt", request.arguments as Record<string, never>); return context.interrupt();
  } }, ...["exit", "quit"].map((commandName): NativeCommandContribution => ({ entry: { commandName, summary: "Preserve and close this native session", handlerId: "native.session.exit",
    inputSchema: { type: "object", additionalProperties: false, properties: {}, required: [] }, resultSchema: { type: "object", additionalProperties: false, properties: { status: { type: "string", enum: ["closed"], maxLength: 16 } }, required: ["status"] },
    mutationClass: "session", states: ["idle"], busyPolicy: "reject", confirmation: "none", availability: "available", reason: "native-history-slate-lease-close" }, structuredResult: true,
    async execute(context) { if (context.close === undefined) throw new Error("native-session-close-required"); return context.close(); },
  }))];
}
