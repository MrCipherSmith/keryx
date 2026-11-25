import type { SessionReviewLink } from "./sessionReview";

/**
 * Where a session's review cards go: one card per round (link). A round that runs or waits is pinned above the
 * composer, like the plan card; every other round (finished, paused, not yet read) sits in the timeline where it started.
 * A link the cards have not reported yet stays in the timeline, so a reopened session does not flash its history pinned.
 */
export function splitReviewCards(links: readonly SessionReviewLink[], active: ReadonlySet<string>): {
  pinned: SessionReviewLink[]; timeline: SessionReviewLink[];
} {
  const pinned: SessionReviewLink[] = [];
  const timeline: SessionReviewLink[] = [];
  for (const link of links) (active.has(link.id) ? pinned : timeline).push(link);
  return { pinned, timeline };
}

/**
 * The texts that identify the user message a round started from, most specific first: the round's head commit (a v3
 * start turn names it), the request the user typed (v2), then the pull request URL.
 */
export function reviewCardAnchors(link: SessionReviewLink): string[] {
  return [link.revision.headSha, link.prompt ?? "", `https://github.com/${link.key.repo}/pull/${link.key.number}`]
    .filter(text => text.trim() !== "");
}

/** `previous` with `id` marked active or not; the same set when nothing changed, so React skips the render. */
export function withReviewActive(previous: ReadonlySet<string>, id: string, active: boolean): ReadonlySet<string> {
  if (previous.has(id) === active) return previous;
  const next = new Set(previous);
  if (active) next.add(id);
  else next.delete(id);
  return next;
}
