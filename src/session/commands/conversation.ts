import type { Control } from "../../remote-control/protocol";
import { redactSensitiveText } from "../../security/service";
import { runNotesCommand, runTrailCommand } from "../../tui/working-memory-command";
import type { NativeCommandContribution } from "./handlers";

/** The shipped readline and TUI clients call these same working-memory readers. */
export function conversationCommands(): NativeCommandContribution[] {
  const schemas: Record<string, Control["ArgumentSchema"]> = {
    trail: { type: "object", additionalProperties: false, required: [], properties: {
      count: { type: "integer", minimum: 1, maximum: 100 }, tool: { type: "string", maxLength: 200 },
      file: { type: "string", maxLength: 200 }, from: { type: "integer", minimum: 1, maximum: 1000000 }, to: { type: "integer", minimum: 1, maximum: 1000000 },
    } },
    notes: { type: "object", additionalProperties: false, required: [], properties: { key: { type: "string", maxLength: 200 } } },
  };
  return Object.entries(schemas).map(([commandName, inputSchema]) => ({
    entry: { commandName, summary: commandName === "trail" ? "Read the native session tool trail" : "Read the native session working notes",
      handlerId: `native.conversation.${commandName}`, inputSchema, resultSchema: { type: "string", maxLength: 32768 }, mutationClass: "read",
      states: ["idle", "busy", "paused"], busyPolicy: "read-only", confirmation: "none", availability: "available", reason: "shared-native-working-memory-reader" },
    async execute(context, request) {
      const args = request.arguments as Record<string, string | number>;
      const text = commandName === "notes" ? await runNotesCommand(String(args.key ?? ""), context.nativeSessionDir)
        : await runTrailCommand(Object.entries(args).map(([key, value]) => key === "count" ? String(value) : `${key}=${value}`).join(" "), context.nativeSessionDir);
      return redactSensitiveText(text).replaceAll(context.nativeSessionDir, "[native-session]").replaceAll(context.cwd, ".").slice(0, 30000);
    },
  }));
}
