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

test("a table or code block in the card scrolls sideways inside itself; cells are not squeezed to single letters", async () => {
  const read = async (path: string) => ((await import(path, { with: { type: "text" } })) as unknown as { default: string }).default;
  const css = await read("../styles.css");
  const del = await read("../styles/delegate.css");
  const rule = (src: string, sel: string) => src.slice(src.indexOf(`${sel} {`), src.indexOf("}", src.indexOf(`${sel} {`)));
  expect(rule(css, ".md table")).toMatch(/overflow-x:\s*auto/);
  expect(rule(css, ".md table")).toContain("max-width: 100%");
  expect(rule(css, ".md th, .md td")).toMatch(/word-break:\s*normal/);
  expect(rule(css, ".md th, .md td")).toMatch(/min-width:\s*\d/);
  expect(rule(css, ".md th")).toContain("white-space: nowrap");
  expect(rule(css, ".md pre, .md .code-block pre")).toMatch(/overflow-x:\s*auto/);
  expect(rule(del, ".delegate-result-body")).not.toContain("anywhere");
  expect(rule(del, ".delegate-result-body")).toContain("min-width: 0");
  expect(del).toMatch(/\.delegate-result-body \.md table[^{]*\{[^}]*overflow-x:\s*auto/);
  expect(rule(del, ".delegate-result-body.is-clipped")).toContain("mask-image");
});

test("a replayed note renders as the card: its text, no envelope tags, no raw note header", async () => {
  const { applyUpdates, newConv } = await import("./reducer");
  const replayed = applyUpdates(newConv("s1", { replaying: true }), [
    {
      at: 1,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "| a | b |\n|---|---|\n| 1 | 2 |" },
        _meta: { keryx: { delegateResult: { runId: "ext:1", agentId: "claude-cli", turn: 1, text: "| a | b |\n|---|---|\n| 1 | 2 |" } } },
      },
    },
  ]);
  await render(replayed.items);
  const card = q(".delegate-result");
  expect(card).not.toBeNull();
  expect(q("[data-delegate-body]")).not.toBeNull();
  expect(card.textContent).toContain("claude-cli");
  expect(document.body.textContent).not.toContain("delegate-result-");
  expect(document.body.textContent).not.toContain("UNTRUSTED");
  expect(document.querySelector(".msg-user, .user-bubble")).toBeNull();
});
