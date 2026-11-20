function reviewTargetArgs(target: unknown): string[] {
  const args: string[] = [];
  if (!target || typeof target !== "object") throw new Error("Invalid watcher target.");
  const key = target as Record<string, unknown>;
  for (const [field, flag] of [["repo", "--repo"], ["repositoryId", "--repository-id"], ["viewer", "--viewer"]] as const) {
    const value = key[field];
    if (typeof value !== "string" || !value || value.startsWith("-") || /\s/.test(value)) throw new Error("Invalid watcher identity.");
    args.push(flag, value);
  }
  return args;
}

export function reviewRuleArgs(target: unknown, action: unknown): string[] {
  if (!action || typeof action !== "object" || !("kind" in action) ||
      !["status", "save", "delete", "mode"].includes(String(action.kind))) throw new Error("Unknown review rule operation.");
  const request = JSON.stringify(action);
  if (Buffer.byteLength(request) > 8192) throw new Error("Review rule request is too large.");
  return ["review", "rules", "--json", ...reviewTargetArgs(target), "--request", request];
}

/** Translate webview controls to the same fixed CLI operations as the native host. */
export function reviewWatcherArgs(target: unknown, action: unknown): string[] {
  if (!action || typeof action !== "object" || !("kind" in action)) throw new Error("Missing watcher operation.");
  const op = action.kind;
  if (op !== "status" && op !== "enable" && op !== "pause" && op !== "resume") throw new Error("Unknown watcher operation.");
  const args = ["review", "watch", op, "--json"];
  if (target == null) {
    if (op !== "status" && op !== "pause") throw new Error("Select a repository for the watcher.");
  } else {
    args.push(...reviewTargetArgs(target));
  }
  if (op === "enable") {
    const minutes = "intervalMinutes" in action ? action.intervalMinutes : undefined;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
      throw new Error("Choose a watcher interval from 1 to 1440 minutes.");
    }
    args.push("--interval-minutes", String(minutes));
  } else if ("intervalMinutes" in action) throw new Error("Only enable accepts a watcher interval.");
  return args;
}
