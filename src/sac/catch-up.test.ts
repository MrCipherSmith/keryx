// RED tests for flow 165 (Slate Phase 5), Track B item 7: the catch-up
// classifier (SLATE-10) and this flow's frozen AC1-AC5.
//
// `./catch-up` does not exist yet (task-implementer's Track B creates it) —
// this whole file fails at IMPORT time until then, mirroring the RED-file
// convention already used elsewhere in this codebase (e.g.
// `slate-terminal-state.test.ts`: "the missing-module import is the expected
// RED failure for the WHOLE file, not a per-test bug").
//
// PINNED API (plan.md Track B item 7, cross-checked against
// docs/requirements/slate/specification.md's `CatchUpItem` union):
//   export async function buildCatchUp(input: { cwd: string; workspaceId?: string }): Promise<CatchUpReport>;
//   type CatchUpReport = {
//     proposals: Array<{ type: "proposal"; workspaceId: string; proposalId: string; fresh: boolean }>;
//     blocked: Array<{ type: "blocked"; sessionId: string; workspaceId?: string; terminalState: TerminalState }>;
//     unboundCandidates: Array<{ type: "unbound-candidate"; sessionId: string; evidencePath: string; summary: string }>;
//     unknown: Array<{ type: "unknown"; sessionId: string; workspaceId?: string; lastSeenAt: string }>;
//   };
// Four fields ALWAYS present as arrays (AC2), never merged/interleaved.
// Session-derived categories (blocked/unbound-candidate/unknown) are mutually
// exclusive per session, priority order: terminal-state.json > slate-archive
// unbound-candidate artifact > isLockHeld (excludes entirely) > unknown.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildCatchUp } from "./catch-up";
import { ProposalLifecycleService } from "./proposal-lifecycle";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "./workspace-service";
import { createTrustedWrapUpAuthority } from "./trusted-wrap-up";
import { createSession } from "../session/store";
import { openSlateAtomic, slateLockPath, writeSlate } from "../session/slate";

const LOCAL_STRICT = { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" } as const;

let dataDir = "";
let originalDataDir: string | undefined;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "keryx-catchup-data-"));
  originalDataDir = process.env.KERYX_DATA_DIR;
  process.env.KERYX_DATA_DIR = dataDir;
});

