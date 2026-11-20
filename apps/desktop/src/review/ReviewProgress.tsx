import type { DeskReviewerProgress } from "../../../../src/review/desk-run-types";

/** The roster can grow between waves. This is reviewer completion, not an estimate of elapsed run time. */
export function ReviewProgress({ progress, active }: { progress?: Omit<DeskReviewerProgress, "sessions">; active: boolean }) {
  const planned = progress?.planned;
  const known = planned != null && planned > 0 && !!progress && progress.finished <= planned;
  if (!active && !known) return null;
  const label = known ? `${progress.finished} of ${planned} reviewers finished` : "Reviewer count unavailable";
  return <span className="review-progress">
    <span className="review-progress-caption">
      {progress?.wave != null && <span className="review-wave">Wave {progress.wave}</span>}
      <span>{label}</span>
    </span>
    <span role="progressbar" aria-label="Reviewer progress" aria-valuetext={label}
      aria-valuemin={0} aria-valuemax={known ? planned : undefined} aria-valuenow={known ? progress.finished : undefined}
      className={known ? "review-progress-track" : "review-progress-track is-indeterminate"}>
      <span style={known ? { width: (100 * progress.finished / planned) + "%" } : undefined} />
    </span>
  </span>;
}
