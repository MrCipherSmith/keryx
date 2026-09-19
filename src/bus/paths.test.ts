import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitToplevel } from "../lib/clone-scope";
import { projectKeyFromPath } from "../session/paths";
import { isBusRefusal } from "./errors";
import {
  assertBusId,
  busRootFor,
  leasePath,
  parseRotatedSegmentName,
  presencePath,
  resolveBusRoot,
  rotatedSegmentPath,
  slugifyProjectPath,
} from "./paths";

// AC2: one bus per clone, keyed on the resolved project root.

const ROOTS: string[] = [];

afterAll(async () => {
  await Promise.all(ROOTS.map((root) => rm(root, { recursive: true, force: true })));
});

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
    env: {
      ...process.env,
      // Isolated from the host's git config (hooks, signing, identity rules).
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "keryx test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "keryx test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if ((await proc.exited) !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

// A repository with one commit, so `git worktree add` has something to branch from.
async function freshRepo(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-bus-root-"));
  ROOTS.push(root);
  await writeFile(path.join(root, "README.md"), "x\n", "utf8");
  await git(root, "init", "-b", "main");
  await git(root, "add", ".");
  await git(root, "commit", "-m", "initial");
  return root;
}

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("resolveBusRoot", () => {
  test("a subdirectory and a linked worktree of one clone resolve to the same git-common-dir root", async () => {
    const repo = await freshRepo();
    const sub = path.join(repo, "src", "deep");
    await mkdir(sub, { recursive: true });
    const worktree = path.join(repo, "wt");
    await git(repo, "worktree", "add", "-b", "feature", worktree, "main");

    const fromRoot = await resolveBusRoot(repo);
    const fromSub = await resolveBusRoot(sub);
    const fromWorktree = await resolveBusRoot(worktree);

    const expected = path.join(await realpath(path.join(repo, ".git")), "keryx", "bus", "root");
    expect(fromRoot).toEqual({ root: expected, projectKey: "root", kind: "git" });
    expect(fromSub).toEqual(fromRoot);
    expect(fromWorktree).toEqual(fromRoot);
  });

  test("a directory outside git falls back to <dataDir>/bus/<projectKeyFromPath(projectRoot)>", async () => {
    if ((await gitToplevel(tmpdir())) !== null) return; // host tmp inside a repo: not testable here
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-bus-nogit-"));
    ROOTS.push(dir);
    const dataDir = path.join(dir, "data");

    const resolved = await resolveBusRoot(dir, { dataDir });

    const key = projectKeyFromPath(await realpath(dir));
    expect(resolved).toEqual({ root: path.join(dataDir, "bus", key), projectKey: key, kind: "data-dir" });
  });
});

describe("busRootFor (pure)", () => {
  test("a project nested inside the repository gets a slugified key", () => {
    expect(busRootFor({ commonDir: "/r/.git", toplevel: "/r", projectRoot: "/r/Packages/App One" })).toEqual({
      root: path.join("/r/.git", "keryx", "bus", "packages-app-one"),
      projectKey: "packages-app-one",
      kind: "git",
    });
  });

  test("the project root at the toplevel is keyed root", () => {
    expect(busRootFor({ commonDir: "/r/.git", toplevel: "/r", projectRoot: "/r" }).projectKey).toBe("root");
  });

  test("slugifyProjectPath falls back to root for an empty slug", () => {
    expect(slugifyProjectPath("///")).toBe("root");
    expect(slugifyProjectPath("a/b_c")).toBe("a-b-c");
  });
});

describe("ids are checked before any path is built", () => {
  const root = "/bus";

  test("a UUID builds the expected paths", () => {
    expect(presencePath(root, ID)).toBe(path.join(root, "presence", `${ID}.json`));
    expect(leasePath(root, ID)).toBe(path.join(root, "leases", `${ID}.json`));
    expect(rotatedSegmentPath(root, 3)).toBe(path.join(root, "events.3.jsonl"));
  });

  for (const bad of ["../../etc/passwd", "", `${ID}/x`, "not-a-uuid", `${ID}.json`, "0f8fad5b-d9cb-469f-a165-70867728950"]) {
    test(`refuses ${JSON.stringify(bad)} with invalid-id`, () => {
      for (const build of [() => presencePath(root, bad), () => leasePath(root, bad), () => assertBusId(bad)]) {
        let caught: unknown;
        try {
          build();
        } catch (error) {
          caught = error;
        }
        expect(isBusRefusal(caught, "invalid-id")).toBe(true);
      }
    });
  }

  test("rotated segment names round-trip and anything else is not a segment", () => {
    expect(parseRotatedSegmentName("events.12.jsonl")).toBe(12);
    expect(parseRotatedSegmentName("events.jsonl")).toBeUndefined();
    expect(parseRotatedSegmentName("events.0.jsonl")).toBeUndefined();
    expect(parseRotatedSegmentName("events.-1.jsonl")).toBeUndefined();
    expect(() => rotatedSegmentPath(root, 0)).toThrow(/invalid-id/);
  });
});
