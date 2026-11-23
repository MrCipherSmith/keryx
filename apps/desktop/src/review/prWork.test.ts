import { expect, test } from "bun:test";
import type { SessionInfo, SessionSubject } from "../acp/types";
import type { FlowCard } from "../platform/commands";
import {
  boundSessions, FLOW_LINK_WINDOW_MS, flowPrompt, flowStage, openSubjectSession, prFlows, prSubject, prWorkIndex, resolveFlowLinks,
  reviewLaunchTarget, reviewSlotState, subjectOpener, withPendingSubjects, type PendingFlowLink, type SubjectSessionDeps,
} from "./prWork";
import { PendingSubjects, SUBJECT_NOT_SAVED } from "../session/subjectBinding";

const url = "https://github.com/org/repo/pull/101";
const subject: SessionSubject = { kind: "pr", repo: "org/repo", number: 101, url };
const session = (id: string, flags: Record<string, unknown> = {}, updatedAt: string | null = "2026-11-20T10:00:00Z"): SessionInfo =>
  ({ sessionId: id, cwd: "/project", title: "Session " + id, updatedAt, _meta: { keryx: flags } });
const flow = (id: string, extra: Partial<FlowCard> = {}): FlowCard => ({
  id, dir: id + "-work", idValid: true, commandRef: null, title: "Work " + id, status: "in-progress", previousStatus: null,
  blocked: false, owner: null, prUrl: null, baseBranch: null, tasksDone: 0, tasksTotal: 0, acTotal: 0, acConfirmed: 0,
  updatedAt: null, completionExceptions: false, error: null, ...extra,
});

test("the PR subject names the board's repository and the card", () => {
  expect(prSubject({ number: 101, url }, "org/repo", "R1")).toEqual({ ...subject, repositoryId: "R1" });
  expect(prSubject({ number: 101, url }, "org/repo")).toEqual(subject);
});

test("bound sessions: same PR only, never archived, newest first, an unsaved one first", () => {
  const sessions = [
    session("old", { subject }, "2026-11-01T00:00:00Z"),
    session("archived", { subject, archivedAt: "2026-11-21T00:00:00Z" }, "2026-11-22T00:00:00Z"),
    session("other", { subject: { ...subject, number: 102, url: url.replace("101", "102") } }),
    session("issue", { subject: { ...subject, kind: "issue", url: "https://github.com/org/repo/issues/101" } }),
    session("new", { subject }, "2026-11-20T00:00:00Z"),
    session("Case", { subject: { ...subject, repo: "Org/Repo" } }, "2026-11-19T00:00:00Z"),
    session("unsaved", { subject }, null),
  ];
  expect(boundSessions(sessions, subject).map(s => s.sessionId)).toEqual(["unsaved", "new", "Case", "old"]);
});

test("pending subjects show as bound sessions until keryx stores them", () => {
  const pending = new Map([["fresh", subject], ["stored", subject]]);
  const merged = withPendingSubjects([session("stored"), session("plain")], pending);
  expect(merged.map(s => s.sessionId)).toEqual(["fresh", "stored", "plain"]);
  expect(boundSessions(merged, subject).map(s => s.sessionId)).toEqual(["fresh", "stored"]);
  expect(withPendingSubjects([session("plain")], new Map())).toHaveLength(1);
});

test("a subject keryx already stored wins over a pending binding for the same session", () => {
  const other: SessionSubject = { ...subject, number: 102, url: url.replace("101", "102") };
  const merged = withPendingSubjects([session("stored", { subject: other })], new Map([["stored", subject]]));
  expect(merged[0]?._meta?.keryx?.subject).toEqual(other);
  expect(boundSessions(merged, subject)).toEqual([]);
  expect(boundSessions(merged, other).map(s => s.sessionId)).toEqual(["stored"]);
});

