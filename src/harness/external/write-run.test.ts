// Tests for the claude write run (flow 370, AC3). A real temp git repo and the real
// git worktree port; the child is a fake spawn port that edits its cwd, so no test
// ever starts the claude binary.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createGitWorktreePort } from "../child/git-worktree-port";
import type { WorktreePort } from "../child/worktree";
import { withoutGitDiscoveryOverrides } from "../../lib/git-env";
import type { RunExternalChildInput } from "./runtime";
import type { ExternalSpawnPort, SpawnedProcess } from "./supervise";
import {
  EXTERNAL_WRITE_PATCH_FILE,
  EXTERNAL_WRITE_RUN_FILE,
  captureWriteDiff,
  flaggedPathsOf,
  loadExternalWriteRun,
  resolveBaseCommit,
  runExternalWriteChild,
  type ExternalWriteRunDeps,
} from "./write-run";

const GIT_ENV = withoutGitDiscoveryOverrides(process.env);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
}

async function* lines(items: readonly string[]): AsyncIterable<string> {
  for (const item of items) yield item;
}

type ChildScript = (cwd: string) => void | Promise<void>;

/** A fake child: runs `script` inside its cwd (the worktree), then exits. */
function scriptedChild(script: ChildScript, exitCode = 0): ExternalSpawnPort {
  return {
    spawn(_argv, opts): SpawnedProcess {
      const done = Promise.resolve(script(opts.cwd)).then(() => exitCode);
      return {
        stdout: (async function* () {
          await done;
        })(),
        stderr: lines([]),
        writeStdin: () => undefined,
        kill: () => undefined,
        exited: done,
      };
    },
  };
}

/** A child that never finishes on its own: it edits, then hangs until killed. */
function hangingChild(script: ChildScript): { port: ExternalSpawnPort; killed: () => boolean } {
  let killed = false;
  const port: ExternalSpawnPort = {
    spawn(_argv, opts): SpawnedProcess {
      script(opts.cwd);
      let release: (code: number) => void = () => undefined;
      const exited = new Promise<number>((resolve) => {
        release = resolve;
      });
      return {
        stdout: (async function* () {
          await exited;
        })(),
        stderr: lines([]),
        writeStdin: () => undefined,
        kill: () => {
          killed = true;
          release(137);
        },
        exited,
      };
    },
  };
  return { port, killed: () => killed };
}

let root: string;
let repo: string;
let dataDir: string;
let worktreesDir: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-write-run-test-")));
  repo = path.join(root, "repo");
  dataDir = path.join(root, "data");
  worktreesDir = path.join(root, "worktrees");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "T");
  writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
  writeFileSync(path.join(repo, "gone.txt"), "delete me\n");
  writeFileSync(path.join(repo, "run.sh"), "#!/bin/sh\necho hi\n");
  writeFileSync(path.join(repo, ".gitignore"), "ignored.log\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeInput(overrides: Partial<RunExternalChildInput> = {}): RunExternalChildInput {
  return {
    runtime: { kind: "external", agent: "claude-cli", sandbox: "worktree-write" },
    allowedActions: ["read-file", "write"],
    taskTitle: "edit things",
    taskDescription: "edit a few files",
    acceptanceCriteria: [],
    worktreeId: "wr-test",
    maxPromptBytes: 65536,
    timeoutMs: 30_000,
    parentEnv: { PATH: process.env.PATH },
    depth: 1,
    ...overrides,
  };
}

function deps(spawn: ExternalSpawnPort, overrides: Partial<ExternalWriteRunDeps> = {}): ExternalWriteRunDeps {
  return {
    spawn,
    capability: () => ({ enabled: true }),
    maxExternalDepth: 3,
    projectRoot: repo,
    dataDir,
    worktreesDir,
    ...overrides,
  };
}

function worktreeCount(): number {
  return git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
}

/** The worktree is gone from git's list AND from disk. */
function expectNoWorktreeLeft(): void {
  expect(worktreeCount()).toBe(1);
  expect(existsSync(worktreesDir) ? readdirSync(worktreesDir) : []).toEqual([]);
}

