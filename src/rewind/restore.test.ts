import { expect, test } from "bun:test";
import { applyPatchTool } from "../harness/tool/builtin/apply-patch-tool";
import { makeCommandRunner, shellExecTool } from "../harness/tool/builtin/shell-exec-tool";
import { createRewindRecorder } from "./recorder";
import { REWIND_MAX_FILE_BYTES } from "./shadow";
import { exists, makeProject, projectGitFingerprint, read, runGit, write } from "./rewind.test-helpers";

const PATCH = ["--- a/a.txt", "+++ b/a.txt", "@@ -1,1 +1,1 @@", "-alpha", "+beta", ""].join("\n");

function setup() {
  const project = makeProject();
  const recorder = createRewindRecorder({ workTree: project.root, dir: () => project.rewindDir, enabled: () => true });
  return { project, recorder, patch: applyPatchTool(project.root), shell: shellExecTool(project.root, makeCommandRunner(project.root)) };
}

test("a real apply_patch and a real shell_exec write are undone by rewinding files", async () => {
  const { project, recorder, patch, shell } = setup();
  write(project.root, "ignored.log", "keep me\n");
  write(project.root, "node_modules/pkg/index.js", "dep\n");
  const gitBefore = projectGitFingerprint(project.root);

  recorder.beginTurn({ archiveIndex: 0, prompt: "rewrite things" });
  await recorder.beforeMutation();
  const patched = await patch.invoke({ patch: PATCH });
  expect(patched.isError).toBe(false);
  const shelled = await shell.invoke({ command: "echo made > created.txt && rm src/b.ts && echo more >> a.txt && echo scratch > ignored.log" });
  expect(shelled.isError).toBe(false);
  expect(read(project.root, "a.txt")).toBe("beta\nmore\n");
  expect(exists(project.root, "created.txt")).toBe(true);
  expect(exists(project.root, "src/b.ts")).toBe(false);

  const target = recorder.entries()[0]!;
  const outcome = await recorder.restoreFiles(target.seq);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(read(project.root, "a.txt")).toBe("alpha\n");
  expect(exists(project.root, "created.txt")).toBe(false);
  expect(read(project.root, "src/b.ts")).toBe("export const b = 1;\n");
  expect(outcome.restored).toEqual(["a.txt"]);
  expect(outcome.removed).toEqual(["created.txt"]);
  expect(outcome.recreated).toEqual(["src/b.ts"]);
  expect(read(project.root, "ignored.log")).toBe("scratch\n");
  expect(read(project.root, "node_modules/pkg/index.js")).toBe("dep\n");
  expect(projectGitFingerprint(project.root)).toEqual(gitBefore);
  expect(runGit(project.root, ["stash", "list"])).toBe("");
});

test("the pre-rewind snapshot brings the undone work back", async () => {
  const { project, recorder, patch } = setup();
  recorder.beginTurn({ archiveIndex: 0, prompt: "patch" });
  await recorder.beforeMutation();
  await patch.invoke({ patch: PATCH });
  await recorder.restoreFiles(recorder.entries()[0]!.seq);
  expect(read(project.root, "a.txt")).toBe("alpha\n");
  const pre = recorder.entries().find((entry) => entry.kind === "pre-rewind")!;
  const undo = await recorder.restoreFiles(pre.seq);
  expect(undo.ok).toBe(true);
  expect(read(project.root, "a.txt")).toBe("beta\n");
});

test("rewinding an earlier turn undoes every later turn as well", async () => {
  const { project, recorder, shell } = setup();
  recorder.beginTurn({ archiveIndex: 0, prompt: "one" });
  await recorder.beforeMutation();
  await shell.invoke({ command: "echo 1 > t1.txt" });
  recorder.beginTurn({ archiveIndex: 2, prompt: "two" });
  await recorder.beforeMutation();
  await shell.invoke({ command: "echo 2 > t2.txt && echo edited > a.txt" });
  await recorder.restoreFiles(recorder.entries()[0]!.seq);
  expect(exists(project.root, "t1.txt")).toBe(false);
  expect(exists(project.root, "t2.txt")).toBe(false);
  expect(read(project.root, "a.txt")).toBe("alpha\n");
});

test("files over 5 MB are left alone and reported by name", async () => {
  const { project, recorder, shell } = setup();
  write(project.root, "big.bin", new Uint8Array(REWIND_MAX_FILE_BYTES + 10));
  recorder.beginTurn({ archiveIndex: 0, prompt: "big" });
  await recorder.beforeMutation();
  expect(recorder.entries()[0]?.skipped).toEqual(["big.bin"]);
  await shell.invoke({ command: "echo x > small.txt" });
  const outcome = await recorder.restoreFiles(recorder.entries()[0]!.seq);
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) return;
  expect(outcome.skipped).toEqual(["big.bin"]);
  expect(exists(project.root, "big.bin")).toBe(true);
  expect(exists(project.root, "small.txt")).toBe(false);
});

test("removing the last file of a created directory removes the directory", async () => {
  const { project, recorder, shell } = setup();
  recorder.beginTurn({ archiveIndex: 0, prompt: "dir" });
  await recorder.beforeMutation();
  await shell.invoke({ command: "mkdir -p deep/er && echo x > deep/er/file.txt" });
  await recorder.restoreFiles(recorder.entries()[0]!.seq);
  expect(exists(project.root, "deep")).toBe(false);
});
