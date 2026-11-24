import assert from "node:assert/strict";
import { registerDom, unregisterDom } from "./dom";

// AC9 and AC12 over the App wiring: "Create Flow" on a PR card (prefilled flow prompt in the bound session,
// the one new package offered as "Link Flow #<id> · <title>?" and linked only on Link, Dismiss and two packages link
// nothing, a press coalesced into an open in flight registers nothing), one open per PR at a time, a new
// session of the PR linked to the Flow its bound session works on, a session switch during an open leaving
// the shown composer alone, and the Issue card's session slot counting a session bound to the issue. Runs in
// its own process like app-navigation.fixture.tsx: the production backend caches its first host connection.
registerDom();
const { mockIPC, mockWindows, clearMocks } = await import("@tauri-apps/api/mocks");
const { emit } = await import("@tauri-apps/api/event");
const cwd = "/dev/work-row";
const pr = (number: number) => `https://github.com/org/project/pull/${number}`;
const subject = (kind: "pr" | "issue", number: number) =>
  ({ kind, repo: "org/project", number, url: `https://github.com/org/project/${kind === "pr" ? "pull" : "issues"}/${number}` });
let flowDirs = ["500-existing"];
const flagWrites: Array<{ sessionId: string; flow?: string; subject?: number }> = [];
const calls: string[] = [];
let created = 0;
/** While set, session/new answers only once it resolves: a press can land while an open is in flight. */
let newGate: Promise<void> | undefined;
/** Set: keryx refuses the next flow link with this reason (a held flags lock). */
let refuseFlowLink: string | undefined;
type Stored = { sessionId: string; cwd: string; title: string; updatedAt: string; _meta: { keryx: Record<string, unknown> } };
const stored = new Map<string, Stored>([
  ["pr12-session", { sessionId: "pr12-session", cwd, title: "Work on #12", updatedAt: "2026-11-20T00:00:03Z", _meta: { keryx: { subject: subject("pr", 12) } } }],
  ["pr13-session", { sessionId: "pr13-session", cwd, title: "Work on #13", updatedAt: "2026-11-20T00:00:02Z", _meta: { keryx: { subject: subject("pr", 13) } } }],
  ["issue5-session", { sessionId: "issue5-session", cwd, title: "Issue 5", updatedAt: "2026-11-20T00:00:01Z", _meta: { keryx: { subject: subject("issue", 5) } } }],
]);
const viewer = { login: "me", nodeId: "U_me", host: "github.com" };
const issue = (number: number) => ({
  ref: { host: "github.com", nodeId: "I_" + number, repositoryId: "RID", owner: "org", repo: "project", number, url: subject("issue", number).url },
  title: "Issue " + number, state: "open", author: "sam", assignees: [], labels: [], createdAt: "2026-11-01", updatedAt: "2026-11-02",
  work: { stage: "none" },
});
const card = (number: number, updatedAt: string) => ({ number, title: "PR " + number, url: pr(number), state: "open", draft: false, author: "author",
  assignees: [], reviewers: [], decision: null, ci: "passed", headSha: "a".repeat(40), baseSha: "b".repeat(40), updatedAt });

