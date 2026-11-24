import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Root } from "react-dom/client";
import type { IssueSummary } from "../../../../src/integrations/issues-contract";
import type { SessionInfo } from "../acp/types";
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
function render(read: Read, login = viewer.login, onWork: (action: string) => void = () => {}, sessions?: SessionInfo[]) {
  const request: typeof requestIssues = async <T,>(_cwd: string, account: string, action: IssuesAction, args: object) => (action === "viewer" ? { viewer: { ...viewer, login: account, nodeId: account === viewer.login ? viewer.nodeId : "U_b" } } : await read(account, action, args)) as T;
  return act(async () => { root.render(createElement(Board, { cwd: "/fixture", login, request,
    onSettings: () => {}, onWork: async action => onWork(action), ...(sessions ? { sessions } : {}) })); });
}
const account = "keryx.issues." + JSON.stringify([viewer.host, viewer.nodeId]);
const lanes = () => [...host.querySelectorAll(".issue-lanes .lane")].map(lane => lane.getAttribute("aria-label"));
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
  expect(host.querySelector('[aria-label="Open"] .flow-card')?.textContent).toContain("open");
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
  await click(button("Flow · Done for org/sample#3"));
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
  localStorage.setItem(account + ".source", "project");
  localStorage.setItem(account + ".project", JSON.stringify({owner: "demo", number: 18}));
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

test("AC11 busy session leaves its Flow openable and its unsent preparation retryable from board, list, and detail", async () => {
  let bound = false;
  let accepted = false;
  let requests = 0;
  const read = async (_login: string, action: IssuesAction) => {
    const row = { ...issue, work: { stage: bound ? "preparing" : "none", canResumePreparation: bound && !accepted } };
    if (action === "list") return page([row]);
    if (action === "detail") return { viewer, issue: { ...row, body: "The linked issue." } };
    return page([]);
  };
  await render(read, viewer.login, action => {
    expect(action).toBe("prepare-flow");
    requests++;
    if (!bound) { bound = true; throw new Error("The conversation is busy."); }
    accepted = true;
  });
  await click(button("Create Flow for org/sample#3"));
  expect(host.textContent).toContain("The conversation is busy.");
  const retrySelector = 'button[aria-label="Resume preparation for org/sample#3"]';
  expect(host.querySelector(".flow-card " + retrySelector)).not.toBeNull();
  expect(button("Flow · Preparing for org/sample#3")).not.toBeUndefined();
  await click(button("List"));
  expect(host.querySelector("tbody " + retrySelector)).not.toBeNull();
  await click(host.querySelector<HTMLButtonElement>("tbody .review-list-link")!);
  await click(host.querySelector<HTMLButtonElement>("aside " + retrySelector)!);
  expect(requests).toBe(2);
  expect(host.querySelector(retrySelector)).toBeNull();
});

test("AC11 source issue can resume the same package and removes the action after admission", async () => {
  const { IssueOriginDetail } = await import("./IssueOriginDetail");
  const origin = { flowDir: "007-existing-issue" };
  let accepted = false;
  const request: typeof requestIssues = async <T,>(_cwd: string, _account: string, action: IssuesAction) =>
    (action === "origin" ? { viewer, issue: { ...issue, body: "Linked issue",
      work: { stage:"preparing", canResumePreparation: !accepted } } } : page([])) as T;
  const operations: unknown[][] = [];
  await act(async () => { root.render(createElement(IssueOriginDetail, {
    cwd: "/fixture", login: viewer.login, origin, request, close: () => {},
    onWork: async (...args) => { operations.push(args); accepted = true; },
  })); });
  await click(button("Resume preparation"));
  expect(operations).toEqual([["prepare-flow", issue.ref, origin.flowDir]]);
  expect(host.textContent).not.toContain("Resume preparation");
  expect(button("Open Flow")).not.toBeUndefined();
});

