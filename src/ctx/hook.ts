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
import { getRuntime, nativeSearchMessage, parseToolName, refusalAction } from "./runtimes";

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
    // Not a shell call. Before failing open, check whether it is the runtime's
    // OWN search tool: the matcher used to be `Bash` alone, so an agent that
    // reached for the native tool went unguarded and the Bash guard still
    // reported a clean run — compliance recorded in the routing audit that did
    // not happen.
    const nativeSearch = matchedNativeSearch(runtime.nativeSearchTools, payload);
    if (nativeSearch) {
      const action = refusalAction(runtime.id, nativeSearchMessage(nativeSearch));
      if (action.stdout) process.stdout.write(action.stdout);
      if (action.stderr) process.stderr.write(action.stderr);
      if (action.exitCode) process.exitCode = action.exitCode;
    }
    return; // fail-open for anything else: unparseable, or a tool we do not claim.
  }

  const classification = classifyCommand(command);
  const action = classification.block
    ? runtime.block(command, classification)
    : runtime.allow(classification);

  if (action.stdout) process.stdout.write(action.stdout);
  if (action.stderr) process.stderr.write(action.stderr);
  if (action.exitCode) process.exitCode = action.exitCode;
}

/** The declared native search tool this payload invokes, or null. */
function matchedNativeSearch(tools: readonly string[] | undefined, payload: string): string | null {
  if (!tools || tools.length === 0) {
    return null;
  }
  const name = parseToolName(payload);
  return name && tools.includes(name) ? name : null;
}
