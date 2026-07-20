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
import type { NormalizedMessage, NormalizedRequest, NormalizedUsage, ProviderPort } from "../harness/provider/types";

/** Rendering sink for agent mode. Assistant text streams through `write`. */
export interface AgentIO {
  write: (s: string) => void;
  /**
   * A round's assistant text is finalized (called once per round that produced
   * text, AFTER `write` streamed the tokens and BEFORE any tool execution).
   * A rich renderer uses this to re-render the buffered round as markdown; when
   * absent the driver's default streaming via `write` is unchanged.
   */
  onAssistantText?: (text: string) => void;
  /**
   * A round's chain-of-thought (from a reasoning-capable model) is finalized.
   * Called ONCE per round that produced reasoning, BEFORE the answer renders.
   * Absent for models that emit no reasoning (e.g. gpt-4o-mini).
   */
  onReasoning?: (text: string) => void;
  /** Provider-reported token usage for this run (forwarded from `usage_update`). */
  onUsage?: (usage: NormalizedUsage) => void;
  /** A model tool call is about to run (raw JSON input string). */
  onToolCall?: (name: string, input: string) => void;
  /** A tool finished; `result.isError` distinguishes failures. */
  onToolResult?: (name: string, result: InteractiveToolResult) => void;
  /** Non-token system/error text. */
  onSystem?: (text: string) => void;
  /**
   * Approve a mutating (risk `shell`) tool call before it runs. DEFAULT-DENY:
   * when this is absent the driver denies the call and never executes it. `input`
   * is the raw JSON input string the model proposed.
   */
  requestApproval?: (tool: string, input: string) => Promise<boolean>;
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

/** Consecutive identical failing tool calls that abort a turn (runaway guard). */
const MAX_REPEAT_FAILS = 3;

/** Optional session context baked into the system instruction (provider/model). */
export interface AgentInstructionContext {
  providerId?: string;
  modelId?: string;
}

/**
 * Assemble the trusted system instruction. When a `keryx orient` block is present
 * and non-empty it is embedded; otherwise a minimal static instruction is used.
 * Pure — never throws on a missing/empty orientation block.
 *
 * Includes explicit **workflow routing** so the harness acts on product intents
 * (e.g. "обогати вики через модель" → `keryx wiki enrich`) instead of thrashing
 * read tools with empty arguments.
 */
export function buildAgentSystemInstruction(orient?: string, ctx: AgentInstructionContext = {}): string {
  const sessionProvider = ctx.providerId?.trim() ?? "";
  const sessionModel = ctx.modelId?.trim() ?? "";
  const enrichFlags =
    sessionProvider.length > 0 && sessionModel.length > 0
      ? ` --provider ${sessionProvider} --model ${sessionModel}`
      : "";

  const base =
    "You are the keryx interactive agent (project harness). You have read-only tools to " +
    "inspect the real project: get_cwd, list_dir, read_file (filesystem), and search_code, " +
    "graph_affected, memory_search, read_wiki, wiki_ask, graph_symbol (keryx metaproject). " +
    "You may also propose shell_exec to run a command, which requires the user's explicit " +
    "approval before it executes.\n\n" +
    "Tool-calling rules (critical):\n" +
    "- ALWAYS pass every required field in the tool JSON (e.g. search_code needs " +
    "`pattern`, read_wiki needs `path`, wiki_ask needs `question`). Never call a tool " +
    "with an empty object.\n" +
    "- Prefer ONE correct shell_exec over many exploratory tool calls when the user asks " +
    "to run a known keryx workflow.\n\n" +
    "Workflow routing (follow these instead of improvising):\n" +
    "- User asks to enrich / enrich wiki / enrich with a model / «обогати вики» / " +
    "«обогатить вики через модель» → use shell_exec with command:\n" +
    `    keryx wiki enrich --all${enrichFlags}\n` +
    `  For a single page: keryx wiki enrich <page-or-slug>${enrichFlags}. ` +
    "Do NOT try to rewrite wiki pages by hand with search_code/read_wiki alone — " +
    "wiki enrich is the dedicated model-backed enricher.\n" +
    "- Optional prep: `keryx wiki collect` scaffolds drafts; then `keryx wiki enrich --all`.\n" +
    "- Other keryx work (graph, health, memory, flow) → prefer `shell_exec` with the " +
    "matching `keryx …` CLI when the user wants a full command run.\n\n" +
    "ALWAYS use a tool to obtain facts instead of guessing; never fabricate paths, file " +
    "contents, or results. Be economical with output tokens: lead with the conclusion, " +
    "give the shortest correct answer, prefer bullet points over prose, and omit preamble. " +
    "Do NOT paste large tool/command output back into your reply — the compact tool result " +
    "is already in context; reference it instead of repeating it.";

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
  // Runaway guard: track consecutive identical FAILING calls across rounds.
  let repeatFailSig: string | undefined;
  let repeatFailCount = 0;

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
    let reasoningText = "";
    let reasoningFlushed = false;
    const flushReasoning = (): void => {
      if (reasoningText.length > 0 && !reasoningFlushed) {
        io.onReasoning?.(reasoningText);
        reasoningFlushed = true;
      }
    };
    const nameById = new Map<string, string>();
    const calls: PendingCall[] = [];
    let errored = false;

    try {
      for await (const event of deps.provider.stream(request, { attemptId: deps.idSeq() })) {
        if (event.kind === "reasoning_delta") {
          reasoningText += event.text ?? "";
        } else if (event.kind === "text_delta") {
          flushReasoning(); // reasoning precedes the answer → surface it first
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
        } else if (event.kind === "usage_update") {
          if (event.usage !== undefined) {
            io.onUsage?.(event.usage);
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

    flushReasoning(); // reasoning-only round (e.g. before a tool call) still surfaces it

    if (assistantText.length > 0) {
      history.push({ role: "assistant", content: assistantText, provenance: "model" });
      io.onAssistantText?.(assistantText);
    }

    if (errored || calls.length === 0) {
      return; // error, or a text-only finish → turn complete
    }

    // Execute each tool call and append its result, then loop to re-request.
    let abort: string | undefined;
    for (const call of calls) {
      io.onToolCall?.(call.name, call.input);
      const result = await executeCall(call, toolByName, io.requestApproval, () => toolCallsUsed++, {
        used: () => toolCallsUsed,
        max: maxToolCalls,
      });
      io.onToolResult?.(call.name, result);
      history.push({ role: "tool", content: result.output, provenance: "tool" });

      // Runaway guard: a model that re-issues the SAME failing call every round
      // would otherwise spin forever. Abort after N consecutive identical errors.
      if (result.isError) {
        const sig = `${call.name}:${call.input}`;
        repeatFailCount = sig === repeatFailSig ? repeatFailCount + 1 : 1;
        repeatFailSig = sig;
        if (repeatFailCount >= MAX_REPEAT_FAILS) {
          abort = `repeated identical tool error — ${call.name} failed ${repeatFailCount}× with the same input`;
          break;
        }
      } else {
        repeatFailSig = undefined;
        repeatFailCount = 0;
      }
    }

    if (abort !== undefined) {
      system(`\n[stopped] ${abort}\n`);
      return;
    }
    // Terminate the turn once the tool-call budget is spent instead of
    // re-requesting forever (every further call would just return "exhausted").
    if (toolCallsUsed >= maxToolCalls) {
      system(`\n[stopped] tool-call limit reached (${maxToolCalls} per turn)\n`);
      return;
    }
  }
}

/** Resolve, gate (risk + approval), validate, and invoke a call → a content result. */
async function executeCall(
  call: PendingCall,
  toolByName: Map<string, InteractiveTool>,
  requestApproval: AgentIO["requestApproval"],
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

  const input = parseToolInput(call.input);
  const validation = validateAgainstSchemaObject(tool.definition.inputSchema, input);
  if (!validation.valid) {
    const detail = validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ");
    const requiredRaw = (tool.definition.inputSchema as { required?: unknown }).required;
    const required = Array.isArray(requiredRaw) ? requiredRaw.filter((r): r is string => typeof r === "string") : [];
    const hint = required.length > 0 ? ` (required: ${required.join(", ")})` : "";
    return { output: `invalid input for ${call.name}: ${detail}${hint}`, isError: true };
  }

  // Risk gate: `read` auto-allows; `shell` requires approval (DEFAULT-DENY — no
  // approver means no execution); anything else is denied.
  const risk = tool.definition.risk;
  if (risk === "shell") {
    const approved = requestApproval !== undefined && (await requestApproval(call.name, call.input));
    if (!approved) {
      return { output: `command not approved by the user; not executed`, isError: true };
    }
  } else if (risk !== "read") {
    return { output: `tool "${call.name}" (risk ${risk}) is not permitted`, isError: true };
  }

  return tool.invoke(input);
}