describe("captureWriteDiff", () => {
  test("captures edits, new files, deletions, mode changes and binary files against the base commit", async () => {
    const base = (await resolveBaseCommit(repo)) as string;
    const port = createGitWorktreePort({ repoRoot: repo, worktreesDir: root, ref: base });
    const wt = await port.create("cap-1");
    try {
      writeFileSync(path.join(wt.path, "a.txt"), "one\nTWO\nthree\n");
      writeFileSync(path.join(wt.path, "new.txt"), "brand new\n");
      writeFileSync(path.join(wt.path, "image.bin"), Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]));
      rmSync(path.join(wt.path, "gone.txt"));
      chmodSync(path.join(wt.path, "run.sh"), 0o755);
      const diff = await captureWriteDiff({ worktreePath: wt.path, baseCommit: base });
      const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));
      expect(byPath["a.txt"]).toEqual({ path: "a.txt", status: "modified" });
      expect(byPath["new.txt"]).toEqual({ path: "new.txt", status: "added" });
      expect(byPath["gone.txt"]).toEqual({ path: "gone.txt", status: "deleted" });
      expect(byPath["run.sh"]).toEqual({ path: "run.sh", status: "mode-changed" });
      expect(byPath["image.bin"]).toEqual({ path: "image.bin", status: "added", binary: true });
      expect(diff.patch).toContain("+TWO");
      expect(diff.patch).toContain("deleted file mode");
      expect(diff.patch).toContain("new mode 100755");
      expect(diff.patch).toContain("Binary files");
      expect(diff.refusedPaths).toEqual([]);
    } finally {
      await port.remove("cap-1");
    }
  });

  test("an unchanged worktree yields an empty diff, not an error", async () => {
    const base = (await resolveBaseCommit(repo)) as string;
    const port = createGitWorktreePort({ repoRoot: repo, worktreesDir: root, ref: base });
    const wt = await port.create("cap-2");
    try {
      expect(await captureWriteDiff({ worktreePath: wt.path, baseCommit: base })).toEqual({ patch: "", files: [], refusedPaths: [] });
    } finally {
      await port.remove("cap-2");
    }
  });

  test("a git failure throws instead of reporting an empty diff", async () => {
    await expect(captureWriteDiff({ worktreePath: repo, baseCommit: "0".repeat(40) })).rejects.toThrow();
  });
});

describe("flaggedPathsOf", () => {
  test("flags repo plumbing, CI, hooks and agent config, including nested copies", () => {
    const flagged = flaggedPathsOf([
      "src/a.ts",
      ".git/hooks/pre-commit",
      ".github/workflows/ci.yml",
      ".claude/settings.json",
      ".metaproject/index.md",
      ".husky/pre-push",
      "pkg/.github/dependabot.yml",
      "Jenkinsfile",
      "sub/.gitlab-ci.yml",
      "README.md",
    ]);
    expect(flagged).toEqual([
      ".git/hooks/pre-commit",
      ".github/workflows/ci.yml",
      ".claude/settings.json",
      ".metaproject/index.md",
      ".husky/pre-push",
      "pkg/.github/dependabot.yml",
      "Jenkinsfile",
      "sub/.gitlab-ci.yml",
    ]);
  });
});

describe("flaggedPathsOf, case and agent-config files", () => {
  test("matches every rule without regard to case", () => {
    expect(
      flaggedPathsOf([".Claude/settings.json", ".GitHub/workflows/x.yml", "pkg/.HUSKY/pre-push", "JENKINSFILE", ".Git/config", ".VSCode/Tasks.json", "src/a.ts"]),
    ).toEqual([".Claude/settings.json", ".GitHub/workflows/x.yml", "pkg/.HUSKY/pre-push", "JENKINSFILE", ".Git/config", ".VSCode/Tasks.json"]);
  });

  test("flags config that executes or changes tool behaviour", () => {
    const paths = [".mcp.json", "pkg/.envrc", ".gitattributes", ".gitmodules", ".vscode/tasks.json", ".vscode/settings.json", "app/.vscode/launch.json", ".githooks/pre-commit", ".gitlab-ci.yml"];
    expect(flaggedPathsOf(paths)).toEqual(paths);
  });

  test("flags a bare directory-named entry such as a symlink", () => {
    const paths = [".claude", ".github", ".git", ".metaproject", ".husky", ".githooks", ".circleci", "pkg/.claude", ".Cursor", ".codex", ".gemini"];
    expect(flaggedPathsOf(paths)).toEqual(paths);
  });

  test("flags agent instruction files and other agents' config directories", () => {
    const paths = ["CLAUDE.md", "AGENTS.md", "pkg/CLAUDE.md", ".cursor/rules/x.mdc", ".codex/config.toml", ".gemini/settings.json"];
    expect(flaggedPathsOf(paths)).toEqual(paths);
  });

  test("flags the per-developer entrypoints keryx writes the managed block to (flow 361)", () => {
    const paths = ["CLAUDE.local.md", "AGENTS.override.md", "pkg/Claude.Local.md", ".claude/settings.local.json"];
    expect(flaggedPathsOf(paths)).toEqual(paths);
  });

  test("leaves ordinary files and harmless editor files alone", () => {
    expect(flaggedPathsOf([".vscode/extensions.json", "Makefile", "docs/gitattributes.md", "src/envrc.ts", ".gitignore"])).toEqual([]);
  });
});

