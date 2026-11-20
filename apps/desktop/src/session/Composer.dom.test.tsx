import { savingDone, waitFor } from "./testWait";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let Composer: typeof import("./Composer").Composer;
let createElement: typeof import("react").createElement;
let createRef: typeof import("react").createRef;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  createRef = React.createRef;
  Composer = (await import("./Composer")).Composer;
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

function props(sessionId: string | null, ref: import("react").Ref<import("./Composer").ComposerHandle>) {
  return {
    ref,
    sessionId,
    busy: false,
    disabledReason: null,
    commands: [],
    modes: null,
    model: undefined,
    sendKey: "enter" as const,
    onSend: () => true,
    onStop: () => {},
    onMode: () => {},
    onModel: () => {},
  };
}

test("a prefill made with no session is still in the textarea once the session appears", async () => {
  const ref = createRef<import("./Composer").ComposerHandle>();
  await act(() => root.render(createElement(Composer, props(null, ref))));
  await act(async () => ref.current!.setText("from flows"));
  expect(host.querySelector("textarea")!.value).toBe("from flows");

  await act(() => root.render(createElement(Composer, props("A", ref))));
  expect(host.querySelector("textarea")!.value).toBe("from flows");
});

// ---- height -----------------------------------------------------------------------------------------
// Regression: on the empty session screen the box was half the window tall. Its height was measured only when
// the text changed, and a narrow moment (a side panel opening) wraps the placeholder into many lines; that
// height then stayed after the column widened again.

function withScrollHeight(el: HTMLTextAreaElement, h: number) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => h });
}

test("an empty box stays at its CSS minimum even when the wrapped placeholder is tall", async () => {
  const { fitComposerHeight } = await import("./Composer");
  const el = document.createElement("textarea");
  el.style.height = "260px";
  withScrollHeight(el, 400);
  fitComposerHeight(el);
  expect(el.style.height).toBe("");
});

test("the box grows with its text and stops at the maximum", async () => {
  const { fitComposerHeight, COMPOSER_MAX_PX } = await import("./Composer");
  const el = document.createElement("textarea");
  el.value = "two\nlines";
  withScrollHeight(el, 72);
  fitComposerHeight(el);
  expect(el.style.height).toBe("72px");
  withScrollHeight(el, 900);
  fitComposerHeight(el);
  expect(el.style.height).toBe(`${COMPOSER_MAX_PX}px`);
});

test("the composer renders one row and sets no height while empty", async () => {
  await act(() => root.render(createElement(Composer, props("H", createRef()))));
  const area = host.querySelector("textarea")!;
  expect(area.getAttribute("rows")).toBe("1");
  expect(area.style.height).toBe("");
});

test("the dock and box carry no growing or fixed-height rule; the textarea is capped and does not stretch", async () => {
  const css = ((await import("../styles.css", { with: { type: "text" } })) as unknown as { default: string }).default;
  const { COMPOSER_MAX_PX } = await import("./Composer");
  const rule = (sel: string) => css.split("\n").find((l: string) => l.startsWith(`${sel} {`)) ?? "";
  for (const sel of [".composer-dock", ".composer"]) {
    const r = rule(sel) || css.slice(css.indexOf(`${sel} {`), css.indexOf("}", css.indexOf(`${sel} {`)));
    expect(r).not.toBe("");
    expect(r).not.toMatch(/flex:\s*1|flex-grow|(^|[\s;{])height:|min-height|align-self:\s*stretch/);
  }
  expect(rule(".composer-dock")).toContain("flex: none");
  const ta = css.slice(css.indexOf(".composer textarea {"), css.indexOf("}", css.indexOf(".composer textarea {")));
  expect(ta).toContain(`max-height: ${COMPOSER_MAX_PX}px`);
  expect(ta).toContain("resize: none");
  expect(ta).not.toMatch(/flex:|[\s;{]height:/);
});

test("the chip row never overflows: chips shrink and truncate, the hint drops first, the row wraps, send stays right", async () => {
  const css = ((await import("../styles.css", { with: { type: "text" } })) as unknown as { default: string }).default;
  const rule = (sel: string) => css.slice(css.indexOf(`${sel} {`), css.indexOf("}", css.indexOf(`${sel} {`)));
  expect(rule(".composer")).toContain("container-type: inline-size");
  expect(rule(".composer-bar")).toContain("flex-wrap: wrap");
  expect(rule(".composer-bar")).toContain("min-width: 0");
  expect(rule(".chip-btn")).toMatch(/min-width:\s*0/);
  expect(rule(".chip-btn")).toMatch(/flex:\s*0 1 auto/);
  expect(rule(".chip-model")).toMatch(/min-width:\s*0/);
  expect(rule(".send-btn")).toContain("margin-left: auto");
  expect(rule(".send-btn")).toContain("flex: none");
  expect(css).toMatch(/@container composer \(max-width: \d+px\) \{ \.composer-hint \{ display: none; \} \}/);
  // the shared .truncate class gives the ellipsis
  const comp = ((await import("../styles/components.css", { with: { type: "text" } })) as unknown as { default: string }).default;
  expect(comp).toMatch(/\.truncate \{[^}]*text-overflow: ellipsis/);
});

test("a long provider or model label carries its full text in the title and truncates", async () => {
  await act(() => root.render(createElement(Composer, props("H", createRef()))));
  const labels = Array.from(host.querySelectorAll<HTMLElement>(".chip-btn .truncate"));
  for (const l of labels) expect(l.getAttribute("title")).toBe(l.textContent);
});

// ---- attachments (page elements picked in the browser panel) -----------------------------------------

const SHOT = "data:image/png;base64,iVBORw0KGgo=";

async function pasteImages(count: number) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  const files = Array.from({ length: count }, (_, i) => new File([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10, i)], `shot${i}.png`, { type: "image/png" }));
  Object.defineProperty(event, "clipboardData", { value: { files, getData: () => "" } });
  await act(async () => { host.querySelector("textarea")?.dispatchEvent(event); });
  await waitFor(() => savingDone(host), act);
}

