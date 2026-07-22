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
import { isDestructiveCommand, touchesAgentCredentials } from "../lib/command-risk";
import type { InteractiveTool, InteractiveToolResult } from "../harness/tool/builtin/interactive-tools";
import type { NormalizedMessage, NormalizedRequest, NormalizedUsage, ProviderPort } from "../harness/provider/types";

/**
 * Extra context handed to an approver alongside the raw tool input.
 *
 * `destructive` is a per-COMMAND judgement (see `lib/command-risk.ts`): the tool's
 * static risk cannot tell `ls` from `rm -rf /`. It asks the approver to escalate —
 * always prompt, never auto-approve from a saved allowlist, never offer "always".
 * It is NOT a block signal: the classifier is incomplete by construction and must
 * never be treated as a security boundary (ADR-0009).
 */
export interface ApprovalMeta {
  /**
   * Identity of the exact action being approved (tool name + canonical input).
   * An approver that persists or replays a decision MUST key it on this, and an
   * approver that answers for a specific action should echo it back (see
   * {@link ApprovalResponse}) so the driver can refuse a mismatched answer.
   */
  fingerprint: string;
  destructive: boolean;
  /**
   * The command mentions the agent's own permission/credential files. Approving
   * it may hand the agent authority it did not have; it is never auto-approved
   * and never remembered, whatever the user picks.
   */
  credentials?: boolean;
}

/**
 * What an approver may answer.
 *
 * A bare `boolean` is the historical form and still works. The object form
 * BINDS the answer to an action: when `fingerprint` is present it must equal the
 * fingerprint the approver was given, otherwise the driver treats the answer as
 * a denial. That closes the gap where "the user said yes" and "this is what
 * runs" are two independent facts that merely happen to line up.
 */
export type ApprovalResponse = boolean | { approved: boolean; fingerprint?: string };

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
   * Approve a mutating (risk `shell`/`destructive`) tool call before it runs.
   * DEFAULT-DENY: when this is absent the driver denies the call and never
   * executes it. `input` is the raw JSON input string the model proposed.
   * `meta.destructive` asks the approver to ESCALATE (never auto-approve from an
   * allowlist, never offer "always") — see {@link ApprovalMeta}.
   */
  requestApproval?: (tool: string, input: string, meta?: ApprovalMeta) => Promise<ApprovalResponse>;
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
  /**
   * Max **unique** tool signatures per user turn (loop-safety guard).
   * Default {@link DEFAULT_MAX_TOOL_CALLS} (overridable via
   * {@link resolveAgentMaxToolCalls} / `KERYX_AGENT_MAX_TOOL_CALLS`).
   * The same call (name + normalized input hash) may be retried up to
   * {@link MAX_ATTEMPTS_PER_HASH} times and still counts as **one** budget slot.
   */
  maxToolCalls?: number;
}

/**
 * Default unique tool-signature budget per user turn for interactive agent
 * (`keryx shell` / TUI). Sized so multi-step operator prompts (read several
 * docs, run a probe matrix, write a report) complete without the user needing
 * "budget mode" wording or one-shot script workarounds.
 * Still a finite loop-safety guard — not unlimited.
 */
export const DEFAULT_MAX_TOOL_CALLS = 48;

/** Env override for {@link DEFAULT_MAX_TOOL_CALLS} (positive integer). */
export const ENV_AGENT_MAX_TOOL_CALLS = "KERYX_AGENT_MAX_TOOL_CALLS";

/** Hard ceiling when env/CLI requests an extreme value (runaway guard). */
export const MAX_AGENT_MAX_TOOL_CALLS = 256;

/**
 * Resolve unique tool-signature budget for an interactive agent turn.
 * - unset / empty / invalid env → {@link DEFAULT_MAX_TOOL_CALLS}
 * - valid integer ≥ 1 → clamped to {@link MAX_AGENT_MAX_TOOL_CALLS}
 *
 * Callers pass `process.env` in production; tests inject a stub map.
 */
