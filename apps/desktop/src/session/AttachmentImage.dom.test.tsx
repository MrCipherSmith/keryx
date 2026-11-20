import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let AttachmentImage: typeof import("./AttachmentImage").AttachmentImage;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  AttachmentImage = (await import("./AttachmentImage")).AttachmentImage;
  // happy-dom ships an observer that never fires; report every element as in view immediately.
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    constructor(private cb: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe() { this.cb([{ isIntersecting: true }]); }
    disconnect() {}
  };
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

type Load = (path: string) => Promise<string>;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const urlFor = (path: string) => `data:image/png;base64,${btoa(path)}`;

/** Poll (inside act so React flushes) until `cond` holds or `ms` elapse; returns the last verdict. */
async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await act(async () => { await sleep(10); });
  }
  return cond();
}

const mount = (paths: string[], load: Load) =>
  act(() => root.render(createElement("div", null, ...paths.map((path, i) =>
    createElement(AttachmentImage, { key: `${i}`, path, alt: `alt-${i}`, load })))));

const unmountAll = () => act(() => root.render(null));

test("40 mounted images all load, never more than 3 at once, none dropped", async () => {
  const paths = Array.from({ length: 40 }, (_, i) => `/tmp/limit-${i}.png`);
  const pending: Array<{ path: string; resolve: (url: string) => void }> = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  let started = 0;
  const load: Load = (path) => {
    started++;
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    return new Promise<string>((resolve) => {
      pending.push({ path, resolve });
    }).then((url) => { concurrent--; return url; });
  };
  await mount(paths, load);
  expect(pending.length).toBe(3);
  let resolvedCount = 0;
  const end = Date.now() + 4000;
  while (resolvedCount < paths.length && Date.now() < end) {
    const next = pending.shift();
    if (next) {
      await act(async () => { next.resolve(urlFor(next.path)); await sleep(0); });
      resolvedCount++;
    } else {
      await act(async () => { await sleep(5); });
    }
  }
  expect(resolvedCount).toBe(40);
  const done = await waitFor(() => host.querySelectorAll("img.sent-image").length === 40);
  expect(done).toBe(true);
  expect(started).toBe(40);
  expect(maxConcurrent <= 3).toBe(true);
  expect(host.textContent).not.toContain("Loading image…");
  await unmountAll();
});

test("a busy rejection is retried and then shows the image", async () => {
  const path = "/tmp/busy-retry.png";
  let calls = 0;
  const load: Load = async (p) => {
    calls++;
    if (calls === 1) throw new Error("busy: Chat attachments are busy; try again");
    return urlFor(p);
  };
  await mount([path], load);
  const shown = await waitFor(() => host.querySelector("img.sent-image") !== null, 3000);
  expect(shown).toBe(true);
  expect(calls).toBe(2);
  expect(host.querySelector("img.sent-image")?.getAttribute("src")).toBe(urlFor(path));
  expect(host.textContent).not.toContain("Image no longer available");
  await unmountAll();
});

test("a busy refusal as a plain string (Tauri) is retried and then shows the image", async () => {
  const path = "/tmp/busy-string.png";
  let calls = 0;
  const load: Load = async (p) => {
    calls++;
    if (calls === 1) throw "busy: Chat attachments are busy; try again";
    return urlFor(p);
  };
  await mount([path], load);
  expect(await waitFor(() => host.querySelector("img.sent-image") !== null, 3000)).toBe(true);
  expect(calls).toBe(2);
  expect(host.textContent).not.toContain("Image no longer available");
  await unmountAll();
});

test("a non-busy rejection shows 'Image no longer available'", async () => {
  let calls = 0;
  const load: Load = async () => { calls++; throw new Error("ENOENT: no such file"); };
  await mount(["/tmp/missing-file.png"], load);
  const failed = await waitFor(() => (host.textContent ?? "").includes("Image no longer available"));
  expect(failed).toBe(true);
  expect(calls).toBe(1);
  expect(host.querySelector("img.sent-image")).toBeNull();
  await unmountAll();
});

test("the same path rendered twice loads once (LRU hit)", async () => {
  const path = "/tmp/lru-same.png";
  const loaded: string[] = [];
  const load: Load = async (p) => { loaded.push(p); return urlFor(p); };
  await mount([path], load);
  expect(await waitFor(() => host.querySelectorAll("img.sent-image").length === 1)).toBe(true);
  await mount([path, path], load);
  expect(await waitFor(() => host.querySelectorAll("img.sent-image").length === 2)).toBe(true);
  expect(loaded).toEqual([path]);
  await unmountAll();
});
