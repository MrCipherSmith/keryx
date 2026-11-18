import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let Markdown: typeof import("./Markdown").Markdown;
let createElement: typeof import("react").createElement;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  Markdown = (await import("./Markdown")).Markdown;
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

test("a rendered code block shows the escape marker and Copy writes the raw text", async () => {
  const raw = "let a = 1;‮ // evil";
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (t: string) => (written.push(t), Promise.resolve()) },
  });

  // happy-dom quirk: DOMPurify drops the first top-level element it parses, so the block follows a lead-in paragraph.
  await act(() => root.render(createElement(Markdown, { text: "lead-in\n\n```js\n" + raw + "\n```" })));

  const code = host.querySelector(".code-block pre code");
  expect(code).not.toBeNull();
  expect(code!.textContent).toContain("⟨U+202E⟩");
  expect(code!.textContent).not.toContain("‮");

  const btn = host.querySelector<HTMLButtonElement>("button.code-copy");
  expect(btn).not.toBeNull();
  await act(async () => {
    btn!.click();
  });
  expect(written).toEqual([`${raw}\n`]);
});
