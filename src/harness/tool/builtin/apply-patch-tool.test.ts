import { expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyPatchTool, makeGitApplyRunner, type GitApplyResult, type GitApplyRunner } from "./apply-patch-tool";

function recordingRunner(result: GitApplyResult = { ok: true }): {
  run: GitApplyRunner;
  calls: Array<{ patch: string; cwd: string }>;
} {
  const calls: Array<{ patch: string; cwd: string }> = [];
  return {
    calls,
    run: async (patch, cwd) => {
      calls.push({ patch, cwd });
      return result;
    },
  };
}

function modifyHunk(path_: string): string {
  return [`--- a/${path_}`, `+++ b/${path_}`, "@@ -1,1 +1,1 @@", "-old", "+new", ""].join("\n");
}

test("apply_patch is risk write with a patch input schema", () => {
  const { run } = recordingRunner();
  const tool = applyPatchTool("/proj", run);
  expect(tool.definition.name).toBe("apply_patch");
  expect(tool.definition.risk).toBe("write");
  expect(tool.definition.inputSchema.required).toEqual(["patch"]);
});

test("apply_patch rejects an empty patch without calling the runner", async () => {
  const { run, calls } = recordingRunner();
  const tool = applyPatchTool("/proj", run);
  const result = await tool.invoke({ patch: "" });
  expect(result.isError).toBe(true);
  expect(result.output).toMatch(/non-empty/);
  expect(calls).toEqual([]);
});

test("apply_patch rejects a patch with no recognizable file targets without calling the runner", async () => {
  const { run, calls } = recordingRunner();
  const tool = applyPatchTool("/proj", run);
  const result = await tool.invoke({ patch: "this is not a diff" });
  expect(result.isError).toBe(true);
  expect(result.output).toMatch(/no valid file targets/);
  expect(calls).toEqual([]);
});

test("apply_patch passes the patch and confined root through to the runner on success", async () => {
  const { run, calls } = recordingRunner({ ok: true });
  const tool = applyPatchTool("/proj", run);
  const patch = modifyHunk("src/a.ts") + modifyHunk("src/b.ts");
  const result = await tool.invoke({ patch });
  expect(calls).toEqual([{ patch, cwd: "/proj" }]);
  expect(result.isError).toBe(false);
  const parsed = JSON.parse(result.output);
  expect(parsed.applied).toBe(true);
  expect(parsed.results).toEqual([
    { path: "src/a.ts", action: "modify", ok: true },
    { path: "src/b.ts", action: "modify", ok: true },
  ]);
});

test("apply_patch: a runner failure marks every target ok:false with the runner's error, isError true", async () => {
  const { run } = recordingRunner({ ok: false, error: "patch does not apply" });
  const tool = applyPatchTool("/proj", run);
  const result = await tool.invoke({ patch: modifyHunk("src/a.ts") + modifyHunk("src/b.ts") });
  expect(result.isError).toBe(true);
  const parsed = JSON.parse(result.output);
  expect(parsed.applied).toBe(false);
  expect(parsed.results).toEqual([
    { path: "src/a.ts", action: "modify", ok: false, error: "patch does not apply" },
    { path: "src/b.ts", action: "modify", ok: false, error: "patch does not apply" },
  ]);
});

test("apply_patch: a path escaping the project root rejects the WHOLE patch before the runner ever runs (atomicity)", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-apply-patch-"));
  try {
    const { run, calls } = recordingRunner({ ok: true });
    const tool = applyPatchTool(root, run);
    const patch = modifyHunk("src/safe.ts") + modifyHunk("../../etc/passwd");
    const result = await tool.invoke({ patch });
    expect(calls).toEqual([]); // the runner never ran — nothing was ever written
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.applied).toBe(false);
    const safe = parsed.results.find((r: { path: string }) => r.path === "src/safe.ts");
    const escaping = parsed.results.find((r: { path: string }) => r.path === "../../etc/passwd");
    expect(safe.ok).toBe(false);
    expect(safe.error).toMatch(/sibling target/);
    expect(escaping.ok).toBe(false);
    expect(escaping.error).toMatch(/escapes the project root/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("apply_patch: create (/dev/null source) and delete (/dev/null target) are classified correctly end to end", async () => {
  const { run, calls } = recordingRunner({ ok: true });
  const tool = applyPatchTool("/proj", run);
  const patch = [
    "--- /dev/null",
    "+++ b/src/new.ts",
    "@@ -0,0 +1,1 @@",
    "+hello",
    "",
    "--- a/src/gone.ts",
    "+++ /dev/null",
    "@@ -1,1 +0,0 @@",
    "-bye",
    "",
  ].join("\n");
  const result = await tool.invoke({ patch });
  expect(calls).toHaveLength(1);
  const parsed = JSON.parse(result.output);
  expect(parsed.results).toEqual([
    { path: "src/new.ts", action: "create", ok: true },
    { path: "src/gone.ts", action: "delete", ok: true },
  ]);
});

// --- real subprocess: the default runner against an actual `git apply` ------
//
// F1 (found during this feature's own development): a `GIT_DIR`/`GIT_WORK_TREE`
// leaked into these tests' inherited environment made `git init`/`add`/`commit`
// silently operate on an UNRELATED real repository instead of `root`'s fresh
// tmpdir, despite an explicit `cwd`. `execGitClean` strips those overrides —
// same fix as `apply-patch-tool.ts`'s own `gitDiscoveryCleanEnv` — so these
// tests can never repeat that regardless of what spawned the test runner.

const GIT_DISCOVERY_OVERRIDE_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
];

function execGitClean(command: string, cwd: string): void {
  const cleanEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !GIT_DISCOVERY_OVERRIDE_VARS.includes(key)) {
      cleanEnv[key] = value;
    }
  }
  execSync(command, { cwd, env: cleanEnv });
}

