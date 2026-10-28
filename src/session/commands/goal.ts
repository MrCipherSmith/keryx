import type { NativeCommandContribution } from "./handlers";
export function goalCommands(): NativeCommandContribution[] {
  return [{ entry: { commandName: "goal", summary: "Run a native goal with bounded optional continuation", handlerId: "native.goal",
    inputSchema: { type: "object", additionalProperties: false, required: ["text"], properties: { text: { type: "string", maxLength: 32768 },
      workspaceId: { type: "string", maxLength: 200 }, autoRounds: { type: "integer", minimum: 1, maximum: 8 } } }, resultSchema: { type: "string", maxLength: 32768 },
    mutationClass: "workspace", states: ["idle"], busyPolicy: "queue-at-idle", confirmation: "none", availability: "available", reason: "shared-native-goal-handler" },
  async execute(context, request) {
    const effect = context.effect; if (effect === undefined) throw new Error("admitted-goal-required");
    const args = request.arguments as { text: string; workspaceId?: string; autoRounds?: number };
    if (args.text.trim().length === 0 || (args.autoRounds !== undefined && effect.association.mode !== "flow")) throw new Error("goal-continuation-requires-current-canonical-flow");
    const result = await context.runtime.run({ write: effect.progress, beforeAction: effect.beforeAction, onUsage: effect.usage }, context.history(), args.text, effect.snapshot,
      { signal: effect.signal, nativeGoal: { ...args, ...(effect.association.mode === "flow" ? { canonicalFlowId: effect.association.flowId } : {}) } });
    return { ok: result.outcome === "succeeded", outcome: result.outcome, reason: result.reason };
  } }];
}
