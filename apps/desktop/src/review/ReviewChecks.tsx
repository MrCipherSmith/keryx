import { Icon, type IconName } from "../components/Icon";
import type { ReviewCheck } from "../../../../src/review/board-detail-types";
import { ReviewBrowserLink } from "./ReviewBrowserLink";

function checkIcon(status: string): { icon: IconName; tone: string } {
  switch (status) {
    case "SUCCESS": return { icon: "circleCheck", tone: "ok" };
    case "FAILURE": case "ERROR": case "TIMED_OUT": case "ACTION_REQUIRED": case "STARTUP_FAILURE":
      return { icon: "circleX", tone: "danger" };
    case "QUEUED": case "PENDING": case "IN_PROGRESS": case "EXPECTED": case "WAITING": case "REQUESTED":
      return { icon: "clock", tone: "warn" };
    default: return { icon: "circle", tone: "neutral" };
  }
}

export function ReviewChecks({ checks, partial }: { checks: ReviewCheck[]; partial: boolean }) {
  if (!checks.length) return <p className="review-detail-muted">{partial ? "No checks loaded." : "No checks reported for this commit."}</p>;
  return <ul className="review-checks" aria-label="Checks on head commit">
    {checks.map(check => {
      const { icon, tone } = checkIcon(check.status);
      return <li className="review-detail-check" key={check.id}>
        <Icon className={`check-tone-${tone}`} name={icon} size={15} />
        <span className="review-check-name"><ReviewBrowserLink url={check.url}>{check.name}</ReviewBrowserLink></span>
        <span className="review-check-state">{check.status.toLowerCase().replaceAll("_", " ")}</span>
      </li>;
    })}
  </ul>;
}
