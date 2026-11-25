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

function harness(accept: boolean) {
  const actions: ReviewRunAction[] = [];
  const turns: Array<{ link: SessionReviewLink; note: string }> = [];
  const runCommand = (async (_cwd, _key, action) => {
    actions.push(action);
    return { version: 1, runs: [partial] } satisfies DeskRunSnapshot;
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

async function render(rig: ReturnType<typeof harness>) {
  await act(() => root.render(createElement(SessionReviewActivity, {
    cwd: "/dev/project", links: [link], visible: true, onContinueTurn: rig.onContinueTurn, runCommand: rig.runCommand,
  })));
  await flush();
}

async function typeNote(text: string) {
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
  const text = reviewContinueTurn({ key: rig.turns[0]!.link.key, note: rig.turns[0]!.note });
  expect(text).toContain("(review org-project-12-me)");
  expect(text).toContain("keryx review state show --review org-project-12-me");
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
