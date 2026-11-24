import type { DeskReviewerProgress, DeskRun, DeskRunState } from "../../../../src/review/desk-run-types";
import type { ReviewCard } from "./types";

export interface ReviewPlanSummaryFile {
  path: string;
  additions?: number;
  deletions?: number;
}

export interface ReviewPlanSummaryCheck {
  name: string;
  category: "baseline" | "project";
  slices: readonly string[];
  assignments?: readonly ReviewPlanSummaryAssignment[];
}

export interface ReviewPlanSummaryAssignment {
  wave: number;
  slices: readonly string[];
  tier: "light" | "middle" | "strong";
  tierReason: string;
  provider?: string;
  model?: string;
}

export interface ReviewPlanSummarySliceReason {
  id: string;
  depth?: string;
  reasons: readonly string[];
}

/** Read-only, revision-pinned facts shared by the PR workspace and a session's review activity. */
export interface ReviewPlanSummaryData {
  title: string;
  headSha: string;
  changeStats?: ReviewCard["changeStats"];
  files?: readonly ReviewPlanSummaryFile[];
  filesComplete?: boolean;
  checks?: readonly ReviewPlanSummaryCheck[];
  checksComplete?: boolean;
  sliceReasons?: readonly ReviewPlanSummarySliceReason[];
  depth?: "light" | "full";
  depthReason?: string;
  stage?: string;
  runState?: DeskRunState;
  assignmentProgress?: Pick<DeskReviewerProgress, "planned" | "finished" | "completed">;
  operatorStep?: string;
  singleReviewer?: boolean;
}

export function reviewPlanEvidence(plan: DeskReviewerProgress["planSummary"], scope: DeskRun["pullRequestScope"]) {
  const files = plan ? plan.files.map(path => scope?.files.find(file => file.path === path) ?? { path }) : scope?.files;
  return {
    ...(scope && { changeStats: scope.changeStats }),
    ...(files && { files, filesComplete: plan?.filesComplete ?? scope?.filesComplete ?? false }),
    ...(plan && {
      checks: plan.checks,
      checksComplete: plan.checksComplete,
      sliceReasons: plan.sliceReasons,
      ...(plan.depth && { depth: plan.depth }),
      ...(plan.depthReason && { depthReason: plan.depthReason }),
    }),
  };
}

function readableStage(stage: string | undefined, runState?: DeskRunState, progress?: ReviewPlanSummaryData["assignmentProgress"]) {
  if (runState === "completed") return "Review finished";
  if (runState === "partial") return "Review finished with partial coverage";
  if (runState === "blocked") return "Review blocked";
  if (runState === "failed") return "Review failed";
  const value = stage?.trim();
  const allAssignmentsFinished = progress?.planned !== null && progress?.planned !== undefined && progress.planned > 0 && progress.finished >= progress.planned;
  if (!value) return allAssignmentsFinished ? "All reviewer assignments finished · preparing final checks and report" : "Preparing review plan";
  const normalized = value.toLowerCase();
  if (normalized === "review complete" || normalized === "reviewing final checks") return "Running final review checks";
  if (normalized === "review ingest" || normalized === "recording reviewer findings") return "Recording reviewer findings";
  if (normalized === "review reconcile" || normalized === "reconciling reviewer observations") return "Reconciling reviewer observations";
  if (normalized === "review plan paused") return "Review plan paused";
  if (allAssignmentsFinished) return "All reviewer assignments finished · preparing final checks and report";
  if (normalized === "shell_task_output") return "Waiting for review progress";
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(value)) return "Review in progress";
  return value;
}