export function resolveAgentMaxToolCalls(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[ENV_AGENT_MAX_TOOL_CALLS];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_MAX_TOOL_CALLS;
  }
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n) || n < 1) {
    return DEFAULT_MAX_TOOL_CALLS;
  }
  return Math.min(n, MAX_AGENT_MAX_TOOL_CALLS);
}

/**
 * Max attempts for the same tool signature (name + input hash). All attempts of
 * one signature share a single budget slot.
 */
export const MAX_ATTEMPTS_PER_HASH = 3;

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
    "to run a known keryx workflow.\n" +
    "- When you need a decision, interview step, or clarification: use **ask_user** with " +
    "2–6 options `{ id, label, description, recommended? }` (mark one recommended). " +
    "Do not dump long prose questions without options.\n" +
    "- For a focused independent subtask (investigate X, review Y, research Z): use " +
    "**spawn_subagent** with `{ task, mode?: 'read_only'|'general', label? }`. " +
    "Default mode is read_only (no shell). Prefer spawn for work that can finish " +
    "without your intermediate turns; do not spawn for trivial one-line answers.\n\n" +
    "Workflow routing (follow these instead of improvising):\n" +
    "- User asks to enrich / enrich wiki / «обогати вики» (TUI also pre-routes this):\n" +
    "  1) `keryx wiki enrich --list` — show drafts vs accepted.\n" +
    "  2) Ask: drafts only | force all (`--force`) | cancel.\n" +
    "  3) shell_exec (provider/model from auth.json if omitted):\n" +
    `       keryx wiki enrich --all${enrichFlags}\n` +
    `       keryx wiki enrich --all --force --concurrency 4${enrichFlags}\n` +
    `       keryx wiki enrich --all --resume --limit 10${enrichFlags}\n` +
    `       keryx wiki enrich --all --refresh-graph${enrichFlags}\n` +
    "  Do NOT thrash search_code/read_wiki instead of wiki enrich.\n" +
    "- Optional prep: `keryx wiki collect` then enrich.\n" +
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

/** Canonical JSON with sorted keys so equivalent objects hash the same. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Hash for budget / retry accounting: tool name + normalized input.
 * Exported for unit tests.
 */
export function toolCallHash(name: string, input: string): string {
  const parsed = parseToolInput(input);
  return `${name}\0${stableStringify(parsed)}`;
}

interface ToolBudgetState {
  /** Unique signatures that have consumed a budget slot. */
  charged: Set<string>;
  /** Attempt count per signature (capped at {@link MAX_ATTEMPTS_PER_HASH}). */
  attempts: Map<string, number>;
  maxUnique: number;
}

function budgetUsed(state: ToolBudgetState): number {
  return state.charged.size;
}

/**
 * Decide whether to run this call and whether it charges a new budget slot.
 * - Same hash: up to {@link MAX_ATTEMPTS_PER_HASH} attempts, **one** budget slot.
 * - New hash: charges one slot if budget remains; else rejected.
 */
