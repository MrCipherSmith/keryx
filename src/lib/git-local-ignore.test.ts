import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import * as localIgnore from "./git-local-ignore";
import {
  explainIgnoredPaths,
  isMetaprojectIgnoredAsWhole,
  isPathIgnored,
  planLocalIgnoreBlock,
  replaceLocalIgnoreBlock,
  resolveLocalExcludePath,
} from "./git-local-ignore";
import { uniqueTestRoot } from "./test-tmp";

async function run(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
}

/**
 * `core.excludesFile` points at a file that does not exist, so the
 * developer's own global excludes (Claude Code adds
 * `.claude/settings.local.json` there, and a machine may list
 * `CLAUDE.local.md`) cannot answer for the fixture. Set in the repository's
 * own config — changing `process.env` would not reach the `git` processes
 * `Bun.spawn` starts — and shared by every linked worktree of it.
 */
async function initRepo(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await run(root, ["init", "-q"]);
  await run(root, ["config", "user.email", "keryx@example.test"]);
  await run(root, ["config", "user.name", "Keryx Test"]);
  await run(root, ["config", "core.excludesFile", path.join(root, ".git", "no-global-excludes")]);
}

const LOCAL_TARGETS = ["CLAUDE.local.md", "AGENTS.override.md", ".claude/settings.local.json"];