test("the PR's Flows are those naming its URL and those linked to a session bound to it", () => {
  const flows = [flow("1", { prUrl: url + "/" }), flow("2"), flow("3"), flow("4", { prUrl: "https://github.com/org/repo/pull/7" })];
  const bound = [session("a", { subject, flow: "2-work" })];
  expect(prFlows({ url }, flows, bound).map(f => f.id).sort()).toEqual(["1", "2"]);
  expect(prFlows({ url }, flows, []).map(f => f.id)).toEqual(["1"]);
  // Both sides are compared without a trailing slash and without case.
  expect(prFlows({ url: url.toUpperCase() + "/" }, flows, []).map(f => f.id)).toEqual(["1"]);
  expect(flowStage(flow("1"))).toBe("In progress");
  expect(flowStage(flow("1", { blocked: true }))).toBe("Blocked");
  expect(flowStage(flow("1", { status: "custom" }))).toBe("custom");
});

test("the review slot names the local review state only: no round number and no behind count", () => {
  expect(reviewSlotState(undefined)).toBeNull();
  expect(reviewSlotState({ active: false, ready: false })).toBeNull();
  const cases: Array<[Parameters<typeof reviewSlotState>[0], string]> = [
    [{ active: true, ready: false, runState: "queued" }, "queued"],
    [{ active: true, ready: false, runState: "running" }, "running"],
    [{ active: true, ready: false, runState: "running", awaitingAnswer: true }, "needs your answer"],
    [{ active: false, ready: true, runState: "completed" }, "ready"],
    [{ active: false, ready: false, runState: "partial" }, "partial"],
    [{ active: false, ready: true, runState: "completed", publicationPending: true }, "publication pending"],
    [{ active: false, ready: false, runState: "failed" }, "failed"],
    [{ active: false, ready: false, runState: "cancelled" }, "stopped"],
    [{ active: false, ready: false, outdated: { headSha: "abc", state: "completed" } }, "outdated"],
    [{ active: true, ready: false, runState: "other-revision" }, "outdated"],
  ];
  for (const [badge, state] of cases) {
    const text = reviewSlotState(badge);
    expect(text).toBe(state);
    expect(text).not.toMatch(/round|behind|\d/i);
  }
});

test("/review without a target in a PR-bound session preselects that PR; a typed target or an issue session wins", () => {
  expect(reviewLaunchTarget(undefined, subject)).toBe(url);
  expect(reviewLaunchTarget("  ", subject)).toBe(url);
  expect(reviewLaunchTarget("#7", subject)).toBe("#7");
  expect(reviewLaunchTarget(undefined, { ...subject, kind: "issue" })).toBeUndefined();
  expect(reviewLaunchTarget(undefined, undefined)).toBeUndefined();
});

test("the board's index answers what boundSessions and prFlows answer", () => {
  const other: SessionSubject = { ...subject, number: 102, url: url.replace("101", "102") };
  const sessions = [
    session("old", { subject, flow: "2-work" }, "2026-11-01T00:00:00Z"), session("archived", { subject, archivedAt: "2026-11-21T00:00:00Z" }),
    session("other", { subject: other }), session("Case", { subject: { ...subject, repo: "Org/Repo" } }, "2026-11-19T00:00:00Z"),
    session("unsaved", { subject }, null), session("plain"),
  ];
  const flows = [flow("1", { prUrl: url + "/" }), flow("2"), flow("3", { prUrl: other.url })];
  const index = prWorkIndex(flows, sessions);
  for (const value of [subject, other, { ...subject, number: 999 }]) {
    expect(index.sessions(value)).toEqual(boundSessions(sessions, value));
    const card = { url: value.url };
    expect(index.flows(card, index.sessions(value))).toEqual(prFlows(card, flows, boundSessions(sessions, value)));
  }
});

const entry = (sessionId: string, known: string[], expiresAt = FLOW_LINK_WINDOW_MS): PendingFlowLink =>
  ({ sessionId, knownDirs: new Set(known), expiresAt });
const noFlow = () => undefined;

test("Create Flow links the one new package to the one pending request, none when several appear or the session already has a Flow", () => {
  const pending = [entry("s", ["1-a", "2-b"])];
  expect(resolveFlowLinks(pending, ["1-a", "2-b"], noFlow, new Set(), 0)).toEqual({ pending, links: [] });
  expect(resolveFlowLinks(pending, ["1-a", "2-b", "3-c"], noFlow, new Set(), 0)).toEqual({ pending: [], links: [{ sessionId: "s", dir: "3-c" }] });
  expect(resolveFlowLinks(pending, ["1-a", "3-c", "4-d"], noFlow, new Set(), 0)).toEqual({ pending: [], links: [] });
  expect(resolveFlowLinks(pending, ["1-a", "3-c"], () => "2-b", new Set(), 0)).toEqual({ pending: [], links: [] });
  expect(flowPrompt(url)).toBe(`Create a Keryx flow for ${url} with flow-orchestrator.`);
});

