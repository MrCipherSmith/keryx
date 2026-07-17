// Interactive agent-mode driver (flow 033 / SA-01 Flow A).
//
// `runAgentTurn(io, deps, history, userLine)` is the injectable, deterministic
// core: it reaches NO real stdio/TTY/network. Per user turn it streams
// `provider.stream(request WITH tools)`, and on each `tool_call_end` it validates
// the tool input, applies a read-only risk gate, invokes the content-returning
// executor, appends the result as a `role:"tool"` message, and re-requests —
// looping until a text-only finish or the `maxToolCalls` guard. `runShell`'s
// chat core is untouched; this is a separate, opt-in path.
//
// Determinism: uses ONLY `deps.idSeq` (never `Date.now`/`Math.random`); all
// provider I/O flows through the injected `ProviderPort`, all tool I/O through the
// injected `InteractiveTool` executors.

import { validateAgainstSchemaObject } from "../contracts/validator";
import type { InteractiveTool, InteractiveToolResult } from "../harness/tool/builtin/interactive-tools";
import type { NormalizedMessage, NormalizedRequest, ProviderPort } from "../harness/provider/types";

/** Rendering sink for agent mode. Assistant text streams through `write`. */
export interface AgentIO {
  write: (s: string) => void;
  /** A model tool call is about to run (raw JSON input string). */
  onToolCall?: (name: string, input: string) => void;
  /** A tool finished; `result.isError` distinguishes failures. */
  onToolResult?: (name: string, result: InteractiveToolResult) => void;
  /** Non-token system/error text. */
  onSystem?: (text: string) => void;
}

/** Injected dependencies keeping `runAgentTurn` deterministic + offline. */
export interface AgentDeps {
  provider: ProviderPort;
  providerId: string;
  modelId: string;
  tools: InteractiveTool[];
  /** Trusted system instruction (assembled by `buildAgentSystemInstruction`). */
  systemInstruction: string;
  idSeq: () => string;
  /** Max tool executions per user turn (loop-safety guard). Default 8. */
  maxToolCalls?: number;
}

const DEFAULT_MAX_TOOL_CALLS = 8;

/**
 * Assemble the trusted system instruction. When a `keryx orient` block is present
 * and non-empty it is embedded; otherwise a minimal static instruction is used.
 * Pure — never throws on a missing/empty orientation block.
 */
export function buildAgentSystemInstruction(orient?: string): string {
  const base =
    "You are the keryx interactive agent. You have read-only tools to inspect the " +
    "real project: get_cwd, list_dir, read_file (filesystem), and search_code, " +
    "graph_affected, memory_search (keryx metaproject: compact code search, code-graph " +
    "blast radius, and project memory). ALWAYS use a tool to obtain facts instead of " +
    "guessing; never fabricate paths, file contents, or search results. Answer concisely.";
  const trimmed = orient?.trim() ?? "";
  if (trimmed.length === 0) {
    return base;
  }
  return `${base}\n\nProject orientation (trusted context):\n${trimmed}`;
}

interface PendingCall {
  id: string;
  name: string;
  input: string;
}

/** Safe JSON parse of a tool-call input string → object (empty object on failure). */
function parseToolInput(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (text.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Run ONE user turn to completion (possibly several model round-trips if tools are
 * called). Appends the user message plus every assistant/tool message produced to
 * `history` in place.
 */
export async function runAgentTurn(
  io: AgentIO,
  deps: AgentDeps,
  history: NormalizedMessage[],
  userLine: string,
): Promise<void> {
  history.push({ role: "user", content: userLine, provenance: "project" });

  const toolByName = new Map(deps.tools.map((t) => [t.definition.name, t]));
  const toolDefs = deps.tools.map((t) => t.definition);
  const maxToolCalls = deps.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const parentRunId = deps.idSeq();
  let toolCallsUsed = 0;

  const system = (text: string): void => {
    if (io.onSystem !== undefined) {
      io.onSystem(text);
    } else {
      io.write(text);
    }
  };

  // Loop: request → stream → (execute tool calls, re-request) until a text-only
  // finish or the tool-call guard trips.
  for (;;) {
    const request: NormalizedRequest = {
      providerId: deps.providerId,
      modelId: deps.modelId,
      systemInstruction: deps.systemInstruction,
      messages: [...history],
      tools: toolDefs,
      budget: { maxOutputTokens: 1024, runReservation: 1024 },
      stream: true,
      requestId: deps.idSeq(),
      parentRunId,
    };

    let assistantText = "";
    const nameById = new Map<string, string>();
    const calls: PendingCall[] = [];
    let errored = false;

    try {
      for await (const event of deps.provider.stream(request, { attemptId: deps.idSeq() })) {
        if (event.kind === "text_delta") {
          const text = event.text ?? "";
          io.write(text);
          assistantText += text;
        } else if (event.kind === "tool_call_start") {
          if (event.toolCallId !== undefined && event.toolName !== undefined) {
            nameById.set(event.toolCallId, event.toolName);
          }
        } else if (event.kind === "tool_call_end") {
          if (event.toolCallId !== undefined) {
            calls.push({
              id: event.toolCallId,
              name: nameById.get(event.toolCallId) ?? event.toolName ?? "",
              input: event.input ?? "",
            });
          }
        } else if (event.kind === "provider_error") {
          system(`\n[error] ${event.error?.message ?? event.error?.kind ?? "provider error"}\n`);
          errored = true;
          break;
        } else if (event.kind === "model_end") {
          break;
        }
      }
    } catch (cause) {
      system(`\n[error] ${cause instanceof Error ? cause.message : String(cause)}\n`);
      errored = true;
    }

    if (assistantText.length > 0) {
      history.push({ role: "assistant", content: assistantText, provenance: "model" });
    }

    if (errored || calls.length === 0) {
      return; // error, or a text-only finish → turn complete
    }

    // Execute each tool call and append its result, then loop to re-request.
    for (const call of calls) {
      io.onToolCall?.(call.name, call.input);
      const result = await executeCall(call, toolByName, () => toolCallsUsed++, {
        used: () => toolCallsUsed,
        max: maxToolCalls,
      });
      io.onToolResult?.(call.name, result);
      history.push({ role: "tool", content: result.output, provenance: "tool" });
    }
  }
}

/** Resolve, gate, validate, and invoke a single tool call → a content result. */
async function executeCall(
  call: PendingCall,
  toolByName: Map<string, InteractiveTool>,
  countCall: () => void,
  budget: { used: () => number; max: number },
): Promise<InteractiveToolResult> {
  if (budget.used() >= budget.max) {
    return { output: `tool-call budget exhausted (${budget.max} per turn)`, isError: true };
  }
  countCall();

  const tool = toolByName.get(call.name);
  if (tool === undefined) {
    return { output: `unknown tool: ${call.name}`, isError: true };
  }
  // Read-only risk gate (Flow A): only `read` tools may run.
  if (tool.definition.risk !== "read") {
    return {
      output: `tool "${call.name}" (risk ${tool.definition.risk}) is not permitted in read-only agent mode`,
      isError: true,
    };
  }
  const input = parseToolInput(call.input);
  const validation = validateAgainstSchemaObject(tool.definition.inputSchema, input);
  if (!validation.valid) {
    const detail = validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    return { output: `invalid input for ${call.name}: ${detail}`, isError: true };
  }
  return tool.invoke(input);
}
