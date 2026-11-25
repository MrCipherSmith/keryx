import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";
import type { Item } from "./reducer";
import type { ReviewCardSlot } from "./Transcript";
import type { SessionReviewLink } from "../review/sessionReview";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let Transcript: typeof import("./Transcript").Transcript;
let placement: typeof import("../review/reviewPlacement");

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  ({ Transcript } = await import("./Transcript"));
  placement = await import("../review/reviewPlacement");
  host = document.createElement("div");
  document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});
afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const url = "https://github.com/org/project/pull/12";
const head1 = "a".repeat(40);
const head2 = "c".repeat(40);
const key = { repo: "org/project", repositoryId: "RID", viewer: "me", number: 12 };
const round1: SessionReviewLink = { id: "run-1", sessionId: "s", key, revision: { baseSha: "b".repeat(40), headSha: head1 } };
const round2: SessionReviewLink = { id: "run-2", sessionId: "s", key, revision: { baseSha: "b".repeat(40), headSha: head2 } };
// Round 1 starts, the user fixes findings, then round 2 starts later in the same session.
const items: Item[] = [
  { kind: "user", id: 1, text: `Review pull request ${url} with the review-orchestrator skill.\nReview this revision: base ${"b".repeat(40)}, head ${head1}.` },
  { kind: "agent", id: 2, text: "Round 1 found two majors." },
  { kind: "user", id: 3, text: "Fix the two majors." },
  { kind: "agent", id: 4, text: "Fixed and pushed." },
  { kind: "user", id: 5, text: `Review pull request ${url} with the review-orchestrator skill.\nReview this revision: base ${"b".repeat(40)}, head ${head2}.` },
  { kind: "agent", id: 6, text: "Round 2 started." },
];

function slot(link: SessionReviewLink): ReviewCardSlot {
  return { key: link.id, anchors: placement.reviewCardAnchors(link),
    node: createElement("article", { className: "test-review-card", "data-round": link.id }, `card ${link.id}`) };
}

async function render(cards: ReviewCardSlot[]) {
  await act(() => root.render(createElement(Transcript, { items, busy: false, replaying: false, empty: null, reviewCards: cards })));
}

/** The transcript's children in order, cards named by their round and messages by their text. */
function order(): string[] {
  const inner = host.querySelector(".transcript-inner")!;
  return [...inner.querySelectorAll(".test-review-card, .turn-user, .turn-agent")]
    .map(node => node.classList.contains("test-review-card") ? `[${node.getAttribute("data-round")}]` : (node.textContent ?? "").trim());
}

test("a finished round's card sits in the timeline right after the message that started its round, not at the end", async () => {
  await render([slot(round1)]);
  const sequence = order();
  expect(sequence.indexOf("[run-1]")).toBe(1);
  expect(sequence.at(-1)).not.toBe("[run-1]");
});

test("two rounds give two cards, each where its own round started; the conversation continues below each", async () => {
  await render([slot(round1), slot(round2)]);
  const sequence = order();
  expect(sequence.filter(entry => entry.startsWith("[run-"))).toEqual(["[run-1]", "[run-2]"]);
  // Round 1's card stays above the fix-findings exchange; round 2's card follows the second review message.
  expect(sequence.indexOf("[run-1]")).toBeLessThan(sequence.findIndex(entry => entry.includes("Fix the two")));
  expect(sequence.indexOf("[run-2]")).toBe(sequence.length - 2);
});

test("a card whose round matches no message goes after the last item", async () => {
  const stray: SessionReviewLink = { ...round1, id: "run-9", key: { ...key, number: 99 }, revision: { ...round1.revision, headSha: "f".repeat(40) } };
  await render([slot(stray)]);
  expect(order().at(-1)).toBe("[run-9]");
});

test("running or waiting rounds are pinned, the others stay in the timeline; one card per round", () => {
  const active = placement.withReviewActive(new Set(), "run-2", true);
  expect(placement.withReviewActive(active, "run-2", true)).toBe(active);
  const { pinned, timeline } = placement.splitReviewCards([round2, round1], active);
  expect(pinned.map(link => link.id)).toEqual(["run-2"]);
  expect(timeline.map(link => link.id)).toEqual(["run-1"]);
  // Round 2 finishing unpins it: both rounds are then timeline cards.
  const done = placement.withReviewActive(active, "run-2", false);
  expect(placement.splitReviewCards([round2, round1], done).timeline.map(link => link.id)).toEqual(["run-2", "run-1"]);
  expect(placement.reviewCardAnchors(round1)).toEqual([head1, url]);
});