test("AC3 switching viewer while opening a private issue invalidates the workspace and the admitted navigation", async () => {
  const { useLayoutEffect } = await import("react");
  const { useIssueWork } = await import("./IssueWork");
  const calls: IssuesAction[] = [];
  const opened: string[] = [];
  let delay: IssuesAction = "workspace";
  let release!: (value: unknown) => void;
  const workspace = { projects: [{ cwd: "/fixture" }], flows: [] };
  const request: typeof requestIssues = async <T,>(_cwd: string, _login: string, action: IssuesAction) => {
    calls.push(action);
    return (action === delay ? await new Promise<unknown>(resolve => { release = resolve; }) : workspace) as T;
  };
  function Host({login}: {login: string}) {
    const work = useIssueWork({
      cwd: "/fixture", ready: false, canPrepare: true, notifyError: () => {},
      showFlow: dir => opened.push(dir), showSession: async id => { opened.push(id); },
    }, request);
    useLayoutEffect(() => { work.setViewer(login); }, [work.setViewer, login]);
    return createElement("div", null, work.chooser, createElement("button", {
      onClick: () => { void work.run({ action: "prepare-flow", login, ref: issue.ref }); },
    }, "Prepare fixture"));
  }
  const selectViewer = (login: string) => act(() => root.render(createElement(Host, { login })));
  await selectViewer("alice");
  await click(button("Prepare fixture"));
  await selectViewer("bob");
  await selectViewer("alice");
  await act(async () => { release({projects:[{cwd:"/private/alice"},{cwd:"/private/checkout"}], flows:[]}); });
  expect(host.textContent).not.toContain("/private/alice");
  expect(calls).toEqual(["workspace"]);

  delay = "prepare-flow";
  await click(button("Prepare fixture"));
  expect(calls).toEqual(["workspace","workspace","prepare-flow"]);
  await selectViewer("bob");
  await act(async () => { release({ ...workspace, session:{sessionId:"private-session", project:{cwd:"/fixture"}} }); });
  expect(opened).toEqual([]);
});

test("AC4 discussion pages retain chronological order through an overlapping page and a retry", async () => {
  const cursors: (string | null)[] = [];
  const comment = (id: number, body = "Comment " + id) => ({
    id: String(id), author: "fixture-user", body, url: issue.ref.url + "#issuecomment-" + id,
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, id)).toISOString(),
  });
  const firstPage = Array.from({length: 40}, (_, index) => comment(index + 1));
  await render(async (_login, action, args) => {
    if (action === "list") return page([issue]);
    if (action === "detail") return {viewer, issue: {...issue, body: "The description comes first."}};
    if (action !== "comments") throw new Error("Unexpected " + action);
    const { cursor } = args as { cursor: string | null };
    cursors.push(cursor);
    if (cursor === null) return page(firstPage, "comments-page-two");
    if (cursors.length === 2) throw new Error("offline: connection interrupted");
    return page([comment(40, "Updated comment 40"), comment(41), comment(42)]);
  });
  await click(host.querySelector<HTMLButtonElement>(".flow-card-main")!);
  const bodies = () => Array.from(host.querySelectorAll("aside article .discussion-markdown"), el => el.textContent?.trim());
  expect(bodies()).toEqual(firstPage.map(c => c.body));
  expect(cursors).toEqual([null]);
  await click(button("Load more comments"));
  expect(host.textContent).toContain("connection interrupted");
  expect(bodies()).toEqual(firstPage.map(c => c.body));
  await click(button("Retry comments"));
  expect(cursors).toEqual([null, "comments-page-two", "comments-page-two"]);
  expect(bodies()).toEqual([...firstPage.slice(0, 39).map(c => c.body), "Updated comment 40", "Comment 41", "Comment 42"]);
  expect(host.textContent).not.toContain("Load more comments");
});