test("isPathIgnored answers for untracked and for tracked paths", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-local-ignore-check");
  try {
    await initRepo(root);
    await mkdir(path.join(root, ".claude"));
    await writeFile(path.join(root, ".claude", "settings.json"), "{}\n");
    await run(root, ["add", ".claude/settings.json"]);
    await run(root, ["commit", "-q", "-m", "fixture"]);
    expect(await isPathIgnored(root, "CLAUDE.local.md")).toEqual({ git: true, ignored: false });
    expect(await isPathIgnored(root, ".claude/settings.json")).toEqual({ git: true, ignored: false });

    await writeFile(path.join(root, ".gitignore"), "CLAUDE.local.md\n.claude/\n");
    expect(await isPathIgnored(root, "CLAUDE.local.md")).toEqual({ git: true, ignored: true });
    // Tracked, yet matched by an ignore rule: plain `git check-ignore` says
    // "not ignored" here; `--no-index` is what gives the rule's own answer.
    expect(await isPathIgnored(root, ".claude/settings.json")).toEqual({ git: true, ignored: true });
    expect(await isPathIgnored(root, "AGENTS.override.md")).toEqual({ git: true, ignored: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isMetaprojectIgnoredAsWhole is true only for a blanket rule", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-local-ignore-whole");
  try {
    await initRepo(root);
    expect(await isMetaprojectIgnoredAsWhole(root)).toEqual({ git: true, ignored: false });

    await writeFile(path.join(root, ".gitignore"), ".metaproject/runtime/\n.metaproject/data/**/raw/\n");
    expect(await isMetaprojectIgnoredAsWhole(root)).toEqual({ git: true, ignored: false });

    // Holds before the directory exists and after.
    await writeFile(path.join(root, ".gitignore"), ".metaproject/\n");
    expect(await isMetaprojectIgnoredAsWhole(root)).toEqual({ git: true, ignored: true });
    await mkdir(path.join(root, ".metaproject"));
    expect(await isMetaprojectIgnoredAsWhole(root)).toEqual({ git: true, ignored: true });

    await writeFile(path.join(root, ".gitignore"), ".metaproject\n");
    expect(await isMetaprojectIgnoredAsWhole(root)).toEqual({ git: true, ignored: true });

    // A blanket rule in info/exclude counts just the same.
    await rm(path.join(root, ".gitignore"));
    await mkdir(path.join(root, ".git", "info"), { recursive: true });
    await writeFile(path.join(root, ".git", "info", "exclude"), ".metaproject/\n");
    expect(await isMetaprojectIgnoredAsWhole(root)).toEqual({ git: true, ignored: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Flow 361 review round 1, F-007: the additive writer had no caller outside
// its tests and ignored the subdirectory prefix; the replace writer is the one.
test("the additive exclude writer is gone; replaceLocalIgnoreBlock is the only writer", () => {
  expect("ensureLocalIgnorePatterns" in localIgnore).toBe(false);
});

test("replaceLocalIgnoreBlock creates info/ when it is missing", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-local-ignore-mkdir");
  try {
    await initRepo(root);
    await rm(path.join(root, ".git", "info"), { recursive: true, force: true });
    const result = await replaceLocalIgnoreBlock(root, ["CLAUDE.local.md"]);
    expect(result.status).toBe("written");
    expect(await readFile(path.join(root, ".git", "info", "exclude"), "utf8")).toBe(
      "# keryx:begin\nCLAUDE.local.md\n# keryx:end\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Flow 361 review round 1, F-001 (defence in depth): whatever a caller hands
// the writer, a line that re-includes a path (`!`), carries a line break, or
// forges a marker is refused — nothing is written.
test("replaceLocalIgnoreBlock refuses a line that would un-ignore a path or break the block", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-local-ignore-refuse-lines");
  try {
    await initRepo(root);
    const excludePath = path.join(root, ".git", "info", "exclude");
    await mkdir(path.dirname(excludePath), { recursive: true });
    const foreign = "# mine\n.env\n";
    await writeFile(excludePath, foreign);

    for (const lines of [
      ["!.env"],
      ["  !*.pem"],
      ["CLAUDE.local.md\n!.env"],
      ["CLAUDE.local.md\r!.env"],
      ["CLAUDE.local.md", "# keryx:end"],
      ["# keryx:begin", "CLAUDE.local.md"],
    ]) {
      const result = await replaceLocalIgnoreBlock(root, lines);
      expect(result.status).toBe("refused");
      expect((await planLocalIgnoreBlock(root, lines)).status).toBe("refused");
    }
    expect(await readFile(excludePath, "utf8")).toBe(foreign);
    expect(await isPathIgnored(root, ".env")).toEqual({ git: true, ignored: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("from a linked worktree the shared exclude file of the common dir is written", async () => {
  const base = uniqueTestRoot(tmpdir(), "keryx-local-ignore-worktree");
  try {
    const main = path.join(base, "main");
    const linked = path.join(base, "linked");
    await initRepo(main);
    await writeFile(path.join(main, "README.md"), "readme\n");
    await run(main, ["add", "README.md"]);
    await run(main, ["commit", "-q", "-m", "fixture"]);
    await run(main, ["worktree", "add", "-q", linked, "-b", "linked-branch"]);

    const mainExclude = path.join(main, ".git", "info", "exclude");
    expect(await realpath(path.dirname((await resolveLocalExcludePath(linked)) ?? ""))).toBe(
      await realpath(path.dirname(mainExclude)),
    );

    const result = await replaceLocalIgnoreBlock(linked, LOCAL_TARGETS);
    expect(result.status).toBe("written");
    expect(await readFile(mainExclude, "utf8")).toContain("# keryx:begin\nCLAUDE.local.md\n");
    // Nothing was written under the linked worktree's own private git dir.
    expect(await Bun.file(path.join(main, ".git", "worktrees", "linked", "info", "exclude")).exists()).toBe(false);

    // One write covers every worktree of the clone.
    for (const checkout of [main, linked]) {
      for (const target of LOCAL_TARGETS) {
        expect(await isPathIgnored(checkout, target)).toEqual({ git: true, ignored: true });
      }
    }
    expect((await replaceLocalIgnoreBlock(main, LOCAL_TARGETS)).status).toBe("unchanged");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("outside a git repository every call reports it instead of throwing", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-local-ignore-nogit");
  try {
    expect(await isPathIgnored(root, "CLAUDE.local.md")).toEqual({ git: false });
    expect(await isMetaprojectIgnoredAsWhole(root)).toEqual({ git: false });
    expect(await resolveLocalExcludePath(root)).toBeUndefined();
    expect(await replaceLocalIgnoreBlock(root, LOCAL_TARGETS)).toEqual({ status: "not-a-git-repository" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Flow 361 T7: replace semantics. The block is what keryx emits NOW — a line
// it stopped emitting must not linger — while every byte outside the markers
// stays the developer's.
test("replaceLocalIgnoreBlock rewrites the block to exactly the given lines and keeps foreign lines", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-local-ignore-replace");
  try {
    await initRepo(root);
    const excludePath = path.join(root, ".git", "info", "exclude");
    await mkdir(path.dirname(excludePath), { recursive: true });
    const before = "# mine\n*.swp\n\n";
    const after = "\nafter-block/\n";
    await writeFile(excludePath, `${before}# keryx:begin\n.keryx-retired/\n.keryx-kept/\n# keryx:end\n${after}`);

    const first = await replaceLocalIgnoreBlock(root, ["# a comment", ".keryx-kept/", ".keryx-new/", ".keryx-new/"]);
    expect(first).toMatchObject({ status: "written", added: ["# a comment", ".keryx-new/"], removed: [".keryx-retired/"] });
    const written = await readFile(excludePath, "utf8");
    expect(written).toBe(`${before}# keryx:begin\n# a comment\n.keryx-kept/\n.keryx-new/\n# keryx:end\n${after}`);

    const stamp = (await stat(excludePath)).mtimeMs;
    expect((await replaceLocalIgnoreBlock(root, ["# a comment", ".keryx-kept/", ".keryx-new/"])).status).toBe("unchanged");
    expect(await readFile(excludePath, "utf8")).toBe(written);
    expect((await stat(excludePath)).mtimeMs).toBe(stamp);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("replaceLocalIgnoreBlock with nothing to write removes the block, and never creates one", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-local-ignore-replace-empty");
  try {
    await initRepo(root);
    const excludePath = path.join(root, ".git", "info", "exclude");
    await rm(path.join(root, ".git", "info"), { recursive: true, force: true });
    expect((await replaceLocalIgnoreBlock(root, [])).status).toBe("unchanged");
    expect(await Bun.file(excludePath).exists()).toBe(false);

    await mkdir(path.dirname(excludePath), { recursive: true });
    await writeFile(excludePath, "# mine\n*.swp\n");
    expect((await replaceLocalIgnoreBlock(root, [".keryx-kept/"])).status).toBe("written");
    expect(await readFile(excludePath, "utf8")).toBe("# mine\n*.swp\n\n# keryx:begin\n.keryx-kept/\n# keryx:end\n");

    expect(await replaceLocalIgnoreBlock(root, [])).toMatchObject({ status: "written", added: [], removed: [".keryx-kept/"] });
    expect(await readFile(excludePath, "utf8")).toBe("# mine\n*.swp\n");
    expect((await replaceLocalIgnoreBlock(root, [])).status).toBe("unchanged");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// `info/exclude` patterns are relative to the repository top level, and one
// exclude file serves every project in the repository. A project in a
// subdirectory therefore gets its patterns prefixed, and its own block, so a
// replace there cannot wipe the root project's entries (or the reverse).
test("a project in a subdirectory gets prefixed patterns in a block of its own", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-local-ignore-subdir");
  try {
    await initRepo(root);
    const sub = path.join(root, "packages", "app");
    await mkdir(sub, { recursive: true });
    const excludePath = path.join(root, ".git", "info", "exclude");
    await rm(excludePath, { force: true });

    expect((await replaceLocalIgnoreBlock(root, [".keryx-root/"])).status).toBe("written");
    expect((await replaceLocalIgnoreBlock(sub, ["# note", ".keryx-dir/cache/", "keryx-local.md"])).status).toBe("written");
    expect(await readFile(excludePath, "utf8")).toBe(
      "# keryx:begin\n.keryx-root/\n# keryx:end\n\n" +
        "# keryx:begin packages/app/\n# note\npackages/app/.keryx-dir/cache/\npackages/app/**/keryx-local.md\n# keryx:end packages/app/\n",
    );
    expect(await isPathIgnored(sub, ".keryx-dir/cache/")).toEqual({ git: true, ignored: true });
    expect(await isPathIgnored(sub, "keryx-local.md")).toEqual({ git: true, ignored: true });
    expect(await isPathIgnored(root, "keryx-local.md")).toEqual({ git: true, ignored: false });

    // Each project replaces only its own block.
    expect((await replaceLocalIgnoreBlock(root, [".keryx-root-2/"])).status).toBe("written");
    expect((await replaceLocalIgnoreBlock(sub, [])).status).toBe("written");
    expect(await readFile(excludePath, "utf8")).toBe("# keryx:begin\n.keryx-root-2/\n# keryx:end\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explainIgnoredPaths tells a rule in the managed block from one anywhere else", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-local-ignore-explain");
  try {
    await initRepo(root);
    const excludePath = path.join(root, ".git", "info", "exclude");
    await mkdir(path.dirname(excludePath), { recursive: true });
    await writeFile(excludePath, ".keryx-foreign/\n");
    await replaceLocalIgnoreBlock(root, [".keryx-managed/", ".keryx-both/", ".keryx-negated"]);
    await writeFile(path.join(root, ".gitignore"), ".keryx-repo/\n.keryx-both/\n!.keryx-negated\n");

    const explained = await explainIgnoredPaths(root, [
      ".keryx-managed/",
      ".keryx-foreign/",
      ".keryx-repo/",
      ".keryx-both/",
      ".keryx-negated",
      ".keryx-nothing",
    ]);
    expect(explained?.map((entry) => [entry.path, entry.ignored, entry.managed])).toEqual([
      [".keryx-managed/", true, true],
      // Same file as the managed block, but outside its markers.
      [".keryx-foreign/", true, false],
      [".keryx-repo/", true, false],
      // `.gitignore` outranks `info/exclude`: the repository's rule is the one that counts.
      [".keryx-both/", true, false],
      // A `!` rule is a match that RE-INCLUDES the path.
      [".keryx-negated", false, false],
      [".keryx-nothing", false, false],
    ]);
    expect(explained?.[4]?.rule).toBe(".gitignore:3");
    expect(explained?.[5]?.rule).toBeUndefined();
    expect(await explainIgnoredPaths(root, [])).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explainIgnoredPaths works from a linked worktree and reports nothing outside git", async () => {
  const base = uniqueTestRoot(tmpdir(), "keryx-local-ignore-explain-worktree");
  try {
    const main = path.join(base, "main");
    const linked = path.join(base, "linked");
    await initRepo(main);
    await writeFile(path.join(main, "README.md"), "readme\n");
    await run(main, ["add", "README.md"]);
    await run(main, ["commit", "-q", "-m", "fixture"]);
    await run(main, ["worktree", "add", "-q", linked, "-b", "linked-branch"]);
    await replaceLocalIgnoreBlock(linked, [".keryx-managed/"]);

    for (const checkout of [main, linked]) {
      expect(await explainIgnoredPaths(checkout, [".keryx-managed/"])).toMatchObject([{ ignored: true, managed: true }]);
    }
    expect(await explainIgnoredPaths(base, [".keryx-managed/"])).toBeUndefined();
    expect(await replaceLocalIgnoreBlock(base, [".keryx-managed/"])).toEqual({ status: "not-a-git-repository" });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("an exclude file symlinked outside the git common dir is refused, not written through", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-local-ignore-symlink");
  const outside = uniqueTestRoot(tmpdir(), "keryx-local-ignore-symlink-outside");
  try {
    await initRepo(root);
    const victim = path.join(outside, "victim.txt");
    await writeFile(victim, "untouched\n");
    const excludePath = path.join(root, ".git", "info", "exclude");
    await mkdir(path.dirname(excludePath), { recursive: true });
    await rm(excludePath, { force: true });
    await symlink(victim, excludePath);

    expect((await replaceLocalIgnoreBlock(root, LOCAL_TARGETS)).status).toBe("refused");
    expect(await readFile(victim, "utf8")).toBe("untouched\n");

    // The same for a symlinked info/ directory.
    await rm(path.join(root, ".git", "info"), { recursive: true, force: true });
    await symlink(outside, path.join(root, ".git", "info"));
    expect((await replaceLocalIgnoreBlock(root, LOCAL_TARGETS)).status).toBe("refused");
    expect(await Bun.file(path.join(outside, "exclude")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
