// Assembled offline read-only run loop (flow 009, W7 / S5, task-R0-03).
//
// `runOffline` wires the Release 0 harness slices into one deterministic,
// OFFLINE run: startup (S1) -> trusted-context manifest (S1) ->
// provider.stream (W5/W6) -> on each `tool_call_end`: policy decide (S3) ->
// on allow: budget/loop guards -> tool executor invoke (W5/W6) -> redaction
// (S4) + append-only session record (S2) + evidence linkage (S4) -> on
// `model_end`: completion gate (S4) -> a schema-valid `HarnessRunOutput`.
//
// Deterministic + offline by construction: the clock and id sequence are
// injected via `deps`; there is NO `Date.now`, `Math.random`, network, real
// timer, or filesystem mutation anywhere. Every stop condition (malformed tool
// input, bounded tool failure, hard budget boundary, repeated ineffective
// loop) is modelled through the injected provider transcript / executor stub,
// never a real wall-clock wait. This module assembles the existing S1-S4 /
// W5 / W6 modules by import and rewrites none of them.
import { createHash } from "node:crypto";
import type { HarnessConfig } from "../config";
import {
  type CompletionGateResult,
  type RequiredGate,
  evaluateCompletion,
} from "../completion/gate";
import { redactForPersistence } from "../evidence/redaction";
import { decide } from "../policy/engine";
import type { PolicyContext, PolicyDecision, PolicyProfile } from "../policy/types";
import type { NormalizedEvent, NormalizedRequest, ProviderPort } from "../provider/types";
import { AppendOnlySession } from "../session/session";
import type { ArtifactRef, SessionEntry } from "../session/types";
import type { ToolRegistry } from "../tool/registry";
import type {
  ToolCall,
  ToolExecutorPort,
  ToolInvocation,
  ToolResult,
  ToolRisk,
} from "../tool/types";
import { startRun } from "../startup";
import type { HarnessRunInput } from "../types";

/** Every durable harness contract in Release 0 is schemaVersion 1. */
const SCHEMA_VERSION = 1;

/**
 * The number of times a single normalized action (same tool + same input) may
 * be dispatched before the run declares a repeated ineffective loop and stops
 * with a bounded next action (@SC_R12_LOOP_DETECTION). The occurrence that
 * *reaches* this count is the one that trips the guard, so strictly fewer than
 * `LOOP_THRESHOLD` executions happen for a runaway repeat.
 */
const LOOP_THRESHOLD = 3;

/**
 * The typed, non-status stop-reason surface carried on `HarnessRunOutput`.
 * These literals are NOT `status` values (the status enum has no such member);
 * they are the machine-readable reason a run stopped short of completion.
 */
export type UnresolvedRisk = "budget_exceeded" | "loop_detected";

/**
 * Terminal harness run output. Mirrors `harness-run-output.schema.json` in full
 * PLUS an optional `unresolvedRisks` carrying the typed stop-reason surface
 * (`budget_exceeded` / `loop_detected`). A constructed value validates against
 * that frozen schema unchanged (the extra `unresolvedRisks` key is declared by
 * the schema itself).
 */
export interface HarnessRunOutputMetrics {
  provider?: string;
  model?: string;
  toolCalls: number;
  modelRequests: number;
  retries: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  wallSeconds?: number | null;
  reliability?: "exact" | "estimated" | "unknown";
}

export interface HarnessRunOutput {
  schemaVersion: number;
  runId: string;
  sessionId?: string;
  flowId?: string;
  status: "completed" | "failed" | "blocked" | "cancelled" | "paused" | "in-progress";
  startedAt: string;
  finishedAt: string | null;
  summary?: string;
  gate: CompletionGateResult;
  artifacts: string[];
  metrics: HarnessRunOutputMetrics;
  unresolvedRisks?: string[];
  unresolvedBlockerIds: string[];
}

/**
 * Injected dependencies for a single assembled run. `clock`/`idSeq` are the only
 * sources of non-determinism; `provider`/`toolExecutor` are the (offline) W5/W6
 * ports; `policyProfile` is the frozen S3 security profile; `interactive`
 * governs the S3 headless fail-closed posture.
 */
export interface RunDeps {
  provider: ProviderPort;
  toolRegistry: ToolRegistry;
  toolExecutor: ToolExecutorPort;
  policyProfile: PolicyProfile;
  clock: () => string;
  idSeq: () => string;
  interactive: boolean;
}