export function reserveToolAttempt(
  state: ToolBudgetState,
  name: string,
  input: string,
): { ok: true; hash: string; attempt: number; chargedNew: boolean } | { ok: false; hash: string; reason: string } {
  const hash = toolCallHash(name, input);
  const prev = state.attempts.get(hash) ?? 0;
  if (prev >= MAX_ATTEMPTS_PER_HASH) {
    return {
      ok: false,
      hash,
      reason: `same tool call already tried ${MAX_ATTEMPTS_PER_HASH}× (hash budget); change the arguments or a different tool`,
    };
  }
  const isNew = !state.charged.has(hash);
  if (isNew && state.charged.size >= state.maxUnique) {
    return {
      ok: false,
      hash,
      reason: `tool-call budget exhausted (${state.maxUnique} unique signatures per turn; same call may retry up to ${MAX_ATTEMPTS_PER_HASH}× as one slot)`,
    };
  }
  if (isNew) {
    state.charged.add(hash);
  }
  const attempt = prev + 1;
  state.attempts.set(hash, attempt);
  return { ok: true, hash, attempt, chargedNew: isNew };
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
  const maxToolCalls = deps.maxToolCalls ?? resolveAgentMaxToolCalls();
  const parentRunId = deps.idSeq();
  const budget: ToolBudgetState = {
    charged: new Set(),
    attempts: new Map(),
    maxUnique: maxToolCalls,
  };
  /** Short log of tool outcomes for the budget-exhausted wrap-up. */
  const toolLog: string[] = [];

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
    let stopForBudget = false;
    let executedAny = false;
    for (const call of calls) {
      io.onToolCall?.(call.name, call.input);
      const reservation = reserveToolAttempt(budget, call.name, call.input);
      if (!reservation.ok) {
        const result: InteractiveToolResult = { output: reservation.reason, isError: true };
        io.onToolResult?.(call.name, result);
        history.push({ role: "tool", content: result.output, provenance: "tool" });
        toolLog.push(`${call.name}: skipped (${reservation.reason.split(";")[0] ?? "budget"})`);
        if (reservation.reason.startsWith("tool-call budget exhausted")) {
          stopForBudget = true;
        }
        continue;
      }

      executedAny = true;
      const result = await executeCall(call, toolByName, io.requestApproval);
      io.onToolResult?.(call.name, result);
      history.push({ role: "tool", content: result.output, provenance: "tool" });
      const shortIn = call.input.length > 80 ? `${call.input.slice(0, 77)}…` : call.input;
      toolLog.push(
        `${call.name}(${shortIn}) → ${result.isError ? "error" : "ok"} [attempt ${reservation.attempt}/${MAX_ATTEMPTS_PER_HASH}, unique ${budgetUsed(budget)}/${maxToolCalls}]`,
      );
    }

    // Stop when unique budget is full, OR the model only re-issued exhausted
    // hashes (no progress) — otherwise it could loop forever on the same call.
    const noProgress = !executedAny && calls.length > 0;
    if (stopForBudget || budgetUsed(budget) >= maxToolCalls || noProgress) {
      await finishWithBudgetSummary(io, deps, history, parentRunId, {
        maxUnique: maxToolCalls,
        used: budgetUsed(budget),
        toolLog,
        noProgress,
      });
      return;
    }
  }
}

/**
 * Budget exhausted (or maxed unique signatures): one final model turn **without
 * tools** so the assistant explains what happened and suggests next steps.
 */
