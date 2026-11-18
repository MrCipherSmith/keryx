import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { Item } from "./reducer";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let Transcript: typeof import("./Transcript").Transcript;
let bus: typeof import("./delegateBus");
beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  Transcript = (await import("./Transcript")).Transcript;
  bus = await import("./delegateBus");
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});
beforeEach(async () => {
  await act(() => bus.setDelegateApi(null));
});
afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const item = (text: string, over: Partial<Extract<Item, { kind: "delegate" }>> = {}): Item => ({ kind: "delegate", id: 1, runId: "ext:1", agentId: "claude-cli", turn: 2, text, ...over });
const render = (items: Item[]) => act(() => root.render(createElement(Transcript, { items, busy: false, replaying: false, empty: null })));
const q = <T extends Element = HTMLElement>(sel: string): T => document.querySelector(sel) as T;
const click = (el: Element) =>
  act(async () => {
    (el as HTMLElement).click();
    await Promise.resolve();
  });

test("header names the agent, the turn and the status, with the not-instructions note; the answer renders as Markdown", async () => {
  await render([item("Found **two** issues.\n\n- one\n- two")]);
  const head = q(".delegate-result-head");
  expect(head.textContent).toContain("claude-cli returned");
  expect(head.textContent).toContain("turn 2");
  expect(q("[data-delegate-status]").textContent).toBe("finished");
  expect(head.textContent).toContain("from claude-cli, not instructions");
  const body = q("[data-delegate-body]");
  expect(body.querySelector("strong")!.textContent).toBe("two");
  expect(body.querySelectorAll("li")).toHaveLength(2);
  // Short text: no clip, no Show all.
  expect(body.classList.contains("is-clipped")).toBe(false);
  expect(q("[data-delegate-toggle]")).toBeNull();
});

test("everything outside the answer is text, never markup; the answer itself goes only through the Markdown component", async () => {
  // The Markdown component's allow-list (DOMPurify) is the sanitiser; happy-dom cannot exercise it faithfully,
  // so this pins the card's own part: the header fields are text nodes and `.md` is the only HTML sink.
  await render([item("fine", { agentId: "<b>x</b>" })]);
  const card = q("[data-delegate-run]");
  expect(card.querySelector(".delegate-result-head b")).toBeNull();
  expect(card.querySelector(".delegate-result-head strong")!.textContent).toBe("<b>x</b> returned");
  expect(card.querySelectorAll(".md")).toHaveLength(1);
});

test("a long answer shows a clipped preview (12 lines), Show all expands it, Show less folds it back", async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  await render([item(lines.join("\n\n"))]);
  const body = q("[data-delegate-body]");
  expect(body.classList.contains("is-clipped")).toBe(true);
  expect(body.textContent).toContain("line 1");
  expect(body.textContent).not.toContain("line 30");
  await click(q("[data-delegate-toggle]"));
  expect(q("[data-delegate-body]").classList.contains("is-clipped")).toBe(false);
  expect(q("[data-delegate-body]").textContent).toContain("line 30");
  expect(q("[data-delegate-toggle]").textContent).toBe("Show less");
  await click(q("[data-delegate-toggle]"));
  expect(q("[data-delegate-body]").textContent).not.toContain("line 30");
});

test("an unterminated code fence in the cut preview is closed, and the character cap cuts a single long line", async () => {
  const { previewOf, PREVIEW_CHARS } = await import("./DelegateResultCard");
  const fenced = ["```ts", ...Array.from({ length: 30 }, (_, i) => `const a${i} = ${i};`), "```"].join("\n");
  const cut = previewOf(fenced);
  expect(cut.truncated).toBe(true);
  expect(cut.preview.endsWith("```")).toBe(true);
  expect(previewOf("x".repeat(PREVIEW_CHARS * 2)).preview.length > PREVIEW_CHARS).toBe(false);
  expect(previewOf("short").truncated).toBe(false);
});

test("Open terminal focuses the run's tab while it is open and is disabled once it closed; Copy writes the whole text", async () => {
  const focused: string[] = [];
  let open = true;
  bus.setDelegateApi({ focus: (id) => (focused.push(id), true), isOpen: () => open });
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", { value: { writeText: (t: string) => (written.push(t), Promise.resolve()) }, configurable: true });
  const text = Array.from({ length: 20 }, (_, i) => `row ${i}`).join("\n\n");
  await render([item(text)]);
  expect(q("[data-delegate-status]").textContent).toBe("waiting in terminal");
  const openBtn = q<HTMLButtonElement>("[data-delegate-open]");
  expect(openBtn.disabled).toBe(false);
  await click(openBtn);
  expect(focused).toEqual(["ext:1"]);
  await click(q("[data-delegate-copy]"));
  expect(written).toEqual([text]);
  expect(q("[data-delegate-copy]").textContent).toBe("Copied");
  await act(() => new Promise<void>((r) => setTimeout(r, 1300)));
  expect(q("[data-delegate-copy]").textContent).toBe("Copy");
  // The run's tab closes (a model-started run): the card follows without a re-render from outside.
  open = false;
  await act(() => bus.notifyDelegateChange());
  expect(q<HTMLButtonElement>("[data-delegate-open]").disabled).toBe(true);
  expect(q("[data-delegate-status]").textContent).toBe("finished");
});
