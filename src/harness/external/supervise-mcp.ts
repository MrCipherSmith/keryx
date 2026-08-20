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
import {
  classifyElicitationRisk,
  correlateElicitation,
  buildElicitationResponse,
  extractCommandTextForClassification,
  toPendingElicitation,
  MCP_ELICITATION_TOOL_PREFIX,
} from "../../mcp-client/elicitation";
import { isExecApprovalRequestEvent } from "../../mcp-client/wire";
import { touchesSacConfirmReview } from "../../lib/command-risk";
import { resolveApprovalDecision, type ApprovalGateDecision, type PermissionMode } from "../../commands/permission-mode";
import {
  agentConfig,
  resolveExternalAgentsCapability,
  type ExternalAgentsGateInput,
} from "../../capability/external-agents";
import { isApprovalFor, type AgentIO } from "../../commands/agent";
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

/**
 * Default ceiling for answering ONE elicitation via `deps.requestApproval`
 * (T10, AC4) — independent of, and much shorter than,
 * {@link DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS}'s outer round-trip bound.
 *
 * Per the T5 live probe (context.md "T5 live probe findings"), codex itself
 * self-aborts an unanswered elicitation after ~55-60s (`codex/event`
 * `turn_aborted`, `reason: "interrupted"`). Keryx does not need to race
 * codex to be safe — a hang either way is bounded by codex's own ceiling —
 * but if it wants to OWN the shape of the refusal (a named, distinguishable
 * timeout-driven decline recorded in `ElicitationHandledRecord.timedOut`)
 * rather than reactively absorbing codex's unprompted abort long after an
 * operator has plainly walked away, its own ceiling must fire first, with
 * real margin. 45s leaves ~10-15s of margin under the observed 55-60s
 * window while still being generous for a human to actually read a prompt
 * and answer it — deliberately looser than
 * `external-agent-probe.ts`'s `PROBE_TIMEOUT_MS` (a machine-speed version
 * check with no one to wait on), because this timer is racing a human, not
 * a subprocess.
 */
export const DEFAULT_ELICITATION_TIMEOUT_MS = 45_000;

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
  /**
   * True when this record's `verdict: "deny"` came from
   * {@link DEFAULT_ELICITATION_TIMEOUT_MS}/`elicitationTimeoutMs` firing
   * before `deps.requestApproval` resolved (T10, AC4) — distinguishes a
   * timeout-driven refusal from an operator genuinely answering "no" (always
   * `timedOut: false`) or an unwired approver's default-deny (also
   * `timedOut: false` — that path never starts the timer at all, it denies
   * immediately). Always `false` for a `gateDecision: "auto"` record, since
   * no approval wait ever happens on that path.
   */
  readonly timedOut: boolean;
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
  /**
   * Ceiling for answering ONE elicitation via `deps.requestApproval` (T10,
   * AC4). Defaults to {@link DEFAULT_ELICITATION_TIMEOUT_MS}. Never applies
   * when `gateDecision === "auto"` (no wait happens) or when
   * `deps.requestApproval` is undefined (denies immediately, no timer
   * needed).
   */
  readonly elicitationTimeoutMs?: number;
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
  /**
   * Same shape as `AgentIO["onAutoApproved"]` — called on the `gateDecision
   * === "auto"` path, mirroring `executeCall`'s (`agent.ts`) own call shape
   * for every other gated risk (flow 182 fix round). Without this, a
   * `trust`/`auto`-mode elicitation auto-approval was previously invisible
   * everywhere — no shell/TUI transcript surfaced it at all. `tool` is the
   * same `${MCP_ELICITATION_TOOL_PREFIX}${requestId}` synthetic name used for
   * the `requestApproval` call on the `"ask"` path, for consistency.
   */
  readonly onAutoApproved?: AgentIO["onAutoApproved"];
}

/** What one supervised MCP run produced. */
export interface SuperviseCodexMcpOutcome {
  readonly toolCall: McpToolCallOutcome;
  readonly events: readonly ExternalEvent[];
  readonly elicitations: readonly ElicitationHandledRecord[];
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
 *   2. Classify its risk via {@link classifyElicitationRisk} (T9) — derives
 *      `destructive`/`credentials` from `vendor.codex_command` (reusing
 *      `isDestructiveCommand`/`touchesAgentCredentials`) and
 *      `vendor.codex_elicitation === "patch-approval"`.
 *   3. Call `resolveApprovalDecision` UNCONDITIONALLY (AC6) with `risk: "write"`
 *      — an elicitation-driven write is the closest existing `GatedToolRisk`
 *      shape, per specification.md §9's `apply_patch`/ADR-0010 analogy.
 *   4. On `"auto"`, approve without a prompt. On `"ask"`, call
 *      `deps.requestApproval` — DEFAULT-DENY when absent, never a prompt no
 *      one can answer; when present, raced against
 *      {@link DEFAULT_ELICITATION_TIMEOUT_MS}/`elicitationTimeoutMs` (T10,
 *      AC4) so an operator who never answers still resolves to a named,
 *      distinguishable timeout-driven decline rather than a hang.
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

