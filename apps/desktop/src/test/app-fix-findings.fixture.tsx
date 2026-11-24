import assert from "node:assert/strict";
import type { ReviewSummary } from "../../../../src/review/review-entity";
import { registerDom, unregisterDom } from "./dom";

// "Fix findings" over the App wiring: pressed in a Review panel of the Reviews tab, it opens the PR's bound
// session (a new bound one when none exists) with the findings prompt in the composer, not sent, and the one
// flow package that then appears is offered on the PR's work row as "Link Flow #<id>" and linked only on Link —
// the Create Flow path. Runs in its own process like app-work-row.fixture.tsx: the production backend caches its
// first host connection.
registerDom();
const { mockIPC, mockWindows, clearMocks } = await import("@tauri-apps/api/mocks");
const { emit } = await import("@tauri-apps/api/event");
const cwd = "/dev/fix-findings";
const pr = (number: number) => `https://github.com/org/project/pull/${number}`;
const prSubjectOf = (number: number) => ({ kind: "pr", repo: "org/project", number, url: pr(number) });
let flowDirs = ["500-existing"];
const flagWrites: Array<{ sessionId: string; flow?: string; subject?: number }> = [];
const calls: string[] = [];
let created = 0;
type Stored = { sessionId: string; cwd: string; title: string; updatedAt: string; _meta: { keryx: Record<string, unknown> } };
const stored = new Map<string, Stored>([
  ["pr12-session", { sessionId: "pr12-session", cwd, title: "Work on #12", updatedAt: "2026-11-20T00:00:03Z", _meta: { keryx: { subject: prSubjectOf(12) } } }],
]);
const card = (number: number) => ({ number, title: "PR " + number, url: pr(number), state: "open" as const, draft: false, author: "Me",
  assignees: [], reviewers: [], decision: null, ci: "passed" as const, headSha: "a".repeat(40), baseSha: "b".repeat(40), updatedAt: "2026-11-19T00:00:00Z" });
const time = "2026-11-19T00:00:00Z";
/** The viewer's own PR, reviewed in round 1 with open findings. */
function review(number: number): ReviewSummary {
  const reviewed = { baseSha: "b".repeat(40), headSha: "a".repeat(40) };
  const findings = { blocker: 1, major: 1, minor: 0, info: 2 };
  return { id: "review-" + number, number, card: card(number), state: "ready", freshness: { kind: "current" }, onHeadMove: "ask", closedAt: null,
    rounds: [{ number: 1, baseSha: reviewed.baseSha, headSha: reviewed.headSha, previousRunId: null, attempts: [{ id: "run-" + number, round: 1,
      previousRunId: null, state: "completed", source: "manual", baseSha: reviewed.baseSha, headSha: reviewed.headSha, reviewed, coverage: "complete",
      findings, verdict: null, publication: null, decision: null, flowId: null, tokens: null, awaitingAnswer: false, archived: false,
      createdAt: time, finishedAt: time }] }],
    latestRound: 1, reviewed, archived: false, findings, publication: null, source: "manual", flowId: null, tokens: null };
}
const reviews = [review(12), review(14)];

mockWindows("fix-findings");
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
    case "acp_send": {
      const { method, id, params } = JSON.parse(String((args as { message: string }).message));
      calls.push(method);
      let result: unknown;
      if (method === "_keryx/session_flags") {
        const { sessionId, cwd: _cwd, ...change } = params as { sessionId: string; cwd: string; flow?: string; subject?: { number: number } };
        flagWrites.push({ sessionId, ...(change.flow ? { flow: change.flow } : {}), ...(change.subject ? { subject: change.subject.number } : {}) });
        const entry = stored.get(sessionId);
        // keryx stores a new session only after its first turn: until then it refuses the flags.
        if (!entry) throw new Error("no session " + sessionId);
        entry._meta.keryx = { ...entry._meta.keryx, ...change };
        result = entry._meta.keryx;
      } else {
        result = method === "initialize" ? { agentInfo: { version: "1.0.0" }, _meta: { keryx: { profile: "shell", liveSessions: true } } }
          : method === "session/new" ? { sessionId: "fresh-" + ++created }
          : method === "session/list" ? { sessions: [...stored.values()] } : { sessions: [] };
      }
      await emit("acp://message", JSON.stringify({ jsonrpc: "2.0", id, result }));
      return;
    }
    case "review_board":
      if ((args as { reviewsOnly?: boolean }).reviewsOnly) return { version: 1, repo: "org/project", repositories: ["org/project"], repositoryId: "RID",
        viewer: "me", fetchedAt: time, reviews, warnings: [] };
      return { version: 1, repo: "org/project", repositories: ["org/project"], repositoryId: "RID", viewer: "me", fetchedAt: time,
        warnings: [], cards: [card(12), card(14)] };
    case "review_run": return { version: 1, runs: [] };
    case "review_watcher": return { version: 1, state: "disabled", events: [] };
    default: return null;
  }
}, { shouldMockEvents: true });

