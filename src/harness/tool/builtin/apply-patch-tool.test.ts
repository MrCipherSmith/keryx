import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("makeGitApplyRunner: applies a real patch to a real file via the real git binary", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-apply-patch-real-"));
  try {
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: root });
    writeFileSync(path.join(root, "hello.txt"), "line one\nline two\nline three\n");
    execSync("git add hello.txt && git -c user.email=t@t.com -c user.name=t commit -q -m init", { cwd: root });

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
    const { execSync } = await import("node:child_process");
    execSync("git init -q", { cwd: root });
    writeFileSync(path.join(root, "hello.txt"), "actual content, not what the patch expects\n");
    execSync("git add hello.txt && git -c user.email=t@t.com -c user.name=t commit -q -m init", { cwd: root });

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
