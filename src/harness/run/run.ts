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
import { redactForPersistence, type ScanResult } from "../evidence/redaction";
import { composeDecision } from "../hooks/compose";
import type { HookFireResult, HookInvocationRecord, HookRuntime, HookWarning } from "../hooks";
import { decide } from "../policy/engine";
import { escalateForBlastRadius, metaprojectBlastRadius } from "../policy/metaproject-escalation";
import type { PolicyContext, PolicyDecision, PolicyProfile } from "../policy/types";
import type { MetaprojectPort } from "../tool/metaproject-port";
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
 * Mirrors `commands/agent-hooks.ts`'s `HOOK_TOOL_NAME_ALIASES`/
 * `aliasHookToolName` (flow 306, W6, fix round 1, finding 7): a hook
 * `matcher` is authored against the Claude-Code-shaped tool name
 * (`Bash`/`Edit`), not Keryx's own built-in tool name (`shell_exec`/
 * `apply_patch`) — without this, a project hook matching `"Bash"` silently
 * never fires under `runOffline`/`serve`, only under the interactive `keryx
 * shell` path that already aliases. `run.ts` (harness layer) cannot import
 * from `commands/` (commands sits above harness in the dependency
 * direction), so this small, stable, matcher-only table is duplicated here
 * rather than reaching upward — if either mapping changes, update both. The
 * original Keryx tool name is always carried alongside as `keryxToolName` so
 * a hook command can still recover it.
 */
const RUN_HOOK_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  shell_exec: "Bash",
  apply_patch: "Edit",
};