    // Derived the SAME way every other `resolveApprovalDecision` call site in
    // this codebase does (`agent.ts`'s `executeCall`, `shell`/`destructive`
    // branch): `touchesSacConfirmReview` against the actual command text —
    // NOT hardcoded `false` (flow 182 fix round). `sacReviewConfirmation` is a
    // hard floor on `resolveApprovalDecision`'s own contract (forces `"ask"`
    // even under `trust`/`auto`), so hardcoding it false let a codex command
    // touching keryx's own SAC review-confirmation surface auto-approve.
    // Uses the same unwrapped-when-possible command text
    // `classifyElicitationRisk` itself classifies against, via
    // `extractCommandTextForClassification` — one extraction, not a second
    // one that could drift.
    const commandText = extractCommandTextForClassification(pending.vendor) ?? "";
    const sacReviewConfirmation = touchesSacConfirmReview(commandText);

    // AC6: resolveApprovalDecision is called for EVERY received elicitation,
    // whether or not it could be correlated — an uncorrelated one still gets
    // gated, it just cannot be answered "accept" even if the gate says auto
    // (buildElicitationResponse forces decline for `uncorrelated`).
    const gateDecision = resolveApprovalDecision({
      mode: input.mode,
      risk: "write",
      destructive,
      credentials,
      sacReviewConfirmation,
    });

    const toolName = `${MCP_ELICITATION_TOOL_PREFIX}${String(pending.requestId)}`;
    const inputJson = JSON.stringify({ message: pending.message, vendor: pending.vendor });
    const fingerprint = String(pending.requestId);

