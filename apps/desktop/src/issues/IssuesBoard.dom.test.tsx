import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { Root } from "react-dom/client";
import type { IssueSummary } from "../../../../src/integrations/issues-contract";
import type { IssuesAction, requestIssues } from "../platform/issues";
import { registerDom, unregisterDom } from "../test/dom";

let createElement: typeof import("react").createElement;
let act: (fn: () => void | Promise<void>) => Promise<void>;
let Board: typeof import("./IssuesBoard").IssuesBoard;
let root: Root;
let host: HTMLElement;
const viewer = { login: "fixture", nodeId: "U_a", host: "github.com" };
const issue: IssueSummary = {
  ref: { host: "github.com", nodeId: "I_a", repositoryId: "R_a", owner: "org", repo: "sample", number: 3, url: "https://github.com/org/sample/issues/3" },
  title: "Report the failing upload", state: "open", author: "sam", assignees: ["lee"], labels: ["sync"],
  createdAt: "2026-11-01", updatedAt: "2026-11-02", work: {stage: "done"},
};

beforeAll(async () => {
  registerDom();
  const react = await import("react");
  act = react.act as typeof act;
  createElement = react.createElement;
  Board = (await import("./IssuesBoard")).IssuesBoard;
  host = document.createElement("div"); document.body.append(host);
  root = (await import("react-dom/client")).createRoot(host);
});
beforeEach(async () => { await act(() => root.render(null)); localStorage.clear(); });
afterAll(async () => { await act(() => root.unmount()); await unregisterDom(); });

type Read = (login: string, action: IssuesAction, args: object) => Promise<unknown>;
function render(read: Read, login = viewer.login, onWork: (action: string) => void = () => {}) {
  const request: typeof requestIssues = async <T,>(_cwd: string, account: string, action: IssuesAction, args: object) => (action === "viewer" ? { viewer: { ...viewer, login: account, nodeId: account === viewer.login ? viewer.nodeId : "U_b" } } : await read(account, action, args)) as T;
  return act(async () => { root.render(createElement(Board, { cwd: "/fixture", login, request,
    onSettings: () => {}, onWork: async action => onWork(action) })); });
}
function button(label: string) {
  const result = [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === label || b.getAttribute("aria-label") === label);
  if (!result) throw new Error("Missing button: " + label);
  return result;
}
const click = (el: HTMLElement) => act(async () => { el.click(); });
const page = (items: unknown[], nextCursor: string | null = null) => ({viewer, items, nextCursor, incomplete: false});

test("board and list open one detail panel; comments load on demand and Flow state stays independent", async () => {
  const calls: IssuesAction[] = [];
  const work: string[] = [];
  await render(async (_login, action) => {
    calls.push(action);
    if (action === "list") return page([issue]);
    if (action === "detail") return {viewer, issue: {...issue, body: "See #42 and [README](docs/README.md)."}};
    if (action === "comments") return page([{id:"comment",author:"demo",body:"More context",createdAt:issue.createdAt,url:issue.ref.url}]);
    throw new Error("Unexpected " + action);
  }, viewer.login, a => work.push(a));
  expect(calls).toEqual(["list"]);
  expect(host.querySelector('[aria-label="Done"] .flow-card')?.textContent).toContain("open");
  await click(button("List"));
  expect(calls).toEqual(["list"]);
  const trigger = host.querySelector<HTMLButtonElement>("tbody button.review-list-link")!;
  await click(trigger);
  const detail = host.querySelector("aside")!;
  expect(calls).toEqual(["list", "detail", "comments"]);
  const content = detail.textContent ?? "";
  expect(content.includes("See") && content.indexOf("See") < content.indexOf("More context")).toBe(true);
  expect(detail.querySelector('a[href="https://github.com/org/sample/issues/42"]')).not.toBeNull();
  expect(detail.querySelector('a[href="https://github.com/org/sample/blob/HEAD/docs/README.md"]')).not.toBeNull();
  await click(button("Open Flow for org/sample#3"));
  expect(work).toEqual(["open-flow"]);
  await click(button("Close issue"));
  expect(host.querySelector("aside")).toBeNull();
});

