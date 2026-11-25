import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { DeskRun, DeskRunSnapshot } from "../../../../src/review/desk-run-types";
import type { ReviewRunAction, reviewRun as ReviewRun } from "../platform/reviewRuns";
import { registerDom, unregisterDom } from "../test/dom";
import type { SessionReviewLink } from "./sessionReview";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let SessionReviewActivity: typeof import("./SessionReviewActivity").SessionReviewActivity;
let reviewContinueTurn: typeof import("./reviewTurn").reviewContinueTurn;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  ({ SessionReviewActivity } = await import("./SessionReviewActivity"));
  ({ reviewContinueTurn } = await import("./reviewTurn"));
  host = document.createElement("div");
  document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});
afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const key = { repo: "org/project", repositoryId: "RID", viewer: "me", number: 12 };
const link: SessionReviewLink = { id: "run-1", sessionId: "session-1", key, revision: { baseSha: "b".repeat(40), headSha: "a".repeat(40) } };
// A v2 attempt from runs.sqlite that stopped part-way: the card offers Continue review.
const partial: DeskRun = {
  id: "run-1", source: "manual", state: "partial", phase: "Stopped", reason: "Budget reached", sessionId: "session-1",
  baseSha: link.revision.baseSha, headSha: link.revision.headSha, createdAt: "2026-11-20T00:00:00Z",
  startedAt: "2026-11-20T00:00:01Z", finishedAt: "2026-11-20T00:10:00Z", result: null,
};

function harness(accept: boolean, run: DeskRun = partial) {
  const actions: ReviewRunAction[] = [];
  const turns: Array<{ link: SessionReviewLink; note: string }> = [];
  const runCommand = (async (_cwd, _key, action) => {
    actions.push(action);
    return { version: 1, runs: [run] } satisfies DeskRunSnapshot;
  }) as typeof ReviewRun;
  const onContinueTurn = (target: SessionReviewLink, note: string) => {
    turns.push({ link: target, note });
    return accept;
  };
  return { actions, turns, runCommand, onContinueTurn };
}

async function flush() {
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
}

async function render(rig: ReturnType<typeof harness>, onActiveChange?: (id: string, active: boolean) => void,
  memory?: import("./SessionReviewActivity").ReviewCardMemory, pinned = false) {
  await act(() => root.render(createElement(SessionReviewActivity, {
    cwd: "/dev/project", links: [link], visible: true, onContinueTurn: rig.onContinueTurn, runCommand: rig.runCommand, onActiveChange,
    memory, pinned, key: pinned ? "pinned" : "timeline",
  })));
  await flush();
}

async function expand() {
  const toggle = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "Show details");
  expect(toggle).not.toBeUndefined();
  await act(() => toggle!.click());
}

async function typeNote(text: string) {
  await expand();
  const field = host.querySelector<HTMLTextAreaElement>(".session-review-item textarea");
  expect(field).not.toBeNull();
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text);
    field!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return field!;
}

function continueButton() {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "Continue review");
  expect(button).not.toBeUndefined();
  return button!;
}

test("AC7 Continue review sends the continue turn into the shown session and no review_run continue", async () => {
  const rig = harness(true);
  await render(rig);
  const field = await typeNote("Look at the migration again.");
  await act(async () => {
    continueButton().click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  await flush();
  expect(rig.turns).toEqual([{ link, note: "Look at the migration again." }]);
  expect(rig.actions.every(action => action.kind === "status")).toBe(true);
  expect(rig.actions.some(action => action.kind === "continue")).toBe(false);
  expect(field.value).toBe("");
  expect(host.querySelector('.session-review-item [role="alert"]')).toBeNull();
  // The App sends exactly this text: the review id and `keryx review state show`, then the note.
  const sent = rig.turns[0]!.link;
  const text = reviewContinueTurn({ key: sent.key, note: rig.turns[0]!.note, attemptId: sent.id, revision: sent.revision, sessionId: sent.sessionId });
  expect(text).toContain("(review org-project-12-me)");
  expect(text).toContain("keryx review state show --review org-project-12-me");
  expect(text).toContain("If `state show` reports no review, run `keryx review state open --pr https://github.com/org/project/pull/12");
  expect(text).toContain("continue the earlier Desktop attempt run-1");
  expect(text.endsWith("\nLook at the migration again.")).toBe(true);
});

test("AC8 a busy session refuses the continue turn: no turn, no detached continue, the reason shows and the note stays", async () => {
  await act(() => root.render(null));
  const rig = harness(false);
  await render(rig);
  const field = await typeNote("Check the API contract.");
  await act(async () => {
    continueButton().click();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  await flush();
  expect(rig.turns).toHaveLength(1);
  expect(rig.actions.some(action => action.kind === "continue")).toBe(false);
  expect(host.querySelector('.session-review-item [role="alert"]')?.textContent).toContain("The session is running a turn. Send the review when it finishes.");
  expect(field.value).toBe("Check the API contract.");
  expect(continueButton().disabled).toBe(false);
});

test("a round's card is compact by default: round, verdict and findings, with details behind a toggle", async () => {
  await act(() => root.render(null));
  const reviewed: DeskRun = { ...partial, state: "completed", round: 2, result: { reviewed: link.revision, verdict: "request-changes",
    coverage: "complete", findingsKnown: true, findings: { blocker: 0, major: 2, minor: 1, info: 0 }, report: "# Report" } };
  const reports: Array<[string, boolean]> = [];
  await render(harness(true, reviewed), (id, active) => reports.push([id, active]));
  expect(host.querySelector(".session-review-summary")?.textContent).toContain("Round 2 · verdict request-changes · 2 major, 1 minor");
  expect(host.querySelector(".review-plan-summary")).toBeNull();
  expect(host.querySelector(".review-session-outcome")).toBeNull();
  const toggle = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "Show details")!;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  await act(() => toggle.click());
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(toggle.textContent).toBe("Hide details");
  expect(host.querySelector(".review-plan-summary")).not.toBeNull();
  expect(host.querySelector(".review-session-outcome")).not.toBeNull();
  // A finished round reports itself inactive: its card belongs in the timeline.
  expect(reports).toEqual([["run-1", false]]);
});

test("a running round reports itself active, so the caller pins its card above the composer", async () => {
  await act(() => root.render(null));
  const reports: Array<[string, boolean]> = [];
  await render(harness(true, { ...partial, state: "running", finishedAt: null }), (id, active) => reports.push([id, active]));
  expect(reports).toEqual([["run-1", true]]);
});

test("a card moving from the pinned slot to the timeline keeps its expansion and unsent note", async () => {
  await act(() => root.render(null));
  const memory: import("./SessionReviewActivity").ReviewCardMemory = new Map();
  const rig = harness(true);
  await render(rig, undefined, memory, true);
  await typeNote("Half-written note");
  // The round finished: the caller now renders the card in the timeline, a new tree.
  await render(rig, undefined, memory, false);
  const toggle = [...host.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === "Hide details");
  expect(toggle?.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector<HTMLTextAreaElement>(".session-review-item textarea")?.value).toBe("Half-written note");
});

test("a pinned round whose attempt can no longer be found reports itself inactive, so it leaves the pinned slot", async () => {
  await act(() => root.render(null));
  const reports: Array<[string, boolean]> = [];
  const rig = harness(true);
  rig.runCommand = (async () => ({ version: 1, runs: [] })) as typeof ReviewRun;
  await render(rig, (id, active) => reports.push([id, active]));
  expect(reports).toEqual([["run-1", false]]);
});
