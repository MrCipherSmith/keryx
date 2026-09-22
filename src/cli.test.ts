import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";
import { CLI_ROUTES, exitCodeForError, groupUsage, helpRequestedFor, shouldInterceptHelp } from "./cli";
import { ShellFlagError, shellCommand } from "./commands/shell";

// RED tests for flow 021 (interactive `keryx` shell), T5 / AC3.
//
// `keryx --help`/`-h` must list `keryx harness run …` (already dispatched in
// `src/cli.ts` but not yet present in `printHelp()`'s printed text) AND the
// interactive shell — this is a behavioral, offline spawn test (no stdin is
// read for `--help`).
//
// Bare `keryx` (no args) is the CLI surface and must print usage — NOT launch
// the interactive shell. The TUI agent harness is only `keryx shell […]`.

test("--help lists the harness command and the interactive shell", async () => {
  const cliPath = path.join(import.meta.dir, "cli.ts");
  const output = await runBun([cliPath, "--help"]);

  expect(output).toMatch(/keryx harness run/);
  expect(/shell|interactive/i.test(output)).toBe(true);
});

test("bare `keryx` (no args) prints CLI usage, not the shell", async () => {
  const cliPath = path.join(import.meta.dir, "cli.ts");
  const output = await runBun([cliPath]);

  expect(output).toMatch(/Usage:/);
  expect(output).toMatch(/keryx shell/);
  expect(output).not.toMatch(/Select a provider/);
});

test("`keryx shell` is dispatched via shellCommand, and bare `keryx` is not", () => {
  // Flow 021 / AC3. This used to grep cli.ts for `if (command === "shell")`,
  // which was a proxy for the real invariant: the verb `shell` reaches
  // `shellCommand`, and the no-args path prints help instead of entering the
  // shell. Dispatch is now a table, so the binding itself can be asserted —
  // strictly stronger than matching the source text, which passed for any
  // spelling and would keep passing if the handler were swapped.
  expect(Object.keys(CLI_ROUTES)).toContain("shell");
  expect(CLI_ROUTES.shell).toBe(shellCommand);
  expect(CLI_ROUTES[""]).toBeUndefined();

  const cliSource = readFileSync(path.join(import.meta.dir, "cli.ts"), "utf8");
  expect(cliSource).toMatch(/!command/);
  expect(cliSource).toMatch(/printHelp\(\)/);
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

test("only a ShellFlagError sets its own exit code; any other error exits 1 (review F9)", () => {
  expect(exitCodeForError(new ShellFlagError("--fork needs an explicit session id"))).toBe(2);
  // A child-process error (Bun ShellError, execa) carries the CHILD's code.
  expect(exitCodeForError(Object.assign(new Error("child failed"), { exitCode: 7 }))).toBe(1);
  expect(exitCodeForError({ exitCode: 3 })).toBe(1);
  expect(exitCodeForError("boom")).toBe(1);
  expect(exitCodeForError(null)).toBe(1);
});

// --- `--help` is a QUESTION, never a command (found the hard way: running
// `keryx skills install --help` to read its usage INSTALLED 52 skills, because
// `--help` was recognized only as the first argv token) ---

test("a `--help` after a subcommand is recognized as a question", () => {
  expect(helpRequestedFor(["install", "--help"])).toBe(true);
  expect(helpRequestedFor(["install", "-h"])).toBe(true);
  expect(helpRequestedFor(["install"])).toBe(false);
  // A CHILD's own flag, after the separator, must pass through untouched:
  // `harness exec -- <cmd> --help` asks the child for help, and the harness
  // still has to run it.
  expect(helpRequestedFor(["exec", "--", "cmd", "--help"])).toBe(false);
  expect(helpRequestedFor(["--", "--help"])).toBe(false);
});

test("a group's usage is its own lines — including the indented descriptions that belong to them", () => {
  const skills = groupUsage("skills");
  expect(skills).toContain("keryx skills install [--profile recommended]");
  expect(skills).toContain("keryx skills sync --runtime codex|claude --target <dir>");
  expect(skills).not.toContain("keryx flow init");

  const sessions = groupUsage("sessions");
  expect(sessions).toContain("keryx sessions list|fork <id>|export <id>|path");
  expect(sessions).toContain("List / branch / export sessions for the current project");

  expect(groupUsage("not-a-command")).toBeUndefined();
});

test("the guard defers to a group that answers `--help` deeper, and passes a child's flag through", () => {
  expect(shouldInterceptHelp("skills", ["install", "--help"])).toBe(true);
  expect(shouldInterceptHelp("flow", ["complete", "--help"])).toBe(true);
  // `agents bootstrap --help` is answered by the bootstrap handler, which knows
  // the runtime list this group's two usage lines do not carry.
  expect(shouldInterceptHelp("agents", ["bootstrap", "--help"])).toBe(false);
  // After the separator the flag is the child process's, not ours.
  expect(shouldInterceptHelp("harness", ["exec", "--", "cmd", "--help"])).toBe(false);
});

test("every dispatched group either has its own usage lines or falls back to the full help", () => {
  const missing = Object.keys(CLI_ROUTES).filter((name) => groupUsage(name) === undefined);
  // `session` is the singular ALIAS of `sessions` (`CLI_ROUTES.session ===
  // sessionsCommand`), and the usage block lists the canonical spelling only —
  // so it is the one route answered by the full-help fallback, and this pins
  // that it stays the ONLY one rather than an unwatched list that grows.
  expect(missing).toEqual(["session"]);
});