/**
 * The full result of an assembled run. `output` is the schema-valid terminal
 * document; `events`/`decisions`/`sessionEntries` are the ordered in-memory
 * trails a transport or a replay fixture is built over. The `*Hash` fields and
 * `sessionManifest` are the deterministic recomputable state a replay fixture
 * binds to (see `../replay/replay.ts`).
 */
export interface RunResult {
  output: HarnessRunOutput;
  events: NormalizedEvent[];
  decisions: PolicyDecision[];
  sessionEntries: SessionEntry[];
  sessionManifestHash: string;
  eventLogHash: string;
  toolRegistryHash: string;
  transcriptHash: string;
  expectedStateHash: string;
}

// Stable, key-sorted serialization so a content fingerprint is independent of
// property insertion order. Mirrors the sibling canonicalizers across S1-S4.
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Deduplicate strings while preserving first-seen order. */
function uniqueInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/** A single completed tool call's outcome, for later state hashing. */
interface ExecutedCall {
  toolCallId: string;
  toolName: string;
  result: ToolResult;
}

/**
 * Assemble and run one offline read-only harness turn. Deterministic given
 * `deps`: two runs over identical `(input, config, deps-with-identical-clock/idSeq)`
 * produce byte-identical results.
 */
export async function runOffline(
  input: HarnessRunInput,
  config: HarnessConfig,
  deps: RunDeps,
): Promise<RunResult> {
  const startedAt = deps.clock();
  const startup = startRun(input, config, deps);

  // Non-started startup outcomes are terminal, schema-valid, and never open a
  // provider stream (deterministic no-load / environment-blocked floor).
  if (startup.kind !== "started") {
    const reason =
      startup.kind === "disabled"
        ? "Harness disabled: deterministic no-load floor."
        : `Startup blocked: ${startup.reason}`;
    return earlyTermination(input, config, deps, startedAt, reason);
  }

  const { manifest } = startup;
  const runId = `run-${manifest.contextHash.slice(0, 32)}`;
  const sessionId = `session-${manifest.contextHash.slice(0, 32)}`;
  const provider = input.provider ?? config.defaultProvider ?? "fake-provider";
  const model = input.model ?? config.defaultModel ?? "fixture-model";

  const session = new AppendOnlySession(
    {
      sessionId,
      runId,
      createdAt: startedAt,
      policyFingerprint: deps.policyProfile.fingerprint,
      contextManifestHash: manifest.contextHash,
    },
    { clock: deps.clock, idSeq: deps.idSeq },
  );

  // A trusted-context evidence anchor is always present so the completion gate's
  // evidenceRefs are non-empty even on a run that executes no tool.
  const presentEvidenceIds: string[] = [];
  const contextEvidenceId = deps.idSeq();
  presentEvidenceIds.push(contextEvidenceId);

  const artifacts: string[] = [manifest.contextHash];
  const decisions: PolicyDecision[] = [];
  const events: NormalizedEvent[] = [];
  const executed: ExecutedCall[] = [];
  const blockerIds: string[] = [];
  const unresolvedRisks: UnresolvedRisk[] = [];

  // Deterministic, offline redaction scanner (S4). No content is protected in a
  // fixture run; the seam is exercised so a real scanner drops in unchanged.
  const scan = () => ({ hasSecret: false }) as const;

  const toolNameByCall = new Map<string, string>();
  const actionCounts = new Map<string, number>();
  let executedToolCalls = 0;
  let finalMessageEmitted = false;

  const request: NormalizedRequest = {
    providerId: provider,
    modelId: model,
    systemInstruction: "Keryx harness offline run (Release 0).",
    messages: [{ role: "user", content: input.request, provenance: "project" }],
    budget: { maxOutputTokens: 1000, runReservation: 1000 },
    stream: true,
    requestId: `req-${manifest.contextHash.slice(0, 32)}`,
    parentRunId: runId,
  };

  const maxToolCalls = input.budget.maxToolCalls;
  let modelRequests = 0;

  modelRequests += 1;
  const stream = deps.provider.stream(request, { attemptId: `attempt-${runId}` });

  for await (const event of stream) {
    events.push(event);

    if (event.kind === "model_end") {
      finalMessageEmitted = true;
      continue;
    }

    if (event.kind === "tool_call_start") {
      if (event.toolCallId !== undefined && event.toolName !== undefined) {
        toolNameByCall.set(event.toolCallId, event.toolName);
      }
      continue;
    }

    if (event.kind !== "tool_call_end") {
      continue;
    }

    // --- A complete tool call arrived. Resolve the tool + normalized input. ---
    const toolCallId = event.toolCallId;
    if (toolCallId === undefined) continue;
    const toolName = toolNameByCall.get(toolCallId) ?? event.toolName;
    if (toolName === undefined) continue;
    const definition = deps.toolRegistry.get(toolName);
    if (definition === undefined) continue;

    const parsedInput = parseInput(event.input);
    const risk: ToolRisk = definition.risk;

    const call: ToolCall = {
      schemaVersion: SCHEMA_VERSION,
      toolCallId,
      toolName,
      input: parsedInput,
      runId,
      sessionId,
      role: input.role,
      risk,
      projectRoot: input.projectRoot,
      origin: "model",
    };

    const actionFingerprint = sha256(canonicalize({ toolName, input: parsedInput }));
    const policyContext: PolicyContext = {
      profile: deps.policyProfile,
      role: input.role,
      interactive: deps.interactive,
      approvals: [],
      actionFingerprint,
    };
    const decision = decide({ toolCallId, risk }, policyContext, {
      clock: deps.clock,
      idSeq: deps.idSeq,
    });
    decisions.push(decision);

    // Persist the policy decision as an append-only session record (S2).
    session.append(
      {
        type: "policy_decision",
        toolCallId,
        artifactRef: makeArtifactRef(`decision-${toolCallId}`, "policy-decision", sha256(canonicalize(decision))),
      },
      { correlationId: toolCallId },
    );

    // A transport can never upgrade a policy decision: only an in-process
    // `allow` reaches the executor (@SC_R13_TRANSPORT_CANNOT_CHANGE_POLICY).
    if (decision.decision !== "allow") {
      continue;
    }

    // --- Hard budget boundary: stop before starting a call over the ceiling. ---
    if (executedToolCalls >= maxToolCalls) {
      unresolvedRisks.push("budget_exceeded");
      blockerIds.push("blocker:budget_exceeded");
      break;
    }

    // --- Loop detection: the same normalized action repeated past threshold. ---
    const nextCount = (actionCounts.get(actionFingerprint) ?? 0) + 1;
    actionCounts.set(actionFingerprint, nextCount);
    if (nextCount >= LOOP_THRESHOLD) {
      unresolvedRisks.push("loop_detected");
      blockerIds.push("blocker:loop_detected");
      break;
    }

    const invocation: ToolInvocation = {
      call,
      provenance: {
        projectRoot: input.projectRoot,
        worktree: input.projectRoot,
        sessionId,
        turn: executedToolCalls + 1,
        toolCallId,
      },
      budget: definition.limits,
    };

    executedToolCalls += 1;

    let result: ToolResult | undefined;
    try {
      result = await deps.toolExecutor.invoke(invocation);
    } catch {
      // Malformed / schema-invalid input rejected by the executor gate before
      // any receipt: record a typed blocker, never a tool_result with an
      // artifactRef (@SC_R04_MALFORMED_TOOL_INPUT — "no execution receipt").
      blockerIds.push(`blocker:tool-rejected:${toolCallId}`);
      continue;
    }

    executed.push({ toolCallId, toolName, result });

    // Redact the tool result for persistence (S4) before it is recorded.
    const redaction = redactForPersistence(canonicalize(result), { scan });
    if (redaction.blocked) {
      blockerIds.push(`blocker:redaction-failed:${toolCallId}`);
      continue;
    }

    const artifactRef = makeArtifactRef(`tool-result-${toolCallId}`, "tool-result", redaction.hash);
    session.append({ type: "tool_result", toolCallId, artifactRef }, { correlationId: toolCallId });

    const evidenceId = deps.idSeq();
    presentEvidenceIds.push(evidenceId);
    artifacts.push(result.outputHash);

    // A bounded typed failure (timeout / output overflow) is recorded but never
    // treated as success: it becomes an undisposed blocker so the run cannot
    // falsely complete (@SC_R04_TOOL_TIMEOUT / @SC_R04_TOOL_OUTPUT_OVERFLOW).
    if (result.status !== "succeeded") {
      blockerIds.push(`blocker:tool-${result.errorCode ?? "failed"}:${toolCallId}`);
    }
  }

  // --- Completion gate (S4): the single authority on whether the run passed. ---
  const requiredGates: RequiredGate[] = [];
  const gate = evaluateCompletion(
    {
      runId,
      requiredGates,
      requiredEvidenceRefs: [],
      presentEvidenceIds: uniqueInOrder(presentEvidenceIds),
      undisposedBlockerIds: uniqueInOrder(blockerIds),
      finalMessageEmitted,
    },
    { clock: deps.clock, idSeq: deps.idSeq },
  );

  const status = resolveStatus(unresolvedRisks, gate.status);
  const finishedAt = deps.clock();

  const output: HarnessRunOutput = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    sessionId,
    status,
    startedAt,
    finishedAt,
    gate,
    artifacts: uniqueInOrder(artifacts),
    metrics: {
      provider,
      model,
      toolCalls: executedToolCalls,
      modelRequests,
      retries: 0,
      inputTokens: null,
      outputTokens: null,
      wallSeconds: null,
      reliability: "unknown",
    },
    unresolvedBlockerIds: uniqueInOrder(gate.unresolvedBlockerIds),
  };
  if (input.flowId !== undefined) output.flowId = input.flowId;
  if (unresolvedRisks.length > 0) output.unresolvedRisks = [...unresolvedRisks];

  const sessionEntries = session.entries();
  const sessionManifestHash = sha256(canonicalize(session.manifest()));
  const eventLogHash = sha256(canonicalize(events));
  const transcriptHash = sha256(`transcript:${canonicalize(events)}`);
  const toolRegistryHash = deps.toolRegistry.snapshot({
    snapshotId: `snapshot-${runId}`,
    createdAt: startedAt,
  }).registryHash;
  const expectedStateHash = sha256(
    canonicalize({ output, sessionEntries, executed: executed.map((e) => e.result) }),
  );

  return {
    output,
    events,
    decisions,
    sessionEntries,
    sessionManifestHash,
    eventLogHash,
    toolRegistryHash,
    transcriptHash,
    expectedStateHash,
  };
}

