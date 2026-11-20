import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";
import type { Item } from "./reducer";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let Transcript: typeof import("./Transcript").Transcript;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  Transcript = (await import("./Transcript")).Transcript;
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const show = (items: Item[]) => act(() => root.render(createElement(Transcript, { items, busy: false, replaying: false, empty: null })));

test("keryx's gate note renders apart from the reply, with its tag and its list of reasons", async () => {
  await show([
    { kind: "agent", id: 1, text: "The blocker stays." },
    {
      kind: "notice",
      id: 2,
      level: "warn",
      text: "Review r02 is not complete. Refused on:\n- census incomplete\n- observations not reconciled",
      system: { tag: "review-gate" },
    },
    { kind: "agent", id: 3, text: "Blocker: the router." },
  ]);
  const replies = Array.from(host.querySelectorAll(".turn-agent > .md")).map((m) => m.textContent?.trim());
  expect(replies).toEqual(["The blocker stays.", "Blocker: the router."]);
  const note = host.querySelector(".notice.notice-system.notice-warn");
  expect(note?.querySelector(".notice-tag")?.textContent).toBe("review-gate");
  expect(Array.from(note?.querySelectorAll("li") ?? []).map((li) => li.textContent)).toEqual(["census incomplete", "observations not reconciled"]);
});

test("the app's own notice stays plain text", async () => {
  await show([{ kind: "notice", id: 1, level: "error", text: "**not** markdown" }]);
  const note = host.querySelector(".notice.notice-error");
  expect(note?.classList.contains("notice-system")).toBe(false);
  expect(note?.textContent).toBe("**not** markdown");
});