test("two pending Create Flow requests and one new package: none is linked and both requests end", () => {
  const pending = [entry("s1", ["1-a"]), entry("s2", ["1-a"])];
  expect(resolveFlowLinks(pending, ["1-a"], noFlow, new Set(), 0)).toEqual({ pending, links: [] });
  expect(resolveFlowLinks(pending, ["1-a", "2-new"], noFlow, new Set(), 0)).toEqual({ pending: [], links: [] });
});

test("a package that appears after the request's window is not linked: the request has expired", () => {
  const pending = [entry("s1", ["1-a"], 1_000)];
  expect(resolveFlowLinks(pending, ["1-a"], noFlow, new Set(), 999)).toEqual({ pending, links: [] });
  expect(resolveFlowLinks(pending, ["1-a"], noFlow, new Set(), 1_000)).toEqual({ pending: [], links: [] });
  expect(resolveFlowLinks(pending, ["1-a", "2-foreign"], noFlow, new Set(), 1_001)).toEqual({ pending: [], links: [] });
});

test("a package already linked to one request is never linked to another", () => {
  const pending = [entry("s2", ["1-a"])];
  expect(resolveFlowLinks(pending, ["1-a", "2-claimed"], noFlow, new Set(["2-claimed"]), 0)).toEqual({ pending, links: [] });
  expect(resolveFlowLinks(pending, ["1-a", "2-claimed", "3-own"], noFlow, new Set(["2-claimed"]), 0))
    .toEqual({ pending: [], links: [{ sessionId: "s2", dir: "3-own" }] });
});

/** An app stand-in: new sessions are shown, bound through PendingSubjects, and the composer is only filled. */
function fakeApp(reply: (subject: SessionSubject) => Record<string, unknown> | "not-stored" = s => ({ subject: s })) {
  const stored: SessionInfo[] = [];
  const events: string[] = [];
  const notices: string[] = [];
  let pending: ReadonlyMap<string, SessionSubject> = new Map();
  let next = 0;
  const subjects = new PendingSubjects({
    write: async (sessionId, value) => {
      const answer = reply(value);
      if (answer === "not-stored") throw new Error("unknown session");
      events.push("flags " + sessionId);
      return answer;
    },
    onFlags: (sessionId, flags) => {
      const index = stored.findIndex(s => s.sessionId === sessionId);
      const entry = { ...session(sessionId), _meta: { keryx: flags } };
      if (index < 0) stored.push(entry); else stored[index] = entry;
    },
    onNotice: (sessionId, text) => notices.push(sessionId + ": " + text),
    onChange: value => { pending = value; },
  });
  const deps: SubjectSessionDeps = {
    sessions: () => withPendingSubjects(stored, pending),
    loadSession: async id => { events.push("load " + id); },
    newSession: async () => { const id = "s" + ++next; events.push("new " + id); return id; },
    bind: (id, value) => void subjects.bind(id, value),
    fill: text => events.push("fill " + text),
  };
  return { deps, events, notices, subjects, stored };
}

test("Open in session: a new bound session with the PR URL in the composer, not sent; again opens the same session", async () => {
  const app = fakeApp(() => "not-stored");
  expect(await openSubjectSession(app.deps, subject, "latest", url)).toBe("s1");
  // Prefilled only: the deps have no way to send, and the composer got the URL.
  expect(app.events).toEqual(["new s1", "fill " + url]);
  expect(await openSubjectSession(app.deps, subject, "latest", url)).toBe("s1");
  expect(app.events.slice(2)).toEqual(["load s1"]);
});