async function finishWithBudgetSummary(
  io: AgentIO,
  deps: AgentDeps,
  history: NormalizedMessage[],
  parentRunId: string,
  info: { maxUnique: number; used: number; toolLog: string[]; noProgress?: boolean },
): Promise<void> {
  const system = (text: string): void => {
    if (io.onSystem !== undefined) {
      io.onSystem(text);
    } else {
      io.write(text);
    }
  };

  const why = info.noProgress
    ? `no progress (only repeated/exhausted tool signatures; max ${MAX_ATTEMPTS_PER_HASH} attempts each)`
    : `unique signature budget ${info.used}/${info.maxUnique} (same call may retry up to ${MAX_ATTEMPTS_PER_HASH}× as one slot)`;

  system(`\n[budget] Stopping tools: ${why}. Asking the model for a short wrap-up…\n`);

  const logBlock =
    info.toolLog.length > 0
      ? info.toolLog
          .slice(-12)
          .map((line) => `- ${line}`)
          .join("\n")
      : "- (no tool log)";

  history.push({
    role: "user",
    content:
      `[system] Tool loop stopped: ${why}.\n\n` +
      `Recent tool outcomes:\n${logBlock}\n\n` +
      `Reply briefly in the user's language: (1) what you tried, (2) what went wrong, ` +
      `(3) 1–3 concrete next steps (commands to re-run, fixes, or “send the same request again”). ` +
      `Do NOT call tools.`,
    provenance: "project",
  });

  const request: NormalizedRequest = {
    providerId: deps.providerId,
    modelId: deps.modelId,
    systemInstruction: deps.systemInstruction,
    messages: [...history],
    // No tools — force a text wrap-up.
    budget: { maxOutputTokens: 1024, runReservation: 1024 },
    stream: true,
    requestId: deps.idSeq(),
    parentRunId,
  };

  let assistantText = "";
  let reasoningText = "";
  let reasoningFlushed = false;
  try {
    for await (const event of deps.provider.stream(request, { attemptId: deps.idSeq() })) {
      if (event.kind === "reasoning_delta") {
        reasoningText += event.text ?? "";
      } else if (event.kind === "text_delta") {
        if (reasoningText.length > 0 && !reasoningFlushed) {
          io.onReasoning?.(reasoningText);
          reasoningFlushed = true;
        }
        const text = event.text ?? "";
        io.write(text);
        assistantText += text;
      } else if (event.kind === "usage_update") {
        if (event.usage !== undefined) {
          io.onUsage?.(event.usage);
        }
      } else if (event.kind === "provider_error") {
        system(`\n[error] ${event.error?.message ?? event.error?.kind ?? "provider error"}\n`);
        break;
      } else if (event.kind === "model_end") {
        break;
      }
    }
  } catch (cause) {
    system(`\n[error] wrap-up failed: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  }

  if (reasoningText.length > 0 && !reasoningFlushed) {
    io.onReasoning?.(reasoningText);
  }
  if (assistantText.length > 0) {
    history.push({ role: "assistant", content: assistantText, provenance: "model" });
    io.onAssistantText?.(assistantText);
  } else {
    system(
      "\n[budget] No wrap-up text from the model. Re-run your request, or call the " +
        "needed `keryx …` command directly (e.g. `keryx wiki enrich --all`).\n",
    );
  }
}

/**
 * True when `response` authorises THIS action. A bare `true` is accepted (the
 * historical contract); an object form must either omit the fingerprint or echo
 * the one it was given. A mismatch is a denial, never a pass — an approver that
 * answers about a different action has not approved this one.
 */
function isApprovalFor(response: ApprovalResponse, fingerprint: string): boolean {
  if (typeof response === "boolean") {
    return response;
  }
  if (!response.approved) {
    return false;
  }
  return response.fingerprint === undefined || response.fingerprint === fingerprint;
}

/** Resolve, gate (risk + approval), validate, and invoke a call → a content result. */
async function executeCall(
  call: PendingCall,
  toolByName: Map<string, InteractiveTool>,
  requestApproval: AgentIO["requestApproval"],
): Promise<InteractiveToolResult> {
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

  // Risk gate:
  // - `read` auto-allows
  // - `shell` / `destructive` require approval (DEFAULT-DENY when no approver)
  // - `delegate` (spawn_subagent): auto-allow when no approver; when an approver
  //   is present, ask (TUI may auto-approve read_only subagents)
  // - anything else is denied
  const risk = tool.definition.risk;
  if (risk === "shell" || risk === "destructive") {
    // Per-command escalation. A tool carries ONE static risk, so `shell_exec` is
    // `shell` whether it runs `ls` or `rm -rf /`; the classifier supplies the
    // missing dimension. Escalation only — it never denies on its own (ADR-0009),
    // because a "safe" verdict from an incomplete list must never read as a grant.
    const command = typeof input.command === "string" ? input.command : "";
    const destructive = risk === "destructive" || isDestructiveCommand(command);
    const credentials = touchesAgentCredentials(command);
    const fingerprint = toolCallHash(call.name, call.input);
    const response =
      requestApproval === undefined
        ? false
        : await requestApproval(call.name, call.input, {
            fingerprint,
            destructive,
            ...(credentials ? { credentials } : {}),
          });
    if (!isApprovalFor(response, fingerprint)) {
      return { output: `command not approved by the user; not executed`, isError: true };
    }
  } else if (risk === "delegate") {
    if (requestApproval !== undefined) {
      const fingerprint = toolCallHash(call.name, call.input);
      const response = await requestApproval(call.name, call.input, { fingerprint, destructive: false });
      if (!isApprovalFor(response, fingerprint)) {
        return { output: `subagent spawn not approved by the user; not executed`, isError: true };
      }
    }
  } else if (risk !== "read") {
    return { output: `tool "${call.name}" (risk ${risk}) is not permitted`, isError: true };
  }

  return tool.invoke(input);
}