test("AC4 Escape from a narrow Board and List detail returns focus to the exact issue trigger", async () => {
  const proto = HTMLDivElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, "clientWidth");
  Object.defineProperty(proto, "clientWidth", {configurable: true, get: () => 440});
  try {
    const other = {...issue, ref: {...issue.ref, nodeId:"I_b", number:4, url:issue.ref.url.replace(/3$/, "4")}, title:"Second ticket"};
    await render(async (_login, action, args) => {
      if (action === "list") return page([issue, other]);
      if (action === "comments") return page([]);
      const request = args as {ref: typeof issue.ref};
      return {viewer, issue:{...(request.ref.nodeId === other.ref.nodeId ? other : issue), body:"Fixture"}};
    });
    for (const layout of ["Board", "List"]) {
      await click(button(layout));
      const selector = layout === "Board" ? ".flow-card-main" : "tbody .review-list-link";
      const trigger = Array.from(host.querySelectorAll<HTMLButtonElement>(selector)).find(el => el.textContent?.includes(other.title))!;
      trigger.focus();
      await click(trigger);
      const dialog = host.querySelector<HTMLElement>('aside[role="dialog"][aria-modal="true"]')!;
      expect(dialog?.textContent).toContain(other.title);
      expect(host.querySelector<HTMLElement>(".issues-main")?.hidden).toBe(true);
      expect(dialog.contains(document.activeElement)).toBe(true);
      await act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", {key:"Escape", bubbles:true, cancelable:true}));
      });
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      expect(host.querySelector("aside")).toBeNull();
      expect(host.querySelector<HTMLElement>(".issues-main")?.hidden).toBe(false);
      expect(document.activeElement === trigger).toBe(true);
    }
  } finally {
    if (original) Object.defineProperty(proto, "clientWidth", original);
    else Reflect.deleteProperty(proto, "clientWidth");
  }
});

test("every action on an Issue card and list row has visible text", async () => {
  await render(async (_login, action) => {
    if (action === "list") return page([issue, {...issue, ref: {...issue.ref, nodeId: "I_b", number: 4, url: "https://github.com/org/sample/issues/4"},
      work: {stage: "none", canResumePreparation: true}}]);
    throw new Error("Unexpected " + action);
  });
  for (const mode of ["Board", "List"]) {
    await click(button(mode));
    const containers = [...host.querySelectorAll(mode === "Board" ? ".issue-lanes .flow-card" : ".issue-table tbody tr")];
    expect(containers.length).toBe(2);
    for (const container of containers) {
      const controls = [...container.querySelectorAll(".issue-work-row button, .card-actions button, .card-actions a")];
      expect(controls.length).toBeGreaterThan(1);
      for (const control of controls) expect(control.textContent?.trim()).not.toBe("");
    }
  }
  expect(button("Open in session for org/sample#3").textContent).toBe("Open in session");
  expect(button("Flow · Done for org/sample#3").textContent).toBe("Flow · Done");
  expect(button("Create Flow for org/sample#4").textContent).toBe("Create Flow");
  expect(button("Resume preparation for org/sample#4").textContent).toBe("Resume preparation");
});

const other = (number: number, patch: Partial<IssueSummary> = {}): IssueSummary => ({ ...issue, ...patch,
  ref: { ...issue.ref, nodeId: "I_" + number, number, url: "https://github.com/org/sample/issues/" + number } });

