import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";

// RED tests for flow 021 (interactive `keryx` shell), T5 / AC3.
//
// `keryx --help`/`-h` must list `keryx harness run …` (already dispatched in
// `src/cli.ts` but not yet present in `printHelp()`'s printed text) AND the
// interactive shell — this is a behavioral, offline spawn test (no stdin is
// read for `--help`).
//
// Bare `keryx` (no args) must dispatch to the interactive shell
// (`shellCommand`/`runShell` from `src/commands/shell.ts`, T6). A behavioral
// test would block forever on real stdin (the shell reads a live line
// source), so per the T5 dispatch this is a source-text audit of the `!command`
// branch in `main()` instead — NOT a per-test bug, but it WILL fail (RED)
// until `src/cli.ts` routes `!command` to `shellCommand(...)`.

test("--help lists the harness command and the interactive shell", async () => {
  const cliPath = path.join(import.meta.dir, "cli.ts");
  const output = await runBun([cliPath, "--help"]);

  expect(output).toMatch(/keryx harness run/);
  expect(/shell|interactive/i.test(output)).toBe(true);
});

test("bare `keryx` (no args) dispatches to the interactive shell (source-text audit)", () => {
  const cliSource = readFileSync(path.join(import.meta.dir, "cli.ts"), "utf8");

  expect(/shellCommand/.test(cliSource)).toBe(true);

  const bareBranch = /if\s*\(\s*!command\s*\)\s*\{([\s\S]*?)\}/.exec(cliSource);
  expect(bareBranch).not.toBeNull();
  expect(bareBranch?.[1] ?? "").toMatch(/shellCommand/);
});

test("dash alias is advertised in CLI help", async () => {
  const cliPath = path.join(import.meta.dir, "cli.ts");
  const output = await runBun([cliPath, "--help"]);

  expect(output).toContain("keryx dash");
  expect(output).toContain("dash      Rebuild and open .metaproject/keryx-dashboard.html");
});

test("agents bootstrap help is available without touching global files", async () => {
  const cliPath = path.join(import.meta.dir, "cli.ts");
  const output = await runBun([cliPath, "agents", "bootstrap", "--help"]);

  expect(output).toContain("keryx agents bootstrap");
  expect(output).toContain("claude, opencode, zcode, codex, antigravity");
  expect(output).toContain("--dry-run");
});

function runBun(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.join(import.meta.dir, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr || `bun exited with ${code}`));
    });
  });
}
