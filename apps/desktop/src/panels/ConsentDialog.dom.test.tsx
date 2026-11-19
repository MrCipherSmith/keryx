import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import { registerDom, unregisterDom } from "../test/dom";
import type { ConsentRequest } from "../platform/panels";

// The host's consent events and answers, captured.
let ask: ((r: ConsentRequest) => void) | null = null;
let closed: ((id: number) => void) | null = null;
const answers: Array<[number, boolean, boolean]> = [];

const fakeHost = {
  onConsent: async (h: (r: ConsentRequest) => void) => ((ask = h), () => {}),
  onConsentClosed: async (h: (id: number) => void) => ((closed = h), () => {}),
  browserConsentAnswer: async (id: number, allow: boolean, remember: boolean) => void answers.push([id, allow, remember]),
};

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  const client = await import("react-dom/client");
  act = React.act as unknown as typeof act;
  const { ConsentDialog } = await import("./ConsentDialog");
  host = document.createElement("div");
  document.body.append(host);
  root = client.createRoot(host);
  await act(() => root.render(React.createElement(ConsentDialog, { host: fakeHost })));
});

afterAll(async () => {
  await act(() => root.unmount());
  await unregisterDom();
});

const button = (label: string) => Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label)!;

test("a question names the site; each answer goes back once, then the next question shows", async () => {
  expect(document.body.textContent).not.toContain("Allow the agent");
  await act(async () => {
    ask!({ id: 1, action: "click", origin: "https://shop.example", url: "https://shop.example/cart" });
    ask!({ id: 2, action: "open", origin: "https://mail.example", url: "https://mail.example/" });
  });
  expect(document.body.textContent).toContain("https://shop.example");
  await act(async () => button("Allow once").click());
  expect(answers).toEqual([[1, true, false]]);
  expect(document.body.textContent).toContain("https://mail.example");
  await act(async () => button("Allow for this session").click());
  expect(answers).toEqual([[1, true, false], [2, true, true]]);
  expect(document.body.textContent).not.toContain("Allow the agent");
});

test("a refusal says no, and a question the host closed (timed out) disappears", async () => {
  await act(async () => ask!({ id: 3, action: "type into", origin: "https://bank.example", url: "https://bank.example/" }));
  await act(async () => button("Don't allow").click());
  expect(answers.at(-1)).toEqual([3, false, false]);

  await act(async () => ask!({ id: 4, action: "open", origin: "https://x.example", url: "https://x.example/" }));
  expect(document.body.textContent).toContain("https://x.example");
  await act(async () => closed!(4));
  expect(document.body.textContent).not.toContain("https://x.example");
  expect(answers.some(([id]) => id === 4)).toBe(false);
});