/** Map a Keryx tool name to the alias a hook `matcher` is tested against (see `RUN_HOOK_TOOL_NAME_ALIASES`). */
function aliasRunHookToolName(keryxToolName: string): string {
  return RUN_HOOK_TOOL_NAME_ALIASES[keryxToolName] ?? keryxToolName;
}

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
  /**
   * OPTIONAL metaproject read port (flow 122 / S1). Additive and default-OFF:
   * when it is `undefined` the run is byte-identical to a run built without the
   * field (the deterministic floor is preserved). It is consulted ONLY by the
   * MP-6 blast-radius escalation below, and only alongside a positive
   * `blastRadiusThreshold`.
   */
  metaprojectPort?: MetaprojectPort;
  /**
   * OPTIONAL blast-radius escalation threshold (flow 122 / MP-6). When both this
   * (`> 0`) and `metaprojectPort` are present, an `allow` for a tool call whose
   * target's affected count meets the threshold is escalated to `ask` via the
   * pure `escalateForBlastRadius` primitive. Absent / `<= 0` => decisions are
   * exactly `decide()`'s output.
   */
  blastRadiusThreshold?: number;
  /**
   * OPTIONAL content scanner for redaction-before-persistence (flow 134 / S2).
   *
   * The seam was here from the start but the only implementation was a local
   * stub that answered `hasSecret: false` to everything, so every tool result
   * this loop persisted was scanned by a function that could not find anything.
   * The real detectors (`security/detect/runDetectors`) are synchronous and
   * pure, which is exactly what this loop's determinism contract needs — what
   * they are not is free of configuration, and configuration lives on disk. So
   * the caller resolves the config once, outside the loop, and injects the
   * closure; the loop stays sync, offline and replayable.
   *
   * Absent ⇒ the previous permissive stub, so a fixture run and every existing
   * caller are byte-identical. `buildSecurityScan` in `security/harness-scan.ts`
   * is the production one.
   */
  scan?: (content: string) => ScanResult;
  /**
   * OPTIONAL completion requirements supplied by the caller (flow 134 / S3).
   *
   * The completion gate has always evaluated `requiredGates` and
   * `requiredEvidenceRefs`, but this loop handed it two empty arrays that no
   * caller could reach. Two of the gate's three conditions were therefore
   * vacuous: a run passed on "a final message and no undisposed blocker", which
   * is exactly the evidence-free completion the gate exists to reject.
   *
   * These live on `RunDeps` rather than on `HarnessRunInput` on purpose. The
   * input document mirrors a frozen schema with `additionalProperties: false`
   * and already carries the one documented local-only extension it is allowed
   * (`credentialRef`); the RPC transport round-trips that document through
   * JSON, so a second and third off-schema key would either be rejected there
   * or silently dropped — a requirement that vanishes in transit is worse than
   * no requirement at all. Deps are the in-process seam, and the caller that
   * knows a flow's frozen acceptance criteria is in-process by construction.
   *
   * Absent ⇒ both lists are empty, i.e. exactly the previous behaviour, so an
   * ad-hoc run with no flow behind it does not start failing.
   */
  completionRequirements?: CompletionRequirements;
  /**
   * OPTIONAL lifecycle hook runtime (flow 306 / W6, task T6).
   *
   * Absent ⇒ byte-identical to a run built without this field: no
   * `SessionStart`/`UserPromptSubmit`/`PreToolUse`/`PostToolUse`/
   * `PostToolUseFailure`/`Stop`/`SessionEnd` event ever fires, no
   * `hook_invocation` session entries are appended, and `RunResult` carries
   * neither `hookInvocations` nor `hookWarnings` — preserving the replay
   * suite's fixture hashes and every existing caller's behaviour.
   *
   * When present:
   *  - `SessionStart` fires once, after `startRun()` returns `started`, before
   *    the first provider request; its `additionalContext` (joined) is
   *    appended to the request's `systemInstruction`.
   *  - `UserPromptSubmit` fires once per run, before `deps.provider.stream` is
   *    ever called, with the raw `input.request` text; its `additionalContext`
   *    is appended to the first user message. A composed `deny` (a tightened
   *    `ask` under `interactive: false` also reads as `deny` — there is no
   *    interactive approver inside `runOffline`) never opens the stream: the
   *    run ends `blocked` with a typed blocker
   *    `blocker:hook-denied:UserPromptSubmit`.
   *  - `PreToolUse` fires per resolved tool call AFTER `decide()` (and the
   *    MP-6 escalation) have run, with `ctx.decideOutcome` set to that
   *    decision's outcome — required for the gate malformed-output failure
   *    table (malformed stdout on exit 0 silent-approves UNLESS `decide()`
   *    would have said `ask`, in which case it denies). This is
   *    observationally equivalent to the spec's "hooks before decide()"
   *    ordering: `decide()` is pure and a hook cannot influence its inputs, so
   *    the hook sees the same payload either way and the only point the two
   *    actually meet is `composeDecision`, which still runs after both are
   *    known. Its decisions are composed with the policy decision via
   *    `composeDecision` afterwards, and the composed decision is what is
   *    pushed/persisted/gates execution. `additionalContext` from a
   *    `PreToolUse` hook has no mid-stream injection point in this offline
   *    loop; it is dropped after being fired (only the hook's decision and its
   *    `hook_invocation` record survive) — the same is true whenever a
   *    downstream consumer needs it (see the module doc for a future
   *    injection point).
   *  - `PostToolUse` fires after a successfully executed tool
   *    (`result.status === "succeeded"`); `PostToolUseFailure` fires when the
   *    executor throws OR resolves with any other status. Both are
   *    observe-only: neither can change `blockerIds` or a tool's `ToolResult`.
   *  - `Stop` fires once per `model_end` event with `stopReason: "model_end"`;
   *    a tightened `deny` adds the typed blocker `blocker:hook-denied:Stop`
   *    (does not retroactively un-execute anything already run).
   *  - `SessionEnd` fires once at the very end of the run, observe-only, with
   *    `endReason` set to the run's own terminal status
   *    (`completed`/`blocked`/`failed`).
   *  - Every `HookInvocationRecord` any of the above produces becomes one
   *    append-only `hook_invocation` session entry, correlated by
   *    `toolCallId` for the per-tool events and by the session's own
   *    deterministic id sequence otherwise.
   *
   * Determinism is preserved because the only non-determinism a hook record
   * could introduce (ids, timestamps) is drawn from `deps.clock`/`deps.idSeq`
   * — the runtime itself is required to be built the same way (see
   * `src/harness/hooks/runtime.ts`).
   */
  hooks?: HookRuntime;
}

/**
 * Caller-stated completion requirements for one run (flow 134 / S3).
 *
 * `requiredGates` names verification gates that must report `pass`.
 * `requiredEvidenceRefs` names evidence ids that must be present among the ones
 * the run records; a missing ref fails the gate. Refs are only nameable by a
 * caller that knows them ahead of time — a parent passing a child run's
 * `evidenceId`, or a deterministic id sequence — which is the case this exists
 * for. Naming an id the run cannot mint is a failing requirement, by design.
 */
