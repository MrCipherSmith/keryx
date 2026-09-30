import { mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  ensureLocalIgnorePatterns,
  isMetaprojectIgnoredAsWhole,
  isPathIgnored,
  resolveLocalExcludePath,
} from "./git-local-ignore";
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

test("ensureLocalIgnorePatterns writes the managed block, keeps foreign lines, and is idempotent", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-local-ignore-ensure");
  try {
    await initRepo(root);
    const excludePath = path.join(root, ".git", "info", "exclude");
    await mkdir(path.dirname(excludePath), { recursive: true });
    const foreign = "# a developer's own rules\n*.swp\n\n\nscratch/\n";
    await writeFile(excludePath, foreign);

    const first = await ensureLocalIgnorePatterns(root, LOCAL_TARGETS);
    expect(first.status).toBe("written");
    if (first.status !== "written") throw new Error("unreachable");
    expect(first.added).toEqual(LOCAL_TARGETS);
    expect(await realpath(first.excludePath)).toBe(await realpath(excludePath));

    const written = await readFile(excludePath, "utf8");
    expect(written.startsWith(foreign)).toBe(true);
    expect(written).toBe(`${foreign}\n# keryx:begin\n${LOCAL_TARGETS.join("\n")}\n# keryx:end\n`);
    for (const target of LOCAL_TARGETS) {
      expect(await isPathIgnored(root, target)).toEqual({ git: true, ignored: true });
    }

    const before = await stat(excludePath);
    const second = await ensureLocalIgnorePatterns(root, LOCAL_TARGETS);
    expect(second.status).toBe("unchanged");
    expect(await readFile(excludePath, "utf8")).toBe(written);
    expect((await stat(excludePath)).mtimeMs).toBe(before.mtimeMs);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureLocalIgnorePatterns adds only the missing patterns and keeps the block's earlier ones", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-local-ignore-extend");
  try {
    await initRepo(root);
    const excludePath = path.join(root, ".git", "info", "exclude");
    await ensureLocalIgnorePatterns(root, ["# Metaproject internals", ".metaproject/runtime/"]);
    // Foreign lines on BOTH sides of the block.
    await writeFile(excludePath, `${await readFile(excludePath, "utf8")}\nafter-block/\n`);
    const head = (await readFile(excludePath, "utf8")).split("# keryx:begin")[0];

    const result = await ensureLocalIgnorePatterns(root, [".metaproject/runtime/", "CLAUDE.local.md", "CLAUDE.local.md"]);
    expect(result).toMatchObject({ status: "written", added: ["CLAUDE.local.md"] });
    expect(await readFile(excludePath, "utf8")).toBe(
      `${head}# keryx:begin\n# Metaproject internals\n.metaproject/runtime/\nCLAUDE.local.md\n# keryx:end\n\nafter-block/\n`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ensureLocalIgnorePatterns creates info/ when it is missing", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-local-ignore-mkdir");
  try {
    await initRepo(root);
    await rm(path.join(root, ".git", "info"), { recursive: true, force: true });
    const result = await ensureLocalIgnorePatterns(root, ["CLAUDE.local.md"]);
    expect(result.status).toBe("written");
    expect(await readFile(path.join(root, ".git", "info", "exclude"), "utf8")).toBe(
      "# keryx:begin\nCLAUDE.local.md\n# keryx:end\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty pattern list writes nothing", async () => {
  const root = uniqueTestRoot(tmpdir(), "keryx-local-ignore-empty");
  try {
    await initRepo(root);
    await rm(path.join(root, ".git", "info"), { recursive: true, force: true });
    expect((await ensureLocalIgnorePatterns(root, [])).status).toBe("unchanged");
    expect(await Bun.file(path.join(root, ".git", "info", "exclude")).exists()).toBe(false);
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

    const result = await ensureLocalIgnorePatterns(linked, LOCAL_TARGETS);
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
    expect((await ensureLocalIgnorePatterns(main, LOCAL_TARGETS)).status).toBe("unchanged");
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
    expect(await ensureLocalIgnorePatterns(root, LOCAL_TARGETS)).toEqual({ status: "not-a-git-repository" });
  } finally {
    await rm(root, { recursive: true, force: true });
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

    const result = await ensureLocalIgnorePatterns(root, LOCAL_TARGETS);
    expect(result.status).toBe("refused");
    expect(await readFile(victim, "utf8")).toBe("untouched\n");

    // The same for a symlinked info/ directory.
    await rm(path.join(root, ".git", "info"), { recursive: true, force: true });
    await symlink(outside, path.join(root, ".git", "info"));
    expect((await ensureLocalIgnorePatterns(root, LOCAL_TARGETS)).status).toBe("refused");
    expect(await Bun.file(path.join(outside, "exclude")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
