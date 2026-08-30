// Job packages — the `keryx job` surface.
//
// Every type here is shaped by ONE external constraint: the state file on disk
// must validate against
// `src/gdskills/bundled/skills/orchestration/job-orchestrator/state.schema.json`,
// which carries `additionalProperties: false` at the root. So the field names
// are the schema's snake_case names, not this codebase's camelCase, and nothing
// is persisted that the schema does not already declare. Where the two spell a
// value differently (`in_progress` on disk, `in-progress` on the command line)
// the mapping lives in `machine.ts` and is asserted by a test, rather than being
// re-derived at each call site.

/** Orchestrator phase. Schema: `phase` (enum, required). */
export type JobPhase = "CONTEXT" | "PLAN" | "EXECUTION" | "COMPLETION";

/** Schema: `intent` (enum, required). */
export type JobIntent = "implement" | "analyze" | "review" | "custom";

export const JOB_INTENTS: readonly JobIntent[] = ["implement", "analyze", "review", "custom"];

/**
 * Step status AS PERSISTED. The schema enum is underscored (`in_progress`); the
 * CLI flag is hyphenated (`in-progress`) because that is the surface the
 * job-orchestrator skill is written against. Both spellings are pinned by
 * `machine.test.ts` so neither can drift into the other's shape unnoticed.
 */
export type JobStepStatus = "pending" | "in_progress" | "completed" | "skipped" | "failed";

/** The `--status` values `keryx job step` accepts, in the order help prints them. */
export const STEP_STATUS_FLAGS = [
  "pending",
  "in-progress",
  "completed",
  "skipped",
  "failed",
] as const;
export type JobStepStatusFlag = (typeof STEP_STATUS_FLAGS)[number];

/** The `--type` values `keryx job document` accepts. */
export const DOCUMENT_TYPES = [
  "analysis",
  "implementation-report",
  "review",
  "verification-report",
] as const;
export type JobDocumentType = (typeof DOCUMENT_TYPES)[number];

/** Schema: `plan.steps[]`, whose `required` is `["id", "type", "agent", "status"]`. */
export type JobStep = {
  id: string;
  type: string;
  agent: string;
  status: JobStepStatus;
  depends?: string[] | undefined;
  conditional?: boolean | undefined;
};

/**
 * Schema: `metrics.steps[]`.
 *
 * `retries` is the field this module exists to make real. It has been declared
 * in the schema since the skill was written and no code ever wrote it — the same
 * defect `attempts.count` had in the flow module before `src/flow/service.ts`
 * started incrementing it. Here it counts step attempts BEYOND THE FIRST: an
 * attempt begins each time `keryx job step ... --status in-progress` moves the
 * step into `in_progress`, so the first attempt leaves `retries: 0` and every
 * re-entry adds one. It is persisted rather than counted in memory precisely so
 * a loop bound survives the session restart that resumption assumes.
 */
export type JobStepMetric = {
  step_id: string;
  retries: number;
  status?: string | undefined;
  started_at?: string | undefined;
  completed_at?: string | undefined;
  duration_ms?: number | undefined;
  total_tokens?: number | undefined;
};

export type JobIssueRef = {
  number?: number | undefined;
  title?: string | undefined;
  url?: string | undefined;
  type?: string | undefined;
};

export type JobContext = {
  project_dir?: string | undefined;
  base_branch?: string | undefined;
  issue?: JobIssueRef | undefined;
};

export type JobPlan = {
  steps: JobStep[];
  current_step?: string | undefined;
};

export type JobDocumentation = {
  job_path?: string | undefined;
  /**
   * Package-relative file names, one per recorded document. The schema types
   * this as `array of string`, so the document TYPE is carried by the file name
   * (`analysis.md`, `review.md`, …) rather than by a parallel object the schema
   * would reject. `documentFileName` in `store.ts` is the single mapping.
   */
  documents_created?: string[] | undefined;
};

export type JobMetrics = {
  steps: JobStepMetric[];
  total_duration_ms?: number | undefined;
  total_tokens?: number | undefined;
};

/**
 * The persisted job package state — `.metaproject/jobs/<name>/state.json`.
 *
 * Deliberately NOT carrying the five fields the audit found asserted in prose
 * and forbidden by the schema's `additionalProperties: false` (`sanity_check`,
 * `convention_reviewers`, `publication_plan.mode`,
 * `pending_pr_review_report_comment`, `pending_review_ai_artifact`), nor a
 * `paused` status: none of the six commands below produces any of them, so
 * adding them to the schema would recreate exactly the defect being closed —
 * a declaration with no writer.
 */
export type JobState = {
  phase: JobPhase;
  intent: JobIntent;
  job_name: string;
  context: JobContext;
  plan: JobPlan;
  create_pr?: boolean | undefined;
  documentation?: JobDocumentation | undefined;
  metrics?: JobMetrics | undefined;
  jobs_root?: string | undefined;
  updated_at?: string | undefined;
};

export type JobSummary = {
  name: string;
  phase: JobPhase;
  intent: JobIntent;
  dir: string;
  stepsDone: number;
  stepsTotal: number;
  /** First step that is not terminal, or `null` when every step is terminal. */
  nextStep: string | null;
};

export type JobStatusReport = {
  state: JobState;
  dir: string;
  stepsDone: number;
  stepsTotal: number;
  /**
   * The resumption fact. §0.0 of the job-orchestrator skill promises a resuming
   * agent can pick the job back up; this is the answer it needs, read off disk
   * rather than recalled.
   */
  nextStep: JobStep | null;
  open: string[];
  failed: string[];
  retries: Record<string, number>;
  documents: string[];
};

export type JobServiceDeps = {
  now: () => Date;
};

export type JobInitInput = {
  cwd: string;
  name: string;
  intent?: string | undefined;
  projectDir?: string | undefined;
};

export type JobStepInput = {
  cwd: string;
  name: string;
  stepId: string;
  status: string;
  reason?: string | undefined;
};

export type JobDocumentInput = {
  cwd: string;
  name: string;
  type: string;
  file: string;
};

export type JobStepResult = {
  state: JobState;
  step: JobStep;
  retries: number;
};

export type JobDocumentResult = {
  state: JobState;
  document: string;
  path: string;
};

export interface JobService {
  init(input: JobInitInput): Promise<{ state: JobState; dir: string }>;
  status(input: { cwd: string; name: string }): Promise<JobStatusReport>;
  step(input: JobStepInput): Promise<JobStepResult>;
  document(input: JobDocumentInput): Promise<JobDocumentResult>;
  complete(input: { cwd: string; name: string }): Promise<JobState>;
  list(input: { cwd: string }): Promise<JobSummary[]>;
}