test("a rejected saveImage shows an alert and adds no chip", async () => {
  await act(() => root.render(null));
  await act(() => root.render(createElement(Composer, {
    ...props("REJ", createRef()),
    saveImage: async () => { throw new Error("disk full"); },
    loadImage: async () => SHOT,
  })));
  await pasteImages(1);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("disk full");
  expect(host.querySelector(".attach-chip")).toBeNull();
});

test("in a mixed batch the successful images are kept and the failure is reported", async () => {
  await act(() => root.render(null));
  let n = 0;
  await act(() => root.render(createElement(Composer, {
    ...props("MIX", createRef()),
    saveImage: async () => { n += 1; if (n === 2) throw new Error("disk full"); return `/tmp/keryx-chat-images-mix/ok${n}.png`; },
    loadImage: async () => SHOT,
  })));
  await pasteImages(3);
  expect(host.querySelectorAll(".attach-chip").length).toBe(2);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("disk full");
});

test("unmounting with an unsent attachment discards its saved copy", async () => {
  await act(() => root.render(null));
  const discarded: string[] = [];
  const path = "/tmp/keryx-chat-images-unm/a.png";
  await act(() => root.render(createElement(Composer, {
    ...props("UNM", createRef()),
    saveImage: async () => path,
    discardFile: async (p: string) => { discarded.push(p); },
    loadImage: async () => SHOT,
  })));
  await pasteImages(1);
  expect(host.querySelectorAll(".attach-chip").length).toBe(1);
  expect(discarded).toEqual([]);
  await act(() => root.render(null));
  expect(discarded).toEqual([path]);
});

test("switching session discards the previous session's unsent attachment", async () => {
  await act(() => root.render(null));
  const discarded: string[] = [];
  const path = "/tmp/keryx-chat-images-sw/a.png";
  const base = { saveImage: async () => path, discardFile: async (p: string) => { discarded.push(p); }, loadImage: async () => SHOT };
  await act(() => root.render(createElement(Composer, { ...props("SW1", createRef()), ...base })));
  await pasteImages(1);
  await act(() => root.render(createElement(Composer, { ...props("SW2", createRef()), ...base })));
  expect(discarded).toEqual([path]);
  await act(() => root.render(null));
});

test("after a successful send, unmounting does not discard the sent attachment", async () => {
  await act(() => root.render(null));
  const discarded: string[] = [];
  const reported: string[][] = [];
  const path = "/tmp/keryx-chat-images-snt/a.png";
  await act(() => root.render(createElement(Composer, {
    ...props("SNT", createRef()),
    saveImage: async () => path,
    discardFile: async (p: string) => { discarded.push(p); },
    loadImage: async () => SHOT,
    onSend: () => true,
    onAttachmentsSent: (paths: readonly string[]) => { reported.push([...paths]); },
  })));
  await pasteImages(1);
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click(); });
  expect(reported).toEqual([[path]]);
  expect(host.querySelector(".attach-chip")).toBeNull();
  await act(() => root.render(null));
  expect(discarded).toEqual([]);
});

