import assert from "node:assert/strict";
import { registerDom, unregisterDom } from "./dom";

// AC9 and AC12 over the App wiring: "Create Flow" on a PR card (prefilled flow prompt in the bound session,
// the one new package linked to it and shown on the card, none linked when two appear) and the Issue
// card's session slot counting a session bound to the issue. Runs in its own process like
// app-navigation.fixture.tsx: the production backend caches its first host connection.
registerDom();
const { mockIPC, mockWindows, clearMocks } = await import("@tauri-apps/api/mocks");
const { emit } = await import("@tauri-apps/api/event");
const cwd = "/dev/work-row";
const pr = (number: number) => `https://github.com/org/project/pull/${number}`;
const subject = (kind: "pr" | "issue", number: number) =>
  ({ kind, repo: "org/project", number, url: `https://github.com/org/project/${kind === "pr" ? "pull" : "issues"}/${number}` });
let flowDirs = ["500-existing"];
const flagWrites: Array<{ sessionId: string; flow?: string }> = [];
const calls: string[] = [];
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
        const { sessionId, cwd: _cwd, ...change } = params as { sessionId: string; cwd: string; flow?: string };
        flagWrites.push({ sessionId, ...(change.flow ? { flow: change.flow } : {}) });
        const entry = stored.get(sessionId);
        if (!entry) throw new Error("no session " + sessionId);
        entry._meta.keryx = { ...entry._meta.keryx, ...change };
        result = entry._meta.keryx;
      } else {
        result = method === "initialize" ? { agentInfo: { version: "1.0.0" }, _meta: { keryx: { profile: "shell", liveSessions: true } } }
          : method === "session/new" ? { sessionId: "fresh-session" }
          : method === "session/list" ? { sessions: [...stored.values()] } : { sessions: [] };
      }
      await emit("acp://message", JSON.stringify({ jsonrpc: "2.0", id, result }));
      return;
    }
    case "review_board":
      return { version: 1, repo: "org/project", repositories: ["org/project"], repositoryId: "RID", viewer: "me", fetchedAt: "2026-11-19T00:00:00Z",
        warnings: [], cards: [card(12, "2026-11-19T00:00:00Z"), card(13, "2026-11-18T00:00:00Z")] };
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
const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
async function go(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("main nav button")].find(b => b.textContent?.startsWith(label));
  assert.ok(button, "Missing project view " + label);
  await React.act(() => button.click());
  await settle();
}
function namedButton(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.getAttribute("aria-label") === label || b.textContent?.trim() === label);
  assert.ok(button, "Missing button " + label);
  return button;
}
const shownComposer = () => [...host.querySelectorAll<HTMLTextAreaElement>("textarea")].find(t => !t.closest("[hidden]"));
const slot = (number: number, name: string) => host.querySelector(`[aria-label="Keryx work for #${number}"] [data-slot="${name}"] button`)?.textContent;
/** The flow list changes on disk; the window's focus re-reads it. */
async function packagesAppear(...dirs: string[]) {
  flowDirs = [...flowDirs, ...dirs];
  await React.act(async () => { window.dispatchEvent(new Event("focus")); });
  await settle();
  await settle();
}

try {
  await React.act(async () => root.render(<ToastProvider><App /></ToastProvider>));
  const deadline = Date.now() + 2500;
  while (host.querySelector("textarea")?.disabled !== false && Date.now() < deadline) {
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  assert.ok(host.querySelector("textarea") && !host.querySelector("textarea")!.disabled, "ACP session composer is ready");

  // AC12: the Issue card's session slot counts the session bound to that issue through `subject`.
  await go("Issues");
  const issueSlot = (number: number) => host.querySelector(`[aria-label="Keryx work for org/project#${number}"] [data-slot="session"] button`)?.textContent;
  assert.equal(issueSlot(5), "Session", "The session bound to issue #5 is counted on its card");
  assert.equal(issueSlot(6), "Open in session");

  // AC9: Create Flow on a PR with a bound session opens that session with the flow prompt, not sent.
  await go("Pull requests");
  assert.equal(slot(12, "flow"), "Create Flow");
  assert.equal(slot(12, "session"), "Session");
  const newBefore = calls.filter(method => method === "session/new").length;
  await React.act(() => namedButton("Create Flow for #12").click());
  await settle();
  assert.equal(calls.filter(method => method === "session/new").length, newBefore, "The bound session is reused");
  assert.equal(shownComposer()?.value, flowPrompt(pr(12)), "The bound session's composer holds the flow prompt");
  assert.ok(!calls.includes("session/prompt"), "The flow prompt is not sent");
  // The one package that then appears is linked to the session and shown as the card's Flow.
  await packagesAppear("506-for-twelve");
  assert.deepEqual(flagWrites.filter(write => write.flow), [{ sessionId: "pr12-session", flow: "506-for-twelve" }]);
  await go("Pull requests");
  assert.equal(slot(12, "flow"), "Flow #506 · Initializing", "The linked package is the card's Flow");

  // Two packages appearing for one request: none is linked.
  await React.act(() => namedButton("Create Flow for #13").click());
  await settle();
  assert.equal(shownComposer()?.value, flowPrompt(pr(13)));
  await packagesAppear("507-a", "508-b");
  assert.deepEqual(flagWrites.filter(write => write.flow), [{ sessionId: "pr12-session", flow: "506-for-twelve" }], "Nothing more is linked");
  await go("Pull requests");
  assert.equal(slot(13, "flow"), "Create Flow");
} finally {
  await React.act(() => root.unmount());
  clearMocks();
  await unregisterDom();
}
