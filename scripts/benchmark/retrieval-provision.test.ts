import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  forgetRegisteredProject,
  provisionContextOn,
  KERYX_GRAPH_BUILD,
  KERYX_INIT,
  type CommandRunner,
} from "./retrieval-provision";

// The commands are faked. What needs proving is WHICH commands run and when —
// that a committed workspace is not overwritten, that the graph is always built,
// and that a failure stops the arm instead of scoring it half-provisioned.
// Running the real `keryx init` fifty times to learn that would be slow and
// would write to the user's global registry.

function runner(exit: (command: readonly string[]) => number = () => 0): CommandRunner & {
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    async run({ command }) {
      calls.push([...command]);
      return { exitCode: exit(command), stderr: exit(command) === 0 ? "" : "boom" };
    },
  };
}

async function worktree(withMetaproject: boolean): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-provision-"));
  if (withMetaproject) {
    await mkdir(path.join(root, ".metaproject", "wiki"), { recursive: true });
  }
  return root;
}

describe("provisionContextOn", () => {
  test("builds the graph even when the workspace is committed", async () => {
    // The graph database is generated and never committed — this repository
    // tracks three gdgraph files and none of them answers `gdgraph affected`.
    // Without this the context-on arm holds a routing index pointing at a graph
    // that does not exist, which is the state the smoke run actually ran in.
    const root = await worktree(true);
    const r = runner();
    try {
      const result = await provisionContextOn(root, r);
      expect(r.calls).toEqual([[...KERYX_GRAPH_BUILD]]);
      expect(result.initialized).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("initializes only when the checkout has no workspace at all", async () => {
    const root = await worktree(false);
    const r = runner();
    try {
      const result = await provisionContextOn(root, r);
      expect(r.calls).toEqual([[...KERYX_INIT], [...KERYX_GRAPH_BUILD]]);
      expect(result.initialized).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("never re-initializes over a committed workspace", async () => {
    // `keryx init` regenerates the workspace. Running it over a checkout that
    // legitimately carries the wiki at that revision would overwrite the very
    // thing the arm is supposed to have.
    const root = await worktree(true);
    const r = runner();
    try {
      await provisionContextOn(root, r);
      expect(r.calls.some((c) => c.includes("init"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a failed graph build throws rather than scoring a half-provisioned arm", async () => {
    const root = await worktree(true);
    try {
      await expect(
        provisionContextOn(root, runner((c) => (c.includes("gdgraph") ? 1 : 0))),
      ).rejects.toThrow(/gdgraph build failed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a failed init stops before the graph is attempted", async () => {
    const root = await worktree(false);
    const r = runner((c) => (c.includes("init") ? 1 : 0));
    try {
      await expect(provisionContextOn(root, r)).rejects.toThrow(/keryx init failed/);
      expect(r.calls.some((c) => c.includes("gdgraph"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("KERYX_INIT", () => {
  test("suppresses every git hook, because worktrees share the real repo's hooks", () => {
    // `git rev-parse --git-path hooks` inside a worktree resolves to the MAIN
    // repository's .git/hooks — checked in a real worktree, not assumed. The
    // intended primary repository is the operator's work checkout, and fifty
    // throwaway trees rewriting its hooks is not an acceptable cost of a
    // measurement. This test exists so nobody tidies the flags away.
    for (const flag of [
      "--no-gdgraph-hook",
      "--no-gdskills-hook",
      "--no-health-hook",
      "--no-testing-post-commit-hook",
      "--no-testing-pre-push-hook",
      "--no-security-hook",
    ]) {
      expect(KERYX_INIT).toContain(flag);
    }
  });

  test("keeps the .claude agent hooks, which live in the worktree and ARE the arm", () => {
    // That file is per-worktree, so it is isolated; and those hooks are part of
    // what "keryx is set up here" means.
    expect(KERYX_INIT).not.toContain("--no-security-agent-hook");
  });
});

describe("forgetRegisteredProject", () => {
  test("releases the registry entry the throwaway tree created", async () => {
    // `keryx projects list` already shows twenty dead entries left by earlier
    // throwaway trees. A fifty-task sweep would add fifty more, and `forget` is
    // the only way an entry is ever removed.
    const r = runner();
    const withList = {
      ...r,
      async list() {
        return [
          { projectId: "other", path: "/home/someone/real-project" },
          { projectId: "abc-123", path: "/tmp/wt-7" },
        ];
      },
    };
    expect(await forgetRegisteredProject("/tmp/wt-7", withList)).toBe(true);
    expect(r.calls).toEqual([["keryx", "projects", "forget", "abc-123"]]);
  });

  test("leaves entries that are not this worktree alone", async () => {
    const r = runner();
    const withList = {
      ...r,
      async list() {
        return [{ projectId: "other", path: "/home/someone/real-project" }];
      },
    };
    expect(await forgetRegisteredProject("/tmp/wt-7", withList)).toBe(false);
    expect(r.calls).toEqual([]);
  });

  test("a registry it cannot read is reported, not thrown", async () => {
    // Tidying the registry failing must not fail a task that otherwise ran
    // correctly — but the caller has to be able to tell, so leftovers can be
    // reported instead of assumed absent.
    const r = runner();
    const withList = {
      ...r,
      async list(): Promise<{ projectId: string; path: string }[]> {
        throw new Error("registry unreadable");
      },
    };
    expect(await forgetRegisteredProject("/tmp/wt-7", withList)).toBe(false);
  });
});
