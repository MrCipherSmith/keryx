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

test("PR references open externally on click and offer the internal browser on right-click", async () => {
  const opened: string[][] = [];
  await act(() => root.render(createElement(Markdown, {
    text: "Published in PR #9130. `PR #12` is code. [other PR](https://github.com/other/repo/pull/8).",
    prLinks: {
      repository: "example/project",
      openExternal: (url: string) => { opened.push(["external", url]); },
      openInternal: (url: string) => { opened.push(["internal", url]); },
    },
  })));
  const links = Array.from(host.querySelectorAll<HTMLAnchorElement>(".md a"));
  expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
    ["PR #9130", "https://github.com/example/project/pull/9130"],
    ["other PR", "https://github.com/other/repo/pull/8"],
  ]);
  const link = links[0];
  await act(() => link?.click());
  expect(opened).toEqual([["external", "https://github.com/example/project/pull/9130"]]);
  const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  await act(() => { link?.dispatchEvent(menu); });
  expect(menu.defaultPrevented).toBe(true);
  const internal = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'))
    .find((b) => b.textContent?.includes("Open in Keryx Browser"));
  await act(() => internal?.click());
  expect(opened.at(-1)).toEqual(["internal", "https://github.com/example/project/pull/9130"]);
});

test("without a repository only explicit GitHub PR links can open", async () => {
  const opened: string[] = [];
  await act(() => root.render(createElement(Markdown, {
    text: "Bare PR #5. [real PR](https://github.com/owner/repo/pull/6) and [other](https://github.com.example/owner/repo/pull/7).",
    prLinks: { openExternal: (url: string) => { opened.push(url); } },
  })));
  const md = host.querySelector(".md");
  expect(md?.textContent).toContain("Bare PR #5.");
  const links = Array.from(md?.querySelectorAll<HTMLAnchorElement>("a") ?? []);
  expect(links.map((a) => a.textContent)).toEqual(["real PR", "other"]);
  for (const link of links) {
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(() => { link.dispatchEvent(click); });
    expect(click.defaultPrevented).toBe(true);
  }
  expect(opened).toEqual(["https://github.com/owner/repo/pull/6"]);
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

test("a fenced block in a known language is highlighted; its text and Copy stay the source", async () => {
  await act(() => root.render(createElement(Markdown, { text: "lead-in\n\n```ts\nconst a: number = 1; // one\n```" })));
  const code = host.querySelector(".code-block pre code");
  expect(code?.classList.contains("hljs")).toBe(true);
  expect(code?.querySelector(".hljs-keyword")?.textContent).toBe("const");
  expect(code?.querySelector(".hljs-comment")?.textContent).toBe("// one");
  expect(code?.textContent).toBe("const a: number = 1; // one\n");
});

test("source that looks like markup is escaped by the highlighter, never parsed", async () => {
  await act(() => root.render(createElement(Markdown, { text: "lead-in\n\n```html\n<img src=x onerror=alert(1)>\n```" })));
  expect(host.querySelector(".code-block img")).toBeNull();
  expect(host.querySelector(".code-block code")?.textContent).toContain("<img src=x onerror=alert(1)>");
});

test("a diff fence shows coloured lines with counts, and Copy writes the patch as it was", async () => {
  const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n";
  const written: string[] = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (t: string) => (written.push(t), Promise.resolve()) },
  });
  await act(() => root.render(createElement(Markdown, { text: "lead-in\n\n```diff\n" + patch + "```" })));
  const block = host.querySelector(".code-block.is-diff");
  expect(block).not.toBeNull();
  const kinds = Array.from(block!.querySelectorAll(".diff-line")).map((l) => l.className.replace("diff-line diff-", ""));
  expect(kinds).toEqual(["meta", "meta", "hunk", "ctx", "del", "add"]);
  expect(block!.querySelector(".diff-stat.add")?.textContent).toBe("+1");
  expect(block!.querySelector(".diff-stat.del")?.textContent).toBe("\u22121");
  await act(async () => {
    block!.querySelector<HTMLButtonElement>("button.code-copy")!.click();
  });
  expect(written).toEqual([patch]);
});

test("an unlabelled fence holding a unified diff is shown as one", async () => {
  await act(() => root.render(createElement(Markdown, { text: "lead-in\n\n```\n@@ -1 +1 @@\n-a\n+b\n```" })));
  expect(host.querySelector(".code-block.is-diff .code-lang")?.textContent).toBe("diff");
});