    let verdict: ElicitationVerdict;
    let timedOut = false;
    if (gateDecision === "auto") {
      verdict = "approve";
      // Mirrors `executeCall`'s (`agent.ts`) own auto-approve call shape for
      // every other gated risk — without this, an elicitation auto-approved
      // under `trust`/`auto` mode was invisible everywhere (flow 182 fix round).
      deps.onAutoApproved?.(toolName, inputJson, { destructive, credentials });
    } else if (deps.requestApproval === undefined) {
      // DEFAULT-DENY when no approver is wired — identical floor to every
      // other gated risk in `executeCall` (agent.ts). No wait, no timer.
      verdict = "deny";
    } else {
      // T10, AC4: the approval-await gets its OWN, shorter timeout,
      // independent of the outer `client.callTool` bound above — an
      // operator who has walked away leaves this promise pending forever
      // otherwise; `client.callTool`'s timeout only bounds the JSON-RPC
      // round trip, not this nested await inside our own handler. Same
      // race-a-timer idiom as `external-agent-probe.ts`'s `createVersionProbe`.
      // `reasons` (classifyElicitationRisk's third field) is deliberately
      // NOT threaded into this metadata object — see `types.ts`'s
      // `ElicitationRiskClassification.reasons` doc for why that mirrors
      // `classifyPatchRisk`'s own current (unwired) precedent at its one
      // call site (agent.ts's `write` branch).
      const approvalPromise = deps.requestApproval(toolName, inputJson, {
        fingerprint,
        destructive,
        ...(credentials ? { credentials } : {}),
      });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), input.elicitationTimeoutMs ?? DEFAULT_ELICITATION_TIMEOUT_MS);
      });
      try {
        const settled = await Promise.race([approvalPromise, expired]);
        if (settled === "timeout") {
          timedOut = true;
          verdict = "deny";
        } else {
          // Reuses `agent.ts`'s own `isApprovalFor` (flow 182 fix round) —
          // NOT a locally-duplicated "approved === true" check. `deps.requestApproval`
          // is plausibly the SAME approver instance shared across every
          // shell/write/delegate/elicitation prompt in one session, so a
          // stale or mismatched response for a DIFFERENT prompt must be
          // rejected via the fingerprint check, exactly like every other
          // risk branch already does.
          verdict = isApprovalFor(settled, fingerprint) ? "approve" : "deny";
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    const response = buildElicitationResponse(verdict, correlation);
    const record: ElicitationHandledRecord = {
      requestId: pending.requestId,
      callId: pending.callId,
      correlation: correlation.kind,
      gateDecision,
      verdict,
      response,
      timedOut,
    };
    elicitations.push(record);
    deps.onElicitationHandled?.(record);
    // Cleanup, once the sibling `codex/event` this elicitation correlated
    // against (if any) has actually been read above — a single codex turn
    // that raises many elicitations otherwise accumulates one stale Map
    // entry per approval for the run's entire lifetime (flow 182 fix round).
    if (pending.callId !== undefined) {
      pendingCodexEvents.delete(pending.callId);
    }
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

  try {
    await connection.close();
  } catch {
    // Non-fatal, deliberately swallowed (flow 182 fix round): by this point
    // `outcome` is ALREADY fully computed — the tool call succeeded (or
    // failed and was already recorded via `child_failed`) and every event
    // was already emitted. A rejecting `close()` (a real possibility if the
    // underlying SDK's child-process handling misbehaves) must not propagate
    // and discard an already-good outcome the caller worked for. Mirrors
    // `supervise.ts`'s own "recorded, not thrown" cleanup philosophy for
    // post-hoc failures (its `guard`/exit-signal handlers), except this
    // module currently exposes no diagnostic channel (no stderr transcript,
    // no `onWarning`-style callback) to record the failure into — swallowing
    // here is the deliberate, documented choice, not an oversight.
  }

  return { toolCall, events, elicitations };
}

// ---------------------------------------------------------------------------
// Capability gate (T11, specification.md §7)
// ---------------------------------------------------------------------------

/**
 * The registry id `superviseCodexMcpRun` always spawns for — the only vendor
 * this package's MCP-shaped supervision path exists to serve (specification.md
 * §2). Not exported from `registry.ts` as a shared constant; this module does
 * not touch that file (out of scope, see this file's header), so the same
 * literal every other `codex-cli` call site already uses (e.g.
 * `run-external-factory.test.ts`'s `agent: "codex-cli"`) is named once, here.
 */
const CODEX_CLI_AGENT_ID = "codex-cli";

/**
 * Everything {@link gatedSuperviseCodexMcpRun} needs to resolve the capability
 * gate — a strict subset of {@link ExternalAgentsGateInput}, `cwd` required
 * like every other field there, the rest optional exactly as the gate itself
 * allows.
 */
export type SuperviseCodexMcpGateInput = ExternalAgentsGateInput;

/** Why {@link gatedSuperviseCodexMcpRun} refused to run, before any process existed. */
export interface SuperviseCodexMcpRefusal {
  readonly ok: false;
  readonly reason: string;
}

/** {@link gatedSuperviseCodexMcpRun}'s result: the same refusal shape the capability gate already uses, or a real outcome. */
export type GatedSuperviseCodexMcpResult = { readonly ok: true; readonly outcome: SuperviseCodexMcpOutcome } | SuperviseCodexMcpRefusal;

/**
 * The ONE entry point a future caller uses to run {@link superviseCodexMcpRun}
 * for a real `codex mcp-server` child (T11, specification.md §7).
 *
 * Gated by the EXACT SAME capability that already governs every other
 * external-agent dispatch — `gdskills.external-agents`
 * (`src/capability/external-agents.ts`) — via
 * {@link resolveExternalAgentsCapability} called directly, not a second,
 * duplicated gate function. No new capability id, no new config flag, no new
 * `keryx init --something-else` toggle: the only switches consulted are the
 * existing `externalAgents.enabled` and (via {@link agentConfig}, the exact
 * helper `run-external-factory.ts`'s `createRunExternal` calls for this same
 * purpose) the existing per-agent `externalAgents.agents.codex-cli.enabled`.
 *
 * Two gates, in order, mirroring `createRunExternal`'s own sequence for the
 * existing line-stream path:
 *
 *   1. {@link resolveExternalAgentsCapability} — hard disable (remote
 *      transport / CI), the operator's user-global switch, then the project's
 *      manifest opt-in. A refusal here carries that function's own named
 *      reason, unmodified.
 *   2. `codex-cli`'s per-agent config, via `agentConfig(gate.config,
 *      "codex-cli")` — an operator who left the runtime enabled but disabled
 *      `codex-cli` specifically gets the same refusal shape `spawn_subagent`
 *      already gives them for the existing path.
 *
 * `deps.client.connect` (and therefore the child process) is reached ONLY
 * once both gates pass — a disabled capability or a disabled `codex-cli`
 * never touches {@link SuperviseCodexMcpDeps.client} at all, provable by an
 * injected fake exactly like `run-external-factory.test.ts`'s "no spawn and
 * no worktree are ever touched on the unavailable path" test proves the same
 * property for the existing path.
 *
 * NOT wired into `dispatch.ts`, `registry.ts`, or `run-external-factory.ts`'s
 * existing `codex exec` branch — this is a standalone, callable entry point
 * for a future caller to wire in, exactly like {@link superviseCodexMcpRun}
 * itself already is (see this file's header). Production callers pass
 * `{client: codexMcpClientPort, ...}` (`../../mcp-client/client.ts`); this
 * module never imports that port itself, keeping the same offline-testable
 * shape `superviseCodexMcpRun` already has.
 */
export async function gatedSuperviseCodexMcpRun(
  gateInput: SuperviseCodexMcpGateInput,
  input: SuperviseCodexMcpInput,
  deps: SuperviseCodexMcpDeps,
): Promise<GatedSuperviseCodexMcpResult> {
  const gate = await resolveExternalAgentsCapability(gateInput);
  if (!gate.ok) {
    return { ok: false, reason: gate.reason };
  }

  const perAgent = agentConfig(gate.config, CODEX_CLI_AGENT_ID);
  if (!perAgent.enabled) {
    return {
      ok: false,
      reason: `external agent "${CODEX_CLI_AGENT_ID}" is disabled; enable it under \`externalAgents.agents.${CODEX_CLI_AGENT_ID}\` in the keryx user config`,
    };
  }

  const outcome = await superviseCodexMcpRun(input, deps);
  return { ok: true, outcome };
}
