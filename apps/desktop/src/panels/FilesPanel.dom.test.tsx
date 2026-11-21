import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";
import type { FilesApi } from "./FilesPanel";

// The panel takes its host calls as a prop, so no module mock is needed (those hold for the whole run).
let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let React: typeof import("react");
let FilesPanel: typeof import("./FilesPanel").FilesPanel;

beforeAll(async () => {
  registerDom();
  React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  FilesPanel = (await import("./FilesPanel")).FilesPanel;
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

beforeEach(async () => {
  await act(() => root.render(null));
});

const tick = (ms = 0) => act(() => new Promise((r) => setTimeout(r, ms)));
const rowsText = () => Array.from(host.querySelectorAll(".files-row")).map((r) => r.textContent!.trim());
const row = (name: string) => Array.from(host.querySelectorAll<HTMLElement>(".files-row")).find((r) => r.textContent!.trim() === name)!;
const click = (el: Element) => act(async () => void (el as HTMLElement).dispatchEvent(new MouseEvent("click", { bubbles: true })));
const type = (value: string) =>
  act(async () => {
    const input = host.querySelector<HTMLInputElement>(".files-search input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

function api(over: Partial<FilesApi> = {}): FilesApi {
  return {
    list: async (_cwd, query) =>
      query ? { files: ["src/match.ts"], truncated: false } : { files: ["README.md", "src/a.ts", "src/lib/b.ts"], truncated: false },
    read: async (_cwd, path) => ({ path, text: `content of ${path}`, binary: false, size: 10 }),
    ...over,
  };
}

const mount = (a: FilesApi, props: { cwd?: string; visible?: boolean } = {}) =>
  act(() => root.render(React.createElement(FilesPanel, { cwd: props.cwd ?? "/p", visible: props.visible ?? true, api: a })));

test("loads when first visible and shows folders first, collapsed until clicked", async () => {
  const calls: Array<string | undefined> = [];
  const a = api({ list: async (_c, q) => (calls.push(q), { files: ["README.md", "src/a.ts"], truncated: false }) });
  await mount(a, { visible: false });
  await tick();
  expect(calls).toEqual([]);
  await mount(a, { visible: true });
  await tick();
  expect(calls).toEqual([undefined]);
  expect(rowsText()).toEqual(["src", "README.md"]);
  await click(row("src"));
  expect(rowsText()).toEqual(["src", "a.ts", "README.md"]);
  expect(row("src").getAttribute("aria-expanded")).toBe("true");
  await click(row("src"));
  expect(rowsText()).toEqual(["src", "README.md"]);
});

test("search debounces, lists flat results, and clearing it returns to the tree", async () => {
  const queries: Array<string | undefined> = [];
  const a = api({ list: async (_c, q) => (queries.push(q), q ? { files: ["src/match.ts"], truncated: false } : { files: ["README.md"], truncated: false }) });
  await mount(a);
  await tick();
  await type("mat");
  await tick(20);
  expect(queries).toEqual([undefined]); // still inside the debounce
  await tick(200);
  expect(queries).toEqual([undefined, "mat"]);
  expect(rowsText()).toEqual(["src/match.ts"]);
  await type("");
  expect(rowsText()).toEqual(["README.md"]);
});

test("opening a file shows its text; a binary file shows its size", async () => {
  const a = api({
    list: async () => ({ files: ["a.txt", "b.png"], truncated: false }),
    read: async (_c, path) => (path === "b.png" ? { path, text: null, binary: true, size: 2048 } : { path, text: "hello\nworld", binary: false, size: 11 }),
  });
  await mount(a);
  await tick();
  await click(row("a.txt"));
  await tick();
  expect(host.querySelector(".files-viewer-body")!.textContent).toBe("hello\nworld");
  await click(row("b.png"));
  await tick();
  expect(host.querySelector(".files-viewer")!.textContent).toContain("Binary file, 2048 bytes");
});

test("a long file is cut to 2000 lines with a note", async () => {
  const text = Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n");
  await mount(api({ list: async () => ({ files: ["big.txt"], truncated: false }), read: async (_c, path) => ({ path, text, binary: false, size: text.length }) }));
  await tick();
  await click(row("big.txt"));
  await tick();
  expect(host.querySelector(".files-viewer")!.textContent).toContain("Showing first 2000 lines");
  expect(host.querySelector(".files-viewer-body")!.textContent!.split("\n")).toHaveLength(2000);
});

test("a list error shows inline with Retry, and Retry loads the list", async () => {
  let fail = true;
  await mount(api({ list: async () => (fail ? Promise.reject("boom: no such folder") : { files: ["ok.ts"], truncated: false }) }));
  await tick();
  expect(host.querySelector(".files-error")!.textContent).toContain("boom: no such folder");
  fail = false;
  await click(Array.from(host.querySelectorAll("button")).find((b) => b.textContent === "Retry")!);
  await tick();
  expect(host.querySelector(".files-error")).toBeNull();
  expect(rowsText()).toEqual(["ok.ts"]);
});

test("a failed refresh keeps the last list", async () => {
  let calls = 0;
  await mount(api({ list: async () => (++calls === 1 ? { files: ["keep.ts"], truncated: false } : Promise.reject("later failure")) }));
  await tick();
  await act(() => void host.querySelector<HTMLInputElement>("input")!.focus());
  await type("x");
  await tick(250);
  await type("");
  expect(rowsText()).toEqual(["keep.ts"]);
});

test("a read error shows in the viewer, not the list", async () => {
  await mount(api({ list: async () => ({ files: ["a.txt"], truncated: false }), read: async () => Promise.reject("permission denied") }));
  await tick();
  await click(row("a.txt"));
  await tick();
  expect(host.querySelector(".files-viewer .files-error")!.textContent).toBe("permission denied");
  expect(rowsText()).toEqual(["a.txt"]);
});

test("a stale file read does not replace a newer one", async () => {
  const slow = deferred<{ path: string; text: string; binary: boolean; size: number }>();
  const a = api({
    list: async () => ({ files: ["slow.txt", "fast.txt"], truncated: false }),
    read: (_c, path) => (path === "slow.txt" ? slow.promise : Promise.resolve({ path, text: "fast body", binary: false, size: 9 })),
  });
  await mount(a);
  await tick();
  await click(row("slow.txt"));
  await click(row("fast.txt"));
  await tick();
  await act(async () => slow.resolve({ path: "slow.txt", text: "slow body", binary: false, size: 9 }));
  await tick();
  expect(host.querySelector(".files-viewer-body")!.textContent).toBe("fast body");
  expect(host.querySelector(".files-viewer-path")!.textContent).toBe("fast.txt");
});

test("a stale search response is dropped", async () => {
  const first = deferred<{ files: string[]; truncated: boolean }>();
  const a = api({
    list: (_c, q) => (q === "a" ? first.promise : q === "ab" ? Promise.resolve({ files: ["ab.ts"], truncated: false }) : Promise.resolve({ files: ["x"], truncated: false })),
  });
  await mount(a);
  await tick();
  await type("a");
  await tick(200);
  await type("ab");
  await tick(200);
  await act(async () => first.resolve({ files: ["old.ts"], truncated: false }));
  await tick();
  expect(rowsText()).toEqual(["ab.ts"]);
});

test("a cwd change resets the panel; a response after unmount is ignored", async () => {
  const late = deferred<{ files: string[]; truncated: boolean }>();
  const a = api({ list: (cwd) => (cwd === "/late" ? late.promise : Promise.resolve({ files: [`${cwd.slice(1)}.ts`], truncated: false })) });
  await mount(a, { cwd: "/one" });
  await tick();
  expect(rowsText()).toEqual(["one.ts"]);
  await click(row("one.ts"));
  await mount(a, { cwd: "/two" });
  await tick();
  expect(rowsText()).toEqual(["two.ts"]);
  expect(host.querySelector(".files-viewer")).toBeNull();
  await mount(a, { cwd: "/late" });
  await act(() => root.render(null));
  await act(async () => late.resolve({ files: ["z.ts"], truncated: false }));
  await tick();
  expect(host.textContent).toBe("");
});