test("an image block shows as a picture; an svg one as a label", async () => {
  await show([
    { kind: "block", id: 1, role: "agent", block: { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" } },
    { kind: "block", id: 2, role: "agent", block: { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" } },
  ]);
  const imgs = host.querySelectorAll(".feed-image img");
  expect(imgs.length).toBe(1);
  expect(imgs[0]?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
  expect(host.querySelector(".feed-chip.is-muted")?.textContent).toBe("image (image/svg+xml) not shown");
});

test("copy uses the original text and editing sends without changing history", async () => {
  const sent: string[] = [];
  const copied: string[] = [];
  const original = Object.getOwnPropertyDescriptor(navigator.clipboard, "writeText");
  Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async (text: string) => { copied.push(text); } });
  await act(() => root.render(createElement(Transcript, {
    items: [{ kind: "user", id: 1, text: "original message" }],
    busy: false,
    replaying: false,
    empty: null,
    onEditMessage: (text: string) => { sent.push(text); return true; },
  })));
  const actions = host.querySelector(".user-msg + .user-msg-actions");
  try {
    await act(async () => actions?.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')?.click());
    expect(copied).toEqual(["original message"]);
  } finally {
    if (original) Object.defineProperty(navigator.clipboard, "writeText", original);
    else Reflect.deleteProperty(navigator.clipboard, "writeText");
  }
  await act(() => actions?.querySelector<HTMLButtonElement>('[aria-label="Edit message"]')?.click());
  expect(host.querySelector("textarea")?.value).toBe("original message");
  await act(() => host.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
  expect(sent).toEqual(["original message"]);
  expect(host.querySelector(".user-msg")?.textContent).toBe("original message");
});

test("resend keeps exact indentation and the original attachment blocks", async () => {
  const context = {
    images: [], local: [], pickedCount: 1,
    blocks: [{ type: "resource", resource: { uri: "keryx-desktop:picked-elements", text: "page data" } }],
  };
  const sent: unknown[] = [];
  await act(() => root.render(createElement(Transcript, {
    items: [{ kind: "user", id: 1, text: " /help", context }],
    busy: false, replaying: false, empty: null,
    onEditMessage: (...args: unknown[]) => { sent.push(args); return true; },
  })));
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Edit message"]')?.click());
  await act(() => host.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
  expect(sent).toEqual([[" /help", context]]);
});

test("copy of a picked-elements-only message copies the count, never page data", async () => {
  const copied: string[] = [];
  const original = Object.getOwnPropertyDescriptor(navigator.clipboard, "writeText");
  Object.defineProperty(navigator.clipboard, "writeText", { configurable: true, value: async (text: string) => { copied.push(text); } });
  try {
    for (const [id, count] of [[11, 1], [12, 2]] as const) {
      const context = {
        images: [], local: [], pickedCount: count,
        blocks: [{ type: "resource", resource: { uri: "keryx-desktop:picked-elements", text: "page data" } }],
      };
      await show([{ kind: "user", id, text: "", context }]);
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Copy message"]')?.click());
    }
  } finally {
    if (original) Object.defineProperty(navigator.clipboard, "writeText", original);
    else Reflect.deleteProperty(navigator.clipboard, "writeText");
  }
  expect(copied).toEqual(["1 picked page element", "2 picked page elements"]);
});

test("focus returns to the Edit button after a successful resend", async () => {
  await act(() => root.render(createElement(Transcript, {
    items: [{ kind: "user", id: 21, text: "hello" }],
    busy: false, replaying: false, empty: null,
    onEditMessage: () => true,
  })));
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Edit message"]')?.click());
  expect(host.querySelector("textarea")).not.toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
  expect(host.querySelector("textarea")).toBeNull();
  const edit = host.querySelector<HTMLButtonElement>('[aria-label="Edit message"]');
  expect(edit).not.toBeNull();
  expect(document.activeElement).toBe(edit);
});

test("a flattened replay shows an inline note and cannot be edited", async () => {
  const text = "[external content abc-1 from keryx-desktop:picked-elements:\npage data";
  await act(() => root.render(createElement(Transcript, {
    items: [{ kind: "user", id: 31, text }],
    busy: false, replaying: false, empty: null,
    onEditMessage: () => true,
  })));
  expect(host.querySelector(".user-msg-note")?.textContent).toBe("Cannot resend: the saved history does not keep the original attachments. Send a new message with fresh attachments.");
  expect(host.querySelector<HTMLButtonElement>('[aria-label="Edit message"]')?.disabled).toBe(true);
});

test("a failed message shows an alert note that goes away while the editor is open", async () => {
  await act(() => root.render(createElement(Transcript, {
    items: [{ kind: "user", id: 41, text: "hello", failed: true } as Item],
    busy: false, replaying: false, empty: null,
    onEditMessage: () => true,
  })));
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toBe("Not sent — edit to retry");
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Edit message"]')?.click());
  expect(host.querySelector("textarea")).not.toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).not.toContain("Not sent");
});

test("Escape in the editor returns focus to the Edit button", async () => {
  await act(() => root.render(createElement(Transcript, {
    items: [{ kind: "user", id: 51, text: "hello" }],
    busy: false, replaying: false, empty: null,
    onEditMessage: () => true,
  })));
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Edit message"]')?.click());
  const area = host.querySelector<HTMLTextAreaElement>("textarea");
  expect(area).not.toBeNull();
  await act(() => { area?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  expect(host.querySelector("textarea")).toBeNull();
  const edit = host.querySelector<HTMLButtonElement>('[aria-label="Edit message"]');
  expect(edit).not.toBeNull();
  expect(document.activeElement).toBe(edit);
});

test("the unavailable note is linked to the disabled Edit button by aria-describedby", async () => {
  const text = "[external content abc-1 from keryx-desktop:picked-elements:\npage data";
  await act(() => root.render(createElement(Transcript, {
    items: [{ kind: "user", id: 61, text }],
    busy: false, replaying: false, empty: null,
    onEditMessage: () => true,
  })));
  const edit = host.querySelector<HTMLButtonElement>('[aria-label="Edit message"]');
  expect(edit?.disabled).toBe(true);
  const id = edit?.getAttribute("aria-describedby");
  expect(Boolean(id)).toBe(true);
  const note = document.getElementById(id ?? "");
  expect(note).not.toBeNull();
  expect(note).toBe(host.querySelector(".user-msg-note"));
  expect(note?.getAttribute("role")).toBe("note");
});

test("the not-sent note disappears once the message is resent", async () => {
  await act(() => root.render(createElement(Transcript, {
    items: [{ kind: "user", id: 71, text: "hello", failed: true } as Item],
    busy: false, replaying: false, empty: null,
    onEditMessage: () => true,
  })));
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Edit message"]')?.click());
  await act(() => host.querySelector<HTMLButtonElement>('button[type="submit"]')?.click());
  expect(host.querySelector("textarea")).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

test("a literal image marker in message text is not treated as an attachment", async () => {
  const text = "Example\n\n[Local image attachments (use local tools to inspect):]\n/tmp/keryx-chat-images-test/example.png";
  await show([{ kind: "user", id: 1, text }]);
  expect(host.querySelector(".user-msg")?.textContent).toBe(text);
});

test("a tool's output is shown once, and a diff it printed is coloured", async () => {
  const out = "@@ -1 +1 @@\n-a\n+b";
  await show([
    {
      kind: "tool",
      id: 1,
      toolCallId: "c1",
      title: "shell_exec",
      toolKind: "execute",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: out } }],
      rawOutput: out,
      autoApproved: false,
      startedAt: 0,
      endedAt: 10,
    },
  ]);
  await act(async () => {
    host.querySelector<HTMLButtonElement>(".tool-row")!.click();
  });
  const body = host.querySelector(".tool-body");
  // The diff goes through the Markdown renderer as a diff fence (its colouring is covered in Markdown.dom.test;
  // happy-dom's DOMPurify drops a lone first <pre>, so the block itself is not asserted here).
  expect(body?.querySelectorAll(".md.md-output").length).toBe(1);
  expect(body?.querySelector(".md-output code")?.className).toBe("language-diff");
  expect(body?.querySelector("pre.out-pre")).toBeNull();
  expect(Array.from(body?.querySelectorAll(".tool-label") ?? []).map((l) => l.textContent)).not.toContain("Output");
});
