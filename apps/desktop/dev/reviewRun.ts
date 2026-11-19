// Only these three operations are exposed to the webview. In particular, the
// detached worker entry point belongs to the CLI's local dispatcher.
export function reviewRunArgs(target: unknown, action: unknown): string[] {
  if (!target || typeof target !== "object" || !action || typeof action !== "object") {
    throw new Error("configuration: Missing Review request");
  }
  const key = target as Record<string, unknown>;
  const op = action as Record<string, unknown>;
  if (op.kind !== "status" && op.kind !== "start" && op.kind !== "cancel") {
    throw new Error("configuration: Unknown Review operation");
  }
  if (!Number.isSafeInteger(key.number) || Number(key.number) <= 0) {
    throw new Error("configuration: Invalid pull request number");
  }
  const fields: [string, unknown][] = [
    ["--repo", key.repo], ["--repository-id", key.repositoryId], ["--viewer", key.viewer], ["--number", String(key.number)],
  ];
  if (op.kind === "start") fields.push(["--base", op.baseSha], ["--head", op.headSha]);
  if (op.kind === "cancel" || (op.kind === "status" && op.id !== undefined)) fields.push(["--id", op.id]);
  const args = ["review", "desk-run", op.kind, "--json"];
  for (const [flag, value] of fields) {
    if (typeof value !== "string" || !value || value.startsWith("-") || /\s/.test(value)) {
      throw new Error(`configuration: Invalid Review request field ${flag}`);
    }
    args.push(flag, value);
  }
  return args;
}
