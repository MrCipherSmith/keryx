import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSession } from "../session/store";
import { writeSlate } from "../session/slate";
import { createFlowService } from "../flow/service";
import type { FlowServiceDeps } from "../flow/types";
import { acCheckCacheKey, acCheckCachePath, writeAcCheckCache } from "../flow/check-ac";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "../sac/workspace-service";
import type { CatchUpBlockedItem, CatchUpProposalItem, CatchUpReport } from "../sac/catch-up";
import {
  catchUpItems,
  flowsInSession,
  formatSessionFlowLines,
  formatWorkspaceLines,
  loadInspectorCatchUp,
  loadInspectorFlows,
  loadInspectorSlates,
  loadInspectorWorkspace,
  sortFlowsNewestFirst,
  sortSlatesNewestFirst,
  workspacesInSession,
  type FlowInspectorItem,
  type SlateInspectorItem,
  type WorkspaceInfo,
} from "./inspector-sources";

const ALPHA: WorkspaceInfo = {
  id: "workspace-alpha",
  title: "Alpha",
  status: "active",
  resources: [],
};
const BETA: WorkspaceInfo = {
  id: "workspace-beta",
  title: "Beta",
  status: "active",
  resources: [{ kind: "session", uri: "session:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }],
};

const FLOW: FlowInspectorItem = {
  id: "154",
  slug: "tui-modal-chrome",
  title: "Modal chrome",
  status: "in-progress",
  dir: ".metaproject/flows/154-tui-modal-chrome",
  tasksDone: 2,
  tasksTotal: 4,
  sessionIds: ["sess-1"],
  prUrl: null,
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
  source: "description",
  tasks: [{ id: "T1", title: "Do it", status: "done" }],
};

test("workspacesInSession keeps only mentioned or session-linked workspaces", () => {
  expect(workspacesInSession([ALPHA, BETA], { sessionText: "called workspace-alpha" }).map((w) => w.id)).toEqual([
    "workspace-alpha",
  ]);
  expect(
    workspacesInSession([ALPHA, BETA], { sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }).map((w) => w.id),
  ).toEqual(["workspace-beta"]);
  expect(workspacesInSession([ALPHA], { sessionText: "unrelated" })).toEqual([]);
});

test("flowsInSession matches runLink session ids and explicit flow mentions only", () => {
  expect(flowsInSession([FLOW], { sessionId: "sess-1" })).toHaveLength(1);
  expect(flowsInSession([FLOW], { sessionText: "see /flows 154" })).toHaveLength(1);
  expect(flowsInSession([FLOW], { sessionText: "random 154 in a uuid is not enough" })).toEqual([]);
});

test("empty formatters say so", () => {
  expect(formatWorkspaceLines([])[0]).toMatch(/no workspaces/i);
  expect(formatSessionFlowLines([])[0]).toMatch(/no flows/i);
});

test("sortFlowsNewestFirst is last-id first", () => {
  const older = { ...FLOW, id: "003", updatedAt: "2026-01-01T00:00:00.000Z" };
  const newer = { ...FLOW, id: "154", updatedAt: "2026-08-01T00:00:00.000Z" };
  expect(sortFlowsNewestFirst([older, newer]).map((item) => item.id)).toEqual(["154", "003"]);
});

const SLATE_ITEM: SlateInspectorItem = {
  sessionId: "sess-1",
  sessionTitle: "First",
  updatedAt: "2026-01-01T00:00:00.000Z",
  courseStatus: "active",
  seedCount: 0,
  touchedFiles: [],
  seeds: [],
};

test("sortSlatesNewestFirst is most-recently-updated first", () => {
  const older = { ...SLATE_ITEM, sessionId: "sess-1", updatedAt: "2026-01-01T00:00:00.000Z" };
  const newer = { ...SLATE_ITEM, sessionId: "sess-2", updatedAt: "2026-08-01T00:00:00.000Z" };
  expect(sortSlatesNewestFirst([older, newer]).map((item) => item.sessionId)).toEqual(["sess-2", "sess-1"]);
});

const LOCAL_STRICT = { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" } as const;

async function ensureWorkspace(cwd: string, id: string, title = id) {
  const workspaces = new WorkspaceService({ workspaceRoot: cwd, authorizationServer: localWorkspaceAuthorizationServer(), strictGuard: LOCAL_STRICT });
  return workspaces.create({ request: undefined, requestCorrelationId: randomUUID(), id, title });
}

test("loadInspectorWorkspace / loadInspectorSlates: real fixtures, real cross-session link", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "keryx-ws-inspector-data-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-ws-inspector-cwd-"));
  const originalDataDir = process.env.KERYX_DATA_DIR;
  process.env.KERYX_DATA_DIR = dataDir;
  try {
    await ensureWorkspace(cwd, "workspace-gamma", "Gamma");

    // One session bound to the workspace, one unbound — only the bound one
    // must show up in loadInspectorSlates.
    const bound = createSession({ cwd, title: "Bound session" });
    await writeSlate(bound.dir, () => ({
      workspaceId: "workspace-gamma",
      anchors: { root: cwd, touched: ["src/a.ts"] },
      course: { flowRef: "042" },
      seeds: [{ id: "seed-1", text: "note", ts: "2026-08-18T00:00:00.000Z", kind: "decision" }],
    }));
    const unbound = createSession({ cwd, title: "Unbound session" });
    await writeSlate(unbound.dir, () => ({
      anchors: { root: cwd, touched: [] },
      course: {},
      seeds: [],
    }));

    const workspace = await loadInspectorWorkspace(cwd, "workspace-gamma");
    expect(workspace?.title).toBe("Gamma");
    expect(await loadInspectorWorkspace(cwd, "no-such-workspace")).toBeUndefined();

    const slates = await loadInspectorSlates(cwd, "workspace-gamma");
    expect(slates.map((s) => s.sessionId)).toEqual([bound.summary.id]);
    expect(slates[0]?.flowRef).toBe("042");
    expect(slates[0]?.seedCount).toBe(1);
    expect(slates[0]?.touchedFiles).toEqual(["src/a.ts"]);

    expect(await loadInspectorSlates(cwd, "no-such-workspace")).toEqual([]);
  } finally {
    if (originalDataDir !== undefined) process.env.KERYX_DATA_DIR = originalDataDir;
    else delete process.env.KERYX_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

const PROPOSAL: CatchUpProposalItem = {
  type: "proposal",
  workspaceId: "ws-1",
  proposalId: "p-1",
  fresh: true,
  kind: "follow-up",
  author: "user:local-1",
  createdAt: "2026-08-16T00:00:00.000Z",
  note: undefined,
};
const BLOCKED: CatchUpBlockedItem = {
  type: "blocked",
  sessionId: "sess-1",
  terminalState: {
    status: "blocked",
    reason: "other",
    courseSnapshot: {},
    anchorsSnapshot: { root: "/tmp", touched: [] },
    occurredAt: "2026-08-16T00:00:00.000Z",
  },
};

test("catchUpItems concatenates proposals, blocked, unbound-candidates, unknown in that order — never lifecycleFlags", () => {
  const report: CatchUpReport = {
    proposals: [PROPOSAL],
    blocked: [BLOCKED],
    unboundCandidates: [{ type: "unbound-candidate", sessionId: "sess-2", evidencePath: "/tmp/e.json", summary: "1 seed" }],
    unknown: [{ type: "unknown", sessionId: "sess-3", lastSeenAt: "2026-08-16T00:00:00.000Z", reason: "no-resolution-recorded" }],
    lifecycleFlags: [
      { kind: "workspace", ref: "ws-2", missingComponent: "src/gone.ts", flaggedAt: "2026-08-16T00:00:00.000Z" },
    ],
    unreviewedPaths: [],
  };
  const items = catchUpItems(report);
  expect(items.map((item) => item.type)).toEqual(["proposal", "blocked", "unbound-candidate", "unknown"]);
  expect(items).toHaveLength(4);
});

test("loadInspectorCatchUp: an ordinary project with no proposals/sessions returns an empty report, never throws", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "keryx-catchup-data-"));
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-catchup-cwd-"));
  const originalDataDir = process.env.KERYX_DATA_DIR;
  process.env.KERYX_DATA_DIR = dataDir;
  try {
    const report = await loadInspectorCatchUp(cwd);
    expect(catchUpItems(report)).toEqual([]);
    expect(report.lifecycleFlags).toEqual([]);
  } finally {
    if (originalDataDir !== undefined) process.env.KERYX_DATA_DIR = originalDataDir;
    else delete process.env.KERYX_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

/** A local `git` invocation for the freshness-detection fixtures below — same shape as `flow-check-ac.test.ts`'s own helper. */
async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

// Flow 328, AC7: `loadInspectorFlows` reads a flow's CACHED check-ac result
// (never triggers a Jev call itself) and exposes it as `acMarkers`.
test("loadInspectorFlows: no cache -> acMarkers absent (not run); a checksum mismatch is always stale; no git repo -> freshness unknown", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-inspector-ac-"));
  try {
    const deps: FlowServiceDeps = { tracker: null, healthGate: async () => ({ status: "pass", reasons: [] }), now: () => new Date("2026-09-25T00:00:00Z") };
    const service = createFlowService(deps);
    const created = await service.init({ cwd, title: "AC markers fixture" });
    const dir = path.basename(created.dir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(cwd, ".metaproject", "flows", dir, "acceptance-criteria.md"),
      "# Acceptance Criteria\n\n## Criteria\n\n- AC1: the fixture criterion holds\n",
      "utf8",
    );
    const frozen = await service.freeze({ cwd, id: dir });

    const noCache = await loadInspectorFlows(cwd);
    expect(noCache[0]?.acMarkers).toBeUndefined();

    // Review finding: staleness must compare the FULL key (criteria checksum
    // + diff hash), not just the checksum half — this key's checksum half
    // matches, but its diff-hash half ("deadbeef") is fabricated and this
    // `cwd` is not even a git repo, so the diff cannot be computed at all.
    // That must read as `"unknown"`, never as fresh.
    await writeAcCheckCache(acCheckCachePath(cwd, dir), {
      key: `${frozen.acChecksum}:deadbeef`,
      at: "2026-09-25T01:00:00.000Z",
      jevAsked: true,
      verdicts: [{ id: "AC1", text: "the fixture criterion holds", status: "likely-met", probability: 0.9, factLines: [], evidencePaths: [] }],
    });
    const cached = await loadInspectorFlows(cwd);
    expect(cached[0]?.acMarkers).toEqual([{ id: "AC1", status: "likely-met", label: "likely met" }]);
    expect(cached[0]?.acCheckedAt).toBe("2026-09-25T01:00:00.000Z");
    expect(cached[0]?.acCheckStale).toBe("unknown");

    // Re-freeze over changed criteria text -> checksum changes -> the cached
    // result (keyed to the OLD checksum) is now stale — decidable with NO
    // git call, so this stays `true` even with no repo present.
    await writeFile(
      path.join(cwd, ".metaproject", "flows", dir, "acceptance-criteria.md"),
      "# Acceptance Criteria\n\n## Criteria\n\n- AC1: a DIFFERENT criterion text\n",
      "utf8",
    );
    await service.acUpdate({ cwd, id: dir, reason: "criterion changed for the stale-detection test" });
    const stale = await loadInspectorFlows(cwd);
    expect(stale[0]?.acMarkers).toBeDefined();
    expect(stale[0]?.acCheckStale).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Review finding: the full-key comparison's other half — a criteria checksum
// that has NOT changed, but the diff HAS. A real git repo is needed here
// (unlike the fixture above) because this case can only be told apart from
// "fresh" by actually computing the diff.
test("loadInspectorFlows: checksum unchanged but the diff changed since the cache was written -> stale, with a real git repo", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-inspector-ac-git-"));
  try {
    await git(cwd, ["init", "-q", "-b", "main"]);
    await git(cwd, ["config", "user.email", "fixture@example.invalid"]);
    await git(cwd, ["config", "user.name", "fixture"]);

    const deps: FlowServiceDeps = { tracker: null, healthGate: async () => ({ status: "pass", reasons: [] }), now: () => new Date("2026-09-25T00:00:00Z") };
    const service = createFlowService(deps);
    const created = await service.init({ cwd, title: "AC freshness fixture", baseBranch: "main" });
    const dir = path.basename(created.dir);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      path.join(cwd, ".metaproject", "flows", dir, "acceptance-criteria.md"),
      "# Acceptance Criteria\n\n## Criteria\n\n- AC1: the fixture criterion holds\n",
      "utf8",
    );
    const frozen = await service.freeze({ cwd, id: dir });

    // Commit everything so the working tree is CLEAN and `main` IS the
    // current commit — merge-base(HEAD, "main") = HEAD, so the diff against
    // it is empty, with a deterministic, known hash.
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-q", "-m", "fixture base"]);

    await writeAcCheckCache(acCheckCachePath(cwd, dir), {
      key: acCheckCacheKey(frozen.acChecksum ?? "", ""),
      at: "2026-09-25T01:00:00.000Z",
      jevAsked: true,
      verdicts: [{ id: "AC1", text: "the fixture criterion holds", status: "likely-met", probability: 0.9, factLines: [], evidencePaths: [] }],
    });

    const fresh = await loadInspectorFlows(cwd);
    expect(fresh[0]?.acCheckStale).toBe(false);

    // The criteria are untouched (checksum unchanged) — only the DIFF
    // changes, via an uncommitted edit in the worktree. Staged (`git add`),
    // because `git diff <commit>` (comparing a commit to the working tree)
    // never shows a brand-new file until it is at least staged — an
    // untracked file is invisible to `git diff` entirely, staged or not.
    await writeFile(path.join(cwd, "unrelated-change.txt"), "something changed after the check ran\n", "utf8");
    await git(cwd, ["add", "-A"]);
    const diffChanged = await loadInspectorFlows(cwd);
    expect(diffChanged[0]?.acCheckStale).toBe(true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
