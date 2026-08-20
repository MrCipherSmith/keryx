// MCP-shaped supervisor for `codex-cli` (flow 182, T7/T8). Package:
// docs/requirements/keryx-mcp-client specification.md §3-§4, §9; plan.md
// steps 2-4.
//
// A SECOND, ADDITIVE supervision path, alongside — not replacing —
// `superviseExternalRun` (`./supervise.ts`), which `claude-cli` keeps using
// unchanged (specification.md §4). `superviseExternalRun`'s
// `ExternalSpawnPort`/`SpawnedProcess` seam is built entirely around
// line-based stdout/stderr text streaming; an MCP client needs bidirectional
// structured JSON-RPC messages with a request that must be answered out of
// band while other messages keep flowing, which is why this is a genuinely
// separate function rather than a parameter to the existing one
// (decisions.md D-03's accepted cost).
//
// This module is NOT wired into `src/harness/external/dispatch.ts`'s
// `validateRuntimeBlock` or `IMPLEMENTED_SANDBOX_MODES`, and does not touch
// either — that release gate (`worktree-write` refused at runtime) belongs to
// a different package (`keryx-external-agent-runtime` D-04) and lifting it is
// explicitly out of scope here. This function is real, callable, and tested
// via an injected fake exactly like `superviseExternalRun`, ready for a
// future task to wire into an actual dispatch path.
//
// AC8: the elicitation exchange itself produces NO `ExternalEvent` — it is a
// side channel this supervisor owns, recorded in `elicitations`, not `events`.
// `bridgeExternalEvent`/`reduceAgents` (`./agent-event-bridge.ts`) are neither
// imported nor touched by this file.
import { classifyElicitationRisk, correlateElicitation, buildElicitationResponse, toPendingElicitation } from "../../mcp-client/elicitation";
import { isExecApprovalRequestEvent } from "../../mcp-client/wire";
import { resolveApprovalDecision, type ApprovalGateDecision, type PermissionMode } from "../../commands/permission-mode";
import type { AgentIO, ApprovalResponse } from "../../commands/agent";
import type {
  ElicitationResponsePayload,
  McpClientPort,
  McpSpawnOptions,
  McpToolCallOutcome,
  RawCodexEventNotification,
} from "../../mcp-client/types";
import type { ElicitationVerdict } from "../../mcp-client/elicitation";
import type { ExternalEvent } from "./types";

/** Argv for the codex MCP server child. Re-exported so callers do not need `../../mcp-client/client` for this alone. */
export { buildCodexMcpServerArgv } from "../../mcp-client/client";

/**
 * Default ceiling for one `tools/call` round-trip.
 *
 * Matches `EXTERNAL_AGENTS_DEFAULTS.defaultTimeoutMs`
 * (`src/capability/external-agents.ts`) rather than the SDK's own 60s
 * default: per the T5 live probe, the outer `tools/call` promise can outlive
 * a cleanly-declined elicitation and hit the SDK's default client timeout
 * (`McpError -32001`) even after the elicitation itself resolved correctly —
 * this is the "independent timeout/cancellation handling" plan step 4 calls
 * for, applied by always passing an explicit `timeout` rather than trusting
 * the SDK's default.
 */
export const DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS = 600_000;

/** One elicitation this supervisor answered, kept as a DIAGNOSTIC record — never an `ExternalEvent` (AC8). */
export interface ElicitationHandledRecord {
  readonly requestId: string | number;
  readonly callId: string | undefined;
  /** Whether a sibling `codex/event` supplied a decision vocabulary for this request. */
  readonly correlation: "correlated" | "uncorrelated";
  /** What `resolveApprovalDecision` returned — always called, per AC6. */
  readonly gateDecision: ApprovalGateDecision;
  readonly verdict: ElicitationVerdict;
  readonly response: ElicitationResponsePayload;
}

export interface SuperviseCodexMcpInput {
  /** Absolute path the child runs in — the disposable worktree, same as `superviseExternalRun`. */
  readonly cwd: string;
  /** The stripped child environment, built by `buildExternalChildEnv` exactly like the line-stream path. */
  readonly env: Record<string, string>;
  /** The complete argv for the codex MCP server child. Use {@link buildCodexMcpServerArgv} for the standard case. */
  readonly argv: readonly string[];
  /**
   * The MCP tool name on the `codex mcp-server` child to invoke for this run.
   * NOT hardcoded here: the T5 live probe confirmed the codex MCP server's
   * per-call argument keys (`sandbox`, `approval-policy`, dash-cased — distinct
   * from the TOML spawn-config keys `sandbox_mode`/`approval_policy`) but did
   * not pin the tool's own name as part of this task's scope, so a caller
   * supplies both explicitly rather than this module guessing.
   */
  readonly toolName: string;
  readonly toolArguments: Record<string, unknown>;
  /** Ceiling for the `tools/call` round-trip. Defaults to {@link DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS}. */
  readonly toolCallTimeoutMs?: number;
  /** The session's permission mode — read once per run, mirrors `executeCall`'s `permissionMode?.()` read. */
  readonly mode: PermissionMode;
}

/** Callbacks and ports {@link superviseCodexMcpRun} needs. */
export interface SuperviseCodexMcpDeps {
  /** The MCP transport seam. The only mandatory impure dependency — production passes `codexMcpClientPort`. */
  readonly client: McpClientPort;
  /**
   * Same shape as `AgentIO["requestApproval"]`, so a caller can pass the
   * interactive session's own approver directly. DEFAULT-DENY when absent —
   * mirrors `executeCall`'s existing gated-risk floor exactly (headless
   * safety is inherited for free, per specification.md §9).
   */
  readonly requestApproval: AgentIO["requestApproval"];
  /** Called for each `ExternalEvent` as it happens. Never receives an elicitation event — see AC8. */
  readonly onEvent?: (event: ExternalEvent) => void;
  /** Called once per elicitation this supervisor answered. Diagnostic only, never folded into `events`. */
  readonly onElicitationHandled?: (record: ElicitationHandledRecord) => void;
}

