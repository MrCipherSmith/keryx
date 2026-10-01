// Flow 384: what this clone can learn about other branches' flow numbers
// without a network — and that it never gets in the way when it can learn nothing.
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { flowNumberOfDir, knownRemoteFlowDirs, remoteFlowNumbers } from "./remote-flows";
import { addRemoteRef, git, gitRepo } from "./remote-fixtures";

const ROOTS: string[] = [];

afterEach(async () => {
  await Promise.all(ROOTS.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function repo(): Promise<string> {
  const root = await gitRepo("keryx-remote-flows-");
  ROOTS.push(root);
  return root;
}

test("reads the flow folders held by remote-tracking refs, naming the ref", async () => {
  const root = await repo();
  await addRemoteRef(root, "origin/main", ["005-2026-10-01-alpha", "007-2026-10-01-beta"]);
  await addRemoteRef(root, "origin/feature", ["012-2026-10-02-gamma"]);

  const found = await knownRemoteFlowDirs(root);

  expect(found).toContainEqual({ ref: "origin/main", dir: "005-2026-10-01-alpha" });
  expect(found).toContainEqual({ ref: "origin/main", dir: "007-2026-10-01-beta" });
  expect(found).toContainEqual({ ref: "origin/feature", dir: "012-2026-10-02-gamma" });
  expect(await remoteFlowNumbers(root)).toEqual([5, 7, 12]);
});

test("a four-digit number is read whole, not by its first three digits", async () => {
  const root = await repo();
  await addRemoteRef(root, "origin/main", ["1000-2026-10-01-big"]);
  expect(flowNumberOfDir("1000-2026-10-01-big")).toBe(1000);
  expect(await remoteFlowNumbers(root)).toEqual([1000]);
});

test("not a git repository, a repository without remotes, and a missing directory all answer nothing", async () => {
  const plain = await mkdtemp(path.join(tmpdir(), "keryx-remote-flows-plain-"));
  ROOTS.push(plain);
  expect(await knownRemoteFlowDirs(plain)).toEqual([]);
  expect(await remoteFlowNumbers(plain)).toEqual([]);

  const bare = await repo();
  expect(await knownRemoteFlowDirs(bare)).toEqual([]);

  expect(await knownRemoteFlowDirs(path.join(plain, "gone"))).toEqual([]);
});

test("a remote's HEAD symbolic ref is skipped; the branch it points at is read once", async () => {
  const root = await repo();
  await addRemoteRef(root, "origin/main", ["003-2026-10-01-one"]);
  await git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

  const found = await knownRemoteFlowDirs(root);

  expect(found).toEqual([{ ref: "origin/main", dir: "003-2026-10-01-one" }]);
});

test("a ref whose name starts with a dash is never handed to git as an option", async () => {
  const root = await repo();
  // `refs/remotes/-x/main` is a legal ref name whose short form starts with "-".
  await addRemoteRef(root, "-x/main", ["004-2026-10-01-dash"]);
  await addRemoteRef(root, "origin/main", ["006-2026-10-01-ok"]);

  const found = await knownRemoteFlowDirs(root);

  // The FULL ref (`refs/remotes/-x/main`) is what reaches `git ls-tree`, so a
  // dash-leading short name is read as a ref and never as an option.
  expect(found).toContainEqual({ ref: "-x/main", dir: "004-2026-10-01-dash" });
  expect(found).toContainEqual({ ref: "origin/main", dir: "006-2026-10-01-ok" });
});

test("folders under the flows directory that are not numbered flow folders are ignored", async () => {
  const root = await repo();
  await addRemoteRef(root, "origin/main", ["notes", "009-2026-10-01-real"]);

  expect((await knownRemoteFlowDirs(root)).map((entry) => entry.dir)).toEqual(["009-2026-10-01-real"]);
});

test("the number is the digits before the first dash", () => {
  expect(flowNumberOfDir("005-2026-10-01-x")).toBe(5);
  expect(flowNumberOfDir("x-005")).toBeNaN();
  expect(flowNumberOfDir("nodash")).toBeNaN();
});