/** Parse a normalized `tool_call_end` input string into a record (fail-safe to `{}`). */
function parseInput(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Build an `artifactRef` mirroring `harness-envelope.schema.json#/$defs/artifactRef`. */
function makeArtifactRef(artifactId: string, kind: string, hash: string): ArtifactRef {
  return { artifactId, kind, hash };
}

/**
 * Map the completion-gate verdict + any typed stop-reason to a terminal run
 * status. A stop-reason always blocks; otherwise the gate decides: `pass` ->
 * completed, `blocked` -> blocked, anything else -> failed.
 */
function resolveStatus(
  unresolvedRisks: readonly UnresolvedRisk[],
  gateStatus: CompletionGateResult["status"],
): HarnessRunOutput["status"] {
  if (unresolvedRisks.length > 0) return "blocked";
  if (gateStatus === "pass") return "completed";
  if (gateStatus === "blocked") return "blocked";
  return "failed";
}

/**
 * Build a terminal `RunResult` for a non-started startup outcome without opening
 * a provider stream. The output is schema-valid (`status: "failed"`, a
 * non-passing gate anchored to a synthetic context evidence id).
 */
function earlyTermination(
  input: HarnessRunInput,
  config: HarnessConfig,
  deps: RunDeps,
  startedAt: string,
  reason: string,
): RunResult {
  const runId = `run-${sha256(reason).slice(0, 32)}`;
  const evidenceId = deps.idSeq();
  const gate = evaluateCompletion(
    {
      runId,
      requiredGates: [],
      requiredEvidenceRefs: [],
      presentEvidenceIds: [evidenceId],
      undisposedBlockerIds: ["blocker:startup"],
      finalMessageEmitted: false,
    },
    { clock: deps.clock, idSeq: deps.idSeq },
  );
  const provider = input.provider ?? config.defaultProvider ?? "unknown";
  const model = input.model ?? config.defaultModel ?? "unknown";
  const output: HarnessRunOutput = {
    schemaVersion: SCHEMA_VERSION,
    runId,
    status: "failed",
    startedAt,
    finishedAt: deps.clock(),
    summary: reason,
    gate,
    artifacts: [sha256(reason)],
    metrics: {
      provider,
      model,
      toolCalls: 0,
      modelRequests: 0,
      retries: 0,
      inputTokens: null,
      outputTokens: null,
      wallSeconds: null,
      reliability: "unknown",
    },
    unresolvedBlockerIds: uniqueInOrder(gate.unresolvedBlockerIds),
  };
  const eventLogHash = sha256(canonicalize([]));
  return {
    output,
    events: [],
    decisions: [],
    sessionEntries: [],
    sessionManifestHash: sha256(canonicalize({ runId })),
    eventLogHash,
    toolRegistryHash: deps.toolRegistry.snapshot({ snapshotId: `snapshot-${runId}`, createdAt: startedAt })
      .registryHash,
    transcriptHash: sha256(`transcript:${canonicalize([])}`),
    expectedStateHash: sha256(canonicalize({ output })),
  };
}
