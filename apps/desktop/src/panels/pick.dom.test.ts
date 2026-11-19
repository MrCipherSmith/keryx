// The browser panel's element picker script (`src-tauri/src/pick.js`), run in happy-dom the way
// WebKit's `callAsyncJavaScript` runs it: as the body of an async function.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { registerDom, unregisterDom } from "../test/dom";

let PICK_JS = "";

beforeAll(async () => {
  // happy-dom cannot make trusted events; the picker's own test switch stands in for a real user.
  (globalThis as { __kxPickTrustAll?: boolean }).__kxPickTrustAll = true;
  // The host embeds this file with include_str!; read it as text, the same bytes.
  const script: string = "../../src-tauri/src/pick.js";
  PICK_JS = ((await import(script, { with: { type: "text" } })) as { default: string }).default;
  registerDom();
});
afterAll(async () => {
  await unregisterDom();
});

type Picked = Record<string, unknown> & { cancelled?: boolean };

/** Start the picker; the promise settles when the script answers. */
function startPick(): Promise<Picked> {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const run = new Function(`return (async () => {\n${PICK_JS}\n})();`) as () => Promise<string>;
  return run().then((s) => JSON.parse(s) as Picked);
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const trustAll = (on: boolean) => {
  (globalThis as { __kxPickTrustAll?: boolean }).__kxPickTrustAll = on;
};

test("events the page dispatches itself cannot pick or cancel", async () => {
  trustAll(false);
  document.body.innerHTML = `<button id="bait">Pick me</button>`;
  let settled = false;
  const picked = startPick().then((r) => ((settled = true), r));
  await flush();
  const bait = document.getElementById("bait")!;
  bait.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  await flush();
  expect(settled).toBe(false);
  (globalThis as unknown as { __kxPick: { cancel(): void } }).__kxPick.cancel();
  expect(await picked).toEqual({ cancelled: true });
  trustAll(true);
});

test("clicking an element answers with its description, and the page never sees the click", async () => {
  document.body.innerHTML = `
    <main>
      <form>
        <label for="mail">Email</label><input id="mail" name="mail" placeholder="you@example.com">
        <button type="submit" class="btn primary" data-testid="save">Save   changes</button>
        <button type="button" class="btn">Cancel</button>
      </form>
    </main>`;
  let pageSaw = 0;
  document.querySelector("form")!.addEventListener("click", () => pageSaw++);
  const picked = startPick();
  await flush();
  expect(document.querySelector("keryx-picker")).not.toBeNull();

  const save = document.querySelector<HTMLButtonElement>("[data-testid=save]")!;
  save.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, composed: true }));
  save.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
  const r = await picked;

  expect(pageSaw).toBe(0);
  expect(r.tag).toBe("button");
  expect(r.selector).toBe('[data-testid="save"]');
  expect(r.role).toBe("button");
  expect(r.name).toBe("Save changes");
  expect((r.attributes as Record<string, string>).class).toBe("btn primary");
  expect(String(r.html)).toContain("<button");
  expect(r.url).toBe(location.href);
  expect(typeof r.rect).toBe("object");
  expect(typeof r.viewport).toBe("object");
  // The overlay and the crosshair style are gone once it answers.
  expect(document.querySelector("keryx-picker")).toBeNull();
  expect((globalThis as { __kxPick?: unknown }).__kxPick).toBeUndefined();
});

test("selectors fall back to a unique path when there is no id or test id", async () => {
  document.body.innerHTML = `<ul><li>a</li><li><span>b</span></li><li>c</li></ul>`;
  const picked = startPick();
  await flush();
  const span = document.querySelector("li:nth-of-type(2) span")!;
  span.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
  const r = await picked;
  expect(document.querySelectorAll(String(r.selector))).toHaveLength(1);
  expect(document.querySelector(String(r.selector))).toBe(span);
});

test("Escape cancels, and so does a second picker or __kxPick.cancel()", async () => {
  document.body.innerHTML = `<p>hello</p>`;
  const first = startPick();
  await flush();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(await first).toEqual({ cancelled: true });

  const second = startPick();
  await flush();
  const third = startPick();
  expect(await second).toEqual({ cancelled: true });
  await flush();
  (globalThis as unknown as { __kxPick: { cancel(): void } }).__kxPick.cancel();
  expect(await third).toEqual({ cancelled: true });
  expect(document.querySelectorAll("keryx-picker")).toHaveLength(0);
});

test("a password field's value never leaves the page", async () => {
  document.body.innerHTML = `<form id="login"><input type="password" value="hunter2"><button>Go</button></form>`;
  const picked = startPick();
  await flush();
  document.getElementById("login")!.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
  const r = await picked;
  expect(r.selector).toBe("#login");
  expect(String(r.html)).not.toContain("hunter2");
  expect(String(r.text)).not.toContain("hunter2");
});

test("a React dev build's component name and source come along", async () => {
  document.body.innerHTML = `<div><button>Buy</button></div>`;
  const btn = document.querySelector("button")!;
  function BuyButton() {}
  const fiber = { type: "button", return: { type: BuyButton, _debugSource: { fileName: "/app/src/BuyButton.tsx", lineNumber: 12 }, return: null } };
  (btn as unknown as Record<string, unknown>)["__reactFiber$abc"] = fiber;
  const picked = startPick();
  await flush();
  btn.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
  const r = await picked;
  expect(r.components).toEqual([{ framework: "react", name: "BuyButton", file: "/app/src/BuyButton.tsx", line: 12 }]);
});
