import { afterAll, beforeEach, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";
import type { FlowCard } from "../platform/commands";
import type { ReviewBoardSnapshot } from "./types";
import type { ReviewLaunchDialogProps } from "./ReviewLaunchDialog";

let root: Root;
let render: (props: ReviewLaunchDialogProps) => Promise<void>;
let act: (work: () => void | Promise<void>) => Promise<void>;
beforeAll(async () => {
  registerDom();
  const React = await import("react");
  act = React.act as unknown as typeof act;
  const { ReviewLaunchDialog } = await import("./ReviewLaunchDialog");
  const host = document.body.appendChild(document.createElement("div"));
  root = (await import("react-dom/client")).createRoot(host);
  render = props => act(async () => { root.render(React.createElement(ReviewLaunchDialog, props)); });
});
beforeEach(async () => { await act(async () => root.render(null)); });
afterAll(async () => { await act(async () => root.unmount()); await unregisterDom(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

const board: ReviewBoardSnapshot = {
  version: 1, repo: "example/repo", repositoryId: "REPO_ID", viewer: "owner", repositories: ["example/repo"],
  fetchedAt: "2026-11-20", warnings: [],
  cards: [{ number: 14, state: "open", title: "Improve cache", url: "https://github.com/example/repo/pull/14",
    decision: null, reviewers: [], assignees: [], ci: "none", draft: false, author: "demo", updatedAt: "",
    baseSha: "aaa", headSha: "bbb" }],
};
const flow = (id: string, prUrl?: string): FlowCard => ({
  id, dir: id + "-sample", idValid: true, commandRef: null, title: "Work " + id, status: "active", previousStatus: null,
  blocked: false, owner: null, prUrl: prUrl ?? null, baseBranch: null, tasksDone: 0, tasksTotal: 0, acTotal: 0,
  acConfirmed: 0, updatedAt: null, completionExceptions: false, error: null,
});
const models = [{ provider: "first", model: "large", label: "Large" }, { provider: "second", model: "large", label: "Large" }];
const defaults: ReviewLaunchDialogProps = {
  flows: [flow("51", board.cards[0]!.url), flow("52")], models, loadTargets: async () => ({ snapshot: board, selectedNumber: 14 }),
  onApply: async () => {}, onClose() {},
};
const btn = (label: string) => [...document.querySelectorAll("button")].find(b => b.textContent === label)!;
const select = (name: string) => document.querySelector<HTMLSelectElement>(`select[aria-label="${name}"]`)!;
const click = (el: HTMLElement) => act(async () => el.click());
const choose = (el: HTMLSelectElement, value: string) => act(async () => {
  el.value = value; el.dispatchEvent(new Event("change", { bubbles: true }));
});
const changeText = (el: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const limit = (text: string) => [...document.querySelectorAll("label")].find(l => l.textContent?.startsWith(text))!.querySelector("input")!;
const addModel = (tier: string) => document.querySelector<HTMLButtonElement>(`[aria-label="Add model to ${tier} tier"]`)!;
async function pickModel(tier: string, provider: string) {
  await click(addModel(tier));
  await choose(select(tier + " provider"), provider);
  const search = document.querySelector<HTMLInputElement>(`[aria-label="Search ${tier} models"]`)!;
  await changeText(search, "absent");
  expect(document.querySelector('[role="option"]')).toBe(null);
  await changeText(search, "lar");
  const option = document.querySelector<HTMLElement>('[role="option"]')!;
  expect(option.textContent).toBe("Large");
  await click(option);
}
const flowSelector = () => [...document.querySelectorAll("label")].find(l => l.textContent?.startsWith("Associated Flow"))!.querySelector("select")!;

test("effective defaults are shown and require Apply", async () => {
  const calls: unknown[][] = [];
  const submitted = deferred<void>();
  let closed = 0;
  await render({ ...defaults, defaultFlow: "52", onClose: () => { closed++; },
    onApply: async (...values) => { calls.push(values); await submitted.promise; } });
  expect(btn("Auto").getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector<HTMLInputElement>('[type="checkbox"]')?.checked).toBe(true);
  expect(flowSelector().value).toBe("52");
  expect(limit("Max waves").value).toBe("0");
  expect(limit("Parallel reviewers").value).toBe("10");
  expect(limit("Token limit").value).toBe("0");
  const help = document.getElementById(limit("Parallel reviewers").getAttribute("aria-describedby")!);
  expect(help?.textContent).toContain("1–32");
  expect(calls).toHaveLength(0);
  const apply = btn("Apply");
  await act(async () => { apply.click(); apply.click(); });
  expect(calls).toEqual([[{ repo: board.repo, repositoryId: "REPO_ID", viewer: "owner", number: 14 }, { baseSha: "aaa", headSha: "bbb" },
    { mode: "auto", adaptive: true, maxParallel: 10, modelPools: { strong: [], middle: [], light: [] }, flowId: "52" }]]);
  expect(btn("Cancel").disabled).toBe(true);
  expect(closed).toBe(0);
  await act(async () => submitted.resolve());
  expect(closed).toBe(1);
});

test("limits, editable linked flow and provider/model pairs are scoped to the selected tier", async () => {
  const calls: unknown[][] = [];
  await render({ ...defaults, onApply: async (...values) => { calls.push(values); } });
  expect(flowSelector().value).toBe("51");
  await choose(flowSelector(), "");
  await click(btn("Manual"));
  await click(limit("Adaptive model selection"));
  await changeText(limit("Max waves"), "-1");
  expect(btn("Apply").disabled).toBe(true);
  await changeText(limit("Max waves"), "3");
  await changeText(limit("Parallel reviewers"), "33");
  expect(btn("Apply").disabled).toBe(true);
  await changeText(limit("Parallel reviewers"), "15");
  await changeText(limit("Token limit"), "120000");
  for (const m of models) await pickModel("Strong", m.provider);
  expect(addModel("Strong").disabled).toBe(true);
  await pickModel("Light", "first");
  await click(document.querySelector('[aria-label="Remove first Large from Strong"]')!);
  expect(calls).toHaveLength(0);
  await click(btn("Apply"));
  expect(calls[0]?.[2]).toEqual({ mode: "manual", adaptive: false, maxWaves: 3, maxParallel: 15, maxTokens: 120000,
    modelPools: { strong: [{ provider: "second", model: "large" }], middle: [], light: [{ provider: "first", model: "large" }] } });
});

test("the board launch defaults to orchestration and can apply a single-reviewer run", async () => {
  const calls: unknown[][] = [];
  await render({
    models, flows: [], fixedTarget: { repo: board.repo, repositoryId: board.repositoryId, viewer: board.viewer, card: board.cards[0]! },
    onApply: async (...values) => { calls.push(values); }, onClose() {},
  });
  expect(limit("Review orchestrator").checked).toBe(true);
  await changeText(limit("Max waves"), "-1");
  expect(btn("Apply").disabled).toBe(true);
  await click(limit("Review orchestrator"));
  expect(addModel("Strong")).toBeNull();
  expect(document.body.textContent).not.toContain("Parallel reviewers");
  await changeText(limit("Token limit"), "1000");
  await click(btn("Apply"));
  expect(calls[0]?.[2]).toEqual({ mode: "auto", orchestrator: false, adaptive: false, maxTokens: 1000,
    modelPools: { strong: [], middle: [], light: [] } });
});

test("editing the target invalidates it immediately and an obsolete result cannot replace the newer PR", async () => {
  const old = deferred<{snapshot: ReviewBoardSnapshot; selectedNumber: number}>();
  const calls: unknown[][] = [];
  let oldSignal: AbortSignal | undefined;
  const newCard = { ...board.cards[0]!, number: 99, headSha: "new-head" };
  const loadTargets: ReviewLaunchDialogProps["loadTargets"] = async (hint, signal) => {
    if (hint === "#14") { oldSignal = signal; return old.promise; }
    return { snapshot: { ...board, cards: [newCard] }, selectedNumber: 99 };
  };
  await render({ ...defaults, initialTarget: "#14", loadTargets, onApply: async (...values) => { calls.push(values); } });
  const input = document.querySelector<HTMLInputElement>("[data-autofocus]")!;
  await changeText(input, "#99");
  expect(oldSignal?.aborted).toBe(true);
  expect(btn("Apply").disabled).toBe(true);
  await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await act(async () => old.resolve({ snapshot: board, selectedNumber: 14 }));
  expect(select("Pull request").value).toBe("99");
  await click(btn("Apply"));
  expect(calls[0]?.slice(0, 2)).toEqual([{ repo: board.repo, repositoryId: "REPO_ID", viewer: "owner", number: 99 }, { baseSha: "aaa", headSha: "new-head" }]);
});

test("denied lookup exposes no previous PR, and a failed launch can be retried", async () => {
  let denied = false, attempts = 0, closed = 0;
  await render({ ...defaults, loadTargets: async () => {
    if (denied) throw Error("access: Repository unavailable");
    return { snapshot: board, selectedNumber: 14 };
  }, onApply: async () => { attempts++; throw Error("Provider offline"); }, onClose: () => { closed++; } });
  await click(btn("Apply"));
  expect(document.querySelector("[role=alert]")?.textContent).toBe("Provider offline");
  expect(btn("Apply").disabled).toBe(false);
  expect(closed).toBe(0);
  denied = true;
  await act(async () => { document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(document.body.textContent).toContain("Repository unavailable");
  expect(document.body.textContent).not.toContain("Improve cache");
  expect(btn("Apply").disabled).toBe(true);
  expect(attempts).toBe(1);
});