const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { App } = await import("../App");
const { ToastProvider } = await import("../components/Toasts");
const { fixFindingsPrompt, fixFindingsTarget } = await import("../reviews/model");
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
const key = { repo: "org/project", repositoryId: "RID", viewer: "me" };
const promptFor = (item: ReviewSummary) => {
  const target = fixFindingsTarget(item, key.viewer);
  assert.ok(target, `Review #${item.number} is eligible for Fix findings`);
  return fixFindingsPrompt(item, key, target);
};
const shownComposer = () => [...host.querySelectorAll<HTMLTextAreaElement>("textarea")].find(t => !t.closest("[hidden]"));
async function waitFor(what: string, ok: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for: ${what} (composer: ${JSON.stringify(shownComposer()?.value)}, last calls: ${calls.slice(-6).join(", ")})`);
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
const slot = (number: number, name: string) => host.querySelector(`[aria-label="Keryx work for #${number}"] [data-slot="${name}"] > *`)?.textContent;
const offerName = (dir: string) => `Flow #${dir.slice(0, 3)} · Flow ${dir}`;
const offers = (number: number, dir: string) => slot(number, "flow") === `Link ${offerName(dir)} for #${number}`
  && !!findButton(`Link ${offerName(dir)} for #${number}`);
const newSessions = () => calls.filter(method => method === "session/new").length;
const flowWrites = () => flagWrites.filter(write => write.flow);
/** Opens the Reviews tab and the Review of PR `number`, then presses its Fix findings. */
async function fixFindings(number: number) {
  await go("Reviews");
  const tile = () => [...host.querySelectorAll<HTMLButtonElement>("button.review-card")].find(b => b.textContent?.includes(`#${number}`));
  await waitFor(`the Reviews tab lists #${number}`, () => !!tile());
  await React.act(() => tile()!.click());
  await waitFor(`the Review panel of #${number} offers Fix findings`, () => !!findButton(`Fix findings of pull request #${number}`));
  assert.equal(namedButton(`Fix findings of pull request #${number}`).textContent, "Fix findings", "The action has a visible text label");
  await React.act(() => namedButton(`Fix findings of pull request #${number}`).click());
}

try {
  await React.act(async () => root.render(<ToastProvider><App /></ToastProvider>));
  await waitFor("the ACP session composer is ready", () => host.querySelector("textarea")?.disabled === false, 2500);

  // A PR with a bound session: that session opens with the findings prompt in its composer, not sent.
  const newBefore = newSessions();
  await fixFindings(12);
  await waitFor("#12's session composer holds the findings prompt", () => shownComposer()?.value === promptFor(reviews[0]!));
  assert.equal(newSessions(), newBefore, "The bound session is reused");
  assert.ok(!calls.includes("session/prompt"), "The findings prompt is not sent");

  // The one package that then appears is offered on the PR's work row and linked only on Link.
  flowDirs = [...flowDirs, "511-fix-twelve"];
  await React.act(async () => { window.dispatchEvent(new Event("focus")); });
  await go("Flows");
  await waitFor("the Flows board lists the new package", () => host.textContent?.includes("Flow 511-fix-twelve") === true);
  await go("Pull requests");
  await waitFor("#12 offers Flow #511", () => offers(12, "511-fix-twelve"));
  assert.deepEqual(flowWrites(), [], "Nothing is linked before Link");
  await React.act(() => namedButton(`Link ${offerName("511-fix-twelve")} for #12`).click());
  await waitFor("#12 shows the linked Flow", () => slot(12, "flow") === "Flow #511 · Initializing");
  assert.deepEqual(flowWrites(), [{ sessionId: "pr12-session", flow: "511-fix-twelve" }]);

  // A PR without a bound session: a new session is opened, bound to the PR, with the findings prompt.
  const beforeNew = newSessions();
  await fixFindings(14);
  await waitFor("#14's new session holds the findings prompt", () => shownComposer()?.value === promptFor(reviews[1]!));
  await waitFor("#14's new session is bound", () => flagWrites.some(write => write.subject === 14));
  assert.equal(newSessions(), beforeNew + 1, "One new bound session");
  assert.ok(!calls.includes("session/prompt"), "The findings prompt is not sent");
} finally {
  await React.act(() => root.unmount());
  clearMocks();
  await unregisterDom();
}
