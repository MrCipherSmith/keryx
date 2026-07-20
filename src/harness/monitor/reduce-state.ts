// Event-sourced orchestrator state (flow 095, multi-agent engine Phase 6a).
//
// `orchestrator-state` is currently a mutable snapshot. This module makes the
// append-only `agent-event` stream the source of truth: `reduceState` folds the
// stream into a schema-valid `OrchestratorState`
// (`.metaproject/core/gdskills/contracts/orchestrator-state.schema.json`), so
// crash-safe resume, deterministic replay, and a live projection all reconstruct
// from the log.
//
// The fold is expressed as `initialOrchestratorState(meta)` + a pure left-fold
// `applyEvents(state, events)`, which makes replay-safety STRUCTURAL:
// `applyEvents(applyEvents(init, prefix), suffix)` deep-equals
// `applyEvents(init, prefix ++ suffix)` because every event is applied
// independently (terminal statuses guarded, `updated_at` monotonic). Pure and
// deterministic: no clock/RNG/network/fs — ids/timestamps come from the events
// and the injected `meta`; the non-derivable header fields (contract_version,
// orchestrator, phase) are supplied by `meta` with conservative defaults.
import type { AgentEvent } from "./reduce";

/** Run-level status (mirrors orchestrator-state.schema.json enum). */
export type RunStatus = "pending" | "in_progress" | "completed" | "blocked" | "failed";
/** Per-step status (schema enum; adds `skipped`). */
export type StepStatus = "pending" | "in_progress" | "completed" | "skipped" | "blocked" | "failed";

/** One plan step (mirrors the schema's plan.steps item). */
export interface OrchestratorStep {
  id: string;
  skill: string;
  status: StepStatus;
  depends_on?: string[];
  dispatch_id?: string | null;
  result_path?: string | null;
}

/** An orchestrator artifact ref (mirrors the schema's artifacts item). */
export interface OrchestratorArtifact {
  path: string;
  kind: string;
  exists: boolean;
  summary?: string;
}

/** The folded orchestrator state (validates against orchestrator-state.schema.json). */
export interface OrchestratorState {
  contract_version: string;
  run_id: string;
  orchestrator: string;
  intent?: string;
  phase: string;
  status: RunStatus;
  plan: { steps: OrchestratorStep[]; current_step?: string | null };
  artifacts: OrchestratorArtifact[];
  metrics?: Record<string, unknown>;
  updated_at: string;
}

/** Non-derivable header fields the fold cannot get from the event stream. */
export interface ReduceStateMeta {
  contractVersion?: string;
  orchestrator?: string;
  phase?: string;
  runId?: string;
  /** Floor for `updated_at`; the fold raises it to the latest event timestamp. */
  updatedAt?: string;
}

const EPOCH = "1970-01-01T00:00:00.000Z";
const STEP_TERMINAL: ReadonlySet<StepStatus> = new Set<StepStatus>(["completed", "blocked", "failed", "skipped"]);
const RUN_TERMINAL: ReadonlySet<RunStatus> = new Set<RunStatus>(["completed", "failed"]);

/** A fresh state with the injected header and an empty plan (status `pending`). */
export function initialOrchestratorState(meta: ReduceStateMeta = {}): OrchestratorState {
  return {
    contract_version: meta.contractVersion ?? "1.0.0",
    run_id: meta.runId ?? "",
    orchestrator: meta.orchestrator ?? "flow-orchestrator",
    phase: meta.phase ?? "execute",
    status: "pending",
    plan: { steps: [], current_step: null },
    artifacts: [],
    updated_at: meta.updatedAt ?? EPOCH,
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function raiseStatus(current: RunStatus, next: RunStatus): RunStatus {
  return RUN_TERMINAL.has(current) ? current : next;
}

function setStepStatus(step: OrchestratorStep, next: StepStatus): void {
  if (STEP_TERMINAL.has(step.status)) return; // never downgrade a terminal step
  step.status = next;
}

/**
 * Apply an event sequence onto a state, returning a NEW state (the input is not
 * mutated). Each event is applied independently, so the fold is associative over
 * the event sequence (replay-safe). Pure.
 */
export function applyEvents(state: OrchestratorState, events: readonly AgentEvent[]): OrchestratorState {
  // Deep-ish clone of the mutable parts so callers' state is untouched.
  const next: OrchestratorState = {
    ...state,
    plan: { steps: state.plan.steps.map((s) => ({ ...s })), current_step: state.plan.current_step ?? null },
    artifacts: state.artifacts.map((a) => ({ ...a })),
    ...(state.metrics !== undefined ? { metrics: { ...state.metrics } } : {}),
  };

  const stepByDispatch = new Map<string, OrchestratorStep>();
  for (const step of next.plan.steps) {
    if (step.dispatch_id != null) stepByDispatch.set(step.dispatch_id, step);
  }

  const ensureStep = (dispatchId: string, skill: string): OrchestratorStep => {
    let step = stepByDispatch.get(dispatchId);
    if (step === undefined) {
      step = { id: dispatchId, skill, status: "pending", dispatch_id: dispatchId };
      next.plan.steps.push(step);
      stepByDispatch.set(dispatchId, step);
    }
    return step;
  };

  for (const event of events) {
    if (next.run_id === "" && event.run_id.length > 0) next.run_id = event.run_id;
    if (event.timestamp_utc > next.updated_at) next.updated_at = event.timestamp_utc;

    const dispatchId = event.dispatch_id ?? undefined;

    switch (event.type) {
      case "run_started":
        next.status = raiseStatus(next.status, "in_progress");
        break;
      case "run_completed":
        next.status = raiseStatus(next.status, "completed");
        break;
      case "run_failed":
        if (dispatchId !== undefined) setStepStatus(ensureStep(dispatchId, "subagent"), "failed");
        next.status = raiseStatus(next.status, "failed");
        break;
      case "dispatch_created": {
        const step = ensureStep(dispatchId ?? "", str(event.data?.skill) ?? str(event.data?.target_skill) ?? "subagent");
        if (dispatchId !== undefined) {
          const skill = str(event.data?.skill) ?? str(event.data?.target_skill);
          if (skill !== undefined) step.skill = skill;
          setStepStatus(step, "in_progress");
          next.plan.current_step = dispatchId;
        }
        break;
      }
      case "dispatch_completed":
        if (dispatchId !== undefined) setStepStatus(ensureStep(dispatchId, "subagent"), "completed");
        break;
      case "dispatch_blocked":
        if (dispatchId !== undefined) setStepStatus(ensureStep(dispatchId, "subagent"), "blocked");
        break;
      case "validation_failed":
        if (dispatchId !== undefined) setStepStatus(ensureStep(dispatchId, "subagent"), "failed");
        break;
      case "artifact_written": {
        const path = str(event.data?.path);
        if (path !== undefined && !next.artifacts.some((a) => a.path === path)) {
          const artifact: OrchestratorArtifact = { path, kind: str(event.data?.kind) ?? "custom", exists: true };
          const summary = str(event.data?.summary);
          if (summary !== undefined) artifact.summary = summary;
          next.artifacts.push(artifact);
        }
        break;
      }
      default:
        break;
    }
  }

  return next;
}

/**
 * Fold a canonical agent-event stream into a schema-valid {@link OrchestratorState}.
 * Equivalent to `applyEvents(initialOrchestratorState(meta), events)`. Pure and
 * deterministic; steps are in first-seen dispatch order.
 */
export function reduceState(events: readonly AgentEvent[], meta: ReduceStateMeta = {}): OrchestratorState {
  return applyEvents(initialOrchestratorState(meta), events);
}
