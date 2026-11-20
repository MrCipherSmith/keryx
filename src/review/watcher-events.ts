import type { ReviewCard } from "./board-types";
import type { WatcherEvent } from "./watcher-types";

export type WatchedCard = Pick<
  ReviewCard,
  | "number"
  | "baseSha"
  | "author"
  | "assignees"
  | "headSha"
  | "decision"
  | "ci"
  | "updatedAt"
  | "reviewers"
  | "reviewRequestIds"
>;

/** Keep only the fields that participate in change detection. */
export function observedCards(cards: ReviewCard[]): WatchedCard[] {
  return cards.map(
    ({
      number,
      baseSha,
      author,
      assignees,
      headSha,
      decision,
      ci,
      updatedAt,
      reviewers,
      reviewRequestIds,
    }) => ({
      number,
      baseSha,
      author,
      assignees,
      headSha,
      decision,
      ci,
      updatedAt,
      reviewers,
      ...(reviewRequestIds ? { reviewRequestIds } : {}),
    }),
  );
}

export function watcherChanges(previous: WatchedCard[], current: WatchedCard[], at: string): WatcherEvent[] {
  const before = new Map(previous.map((pr) => [pr.number, pr]));
  const events: WatcherEvent[] = [];
  for (const pr of current) {
    const last = before.get(pr.number);
    before.delete(pr.number);
    const initialCount = events.length;
    const event = (kind: WatcherEvent["kind"], description: string, reviewer?: string) =>
      events.push({
        kind,
        description,
        at,
        number: pr.number,
        headSha: pr.headSha,
        ...(reviewer ? { reviewer } : {}),
      });
    if (!last) event("opened", "PR appeared in the open list");
    else if (pr.headSha !== last.headSha) event("push", "New head commit");
    const prior = new Map(last?.reviewers.map((name) => [name.toLowerCase(), name]));
    for (const name of pr.reviewers) {
      const login = name.toLowerCase();
      const currentId = pr.reviewRequestIds?.[login];
      const previousId = last?.reviewRequestIds?.[login];
      if (!prior.has(login) || (currentId && previousId && currentId !== previousId)) {
        event("review_requested", `Review requested from ${name}`, name);
      }
      prior.delete(login);
    }
    for (const name of prior.values())
      event("review_request_removed", `Review request for ${name} is no longer pending`, name);
    if (!last) continue;
    if (pr.decision !== last.decision) event("decision", `Review decision: ${pr.decision ?? "none"}`);
    if (pr.ci !== last.ci && pr.ci !== "unknown") event("ci", `CI: ${pr.ci}`);
    if (events.length === initialCount && pr.updatedAt !== last.updatedAt) event("updated", "PR updated");
  }
  for (const { number, headSha } of before.values()) {
    events.push({ kind: "left_open", number, headSha, at, description: "PR left the open list" });
  }
  return events;
}
