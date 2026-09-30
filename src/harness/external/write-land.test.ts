// Tests for reviewing, landing and discarding a claude write run (flow 370, AC4). Real
// temp git repos, no network, no claude binary: a run is seeded the way write-run.ts
// stores it (session + record + patch file).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { withoutGitDiscoveryOverrides } from "../../lib/git-env";
import { sessionDir } from "../../session/paths";
import { createSession, EXTERNAL_RUN_PROVIDER_PREFIX } from "../../session/store";
import {
  EXTERNAL_WRITE_DECISION_FILE,
  discardWriteRun,
  landWriteRun,
  listPendingWriteRuns,
  viewWriteRun,
  type WriteLandDeps,
} from "./write-land";
import { EXTERNAL_WRITE_PATCH_FILE, EXTERNAL_WRITE_RUN_FILE, type ExternalWriteRunRecord } from "./write-run";

const GIT_ENV = withoutGitDiscoveryOverrides(process.env);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

let root: string;
let repo: string;
let dataDir: string;
let worktreesDir: string;
let baseCommit: string;

/** The patch for changing a.txt and adding new.txt, produced in a scratch clone so `repo` is never touched. */
function makePatch(): { patch: string; tree: string } {
  const clone = path.join(root, `clone-${Math.random().toString(36).slice(2)}`);
  git(root, "clone", "-q", repo, clone);
  git(clone, "config", "user.email", "t@example.com");
  git(clone, "config", "user.name", "T");
  writeFileSync(path.join(clone, "a.txt"), "one\nTWO\nthree\n");
  writeFileSync(path.join(clone, "new.txt"), "brand new\n");
  git(clone, "add", "-A");
  const patch = git(clone, "diff", "--cached", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", baseCommit);
  git(clone, "commit", "-q", "-m", "expected");
  return { patch, tree: git(clone, "rev-parse", "HEAD^{tree}").trim() };
}

interface Seeded {
  readonly runId: string;
  readonly dir: string;
}

function seed(patch: string, overrides: Partial<ExternalWriteRunRecord> = {}): Seeded {
  const runId = crypto.randomUUID();
  const handle = createSession({
    cwd: repo,
    dataDir,
    id: runId,
    provider: `${EXTERNAL_RUN_PROVIDER_PREFIX}claude-cli`,
    title: "External write claude-cli: Completed",
  });
  const patchPath = path.join(handle.dir, EXTERNAL_WRITE_PATCH_FILE);
  // A refused run keeps no patch, and its record carries no path or hash.
  const refused = overrides.state === "refused";
  if (!refused) writeFileSync(patchPath, patch);
  const record: ExternalWriteRunRecord = {
    runId,
    agentId: "claude-cli",
    baseCommit,
    ...(refused ? {} : { patchPath, patchHash: sha256(patch) }),
    files: [
      { path: "a.txt", status: "modified" },
      { path: "new.txt", status: "added" },
    ],
    flaggedPaths: [],
    refusedPaths: [],
    state: "pending-review",
    redacted: false,
    runStatus: "Completed",
    projectRoot: handle.summary.projectPath,
    createdAt: handle.summary.createdAt,
    ...overrides,
  };
  writeFileSync(path.join(handle.dir, EXTERNAL_WRITE_RUN_FILE), JSON.stringify(record, null, 2));
  return { runId, dir: handle.dir };
}

const deps = (): WriteLandDeps => ({ dataDir, worktreesDir });

function snapshot(): { status: string; head: string; branch: string; a: string; branches: string } {
  return {
    status: git(repo, "status", "--porcelain"),
    head: git(repo, "rev-parse", "HEAD").trim(),
    branch: git(repo, "symbolic-ref", "--short", "HEAD").trim(),
    a: readFileSync(path.join(repo, "a.txt"), "utf8"),
    branches: git(repo, "for-each-ref", "--format=%(refname)", "refs/heads"),
  };
}

function expectNoWorktreeLeft(): void {
  const listed = git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
  expect(listed.length).toBe(1);
  expect(existsSync(worktreesDir) ? readdirSync(worktreesDir) : []).toEqual([]);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-write-land-test-")));
  repo = path.join(root, "repo");
  dataDir = path.join(root, "data");
  worktreesDir = path.join(root, "worktrees");
  mkdirSync(repo);
  mkdirSync(worktreesDir);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "operator@example.com");
  git(repo, "config", "user.name", "Operator");
  writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  baseCommit = git(repo, "rev-parse", "HEAD").trim();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("landWriteRun", () => {
  test("lands one commit on external/<runId> whose tree is base + patch, and leaves the checkout untouched", async () => {
    const { patch, tree } = makePatch();
    const run = seed(patch);
    // A dirty tree and a moved HEAD must both survive: landing branches from the recorded base.
    writeFileSync(path.join(repo, "a.txt"), "local edit\n");
    writeFileSync(path.join(repo, "untracked.txt"), "mine\n");
    const before = snapshot();

    const result = await landWriteRun({ cwd: repo, runId: run.runId, confirmedPatchHash: sha256(patch) }, deps());

    expect(result.kind).toBe("landed");
    if (result.kind !== "landed") return;
    expect(result.branch).toBe(`external/${run.runId}`);
    expect(git(repo, "rev-parse", result.branch).trim()).toBe(result.commit);
    expect(git(repo, "rev-parse", `${result.commit}^{tree}`).trim()).toBe(tree);
    expect(git(repo, "rev-list", "--count", `${baseCommit}..${result.branch}`).trim()).toBe("1");
    expect(git(repo, "rev-parse", `${result.commit}^`).trim()).toBe(baseCommit);
    expect(git(repo, "log", "-1", "--format=%an <%ae>%n%B", result.commit).trim()).toBe(
      `Operator <operator@example.com>\nExternal write run ${run.runId} (claude-cli)`,
    );
    const after = snapshot();
    expect({ ...after, branches: "" }).toEqual({ ...before, branches: "" });
    expect(after.branches.split("\n").sort()).toEqual([...before.branches.split("\n"), `refs/heads/${result.branch}`].sort());
    expectNoWorktreeLeft();
    expect(listPendingWriteRuns(repo, deps())).toEqual([]);
  });

  test("still branches from the base commit after HEAD moved", async () => {
    const { patch, tree } = makePatch();
    const run = seed(patch);
    writeFileSync(path.join(repo, "later.txt"), "later\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "later");
    const before = snapshot();
    const result = await landWriteRun({ cwd: repo, runId: run.runId, confirmedPatchHash: sha256(patch) }, deps());
    expect(result.kind).toBe("landed");
    if (result.kind !== "landed") return;
    expect(git(repo, "rev-parse", `${result.commit}^`).trim()).toBe(baseCommit);
    expect(git(repo, "rev-parse", `${result.commit}^{tree}`).trim()).toBe(tree);
    expect({ ...snapshot(), branches: "" }).toEqual({ ...before, branches: "" });
  });

  test("a changed patch file lands nothing", async () => {
    const { patch } = makePatch();
    const run = seed(patch);
    writeFileSync(path.join(run.dir, EXTERNAL_WRITE_PATCH_FILE), patch.replace("brand new", "evil"));
    const before = snapshot();
    const result = await landWriteRun({ cwd: repo, runId: run.runId, confirmedPatchHash: sha256(patch) }, deps());
    expect(result).toMatchObject({ kind: "refused", reason: "hash-mismatch" });
    expect(snapshot()).toEqual(before);
    expect(viewWriteRun(repo, run.runId, deps())?.patch).toBeUndefined();
    expectNoWorktreeLeft();
  });

  test("a missing patch file is patch-missing", async () => {
    const { patch } = makePatch();
    const run = seed(patch);
    rmSync(path.join(run.dir, EXTERNAL_WRITE_PATCH_FILE));
    const result = await landWriteRun({ cwd: repo, runId: run.runId, confirmedPatchHash: sha256(patch) }, deps());
    expect(result).toMatchObject({ kind: "refused", reason: "patch-missing" });
  });

  test("a wrong confirmed hash lands nothing, and so does an unknown run", async () => {
    const { patch } = makePatch();
    const run = seed(patch);
    const before = snapshot();
    expect(await landWriteRun({ cwd: repo, runId: run.runId, confirmedPatchHash: "0".repeat(64) }, deps())).toMatchObject({
      kind: "refused",
      reason: "hash-mismatch",
    });
    expect(await landWriteRun({ cwd: repo, runId: run.runId, confirmedPatchHash: sha256(patch).slice(0, 12) }, deps())).toMatchObject({
      kind: "refused",
      reason: "hash-mismatch",
    });
    expect(await landWriteRun({ cwd: repo, runId: crypto.randomUUID(), confirmedPatchHash: sha256(patch) }, deps())).toMatchObject({
      kind: "refused",
      reason: "not-found",
    });
    expect(snapshot()).toEqual(before);
  });

  test("a second land is refused as not-pending", async () => {
    const { patch } = makePatch();
    const run = seed(patch);
    const input = { cwd: repo, runId: run.runId, confirmedPatchHash: sha256(patch) };
    expect((await landWriteRun(input, deps())).kind).toBe("landed");
    const branches = git(repo, "for-each-ref", "refs/heads");
    expect(await landWriteRun(input, deps())).toMatchObject({ kind: "refused", reason: "not-pending" });
    expect(git(repo, "for-each-ref", "refs/heads")).toBe(branches);
    expect(discardWriteRun({ cwd: repo, runId: run.runId }, deps())).toMatchObject({ kind: "refused", reason: "not-pending" });
    expectNoWorktreeLeft();
  });

  test("a land after a discard is refused, and the discard deletes the patch", async () => {
    const { patch } = makePatch();
    const run = seed(patch);
    expect(discardWriteRun({ cwd: repo, runId: run.runId }, deps())).toEqual({ kind: "discarded" });
    expect(existsSync(path.join(run.dir, EXTERNAL_WRITE_PATCH_FILE))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(run.dir, EXTERNAL_WRITE_DECISION_FILE), "utf8"))).toMatchObject({ decision: "discarded" });
    expect(await landWriteRun({ cwd: repo, runId: run.runId, confirmedPatchHash: sha256(patch) }, deps())).toMatchObject({
      kind: "refused",
      reason: "not-pending",
    });
    expect(discardWriteRun({ cwd: repo, runId: run.runId }, deps())).toMatchObject({ kind: "refused", reason: "not-pending" });
    expect(listPendingWriteRuns(repo, deps())).toEqual([]);
  });

  test("a redacted record is refused", async () => {
    const { patch } = makePatch();
    const run = seed(patch, { redacted: true });
    const before = snapshot();
    expect(await landWriteRun({ cwd: repo, runId: run.runId, confirmedPatchHash: sha256(patch) }, deps())).toMatchObject({
      kind: "refused",
      reason: "redacted",
    });
    expect(snapshot()).toEqual(before);
  });

  test("a record with a binary file is refused", async () => {
    const { patch } = makePatch();
    const run = seed(patch, { files: [{ path: "image.bin", status: "added", binary: true }] });
    const before = snapshot();
    expect(await landWriteRun({ cwd: repo, runId: run.runId, confirmedPatchHash: sha256(patch) }, deps())).toMatchObject({
      kind: "refused",
      reason: "binary",
    });
    expect(snapshot()).toEqual(before);
  });

  test("a flagged record is refused unless flagged paths are allowed", async () => {
    const { patch } = makePatch();
    const run = seed(patch, { flaggedPaths: ["new.txt"] });
    const before = snapshot();
    const input = { cwd: repo, runId: run.runId, confirmedPatchHash: sha256(patch) };
    expect(await landWriteRun(input, deps())).toMatchObject({ kind: "refused", reason: "flagged" });
    expect(snapshot()).toEqual(before);
    const landed = await landWriteRun({ ...input, allowFlagged: true }, deps());
    expect(landed.kind).toBe("landed");
    expect({ ...snapshot(), branches: "" }).toEqual({ ...before, branches: "" });
  });

  test("an existing branch is refused and left as it was", async () => {
    const { patch } = makePatch();
    const run = seed(patch);
    git(repo, "branch", `external/${run.runId}`);
    const before = snapshot();
    expect(await landWriteRun({ cwd: repo, runId: run.runId, confirmedPatchHash: sha256(patch) }, deps())).toMatchObject({
      kind: "refused",
      reason: "branch-exists",
    });
    expect(snapshot()).toEqual(before);
    expectNoWorktreeLeft();
  });

  test("a patch that does not apply leaves no branch, no worktree and an untouched checkout", async () => {
    const bad = [
      "diff --git a/a.txt b/a.txt",
      "--- a/a.txt",
      "+++ b/a.txt",
      "@@ -1,3 +1,3 @@",
      " nothing",
      "-matches",
      "+here",
      " at all",
      "",
    ].join("\n");
    const run = seed(bad);
    const before = snapshot();
    const result = await landWriteRun({ cwd: repo, runId: run.runId, confirmedPatchHash: sha256(bad) }, deps());
    expect(result).toMatchObject({ kind: "refused", reason: "apply-failed" });
    if (result.kind === "refused") expect(result.detail.length).toBeGreaterThan(0);
    expect(snapshot()).toEqual(before);
    expect(existsSync(path.join(run.dir, EXTERNAL_WRITE_DECISION_FILE))).toBe(false);
    expectNoWorktreeLeft();
    // Still pending: a failed land does not spend the run.
    expect(listPendingWriteRuns(repo, deps()).map((r) => r.runId)).toEqual([run.runId]);
  });

  test("a failing decision write removes the branch and reports apply-failed", async () => {
    if (process.getuid?.() === 0) return; // root ignores directory permissions
    const { patch } = makePatch();
    const run = seed(patch);
    const before = snapshot();
    chmodSync(run.dir, 0o500);
    let result: Awaited<ReturnType<typeof landWriteRun>>;
    try {
      result = await landWriteRun({ cwd: repo, runId: run.runId, confirmedPatchHash: sha256(patch) }, deps());
    } finally {
      chmodSync(run.dir, 0o700);
    }
    expect(result).toMatchObject({ kind: "refused", reason: "apply-failed" });
    expect(snapshot()).toEqual(before);
    expectNoWorktreeLeft();
  });
});

