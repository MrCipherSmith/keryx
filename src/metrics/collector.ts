import { aggregateExecutionEvents } from "./events";
import { EXECUTION_RUN_SCHEMA_VERSION } from "./schema";
import type {
  ExecutionEvent,
  ExecutionRunRecord,
  FinalStatus,
  RunMode,
  RunProvenance,
} from "./types";

export function createExecutionRunRecord(input: {
  runId: string;
  runMode: RunMode;
  skill: string;
  startedAt: string;
  finishedAt: string;
  provenance: RunProvenance;
  events?: ExecutionEvent[];
  parentRunId?: string | null;
  finalStatus?: FinalStatus;
  artifactPaths?: string[];
  executionProfile?: "full" | "lightweight";
  skippedPhases?: ExecutionRunRecord["skipped_phases"];
}): ExecutionRunRecord {
  if (input.runMode === "subagent" && !input.parentRunId) {
    throw new Error("subagent metrics require parent_run_id and cannot own a root report");
  }
  const events = input.events ?? [];
  const aggregated = aggregateExecutionEvents(events, {
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
  });
  return {
    run_id: input.runId,
    schema_version: EXECUTION_RUN_SCHEMA_VERSION,
    run_mode: input.runMode,
    skill: input.skill,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    parent_run_id: input.parentRunId ?? null,
    provenance: input.provenance,
    metrics: aggregated.metrics,
    retries: aggregated.retries,
    final_status: input.finalStatus ?? "done",
    artifact_paths: input.artifactPaths ?? [],
    ...(input.executionProfile ? { execution_profile: input.executionProfile } : {}),
    ...(input.skippedPhases ? { skipped_phases: input.skippedPhases } : {}),
  };
}
