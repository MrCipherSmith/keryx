import assert from "node:assert/strict";
import { registerDom, unregisterDom } from "./dom";

// This fixture runs in its own process: the production backend caches its first host connection.
registerDom();
const { mockIPC, mockWindows, clearMocks } = await import("@tauri-apps/api/mocks");
const { emit } = await import("@tauri-apps/api/event");
const cwd = "/dev/project-navigation";
let offline = false;
const reads: string[] = [];
let account: string | null = null;
let connectedNewAccount = false;
mockWindows("project-navigation");
mockIPC(async (cmd, args) => {
  switch (cmd) {
    case "window_initial_cwd": return cwd;
    case "settings_get": return { recentProjects: [] };
    case "projects_state": case "flows_list": return [];
    case "acp_start": return { keryxPath: "/fixture/keryx" };
    case "version_check": return { ok: true };
    case "github_login": connectedNewAccount = true; return null;
    case "github_accounts": {
      const request = args as {action: string; cwd?: string; login?: string};
      if (request.action === "list") return { accounts: [
        { login: "me", active: !connectedNewAccount }, { login: "second", active: false },
        ...(connectedNewAccount ? [{ login: "new-account", active: true }] : []),
      ] };
      assert.equal(request.cwd, cwd);
      if (request.action === "bind") account = request.login ?? null;
      return { eligible: true, configured: account !== null, login: account };
    }
    case "acp_send": {
      const { method, id } = JSON.parse(String((args as {message:string}).message));
      const result = method === "initialize" ? { agentInfo: { version: "1.0.0" }, _meta: { keryx: { profile: "shell", liveSessions: true } } }
        : method === "session/new" ? { sessionId: "nav-session" } : { sessions: [] };
      await emit("acp://message", JSON.stringify({ jsonrpc: "2.0", id, result }));
      return;
    }
    case "review_board":
      reads.push(String((args as {cwd:string}).cwd));
      if (offline) throw new Error("unavailable: connection lost");
      return { version: 1, repo:"org/project", repositories:["org/project"], repositoryId:"RID", viewer:account ?? "me", fetchedAt:"2026-11-19T00:00:00Z",
        warnings: [], cards: [{ number:12,title:"Navigation proof",state:"open",draft:false,author:"author",assignees:[],reviewers:[],decision:null,ci:"passed",headSha:"h",baseSha:"b",updatedAt:"2026-11-19T00:00:00Z" }] };
    case "review_watcher": return { version: 1, state:"disabled", events:[] };
    default: return null;
  }
}, { shouldMockEvents:true });

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { App } = await import("../App");
const { ToastProvider } = await import("../components/Toasts");
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
async function go(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("main nav button")].find(b => b.textContent?.startsWith(label));
  assert.ok(button, "Missing project view " + label);
  await React.act(() => button.click());
}
function namedButton(label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.getAttribute("aria-label") === label || b.textContent?.trim() === label);
  assert.ok(button, "Missing button " + label);
  return button;
}

async function chooseAccount(login: string) {
  const picker = host.querySelector<HTMLSelectElement>('[role="dialog"] select');
  assert.ok(picker);
  assert.deepEqual([...picker.options].map(option => option.value), ["", "me", "second", "new-account"]);
  await React.act(() => {
    picker.value = login;
    picker.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await React.act(() => namedButton("Use account").click());
  assert.equal(account, login);
}
try {
  await React.act(async () => root.render(<ToastProvider><App /></ToastProvider>));
  const deadline = Date.now() + 2500;
  while (host.querySelector("textarea")?.disabled !== false && Date.now() < deadline) {
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
  const composer = host.querySelector<HTMLTextAreaElement>("textarea");
  assert.ok(composer && !composer.disabled, "ACP session composer is ready");
  assert.ok(host.textContent?.includes("Choose a GitHub account"));
  await React.act(() => namedButton("Manage GitHub accounts").click());
  assert.equal(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent, "Integrations");
  await React.act(() => namedButton("Connect account").click());
  assert.ok(connectedNewAccount && host.textContent?.includes("@new-account"));
  await React.act(() => namedButton("Close Settings").click());
  await chooseAccount("me");
  await React.act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer, "Keep this unsent draft");
    composer.dispatchEvent(new Event("input", { bubbles:true }));
  });
  await go("Review");
  assert.ok(host.textContent?.includes("Navigation proof"));
  assert.ok(composer.closest("[hidden]"));
  await React.act(() => namedButton("Settings").click());
  assert.equal(host.querySelector('main .project-views'), null);
  await React.act(() => namedButton("Close Settings").click());
  assert.equal(host.querySelector('main nav button[aria-current="page"]')?.textContent, "Review");
  assert.deepEqual(reads, [cwd]);
  await go("Flows");
  offline = true;
  await go("Review");
  assert.ok(host.textContent?.includes("Last available snapshot"));
  assert.ok(host.textContent?.includes("Navigation proof"));
  assert.deepEqual(reads, [cwd, cwd]);
  await go("Sessions");
  const current = host.querySelector<HTMLTextAreaElement>("textarea");
  assert.ok(current && !current.disabled);
  assert.equal(current.closest("[hidden]"), null);
  assert.equal(current.value, "Keep this unsent draft");
  await React.act(() => host.querySelector<HTMLButtonElement>(".project-switcher")!.click());
  const projectSettings = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === "Project Settings");
  assert.ok(projectSettings);
  await React.act(() => projectSettings.click());
  await chooseAccount("second");
} finally {
  await React.act(() => root.unmount());
  clearMocks();
  await unregisterDom();
}
