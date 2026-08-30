export type FlowStatus =
  | "initializing"
  | "ready"
  | "in-progress"
  | "implemented"
  | "completing"
  | "done"
  | "blocked";

/** `verify` is a first-class quality-gate task, distinct from test authoring. */
export type TaskKind = "context" | "implement" | "test" | "verify" | "review" | "docs";
export type TaskStatus = "todo" | "in-progress" | "done";

// --- Task Manager evolution (TM-01: schemaVersion 2 additive fields) ---
// Every field below is OPTIONAL; no existing v1 field is removed or made
// required. See docs/decisions/keryx-harness/TM-01-task-manager-evolution.md.

export type AttemptOutcome = "started" | "paused" | "completed" | "failed" | "blocked";

// Immutable, append-only attempt-log entry (harness appends; never rewrites).
export type AttemptEntry = {
  at: string; // ISO 8601
  outcome: AttemptOutcome;
  detail?: string | undefined;
};

export type TaskAttempts = {
  count: number;
  log: AttemptEntry[];
};

// Explicit terminal state distinct from `status` (applies once status is "done").
export type TaskDisposition = "completed" | "blocked" | "failed" | "skipped";

// Outcomes the `keryx flow task attempt` verb may record. A subset of
// AttemptOutcome: `completed` is owned by `flow task done` and `paused` is only
// ever written by the v1 -> v2 migration, so neither is user-recordable.
export const ATTEMPT_CLI_OUTCOMES = ["started", "failed", "blocked"] as const;
export type AttemptCliOutcome = (typeof ATTEMPT_CLI_OUTCOMES)[number];

// Per-task execution budget. All fields optional; absence = no per-task override.
export type TaskBudget = {
  maxSeconds?: number | undefined;
  maxToolCalls?: number | undefined;
  maxRetries?: number | undefined;
  maxTokens?: number | undefined;
};

// Reference to the harness run/session that executed this task. Set by Task
// Manager / flow-orchestrator ONLY (D-02 invariant). Harness reads, never writes.
export type TaskRunLink = {
  runId: string;
  sessionId: string;
  attempt: number;
  at?: string | undefined;
};

export type FlowTask = {
  id: string; // T1, T2, ...
  title: string;
  kind: TaskKind;
  status: TaskStatus;
  // --- v2 additive fields (all optional) ---
  dependsOn?: string[] | undefined;
  attempts?: TaskAttempts | undefined;
  disposition?: TaskDisposition | undefined;
  /**
   * Why the task ended the way it did. Required in practice only for
   * `disposition: "skipped"`: the task gate (see `service.complete`) refuses a
   * skip that carries no recorded reason, so "skipped" can never become a
   * silent way past the gate. Free text, written by
   * `keryx flow task done <id> <Tn> --disposition skipped --reason "<why>"`.
   */
  dispositionReason?: string | undefined;
  acRefs?: string[] | undefined;
  evidenceRefs?: string[] | undefined;
  budget?: TaskBudget | undefined;
  runLink?: TaskRunLink | undefined;
};

export type FlowSource = {
  type: "github-issue" | "description";
  ref: string | null; // issue URL when github-issue
};

export type FlowHistoryEvent = {
  at: string;
  event: string;
  detail?: string | undefined;
};

/**
 * Per-package opt-in for completion gates that did not exist when older flow
 * packages were written.
 *
 * Why this is not keyed on `schemaVersion`: `readFlow` migrates every v1
 * package to v2 in memory and the next mutation persists it, so 195 of the 197
 * packages in this repository — including all 24 that completed with an open
 * task — are already `schemaVersion: 2`. A version number cannot separate "was
 * written under the new rules" from "was written before them"; a field set at
 * `init` can. See flow 201 `journal.md` for the full argument.
 */
export type FlowGates = {
  /**
   * Run the task gate in `complete()`. Set to `true` by `flow init` for every
   * package created after the gate landed. ABSENT on pre-existing packages,
   * where the gate reports `skipped` and never fails a completion.
   */
  tasks?: boolean | undefined;
  /**
   * Run the review gate in `complete()` (flow 204, AC5-AC7). Set to `true` by
   * `flow init` for every package created after the gate landed. ABSENT on
   * pre-existing packages, where the gate reports `skipped` and never fails a
   * completion — the same opt-in shape as `tasks`, for the same reason.
   */
  review?: boolean | undefined;
};

export type FlowState = {
  schemaVersion: 1 | 2;
  /** Per-package gate opt-ins. Absent = pre-existing package (see FlowGates). */
  gates?: FlowGates | undefined;
  id: string; // "001"
  slug: string;
  title: string;
  status: FlowStatus;
  // status to return to on unblock
  previousStatus?: FlowStatus | undefined;
  createdAt: string;
  updatedAt: string;
  source: FlowSource;
  acChecksum: string | null;
  acConfirmed: Record<string, { at: string; note?: string | undefined }>;
  pr: { url: string | null };
  merged?: { commit: string; ref: "origin/main"; at: string } | undefined;
  tasks: FlowTask[];
  history: FlowHistoryEvent[];
};

export type FlowSummary = {
  id: string;
  slug: string;
  title: string;
  status: FlowStatus;
  dir: string; // relative flow dir
  tasksDone: number;
  tasksTotal: number;
};

// --- Tracker adapter (D5) ---

export type TrackerRef = { repo: string; number: number };

export interface TrackerAdapter {
  id: string;
  detect(): Promise<boolean>;
  parseRef(input: string): TrackerRef | null;
  fetchIssue(ref: TrackerRef): Promise<{ title: string; body: string } | null>;
  prStatus(url: string): Promise<{
    exists: boolean;
    isDraft: boolean;
    checksGreen: boolean | null; // null = unknown/pending
    /**
     * The PR's head commit. Optional so an adapter written before the review
     * gate still satisfies the interface; `undefined`/`null` means the head is
     * UNKNOWN, which the review gate reports as unobserved rather than as a
     * match (flow 204, §2.2 condition 3).
     */
    headSha?: string | null | undefined;
  }>;
  comment(ref: TrackerRef, body: string): Promise<boolean>;
}