test("late pages of a former account cannot repopulate its private rows; access loss clears detail", async () => {
  let release: (data: unknown) => void = () => {};
  await render(async () => new Promise(resolve => { release = resolve; }));
  const newViewer = { ...viewer, login: "other", nodeId: "U_b" };
  let revoked = false;
  await render(async (_login, action) => {
    if (revoked) throw new Error("access: Source unavailable");
    if (action === "detail") return {viewer:newViewer, issue:{...issue,body:"Sensitive discussion"}};
    return { ...page(action === "list" ? [issue] : []), viewer: newViewer };
  }, newViewer.login);
  await act(async () => { release(page([{...issue, title:"Previous private issue"}])); });
  expect(host.textContent).not.toContain("Previous private issue");
  await click(host.querySelector<HTMLButtonElement>(".flow-card-main")!);
  expect(host.textContent).toContain("Sensitive discussion");
  revoked = true;
  await click(button("Refresh"));
  expect(host.textContent).not.toContain(issue.title);
  expect(host.textContent).not.toContain("Sensitive discussion");
  expect(host.textContent).toContain("Source unavailable");
});

test("partial pages with zero issues need an explicit continuation; double pagination deduplicates records", async () => {
  let calls = 0;
  await render(async () => {
    calls++;
    return calls === 1 ? page([], "again") : page([issue, issue]);
  });
  expect(calls).toBe(1);
  expect(host.textContent).toContain("No matching issues on the loaded pages");
  await click(button("Load more issues"));
  expect(host.querySelectorAll(".flow-card")).toHaveLength(1);
});

test("AC6 remote Markdown links use the verified HTTPS repository and cannot create local commands", async () => {
  await render(async (_login, action) => {
    if (action === "list") return page([issue]);
    if (action === "detail") return { viewer, issue: { ...issue, body:
      'Read [the doc](guides/start.md) or [unsafe](file:///tmp/private.png). <button class="code-run">Run</button> <script>window.hacked=1</script>' } };
    return page([]);
  });
  await click(host.querySelector<HTMLButtonElement>(".flow-card-main")!);
  const markup = host.querySelector("aside .discussion-markdown")!;
  expect([...markup.querySelectorAll("a")].map(a => a.href)).toEqual(["https://github.com/org/sample/blob/HEAD/guides/start.md"]);
  expect(markup.querySelector("button, script, iframe, img")).toBeNull();
});

test("AC2 refreshing page one leaves a selected later-page issue open and revalidates its detail", async () => {
  const later = { ...issue, title: "Later page", ref: { ...issue.ref, nodeId: "I_b", number: 4, url: issue.ref.url.replace("/3","/4") } };
  let details = 0;
  await render(async (_login, action, args) => {
    if (action === "list") return "cursor" in args && args.cursor ? page([later]) : page([issue], "more");
    if (action === "detail") { details++; return { viewer, issue: {...later, body: "Still accessible"} }; }
    return page([]);
  });
  await click(button("Load more issues"));
  const laterCard = [...host.querySelectorAll<HTMLButtonElement>(".flow-card-main")].find(b => b.textContent?.includes("Later page"))!;
  await click(laterCard);
  await click(button("Refresh"));
  expect(host.querySelector("aside h2")?.textContent).toBe("Later page");
  expect(details).toBeGreaterThan(1);
});

test("AC14 keyboard Project Status control uses observed value and surfaces a conflicting move", async () => {
  const acc = 'keryx.issues.' + JSON.stringify([viewer.host, viewer.nodeId]);
  localStorage.setItem(acc + ".source", "project");
  localStorage.setItem(acc + ".project", JSON.stringify({owner: "demo", number: 18}));
  let moves = 0;
  await render(async (_login, action, args) => {
    if (action === "project") return { ...page([{ issue, itemId: "item", optionId: "todo" }]),
      project: {id:"p",number:18,owner:"demo",title:"Issues test project",fieldId:"status",canWrite:true,
        options: [{id:"todo",name:"Todo"},{id:"done",name:"Done"},{id:"review",name:"Review"}]} };
    if (action === "move") {
      moves++;
      expect(args).toMatchObject({projectId:"p",itemId:"item",issueNodeId:issue.ref.nodeId,expectedOptionId:"todo",optionId:"done"});
      return {viewer,itemId:"item",optionId:"review",outcome:"conflict"};
    }
    throw new Error("Unexpected " + action);
  });
  const select = host.querySelector<HTMLSelectElement>(".issue-move")!;
  await act(async () => { select.value = "done"; select.dispatchEvent(new Event("change", { bubbles:true })); });
  expect(moves).toBe(1);
  expect(host.querySelector('[aria-label="Review"] .flow-card')?.textContent).toContain(issue.title);
  expect(host.textContent).toContain("Another update changed this item to Review");
});
