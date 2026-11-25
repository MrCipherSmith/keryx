import type { SessionReviewLink } from "./sessionReview";

/**
 * Where a session's review cards go: one card per round (link). A round that runs or waits is pinned above the
 * composer, like the plan card; every other round (finished, paused, not yet read) sits in the timeline where it started
 * and scrolls away with the conversation.
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

/** The pull request a round belongs to: rounds of one pull request claim their start messages in order. */
export function reviewCardGroup(link: SessionReviewLink): string {
  return `${link.key.repositoryId}#${link.key.number}#${link.key.viewer.toLowerCase()}`;
}

/** `previous` with `id` marked active or not; the same set when nothing changed, so React skips the render. */
export function withReviewActive(previous: ReadonlySet<string>, id: string, active: boolean): ReadonlySet<string> {
  if (previous.has(id) === active) return previous;
  const next = new Set(previous);
  if (active) next.add(id);
  else next.delete(id);
  return next;
}

const PLACES_KEY = "keryx.session-review-places.v1";
const PLACES_LIMIT = 300;
let places: Map<string, number> | undefined;

/**
 * Where a round's card sits when no user message names its round (the agent started the review mid-turn): the id of the
 * last transcript item when the card first showed, by card key. Kept across restarts, so the card stays in the history
 * at that point instead of trailing the newest message.
 */
export function readReviewCardPlaces(): ReadonlyMap<string, number> {
  if (places) return places;
  places = new Map();
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(PLACES_KEY) ?? "[]");
    if (Array.isArray(stored)) for (const entry of stored) {
      if (Array.isArray(entry) && typeof entry[0] === "string" && Number.isSafeInteger(entry[1])) places.set(entry[0], entry[1]);
    }
  } catch { /* Without storage a place lasts for the window's lifetime. */ }
  return places;
}

/** Records each key's place unless it has one; returns the places, a new map when any was added. */
export function rememberReviewCardPlaces(entries: ReadonlyArray<readonly [string, number]>): ReadonlyMap<string, number> {
  const current = readReviewCardPlaces();
  const added = entries.filter(([key]) => !current.has(key));
  if (!added.length) return current;
  places = new Map([...current, ...added].slice(-PLACES_LIMIT));
  try { localStorage.setItem(PLACES_KEY, JSON.stringify([...places])); } catch { /* See readReviewCardPlaces. */ }
  return places;
}
