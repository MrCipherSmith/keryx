import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DeskReviewAction, DeskReviewCheck, DeskRun, DeskRunSnapshot } from "../../../../src/review/desk-run-types";
import { Dialog, Spinner } from "../components/ui";
import { Icon, type IconName } from "../components/Icon";
import { errMessage } from "../lib/format";
import type { ReviewRunAction } from "../platform/reviewRuns";
import { runActive } from "./useReviewRuns";

const labels = {
  complete: "Complete review",
  close: "Close as incomplete",
  archive: "Archive review",
  restore: "Restore review",
  delete: "Delete review",
} satisfies Record<DeskReviewAction, string>;
const explanation = {
  complete: "Run the completion checks and close the managed review package.",
  close: "Record that work on this attempt ended with incomplete coverage.",
  archive: "Move this attempt out of the latest results. It remains available in History.",
  restore: "Return this attempt to the review results.",
  delete: "Permanently remove this Desktop attempt and its local report and transcript.",
} satisfies Record<DeskReviewAction, string>;

const actionIcons = {
  complete: "circleCheck", close: "circleX", archive: "archive", restore: "history", delete: "trash",
} satisfies Record<DeskReviewAction, IconName>;

export type ReviewLifecycleCommand = (action: Extract<ReviewRunAction, { kind: "readiness" | "decide" }>) => Promise<DeskRunSnapshot>;
export function reviewIsArchived(run: DeskRun) {
  return run.decision?.action === "archive";
}

function suggestedReason(run: DeskRun | undefined, action: DeskReviewAction) {
  if (action === "complete" && run?.decision?.action === "complete") return run.decision.reason;
  const reply = run?.coordinatorActivity?.filter(event => event.final).at(-1)?.text;
  for (const line of reply?.split("\n") ?? []) {
    const match = /^Suggested review action: (complete|close|archive) [—–-] (.+)$/i.exec(line.trim());
    if (match?.[1]?.toLowerCase() === action) return match[2];
  }
}

function actionLabel(run: DeskRun, action: DeskReviewAction) {
  if (action === "complete" && run.closure === "completed") return "Recheck completion";
  if (action === "delete" && run.source === "existing") return "Remove from Desktop";
  return labels[action];
}

export function ReviewLifecycle({ run, working, command, load }: {
  run: DeskRun; working: boolean; command: ReviewLifecycleCommand; load: (id: string) => Promise<DeskRun | undefined>;
}) {
  const [action, setAction] = useState<DeskReviewAction>();
  if (runActive(run)) return null;
  const archived = reviewIsArchived(run);
  const actions: DeskReviewAction[] = archived ? ["restore", "delete"] : [
    ...(run.state !== "completed" ? ["complete"] as const : []),
    ...(run.state !== "completed" && !run.closure ? ["close"] as const : []),
    "archive", "delete",
  ];
  return <div className="review-action-row" role="group" aria-label="Review outcome">
    {actions.map(item => {
      const label = actionLabel(run, item);
      return <button className="btn review-icon-action" type="button" key={item} disabled={working}
        aria-label={label} title={label} aria-haspopup="dialog" onClick={() => setAction(item)}>
        <Icon name={item === "complete" && run.closure === "completed" ? "refresh" : actionIcons[item]} />
      </button>;
    })}
    {action && createPortal(<ReviewDecision key={action} run={run} action={action} command={command} load={load}
      onClose={() => setAction(undefined)} />, document.body)}
  </div>;
}

function ReviewDecision({ run, action, command, load, onClose }: {
  run: DeskRun; action: DeskReviewAction; command: ReviewLifecycleCommand;
  load: (id: string) => Promise<DeskRun | undefined>; onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const edited = useRef(false);
  const pending = useRef(false);
  const [working, setWorking] = useState(false);
  const [checks, setChecks] = useState<DeskReviewCheck[] | undefined>(action === "complete" ? undefined : []);
  const [readError, setReadError] = useState("");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    if (!edited.current) {
      const initial = suggestedReason(run, action);
      if (initial) setReason(initial);
      else void load(run.id).then(attempt => {
        const suggestion = suggestedReason(attempt, action);
        if (live && !edited.current && suggestion) setReason(suggestion);
      }).catch(() => {});
    }
    return () => { live = false; };
  }, [action, load, run.id, run.coordinatorActivity, run.decision]);
  useEffect(() => {
    if (action !== "complete") return;
    let live = true;
    setReadError("");
    setChecks(undefined);
    setSelected([]);
    void command({ kind: "readiness", id: run.id }).then(result => {
      if (!result.completion) throw new Error("The review completion checks are unavailable.");
      if (live) setChecks(result.completion.checks);
    }).catch(failure => { if (live) setReadError(errMessage(failure)); });
    return () => { live = false; };
  }, [action, command, run.id, revision]);
  const canSubmit = !working && !!reason.trim() && !!checks?.every(check => check.canWaive && selected.includes(check.id)) &&
    (!selected.length || reason.trim().length >= 8);
  const importedDelete = action === "delete" && run.source === "existing";
  const label = actionLabel(run, action);

  async function apply() {
    if (pending.current || !canSubmit) return;
    pending.current = true;
    setWorking(true);
    setError("");
    try {
      await command({ kind: "decide", id: run.id, decision: action, reason: reason.trim(), ...(selected.length && { waive: selected }) });
      onClose();
    } catch (failure) { setError(errMessage(failure)); }
    finally { setWorking(false); pending.current = false; }
  }
  return <Dialog title={label} tone={action === "delete" ? "danger" : "default"} width={580} onClose={working ? null : onClose} footer={<>
    <button className="btn btn-sm" disabled={working} onClick={onClose}>Cancel</button>
    <button className={action === "delete" ? "btn btn-sm btn-danger" : "btn btn-sm btn-primary"} disabled={!canSubmit}
      onClick={() => void apply()}>{working ? "Saving…" : selected.length ? "Complete with exceptions" : label}</button>
  </>}>
    <p>{importedDelete ? "Remove the entry from Desktop history. The project’s review files stay on disk." : explanation[action]}</p>
    {readError ? <p role="alert">{readError} <button className="btn btn-sm" onClick={() => setRevision(value => value + 1)}>Reload checks</button></p>
      : checks === undefined ? <Spinner label="Checking review readiness" />
      : checks.length > 0 && <fieldset className="review-decision-checks" disabled={working}>
        <legend>Open completion checks</legend>
        {checks.map(check => <label key={check.id}>
          <input type="checkbox" checked={selected.includes(check.id)} disabled={!check.canWaive}
            aria-label={check.canWaive ? "Make an exception for " + check.id : check.id + " requires a decision"}
            onChange={event => setSelected(event.currentTarget.checked ? [...selected, check.id] : selected.filter(id => id !== check.id))} />
          <span><strong>{check.title}</strong><small>{check.evidence}</small>{!check.canWaive && <small>A finding needs its own decision.</small>}</span>
        </label>)}
      </fieldset>}
    <label className="review-decision-reason">Reason
      <textarea className="text-input" rows={3} maxLength={2000} data-autofocus value={reason} disabled={working}
        onChange={event => { edited.current = true; setReason(event.currentTarget.value); }} />
    </label>
    {!!selected.length && <small>Use at least 8 characters to explain why the selected checks can be waived.</small>}
    {error && <p role="alert">{error} {action === "complete" && <button className="btn btn-sm" onClick={() => setRevision(value => value + 1)}>Reload checks</button>}</p>}
  </Dialog>;
}