describe("listPendingWriteRuns and viewWriteRun", () => {
  test("lists pending runs newest first and skips refused, decided and non-external sessions", async () => {
    const { patch } = makePatch();
    const older = seed(patch, { createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = seed(patch, { createdAt: "2026-02-01T00:00:00.000Z" });
    seed(patch, { state: "refused", refusedPaths: ["x"] });
    const decided = seed(patch);
    discardWriteRun({ cwd: repo, runId: decided.runId }, deps());
    createSession({ cwd: repo, dataDir, provider: "anthropic", title: "chat" });
    expect(listPendingWriteRuns(repo, deps()).map((r) => r.runId)).toEqual([newer.runId, older.runId]);
  });

  test("view returns the patch only while its hash matches", () => {
    const { patch } = makePatch();
    const run = seed(patch);
    expect(viewWriteRun(repo, run.runId, deps())?.patch).toBe(patch);
    expect(viewWriteRun(repo, run.runId.slice(0, 8), deps())?.record.runId).toBe(run.runId);
    writeFileSync(path.join(sessionDir(repo, run.runId, dataDir), EXTERNAL_WRITE_PATCH_FILE), `${patch}\n`);
    expect(viewWriteRun(repo, run.runId, deps())?.patch).toBeUndefined();
    expect(viewWriteRun(repo, "nope", deps())).toBeUndefined();
  });

  test("a refused run shows no patch and can be discarded", () => {
    const run = seed("", { state: "refused", refusedPaths: ["link"], files: [{ path: "link", status: "added" }] });
    const view = viewWriteRun(repo, run.runId, deps());
    expect(view?.record.state).toBe("refused");
    expect(view?.patch).toBeUndefined();
    expect(discardWriteRun({ cwd: repo, runId: run.runId }, deps())).toEqual({ kind: "discarded" });
  });
});
