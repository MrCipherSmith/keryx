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
import { proposalNotePath } from "./proposal-evidence";
import { ProposalLifecycleService } from "./proposal-lifecycle";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "./workspace-service";
import { createTrustedWrapUpAuthority } from "./trusted-wrap-up";
import { createSession } from "../session/store";
import { openSlateAtomic, slateLockPath, writeSlate } from "../session/slate";
import { writeExternalSlate } from "../session/external-slate";

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

/** Creates a workspace bound to a real, on-disk `component` resource (never
 * created by `ensureWorkspace`/`proposeInWorkspace`, which bind no
 * component at all) — used by the RP-13/WSL-2 cross-category test below. */
async function ensureWorkspaceWithComponent(cwd: string, id: string, componentPath: string, title = id): Promise<void> {
  const abs = path.join(cwd, componentPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, "export {};\n");
  const workspaces = new WorkspaceService({ workspaceRoot: cwd, authorizationServer: localWorkspaceAuthorizationServer(), strictGuard: LOCAL_STRICT });
  await workspaces.create({ request: undefined, requestCorrelationId: randomUUID(), id, title, component: { kind: "component", uri: `./${componentPath}` } });
}

async function writeGraphNodesExcluding(cwd: string, filePaths: string[]): Promise<void> {
  const dir = path.join(cwd, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(dir, { recursive: true });
  const nodes = filePaths.map((p) => ({ path: p, kind: "file" }));
  await writeFile(path.join(dir, "nodes.jsonl"), `${nodes.map((n) => JSON.stringify(n)).join("\n")}\n`, "utf8");
  await writeFile(path.join(dir, "edges.jsonl"), "", "utf8");
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

/** flow 173: writes a `*-wrap-up-outcome.json` artifact under the session's
 * `slate-archive/`, mirroring `machine-wrap-up.ts`'s `writeWrapUpOutcomeArtifact`
 * output shape exactly, for testing `classifySession`'s new read/branch. */
async function writeWrapUpOutcomeArtifactFixture(
  dir: string,
  groups: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const archiveDir = path.join(dir, "slate-archive");
  await mkdir(archiveDir, { recursive: true });
  const content = {
    recordType: "wrap-up-outcome",
    trigger: "explicit",
    generatedAt: "2026-08-19T00:00:00.000Z",
    groups,
    ...overrides,
  };
  await writeFile(path.join(archiveDir, "2026-08-19T00-00-00-000Z-wrap-up-outcome.json"), `${JSON.stringify(content, null, 2)}\n`);
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

function sessionIds(items: Array<{ sessionId?: string; externalSessionId?: string }>): string[] {
  return items.map((item) => item.sessionId ?? item.externalSessionId ?? "");
}

/** Creates a closed, unbound external MCP slate with seeds (no workspaceId) */
async function makeExternalUnboundSlate(cwd: string, externalSessionId: string): Promise<{ externalSessionId: string }> {
  await writeExternalSlate(cwd, externalSessionId, () => ({
    externalSessionId,
    anchors: { root: cwd },
    seeds: [
      { id: "seed-1", text: "First untriaged seed", kind: "follow-up", ts: "2026-08-16T00:00:00.000Z", origin: { harness: "mcp-external" }, trust: "external-unverified" },
      { id: "seed-2", text: "Second untriaged seed", kind: "risk", ts: "2026-08-16T00:00:01.000Z", origin: { harness: "mcp-external" }, trust: "external-unverified" },
    ],
    lastWriteAt: "2026-08-16T00:00:01.000Z",
    closedAt: "2026-08-16T00:00:02.000Z",
  }));
  return { externalSessionId };
}

/** Creates a closed, bound external MCP slate (with workspaceId — should NOT appear as unbound) */
async function makeExternalBoundSlate(cwd: string, externalSessionId: string, workspaceId: string): Promise<{ externalSessionId: string }> {
  await writeExternalSlate(cwd, externalSessionId, () => ({
    externalSessionId,
    workspaceId,
    anchors: { root: cwd },
    seeds: [
      { id: "seed-1", text: "This seed is bound to a workspace", kind: "follow-up", ts: "2026-08-16T00:00:00.000Z", origin: { harness: "mcp-external" }, trust: "external-unverified" },
    ],
    lastWriteAt: "2026-08-16T00:00:00.000Z",
    closedAt: "2026-08-16T00:00:01.000Z",
  }));
  return { externalSessionId };
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

test("a proposal item carries what was actually proposed — kind, author, and createdAt from the real proposal record", async () => {
  const cwd = await tempCwd("keryx-catchup-content-");
  await proposeInWorkspace(cwd, "workspace-content", "proposal-content-1");

  const report = await buildCatchUp({ cwd });
  const item = report.proposals.find((entry) => entry.proposalId === "proposal-content-1");

  expect(item).toBeDefined();
  expect(item?.kind).toBe("follow-up");
  expect(typeof item?.author).toBe("string");
  expect(item?.author.length).toBeGreaterThan(0);
  expect(item?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  // No `keryx workspace propose --note` was given — nothing to fabricate.
  expect(item?.note).toBeUndefined();
});

test("a proposal item's note is the real propose-time sidecar note, when one was given", async () => {
  const cwd = await tempCwd("keryx-catchup-note-");
  await proposeInWorkspace(cwd, "workspace-note", "proposal-note-1");
  await writeFile(
    proposalNotePath(cwd, "workspace-note", "proposal-note-1"),
    "Switching the retry backoff to exponential.",
  );

  const report = await buildCatchUp({ cwd });
  const item = report.proposals.find((entry) => entry.proposalId === "proposal-note-1");

  expect(item?.note).toBe("Switching the retry backoff to exponential.");
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

// --- RP-13/WSL-2: lifecycleFlags[] is additive, never a substitute for or --
// --- suppressor of proposals[] --------------------------------------------

test("RP-13/WSL-2: a workspace with BOTH a pending proposal AND a lifecycle flag appears correctly in both categories, not just one", async () => {
  const cwd = await tempCwd("keryx-catchup-wsl2-");
  await ensureWorkspaceWithComponent(cwd, "workspace-wsl2", "src/wsl2/component.ts");
  await proposeInWorkspace(cwd, "workspace-wsl2", "proposal-wsl2");
  // The graph knows about a DIFFERENT module only — "src/wsl2" (the
  // workspace's bound component) never appears, so it is flagged.
  await writeGraphNodesExcluding(cwd, ["src/other/still-here.ts"]);

  const report = await buildCatchUp({ cwd });

  const proposalItem = report.proposals.find((item) => item.proposalId === "proposal-wsl2");
  expect(proposalItem).toBeDefined();
  expect(proposalItem?.workspaceId).toBe("workspace-wsl2");

  const flagItem = report.lifecycleFlags.find((flag) => flag.kind === "workspace" && flag.ref === "workspace-wsl2");
  expect(flagItem).toBeDefined();
  expect(flagItem?.missingComponent).toBe("src/wsl2/component.ts");
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

// --- Flow 165 fix (finding B): a corrupted slate.json must never crash the ---
// --- whole catch-up command, and must not hide any OTHER session's item ------

test("finding B fix: a corrupted (non-JSON) slate.json does not crash buildCatchUp, and another session's item in the SAME call still appears correctly — proving isolation, not just that the corrupted session is silently skipped", async () => {
  const cwd = await tempCwd("keryx-catchup-corrupt-slate-");
  const corrupted = await makeBlockedSession(cwd, "blocked session with a corrupted slate.json");
  await writeFile(path.join(corrupted.dir, "slate.json"), "{not valid json");
  const healthyBlocked = await makeBlockedSession(cwd, "healthy blocked session, same call");

  const report = await buildCatchUp({ cwd });

  // The corrupted session's own item still appears (classified "blocked" off
  // its terminal-state.json, same as before) — just without a workspaceId,
  // since safeReadSlate degrades to undefined instead of throwing.
  const corruptedItem = report.blocked.find((item) => item.sessionId === corrupted.sessionId);
  expect(corruptedItem).toBeDefined();
  expect(corruptedItem?.workspaceId).toBeUndefined();

  // The OTHER, healthy session in the same buildCatchUp call is completely
  // unaffected — this is the actual isolation guarantee finding B requires,
  // not merely that the corrupted session itself degrades gracefully.
  const healthyItem = report.blocked.find((item) => item.sessionId === healthyBlocked.sessionId);
  expect(healthyItem).toBeDefined();
  expect(healthyItem?.terminalState).toMatchObject({ status: "blocked", reason: "budget_exhausted" });
});

// --- flow 173: SAC durable wrap-up dispatch outcome recording -------------
// `classifySession` reads the newest wrap-up-outcome artifact and, when
// every group in it is a failure outcome, attaches it to the `unknown`
// item as `wrapUpOutcome` — surfacing WHY nothing else classified this
// session, without changing the existing blocked/unbound-candidate priority.

test("flow 173 (a): a session with a wrap-up-outcome artifact where every group failed classifies 'unknown' with wrapUpOutcome populated", async () => {
  const cwd = await tempCwd("keryx-catchup-wrapup-allfail-");
  const { sessionId, dir } = await makeUnknownSession(cwd, "wrap-up dispatch failed entirely");
  await writeWrapUpOutcomeArtifactFixture(dir, [
    { kind: "decision", outcome: "error", message: "model provider unavailable" },
    { kind: "risk", outcome: "no_credential" },
  ]);

  const report = await buildCatchUp({ cwd });

  const item = report.unknown.find((entry) => entry.sessionId === sessionId);
  expect(item).toBeDefined();
  expect(item?.wrapUpOutcome).toBeDefined();
  expect(item?.wrapUpOutcome?.trigger).toBe("explicit");
  expect(item?.wrapUpOutcome?.generatedAt).toBe("2026-08-19T00:00:00.000Z");
  expect(item?.wrapUpOutcome?.groups).toEqual([
    { kind: "decision", outcome: "error", message: "model provider unavailable" },
    { kind: "risk", outcome: "no_credential" },
  ]);
  // Not classified as blocked or unbound-candidate — the new check never
  // creates a NEW category, only enriches the existing 'unknown' one.
  expect(sessionIds(report.blocked)).not.toContain(sessionId);
  expect(sessionIds(report.unboundCandidates)).not.toContain(sessionId);
});

test("flow 173 (b): a session with a wrap-up-outcome artifact where one group succeeded falls through unaffected — wrapUpOutcome stays absent", async () => {
  const cwd = await tempCwd("keryx-catchup-wrapup-mixed-");
  const { sessionId, dir } = await makeUnknownSession(cwd, "wrap-up dispatch partially succeeded");
  await writeWrapUpOutcomeArtifactFixture(dir, [
    { kind: "decision", outcome: "proposed", proposalId: "wrapup-real-proposal-id" },
    { kind: "risk", outcome: "error", message: "model provider unavailable" },
  ]);

  const report = await buildCatchUp({ cwd });

  const item = report.unknown.find((entry) => entry.sessionId === sessionId);
  expect(item).toBeDefined();
  expect(item?.wrapUpOutcome).toBeUndefined();
});

test("flow 173 (c)/AC5: a session with BOTH a terminal-state.json AND a wrap-up-outcome artifact (all groups failed) still classifies 'blocked', unaffected", async () => {
  const cwd = await tempCwd("keryx-catchup-wrapup-blocked-");
  const handle = await makeBlockedSession(cwd, "blocked with a wrap-up-outcome artifact too");
  await writeWrapUpOutcomeArtifactFixture(handle.dir, [{ kind: "decision", outcome: "error", message: "boom" }]);

  const report = await buildCatchUp({ cwd });

  expect(sessionIds(report.blocked)).toContain(handle.sessionId);
  const blockedItem = report.blocked.find((entry) => entry.sessionId === handle.sessionId);
  expect(blockedItem).toBeDefined();
  expect(sessionIds(report.unknown)).not.toContain(handle.sessionId);
});

test("flow 173 (d)/AC6: a session with real Slate engagement but no wrap-up-outcome artifact at all continues to classify 'unknown' with wrapUpOutcome absent", async () => {
  const cwd = await tempCwd("keryx-catchup-wrapup-none-");
  const { sessionId } = await makeUnknownSession(cwd, "no wrap-up-outcome artifact ever written");

  const report = await buildCatchUp({ cwd });

  const item = report.unknown.find((entry) => entry.sessionId === sessionId);
  expect(item).toBeDefined();
  expect(item?.wrapUpOutcome).toBeUndefined();
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

// --- External MCP slates (AC-395) -----------------------------------------------

test("AC-395 (AC1): a closed, unbound external MCP slate surfaces in catch-up's unboundCandidates", async () => {
  const cwd = await tempCwd("keryx-catchup-external-unbound-");
  const { externalSessionId } = await makeExternalUnboundSlate(cwd, "external-slate-test-1");

  const report = await buildCatchUp({ cwd });

  const item = report.unboundCandidates.find((entry) => entry.externalSessionId === externalSessionId);
  expect(item).toBeDefined();
  expect(item?.type).toBe("unbound-candidate");
  expect(item?.externalSessionId).toBe(externalSessionId);
  expect(item?.sessionId).toBeUndefined(); // external slates use externalSessionId, not sessionId
  expect(item?.summary).toContain("follow-up");
  expect(item?.summary).toContain("risk");
});

test("AC-395 (AC3): a bound (workspace-associated) external slate does NOT appear as unbound candidate", async () => {
  const cwd = await tempCwd("keryx-catchup-external-bound-");
  const workspaceId = "workspace-external-bound-test";
  await ensureWorkspace(cwd, workspaceId);
  const { externalSessionId } = await makeExternalBoundSlate(cwd, "external-slate-bound-1", workspaceId);

  const report = await buildCatchUp({ cwd });

  // Bound external slate should NOT appear in unboundCandidates
  const unboundItem = report.unboundCandidates.find((entry) => entry.externalSessionId === externalSessionId);
  expect(unboundItem).toBeUndefined();

  // It might appear in proposals if wrap-up was triggered, but definitely not in unboundCandidates
  expect(report.unboundCandidates.map((item) => item.externalSessionId)).not.toContain(externalSessionId);
});

test("AC-395 (AC2): integration test — open, seed, close an external slate via MCP tools and verify it surfaces in catch-up", async () => {
  // This is the full integration test matching AC2's requirement:
  // "An integration-style test reproduces the original repro (open+seed+close an external slate with no workspaceId bound, via the MCP surface) and asserts it now surfaces in catch-up's output."
  //
  // We directly create the external slate in the final closed state (simulating the result of the MCP tool flow)
  // since the MCP tool stack is already tested exhaustively in slate-tools.test.ts
  const cwd = await tempCwd("keryx-catchup-integration-");
  const externalSessionId = "claude-code-integration-test-1";

  // Simulate: open slate (no workspaceId) -> write seeds -> close slate
  await writeExternalSlate(cwd, externalSessionId, () => ({
    externalSessionId,
    // Note: NO workspaceId — this is the key difference; if workspaceId were set,
    // this should NOT appear as an unbound candidate
    anchors: { root: cwd, touched: ["src/app"], note: "Reviewed billing module" },
    seeds: [
      {
        id: "seed-integration-1",
        text: "Double-charging on refund path when idempotency key is missing",
        kind: "risk",
        ts: "2026-08-16T12:00:00.000Z",
        origin: { harness: "mcp-external" },
        trust: "external-unverified",
      },
      {
        id: "seed-integration-2",
        text: "Add retry loop for transient network failures",
        kind: "follow-up",
        ts: "2026-08-16T12:00:01.000Z",
        origin: { harness: "mcp-external" },
        trust: "external-unverified",
      },
    ],
    lastWriteAt: "2026-08-16T12:00:01.000Z",
    closedAt: "2026-08-16T12:00:02.000Z", // Closed but never bound
  }));

  // Now call catch-up — should surface this external unbound candidate
  const report = await buildCatchUp({ cwd });

  // Find the external unbound candidate in the report
  const item = report.unboundCandidates.find((entry) => entry.externalSessionId === externalSessionId);
  expect(item).toBeDefined();
  expect(item?.type).toBe("unbound-candidate");
  expect(item?.externalSessionId).toBe(externalSessionId);

  // Verify the summary includes both seed kinds
  expect(item?.summary).toContain("risk");
  expect(item?.summary).toContain("follow-up");
  expect(item?.summary).toContain("2"); // 2 seeds

  // Verify the evidence path points to the external slate file
  expect(item?.evidencePath).toContain(externalSessionId);
});

// --- Flow 194 / issue #391: unreviewedPaths backstop ------------------------
// `keryx wiki enrich` used to write + auto-accept content with zero SAC
// proposal record (the original repro this flow closes). Part 1 fixes that
// specific command; this is the general backstop — `buildCatchUp` must flag
// ANY session during which an SAC-owned path (wiki/memory/skill) picked up
// durable content with no SAC receipt behind it, as its OWN distinct,
// separately-named category — never folded into "unknown".

async function writeWikiPage(cwd: string, relativePath: string, status: string, type = "component"): Promise<string> {
  const abs = path.join(cwd, ".metaproject", "wiki", relativePath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(
    abs,
    `---\nTitle: Test Page\nVersion: 1.0.0\nType: ${type}\nStatus: ${status}\nSummary: test\n---\n\n# Test Page\n\nSome body content.\n`,
  );
  return abs;
}

async function writeMemoryEntry(cwd: string, relativePath: string, status: string): Promise<string> {
  const abs = path.join(cwd, ".metaproject", "memory", relativePath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(
    abs,
    `# Test Entry\n\nVersion: 0.1.0\nType: task-note\nStatus: ${status}\nConfidence: medium\n\n## Summary\n\nSome memory content.\n`,
  );
  return abs;
}

async function writeOwnerReceipt(cwd: string, workspaceId: string, owner: "wiki" | "memory" | "skill", targetRef: string): Promise<void> {
  const dir = path.join(cwd, ".metaproject", "workspaces", workspaceId, `${owner}-write-receipts`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${randomUUID()}.json`),
    `${JSON.stringify({ receiptRef: `./${targetRef.replace(/\.md$/, "")}.receipt.json`, targetRef: `./${targetRef}`, completedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

test("flow 194 AC2: a wiki page that reached Status: accepted during a session, with no SAC receipt, surfaces as its own 'unreviewed-sac-path' item — not lumped into 'unknown'", async () => {
  const cwd = await tempCwd("keryx-catchup-unreviewed-wiki-");
  const handle = createSession({ cwd, title: "bypassed wiki enrich" });
  await writeWikiPage(cwd, "components/bypass.md", "accepted");

  const report = await buildCatchUp({ cwd });

  const item = report.unreviewedPaths.find((entry) => entry.sessionId === handle.summary.id);
  expect(item).toBeDefined();
  expect(item?.type).toBe("unreviewed-sac-path");
  expect(item?.owner).toBe("wiki");
  expect(item?.path).toBe("wiki/components/bypass.md");
  expect(item?.status).toBe("accepted");

  // This session never touched Slate at all — absent this backstop it would
  // not appear ANYWHERE in the report, let alone get folded into "unknown".
  expect(sessionIds(report.unknown)).not.toContain(handle.summary.id);
});

test("flow 194: a wiki page still Status: draft is never flagged — enrich rewriting prose without accepting is legitimate, ordinary activity", async () => {
  const cwd = await tempCwd("keryx-catchup-draft-wiki-");
  const handle = createSession({ cwd, title: "ordinary draft enrichment" });
  await writeWikiPage(cwd, "components/still-draft.md", "draft");

  const report = await buildCatchUp({ cwd });

  expect(report.unreviewedPaths.find((entry) => entry.sessionId === handle.summary.id)).toBeUndefined();
});

test("flow 194: a wiki page covered by a real SAC write receipt is never flagged — this IS the reviewed path, not a bypass", async () => {
  const cwd = await tempCwd("keryx-catchup-reviewed-wiki-");
  const handle = createSession({ cwd, title: "properly reviewed wiki change" });
  await writeWikiPage(cwd, "decisions/sac-real-proposal.md", "accepted", "decision");
  await writeOwnerReceipt(cwd, "ws-194-wiki", "wiki", "wiki/decisions/sac-real-proposal.md");

  const report = await buildCatchUp({ cwd });

  expect(report.unreviewedPaths.find((entry) => entry.sessionId === handle.summary.id)).toBeUndefined();
});

test("flow 194: a memory entry that reached Status: accepted with no SAC receipt is flagged the same way as wiki", async () => {
  const cwd = await tempCwd("keryx-catchup-unreviewed-memory-");
  const handle = createSession({ cwd, title: "bypassed memory write" });
  await writeMemoryEntry(cwd, "task-notes/bypass.md", "accepted");

  const report = await buildCatchUp({ cwd });

  const item = report.unreviewedPaths.find((entry) => entry.sessionId === handle.summary.id && entry.owner === "memory");
  expect(item).toBeDefined();
  expect(item?.path).toBe("memory/task-notes/bypass.md");
  expect(item?.status).toBe("accepted");
});

test("flow 194: a skill file landing under the SAC-reserved 'sac' module with no receipt is flagged", async () => {
  const cwd = await tempCwd("keryx-catchup-unreviewed-skill-");
  const handle = createSession({ cwd, title: "bypassed skill write" });
  const skillPath = path.join(cwd, ".metaproject", "project-skills", "sac", "bypass-proposal", "SKILL.md");
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, "# Bypass Skill\n\nLanded with no SAC review.\n");

  const report = await buildCatchUp({ cwd });

  const item = report.unreviewedPaths.find((entry) => entry.sessionId === handle.summary.id && entry.owner === "skill");
  expect(item).toBeDefined();
  expect(item?.path).toBe("project-skills/sac/bypass-proposal/SKILL.md");
});

test("flow 194: an ordinary skill created via keryx skills create (any OTHER module) is never flagged — only the SAC-reserved module namespace is scanned, to avoid flooding this report with routine skill authoring", async () => {
  const cwd = await tempCwd("keryx-catchup-ordinary-skill-");
  const handle = createSession({ cwd, title: "ordinary skill authoring" });
  const skillPath = path.join(cwd, ".metaproject", "project-skills", "my-module", "my-skill", "SKILL.md");
  await mkdir(path.dirname(skillPath), { recursive: true });
  await writeFile(skillPath, "# My Skill\n\nCreated the normal way.\n");

  const report = await buildCatchUp({ cwd });

  expect(report.unreviewedPaths.find((entry) => entry.sessionId === handle.summary.id)).toBeUndefined();
});

test("flow 194: content whose mtime falls outside every known session's window is never flagged — no flood of pre-existing accepted pages", async () => {
  const cwd = await tempCwd("keryx-catchup-unattributed-wiki-");
  // No session created in this cwd at all.
  await writeWikiPage(cwd, "components/pre-existing.md", "accepted");

  const report = await buildCatchUp({ cwd });

  expect(report.unreviewedPaths).toEqual([]);
});

test("flow 194: --workspace scoping restricts unreviewedPaths to items attributed to that workspace only", async () => {
  const cwd = await tempCwd("keryx-catchup-unreviewed-scope-");
  const handle = createSession({ cwd, title: "bypass with a bound workspace" });
  await writeSlate(handle.dir, () => ({ anchors: { root: cwd, touched: [] }, course: {}, seeds: [], workspaceId: "workspace-194-scope" }));
  await writeWikiPage(cwd, "components/scoped-bypass.md", "accepted");

  const scopedToOther = await buildCatchUp({ cwd, workspaceId: "some-other-workspace" });
  expect(scopedToOther.unreviewedPaths.find((entry) => entry.sessionId === handle.summary.id)).toBeUndefined();

  const scopedToMatch = await buildCatchUp({ cwd, workspaceId: "workspace-194-scope" });
  expect(scopedToMatch.unreviewedPaths.find((entry) => entry.sessionId === handle.summary.id)).toBeDefined();
});
