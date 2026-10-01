// Flow 384: what this clone can learn about other branches' flow numbers
// without a network — and that it never gets in the way when it can learn nothing.
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { flowNumberOfDir, knownRemoteFlowDirs, MAX_REFS, orderRemoteRefs, remoteFlowNumbers, safeDirName, type RefEntry } from "./remote-flows";
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

test("a four-digit number is read whole by flowNumberOfDir, but a four-digit remote folder is not a flow folder", async () => {
  const root = await repo();
  await addRemoteRef(root, "origin/main", ["1000-2026-10-01-big", "9999-x", "004-2026-10-01-ok"]);
  expect(flowNumberOfDir("1000-2026-10-01-big")).toBe(1000);
  // Same rule as the local listing: exactly three digits, then a dash.
  expect(await remoteFlowNumbers(root)).toEqual([4]);
});

test("a date-named folder is not a flow folder, so it cannot poison the reserved numbers", async () => {
  const root = await repo();
  await addRemoteRef(root, "origin/main", ["2026-notes", "2026-10-01-meeting", "008-2026-10-01-real"]);

  expect((await knownRemoteFlowDirs(root)).map((entry) => entry.dir)).toEqual(["008-2026-10-01-real"]);
  expect(await remoteFlowNumbers(root)).toEqual([8]);
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

test("a project in a non-ASCII subdirectory reads remote folders with no stray quote", async () => {
  const root = await repo();
  await addRemoteRef(root, "origin/main", ["007-2026-10-01-beta"], "проект/");
  await mkdir(path.join(root, "проект", ".metaproject"), { recursive: true });

  const found = await knownRemoteFlowDirs(path.join(root, "проект"));

  expect(found).toEqual([{ ref: "origin/main", dir: "007-2026-10-01-beta" }]);
});

test("control characters are stripped from a folder name before it is printed", () => {
  expect(safeDirName("007-x\u001b[31mred\u007f\u0085")).toBe("007-x[31mred");
  expect(safeDirName("007-проект")).toBe("007-проект");
});

function entry(ref: string, tip: string, symref = ""): RefEntry {
  return { tip, ref: `refs/remotes/${ref}`, symref };
}

test("refs are ordered main/master, then the HEAD target, then the rest; HEAD itself is dropped", () => {
  const ordered = orderRemoteRefs([
    entry("origin/aaa", "1"),
    entry("origin/HEAD", "2", "refs/remotes/origin/trunk"),
    entry("origin/trunk", "2"),
    entry("origin/main", "3"),
    entry("upstream/master", "4"),
    entry("origin/zzz", "5"),
  ]);

  expect(ordered).toEqual([
    "refs/remotes/origin/main",
    "refs/remotes/upstream/master",
    "refs/remotes/origin/trunk",
    "refs/remotes/origin/aaa",
    "refs/remotes/origin/zzz",
  ]);
});

test("the cap keeps main and the HEAD target and drops alphabetical stragglers; equal tips are read once", () => {
  const entries: RefEntry[] = [];
  for (let index = 0; index < MAX_REFS + 20; index += 1) {
    entries.push(entry(`origin/b${String(index).padStart(4, "0")}`, `tip${index}`));
  }
  entries.push(entry("origin/main", "main-tip"), entry("origin/zzz-default", "def-tip"), entry("origin/HEAD", "def-tip", "refs/remotes/origin/zzz-default"));
  entries.push(entry("origin/dup", "main-tip"));

  const ordered = orderRemoteRefs(entries);

  expect(ordered).toHaveLength(MAX_REFS);
  expect(ordered[0]).toBe("refs/remotes/origin/main");
  expect(ordered[1]).toBe("refs/remotes/origin/zzz-default");
  expect(ordered).not.toContain("refs/remotes/origin/dup");
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