export interface CompletionRequirements {
  requiredGates?: readonly RequiredGate[];
  requiredEvidenceRefs?: readonly string[];
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
  /**
   * Every hook invocation recorded during this run, in fire order. ONLY
   * present when `deps.hooks` was supplied (conditional property, so a
   * hooks-absent `RunResult` stays deep-equal to one from before this field
   * existed).
   */
  hookInvocations?: HookInvocationRecord[];
  /** Named hook warnings (e.g. `hook-observer-failed`) accumulated over the run. Present under the same condition as {@link hookInvocations}. */
  hookWarnings?: HookWarning[];
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

  // Deterministic, offline redaction scanner (S4). `deps.scan` is the real one
  // when the caller resolved a security config; the fallback keeps a fixture run
  // byte-identical to what it produced before the seam was fillable.
  const scan: (content: string) => ScanResult =
    deps.scan ?? (() => ({ hasSecret: false }));

  const toolNameByCall = new Map<string, string>();
  const actionCounts = new Map<string, number>();
  let executedToolCalls = 0;
  let finalMessageEmitted = false;

  // --- Hook runtime bookkeeping (flow 306 / W6, T6). Every branch below is a
  // no-op when `deps.hooks` is absent, preserving byte-identical behaviour. ---
  const hookInvocations: HookInvocationRecord[] = [];
  const hookWarnings: HookWarning[] = [];
  let hookRecordSeq = 0;

  /** Append every record from one `fire()` result as a `hook_invocation` session entry. */
  function recordHookFire(fire: HookFireResult, opts?: { toolCallId?: string }): void {
    for (const record of fire.records) {
      hookInvocations.push(record);
      const artifactRef = makeArtifactRef(
        `hook-${hookRecordSeq++}-${record.hookId}`,
        "hook-invocation",
        sha256(canonicalize(record)),
      );
      session.append(
        { type: "hook_invocation", artifactRef },
        opts?.toolCallId !== undefined ? { correlationId: opts.toolCallId } : {},
      );
    }
    hookWarnings.push(...fire.warnings);
  }

  // --- SessionStart: after `startRun()`'s `started` outcome, before the first
  // provider request. Observe/context-only (never in `GATE_CAPABLE_EVENTS`);
  // its `additionalContext` (joined) is appended to the system instruction. ---
  let sessionStartContext: string | undefined;
  if (deps.hooks !== undefined) {
    const sessionStartFire = await deps.hooks.fire("SessionStart", {
      sessionId,
      runId,
      projectRoot: input.projectRoot,
      policyProfile: deps.policyProfile.profileId,
      contextHash: manifest.contextHash,
      provider,
      model,
    });
    recordHookFire(sessionStartFire);
    if (sessionStartFire.additionalContext.length > 0) {
      sessionStartContext = sessionStartFire.additionalContext.join("\n");
    }
  }
  const baseSystemInstruction = "Keryx harness offline run (Release 0).";
  const systemInstruction =
    sessionStartContext !== undefined
      ? `${baseSystemInstruction}\n\n${sessionStartContext}`
      : baseSystemInstruction;

  // --- UserPromptSubmit: before the prompt ever reaches the model. A tightened
  // `deny` never opens the provider stream: the run ends `blocked` with a
  // typed blocker instead.
  //
  // Flow 306 fix (review finding 4): a tightened `ask` is ALSO treated as
  // deny here, unconditionally — not only when `deps.hooks.interactive ===
  // false` (`tightenOutcome`'s own headless-fail-closed fold, which already
  // covers that case). `runOffline` is a fully headless entry point with no
  // operator-facing surface at all: there is no `io.requestApproval` (or
  // equivalent) anywhere in this module to resolve an `ask` even when the
  // hook RUNTIME happens to have been constructed with `interactive: true`
  // (e.g. a future caller reusing a shared runtime across an interactive
  // shell session and an offline run). Folding only inside `tightenOutcome`
  // left that combination as a silent `ask` that nothing here ever checked
  // for, which read as "proceed" — a gate hook's `ask` failing OPEN. Treating
  // `ask` as `deny` here, regardless of `tightened`'s own value, closes that
  // gap without needing `tightenOutcome` to know about `runOffline`
  // specifically. ---
  let userPromptDenied = false;
  let userPromptContext: string | undefined;
  if (deps.hooks !== undefined) {
    const userPromptFire = await deps.hooks.fire("UserPromptSubmit", {
      sessionId,
      runId,
      prompt: input.request,
    });
    recordHookFire(userPromptFire);
    if (userPromptFire.additionalContext.length > 0) {
      userPromptContext = userPromptFire.additionalContext.join("\n");
    }
    if (userPromptFire.tightened === "deny" || userPromptFire.tightened === "ask") {
      userPromptDenied = true;
      blockerIds.push("blocker:hook-denied:UserPromptSubmit");
    }
  }