test("the session menu's New session creates another bound session; a listed session opens by id", async () => {
  const app = fakeApp();
  await openSubjectSession(app.deps, subject, "latest", url);
  await Promise.resolve();
  expect(boundSessions(app.deps.sessions(), subject).map(s => s.sessionId)).toEqual(["s1"]);
  expect(await openSubjectSession(app.deps, subject, "new", url)).toBe("s2");
  await Promise.resolve();
  expect(boundSessions(app.deps.sessions(), subject).map(s => s.sessionId).sort()).toEqual(["s1", "s2"]);
  expect(await openSubjectSession(app.deps, subject, "s1", url)).toBe("s1");
  expect(app.events.at(-1)).toBe("load s1");
});

test("Create Flow opens the bound session and prefills the flow prompt even when the session exists", async () => {
  const app = fakeApp(() => "not-stored");
  await openSubjectSession(app.deps, subject, "latest", url);
  expect(await openSubjectSession(app.deps, subject, "latest", flowPrompt(url), true)).toBe("s1");
  expect(app.events.slice(-2)).toEqual(["load s1", "fill " + flowPrompt(url)]);
});

test("a keryx that answers without subject still opens the session and says the binding was not saved", async () => {
  let stored = false;
  const app = fakeApp(() => stored ? { archivedAt: undefined } : "not-stored");
  expect(await openSubjectSession(app.deps, subject, "latest", url)).toBe("s1");
  expect(app.events).toEqual(["new s1", "fill " + url]);
  expect(app.notices).toEqual([]);
  expect(app.subjects.get("s1")).toEqual(subject);
  // After the first turn keryx has stored the session and answers, but without the subject.
  stored = true;
  await app.subjects.apply("s1");
  expect(app.notices).toEqual(["s1: " + SUBJECT_NOT_SAVED]);
  expect(app.subjects.get("s1")).toBeUndefined();
  await app.subjects.apply("s1");
  expect(app.notices).toHaveLength(1);
});

test("a repeat Open in session for a Subject while one is opening gets the same pending open: one new session", async () => {
  const app = fakeApp(() => "not-stored");
  const release: Array<(id: string | null) => void> = [];
  let created = 0;
  const deps: SubjectSessionDeps = { ...app.deps, newSession: () => { created++; return new Promise(resolve => { release.push(resolve); }); } };
  const open = subjectOpener();
  const first = open(deps, subject, "latest", url);
  const again = open(deps, { ...subject, repo: "Org/Repo" }, "latest", url);
  const otherPr = open(deps, { ...subject, number: 102, url: url.replace("101", "102") }, "latest", url);
  expect(again).toBe(first);
  expect(otherPr).not.toBe(first);
  expect(created).toBe(2);
  release[0]!("s1");
  expect(await first).toBe("s1");
  release[1]!("s2");
  await otherPr;
  // Settled: the next press opens again (here the bound session, no new one).
  expect(await open(deps, subject, "latest", url)).toBe("s1");
  expect(created).toBe(2);
});

test("a newer bind for the same session decides: the answer to the superseded write is dropped", async () => {
  const other: SessionSubject = { ...subject, number: 102, url: url.replace("101", "102") };
  const writes: Array<(flags: { subject: SessionSubject }) => void> = [];
  const answered: SessionSubject[] = [];
  const subjects = new PendingSubjects({
    write: () => new Promise(resolve => { writes.push(resolve); }),
    onFlags: (_id, flags) => { if (flags.subject) answered.push(flags.subject); },
    onNotice: () => {},
    onChange: () => {},
  });
  const first = subjects.bind("s1", subject);
  const second = subjects.bind("s1", other);
  writes[0]!({ subject });
  await first;
  expect(answered).toEqual([]);
  expect(subjects.get("s1")).toEqual(other);
  writes[1]!({ subject: other });
  await second;
  expect(answered).toEqual([other]);
  expect(subjects.get("s1")).toBeUndefined();
});

test("a keryx that stores the subject answers it and no notice is shown", async () => {
  const app = fakeApp();
  await openSubjectSession(app.deps, subject, "latest", url);
  await Promise.resolve();
  expect(app.notices).toEqual([]);
  expect(app.stored[0]?._meta?.keryx?.subject).toEqual(subject);
  expect(app.subjects.get("s1")).toBeUndefined();
});