afterEach(async () => {
  if (originalDataDir !== undefined) process.env.KERYX_DATA_DIR = originalDataDir;
  else delete process.env.KERYX_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

async function tempCwd(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function ensureWorkspace(cwd: string, id: string, title = id) {
  const workspaces = new WorkspaceService({ workspaceRoot: cwd, authorizationServer: localWorkspaceAuthorizationServer(), strictGuard: LOCAL_STRICT });
  try {
    return await workspaces.show({ request: undefined, requestCorrelationId: randomUUID(), workspaceId: id });
  } catch {
    return workspaces.create({ request: undefined, requestCorrelationId: randomUUID(), id, title });
  }
}

async function archiveWorkspace(cwd: string, id: string): Promise<void> {
  const workspaces = new WorkspaceService({ workspaceRoot: cwd, authorizationServer: localWorkspaceAuthorizationServer(), strictGuard: LOCAL_STRICT });
  await workspaces.archive({ request: undefined, requestCorrelationId: randomUUID(), workspaceId: id });
}

/** Creates a real pending proposal via the real ProposalLifecycleService — the same local composition `commands/workspace.ts`'s `propose` subcommand uses (`localWorkspaceAuthorizationServer()`), so the actor buildCatchUp resolves internally always has real access to it. */
async function proposeInWorkspace(cwd: string, workspaceId: string, proposalId: string): Promise<{ evidencePath: string }> {
  await ensureWorkspace(cwd, workspaceId);
  const evidenceRel = `./evidence/${proposalId}.md`;
  const evidenceAbs = path.join(cwd, "evidence", `${proposalId}.md`);
  await mkdir(path.dirname(evidenceAbs), { recursive: true });
  const content = `evidence for ${proposalId}`;
  await writeFile(evidenceAbs, content);
  const revision = createHash("sha256").update(content).digest("hex");
  const authorizationServer = localWorkspaceAuthorizationServer();
  const workspaces = new WorkspaceService({ workspaceRoot: cwd, authorizationServer, strictGuard: LOCAL_STRICT });
  const wrapUpAuthority = createTrustedWrapUpAuthority({
    resolveExplicitWrapUp: async () => ({
      workspaceId,
      sourceRevision: "r1",
      summary: `summary for ${proposalId}`,
      evidence: [{ kind: "evidence", uri: evidenceRel, revision, observedAt: new Date().toISOString() }],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  });
  const service = new ProposalLifecycleService({
    workspaceRoot: cwd,
    workspaces,
    authorizationServer,
    guard: LOCAL_STRICT,
    policyRef: "./security/policy/local",
    policyRevision: "local-offline-v1",
    targetWriters: {},
    wrapUpAuthority,
  });
  const actor = await authorizationServer.actorContextFor(undefined, randomUUID());
  if (!actor) throw new Error("test setup: local actor resolution failed");
  const wrapUp = await wrapUpAuthority.issue({ actor, source: "session", sourceRef: `./sessions/${proposalId}` });
  await service.create({ request: undefined, requestCorrelationId: randomUUID(), workspaceId, id: proposalId, proposalRevision: "1", kind: "follow-up", wrapUp });
  return { evidencePath: evidenceAbs };
}

function terminalStateFixture(overrides: Record<string, unknown> = {}) {
  return {
    status: "blocked",
    reason: "budget_exhausted",
    courseSnapshot: {},
    anchorsSnapshot: { root: "", touched: [] },
    occurredAt: "2026-08-16T00:00:00.000Z",
    ...overrides,
  };
}

async function makeBlockedSession(cwd: string, title = "blocked session"): Promise<{ sessionId: string; dir: string }> {
  const handle = createSession({ cwd, title });
  await writeFile(path.join(handle.dir, "terminal-state.json"), `${JSON.stringify(terminalStateFixture())}\n`);
  return { sessionId: handle.summary.id, dir: handle.dir };
}

async function makeUnboundCandidateSession(cwd: string, title = "unbound candidate session"): Promise<{ sessionId: string; dir: string }> {
  const handle = createSession({ cwd, title });
  const archiveDir = path.join(handle.dir, "slate-archive");
  await mkdir(archiveDir, { recursive: true });
  const content = {
    recordType: "unbound-candidate",
    trigger: "close",
    generatedAt: "2026-08-16T00:00:00.000Z",
    groups: [{ kind: "follow-up", seeds: [{ text: "an untriaged seed nobody has bound to a workspace yet", source: "seed" }] }],
  };
  await writeFile(path.join(archiveDir, "2026-08-16T00-00-00-000Z-unbound-candidate.json"), `${JSON.stringify(content, null, 2)}\n`);
  return { sessionId: handle.summary.id, dir: handle.dir };
}

async function makeUnknownSession(cwd: string, title = "unknown session"): Promise<{ sessionId: string; dir: string }> {
  const handle = createSession({ cwd, title });
  await writeSlate(handle.dir, () => ({ anchors: { root: cwd, touched: [] }, course: {}, seeds: [] }));
  return { sessionId: handle.summary.id, dir: handle.dir };
}

async function makeNoEngagementSession(cwd: string, title = "ordinary chat, no slate ever opened"): Promise<string> {
  const handle = createSession({ cwd, title });
  return handle.summary.id;
}

async function plantLock(dir: string, opts: { pid: number; ageMs?: number }): Promise<void> {
  const lockPath = slateLockPath(dir);
  await mkdir(lockPath, { recursive: true });
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: opts.pid, token: randomUUID() }));
  if (opts.ageMs !== undefined) {
    const aged = new Date(Date.now() - opts.ageMs);
    await utimes(lockPath, aged, aged);
  }
}

async function definitelyDeadPid(): Promise<number> {
  const proc = Bun.spawn(["sh", "-c", "exit 0"], { stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return proc.pid;
}

function sessionIds(items: Array<{ sessionId: string }>): string[] {
  return items.map((item) => item.sessionId);
}

// --- AC2: always four hard-separated arrays --------------------------------

test("AC2: buildCatchUp always returns four array fields — proposals/blocked/unboundCandidates/unknown — even when nothing is on disk", async () => {
  const cwd = await tempCwd("keryx-catchup-empty-");
  const report = await buildCatchUp({ cwd });
  expect(Array.isArray(report.proposals)).toBe(true);
  expect(Array.isArray(report.blocked)).toBe(true);
  expect(Array.isArray(report.unboundCandidates)).toBe(true);
  expect(Array.isArray(report.unknown)).toBe(true);
  expect(report.proposals).toEqual([]);
  expect(report.blocked).toEqual([]);
  expect(report.unboundCandidates).toEqual([]);
  expect(report.unknown).toEqual([]);
});

test("AC2: one item per category lands in its own section with the right discriminant 'type', and no sessionId is ever shared across the three session-derived sections", async () => {
  const cwd = await tempCwd("keryx-catchup-shape-");
  await proposeInWorkspace(cwd, "workspace-shape", "proposal-shape-1");
  const blocked = await makeBlockedSession(cwd);
  const unbound = await makeUnboundCandidateSession(cwd);
  const unknown = await makeUnknownSession(cwd);

  const report = await buildCatchUp({ cwd });

  const proposalItem = report.proposals.find((item) => item.proposalId === "proposal-shape-1");
  expect(proposalItem).toBeDefined();
  expect(proposalItem?.type).toBe("proposal");

  const blockedItem = report.blocked.find((item) => item.sessionId === blocked.sessionId);
  expect(blockedItem).toBeDefined();
  expect(blockedItem?.type).toBe("blocked");

  const unboundItem = report.unboundCandidates.find((item) => item.sessionId === unbound.sessionId);
  expect(unboundItem).toBeDefined();
  expect(unboundItem?.type).toBe("unbound-candidate");

  const unknownItem = report.unknown.find((item) => item.sessionId === unknown.sessionId);
  expect(unknownItem).toBeDefined();
  expect(unknownItem?.type).toBe("unknown");

  const acrossSections = [...sessionIds(report.blocked), ...sessionIds(report.unboundCandidates), ...sessionIds(report.unknown)];
  expect(new Set(acrossSections).size).toBe(acrossSections.length);
});

test("an ordinary interactive session that never opened a slate is silently excluded from every category, never surfaced as 'unknown'", async () => {
  const cwd = await tempCwd("keryx-catchup-noengage-");
  const plainId = await makeNoEngagementSession(cwd);
  const report = await buildCatchUp({ cwd });
  const everySessionId = [...sessionIds(report.blocked), ...sessionIds(report.unboundCandidates), ...sessionIds(report.unknown)];
  expect(everySessionId).not.toContain(plainId);
});

test("priority order: a session with BOTH a terminal-state.json AND an unbound-candidate artifact is classified 'blocked' only — terminal-state wins over unbound-candidate", async () => {
  const cwd = await tempCwd("keryx-catchup-priority-");
  const handle = await makeBlockedSession(cwd, "both signals");
  const archiveDir = path.join(handle.dir, "slate-archive");
  await mkdir(archiveDir, { recursive: true });
  await writeFile(
    path.join(archiveDir, "2026-08-16T00-00-00-000Z-unbound-candidate.json"),
    `${JSON.stringify({ recordType: "unbound-candidate", trigger: "close", generatedAt: "2026-08-16T00:00:00.000Z", groups: [] }, null, 2)}\n`,
  );

  const report = await buildCatchUp({ cwd });

  expect(sessionIds(report.blocked)).toContain(handle.sessionId);
  expect(sessionIds(report.unboundCandidates)).not.toContain(handle.sessionId);
});

// --- AC5: still-running (live-locked) sessions never appear in catch-up ----

test("AC5: a session with a currently-held (fresh-mtime) lock never appears in ANY of the four categories, specifically never 'unknown'", async () => {
  const cwd = await tempCwd("keryx-catchup-livelock-");
  const handle = await makeUnknownSession(cwd, "still running"); // slate.json present -> would otherwise be 'unknown'
  await plantLock(handle.dir, { pid: process.pid }); // fresh mtime, alive owner (this test process)

  const report = await buildCatchUp({ cwd });

  const everySessionId = [...sessionIds(report.blocked), ...sessionIds(report.unboundCandidates), ...sessionIds(report.unknown)];
  expect(everySessionId).not.toContain(handle.sessionId);
});

test("AC5: a STALE lock with a DEAD owner pid DOES fall through to a real category ('unknown' here) — isLockHeld distinguishes live-vs-crashed, not just 'lock dir exists'", async () => {
  const cwd = await tempCwd("keryx-catchup-deadlock-");
  const handle = await makeUnknownSession(cwd, "crashed while holding a lock");
  const deadPid = await definitelyDeadPid();
  await plantLock(handle.dir, { pid: deadPid, ageMs: 40_000 }); // older than the 30s default stale threshold

  const report = await buildCatchUp({ cwd });

  expect(sessionIds(report.unknown)).toContain(handle.sessionId);
});

// --- F-002 review fix: lock-held check runs BEFORE terminal-state, and a ---
// --- fresh re-open clears a stale terminal-state.json ----------------------

test("F-002 fix: a session with BOTH terminal-state.json AND a currently-held fresh lock is excluded entirely — never shown as 'blocked' (a resumed session now actively running)", async () => {
  const cwd = await tempCwd("keryx-catchup-blocked-and-locked-");
  const handle = await makeBlockedSession(cwd, "resumed and now actively running");
  await plantLock(handle.dir, { pid: process.pid }); // fresh mtime, alive owner (this test process) — genuinely running right now

  const report = await buildCatchUp({ cwd });

  const everySessionId = [...sessionIds(report.blocked), ...sessionIds(report.unboundCandidates), ...sessionIds(report.unknown)];
  expect(everySessionId).not.toContain(handle.sessionId);
});

test("F-002 fix: a fresh re-open (openSlateAtomic, the real call ensureSlateOpened/openSlate make on resume) clears a prior terminal-state.json — the session no longer appears as 'blocked' afterward", async () => {
  const cwd = await tempCwd("keryx-catchup-cleared-terminal-state-");
  const handle = await makeBlockedSession(cwd, "was blocked, now resumed and reopened");

  await openSlateAtomic(handle.dir, () => "resume-attempt-1", () => ({ anchors: { root: cwd, touched: [] }, course: {}, seeds: [] }));

  const report = await buildCatchUp({ cwd });

  expect(sessionIds(report.blocked)).not.toContain(handle.sessionId);
  // The clearing is real, not an accidental disappearance: the session now
  // has a live slate.json (from the re-open above) and no lock held, so it
  // falls through to a genuine category ('unknown') rather than vanishing.
  expect(sessionIds(report.unknown)).toContain(handle.sessionId);
});

// --- AC3: evidence-freshness re-checked BEFORE display, not only at accept -

test("AC3: a proposal's pinned evidence mutated on disk AFTER creation is reported fresh:false BEFORE any review/accept call ever happens", async () => {
  const cwd = await tempCwd("keryx-catchup-stale-evidence-");
  const { evidencePath } = await proposeInWorkspace(cwd, "workspace-stale", "proposal-stale-1");

  // Drift the evidence AFTER the proposal pinned its revision hash — no
  // accept/review call has ever run against this proposal.
  await writeFile(evidencePath, "the evidence content has changed since the proposal pinned it");

  const report = await buildCatchUp({ cwd });
  const item = report.proposals.find((entry) => entry.proposalId === "proposal-stale-1");
  expect(item).toBeDefined();
  expect(item?.fresh).toBe(false);
});

test("AC3 control: an UN-mutated proposal's evidence is reported fresh:true", async () => {
  const cwd = await tempCwd("keryx-catchup-fresh-evidence-");
  await proposeInWorkspace(cwd, "workspace-fresh", "proposal-fresh-1");

  const report = await buildCatchUp({ cwd });
  const item = report.proposals.find((entry) => entry.proposalId === "proposal-fresh-1");
  expect(item).toBeDefined();
  expect(item?.fresh).toBe(true);
});

// --- AC1: archived workspaces never silently lose discoverability ---------

test("AC1: a pending proposal in an ARCHIVED workspace surfaces in catch-up's proposals[] identically to one in an active workspace", async () => {
  const cwd = await tempCwd("keryx-catchup-archived-");
  await proposeInWorkspace(cwd, "workspace-active-ac1", "proposal-active-ac1");
  await proposeInWorkspace(cwd, "workspace-archived-ac1", "proposal-archived-ac1");
  await archiveWorkspace(cwd, "workspace-archived-ac1");

  const report = await buildCatchUp({ cwd });

  const activeItem = report.proposals.find((entry) => entry.proposalId === "proposal-active-ac1");
  const archivedItem = report.proposals.find((entry) => entry.proposalId === "proposal-archived-ac1");
  expect(activeItem).toBeDefined();
  expect(archivedItem).toBeDefined();
  expect(archivedItem?.workspaceId).toBe("workspace-archived-ac1");
  // "Identically" — the archived item is the same shape as the active one,
  // not a degraded/partial record because its workspace happens to be archived.
  expect(Object.keys(archivedItem ?? {}).sort()).toEqual(Object.keys(activeItem ?? {}).sort());
  expect(archivedItem?.fresh).toBe(activeItem?.fresh);
});

// --- AC4: cwd-scoped only, no cross-project leakage ------------------------

test("AC4: catch-up invoked from cwd A never surfaces a proposal or session that only exists under cwd B", async () => {
  const cwdA = await tempCwd("keryx-catchup-cwd-a-");
  const cwdB = await tempCwd("keryx-catchup-cwd-b-");
  await proposeInWorkspace(cwdA, "workspace-a-only", "proposal-a-only");
  await proposeInWorkspace(cwdB, "workspace-b-only", "proposal-b-only");
  const blockedA = await makeBlockedSession(cwdA, "blocked in A");
  const blockedB = await makeBlockedSession(cwdB, "blocked in B");

  const reportA = await buildCatchUp({ cwd: cwdA });
  const reportB = await buildCatchUp({ cwd: cwdB });

  expect(reportA.proposals.some((item) => item.proposalId === "proposal-a-only")).toBe(true);
  expect(reportA.proposals.some((item) => item.proposalId === "proposal-b-only")).toBe(false);
  expect(sessionIds(reportA.blocked)).toContain(blockedA.sessionId);
  expect(sessionIds(reportA.blocked)).not.toContain(blockedB.sessionId);

  expect(reportB.proposals.some((item) => item.proposalId === "proposal-b-only")).toBe(true);
  expect(reportB.proposals.some((item) => item.proposalId === "proposal-a-only")).toBe(false);
  expect(sessionIds(reportB.blocked)).toContain(blockedB.sessionId);
  expect(sessionIds(reportB.blocked)).not.toContain(blockedA.sessionId);
});

// --- --workspace scoping ----------------------------------------------------

test("--workspace scoping: buildCatchUp({ workspaceId }) restricts proposals[] to that one workspace only", async () => {
  const cwd = await tempCwd("keryx-catchup-scope-");
  await proposeInWorkspace(cwd, "workspace-scope-one", "proposal-scope-one");
  await proposeInWorkspace(cwd, "workspace-scope-two", "proposal-scope-two");

  const scoped = await buildCatchUp({ cwd, workspaceId: "workspace-scope-one" });

  expect(scoped.proposals.map((item) => item.proposalId)).toEqual(["proposal-scope-one"]);
});

test("--workspace scoping: an invisible/unknown workspace id yields an EMPTY proposals section, not an error — never leaks whether the id exists", async () => {
  const cwd = await tempCwd("keryx-catchup-scope-unknown-");
  await proposeInWorkspace(cwd, "workspace-scope-real", "proposal-scope-real");

  await expect(buildCatchUp({ cwd, workspaceId: "workspace-does-not-exist" })).resolves.toMatchObject({ proposals: [] });
});

// --- unbound-candidate item shape -------------------------------------------

test("unbound-candidate items carry evidencePath and summary per the spec's CatchUpItem shape", async () => {
  const cwd = await tempCwd("keryx-catchup-unbound-shape-");
  const { sessionId } = await makeUnboundCandidateSession(cwd);
  const report = await buildCatchUp({ cwd });
  const item = report.unboundCandidates.find((entry) => entry.sessionId === sessionId);
  expect(item).toBeDefined();
  expect(typeof item?.evidencePath).toBe("string");
  expect(item?.evidencePath).toContain("slate-archive");
  expect(typeof item?.summary).toBe("string");
});

// --- blocked item shape ------------------------------------------------------

test("blocked items carry the real parsed TerminalState, not merely a boolean flag", async () => {
  const cwd = await tempCwd("keryx-catchup-blocked-shape-");
  const { sessionId } = await makeBlockedSession(cwd);
  const report = await buildCatchUp({ cwd });
  const item = report.blocked.find((entry) => entry.sessionId === sessionId);
  expect(item).toBeDefined();
  expect(item?.terminalState).toMatchObject({ status: "blocked", reason: "budget_exhausted" });
});

// --- F-003 fix: workspaceId is populated on blocked and unknown items --------

test("F-003 fix: blocked items populated with workspaceId from slate.json when bound", async () => {
  const cwd = await tempCwd("keryx-catchup-f003-blocked-");
  const handle = await makeBlockedSession(cwd, "blocked with workspace binding");

  // Write a slate.json with a workspaceId (simulating a bound session)
  const workspaceId = "workspace-f003-blocked";
  await writeSlate(handle.dir, () => ({
    anchors: { root: cwd, touched: [] },
    course: {},
    seeds: [],
    workspaceId,
  }));

  const report = await buildCatchUp({ cwd });
  const item = report.blocked.find((entry) => entry.sessionId === handle.sessionId);
  expect(item).toBeDefined();
  expect(item?.workspaceId).toBe(workspaceId);
});

test("F-003 fix: unknown items populated with workspaceId from slate.json when bound", async () => {
  const cwd = await tempCwd("keryx-catchup-f003-unknown-");
  const handle = await makeUnknownSession(cwd, "unknown with workspace binding");

  // Update the slate.json to include a workspaceId
  const workspaceId = "workspace-f003-unknown";
  await writeSlate(handle.dir, () => ({
    anchors: { root: cwd, touched: [] },
    course: {},
    seeds: [],
    workspaceId,
  }));

  const report = await buildCatchUp({ cwd });
  const item = report.unknown.find((entry) => entry.sessionId === handle.sessionId);
  expect(item).toBeDefined();
  expect(item?.workspaceId).toBe(workspaceId);
});