  const maxToolCalls = input.budget.maxToolCalls;
  let modelRequests = 0;

  if (!userPromptDenied) {
  const request: NormalizedRequest = {
    providerId: provider,
    modelId: model,
    systemInstruction,
    messages: [
      {
        role: "user",
        content: userPromptContext !== undefined ? `${input.request}\n\n${userPromptContext}` : input.request,
        provenance: "project",
      },
    ],
    budget: { maxOutputTokens: 1000, runReservation: 1000 },
    stream: true,
    requestId: `req-${manifest.contextHash.slice(0, 32)}`,
    parentRunId: runId,
  };

  modelRequests += 1;
  const stream = deps.provider.stream(request, { attemptId: `attempt-${runId}` });

  for await (const event of stream) {
    events.push(event);

    if (event.kind === "model_end") {
      finalMessageEmitted = true;
      if (deps.hooks !== undefined) {
        const stopFire = await deps.hooks.fire("Stop", { sessionId, runId, stopReason: "model_end" });
        recordHookFire(stopFire);
        // Same `ask` ⇒ `deny` fold as `UserPromptSubmit` above (finding 4) —
        // `runOffline` has no approver to resolve an `ask` regardless of the
        // hook runtime's own `interactive` flag.
        if (stopFire.tightened === "deny" || stopFire.tightened === "ask") {
          blockerIds.push("blocker:hook-denied:Stop");
        }
      }
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

    // --- decide() (+ MP-6 escalation) runs FIRST, then `PreToolUse` fires with
    // `ctx.decideOutcome` set to that decision's outcome, then `composeDecision`
    // folds the hook decisions in. This is observationally equivalent to the
    // W6 spec's "hooks before decide()" ordering: `decide()` is pure and hooks
    // cannot influence its inputs (the hook payload carries the same
    // toolCallId/toolName/toolInput/risk/policyProfile either way), so the only
    // place a hook's decision and the policy decision actually meet is
    // `composeDecision` — and that still runs after both are known, exactly as
    // it would if the hook had fired first and its output were composed
    // afterwards. Running decide() first additionally lets the hook see
    // `ctx.decideOutcome`, which the gate malformed-output failure table
    // requires (malformed stdout on exit 0 silent-approves UNLESS decide()
    // would have said `ask`, in which case it denies) — a rule that cannot be
    // implemented at all if the hook fires before `decide()` runs.
    let decision = decide({ toolCallId, risk }, policyContext, {
      clock: deps.clock,
      idSeq: deps.idSeq,
    });

    // MP-6 (flow 122): OPTIONAL, default-OFF metaproject blast-radius escalation.
    // Only when the run supplies BOTH a `metaprojectPort` AND a positive
    // `blastRadiusThreshold` is the existing pure `escalateForBlastRadius`
    // primitive consulted — it can only TIGHTEN an `allow` to `ask`, never
    // weaken. No port / no threshold => `decide()`'s output is used unchanged
    // (the deterministic floor). Deterministic: a pure fold over an injected
    // `graphAffected` read; no `Date.now`/`Math.random`.
    const blastRadiusThreshold = deps.blastRadiusThreshold ?? 0;
    if (deps.metaprojectPort !== undefined && blastRadiusThreshold > 0 && decision.decision === "allow") {
      const targetPath = toolTargetPath(parsedInput);
      if (targetPath !== undefined) {
        const blastRadius = await metaprojectBlastRadius(deps.metaprojectPort, targetPath);
        decision = escalateForBlastRadius(decision, { blastRadius }, blastRadiusThreshold);
      }
    }

    const hookToolName = aliasRunHookToolName(toolName);
    let preToolUseFire: HookFireResult | undefined;
    if (deps.hooks !== undefined) {
      preToolUseFire = await deps.hooks.fire(
        "PreToolUse",
        {
          toolCallId,
          toolName: hookToolName,
          keryxToolName: toolName,
          toolInput: parsedInput,
          risk,
          policyProfile: deps.policyProfile.profileId,
        },
        { toolName: hookToolName, decideOutcome: decision.decision },
      );
      recordHookFire(preToolUseFire, { toolCallId });
    }

    // The composed decision (hooks can only tighten) is what is
    // pushed/persisted and gates execution below.
    if (preToolUseFire !== undefined) {
      decision = composeDecision(decision, preToolUseFire.decisions, { interactive: deps.interactive });
    }

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
    } catch (err) {
      // Malformed / schema-invalid input rejected by the executor gate before
      // any receipt: record a typed blocker, never a tool_result with an
      // artifactRef (@SC_R04_MALFORMED_TOOL_INPUT — "no execution receipt").
      if (deps.hooks !== undefined) {
        const failFire = await deps.hooks.fire(
          "PostToolUseFailure",
          {
            toolCallId,
            toolName: hookToolName,
            keryxToolName: toolName,
            toolInput: parsedInput,
            error: { message: err instanceof Error ? err.message : String(err) },
          },
          { toolName: hookToolName },
        );
        recordHookFire(failFire, { toolCallId });
      }
      blockerIds.push(`blocker:tool-rejected:${toolCallId}`);
      continue;
    }

    executed.push({ toolCallId, toolName, result });

    // PostToolUse / PostToolUseFailure: observe-only, fired AFTER execution.
    // Neither can change `blockerIds` or the recorded `ToolResult` — both
    // events are outside `GATE_CAPABLE_EVENTS`, so `fire()` never computes a
    // `tightened` outcome for them; only their `hook_invocation` records and
    // any warnings are kept.
    if (deps.hooks !== undefined) {
      if (result.status === "succeeded") {
        const postFire = await deps.hooks.fire(
          "PostToolUse",
          {
            toolCallId,
            toolName: hookToolName,
            keryxToolName: toolName,
            toolInput: parsedInput,
            toolOutput: result,
            policyDecision: decision.decision,
          },
          { toolName: hookToolName },
        );
        recordHookFire(postFire, { toolCallId });
      } else {
        const failFire = await deps.hooks.fire(
          "PostToolUseFailure",
          {
            toolCallId,
            toolName: hookToolName,
            keryxToolName: toolName,
            toolInput: parsedInput,
            error: {
              message: `Tool ${toolName} reported status ${result.status}.`,
              ...(result.errorCode !== undefined ? { code: result.errorCode } : {}),
            },
          },
          { toolName: hookToolName },
        );
        recordHookFire(failFire, { toolCallId });
      }
    }

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
  } // end `if (!userPromptDenied)`

  // --- Completion gate (S4): the single authority on whether the run passed. ---
  // The two requirement lists come from the caller (flow 134 / S3); absent ⇒
  // empty, which is the pre-S3 behaviour.
  const requiredGates: RequiredGate[] = [...(deps.completionRequirements?.requiredGates ?? [])];
  const requiredEvidenceRefs: string[] = [
    ...(deps.completionRequirements?.requiredEvidenceRefs ?? []),
  ];
  const gate = evaluateCompletion(
    {
      runId,
      requiredGates,
      requiredEvidenceRefs,
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

  // --- SessionEnd: observe-only, fired once at the very end of the run. ---
  if (deps.hooks !== undefined) {
    const endReason = status === "completed" ? "completed" : status === "blocked" ? "blocked" : "failed";
    const sessionEndFire = await deps.hooks.fire("SessionEnd", { sessionId, runId, endReason });
    recordHookFire(sessionEndFire);
  }

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
    ...(deps.hooks !== undefined ? { hookInvocations, hookWarnings } : {}),
  };
}

/**
 * The target file path a tool call operates on, for the MP-6 blast-radius read.
 * Checks the conventional string fields in order and returns the first non-empty
 * one; `undefined` when the input names no target (escalation is then skipped).
 * Pure and deterministic.
 */
function toolTargetPath(input: Record<string, unknown>): string | undefined {
  for (const key of ["path", "file", "target"]) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
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
  // Deliberately NOT carrying `deps.completionRequirements` (flow 134 / S3):
  // the run never started, so no requirement was given a chance to be met.
  // Reporting them as unmet would add noise to a verdict the startup blocker
  // has already decided.
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
