import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { SessionSubject } from "../acp/types";
import { registerDom, unregisterDom } from "../test/dom";

let root: Root;
let host: HTMLElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let createElement: typeof import("react").createElement;
let SessionSubjectLinks: typeof import("./SessionSubjectLinks").SessionSubjectLinks;

beforeAll(async () => {
  registerDom();
  const React = await import("react");
  act = React.act as unknown as typeof act;
  createElement = React.createElement;
  ({ SessionSubjectLinks } = await import("./SessionSubjectLinks"));
  host = document.body.appendChild(document.createElement("div"));
  root = (await import("react-dom/client")).createRoot(host);
});
afterAll(async () => { await act(() => root.unmount()); await unregisterDom(); });

const pr: SessionSubject = { kind: "pr", repo: "org/repo", number: 101, url: "https://github.com/org/repo/pull/101" };

test("the session header links its Subject and Flow back to their cards", async () => {
  const opened: string[] = [];
  const render = (subject?: SessionSubject, flow?: { id: string; dir: string; title: string }) => act(async () => {
    root.render(createElement(SessionSubjectLinks, { subject, flow,
      onOpenSubject: value => opened.push(`${value.kind} ${value.number}`), onOpenFlow: dir => opened.push("flow " + dir) }));
  });
  await render();
  expect(host.textContent).toBe("");
  await render(pr, { id: "517", dir: "517-work", title: "Work" });
  const buttons = [...host.querySelectorAll("button")];
  expect(buttons.map(b => b.textContent)).toEqual(["PR org/repo#101", "Flow #517"]);
  for (const b of buttons) await act(async () => b.click());
  await render({ ...pr, kind: "issue", url: "https://github.com/org/repo/issues/101" });
  expect(host.textContent).toBe("Issue org/repo#101");
  await act(async () => host.querySelector("button")!.click());
  expect(opened).toEqual(["pr 101", "flow 517-work", "issue 101"]);
});