/** A compact explanation of the actual input range, plan assignments, and the next operator action. */
export function ReviewPlanSummary({ data }: { data: ReviewPlanSummaryData }) {
  return <section className="review-plan-summary" aria-label="Review scope and plan" data-head-sha={data.headSha}>
    <header>
      <h3>{data.title}</h3>
      {data.changeStats && <p className="review-plan-summary-stats">
        <span>{data.changeStats.files.toLocaleString()} {data.changeStats.files === 1 ? "file changed" : "files changed"}</span>
        <span aria-label={`${data.changeStats.additions.toLocaleString()} additions`}>+{data.changeStats.additions.toLocaleString()}</span>
        <span aria-label={`${data.changeStats.deletions.toLocaleString()} deletions`}>−{data.changeStats.deletions.toLocaleString()}</span>
      </p>}
      <p className="review-plan-summary-revision">Reviewing <code>{data.headSha.slice(0, 12)}</code></p>
    </header>
    <section aria-label="Changed files">
      <h4>Changed files</h4>
      {data.files ? <ul>{data.files.map(file => <li key={file.path}>
        <code>{file.path}</code>
        {(file.additions !== undefined || file.deletions !== undefined) && <span aria-label="Line changes">
          {file.additions === undefined ? "" : ` +${file.additions.toLocaleString()}`}
          {file.deletions === undefined ? "" : ` −${file.deletions.toLocaleString()}`}
        </span>}
      </li>)}</ul> : <p className="field-hint">File list is not available yet.</p>}
      {data.files && !data.filesComplete && <p className="field-hint">File list is partial or unavailable.</p>}
    </section>
    <section aria-label="Planned checks">
      <h4>Planned checks</h4>
      {data.depth && data.depthReason && <p><strong>Review depth: {data.depth}</strong> · {data.depthReason}</p>}
      {data.checks && <p>{data.checks.length} planned reviewer checks · {data.checks.filter(check => check.category === "baseline").length} baseline · {data.checks.filter(check => check.category === "project").length} project</p>}
      {data.singleReviewer ? <p className="field-hint">One reviewer checks the pinned diff in a single pass.</p>
        : data.checks === undefined ? <p className="field-hint">Waiting for the verified review plan.</p>
        : data.checks.length ? <details>
          <summary>{data.checksComplete ? "Show reviewer assignments" : "Show planned reviewer roles"}</summary>
          {!data.checksComplete && <p className="field-hint">The final dispatch list is not available yet.</p>}
          <ul>{data.checks.map((check, index) => <li key={`${check.name}-${index}`}>
            <strong>{check.name}</strong> · {check.category}{check.slices.length > 0 && <span> · {check.slices.join(", ")}</span>}
            {(check.assignments?.length ?? 0) > 0 && <ul aria-label={`${check.name} model assignments`}>
              {check.assignments!.map((assignment, assignmentIndex) => <li key={`${assignment.wave}-${assignmentIndex}`}>
                Wave {assignment.wave} · Selected tier: {assignment.tier}
                {(assignment.provider || assignment.model) && <span> · Dispatch model: {assignment.provider && assignment.model
                  ? `${assignment.provider} / ${assignment.model}` : assignment.provider ?? assignment.model}</span>}
                {assignment.slices.length > 0 && <span> · {assignment.slices.join(", ")}</span>}
                {assignment.tierReason && <span> · {assignment.tierReason}</span>}
              </li>)}
            </ul>}
          </li>)}</ul>
        </details> : <p className="field-hint">No reviewer assignments are recorded in this plan.</p>}
      {(data.sliceReasons?.length ?? 0) > 0 && <details>
        <summary>Show slice selection reasons</summary>
        <ul>{data.sliceReasons!.map(slice => <li key={slice.id}>
          <strong>{slice.id}</strong>{slice.depth && <span> · {slice.depth}</span>}
          {slice.reasons.length > 0 && <ul>{slice.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
        </li>)}</ul>
      </details>}
    </section>
    <p className="review-plan-summary-stage" role="status">Current stage: {readableStage(data.stage, data.runState, data.assignmentProgress)}</p>
    {data.operatorStep && <p className="inline-banner tone-warn review-plan-summary-operator" role="alert">{data.operatorStep}</p>}
  </section>;
}