test("switching A→B→A drops A's chips together with its discarded files", async () => {
  await act(() => root.render(null));
  const discarded: string[] = [];
  const path = "/tmp/keryx-chat-images-aba/a.png";
  const base = { saveImage: async () => path, discardFile: async (p: string) => { discarded.push(p); }, loadImage: async () => SHOT };
  await act(() => root.render(createElement(Composer, { ...props("ABA1", createRef()), ...base })));
  await pasteImages(1);
  expect(host.querySelectorAll(".attach-chip").length).toBe(1);
  await act(() => root.render(createElement(Composer, { ...props("ABA2", createRef()), ...base })));
  expect(discarded).toEqual([path]);
  await act(() => root.render(createElement(Composer, { ...props("ABA1", createRef()), ...base })));
  expect(host.querySelectorAll(".attach-chip").length).toBe(0);
  expect(discarded).toEqual([path]);
  await act(() => root.render(null));
});

test("unmounting while onSend is still pending does not discard the files being sent", async () => {
  await act(() => root.render(null));
  const discarded: string[] = [];
  let release: (ok: boolean) => void = () => {};
  const path = "/tmp/keryx-chat-images-pnd/a.png";
  await act(() => root.render(createElement(Composer, {
    ...props("PND", createRef()),
    saveImage: async () => path,
    discardFile: async (p: string) => { discarded.push(p); },
    loadImage: async () => SHOT,
    onSend: () => new Promise<boolean>((resolve) => { release = resolve; }),
  })));
  await pasteImages(1);
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click(); });
  await act(() => root.render(null));
  await act(async () => { release(true); });
  expect(discarded).toEqual([]);
});

test("a refused send keeps the files unsent, so unmounting discards them", async () => {
  await act(() => root.render(null));
  const discarded: string[] = [];
  const path = "/tmp/keryx-chat-images-ref/a.png";
  await act(() => root.render(createElement(Composer, {
    ...props("REF", createRef()),
    saveImage: async () => path,
    discardFile: async (p: string) => { discarded.push(p); },
    loadImage: async () => SHOT,
    onSend: () => false,
  })));
  await pasteImages(1);
  await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click(); });
  expect(host.querySelectorAll(".attach-chip").length).toBe(1);
  await act(() => root.render(null));
  expect(discarded).toEqual([path]);
});

test("pasting a screenshot saves it and sends an image-only draft", async () => {
  const saved: string[] = [];
  const sent: string[][] = [];
  const path = "/tmp/keryx-chat-images-123/photo.png";
  await act(() => root.render(createElement(Composer, {
    ...props("IMG", createRef()),
    saveImage: async (mime: string, data: string) => { saved.push(mime, data); return path; },
    loadImage: async () => "data:image/png;base64,iVBORw0KGgo=",
    onSend: (text: string, paths: readonly string[]) => { sent.push([text, ...paths]); return true; },
  })));
  const event = new Event("paste", { bubbles: true, cancelable: true });
  const file = new File([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)], "Clipboard.png", { type: "image/png" });
  Object.defineProperty(event, "clipboardData", { value: { files: [file], getData: () => "" } });
  await act(async () => { host.querySelector("textarea")?.dispatchEvent(event); });
  await waitFor(() => savingDone(host), act);
  expect(event.defaultPrevented).toBe(true);
  expect(saved).toEqual(["image/png", "iVBORw0KGgo="]);
  expect(host.querySelector(".attach-chip img")?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
  await act(() => host.querySelector<HTMLButtonElement>('[aria-label="Send"]')?.click());
  expect(sent).toEqual([["", path]]);
  expect(host.querySelector(".attach-chip img")).toBeNull();
});

test("attached elements show as removable chips and can be sent without text", async () => {
  const ref = createRef<import("./Composer").ComposerHandle>();
  const sent: string[] = [];
  const removed: number[] = [];
  const attachments = [{ key: 4, label: 'button "Save"', title: "#save" }];
  await act(() =>
    root.render(
      createElement(Composer, {
        ...props("ATT", ref),
        attachments,
        onRemoveAttachment: (k: number) => void removed.push(k),
        onSend: (t: string) => (sent.push(t), true),
      }),
    ),
  );
  const chip = host.querySelector(".attach-chip")!;
  expect(chip.textContent).toContain('button "Save"');
  const send = host.querySelector<HTMLButtonElement>(".send-btn")!;
  expect(send.disabled).toBe(false);
  await act(async () => send.click());
  expect(sent).toEqual([""]);
  await act(async () => chip.querySelector<HTMLButtonElement>("button")!.click());
  expect(removed).toEqual([4]);

  await act(() => root.render(createElement(Composer, { ...props("ATT", ref), attachments: [] })));
  expect(host.querySelector(".attach-chip")).toBeNull();
  expect(host.querySelector<HTMLButtonElement>(".send-btn")!.disabled).toBe(true);
});