test("AC13 the project repository is the default source; the other sources stay selectable", async () => {
  const sources: unknown[] = [];
  await render(async (_login, action, args) => {
    if (action === "list") { sources.push((args as { source: string }).source); return page([issue]); }
    throw new Error("Unexpected " + action);
  });
  expect(sources).toEqual(["repository"]);
  const select = host.querySelector<HTMLSelectElement>('select[aria-label="Issue source"]')!;
  expect(select.value).toBe("repository");
  expect([...select.options].map(o => o.textContent)).toEqual(["Project repository", "Assigned to me", "Created by me", "Mentioned", "Subscribed", "GitHub Project"]);
  await act(async () => { select.value = "assigned"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(sources).toEqual(["repository", "assigned"]);
  expect(localStorage.getItem(account + ".source")).toBe("assigned");
});

test("AC13 a stored source preference wins over the project repository default", async () => {
  localStorage.setItem(account + ".source", "assigned");
  const sources: unknown[] = [];
  await render(async (_login, action, args) => {
    if (action === "list") { sources.push((args as { source: string }).source); return page([issue]); }
    throw new Error("Unexpected " + action);
  });
  expect(sources).toEqual(["assigned"]);
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Issue source"]')!.value).toBe("assigned");
});

test("AC11 issues without a Flow spread over Open and Closed; Closed appears only when the state filter includes it", async () => {
  const rows = [other(5, { work: { stage: "none" } }), other(6, { state: "closed", work: { stage: "none" } }), other(7, { work: { stage: "active" } })];
  const read: Read = async (_login, action, args) => {
    if (action !== "list") throw new Error("Unexpected " + action);
    const { state } = args as { state: string };
    return page(rows.filter(r => state === "all" || r.state === state));
  };
  await render(read);
  expect(lanes()).toEqual(["Open"]);
  expect(host.querySelectorAll('[aria-label="Open"] .flow-card')).toHaveLength(2);
  // The Flow stage is a link on the card, never a column.
  expect(host.querySelector('[aria-label="Open"] [data-slot="flow"] button')?.textContent).toBe("Create Flow");
  expect(button("Flow · In progress for org/sample#7").closest('[aria-label="Open"]')).not.toBeNull();

  await act(() => root.render(null));
  localStorage.setItem(account + ".filters." + JSON.stringify(["repository", null]), JSON.stringify({ filters: { state: "all" }, list: false }));
  await render(read);
  expect(lanes()).toEqual(["Open", "Closed"]);
  expect(host.querySelector('[aria-label="Closed"] .flow-card')?.textContent).toContain("org/sample#6");
  expect(host.querySelectorAll('[aria-label="Open"] .flow-card')).toHaveLength(2);
});

test("AC11 the Flow stage filter is gone and a stored stage preference is ignored", async () => {
  localStorage.setItem(account + ".filters." + JSON.stringify(["repository", null]), JSON.stringify({ filters: { stage: "done", label: "sync" }, list: false }));
  await render(async (_login, action) => {
    if (action === "list") return page([other(5, { work: { stage: "none" } })]);
    throw new Error("Unexpected " + action);
  });
  expect(host.textContent).toContain("org/sample#5");
  expect(host.querySelector('button[aria-label="Remove stage filter"]')).toBeNull();
  expect(host.querySelector('button[aria-label="Remove label filter"]')).not.toBeNull();
  await click(button("Filters (1)"));
  expect(host.textContent).not.toContain("Keryx stage");
  expect(host.textContent).not.toContain("All stages");
});

test("AC12 the work row has a Flow slot and a session slot counted from sessions bound through subject", async () => {
  const subject = (number: number, kind = "issue", repo = "Org/Sample") => ({ kind, repo, number, url: "https://github.com/org/sample/issues/" + number });
  const session = (id: string, keryx: Record<string, unknown>): SessionInfo =>
    ({ sessionId: id, cwd: "/fixture", updatedAt: "2026-11-0" + id, _meta: { keryx } }) as SessionInfo;
  const sessions = [
    session("1", { subject: subject(5) }), session("2", { subject: subject(5) }),
    session("3", { subject: subject(5), archivedAt: "2026-11-04" }), session("4", { subject: subject(5, "pr") }),
    session("5", { subject: subject(6) }), session("6", { flow: "001-unrelated" }),
  ];
  const work: string[] = [];
  await render(async (_login, action) => {
    if (action === "list") return page([other(5, { work: { stage: "needs_answer" } }), other(6, { work: { stage: "none" } }), other(7)]);
    throw new Error("Unexpected " + action);
  }, viewer.login, a => work.push(a), sessions);
  const row = (n: number) => [...host.querySelectorAll<HTMLElement>(".issue-work-row")].find(r => r.getAttribute("aria-label") === "Keryx work for org/sample#" + n)!;
  const slots = (n: number) => [...row(n).querySelectorAll("[data-slot] button")].map(b => [b.closest("[data-slot]")!.getAttribute("data-slot"), b.textContent]);
  expect(slots(5)).toEqual([["flow", "Flow · Needs an answer"], ["session", "2 sessions"]]);
  expect(slots(6)).toEqual([["flow", "Create Flow"], ["session", "Session"]]);
  expect(slots(7)).toEqual([["flow", "Flow · Done"], ["session", "Open in session"]]);
  await click(button("2 sessions for org/sample#5"));
  await click(button("Create Flow for org/sample#6"));
  await click(button("Flow · Done for org/sample#7"));
  await click(button("Open in session for org/sample#7"));
  expect(work).toEqual(["open-session", "prepare-flow", "open-flow", "open-session"]);
  await click(button("List"));
  expect(host.querySelectorAll(".issue-table tbody .issue-work-row")).toHaveLength(3);
});

test("the Issue work row's two columns beat the PR row's three whatever order the stylesheets load in", () => {
  const css = readFileSync(new URL("./IssuesBoard.css", import.meta.url), "utf8");
  // Same specificity as `.pr-work-row` (styles/review.css, loaded later) would lose; both classes win.
  expect(css).toMatch(/(^|\n)\.pr-work-row\.issue-work-row \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  expect(css).not.toMatch(/(^|\n)\.issue-work-row \{/);
});

const hasButton = (label: string) => [...host.querySelectorAll("button")].some(b => b.textContent?.trim() === label);

test("AC13 an older keryx that refuses the default repository source offers Assigned to me and an update hint", async () => {
  const sources: string[] = [];
  await render(async (_login, action, args) => {
    if (action !== "list") throw new Error("Unexpected " + action);
    const { source } = args as { source: string };
    sources.push(source);
    if (source === "repository") throw new Error("configuration: Invalid Issues request.");
    return page([issue]);
  });
  const alert = host.querySelector('[role="alert"]')!;
  expect(alert.textContent).toContain("update keryx or choose the bundled CLI in Desktop Settings");
  // Retry would send the same refused request again.
  expect(hasButton("Retry")).toBe(false);
  await click(button("Show issues assigned to me"));
  expect(sources).toEqual(["repository", "assigned"]);
  expect(localStorage.getItem(account + ".source")).toBe("assigned");
  expect(host.querySelector<HTMLSelectElement>('select[aria-label="Issue source"]')!.value).toBe("assigned");
  expect(host.querySelector(".flow-card")?.textContent).toContain(issue.title);
});

test("AC13 a project with no GitHub.com remote, or a repository with Issues turned off, offers Assigned to me instead of Retry", async () => {
  for (const reason of [
    "configuration: This project has no GitHub.com fetch remote.",
    "configuration: GitHub has Issues turned off for fork-owner/sample. Choose another source, such as Assigned to me.",
  ]) {
    await act(() => root.render(null)); localStorage.clear();
    await render(async (_login, action, args) => {
      if (action !== "list") throw new Error("Unexpected " + action);
      if ((args as { source: string }).source === "repository") throw new Error(reason);
      return page([issue]);
    });
    const alert = host.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(reason);
    expect(alert.textContent).toContain("This project's repository issues are not available here.");
    expect(alert.textContent).not.toContain("bundled CLI");
    expect(hasButton("Retry")).toBe(false);
    await click(button("Show issues assigned to me"));
    expect(host.querySelector(".flow-card")?.textContent).toContain(issue.title);
  }
});

test("AC13 a repository source the person chose keeps Retry on a configuration error", async () => {
  localStorage.setItem(account + ".source", "repository");
  await render(async () => { throw new Error("configuration: This project has no GitHub.com fetch remote."); });
  expect(hasButton("Retry")).toBe(true);
  expect(hasButton("Show issues assigned to me")).toBe(false);
});

test("AC12 the work rows read the bound sessions from one index, not once per row", async () => {
  const reads = new Map<string, number>();
  const sessions = Array.from({ length: 5 }, (_, n) => {
    const id = String(n + 1);
    const meta = { keryx: { subject: { kind: "issue", repo: "org/sample", number: 5, url: "https://github.com/org/sample/issues/5" } } };
    return Object.defineProperty({ sessionId: id, cwd: "/fixture", updatedAt: "2026-11-0" + id }, "_meta", {
      get: () => { reads.set(id, (reads.get(id) ?? 0) + 1); return meta; },
    }) as SessionInfo;
  });
  const rows = Array.from({ length: 12 }, (_, n) => other(n + 5));
  await render(async (_login, action) => {
    if (action === "list") return page(rows);
    throw new Error("Unexpected " + action);
  }, viewer.login, () => {}, sessions);
  expect(button("5 sessions for org/sample#5")).not.toBeUndefined();
  // Read for the index, a few times at most across renders; never once per row (12 rows).
  expect(reads.size).toBe(5);
  for (const count of reads.values()) expect(rows.length).toBeGreaterThan(count);
});