/** What one supervised MCP run produced. */
export interface SuperviseCodexMcpOutcome {
  readonly toolCall: McpToolCallOutcome;
  readonly events: readonly ExternalEvent[];
  readonly elicitations: readonly ElicitationHandledRecord[];
}

function isApprovalGranted(response: ApprovalResponse): boolean {
  if (typeof response === "boolean") return response;
  return response.approved === true;
}

/**
 * Spawn one `codex mcp-server` child, complete the MCP handshake, answer every
 * elicitation it raises, drive one `tools/call`, and return what happened.
 *
 * Elicitation handling (T8): every `elicitation/create` this connection
 * raises is answered through {@link SuperviseCodexMcpDeps.client}'s
 * `onElicitation` seam, which is called with the answer to send — see
 * `src/mcp-client/client.ts`'s header for why the response must be returned
 * from that callback rather than sent separately. For each one:
 *
 *   1. Correlate it with a sibling `codex/event` (`exec_approval_request`) by
 *      `call_id`, via {@link correlateElicitation}. Uncorrelated means no
 *      decision vocabulary is known for this request (AC5's live
 *      manifestation — see `elicitation.ts`).
 *   2. Classify its risk via {@link classifyElicitationRisk} — a T9
 *      placeholder today (always `{destructive: false, credentials: false}`),
 *      a real seam already wired for T9 to fill in.
 *   3. Call `resolveApprovalDecision` UNCONDITIONALLY (AC6) with `risk: "write"`
 *      — an elicitation-driven write is the closest existing `GatedToolRisk`
 *      shape, per specification.md §9's `apply_patch`/ADR-0010 analogy.
 *   4. On `"auto"`, approve without a prompt. On `"ask"`, call
 *      `deps.requestApproval` — DEFAULT-DENY when absent, never a prompt no
 *      one can answer.
 *   5. Build the exact `{action, decision}` payload via
 *      {@link buildElicitationResponse} and return it.
 *
 * None of this produces an `ExternalEvent` (AC8) — each answered elicitation
 * is recorded only in the returned `elicitations` array and, incrementally,
 * via `deps.onElicitationHandled`.
 */
export async function superviseCodexMcpRun(
  input: SuperviseCodexMcpInput,
  deps: SuperviseCodexMcpDeps,
): Promise<SuperviseCodexMcpOutcome> {
  const events: ExternalEvent[] = [];
  const elicitations: ElicitationHandledRecord[] = [];
  const pendingCodexEvents = new Map<string, RawCodexEventNotification>();

  const emit = (event: ExternalEvent): void => {
    events.push(event);
    deps.onEvent?.(event);
  };

  const spawnOptions: McpSpawnOptions = { cwd: input.cwd, env: input.env };
  const connection = await deps.client.connect(input.argv, spawnOptions);
  emit({ kind: "child_started" });

  connection.onCodexEvent((event) => {
    // Sent just before its elicitation (T5 live probe finding) — stashed by
    // call_id so the elicitation handler below can find it once it arrives.
    if (isExecApprovalRequestEvent(event) && event.callId !== undefined) {
      pendingCodexEvents.set(event.callId, event);
    }
  });

  connection.onElicitation(async (request): Promise<ElicitationResponsePayload> => {
    const pending = toPendingElicitation(request);
    const correlation = correlateElicitation(pending.callId, pendingCodexEvents);
    const { destructive, credentials } = classifyElicitationRisk(pending);

    // AC6: resolveApprovalDecision is called for EVERY received elicitation,
    // whether or not it could be correlated — an uncorrelated one still gets
    // gated, it just cannot be answered "accept" even if the gate says auto
    // (buildElicitationResponse forces decline for `uncorrelated`).
    const gateDecision = resolveApprovalDecision({
      mode: input.mode,
      risk: "write",
      destructive,
      credentials,
      sacReviewConfirmation: false,
    });

    let verdict: ElicitationVerdict;
    if (gateDecision === "auto") {
      verdict = "approve";
    } else {
      // DEFAULT-DENY when no approver is wired — identical floor to every
      // other gated risk in `executeCall` (agent.ts).
      const response =
        deps.requestApproval === undefined
          ? false
          : await deps.requestApproval(
              `mcp_elicitation:${String(pending.requestId)}`,
              JSON.stringify({ message: pending.message, vendor: pending.vendor }),
              {
                fingerprint: String(pending.requestId),
                destructive,
                ...(credentials ? { credentials } : {}),
              },
            );
      verdict = isApprovalGranted(response) ? "approve" : "deny";
    }

    const response = buildElicitationResponse(verdict, correlation);
    const record: ElicitationHandledRecord = {
      requestId: pending.requestId,
      callId: pending.callId,
      correlation: correlation.kind,
      gateDecision,
      verdict,
      response,
    };
    elicitations.push(record);
    deps.onElicitationHandled?.(record);
    return response;
  });

  const toolCall = await connection.callTool(input.toolName, input.toolArguments, {
    timeoutMs: input.toolCallTimeoutMs ?? DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
  });

  if (toolCall.kind === "result") {
    emit({ kind: "child_finished" });
  } else if (toolCall.kind === "timeout") {
    emit({ kind: "child_failed", message: "codex mcp tool call timed out waiting for a result" });
  } else {
    emit({ kind: "child_failed", message: toolCall.message });
  }

  await connection.close();

  return { toolCall, events, elicitations };
}
