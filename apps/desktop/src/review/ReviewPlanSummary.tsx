import type { DeskReviewerProgress, DeskRun, DeskRunState } from "../../../../src/review/desk-run-types";
import type { ReviewCard } from "./types";
import "./ReviewPlanSummary.css";

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

const DIFF_BLOCKS = 5;

/**
 * GitHub's five-square diffstat for one file: squares in proportion to additions (green) and deletions (red), grey for
 * the rest. Under five changed lines each line is one square, so a one-line change does not read as a rewrite.
 */
export function diffBlocks(additions = 0, deletions = 0): Array<"add" | "del" | "neutral"> {
  const total = additions + deletions;
  const added = total === 0 ? 0 : total < DIFF_BLOCKS ? additions : Math.round(DIFF_BLOCKS * additions / total);
  const deleted = total === 0 ? 0 : total < DIFF_BLOCKS ? deletions : DIFF_BLOCKS - added;
  return [...Array<"add">(added).fill("add"), ...Array<"del">(deleted).fill("del"),
    ...Array<"neutral">(DIFF_BLOCKS - added - deleted).fill("neutral")];
}

function lineChanges(additions: number | undefined, deletions: number | undefined) {
  return [additions !== undefined && `${additions.toLocaleString()} additions`, deletions !== undefined && `${deletions.toLocaleString()} deletions`]
    .filter(Boolean).join(", ");
}

/** The directory part of a path is quiet and the file name carries the row, as GitHub's file list does. */
function FilePath({ path }: { path: string }) {
  const cut = path.lastIndexOf("/") + 1;
  return <code className="review-file-path">
    {cut > 0 && <span className="review-file-dir">{path.slice(0, cut)}</span>}
    <span className="review-file-name">{path.slice(cut)}</span>
  </code>;
}

/** A compact explanation of the actual input range, plan assignments, and the next operator action. */
export function ReviewPlanSummary({ data }: { data: ReviewPlanSummaryData }) {
  return <section className="review-plan-summary" aria-label="Review scope and plan" data-head-sha={data.headSha}>
    <header>
      <h3>{data.title}</h3>
      <p className="review-plan-summary-meta">
        {data.changeStats && <span className="review-plan-summary-stats">
          <span>{data.changeStats.files.toLocaleString()} {data.changeStats.files === 1 ? "file changed" : "files changed"}</span>
          <span className="review-added" aria-label={`${data.changeStats.additions.toLocaleString()} additions`}>+{data.changeStats.additions.toLocaleString()}</span>
          <span className="review-deleted" aria-label={`${data.changeStats.deletions.toLocaleString()} deletions`}>−{data.changeStats.deletions.toLocaleString()}</span>
        </span>}
        <span className="review-plan-summary-revision">Reviewing <code>{data.headSha.slice(0, 12)}</code></span>
      </p>
    </header>
    <section aria-label="Changed files">
      <h4>Changed files</h4>
      {data.files ? <ul className="review-file-list">{data.files.map(file => <li key={file.path} title={file.path}>
        <FilePath path={file.path} />
        {(file.additions !== undefined || file.deletions !== undefined) &&
          <span className="review-file-stat" aria-label={`Line changes: ${lineChanges(file.additions, file.deletions)}`}>
            {file.additions !== undefined && <span className="review-added">+{file.additions.toLocaleString()}</span>}
            {file.deletions !== undefined && <span className="review-deleted">−{file.deletions.toLocaleString()}</span>}
            <span className="review-diff-blocks" aria-hidden="true">
              {diffBlocks(file.additions, file.deletions).map((kind, index) => <span key={index} data-kind={kind} />)}
            </span>
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