test("makeGitApplyRunner: applies a real patch to a real file via the real git binary", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-apply-patch-real-"));
  try {
    execGitClean("git init -q", root);
    writeFileSync(path.join(root, "hello.txt"), "line one\nline two\nline three\n");
    execGitClean("git add hello.txt && git -c user.email=t@t.com -c user.name=t commit -q -m init", root);

    const patch = [
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1,3 +1,3 @@",
      " line one",
      "-line two",
      "+line TWO",
      " line three",
      "",
    ].join("\n");

    const tool = applyPatchTool(root, makeGitApplyRunner());
    const result = await tool.invoke({ patch });
    expect(result.isError).toBe(false);
    const content = readFileSync(path.join(root, "hello.txt"), "utf8");
    expect(content).toBe("line one\nline TWO\nline three\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("makeGitApplyRunner: a patch that doesn't match the file's real content is rejected wholesale, nothing written", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-apply-patch-real-"));
  try {
    execGitClean("git init -q", root);
    writeFileSync(path.join(root, "hello.txt"), "actual content, not what the patch expects\n");
    execGitClean("git add hello.txt && git -c user.email=t@t.com -c user.name=t commit -q -m init", root);

    const patch = [
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1,3 +1,3 @@",
      " line one",
      "-line two",
      "+line TWO",
      " line three",
      "",
    ].join("\n");

    const tool = applyPatchTool(root, makeGitApplyRunner());
    const result = await tool.invoke({ patch });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed.applied).toBe(false);
    const content = readFileSync(path.join(root, "hello.txt"), "utf8");
    expect(content).toBe("actual content, not what the patch expects\n"); // unchanged
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- containment against the real runner (flow 396 review) --------------------
//
// The tool confines every `---`/`+++` target with `confineToRoot` before git runs. These tests drive
// the REAL `git apply` against a real tree with an "outside" sibling directory and assert two things:
// the call is refused, and nothing outside the root was created or changed.

function containmentRig(): { base: string; root: string; outside: string; cleanup: () => void } {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-apply-patch-contain-")));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  execGitClean("git init -q", root);
  writeFileSync(path.join(root, "in.txt"), "a\nb\n");
  writeFileSync(path.join(outside, "secret.txt"), "a\nb\n");
  execGitClean("git add in.txt && git -c user.email=t@t.com -c user.name=t commit -q -m init", root);
  return { base, root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function modify(target: string): string {
  return [`--- a/${target}`, `+++ b/${target}`, "@@ -1,2 +1,2 @@", "-a", "+A", " b", ""].join("\n");
}

function create(target: string): string {
  return ["--- /dev/null", `+++ b/${target}`, "@@ -0,0 +1,1 @@", "+planted", ""].join("\n");
}

test("containment: a `..` target is refused and nothing outside is created", async () => {
  const rig = containmentRig();
  try {
    const tool = applyPatchTool(rig.root, makeGitApplyRunner());
    const result = await tool.invoke({ patch: create("../outside/planted.txt") });
    expect(result.isError).toBe(true);
    expect(existsSync(path.join(rig.outside, "planted.txt"))).toBe(false);
    const edit = await tool.invoke({ patch: modify("../outside/secret.txt") });
    expect(edit.isError).toBe(true);
    expect(readFileSync(path.join(rig.outside, "secret.txt"), "utf8")).toBe("a\nb\n");
  } finally {
    rig.cleanup();
  }
});

test("containment: an absolute target is refused, with or without the a/ b/ prefix", async () => {
  const rig = containmentRig();
  try {
    const tool = applyPatchTool(rig.root, makeGitApplyRunner());
    const abs = path.join(rig.outside, "planted.txt");
    for (const patch of [
      ["--- /dev/null", `+++ ${abs}`, "@@ -0,0 +1,1 @@", "+planted", ""].join("\n"),
      create(abs), // `b//abs/path`
      modify(path.join(rig.outside, "secret.txt")),
    ]) {
      const result = await tool.invoke({ patch });
      expect(result.isError).toBe(true);
    }
    expect(existsSync(abs)).toBe(false);
    expect(readFileSync(path.join(rig.outside, "secret.txt"), "utf8")).toBe("a\nb\n");
  } finally {
    rig.cleanup();
  }
});

test("containment: a directory symlink inside the root that points outside is refused", async () => {
  const rig = containmentRig();
  try {
    symlinkSync(rig.outside, path.join(rig.root, "link"));
    const tool = applyPatchTool(rig.root, makeGitApplyRunner());
    const made = await tool.invoke({ patch: create("link/planted.txt") });
    expect(made.isError).toBe(true);
    expect(existsSync(path.join(rig.outside, "planted.txt"))).toBe(false);
    const edited = await tool.invoke({ patch: modify("link/secret.txt") });
    expect(edited.isError).toBe(true);
    expect(readFileSync(path.join(rig.outside, "secret.txt"), "utf8")).toBe("a\nb\n");
  } finally {
    rig.cleanup();
  }
});

test("containment: a file symlink inside the root that points outside is refused", async () => {
  const rig = containmentRig();
  try {
    symlinkSync(path.join(rig.outside, "secret.txt"), path.join(rig.root, "alias.txt"));
    const tool = applyPatchTool(rig.root, makeGitApplyRunner());
    const result = await tool.invoke({ patch: modify("alias.txt") });
    expect(result.isError).toBe(true);
    expect(readFileSync(path.join(rig.outside, "secret.txt"), "utf8")).toBe("a\nb\n");
  } finally {
    rig.cleanup();
  }
});

test("containment: a dangling symlink target is refused", async () => {
  const rig = containmentRig();
  try {
    symlinkSync(path.join(rig.outside, "not-yet.txt"), path.join(rig.root, "dangling.txt"));
    const tool = applyPatchTool(rig.root, makeGitApplyRunner());
    const result = await tool.invoke({ patch: create("dangling.txt") });
    expect(result.isError).toBe(true);
    expect(existsSync(path.join(rig.outside, "not-yet.txt"))).toBe(false);
  } finally {
    rig.cleanup();
  }
});

test("containment: a rename or copy to a path outside, hidden in extended headers, writes nothing outside", async () => {
  const rig = containmentRig();
  try {
    const tool = applyPatchTool(rig.root, makeGitApplyRunner());
    const withHeader = (extra: string[]): string => [`diff --git a/in.txt b/in.txt`, modify("in.txt"), `diff --git a/in.txt b/x`, ...extra, ""].join("\n");
    for (const patch of [
      withHeader(["rename from in.txt", "rename to ../outside/moved.txt"]),
      withHeader(["copy from in.txt", "copy to ../outside/copied.txt"]),
    ]) {
      await tool.invoke({ patch });
      expect(existsSync(path.join(rig.outside, "moved.txt"))).toBe(false);
      expect(existsSync(path.join(rig.outside, "copied.txt"))).toBe(false);
      expect(existsSync(path.join(rig.base, "moved.txt"))).toBe(false);
    }
    expect(readFileSync(path.join(rig.outside, "secret.txt"), "utf8")).toBe("a\nb\n");
  } finally {
    rig.cleanup();
  }
});

test("containment: a patch inside the root still applies, and creating a new file there works", async () => {
  const rig = containmentRig();
  try {
    const tool = applyPatchTool(rig.root, makeGitApplyRunner());
    const result = await tool.invoke({ patch: modify("in.txt") + create("sub/new.txt") });
    expect(result.isError).toBe(false);
    expect(readFileSync(path.join(rig.root, "in.txt"), "utf8")).toBe("A\nb\n");
    expect(readFileSync(path.join(rig.root, "sub/new.txt"), "utf8")).toBe("planted\n");
  } finally {
    rig.cleanup();
  }
});

test("containment: a rename through a symlinked directory that points outside writes nothing outside", async () => {
  const rig = containmentRig();
  try {
    symlinkSync(rig.outside, path.join(rig.root, "link"));
    const tool = applyPatchTool(rig.root, makeGitApplyRunner());
    const patch = [modify("in.txt"), "diff --git a/in.txt b/link/moved.txt", "rename from in.txt", "rename to link/moved.txt", ""].join("\n");
    await tool.invoke({ patch });
    expect(existsSync(path.join(rig.outside, "moved.txt"))).toBe(false);
  } finally {
    rig.cleanup();
  }
});

test("containment: the same holds when the project root is not a git repository", async () => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-apply-patch-norepo-")));
  try {
    const root = path.join(base, "root");
    mkdirSync(root);
    mkdirSync(path.join(base, "outside"));
    writeFileSync(path.join(root, "in.txt"), "a\nb\n");
    const tool = applyPatchTool(root, makeGitApplyRunner());
    const escaped = await tool.invoke({ patch: create("../outside/planted.txt") });
    expect(escaped.isError).toBe(true);
    const renamed = await tool.invoke({
      patch: [modify("in.txt"), "diff --git a/in.txt b/x", "rename from in.txt", "rename to ../outside/moved.txt", ""].join("\n"),
    });
    expect(renamed.isError).toBe(true);
    expect(existsSync(path.join(base, "outside", "planted.txt"))).toBe(false);
    expect(existsSync(path.join(base, "outside", "moved.txt"))).toBe(false);
    expect(readFileSync(path.join(root, "in.txt"), "utf8")).toBe("a\nb\n");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
