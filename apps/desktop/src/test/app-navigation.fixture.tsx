import assert from "node:assert/strict";
import { registerDom, unregisterDom } from "./dom";

// This fixture runs in its own process: the production backend caches its first host connection.
registerDom();
const { mockIPC, mockWindows, clearMocks } = await import("@tauri-apps/api/mocks");
const { emit } = await import("@tauri-apps/api/event");
const cwd = "/dev/project-navigation";
let offline = false;
const reads: string[] = [];
const reviewReads: string[] = [];
const starts: unknown[] = [];
const replies: unknown[] = [];
let refuseReply = true;
const calls: string[] = [];
const loaded: string[] = [];
const runId = "e968ba9b-c8a3-438f-a5c8-93625e427905";
const prUrl = "https://github.com/org/project/pull/12";
// AC16: a second open PR with no Flow (no Flow names its URL) and no local review.
const bareRunId = "0f3c2a51-7d4e-4b8a-9c61-2e5f0a7b9d13";
const barePrUrl = "https://github.com/org/project/pull/13";
const bareStarts: unknown[] = [];
const boardRunId = "9c8a02c5-1d65-4faa-a407-8f263f83ac53";
let boardOrigin = "";
/** The skill in #14's session has registered its attempt (it does so while the review turn runs, here once it is released). */
let boardRegistered = false;
/** Detached starts for #14; Desktop Review v3 sends none. */
const boardStarts: unknown[] = [];
/** The review turns (text naming `keryx review state open`) each session received, in order. */
const reviewTurns: Array<{ sessionId: string; text: string }> = [];
/** While set, a `session/prompt` answers only once it resolves: that session's turn is in flight. */
let holdPrompt: Promise<void> | undefined;
const boardPrUrl = "https://github.com/org/project/pull/14";
let origin = "";
let bareOrigin = "";
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
const boardRun = { ...run, id: boardRunId, headSha: "e".repeat(40) };
const bareRun = { ...run, id: bareRunId, baseSha: "d".repeat(40), headSha: "c".repeat(40), coordinatorActivity: [] };
let account: string | null = null;
let accountConfigured = false;
let connectedNewAccount = false;
let accountListReads = 0;
let accountListGate: Promise<void> | undefined;
let accountListError: string | undefined;
/** false: an older keryx that answers `_keryx/session_flags` without `subject`. */
let storesSubject = false;
/** Sessions the older keryx has saved: it saves a new session at its first turn and refuses flags before that. */
const saved = new Set<string>();
/** The session ids `session/prompt` was sent for. */
const prompted: string[] = [];
const transcript = new Map<string, string>();
/** The session ids whose flags write the older keryx has refused (the refusal sent to the app). */
const refusedFlags: string[] = [];
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
      if (["session/load", "session/resume", "_keryx/session_shown"].includes(method)) loaded.push(String((params as { sessionId?: string }).sessionId));
      let result: unknown;
      if (method === "_keryx/session_reviews") {
        const sessionId = (params as { sessionId: string }).sessionId;
        const candidates = [{ id: runId, number: 12, sessionId: origin, revision: { baseSha: run.baseSha, headSha: run.headSha } },
          { id: bareRunId, number: 13, sessionId: bareOrigin, revision: { baseSha: bareRun.baseSha, headSha: bareRun.headSha } },
          { id: boardRunId, number: 14, sessionId: boardRegistered ? boardOrigin : "", revision: { baseSha: boardRun.baseSha, headSha: boardRun.headSha } }];
        result = account === "me" ? candidates.filter(candidate => candidate.sessionId === sessionId).map(candidate => ({
          ...candidate, key: { repo: "org/project", repositoryId: "RID", viewer: "me", number: candidate.number },
        })) : [];
      } else if (method === "session/prompt") {
        const { sessionId, prompt } = params as { sessionId: string; prompt: { text: string }[] };
        prompted.push(sessionId);
        saved.add(sessionId);
        const text = prompt[0]?.text ?? "";
        transcript.set(sessionId, text);
        // The review-orchestrator skill in that session registers its package as the PR's attempt (v2 data in
        // runs.sqlite): from then on the session's review list and the run status show it for this session.
        if (text.includes("keryx review state open")) {
          reviewTurns.push({ sessionId, text });
          if (text.includes(`--pr ${prUrl} `)) origin = sessionId;
          if (text.includes(`--pr ${barePrUrl} `)) bareOrigin = sessionId;
          if (text.includes(`--pr ${boardPrUrl} `)) {
            boardOrigin = sessionId;
            if (!stored.has(sessionId)) stored.set(sessionId, { sessionId, cwd, title: "New session", updatedAt: "2026-11-20T00:00:00Z", _meta: { keryx: {} } });
          }
        }
        await holdPrompt;
        result = { stopReason: "end_turn" };
      } else if (method === "session/load") {
        const { sessionId } = params as { sessionId: string };
        const text = transcript.get(sessionId);
        if (text) await emit("acp://message", JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {
          sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
        } }));
        result = {};
      } else if (method === "_keryx/session_flags") {
        const { sessionId, subject } = params as { sessionId: string; subject?: Record<string, unknown> };
        if (!storesSubject && !saved.has(sessionId)) {
          await emit("acp://message", JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: `session ${sessionId} not found` } }));
          refusedFlags.push(sessionId);
          return;
        }
        const flags = storesSubject && subject ? { subject } : {};
        if (storesSubject) stored.set(sessionId, { sessionId, cwd, title: "PR session " + sessionId, updatedAt: new Date(Date.now() + stored.size).toISOString(), _meta: { keryx: flags } });
        result = flags;
      } else {
        result = method === "initialize" ? { agentInfo: { version: "1.0.0" }, _meta: { keryx: { profile: "shell", liveSessions: true, extensions: ["_keryx/session_reviews", "_keryx/session_review_request"] } } }
          : method === "session/new" ? { sessionId: newSessions++ ? "nav-session-" + newSessions : "nav-session" }
          : method === "session/list" ? { sessions: [...stored.values()].reverse() } : { sessions: [] };
      }
      await emit("acp://message", JSON.stringify({ jsonrpc: "2.0", id, result }));
      return;
    }
    case "review_board":
      // The PR panel's detail read (the session header link opens it).
      const detailNumber = (args as { number?: number }).number;
      if (detailNumber === 12 || detailNumber === 14) return { version: 1, viewer: account ?? "me", repositoryId: "RID", number: detailNumber,
        headSha: detailNumber === 14 ? boardRun.headSha : run.headSha, fetchedAt: "2026-11-19T00:00:00Z", comments: [], reviews: [], threads: [], checks: [], warnings: [] };
      // The Reviews tab reads its own list; the board reads counted below are the Pull requests tab's.
      if ((args as {reviewsOnly?: boolean}).reviewsOnly) {
        reviewReads.push(String((args as {cwd:string}).cwd));
        // Once the session starts a review, PR #12 has a running Review in this list.
        const reviews = origin ? [{ id: "review-12", number: 12, state: "running", freshness: { kind: "current" }, onHeadMove: "ask",
          closedAt: null, latestRound: 1, reviewed: null, archived: false, findings: null, publication: null, source: "manual", flowId: null, tokens: null,
          card: { number:12,title:"Navigation proof",url:prUrl,state:"open",draft:false,author:"author",assignees:[],reviewers:["me"],decision:null,ci:"passed",headSha:run.headSha,baseSha:run.baseSha,updatedAt:"2026-11-19T00:00:00Z" },
          rounds: [{ number: 1, baseSha: run.baseSha, headSha: run.headSha, previousRunId: null, attempts: [] }] }] : [];
        return { version: 1, repo:"org/project", repositories:["org/project"], repositoryId:"RID", viewer:account ?? "me",
          fetchedAt:"2026-11-19T00:00:00Z", reviews, warnings: [] };
      }
      reads.push(String((args as {cwd:string}).cwd));
      if (offline) throw new Error("unavailable: connection lost");
      return { version: 1, repo:"org/project", repositories:["org/project"], repositoryId:"RID", viewer:account ?? "me", fetchedAt:"2026-11-19T00:00:00Z",
        warnings: [], cards: [{ number:12,title:"Navigation proof",url:prUrl,state:"open",draft:false,author:"author",assignees:[],reviewers:["me"],decision:null,ci:"passed",headSha:run.headSha,baseSha:run.baseSha, ...(origin && account === "me" && { localReview: { active: true, ready: false, runState: "running", sessionId: origin, runId } }),updatedAt:"2026-11-19T00:00:00Z" },
          { number:13,title:"Bare proof",url:barePrUrl,state:"open",draft:false,author:"author",assignees:[],reviewers:[],decision:null,ci:"passed",headSha:bareRun.headSha,baseSha:bareRun.baseSha, ...(bareOrigin && account === "me" && { localReview: { active: true, ready: false, runState: "running", sessionId: bareOrigin, runId: bareRunId } }),updatedAt:"2026-11-18T00:00:00Z" },
          { number:14,title:"Board proof",url:boardPrUrl,state:"open",draft:false,author:"author",assignees:[],reviewers:[],decision:null,ci:"passed",headSha:boardRun.headSha,baseSha:boardRun.baseSha, ...(boardRegistered && account === "me" && { localReview: { active: true, ready: false, runState: "running", sessionId: boardOrigin, runId: boardRunId } }),updatedAt:"2026-11-17T00:00:00Z" }] };
    case "review_run": {
      const { action, target } = args as { action: { kind: string; activityId?: string; activityBefore?: number; sessionId?: string }; target: { number: number } };
      if (target.number === 14) {
        if (action.kind === "start") {
          boardStarts.push(action);
          return { version: 1, runs: [{ ...boardRun, sessionId: action.sessionId }], startedRunId: boardRunId };
        }
        return { version: 1, runs: boardRegistered ? [{ ...boardRun, sessionId: boardOrigin }] : [] };
      }
      if (target.number === 13) {
        if (action.kind === "start") {
          bareStarts.push(action);
          return { version: 1, runs: [{ ...bareRun, sessionId: action.sessionId }], startedRunId: bareRunId };
        }
        return { version: 1, runs: bareOrigin && (action.activityId === undefined || action.activityId === bareRunId) ? [{ ...bareRun, sessionId: bareOrigin }] : [] };
      }
      assert.equal(target.number, 12);
      if (action.activityBefore !== undefined) {
        assert.deepEqual(action, { kind: "status", activityId: runId, activityBefore: 88 });
        return { version: 1, runs: [{ ...run, coordinatorActivity: [{ kind: "status", text: "Earlier scope validated" }] }] };
      }
      if (action.kind === "start") {
        starts.push(action);
        return { version: 1, runs: [{ ...run, sessionId: action.sessionId }], startedRunId: runId };
      }
      if (action.kind === "answer") {
        replies.push(action);
        if (refuseReply) {
          refuseReply = false;
          throw new Error("unavailable: Review reply could not be sent.");
        }
        questions = questions.filter(q => q.id !== (action as { questionId?: string }).questionId);
      }
      return { version: 1, runs: origin && (action.activityId === runId || action.kind === "answer")
        ? [{ ...run, sessionId: origin, pendingQuestions: questions, coordinatorActivityBefore: 88 }] : [] };
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
/**
 * The app's short timers (up to 2 s) started while `trackTimers` is on and not yet run or cleared: a state a
 * check can wait on, so a late reaction (a notice raised some milliseconds after a refusal) has run before it.
 */
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let tracked: Set<unknown> | null = null;
globalThis.setTimeout = ((handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
  const into = tracked && (ms ?? 0) <= 2000 ? tracked : null;
  const id = realSetTimeout((...callArgs: unknown[]) => { into?.delete(id); handler(...callArgs); }, ms, ...args);
  into?.add(id);
  return id;
}) as unknown as typeof setTimeout;
globalThis.clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => { tracked?.delete(id); realClearTimeout(id); }) as typeof clearTimeout;
function trackTimers() {
  const set = new Set<unknown>();
  tracked = set;
  return { settled: () => set.size === 0, stop: () => { tracked = null; } };
}
/** Polls until `ok` holds, flushing React between polls; fails with `what` after `ms`. */
async function waitFor(what: string, ok: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for: ${what} (title: ${host.querySelector(".titlebar")?.textContent}, last calls: ${calls.slice(-6).join(", ")})`);
    await React.act(async () => { await new Promise(resolve => realSetTimeout(resolve, 10)); });
  }
}
function findButton(label: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(b => b.getAttribute("aria-label") === label || b.textContent?.trim() === label);
}
function namedButton(label: string) {
  const button = findButton(label);
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
  // The Pull requests dot only: the Reviews dot shares the base class and comes first in the nav.
  const reviewDot = () => host.querySelector("nav .review-tab-dot:not(.reviews-tab-dot)")?.getAttribute("data-indicator");
  assert.equal(reviewDot(), "attention", "Review requests reach the navigation on Sessions");
  assert.ok(reviewReads.length > 0, "The Reviews list is read while its tab is hidden");
  assert.equal(host.querySelector("nav .reviews-tab-dot"), null, "No Review waits on the viewer");
  const hiddenReviewReads = reviewReads.length;
  await React.act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "3", metaKey: true, bubbles: true })); });
  assert.equal(host.querySelector('main nav button[aria-current="page"]')?.textContent, "Reviews");
  assert.ok(host.textContent?.includes("No Keryx reviews yet"));
  assert.ok(reviewReads.length > hiddenReviewReads, "Showing the Reviews tab reads the list again");
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
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(current, `Сделай адаптивное ревью ${prUrl} с review-orchestrator`);
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
  // AC6 (Desktop Review v3): Apply sends the review turn into this same session and starts no detached worker.
  await waitFor("the review turn reaches the requesting session", () => reviewTurns.length === 1);
  assert.deepEqual(starts, [], "Apply sends no review_run start");
  assert.equal(reviewTurns[0]!.sessionId, "nav-session"); // length checked above
  const firstTurn = reviewTurns[0]!.text;
  for (const part of ["review-orchestrator", prUrl, `--base ${run.baseSha} --head ${run.headSha}`, "keryx review state open", "--session nav-session",
    "--source desktop", "Flow 505", `Request: Сделай адаптивное ревью ${prUrl} с review-orchestrator`]) {
    assert.ok(firstTurn.includes(part), `The review turn names ${part}`);
  }
  assert.ok(!calls.includes("_keryx/session_review_request"), "No v2 launch receipt is written");
  // AC9: the attempt the skill registered for this session (v2 data) shows in the session review card.
  await waitFor("the session review card shows the registered attempt", () => /2 questions are waiting for a reply/.test(host.textContent ?? ""));
  const activity = [...host.querySelectorAll("summary")].find(summary => summary.textContent === "Review activity");
  assert.ok(activity);
  await React.act(() => activity.click());
  await React.act(() => namedButton("Load earlier activity").click());
  assert.match(host.querySelector('[aria-label="Coordinator activity"]')?.textContent ?? "", /Earlier scope validated.*Wave 1 started/);
  assert.equal(findButton("Load earlier activity"), undefined);
  await React.act(() => namedButton("Back to latest activity").click());
  assert.doesNotMatch(host.querySelector('[aria-label="Coordinator activity"]')?.textContent ?? "", /Earlier scope validated/);
  const contract = [...host.querySelectorAll<HTMLFieldSetElement>(".session-review-activity fieldset")]
    .find(field => field.querySelector("legend")?.textContent === "review-pr-contract");
  assert.ok(contract);
  const replyField = contract.querySelector<HTMLTextAreaElement>("textarea");
  const replyButton = contract.querySelector<HTMLButtonElement>('button[type="submit"]');
  assert.ok(replyField && replyButton);
  assert.ok(!current.disabled, "An active review leaves the regular chat composer available");
  const note = "Read the pinned contract in the backend checkout.";
  await React.act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(replyField, note);
    replyField.dispatchEvent(new Event("input", { bubbles:true }));
  });
  await React.act(() => replyButton.click());
  assert.equal(replyField.value, note, "A failed send keeps the draft for the same review question");
  assert.match(host.textContent ?? "", /Review reply could not be sent/);
  await React.act(() => replyButton.click());
  const reply = { kind: "answer", id: runId, questionId: "question-contract", answer: note };
  assert.deepEqual(replies, [reply, reply]);
  assert.match(host.textContent ?? "", /1 question is waiting for a reply/);
  assert.deepEqual(prompted, ["nav-session"], "Answers and status reads send no turn: the review turn is the only one");
  await go("Pull requests");
  // The board learns of the session's registered attempt from its next read (v2 data on the card slot).
  await React.act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Refresh pull requests"]')!.click());
  await waitFor("#12's slot shows the registered attempt", () => /^Review · (running|needs your answer)$/.test(host.querySelector('[aria-label="Keryx work for #12"] [data-slot="review"]')?.textContent ?? ""));
  assert.match(host.querySelector('[aria-label="Keryx work for #12"] [data-slot="review"]')?.textContent ?? "", /^Review · (running|needs your answer)$/);
  // The card opens the exact ACP conversation that started this review.
  const countBeforeReopen = newSessions;
  for (let attempt = 0; attempt < 2; attempt++) {
    const reviewAction = [...host.querySelectorAll<HTMLButtonElement>("button[aria-label]")]
      .find(b => /^Review · (running|needs your answer) for #12$/.test(b.getAttribute("aria-label") ?? ""));
    assert.ok(reviewAction, "The PR card offers its review");
    await React.act(async () => { reviewAction.click(); });
    await waitFor("the originating review session opens", () => host.querySelector('main nav button[aria-current="page"]')?.textContent === "Sessions");
    assert.equal(newSessions, countBeforeReopen, "Reopening the review creates no new session");
    await go("Pull requests");
  }

  // "Open in session" with an older keryx: a new session opens, the PR URL waits in the composer, a notice says the binding was not saved.
  const shownComposer = () => [...host.querySelectorAll<HTMLTextAreaElement>("textarea")].find(t => !t.closest("[hidden]"));
  const opened = () => calls.filter(method => method === "session/new").length;
  const firstOpen = opened();
  const turnsBeforeOpen = prompted.length;
  const timers = trackTimers();
  await React.act(() => namedButton("Open in session for #12").click());
  await waitFor("the composer holds the PR URL", () => shownComposer()?.value === prUrl);
  assert.equal(opened(), firstOpen + 1);
  assert.equal(prompted.length, turnsBeforeOpen, "The PR URL is not sent");
  // keryx has not saved the new session yet: it refuses the binding, which waits for the first turn without a notice.
  const flagWrites = () => calls.filter(method => method === "_keryx/session_flags").length;
  // TP-R4-006: every notice element added from here on, with the turns sent when it appeared.
  const notSaved = /did not save the pull request binding/;
  const notices: number[] = [];
  const watcher = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node instanceof Element && node.matches(".notice") && notSaved.test(node.textContent ?? "")) notices.push(prompted.length - turnsBeforeOpen);
    }
  });
  watcher.observe(host, { childList: true, subtree: true });
  // Wait on states, not on time: keryx refused the binding, and every short timer the app started since the
  // press has run, so a notice raised some time after the refusal is there before the check.
  await waitFor("keryx refused the first binding attempt and the app's timers ran", () => refusedFlags.length > 0 && timers.settled(), 4000);
  timers.stop();
  await React.act(async () => {});
  assert.ok(!notSaved.test(host.textContent ?? ""), "No notice before keryx has saved the session");
  const refusedWrites = flagWrites();
  // The first turn saves the session; the binding is tried again after it and keryx answers without subject.
  await React.act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
  await waitFor("the notice that the binding was not saved", () => /did not save the pull request binding/.test(host.textContent ?? ""));
  assert.equal(prompted.length, turnsBeforeOpen + 1, "One turn was sent");
  assert.ok(flagWrites() > refusedWrites, "The binding was tried again after the turn");
  const olderTurns = [...prompted];
  // A keryx that stores the subject: the second press opens a bound session, the third opens the same one.
  storesSubject = true;
  await go("Pull requests");
  await React.act(() => namedButton("Open in session for #12").click());
  await waitFor("keryx stores the bound session", () => stored.size === 1 && shownComposer()?.value === prUrl);
  watcher.disconnect();
  assert.deepEqual(notices, [1], "The older keryx's notice appeared once, after the first turn");
  assert.equal(opened(), firstOpen + 2);
  await go("Pull requests");
  await waitFor("#12 counts its bound session", () => !!findButton("Session for #12"));
  await React.act(() => namedButton("Session for #12").click());
  await waitFor("the session header names PR #12", () => host.querySelector(".titlebar")?.textContent?.includes("PR org/project#12") === true);
  assert.equal(opened(), firstOpen + 2, "Open in session again reuses the bound session");
  // /review without a target in the PR-bound session preselects the PR.
  const draft = shownComposer()!;
  await React.act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(draft, "/review");
    draft.dispatchEvent(new Event("input", { bubbles:true }));
  });
  await React.act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
  await waitFor("the launch dialog", () => !!host.querySelector('[role="dialog"]')?.textContent?.includes("Run review"));
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
  await waitFor("keryx stores the second bound session", () => stored.size === 2);
  assert.equal(opened(), firstOpen + 3);
  assert.ok([...stored.values()].every(entry => (entry._meta.keryx.subject as { number?: number } | undefined)?.number === 12));
  // The session header links back to the PR's card and opens its panel, each time it is pressed.
  const panel = () => host.querySelector(".review-detail-panel");
  await waitFor("the header links the new session's PR", () => !!findButton("PR org/project#12"));
  await React.act(() => namedButton("PR org/project#12").click());
  await waitFor("the PR panel opens", () => !!panel());
  assert.ok(host.querySelector('main nav button[aria-current="page"]')?.textContent?.startsWith("Pull requests"));
  await React.act(() => namedButton("Close details").click());
  assert.equal(panel(), null);
  await go("Sessions");
  await React.act(() => namedButton("PR org/project#12").click());
  await waitFor("the PR panel opens again from a second header press", () => !!panel());
  await React.act(() => namedButton("Close details").click());

  // AC16: PR without Flow and review -> Open in session -> /review -> review link on the card.
  await go("Pull requests");
  const bareSlot = (slot: string) => host.querySelector(`[aria-label="Keryx work for #13"] [data-slot="${slot}"] button`)?.textContent;
  assert.equal(bareSlot("review"), "Run review", "#13 has no local review");
  assert.equal(bareSlot("flow"), "Create Flow", "#13 has no Flow");
  assert.equal(bareSlot("session"), "Open in session", "#13 has no bound session");
  const beforeBare = opened();
  await React.act(() => namedButton("Open in session for #13").click());
  await waitFor("keryx stores #13's bound session", () => [...stored.values()].some(entry => (entry._meta.keryx.subject as { number?: number } | undefined)?.number === 13));
  await waitFor("the composer holds #13's URL", () => shownComposer()?.value === barePrUrl);
  assert.equal(opened(), beforeBare + 1, "Open in session creates one session");
  const bareSessions = [...stored.values()].filter(entry => (entry._meta.keryx.subject as { number?: number } | undefined)?.number === 13);
  assert.equal(bareSessions.length, 1, "The new session is bound to #13");
  const bareSession = bareSessions[0]!.sessionId; // length checked above
  assert.deepEqual(bareSessions[0]!._meta.keryx.subject, { kind: "pr", repo: "org/project", number: 13, url: barePrUrl, repositoryId: "RID" });
  assert.equal(shownComposer()?.value, barePrUrl, "The composer holds the PR URL");
  assert.ok(host.querySelector(".titlebar")?.textContent?.includes("PR org/project#13"));
  // Pressing it again, from another session, opens the same session: no second session/new.
  await go("Pull requests");
  // "latest" opens the newest of #12's two bound sessions: the one the menu created.
  const newest12 = [...stored.values()].filter(entry => (entry._meta.keryx.subject as { number?: number } | undefined)?.number === 12)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]!.sessionId; // two are stored, asserted above
  await React.act(() => namedButton("2 sessions for #12").click());
  await waitFor("the newest #12 session is shown", () => loaded.at(-1) === newest12
    && host.querySelector(".titlebar")?.textContent?.includes("PR org/project#12") === true);
  await go("Pull requests");
  assert.equal(bareSlot("session"), "Session");
  const loadsBefore = loaded.length;
  await React.act(() => namedButton("Session for #13").click());
  await waitFor("#13's bound session is shown again", () => loaded.length > loadsBefore
    && host.querySelector(".titlebar")?.textContent?.includes("PR org/project#13") === true);
  assert.equal(opened(), beforeBare + 1, "The second press reuses the bound session");
  assert.equal(stored.size, 3);
  assert.deepEqual(loaded.slice(loadsBefore), [bareSession], "The bound session is shown again");
  assert.equal(shownComposer()?.value, barePrUrl, "Its unsent draft is still there");
  assert.ok(host.querySelector(".titlebar")?.textContent?.includes("PR org/project#13"));
  // /review without a target preselects the bound PR.
  const bareDraft = shownComposer()!;
  await React.act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(bareDraft, "/review");
    bareDraft.dispatchEvent(new Event("input", { bubbles:true }));
  });
  await React.act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
  await waitFor("the launch dialog for #13", () => !!host.querySelector('[role="dialog"]')?.textContent?.includes("Run review"));
  const bareLaunch = host.querySelector('[role="dialog"]');
  assert.ok(bareLaunch && bareLaunch.textContent?.includes("Run review"));
  assert.equal(bareLaunch.querySelector<HTMLInputElement>("input.text-input")?.value, barePrUrl);
  assert.equal(bareLaunch.querySelector<HTMLSelectElement>('select[aria-label="Pull request"]')?.value, "13");
  const bareApply = [...bareLaunch.querySelectorAll("button")].find(button => button.textContent === "Apply");
  assert.ok(bareApply && !bareApply.disabled);
  await React.act(() => bareApply.click());
  await waitFor("the launch dialog closes after the review turn", () => reviewTurns.length === 2 && !host.querySelector('[role="dialog"]'));
  assert.deepEqual(bareStarts, [], "Apply sends no review_run start");
  assert.equal(reviewTurns[1]!.sessionId, bareSession, "The review turn goes into #13's bound session"); // length checked above
  for (const part of ["review-orchestrator", barePrUrl, `--base ${bareRun.baseSha} --head ${bareRun.headSha}`, "keryx review state open", `--session ${bareSession}`]) {
    assert.ok(reviewTurns[1]!.text.includes(part), `#13's review turn names ${part}`);
  }
  assert.ok(!reviewTurns[1]!.text.includes("Request:"), "A bare /review carries no request line");
  // The attempt the skill registered is the card's review link once the board reads again.
  await go("Pull requests");
  await React.act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Refresh pull requests"]')!.click());
  await waitFor("#13's review slot shows the registered attempt", () => bareSlot("review") === "Review · running");
  assert.equal(bareSlot("flow"), "Create Flow");
  assert.equal(bareSlot("session"), "Session");
  assert.deepEqual(prompted, [...olderTurns, bareSession], "Neither the PR URL nor /review is sent as a prompt; the review turn is");
  const openBeforeBoardLaunch = newSessions;
  // AC5: Run review on the board opens a new session bound to #14 (none is bound yet) and sends the review turn there.
  // The turn stays in flight until `releasePrompt`, so a second Run review meets a busy session (AC8).
  let releasePrompt!: () => void;
  holdPrompt = new Promise(resolve => { releasePrompt = resolve; });
  await React.act(() => namedButton("Run review for #14").click());
  await waitFor("the board launch dialog", () => !!host.querySelector('[role="dialog"]')?.textContent?.includes("Run review"));
  await React.act(() => namedButton("Apply").click());
  await waitFor("the board launch sends its review turn and closes", () => !!boardOrigin && !host.querySelector('[role="dialog"]'));
  assert.equal(newSessions, openBeforeBoardLaunch + 1);
  assert.deepEqual(boardStarts, [], "Run review sends no review_run start");
  assert.deepEqual(reviewTurns.slice(2).map(turn => turn.sessionId), [boardOrigin]);
  for (const part of ["review-orchestrator", boardPrUrl, `--base ${boardRun.baseSha} --head ${boardRun.headSha}`, "keryx review state open", `--session ${boardOrigin}`]) {
    assert.ok(reviewTurns[2]!.text.includes(part), `#14's review turn names ${part}`); // three turns asserted above
  }
  await waitFor("the new session is bound to #14", () => host.querySelector(".titlebar")?.textContent?.includes("PR org/project#14") === true);
  // AC8: the bound session is running that turn: a second Run review sends nothing, starts nothing and says why.
  const turnsWhileBusy = prompted.length;
  await go("Pull requests");
  await React.act(() => namedButton("Run review for #14").click());
  await waitFor("the board launch dialog again", () => !!host.querySelector('[role="dialog"]')?.textContent?.includes("Run review"));
  await React.act(() => namedButton("Apply").click());
  await waitFor("the busy refusal in the launch dialog", () => /running a turn/.test(host.querySelector('[role="dialog"]')?.textContent ?? ""));
  assert.equal(prompted.length, turnsWhileBusy, "A busy session gets no second turn");
  assert.deepEqual(boardStarts, [], "A busy session starts no detached worker");
  assert.equal(newSessions, openBeforeBoardLaunch + 1, "The busy session is reused, not replaced");
  await React.act(() => [...host.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(button => button.textContent === "Cancel")!.click());
  holdPrompt = undefined;
  boardRegistered = true;
  await React.act(async () => { releasePrompt(); });
  await waitFor("the review turn finishes", () => !host.querySelector('button[aria-label="Stop"]'));
  const boardComposer = host.querySelector<HTMLTextAreaElement>(".composer textarea");
  assert.ok(boardComposer && !boardComposer.disabled);
  await React.act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(boardComposer, "How is the review going?");
    boardComposer.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await React.act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
  assert.equal(prompted.at(-1), boardOrigin, "Ordinary follow-up is sent to the board review's conversation");
  await React.act(() => root.render(null));
  localStorage.removeItem("keryx.session-reviews.v1:" + cwd);
  await React.act(async () => root.render(<ToastProvider><App /></ToastProvider>));
  await waitFor("the reopened Desktop is connected", () => !!host.querySelector<HTMLTextAreaElement>(".composer textarea:not([disabled])"));
  await go("Pull requests");
  await waitFor("the board has the persisted review origin", () => !!findButton("Review · running for #14"));
  const beforeColdOpen = newSessions;
  const beforeColdLoad = loaded.length;
  await React.act(() => namedButton("Review · running for #14").click());
  await waitFor("the original session is restored without Desktop review storage", () =>
    host.querySelector(".titlebar")?.textContent?.includes("Review #14") === true);
  assert.equal(newSessions, beforeColdOpen);
  // The bound session is now the newest stored one, so the reopened window may already show it: no second load then.
  assert.ok(loaded.slice(beforeColdLoad).every(id => id === boardOrigin) && loaded.at(-1) === boardOrigin, "The original session is the one shown");
  assert.match(host.textContent ?? "", /How is the review going\?/);
  assert.equal(localStorage.getItem("keryx.session-reviews.v1:" + cwd), null);
  await waitFor("the reopened session shows its registered review", () => /\[Review #14\]/.test(host.querySelector(".session-review-activity")?.textContent ?? ""));
  await go("Sessions");
  await React.act(() => host.querySelector<HTMLButtonElement>(".project-switcher")!.click());
  const projectSettings = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent?.trim() === "Project Settings");
  assert.ok(projectSettings);
  await React.act(() => projectSettings.click());
  await chooseAccount("second");
  // The account switch remounts the board: the header request handled earlier is gone and does not reopen the panel.
  await go("Pull requests");
  await waitFor("the board of the second account", () => host.textContent?.includes("Signed in as second") === true);
  assert.equal(host.querySelector(".review-detail-panel"), null, "A handled header focus is not replayed by a remounted board");
  await go("Sessions");
  assert.equal(host.querySelector(".usage-footer .project-github-account")?.textContent, "GitHub · @second");
  assert.equal(host.querySelector(".session-review-activity"), null, "Another account cannot see the previous account's review");
  await React.act(() => namedButton("GitHub · @second").click());
  await React.act(() => namedButton("Disconnect from project").click());
  assert.equal(host.querySelector(".usage-footer .project-github-account")?.textContent, "GitHub · Not connected");
} finally {
  await React.act(() => root.unmount());
  clearMocks();
  await unregisterDom();
}