mockWindows("work-row");
mockIPC(async (cmd, args) => {
  switch (cmd) {
    case "window_initial_cwd": return cwd;
    case "settings_get": return { recentProjects: [] };
    case "projects_state": return [];
    case "flows_list": return flowDirs.map(dir => ({ id: dir.slice(0, 3), idValid: true, dir, title: "Flow " + dir, status: "initializing", prUrl: null }));
    case "acp_start": return { keryxPath: "/fixture/keryx" };
    case "version_check": return { ok: true };
    case "github_accounts": {
      const request = args as { action: string };
      if (request.action === "list") return { accounts: [{ login: "me", active: true }] };
      return { eligible: true, configured: true, login: "me" };
    }
    case "issues_request": {
      const { action } = args as { action: string };
      if (action === "list") return { viewer, items: [issue(5), issue(6)], nextCursor: null, incomplete: false };
      return { viewer };
    }
    case "acp_send": {
      const { method, id, params } = JSON.parse(String((args as { message: string }).message));
      calls.push(method);
      let result: unknown;
      if (method === "_keryx/session_flags") {
        const { sessionId, cwd: _cwd, ...change } = params as { sessionId: string; cwd: string; flow?: string; subject?: { number: number } };
        // Refused before it is recorded: nothing was written.
        if (change.flow && refuseFlowLink) {
          const reason = refuseFlowLink;
          refuseFlowLink = undefined;
          throw new Error(reason);
        }
        flagWrites.push({ sessionId, ...(change.flow ? { flow: change.flow } : {}), ...(change.subject ? { subject: change.subject.number } : {}) });
        const entry = stored.get(sessionId);
        // keryx stores a new session only after its first turn: until then it refuses the flags.
        if (!entry) throw new Error("no session " + sessionId);
        entry._meta.keryx = { ...entry._meta.keryx, ...change };
        result = entry._meta.keryx;
      } else {
        if (method === "session/new") await newGate;
        result = method === "initialize" ? { agentInfo: { version: "1.0.0" }, _meta: { keryx: { profile: "shell", liveSessions: true } } }
          : method === "session/new" ? { sessionId: "fresh-" + ++created }
          : method === "session/list" ? { sessions: [...stored.values()] } : { sessions: [] };
      }
      await emit("acp://message", JSON.stringify({ jsonrpc: "2.0", id, result }));
      return;
    }
    case "review_board":
      return { version: 1, repo: "org/project", repositories: ["org/project"], repositoryId: "RID", viewer: "me", fetchedAt: "2026-11-19T00:00:00Z",
        warnings: [], cards: [card(12, "2026-11-19T00:00:00Z"), card(13, "2026-11-18T00:00:00Z"), card(14, "2026-11-17T00:00:00Z"),
          card(15, "2026-11-16T00:00:00Z"), card(16, "2026-11-15T00:00:00Z")] };
    case "review_run": return { version: 1, runs: [] };
    case "review_watcher": return { version: 1, state: "disabled", events: [] };
    default: return null;
  }
}, { shouldMockEvents: true });

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { App } = await import("../App");
const { ToastProvider } = await import("../components/Toasts");
const { flowPrompt } = await import("../review/prWork");
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
/** Polls until `ok` holds, flushing React between polls; fails with `what` after `ms`. */
async function waitFor(what: string, ok: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for: ${what} (composer: ${JSON.stringify(shownComposer()?.value)}, title: ${host.querySelector(".titlebar")?.textContent}, last calls: ${calls.slice(-6).join(", ")})`);
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}
async function go(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("main nav button")].find(b => b.textContent?.startsWith(label));
  assert.ok(button, "Missing project view " + label);
  await React.act(() => button.click());
  await waitFor(label + " is the current view", () => button.getAttribute("aria-current") === "page");
}
function findButton(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.getAttribute("aria-label") === label || b.textContent?.trim() === label);
}
function namedButton(label: string) {
  const button = findButton(label);
  assert.ok(button, "Missing button " + label);
  return button;
}
const shownComposer = () => [...host.querySelectorAll<HTMLTextAreaElement>("textarea")].find(t => !t.closest("[hidden]"));
/** The slot's first element: its link or action, or the text of a Flow offer. */
const slot = (number: number, name: string) => host.querySelector(`[aria-label="Keryx work for #${number}"] [data-slot="${name}"] > *`)?.textContent;
/** How an offer names the package: its number and title ("Flow #506 · Flow 506-for-twelve"). */
const offerName = (dir: string) => `Flow #${dir.slice(0, 3)} · Flow ${dir}`;
/** The Flow slot offers `dir` with its Link and Dismiss buttons. */
const offers = (number: number, dir: string) => slot(number, "flow") === `Link ${offerName(dir)}?`
  && !!findButton(`Link ${offerName(dir)} for #${number}`) && !!findButton(`Dismiss ${offerName(dir)} for #${number}`);
const newSessions = () => calls.filter(method => method === "session/new").length;
const flowWrites = () => flagWrites.filter(write => write.flow);
/** The flow list changes on disk; the window's focus re-reads it. Resolves once the Flows board lists every dir. */
async function packagesAppear(...dirs: string[]) {
  flowDirs = [...flowDirs, ...dirs];
  await React.act(async () => { window.dispatchEvent(new Event("focus")); });
  await go("Flows");
  await waitFor("the Flows board lists " + dirs.join(", "), () => dirs.every(dir => host.textContent?.includes("Flow " + dir)));
  await go("Pull requests");
}
/** Holds session/new until the returned release is called; the release lets React render the answer. */
function holdNewSessions() {
  let release!: () => void;
  newGate = new Promise(resolve => { release = resolve; });
  return () => React.act(async () => { newGate = undefined; release(); });
}
/** One animation frame: the composer fill App schedules runs before it. */
const nextFrame = () => React.act(async () => { await new Promise(resolve => requestAnimationFrame(() => resolve(undefined))); });

try {
  await React.act(async () => root.render(<ToastProvider><App /></ToastProvider>));
  await waitFor("the ACP session composer is ready", () => host.querySelector("textarea")?.disabled === false, 2500);

  // AC12: the Issue card's session slot counts the session bound to that issue through `subject`.
  await go("Issues");
  const issueSlot = (number: number) => host.querySelector(`[aria-label="Keryx work for org/project#${number}"] [data-slot="session"] button`)?.textContent;
  await waitFor("the Issues board shows #5 and #6", () => issueSlot(5) !== undefined && issueSlot(6) !== undefined);
  assert.equal(issueSlot(5), "Session", "The session bound to issue #5 is counted on its card");
  assert.equal(issueSlot(6), "Open in session");

  // AC9: Create Flow on a PR with a bound session opens that session with the flow prompt, not sent.
  await go("Pull requests");
  await waitFor("the PR board shows #12", () => slot(12, "flow") !== undefined);
  assert.equal(slot(12, "flow"), "Create Flow");
  assert.equal(slot(12, "session"), "Session");
  const newBefore = newSessions();
  await React.act(() => namedButton("Create Flow for #12").click());
  await waitFor("#12's session composer holds the flow prompt", () => shownComposer()?.value === flowPrompt(pr(12)));
  assert.equal(newSessions(), newBefore, "The bound session is reused");
  assert.ok(!calls.includes("session/prompt"), "The flow prompt is not sent");
  // The one package that then appears is offered on the card, not linked; Link writes it and it becomes the card's Flow.
  await packagesAppear("506-for-twelve");
  await waitFor("#12 offers Flow #506", () => offers(12, "506-for-twelve"));
  assert.deepEqual(flowWrites(), [], "Nothing is linked before Link");
  await React.act(() => namedButton(`Link ${offerName("506-for-twelve")} for #12`).click());
  await waitFor("#12 shows the linked Flow", () => slot(12, "flow") === "Flow #506 · Initializing");
  assert.deepEqual(flowWrites(), [{ sessionId: "pr12-session", flow: "506-for-twelve" }]);

  // Dismiss: the offer goes away and nothing is written.
  await React.act(() => namedButton("Create Flow for #13").click());
  await waitFor("#13's session composer holds the flow prompt", () => shownComposer()?.value === flowPrompt(pr(13)));
  await go("Pull requests");
  await packagesAppear("507-for-thirteen");
  await waitFor("#13 offers Flow #507", () => offers(13, "507-for-thirteen"));
  // A Link that keryx refuses keeps the offer and says why; Link stays to be pressed again.
  refuseFlowLink = "the flags of session pr13-session are locked by another keryx process; retry";
  await React.act(() => namedButton(`Link ${offerName("507-for-thirteen")} for #13`).click());
  await waitFor("#13 says the link failed", () => /^Not linked: .*locked by another keryx process/.test(slot(13, "flow") ?? ""));
  assert.ok(findButton(`Link ${offerName("507-for-thirteen")} for #13`), "Link is still offered");
  await React.act(() => namedButton(`Dismiss ${offerName("507-for-thirteen")} for #13`).click());
  await waitFor("#13's offer is gone", () => slot(13, "flow") === "Create Flow");
  assert.deepEqual(flowWrites(), [{ sessionId: "pr12-session", flow: "506-for-twelve" }], "Dismiss links nothing");

  // Two packages appearing for one request: none is offered or linked.
  await React.act(() => namedButton("Create Flow for #13").click());
  await waitFor("#13's session composer holds the flow prompt", () => shownComposer()?.value === flowPrompt(pr(13)));
  await go("Pull requests");
  await packagesAppear("508-a", "509-b");
  assert.equal(slot(13, "flow"), "Create Flow", "Two new packages: no offer");
  assert.deepEqual(flowWrites(), [{ sessionId: "pr12-session", flow: "506-for-twelve" }], "Nothing more is linked");

  // One open per PR at a time: a second press while session/new is in flight starts no second session.
  let release = holdNewSessions();
  const beforeDouble = newSessions();
  await React.act(() => namedButton("Open in session for #14").click());
  await go("Pull requests");
  await React.act(() => namedButton("Open in session for #14").click());
  await release();
  await waitFor("#14's new session holds its URL", () => shownComposer()?.value === pr(14));
  await waitFor("#14's new session is bound", () => flagWrites.some(write => write.subject === 14));
  assert.equal(newSessions(), beforeDouble + 1, "Two presses in flight open one session");

  // Open in session, then Create Flow before session/new answers: the press joins the open, its flow prompt
  // is never filled, so it registers no request and the package that then appears is not offered.
  await go("Pull requests");
  release = holdNewSessions();
  await React.act(() => namedButton("Open in session for #15").click());
  await go("Pull requests");
  await React.act(() => namedButton("Create Flow for #15").click());
  await release();
  await waitFor("#15's new session holds its URL", () => shownComposer()?.value === pr(15));
  await go("Pull requests");
  await packagesAppear("510-c");
  assert.equal(slot(15, "flow"), "Create Flow", "A coalesced press registered no request");
  assert.deepEqual(flowWrites(), [{ sessionId: "pr12-session", flow: "506-for-twelve" }]);

  // A new session of a PR whose bound session works on a Flow is linked to that Flow.
  await React.act(() => namedButton("More sessions for #12").click());
  const menuNew = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "New session");
  assert.ok(menuNew, "The session menu offers New session");
  const beforeMenu = newSessions();
  await React.act(() => menuNew.click());
  await waitFor("#12's new session is linked to Flow #506", () => flowWrites().some(write => write.sessionId !== "pr12-session" && write.flow === "506-for-twelve"));
  assert.equal(newSessions(), beforeMenu + 1);

  // A switch to another session while a new one opens: the new session is bound, the shown composer keeps its draft.
  await go("Pull requests");
  release = holdNewSessions();
  await React.act(() => namedButton("Open in session for #16").click());
  await go("Pull requests");
  await React.act(() => namedButton("2 sessions for #12").click());
  await waitFor("#12's session is shown", () => host.querySelector(".titlebar")?.textContent?.includes("PR org/project#12") === true);
  const draft = shownComposer()?.value;
  await release();
  await waitFor("#16's new session is bound", () => flagWrites.some(write => write.subject === 16));
  await nextFrame();
  assert.equal(shownComposer()?.value, draft, "The shown session's draft is not replaced by #16's URL");
  assert.ok(host.querySelector(".titlebar")?.textContent?.includes("PR org/project#12"), "The session the user switched to stays shown");
} finally {
  await React.act(() => root.unmount());
  clearMocks();
  await unregisterDom();
}
