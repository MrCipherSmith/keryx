// CLI entry for `keryx ctx hook <runtime>` — the process a harness invokes
// before a shell command runs. It is a thin adapter: read the harness payload
// from stdin, resolve the runtime, classify the command, and emit that runtime's
// block/allow signal. All harness-specific behavior lives in runtimes.ts; the
// classification logic lives in hook-classify.ts.
//
// Fail-open by construction: an unknown runtime, a non-shell tool, or an
// unparseable payload always allows the command (exit 0). The guard never blocks
// work it cannot confidently classify.

import { classifyCommand } from "./hook-classify";
import { getRuntime } from "./runtimes";

// Re-exports kept for callers/tests that imported these from hook.ts.
export { classifyCommand, buildBlockMessage, type HookClassification } from "./hook-classify";
export { CTX_HOOK_SENTINEL } from "./runtimes";

export const CTX_HOOK_COMMAND = "keryx ctx hook claude";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runCtxHook(runtimeId: string | undefined): Promise<void> {
  const runtime = getRuntime(runtimeId ?? "claude");
  if (!runtime) {
    // Unknown runtime: never interfere with tool execution.
    return;
  }

  const payload = await readStdin();
  const command = runtime.parseCommand(payload);
  if (command === null) {
    return; // fail-open: not a shell call or unparseable payload.
  }

  const classification = classifyCommand(command);
  const action = classification.block
    ? runtime.block(command, classification)
    : runtime.allow(classification);

  if (action.stdout) process.stdout.write(action.stdout);
  if (action.stderr) process.stderr.write(action.stderr);
  if (action.exitCode) process.exitCode = action.exitCode;
}
