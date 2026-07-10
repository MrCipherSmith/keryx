export type Reliability = "exact" | "estimated" | "unknown";
export type RunMode = "user-direct" | "orchestrator" | "subagent";
export type FinalStatus = "done" | "partial" | "blocked";
export type RetryType =
  | "task"
  | "keryx"
  | "environment"
  | "expected-tdd"
  | "external"
  | "unknown";

export type MetricValue = {
  value: number | string | null;
  reliability: Reliability;
  source: string;
  notes?: string;
};

export type ProvenanceSource = {
  name: string;
  path: string | null;
  timestamp: string | null;
  reliability: Reliability;
};

export type RunProvenance = {
  commit: string | null;
  branch: string | null;
  worktree: string | null;
  sources: ProvenanceSource[];
};

export type RetryRecord = {
  type: RetryType;
  reason: string;
  reliability: Reliability;
  source?: string;
  affected_final_status?: boolean;
  consumed_user_time?: boolean;
};

export type SkippedPhase = { phase: string; reason: string };

export type ExecutionRunRecord = {
  run_id: string;
  schema_version: string;
  run_mode: RunMode;
  skill: string;
  started_at: string;
  finished_at: string;
  parent_run_id: string | null;
  provenance: RunProvenance;
  metrics: Record<string, MetricValue>;
  retries: RetryRecord[];
  final_status: FinalStatus;
  artifact_paths: string[];
  execution_profile?: "full" | "lightweight";
  skipped_phases?: SkippedPhase[];
};

export type ExecutionEventType =
  | "run_started"
  | "run_paused"
  | "run_resumed"
  | "run_finished"
  | "command_started"
  | "command_finished"
  | "tool_called"
  | "subagent_started"
  | "subagent_finished"
  | "file_read"
  | "file_modified"
  | "test_completed"
  | "health_completed"
  | "retry_recorded"
  | "artifact_written";

export type ExecutionEvent = {
  event_id: string;
  run_id: string;
  parent_run_id?: string | null;
  dispatch_id?: string | null;
  type: ExecutionEventType;
  timestamp_utc: string;
  source: string;
  reliability?: Reliability;
  details?: Record<string, unknown>;
};