// --- Gates (D6) ---

export type GateOutcome = {
  name:
    | "acceptance-criteria"
    | "pull-request"
    | "main-merge"
    | "tasks"
    | "health"
    | "security"
    | "review";
  status: "pass" | "fail" | "skipped";
  detail: string;
};

export type FlowServiceDeps = {
  tracker: TrackerAdapter | null;
  healthGate: (cwd: string) => Promise<{ status: string; reasons: string[] }>;
  // Optional security gate over the flow's touched artifacts. Return `null` to
  // omit the gate entirely (e.g. when the security module is disabled) so a
  // normal advisory `flow complete` is never blocked. When present, advisory
  // resolves to `pass` (informational) and enforced/ci may `fail`.
  securityGate?: (
    cwd: string,
  ) => Promise<{ status: "pass" | "fail" | "skipped"; detail: string } | null>;
  mainMergeGate?: (
    cwd: string,
    commit: string,
  ) => Promise<{ status: "pass" | "fail"; detail: string }>;
  /**
   * The external-comment collection (specification §3), when it is wired in.
   *
   * The review gate needs one fact from it — is any collected comment
   * unanswered — and this is the seam through which it asks. Left unwired, the
   * gate falls back to what the round record itself says (external findings, or
   * a coverage entry naming the collection) and, failing both, reports the
   * condition as UNOBSERVED and fails. It never reports "no comments" on the
   * strength of having nothing to ask.
   */
  externalCommentsGate?: import("./review-gate").ExternalCommentsGate | undefined;
  now: () => Date;
};

// --- Service inputs/results (spec section 14) ---

export type FlowInitInput = {
  cwd: string;
  title?: string | undefined;
  issue?: string | undefined;
  slug?: string | undefined;
};
export type FlowInitResult = {
  flow: FlowState;
  dir: string;
  contextNotes: string[];
};

export type FlowTaskAddInput = {
  cwd: string;
  id: string;
  title: string;
  kind?: TaskKind | undefined;
  // v2: optional task dependencies (IDs of tasks this one depends on).
  dependsOn?: string[] | undefined;
};

export type FlowCompleteResult = {
  flow: FlowState;
  gates: GateOutcome[];
  passed: boolean;
  issueComment: string | null; // suggested/posted comment body
  commented: boolean;
};

export type FlowCheckIssue = {
  flow: string;
  kind: "structure" | "checksum" | "schema" | "state" | "duplicate-id";
  message: string;
};
export type FlowCheckResult = { ok: boolean; issues: FlowCheckIssue[] };

/** One recorded `flow renumber`, kept in .metaproject/flows/id-map.json. */
export type FlowIdMapEntry = {
  from: string;
  to: string;
  fromDir: string;
  toDir: string;
  at: string;
  reason: string;
};

export type FlowRenumberResult = {
  flow: FlowState;
  from: string;
  to: string;
  fromDir: string;
  toDir: string;
};

export interface FlowService {
  init(input: FlowInitInput): Promise<FlowInitResult>;
  list(input: { cwd: string }): Promise<FlowSummary[]>;
  get(input: { cwd: string; id: string }): Promise<FlowState>;
  freeze(input: { cwd: string; id: string }): Promise<FlowState>;
  start(input: { cwd: string; id: string }): Promise<FlowState>;
  taskAdd(input: FlowTaskAddInput): Promise<FlowState>;
  taskDone(input: {
    cwd: string;
    id: string;
    taskId: string;
    disposition?: TaskDisposition | undefined;
    /** Why the task ended this way; the task gate requires it for "skipped". */
    reason?: string | undefined;
    // v2 additive (backward-compatible): when provided, the harness's mapped
    // evidence refs / run link are set on the task. Existing callers that omit
    // these are unaffected. Only Task Manager writes these to flow.json (D-02).
    evidenceRefs?: string[] | undefined;
    runLink?: TaskRunLink | undefined;
  }): Promise<FlowState>;
  /**
   * Record one execution attempt against a task: increments `attempts.count`
   * and appends to the append-only `attempts.log`. The counter lives in
   * flow.json precisely so a loop bound survives a session restart — an
   * in-memory count is the bug this exists to fix.
   */
  taskAttempt(input: {
    cwd: string;
    id: string;
    taskId: string;
    outcome: AttemptCliOutcome;
    detail?: string | undefined;
  }): Promise<FlowState>;
  acConfirm(input: {
    cwd: string;
    id: string;
    criterion: string;
    note?: string | undefined;
  }): Promise<FlowState>;
  acUpdate(input: { cwd: string; id: string; reason: string }): Promise<FlowState>;
  implemented(input: { cwd: string; id: string; prUrl: string }): Promise<FlowState>;
  complete(input: {
    cwd: string;
    id: string;
    comment?: boolean | undefined;
    mergedCommit?: string | undefined;
  }): Promise<FlowCompleteResult>;
  block(input: { cwd: string; id: string; reason: string }): Promise<FlowState>;
  unblock(input: { cwd: string; id: string }): Promise<FlowState>;
  check(input: { cwd: string }): Promise<FlowCheckResult>;
  /**
   * Change a flow's number. The only sanctioned way to do it: `flow.json` is
   * CLI-owned and the move must be recorded so old references stay traceable.
   */
  renumber(input: {
    cwd: string;
    ref: string;
    to: string;
    reason: string;
  }): Promise<FlowRenumberResult>;
}
