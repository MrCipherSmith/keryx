export type FlowStatus =
  | "initializing"
  | "ready"
  | "in-progress"
  | "implemented"
  | "completing"
  | "done"
  | "blocked";

export type TaskKind = "context" | "implement" | "test" | "review" | "docs";
export type TaskStatus = "todo" | "in-progress" | "done";

export type FlowTask = {
  id: string; // T1, T2, ...
  title: string;
  kind: TaskKind;
  status: TaskStatus;
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

export type FlowState = {
  schemaVersion: 1;
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
  }>;
  comment(ref: TrackerRef, body: string): Promise<boolean>;
}

// --- Gates (D6) ---

export type GateOutcome = {
  name: "acceptance-criteria" | "pull-request" | "health";
  status: "pass" | "fail" | "skipped";
  detail: string;
};

export type FlowServiceDeps = {
  tracker: TrackerAdapter | null;
  healthGate: (cwd: string) => Promise<{ status: string; reasons: string[] }>;
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
  kind: "structure" | "checksum" | "schema" | "state";
  message: string;
};
export type FlowCheckResult = { ok: boolean; issues: FlowCheckIssue[] };

export interface FlowService {
  init(input: FlowInitInput): Promise<FlowInitResult>;
  list(input: { cwd: string }): Promise<FlowSummary[]>;
  get(input: { cwd: string; id: string }): Promise<FlowState>;
  freeze(input: { cwd: string; id: string }): Promise<FlowState>;
  start(input: { cwd: string; id: string }): Promise<FlowState>;
  taskAdd(input: FlowTaskAddInput): Promise<FlowState>;
  taskDone(input: { cwd: string; id: string; taskId: string }): Promise<FlowState>;
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
  }): Promise<FlowCompleteResult>;
  block(input: { cwd: string; id: string; reason: string }): Promise<FlowState>;
  unblock(input: { cwd: string; id: string }): Promise<FlowState>;
  check(input: { cwd: string }): Promise<FlowCheckResult>;
}