describe("runExternalWriteChild", () => {
  test("stores a pending-review record with a hash of the stored patch and leaves the operator's tree untouched", async () => {
    const result = await runExternalWriteChild(
      writeInput(),
      deps(
        scriptedChild((cwd) => {
          writeFileSync(path.join(cwd, "a.txt"), "one\nTWO\nthree\n");
          writeFileSync(path.join(cwd, "new.txt"), "brand new\n");
          mkdirSync(path.join(cwd, ".github", "workflows"), { recursive: true });
          writeFileSync(path.join(cwd, ".github", "workflows", "ci.yml"), "name: ci\n");
          rmSync(path.join(cwd, "gone.txt"));
        }),
      ),
    );
    const run = result.run;
    expect(run).toBeDefined();
    if (run === undefined) return;
    expect(run.state).toBe("pending-review");
    expect(run.agentId).toBe("claude-cli");
    expect(run.baseCommit).toBe(git(repo, "rev-parse", "HEAD").trim());
    expect(run.files.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
      "added:.github/workflows/ci.yml",
      "added:new.txt",
      "deleted:gone.txt",
      "modified:a.txt",
    ]);
    expect(run.flaggedPaths).toEqual([".github/workflows/ci.yml"]);
    expect(run.refusedPaths).toEqual([]);

    const patchPath = run.patchPath as string;
    expect(path.basename(patchPath)).toBe(EXTERNAL_WRITE_PATCH_FILE);
    const stored = readFileSync(patchPath, "utf8");
    expect(run.patchHash).toBe(createHash("sha256").update(stored, "utf8").digest("hex"));
    expect(stored).toContain("+brand new");
    expect(existsSync(path.join(path.dirname(patchPath), EXTERNAL_WRITE_RUN_FILE))).toBe(true);

    // Never applied: the operator's checkout has no change at all.
    expect(git(repo, "status", "--porcelain").trim()).toBe("");
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");
    expectNoWorktreeLeft();

    // The stored patch applies to the base tree.
    git(repo, "apply", "--check", patchPath);
    // And the record is loadable by full id and by prefix.
    expect(loadExternalWriteRun(repo, run.runId, dataDir)).toEqual(run);
    expect(loadExternalWriteRun(repo, run.runId.slice(0, 8), dataDir)?.runId).toBe(run.runId);
    expect(loadExternalWriteRun(repo, "no-such-run", dataDir)).toBeUndefined();
  });

  test("the child runs with the throwaway worktree as its cwd, cut from the recorded base commit", async () => {
    const seen: { cwd?: string; head?: string } = {};
    await runExternalWriteChild(
      writeInput(),
      deps(
        scriptedChild((cwd) => {
          seen.cwd = cwd;
          seen.head = git(cwd, "rev-parse", "HEAD").trim();
        }),
      ),
    );
    expect(seen.cwd?.startsWith(worktreesDir)).toBe(true);
    expect(seen.head).toBe(git(repo, "rev-parse", "HEAD").trim());
  });

  test("the diff is against the base commit even when the operator's checkout moves on during the run", async () => {
    const base = git(repo, "rev-parse", "HEAD").trim();
    const result = await runExternalWriteChild(
      writeInput(),
      deps(
        scriptedChild((cwd) => {
          writeFileSync(path.join(repo, "later.txt"), "operator work\n");
          git(repo, "add", "-A");
          git(repo, "commit", "-q", "-m", "later");
          writeFileSync(path.join(cwd, "a.txt"), "changed\n");
        }),
      ),
    );
    expect(result.run?.baseCommit).toBe(base);
    expect(result.run?.files.map((f) => f.path)).toEqual(["a.txt"]);
  });

  test("a file the base's .gitignore would hide is still captured", async () => {
    const result = await runExternalWriteChild(
      writeInput(),
      deps(scriptedChild((cwd) => writeFileSync(path.join(cwd, "ignored.log"), "hidden\n"))),
    );
    expect(result.run?.files).toEqual([{ path: "ignored.log", status: "added" }]);
  });

  test("the stored patch is redacted, the hash covers the redacted text, and the record says so", async () => {
    const token = `ghp_${"a1B2c3D4e5".repeat(4).slice(0, 36)}`;
    const result = await runExternalWriteChild(
      writeInput(),
      deps(scriptedChild((cwd) => writeFileSync(path.join(cwd, "config.txt"), `token = ${token}\n`))),
    );
    const run = result.run;
    expect(run?.redacted).toBe(true);
    const stored = readFileSync(run?.patchPath as string, "utf8");
    expect(stored).not.toContain(token);
    expect(stored).toContain("[REDACTED");
    expect(run?.patchHash).toBe(createHash("sha256").update(stored, "utf8").digest("hex"));
  });

  test("a clean patch is recorded as not redacted", async () => {
    const result = await runExternalWriteChild(
      writeInput(),
      deps(scriptedChild((cwd) => writeFileSync(path.join(cwd, "a.txt"), "plain\n"))),
    );
    expect(result.run?.redacted).toBe(false);
  });

  test("a run that changed nothing stores no record and leaves no worktree", async () => {
    const result = await runExternalWriteChild(writeInput(), deps(scriptedChild(() => undefined)));
    expect(result.run).toBeUndefined();
    expect(result.captureError).toBeUndefined();
    expect(existsSync(dataDir) ? readdirSync(dataDir) : []).toEqual([]);
    expectNoWorktreeLeft();
  });

  describe("symlinks", () => {
    test("a symlink pointing outside the worktree is refused and flagged, and no patch is kept", async () => {
      const result = await runExternalWriteChild(
        writeInput(),
        deps(
          scriptedChild((cwd) => {
            symlinkSync("/etc/passwd", path.join(cwd, "leak"));
            symlinkSync("../../outside", path.join(cwd, "rel-leak"));
            writeFileSync(path.join(cwd, "fine.txt"), "ok\n");
          }),
        ),
      );
      const run = result.run;
      expect(run?.state).toBe("refused");
      expect([...(run?.refusedPaths ?? [])].sort()).toEqual(["leak", "rel-leak"]);
      expect(run?.flaggedPaths).toEqual(expect.arrayContaining(["leak", "rel-leak"]));
      expect(run?.patchPath).toBeUndefined();
      expect(run?.patchHash).toBeUndefined();
      expect(existsSync(path.join(dataDir))).toBe(true);
      expectNoWorktreeLeft();
    });

    test("a symlink that stays inside the worktree is an ordinary change", async () => {
      const result = await runExternalWriteChild(
        writeInput(),
        deps(scriptedChild((cwd) => symlinkSync("a.txt", path.join(cwd, "alias")))),
      );
      expect(result.run?.state).toBe("pending-review");
      expect(result.run?.refusedPaths).toEqual([]);
      expect(result.run?.files).toEqual([{ path: "alias", status: "added" }]);
    });
  });

  describe("the worktree is removed on every exit path", () => {
    test("child crash (non-zero exit) still captures the partial work and removes the worktree", async () => {
      const result = await runExternalWriteChild(
        writeInput(),
        deps(scriptedChild((cwd) => writeFileSync(path.join(cwd, "partial.txt"), "half\n"), 1)),
      );
      expect(result.outcome.status).not.toBe("Completed");
      expect(result.run?.files).toEqual([{ path: "partial.txt", status: "added" }]);
      expect(result.run?.runStatus).toBe(result.outcome.status);
      expectNoWorktreeLeft();
    });

    test("timeout", async () => {
      const child = hangingChild((cwd) => writeFileSync(path.join(cwd, "slow.txt"), "wip\n"));
      const result = await runExternalWriteChild(writeInput({ timeoutMs: 150 }), deps(child.port));
      expect(child.killed()).toBe(true);
      expect(result.outcome.status).toBe("Timeout");
      expect(result.run?.files.map((f) => f.path)).toEqual(["slow.txt"]);
      expectNoWorktreeLeft();
    });

    test("operator abort through the run handle", async () => {
      const child = hangingChild((cwd) => writeFileSync(path.join(cwd, "aborted.txt"), "wip\n"));
      const result = await runExternalWriteChild(
        writeInput(),
        deps(child.port, { onSpawned: (handle) => setTimeout(() => handle.kill(), 30) }),
      );
      expect(child.killed()).toBe(true);
      expect(result.outcome.status).not.toBe("Completed");
      expect(result.run?.files.map((f) => f.path)).toEqual(["aborted.txt"]);
      expectNoWorktreeLeft();
    });

    test("a spawn port that throws", async () => {
      const throwing: ExternalSpawnPort = {
        spawn() {
          throw new Error("cannot fork");
        },
      };
      const result = await runExternalWriteChild(writeInput(), deps(throwing));
      expect(result.outcome.status).toBe("Error");
      expect(result.outcome.output).toContain("cannot fork");
      expect(result.run).toBeUndefined();
      expectNoWorktreeLeft();
    });

    test("an exception while capturing is reported, stores nothing, and still removes the worktree", async () => {
      const result = await runExternalWriteChild(
        writeInput(),
        deps(scriptedChild((cwd) => writeFileSync(path.join(cwd, "x.txt"), "x\n")), {
          capture: async () => {
            throw new Error("git exploded");
          },
        }),
      );
      expect(result.captureError).toContain("git exploded");
      expect(result.run).toBeUndefined();
      expect(existsSync(dataDir) ? readdirSync(dataDir) : []).toEqual([]);
      expectNoWorktreeLeft();
    });

    test("a failed removal is retried once", async () => {
      const removed: string[] = [];
      let first = true;
      const flaky: WorktreePort = {
        async create(id) {
          const dir = path.join(worktreesDir, id);
          mkdirSync(dir, { recursive: true });
          return { worktreeId: id, path: dir };
        },
        async remove(id) {
          if (first) {
            first = false;
            throw new Error("busy");
          }
          removed.push(id);
        },
        async merge(id) {
          return { worktreeId: id, ok: true };
        },
      };
      await runExternalWriteChild(
        writeInput(),
        deps(scriptedChild(() => undefined), { worktree: flaky, capture: async () => ({ patch: "", files: [], refusedPaths: [] }) }),
      );
      expect(removed).toEqual(["wr-test"]);
    });
  });

  describe("refusals happen before any worktree exists", () => {
    test("antigravity-cli is refused worktree-write, naming why, and creates nothing", async () => {
      const result = await runExternalWriteChild(
        writeInput({ runtime: { kind: "external", agent: "antigravity-cli", sandbox: "worktree-write" } }),
        deps(scriptedChild(() => undefined)),
      );
      expect(result.outcome.status).toBe("Denied");
      expect(result.outcome.output).toContain("edit tool writes outside the worktree");
      expect(result.run).toBeUndefined();
      expectNoWorktreeLeft();
    });

    test("a read-only block is not a write run", async () => {
      const result = await runExternalWriteChild(
        writeInput({ runtime: { kind: "external", agent: "claude-cli", sandbox: "read-only" } }),
        deps(scriptedChild(() => undefined)),
      );
      expect(result.outcome.status).toBe("Error");
      expect(result.outcome.output).toContain("worktree-write");
    });

    test("a directory that is not a git checkout is refused with a named reason", async () => {
      const plain = path.join(root, "plain");
      mkdirSync(plain);
      const result = await runExternalWriteChild(writeInput(), deps(scriptedChild(() => undefined), { projectRoot: plain }));
      expect(result.outcome.status).toBe("Error");
      expect(result.outcome.output).toContain("git checkout");
    });
  });

  describe("codex-cli write run (flow 371)", () => {
    const codexInput = (): RunExternalChildInput => writeInput({ runtime: { kind: "external", agent: "codex-cli", sandbox: "worktree-write" } });
    const probe = (output: string | undefined) => async () => ({ binaryFound: true, ...(output === undefined ? {} : { detectOutput: output }) });
    const spawned = (): { port: ExternalSpawnPort; argvs: string[][] } => {
      const argvs: string[][] = [];
      const inner = scriptedChild((cwd) => writeFileSync(path.join(cwd, "a.txt"), "edited by codex\n"));
      return {
        argvs,
        port: {
          spawn(argv, opts) {
            argvs.push([...argv]);
            return inner.spawn(argv, opts);
          },
        },
      };
    };

    test.each([
      ["older", "codex-cli 0.158.9", "found 0.158.9"],
      ["an older major", "codex-cli 0.147.0", "found 0.147.0"],
      ["the old floor", "codex-cli 0.159.0", "found 0.159.0"],
      ["newer than verified", "codex-cli 0.160.1", "found 0.160.1"],
      ["a pre-release", "codex-cli 0.159.2-rc.1", "a pre-release"],
    ])("a %s codex is refused before any spawn or worktree, naming the found and required versions", async (_name, output, found) => {
      const child = spawned();
      const result = await runExternalWriteChild(codexInput(), deps(child.port, { detect: probe(output) }));
      expect(result.outcome.status).toBe("Denied");
      expect(result.outcome.output).toContain(found);
      expect(result.outcome.output).toContain("0.159.2");
      expect(result.outcome.output).toContain("0.160.0");
      expect(child.argvs).toEqual([]);
      expect(result.run).toBeUndefined();
      expectNoWorktreeLeft();
    });

    test.each([
      ["no version in the banner", probe("codex is great")],
      ["no detect output at all", probe(undefined)],
      ["no probe supplied", undefined],
    ])("a codex whose version cannot be read (%s) is refused before any spawn or worktree", async (_name, detect) => {
      const child = spawned();
      const result = await runExternalWriteChild(codexInput(), deps(child.port, detect === undefined ? {} : { detect }));
      expect(result.outcome.status).toBe("Denied");
      expect(result.outcome.output).toContain("could not be read");
      expect(result.outcome.output).toContain("0.159.2");
      expect(child.argvs).toEqual([]);
      expectNoWorktreeLeft();
    });

    test.each(["codex-cli 0.159.2", "codex-cli 0.159.7"])(
      "%s captures the diff through the same pipeline as claude and removes the worktree",
      async (output) => {
        const child = spawned();
        const result = await runExternalWriteChild(codexInput(), deps(child.port, { detect: probe(output) }));
        expect(child.argvs).toHaveLength(1);
        expect(child.argvs[0]).toContain("workspace-write");
        expect(child.argvs[0]).toContain("--ignore-rules");
        const run = result.run;
        expect(run?.agentId).toBe("codex-cli");
        expect(run?.state).toBe("pending-review");
        expect(run?.files).toEqual([{ path: "a.txt", status: "modified" }]);
        const stored = readFileSync(run?.patchPath as string, "utf8");
        expect(stored).toContain("+edited by codex");
        expect(run?.patchHash).toBe(createHash("sha256").update(stored, "utf8").digest("hex"));
        expect(loadExternalWriteRun(repo, run?.runId as string, dataDir)).toEqual(run);
        expectNoWorktreeLeft();
      },
    );

    test("the worktree is removed when the codex spawn throws", async () => {
      const result = await runExternalWriteChild(
        codexInput(),
        deps(
          {
            spawn() {
              throw new Error("spawn failed");
            },
          },
          { detect: probe("codex-cli 0.159.2") },
        ),
      );
      expect(result.outcome.isError).toBe(true);
      expectNoWorktreeLeft();
    });

    test("the verified-version gate does not apply to claude", async () => {
      const child = spawned();
      const result = await runExternalWriteChild(writeInput(), deps(child.port));
      expect(child.argvs).toHaveLength(1);
      expect(result.run?.agentId).toBe("claude-cli");
    });
  });
});
