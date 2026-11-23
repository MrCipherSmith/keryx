import assert from "node:assert/strict";
import { registerDom, unregisterDom } from "./dom";

// This fixture runs in its own process: the production backend caches its first host connection.
registerDom();
const { mockIPC, mockWindows, clearMocks } = await import("@tauri-apps/api/mocks");
const { emit } = await import("@tauri-apps/api/event");
const cwd = "/dev/project-navigation";
let offline = false;
const reads: string[] = [];
const starts: unknown[] = [];
const replies: unknown[] = [];
let refuseReply = true;
const calls: string[] = [];
const runId = "e968ba9b-c8a3-438f-a5c8-93625e427905";
const prUrl = "https://github.com/org/project/pull/12";
const question = (id: string, reviewer: string, text: string) => ({
  id, reviewer, question: text, options: [], allowFreeform: true,
});
let questions = [
  question("question-logic", "review-logic", "Which revision should I inspect?"),
  question("question-contract", "review-pr-contract", "Where is the backend contract?"),
];
const run = {
  id: runId, source: "manual", state: "running", phase: "Dispatching reviewers", reason: "",
  baseSha: "b".repeat(40), headSha: "a".repeat(40), createdAt: "2026-11-20T00:00:00Z",
  startedAt: "2026-11-20T00:00:01Z", finishedAt: null, result: null, coordinatorActivity: [{ kind: "status", text: "Wave 1 started" }],
};
let account: string | null = null;
let accountConfigured = false;
let connectedNewAccount = false;
let accountListReads = 0;
let accountListGate: Promise<void> | undefined;
let accountListError: string | undefined;
/** false: an older keryx that answers `_keryx/session_flags` without `subject`. */
let storesSubject = false;
let newSessions = 0;
const stored = new Map<string, { sessionId: string; cwd: string; title: string; updatedAt: string; _meta: { keryx: Record<string, unknown> } }>();
mockWindows("project-navigation");
mockIPC(async (cmd, args) => {
  switch (cmd) {
    case "window_initial_cwd": return cwd;
    case "settings_get": return { recentProjects: [] };
    case "projects_state": return [];
    case "flows_list": return [{ id: "505", idValid: true, dir: "505-review", title: "Review flow", prUrl }];
    case "pr_info": return { url: prUrl, number: 12 };
    case "acp_start": return { keryxPath: "/fixture/keryx" };
    case "version_check": return { ok: true };
    case "github_login": connectedNewAccount = true; return null;
    case "github_accounts": {
      const request = args as {action: string; cwd?: string; login?: string};
      if (request.action === "list") {
        accountListReads++;
        await accountListGate;
        if (accountListError) throw accountListError;
        return { accounts: [
          { login: "me", active: !connectedNewAccount }, { login: "second", active: false },
          ...(connectedNewAccount ? [{ login: "new-account", active: true }] : []),
        ] };
      }
      assert.equal(request.cwd, cwd);
      if (request.action === "bind") {
        account = request.login ?? null;
        accountConfigured = true;
      }
      return { eligible: true, configured: accountConfigured, login: account };
    }
    case "acp_send": {
      const { method, id, params } = JSON.parse(String((args as {message:string}).message));
      calls.push(method);
      let result: unknown;
      if (method === "_keryx/session_flags") {
        const { sessionId, subject } = params as { sessionId: string; subject?: Record<string, unknown> };
        const flags = storesSubject && subject ? { subject } : {};
        if (storesSubject) stored.set(sessionId, { sessionId, cwd, title: "PR session " + sessionId, updatedAt: new Date(Date.now() + stored.size).toISOString(), _meta: { keryx: flags } });
        result = flags;
      } else {
        result = method === "initialize" ? { agentInfo: { version: "1.0.0" }, _meta: { keryx: { profile: "shell", liveSessions: true } } }
          : method === "session/new" ? { sessionId: newSessions++ ? "nav-session-" + newSessions : "nav-session" }
          : method === "session/list" ? { sessions: [...stored.values()].reverse() } : { sessions: [] };
      }
      await emit("acp://message", JSON.stringify({ jsonrpc: "2.0", id, result }));
      return;
    }
    case "review_board":
      // The PR panel's detail read (the session header link opens it).
      if ((args as { number?: number }).number === 12) return { version: 1, viewer: account ?? "me", repositoryId: "RID", number: 12,
        headSha: run.headSha, fetchedAt: "2026-11-19T00:00:00Z", comments: [], reviews: [], threads: [], checks: [], warnings: [] };
      reads.push(String((args as {cwd:string}).cwd));
      if (offline) throw new Error("unavailable: connection lost");
      return { version: 1, repo:"org/project", repositories:["org/project"], repositoryId:"RID", viewer:account ?? "me", fetchedAt:"2026-11-19T00:00:00Z",
        warnings: [], cards: [{ number:12,title:"Navigation proof",url:prUrl,state:"open",draft:false,author:"author",assignees:[],reviewers:["me"],decision:null,ci:"passed",headSha:run.headSha,baseSha:run.baseSha,updatedAt:"2026-11-19T00:00:00Z" }] };
    case "review_run": {
      const { action, target } = args as { action: { kind: string; activityId?: string }; target: { number: number } };
      assert.equal(target.number, 12);
      if (action.kind === "start") {
        starts.push(action);
        return { version: 1, runs: [run], startedRunId: runId };
      }
      if (action.kind === "answer") {
        replies.push(action);
        if (refuseReply) {
          refuseReply = false;
          throw new Error("unavailable: Review reply could not be sent.");
        }
        questions = questions.filter(q => q.id !== (action as { questionId?: string }).questionId);
      }
      return { version: 1, runs: starts.length && (action.activityId === runId || action.kind === "answer")
        ? [{ ...run, pendingQuestions: questions }] : [] };
    }
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
  const beforeRefresh = accountListReads;
  let finishList!: () => void;
  accountListGate = new Promise(resolve => { finishList = resolve; });
  const refreshAccounts = namedButton("Refresh accounts");
  await React.act(() => {
    refreshAccounts.click();
    refreshAccounts.click();
  });
  assert.ok(refreshAccounts.disabled);
  await React.act(() => refreshAccounts.click());
  assert.equal(accountListReads, beforeRefresh + 1);
  await React.act(() => finishList());
  assert.equal(refreshAccounts.disabled, false);
  for (const message of [
    "Unknown command: accounts. Run `keryx review --help` for the list.",
    "unavailable: The selected Keryx CLI did not return a valid Review response. Check the CLI version in Settings.",
    "unavailable: The selected Keryx CLI did not return a valid Review response.",
  ]) {
    accountListError = message;
    await React.act(() => refreshAccounts.click());
    assert.ok(host.querySelector('[role="alert"]')?.textContent?.includes("choose Bundled keryx"));
    assert.ok(namedButton("Connect account").disabled);
  }
  accountListError = undefined;
  await React.act(() => refreshAccounts.click());
  await React.act(() => namedButton("Connect account").click());
  assert.ok(connectedNewAccount && host.textContent?.includes("@new-account"));
  await React.act(() => namedButton("Close Settings").click());
  await chooseAccount("me");
  assert.equal(host.querySelector(".usage-footer .project-github-account")?.textContent, "GitHub · @me");
  assert.ok(host.querySelector('.titlebar-right button[aria-label="Activity"]'));
  await React.act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(composer, "Keep this unsent draft");
    composer.dispatchEvent(new Event("input", { bubbles:true }));
  });
  // Review warms once for the active gh account and once after onboarding binds it.
  const accountReads = [cwd, cwd];
  assert.deepEqual(reads, accountReads);
  const reviewDot = () => host.querySelector("nav .review-tab-dot")?.getAttribute("data-indicator");
  assert.equal(reviewDot(), "attention", "Review requests reach the navigation on Sessions");
  await go("Pull requests");
  assert.equal(host.querySelector('.titlebar-right button[aria-label="Activity"]'), null);
  assert.ok(host.textContent?.includes("Navigation proof"));
  const browserLink = () => host.querySelector<HTMLAnchorElement>('a[aria-label="Open on GitHub: PR #12"]');
  assert.equal(browserLink()?.href, prUrl);
  await React.act(() => namedButton("List").click());
  assert.equal(browserLink()?.href, prUrl);
  assert.ok(namedButton("Open in session for #12"));
  await React.act(() => namedButton("Board").click());
  assert.ok(composer.closest("[hidden]"));
  await React.act(() => namedButton("Settings").click());
  assert.equal(host.querySelector('main .project-views'), null);
  await React.act(() => namedButton("Close Settings").click());
  assert.equal(host.querySelector('main nav button[aria-current="page"] .review-tab-dot')?.getAttribute("data-indicator"), "attention");
  await go("Flows");
  assert.equal(reviewDot(), "attention", "Flows keeps the project notice");
  offline = true;
  await go("Pull requests");
  assert.deepEqual(reads, accountReads);
  assert.ok(host.textContent?.includes("Navigation proof"));
  const refresh = host.querySelector<HTMLButtonElement>('button[aria-label="Refresh pull requests"]');
  assert.ok(refresh && !refresh.disabled);
  await React.act(() => refresh.click());
  assert.ok(host.textContent?.includes("Last available snapshot"));
  assert.ok(host.textContent?.includes("Navigation proof"));
  assert.deepEqual(reads, [...accountReads, cwd]);
  await go("Sessions");
  const current = host.querySelector<HTMLTextAreaElement>("textarea");
  assert.ok(current && !current.disabled);
  assert.equal(current.closest("[hidden]"), null);
  assert.equal(current.value, "Keep this unsent draft");
  offline = false;
  await React.act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(current, `Запусти адаптивное ревью ${prUrl} с review-orchestrator`);
    current.dispatchEvent(new Event("input", { bubbles:true }));
  });
  const send = host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!;
  await React.act(() => send.click());
  const dialog = host.querySelector('[role="dialog"]')!;
  assert.ok(dialog?.textContent?.includes("Run review"));
  assert.equal(dialog.querySelector<HTMLSelectElement>('select[aria-label="Pull request"]')!.value, "12");
  assert.equal(starts.length, 0, "Preparing a review never starts the detached worker");
  const apply = [...dialog.querySelectorAll("button")].find(button => button.textContent === "Apply");
  assert.ok(apply && !apply.disabled);
  await React.act(() => apply.click());
  assert.deepEqual(starts, [{ kind: "start", baseSha: run.baseSha, headSha: run.headSha,
    options: { mode: "auto", adaptive: true, maxParallel: 10, modelPools: { strong: [], middle: [], light: [] }, flowId: "505" } }]);
  assert.match(host.textContent ?? "", /2 questions are waiting for a reply/);
  assert.equal(host.querySelectorAll(".session-review-activity textarea").length, 0);
  assert.equal(current.placeholder, "Reply to review-logic");
  const contractReply = host.querySelector<HTMLButtonElement>('[aria-label="Respond to review-pr-contract"] button');
  assert.ok(contractReply);
  await React.act(() => contractReply.click());
  assert.equal(current.placeholder, "Reply to review-pr-contract");
  const note = "Read the pinned contract in the backend checkout.";
  await React.act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(current, note);
    current.dispatchEvent(new Event("input", { bubbles:true }));
  });
  await React.act(() => send.click());
  assert.equal(current.value, note, "A failed send keeps the draft for the same review question");
  assert.match(host.textContent ?? "", /Review reply could not be sent/);
  await React.act(() => send.click());
  const reply = { kind: "answer", id: runId, questionId: "question-contract", answer: note };
  assert.deepEqual(replies, [reply, reply]);
  assert.match(host.textContent ?? "", /1 question is waiting for a reply/);
  assert.ok([...host.querySelectorAll(".session-review-activity .turn-user")].some(row => row.textContent?.includes(note)));
  assert.equal(current.placeholder, "Reply to review-logic");
  assert.equal(current.value, "");
  assert.ok(!calls.includes("session/prompt"), "Review status is not submitted as a prompt");
  await go("Pull requests");
  // The review started from the session is the card's review link, without a manual refresh.
  assert.match(host.querySelector('[aria-label="Keryx work for #12"] [data-slot="review"]')?.textContent ?? "", /^Review · (running|needs your answer)$/);

  // "Open in session" with an older keryx: a new session opens, the PR URL waits in the composer, a notice says the binding was not saved.
  const shownComposer = () => [...host.querySelectorAll<HTMLTextAreaElement>("textarea")].find(t => !t.closest("[hidden]"));
  const settle = () => React.act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  const opened = () => calls.filter(method => method === "session/new").length;
  const firstOpen = opened();
  await React.act(() => namedButton("Open in session for #12").click());
  await settle();
  assert.equal(opened(), firstOpen + 1);
  assert.equal(shownComposer()?.value, prUrl, "The composer holds the PR URL");
  assert.ok(!calls.includes("session/prompt"), "The PR URL is not sent");
  assert.match(host.textContent ?? "", /did not save the pull request binding/);
  // A keryx that stores the subject: the second press opens a bound session, the third opens the same one.
  storesSubject = true;
  await go("Pull requests");
  await React.act(() => namedButton("Open in session for #12").click());
  await settle();
  assert.equal(opened(), firstOpen + 2);
  assert.equal(stored.size, 1);
  assert.equal(shownComposer()?.value, prUrl);
  await go("Pull requests");
  await React.act(() => namedButton("Session for #12").click());
  await settle();
  assert.equal(opened(), firstOpen + 2, "Open in session again reuses the bound session");
  assert.ok(host.querySelector(".titlebar")?.textContent?.includes("PR org/project#12"));
  // /review without a target in the PR-bound session preselects the PR.
  const draft = shownComposer()!;
  await React.act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draft, "/review");
    draft.dispatchEvent(new Event("input", { bubbles:true }));
  });
  await React.act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
  await settle();
  const launch = host.querySelector('[role="dialog"]');
  assert.ok(launch && launch.textContent?.includes("Run review"));
  assert.equal(launch.querySelector<HTMLInputElement>("input.text-input")?.value, prUrl);
  assert.equal(launch.querySelector<HTMLSelectElement>('select[aria-label="Pull request"]')?.value, "12");
  await React.act(() => [...launch.querySelectorAll("button")].find(button => button.textContent === "Cancel")!.click());
  // The menu's New session creates another session bound to the same PR.
  await go("Pull requests");
  await React.act(() => namedButton("More sessions for #12").click());
  const menuNew = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === "New session");
  assert.ok(menuNew);
  await React.act(() => menuNew.click());
  await settle();
  assert.equal(opened(), firstOpen + 3);
  assert.equal(stored.size, 2);
  assert.ok([...stored.values()].every(entry => (entry._meta.keryx.subject as { number?: number } | undefined)?.number === 12));
  // The session header links back to the PR's card and opens its panel.
  await React.act(() => namedButton("PR org/project#12").click());
  await settle();
  assert.ok(host.querySelector('main nav button[aria-current="page"]')?.textContent?.startsWith("Pull requests"));
  assert.ok(host.querySelector(".review-detail-panel"), "The PR panel is open");
  await go("Sessions");
  await React.act(() => host.querySelector<HTMLButtonElement>(".project-switcher")!.click());
  const projectSettings = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === "Project Settings");
  assert.ok(projectSettings);
  await React.act(() => projectSettings.click());
  await chooseAccount("second");
  assert.equal(host.querySelector(".usage-footer .project-github-account")?.textContent, "GitHub · @second");
  await React.act(() => namedButton("GitHub · @second").click());
  await React.act(() => namedButton("Disconnect from project").click());
  assert.equal(host.querySelector(".usage-footer .project-github-account")?.textContent, "GitHub · Not connected");
} finally {
  await React.act(() => root.unmount());
  clearMocks();
  await unregisterDom();
}
