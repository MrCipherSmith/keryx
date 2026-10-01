// Flow 384: flow folders are committed with the code and numbered across
// branches. Covers `flow init` / `renumber` / `check` against remote-tracking
// refs, the `untracked` warning, and the opt-in `folder-committed` gate — all on
// temporary git repositories, with remote refs built by plumbing (no network).
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "./service";
import { writeCleanReviewPackage } from "./review-fixtures";
import { addRemoteRef, commitAll, git, gitRepo } from "./remote-fixtures";
import { flowFoldersInHead } from "./folder-committed";
import type { FlowService, FlowServiceDeps, FlowState, TrackerAdapter } from "./types";

const ROOTS: string[] = [];
const HEAD = "cafe1cafe2cafe3cafe4cafe5cafe6cafe7cafe8";
const PR_URL = "https://github.com/acme/app/pull/1";

afterEach(async () => {
  await Promise.all(ROOTS.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeTracker(): TrackerAdapter {
  return {
    id: "fake",
    detect: async () => true,
    parseRef: () => null,
    fetchIssue: async () => ({ title: "Issue title", body: "body" }),
    prStatus: async () => ({ exists: true, isDraft: true, checksGreen: true, headSha: HEAD }),
    comment: async () => true,
  };
}

function makeService(): FlowService {
  const deps: FlowServiceDeps = {
    tracker: fakeTracker(),
    healthGate: async () => ({ status: "pass", reasons: [] }),
    now: () => new Date("2026-10-01T10:00:00Z"),
  };
  return createFlowService(deps);
}

async function repo(): Promise<string> {
  const root = await gitRepo("keryx-folder-hygiene-");
  ROOTS.push(root);
  return root;
}

async function plainDir(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-folder-hygiene-plain-"));
  ROOTS.push(root);
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  return root;
}

async function mkFlowDir(root: string, dir: string): Promise<void> {
  await mkdir(path.join(root, ".metaproject", "flows", dir), { recursive: true });
}

// --- init ------------------------------------------------------------------

test("flow init reserves numbers a known remote branch uses: remote 005, local 001-003, empty ledger -> next is at least 006", async () => {
  const root = await repo();
  for (const dir of ["001-2026-09-01-a", "002-2026-09-02-b", "003-2026-09-03-c"]) {
    await mkFlowDir(root, dir);
  }
  await addRemoteRef(root, "origin/main", ["005-2026-09-30-remote"]);

  const { flow } = await makeService().init({ cwd: root, title: "After the remote" });

  expect(Number(flow.id)).toBeGreaterThanOrEqual(6);
});

test("without a remote ref the same repository hands out the next local number (control)", async () => {
  const root = await repo();
  for (const dir of ["001-2026-09-01-a", "002-2026-09-02-b", "003-2026-09-03-c"]) {
    await mkFlowDir(root, dir);
  }

  const { flow } = await makeService().init({ cwd: root, title: "Local only" });

  expect(flow.id).toBe("004");
});

// --- renumber ---------------------------------------------------------------

test("flow renumber --to refuses an id a known remote branch uses, and accepts a free one", async () => {
  const root = await repo();
  const service = makeService();
  const { flow } = await service.init({ cwd: root, title: "To move" });
  await addRemoteRef(root, "origin/main", ["007-2026-09-30-elsewhere"]);

  const refused = await service.renumber({ cwd: root, ref: flow.id, to: "007", reason: "test" }).then(
    () => null,
    (error: unknown) => error as Error,
  );
  expect(refused).toBeInstanceOf(Error);
  expect(refused?.message).toContain("Flow id 007 is already used on origin/main (007-2026-09-30-elsewhere)");

  const moved = await service.renumber({ cwd: root, ref: flow.id, to: "008", reason: "test" });
  expect(moved.to).toBe("008");
});

// --- check: clash with a remote branch --------------------------------------

test("flow check fails duplicate-id for a local folder whose number a remote branch holds under another name", async () => {
  const root = await repo();
  const service = makeService();
  const { dir } = await service.init({ cwd: root, title: "Local side" });
  const localDir = path.basename(dir);
  const id = localDir.slice(0, 3);
  await addRemoteRef(root, "origin/main", [`${id}-2026-09-30-remote-side`]);

  const result = await service.check({ cwd: root });

  expect(result.ok).toBe(false);
  const issue = result.issues.find((entry) => entry.kind === "duplicate-id");
  expect(issue?.flow).toBe(localDir);
  expect(issue?.message).toContain("origin/main");
  expect(issue?.message).toContain(`${id}-2026-09-30-remote-side`);
  expect(issue?.message).toEndWith(`keryx flow renumber ${localDir} --to <free id> --reason "<why>"`);
});

test("flow check does not report a folder the remote branch holds under the SAME name", async () => {
  const root = await repo();
  const service = makeService();
  const { dir } = await service.init({ cwd: root, title: "Same flow" });
  await addRemoteRef(root, "origin/main", [path.basename(dir)]);

  const result = await service.check({ cwd: root });

  expect(result.issues.filter((entry) => entry.kind === "duplicate-id")).toEqual([]);
  expect(result.ok).toBe(true);
});

test("flow check reports a clash on another ref even when one ref holds this folder under its own name", async () => {
  const root = await repo();
  const service = makeService();
  const { dir } = await service.init({ cwd: root, title: "Local side" });
  const localDir = path.basename(dir);
  const id = localDir.slice(0, 3);
  await addRemoteRef(root, "origin/feat", [localDir]);
  await addRemoteRef(root, "origin/main", [`${id}-2026-09-30-someone-else`]);

  const result = await service.check({ cwd: root });

  const issue = result.issues.find((entry) => entry.kind === "duplicate-id");
  expect(issue?.flow).toBe(localDir);
  expect(issue?.message).toContain("origin/main");
  expect(issue?.message).toContain(`${id}-2026-09-30-someone-else`);
});

test("a clash with a non-default remote branch is a warning, not a failure", async () => {
  const root = await repo();
  const service = makeService();
  const { dir } = await service.init({ cwd: root, title: "Local side" });
  const localDir = path.basename(dir);
  const id = localDir.slice(0, 3);
  await addRemoteRef(root, "origin/main", ["900-2026-09-01-unrelated"]);
  await addRemoteRef(root, "origin/stale-branch", [`${id}-2026-09-30-old-cut`]);

  const result = await service.check({ cwd: root });

  expect(result.issues.filter((entry) => entry.kind === "duplicate-id")).toEqual([]);
  expect(result.ok).toBe(true);
  const warning = result.warnings.find((entry) => entry.kind === "branch-duplicate-id");
  expect(warning?.flow).toBe(localDir);
  expect(warning?.message).toContain("origin/stale-branch");
  expect(warning?.message).toContain(`${id}-2026-09-30-old-cut`);
});

test("the branch origin/HEAD points at counts as the default branch even when it is not main", async () => {
  const root = await repo();
  const service = makeService();
  const { dir } = await service.init({ cwd: root, title: "Local side" });
  const localDir = path.basename(dir);
  const id = localDir.slice(0, 3);
  await addRemoteRef(root, "origin/develop", [`${id}-2026-09-30-on-develop`]);
  await git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);

  const result = await service.check({ cwd: root });

  const issue = result.issues.find((entry) => entry.kind === "duplicate-id");
  expect(issue?.flow).toBe(localDir);
  expect(issue?.message).toContain("origin/develop");
});

test("flow init still skips a number only a non-default branch holds", async () => {
  const root = await repo();
  await mkFlowDir(root, "001-2026-09-01-a");
  await addRemoteRef(root, "origin/stale-branch", ["005-2026-09-30-old-cut"]);

  const { flow } = await makeService().init({ cwd: root, title: "After the branch" });

  expect(Number(flow.id)).toBeGreaterThanOrEqual(6);
});

test("a control character in a remote folder name never reaches the check message", async () => {
  const root = await repo();
  const service = makeService();
  const { dir } = await service.init({ cwd: root, title: "Local side" });
  const localDir = path.basename(dir);
  const id = localDir.slice(0, 3);
  await addRemoteRef(root, "origin/main", [`${id}-evil\u001b[2Jname`]);

  const result = await service.check({ cwd: root });

  const issue = result.issues.find((entry) => entry.kind === "duplicate-id");
  expect(issue?.message).toContain(`${id}-evil[2Jname`);
  expect(issue?.message).not.toContain("\u001b");
});

// --- check: the untracked warning --------------------------------------------

test("flow check warns, without failing, about a flow folder that is not in HEAD; committing clears it", async () => {
  const root = await repo();
  const service = makeService();
  const { dir } = await service.init({ cwd: root, title: "Not yet committed" });
  const localDir = path.basename(dir);

  const before = await service.check({ cwd: root });

  expect(before.ok).toBe(true);
  expect(before.issues).toEqual([]);
  expect(before.warnings).toEqual([
    {
      flow: localDir,
      kind: "untracked",
      message: `flow folder ${localDir} is not committed: commit it in the same PR as the code`,
    },
  ]);

  await commitAll(root);
  expect((await service.check({ cwd: root })).warnings).toEqual([]);
});

test("flow check gives no warning outside a git repository", async () => {
  const root = await plainDir();
  const service = makeService();
  await service.init({ cwd: root, title: "No git here" });

  const result = await service.check({ cwd: root });

  expect(result.ok).toBe(true);
  expect(result.warnings).toEqual([]);
});

// --- the folder-committed gate ----------------------------------------------

async function writeAc(root: string, dir: string): Promise<void> {
  await writeFile(
    path.join(root, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    "# Acceptance Criteria\n\n## Criteria\n\n- AC1: Only criterion\n",
    "utf8",
  );
}

/** Drive a fresh flow to the point where `complete` runs its gates. */
async function driveToGates(root: string, service: FlowService): Promise<{ id: string; dir: string }> {
  const { flow, dir: created } = await service.init({ cwd: root, title: "Gate fixture", owner: "Aleks" });
  const dir = path.basename(created);
  await writeAc(root, dir);
  await service.freeze({ cwd: root, id: flow.id });
  await service.start({ cwd: root, id: flow.id });
  await service.implemented({ cwd: root, id: flow.id, prUrl: PR_URL });
  await service.acConfirm({ cwd: root, id: flow.id, criterion: "AC1" });
  await writeCleanReviewPackage({ cwd: root, flowDir: dir, head: HEAD, prUrl: PR_URL });
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await service.taskDone({ cwd: root, id: flow.id, taskId });
  }
  return { id: flow.id, dir };
}

test("flow init opts every new package into the folder-committed gate", async () => {
  const root = await repo();
  const { flow } = await makeService().init({ cwd: root, title: "Opts in" });
  expect(flow.gates?.folderCommitted).toBe(true);
});

test("folder-committed fails while the flow folder is not in HEAD, with the commit instruction", async () => {
  const root = await repo();
  const service = makeService();
  const { id, dir } = await driveToGates(root, service);

  const result = await service.complete({ cwd: root, id });

  const gate = result.gates.find((entry) => entry.name === "folder-committed");
  expect(gate?.status).toBe("fail");
  expect(gate?.detail).toBe(
    `flow folder ${dir} is not committed. Commit it (git add .metaproject/flows/${dir} && git commit) in the PR that carries the code, then run flow complete again`,
  );
  expect(result.passed).toBe(false);
  expect(result.flow.status).toBe("in-progress");
});

test("folder-committed passes once flow.json is in HEAD", async () => {
  const root = await repo();
  const service = makeService();
  const { id, dir } = await driveToGates(root, service);
  await commitAll(root);

  const result = await service.complete({ cwd: root, id });

  const gate = result.gates.find((entry) => entry.name === "folder-committed");
  expect(gate?.status).toBe("pass");
  expect(gate?.detail).toContain(dir);
  // The same check passes read-only.
  const checked = await service.checkComplete({ cwd: root, id });
  expect(checked.gates.find((entry) => entry.name === "folder-committed")?.status).toBe("pass");
});

test("a package without the flag reports folder-committed skipped, committed or not", async () => {
  const root = await repo();
  const service = makeService();
  const { id, dir } = await driveToGates(root, service);
  const file = path.join(root, ".metaproject", "flows", dir, "flow.json");
  const raw = JSON.parse(await readFile(file, "utf8")) as FlowState;
  raw.gates = { tasks: true, review: true, owner: true };
  await writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

  const result = await service.complete({ cwd: root, id });

  const gate = result.gates.find((entry) => entry.name === "folder-committed");
  expect(gate?.status).toBe("skipped");
  expect(gate?.detail).toContain("created before the gate");
  expect(result.gates.some((entry) => entry.name === "folder-committed" && entry.status === "fail")).toBe(false);
});

test("outside a git repository the gate is skipped, not failed", async () => {
  const root = await plainDir();
  const service = makeService();
  const { id } = await driveToGates(root, service);

  const result = await service.complete({ cwd: root, id });

  const gate = result.gates.find((entry) => entry.name === "folder-committed");
  expect(gate?.status).toBe("skipped");
  expect(gate?.detail).toContain("not a git repository");
});

// --- HEAD reading: unborn, unreadable, detached, project in a subdirectory ------

test("a HEAD that exists but does not hold flow.json: check warns and the gate fails", async () => {
  const root = await repo();
  const service = makeService();
  const { id, dir } = await driveToGates(root, service);
  await git(root, ["commit", "--allow-empty", "-q", "-m", "empty"]);

  const checked = await service.check({ cwd: root });
  expect(checked.ok).toBe(true);
  expect(checked.warnings.map((warning) => warning.kind)).toEqual(["untracked"]);

  const result = await service.complete({ cwd: root, id });
  expect(result.gates.find((entry) => entry.name === "folder-committed")?.status).toBe("fail");
  expect(result.passed).toBe(false);
  expect(dir.length).toBeGreaterThan(0);
});

test("a detached HEAD reads the committed folder the same way", async () => {
  const root = await repo();
  const service = makeService();
  const { dir } = await service.init({ cwd: root, title: "Detached" });
  await commitAll(root);
  await git(root, ["checkout", "-q", "--detach"]);

  expect([...((await flowFoldersInHead(root, [path.basename(dir)])) ?? [])]).toEqual([path.basename(dir)]);
  expect((await service.check({ cwd: root })).warnings).toEqual([]);
});

test("an unreadable HEAD tree is an error, never 'nothing committed': no warnings, and the gate cannot pass", async () => {
  const root = await repo();
  const service = makeService();
  const { id, dir } = await driveToGates(root, service);
  await commitAll(root);
  const tree = await git(root, ["rev-parse", "HEAD^{tree}"]);
  await rm(path.join(root, ".git", "objects", tree.slice(0, 2), tree.slice(2)), { force: true });

  await expect(flowFoldersInHead(root, [dir])).rejects.toThrow("could not read HEAD tree");
  expect((await service.check({ cwd: root })).warnings).toEqual([]);
  const result = await service.complete({ cwd: root, id });
  expect(result.gates.find((entry) => entry.name === "folder-committed")?.status).toBe("fail");
  expect(result.passed).toBe(false);
});

test("a project in a non-ASCII subdirectory of the repository reads its committed folder as committed", async () => {
  const root = await repo();
  const project = path.join(root, "проект");
  await mkdir(path.join(project, ".metaproject"), { recursive: true });
  const service = makeService();
  const { dir } = await service.init({ cwd: project, title: "Nested" });
  const localDir = path.basename(dir);

  expect((await service.check({ cwd: project })).warnings.map((warning) => warning.kind)).toEqual(["untracked"]);

  await commitAll(root);

  expect((await service.check({ cwd: project })).warnings).toEqual([]);
  expect([...((await flowFoldersInHead(project, [localDir])) ?? [])]).toEqual([localDir]);
});
