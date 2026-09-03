// CLI entry for `keryx ctx hook <runtime>` — the process a harness invokes
// before a shell command runs. It is a thin adapter: read the harness payload
// from stdin, resolve the runtime, classify the command, and emit that runtime's
// block/allow signal. All harness-specific behavior lives in runtimes.ts; the
// classification logic lives in hook-classify.ts.
//
// Fail-open by construction, with ONE exception: a tool named in the runtime's
// `nativeSearchTools` is refused, because a native code search bypasses the
// shell entirely and the Bash guard would report a clean run over it. An unknown
// runtime, an unparseable payload, or any other non-shell tool still allows the
// command (exit 0). The guard never blocks work it cannot confidently classify.

import { readStdinBounded } from "../lib/bounded-stdin";
import { classifyCommand } from "./hook-classify";
import { getRuntime, nativeSearchMessage, parseToolName, refusalAction, type HookAction } from "./runtimes";

// Re-exports kept for callers/tests that imported these from hook.ts.
export { classifyCommand, buildBlockMessage, type HookClassification } from "./hook-classify";
export { CTX_HOOK_SENTINEL } from "./runtimes";

export const CTX_HOOK_COMMAND = "keryx ctx hook claude";

/**
 * How long the harness gets to deliver its payload.
 *
 * Generous on purpose: this gate has no preamble to hide the wait behind, so the
 * whole budget is felt by a caller that writes slowly. It is still bounded,
 * because a `PreToolUse` gate that never exits wedges the tool call rather than
 * failing open — the opposite of what the header above promises.
 */
const STDIN_DEADLINE_MS = 2_000;

async function readStdin(): Promise<string> {
  return (await readStdinBounded(STDIN_DEADLINE_MS)) ?? "";
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
      emit(refusalAction(runtime.id, nativeSearchMessage(nativeSearch)));
    }
    return; // fail-open for anything else: unparseable, or a tool we do not claim.
  }

  const classification = classifyCommand(command);
  const action = classification.block
    ? runtime.block(command, classification)
    : runtime.allow(classification);

  emit(action);
}

/** The single place a HookAction becomes process output. */
function emit(action: HookAction): void {
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
