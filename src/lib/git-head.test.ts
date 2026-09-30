import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  classifyAgainstHead,
  indexHoldsFile,
  readHeadBlob,
  readIndexBlob,
  restoreWorktreeFileFromHead,
  worktreeFileIsClean,
} from "./git-head";
import { uniqueTestRoot } from "./test-tmp";

async function run(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

async function initRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await run(root, ["init", "-q"]);
  await run(root, ["config", "user.email", "keryx@example.test"]);
  await run(root, ["config", "user.name", "Keryx Test"]);
}

test("readHeadBlob returns the committed bytes, not the working tree's", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-git-head-blob");
  try {
    await initRepo(root);
    const committed = "# Title\n\n\n\ntrailing spaces   \n";
    await mkdir(path.join(root, ".claude"));
    await writeFile(path.join(root, "AGENTS.md"), committed);
    await writeFile(path.join(root, ".claude", "settings.json"), "{}\n");
    await run(root, ["add", "AGENTS.md", ".claude/settings.json"]);
    await run(root, ["commit", "-q", "-m", "fixture"]);
    await writeFile(path.join(root, "AGENTS.md"), "edited\n");

    expect(await readHeadBlob(root, "AGENTS.md")).toBe(committed);
    expect(await readHeadBlob(root, ".claude/settings.json")).toBe("{}\n");
    expect(await readHeadBlob(root, "MISSING.md")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readHeadBlob resolves the path against a project root nested inside the repository", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-git-head-nested");
  try {
    await initRepo(root);
    const project = path.join(root, "packages", "app");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "CLAUDE.md"), "nested\n");
    await writeFile(path.join(root, "CLAUDE.md"), "top\n");
    await run(root, ["add", "-A"]);
    await run(root, ["commit", "-q", "-m", "fixture"]);

    expect(await readHeadBlob(project, "CLAUDE.md")).toBe("nested\n");
    expect(await classifyAgainstHead(project, "CLAUDE.md")).toBe("equal");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifyAgainstHead tells untracked, equal and differs apart", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-git-head-classify");
  try {
    await initRepo(root);
    await writeFile(path.join(root, "AGENTS.md"), "team\n");
    // No commit yet: nothing is in HEAD.
    expect(await classifyAgainstHead(root, "AGENTS.md")).toBe("untracked");

    await run(root, ["add", "AGENTS.md"]);
    await run(root, ["commit", "-q", "-m", "fixture"]);
    expect(await classifyAgainstHead(root, "AGENTS.md")).toBe("equal");

    await writeFile(path.join(root, "AGENTS.md"), "team\nedited\n");
    expect(await classifyAgainstHead(root, "AGENTS.md")).toBe("differs");

    // A staged edit still differs from HEAD.
    await run(root, ["add", "AGENTS.md"]);
    expect(await classifyAgainstHead(root, "AGENTS.md")).toBe("differs");

    await writeFile(path.join(root, "CLAUDE.md"), "new\n");
    expect(await classifyAgainstHead(root, "CLAUDE.md")).toBe("untracked");
    // Staged but never committed: HEAD has no version of it to compare with.
    await run(root, ["add", "CLAUDE.md"]);
    expect(await classifyAgainstHead(root, "CLAUDE.md")).toBe("untracked");
    expect(await classifyAgainstHead(root, "MISSING.md")).toBe("untracked");

    // Deleted from the working tree while HEAD still has it.
    await run(root, ["commit", "-q", "-m", "second"]);
    await rm(path.join(root, "AGENTS.md"));
    expect(await classifyAgainstHead(root, "AGENTS.md")).toBe("differs");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Flow 361 review round 1, F-003: a path after `--` is still a pathspec, so a
// manifest path holding glob characters answered for other files.
test("paths are literal: a glob or pathspec magic never answers for another file", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-git-head-literal");
  try {
    await initRepo(root);
    await writeFile(path.join(root, "s.ts"), "committed\n");
    await run(root, ["add", "s.ts"]);
    await run(root, ["commit", "-q", "-m", "fixture"]);
    await writeFile(path.join(root, "s.ts"), "edited\n");

    expect(await indexHoldsFile(root, "s*")).toBe(false);
    expect(await indexHoldsFile(root, ":(glob)s*")).toBe(false);
    expect(await worktreeFileIsClean(root, "s*")).toBe(true);
    expect(await restoreWorktreeFileFromHead(root, "s*")).toBe(false);
    expect(await readFile(path.join(root, "s.ts"), "utf8")).toBe("edited\n");
    expect(await classifyAgainstHead(root, "s*")).toBe("untracked");
    // The file itself still answers.
    expect(await indexHoldsFile(root, "s.ts")).toBe(true);
    expect(await worktreeFileIsClean(root, "s.ts")).toBe(false);
    expect(await readHeadBlob(root, "s.ts")).toBe("committed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readIndexBlob returns the staged bytes, and nothing for a file the index does not hold", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-git-head-index");
  try {
    await initRepo(root);
    await writeFile(path.join(root, "AGENTS.md"), "committed\n");
    await run(root, ["add", "AGENTS.md"]);
    await run(root, ["commit", "-q", "-m", "fixture"]);
    await writeFile(path.join(root, "AGENTS.md"), "staged\n");
    await run(root, ["add", "AGENTS.md"]);
    await writeFile(path.join(root, "AGENTS.md"), "working\n");

    expect(await readIndexBlob(root, "AGENTS.md")).toBe("staged\n");
    expect(await readIndexBlob(root, "MISSING.md")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("outside a git repository nothing is in HEAD", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-git-head-nogit");
  try {
    await writeFile(path.join(root, "AGENTS.md"), "team\n");
    expect(await readHeadBlob(root, "AGENTS.md")).toBeUndefined();
    expect(await classifyAgainstHead(root, "AGENTS.md")).toBe("untracked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
