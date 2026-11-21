// Only these user-facing operations are exposed to the webview. In particular, the
// detached worker entry point belongs to the CLI's local dispatcher.
export function reviewRunArgs(target: unknown, action: unknown): string[] {
  if (!target || typeof target !== "object" || !action || typeof action !== "object") {
    throw new Error("configuration: Missing Review request");
  }
  const key = target as Record<string, unknown>;
  const op = action as Record<string, unknown>;
  if (!["status", "start", "cancel", "continue", "answer", "readiness", "decide"].includes(String(op.kind))) {
    throw new Error("configuration: Unknown Review operation");
  }
  if (!Number.isSafeInteger(key.number) || Number(key.number) <= 0) {
    throw new Error("configuration: Invalid pull request number");
  }
  const fields: [string, unknown][] = [
    ["--repo", key.repo], ["--repository-id", key.repositoryId], ["--viewer", key.viewer], ["--number", String(key.number)],
  ];
  if (op.kind === "status" && op.activityId !== undefined) {
    if (op.id !== undefined) throw new Error("Choose one Review attempt scope.");
    fields.push(["--activity-id", op.activityId]);
  }
  if (op.kind === "start") fields.push(["--base", op.baseSha], ["--head", op.headSha]);
  if (op.kind === "continue" || op.kind === "cancel" || op.kind === "readiness" || op.kind === "decide" || (op.kind === "status" && op.id !== undefined)) fields.push(["--id", op.id]);
  if (op.kind === "answer") fields.push(["--id", op.id], ["--question-id", op.questionId]);
  if (op.kind === "decide") fields.push(["--decision", op.decision]);
  const args = ["review", "desk-run", String(op.kind), "--json"];
  for (const [flag, value] of fields) {
    if (typeof value !== "string" || !value || value.startsWith("-") || /\s/.test(value)) {
      throw new Error(`configuration: Invalid Review request field ${flag}`);
    }
    args.push(flag, value);
  }
  if (op.kind === "start" && op.options !== undefined) {
    const json = JSON.stringify(op.options);
    if (!op.options || typeof op.options !== "object" || Array.isArray(op.options) || new TextEncoder().encode(json).length > 8192) {
      throw new Error("configuration: Invalid review settings.");
    }
    args.push(`--options=${json}`);
  }
  if (op.kind === "continue" && op.guidance !== undefined) {
    if (typeof op.guidance !== "string" || op.guidance.length > 2000 || op.guidance.includes("\0")) {
      throw new Error("configuration: Review guidance is too long.");
    }
    args.push(`--guidance=${op.guidance}`);
  }
  if (op.kind === "answer") {
    if (typeof op.answer !== "string" || !op.answer.trim() || op.answer.length > 2000 || op.answer.includes("\0")) {
      throw new Error("configuration: Invalid review answer.");
    }
    args.push(`--answer=${op.answer}`);
  }
  if (op.kind === "decide") {
    if (!["complete", "close", "archive", "restore", "delete"].includes(String(op.decision)) ||
        typeof op.reason !== "string" || !op.reason.trim() || op.reason.length > 2000 || op.reason.includes("\0")) {
      throw new Error("configuration: Invalid review decision or reason.");
    }
    args.push(`--reason=${op.reason}`);
    if (op.waive !== undefined) {
      if (op.decision !== "complete" || !Array.isArray(op.waive) || !op.waive.length || op.waive.length > 12 ||
          op.waive.some(item => typeof item !== "string" || !/^[a-z-]{1,40}$/.test(item))) {
        throw new Error("configuration: Invalid review check selection.");
      }
      args.push(`--waive=${op.waive.join(",")}`);
    }
  }
  return args;
}
