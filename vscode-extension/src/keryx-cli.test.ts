import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { KeryxBinaryNotFoundError, runKeryx } from "./keryx-cli";

// keryx-cli.ts has no `vscode` import, so it is exercisable directly with
// `bun test` even without a VS Code instance. These tests spawn REAL child
// processes (a guaranteed-missing binary name, and the real `bun`/`node`
// binary standing in for a "keryx"-shaped CLI) rather than mocking
// child_process, since the seam's entire job is classifying real process
// outcomes correctly.

test("runKeryx raises KeryxBinaryNotFoundError when the binary is missing (ENOENT)", async () => {
  await expect(
    runKeryx(["status"], process.cwd(), undefined, "keryx-definitely-not-a-real-binary-xyz"),
  ).rejects.toBeInstanceOf(KeryxBinaryNotFoundError);
});

test("runKeryx returns a non-zero exitCode (not a throw) for a real process that exits non-zero", async () => {
  // `node -e process.exit(1)` stands in for a `keryx` subcommand that fails
  // cleanly — confirms execFile's throw-on-nonzero-exit is caught and
  // reshaped into a CliResult, not re-thrown.
  const result = await runKeryx(["-e", "process.exit(1)"], process.cwd(), undefined, "node");
  expect(result.exitCode).toBe(1);
});

test("runKeryx returns exitCode 0 and captures stdout for a successful process", async () => {
  const result = await runKeryx(["-e", "console.log('ok')"], process.cwd(), undefined, "node");
  expect(result.exitCode).toBe(0);
  expect(result.stdout.trim()).toBe("ok");
});

// Sanity check that promisify(execFile) itself behaves the way runKeryx
// assumes (belt-and-suspenders on the Node API contract this module relies on).
test("sanity: promisify(execFile) rejects on nonzero exit with stdout/stderr attached", async () => {
  const execFileAsync = promisify(execFile);
  await expect(execFileAsync("node", ["-e", "process.exit(2)"])).rejects.toMatchObject({ code: 2 });
});
