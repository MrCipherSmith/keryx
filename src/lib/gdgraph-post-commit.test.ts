import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { renderGdgraphPostCommitHook } from "./templates";

// The gdgraph post-commit hook is the automatic half of the graph freshness
// contract in `modules/gdgraph.md`: after a graph-relevant commit it must
// actually rebuild the graph, and it must never cost the user a commit. These
// tests run the rendered shell body, so a claim in the docs cannot outlive the
// behaviour it describes (the previous body only printed a reminder while the
// skill file said it refreshed the graph).

type HookRun = {
  exitCode: number;
  stdout: string;
  stderr: string;
  calls: string;
};

async function withRepo(
  run: (ctx: {
    root: string;
    git: (args: string[]) => void;
    runHook: (env?: Record<string, string>) => Promise<HookRun>;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-gdgraph-hook-"));
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const callLog = path.join(root, "keryx-calls.log");

  const git = (args: string[]) => {
    Bun.spawnSync({
      cmd: ["git", ...args],
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
  };

  const runHook = async (env: Record<string, string> = {}): Promise<HookRun> => {
    const file = path.join(root, "post-commit");
    await writeFile(file, `#!/usr/bin/env sh\n\n${renderGdgraphPostCommitHook()}`, "utf8");
    await chmod(file, 0o755);
    const proc = Bun.spawnSync({
      cmd: ["sh", file],
      cwd: root,
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: home,
        KERYX_CALL_LOG: callLog,
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    let calls = "";
    try {
      calls = await readFile(callLog, "utf8");
    } catch {
      calls = "";
    }
    return {
      exitCode: proc.exitCode ?? -1,
      stdout: proc.stdout.toString(),
      stderr: proc.stderr.toString(),
      calls,
    };
  };

  try {
    await mkdir(home, { recursive: true });
    await mkdir(binDir, { recursive: true });
    // A fake `keryx` that records its arguments and honours a forced exit code,
    // so the test observes what the hook invoked without building a real graph.
    const fake = path.join(binDir, "keryx");
    await writeFile(
      fake,
      [
        "#!/usr/bin/env sh",
        'printf "%s\\n" "$*" >> "$KERYX_CALL_LOG"',
        'exit "${FAKE_KERYX_EXIT:-0}"',
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(fake, 0o755);

    git(["init", "-q"]);
    await run({ root, git, runHook });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function commitFile(
  root: string,
  git: (args: string[]) => void,
  relPath: string,
  body: string,
): Promise<void> {
  const abs = path.join(root, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, body, "utf8");
  git(["add", relPath]);
  git(["commit", "-q", "-m", `touch ${relPath}`]);
}

test("rebuilds the graph after a graph-relevant commit", async () => {
  await withRepo(async ({ root, git, runHook }) => {
    await commitFile(root, git, "src/a.ts", "export const a = 1;\n");

    const result = await runHook();

    expect(result.calls.trim()).toBe("gdgraph build");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("rebuilding gdgraph");
    expect(result.stdout).toContain("gdgraph rebuilt");
  });
});

test("does not rebuild after a commit that touched no graph-relevant path", async () => {
  await withRepo(async ({ root, git, runHook }) => {
    await commitFile(root, git, "README.md", "# readme\n");

    const result = await runHook();

    expect(result.calls).toBe("");
    expect(result.exitCode).toBe(0);
  });
});

test("KERYX_GDGRAPH_HOOK_REBUILD=0 falls back to the printed reminder", async () => {
  await withRepo(async ({ root, git, runHook }) => {
    await commitFile(root, git, "src/a.ts", "export const a = 1;\n");

    const result = await runHook({ KERYX_GDGRAPH_HOOK_REBUILD: "0" });

    expect(result.calls).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("KERYX_GDGRAPH_HOOK_REBUILD=0");
    expect(result.stdout).toContain("keryx gdgraph build");
  });
});

test("a failing build warns but never fails the commit", async () => {
  await withRepo(async ({ root, git, runHook }) => {
    await commitFile(root, git, "src/a.ts", "export const a = 1;\n");

    const result = await runHook({ FAKE_KERYX_EXIT: "1" });

    expect(result.calls.trim()).toBe("gdgraph build");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("gdgraph build failed");
  });
});

test("a missing keryx prints the manual command instead of failing", async () => {
  await withRepo(async ({ root, git, runHook }) => {
    await commitFile(root, git, "src/a.ts", "export const a = 1;\n");

    // PATH without the fake binary and a HOME without ~/.local/bin/keryx: the
    // hook must degrade to a message, exactly like the security hook does on
    // version skew.
    const result = await runHook({ PATH: "/usr/bin:/bin" });

    expect(result.calls).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("keryx command not found");
  });
});

test("does nothing outside a git work tree", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-gdgraph-hook-nogit-"));
  try {
    const file = path.join(dir, "post-commit");
    await writeFile(file, `#!/usr/bin/env sh\n\n${renderGdgraphPostCommitHook()}`, "utf8");
    await chmod(file, 0o755);
    const proc = Bun.spawnSync({
      cmd: ["sh", file],
      cwd: dir,
      // GIT_CEILING_DIRECTORIES stops git from discovering a repository above
      // the OS temp dir on machines where one exists.
      env: { PATH: "/usr/bin:/bin", HOME: dir, GIT_CEILING_DIRECTORIES: dir },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toBe("");
    expect(proc.stderr.toString()).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolves keryx from $HOME/.local/bin when it is not on PATH", async () => {
  await withRepo(async ({ root, git, runHook }) => {
    await commitFile(root, git, "src/a.ts", "export const a = 1;\n");

    const fallbackBin = path.join(root, "home", ".local", "bin");
    await mkdir(fallbackBin, { recursive: true });
    const fake = path.join(fallbackBin, "keryx");
    await writeFile(
      fake,
      ["#!/usr/bin/env sh", 'printf "%s\\n" "$*" >> "$KERYX_CALL_LOG"', "exit 0", ""].join("\n"),
      "utf8",
    );
    await chmod(fake, 0o755);

    const result = await runHook({ PATH: "/usr/bin:/bin" });

    expect(result.calls.trim()).toBe("gdgraph build");
    expect(result.exitCode).toBe(0);
  });
});
