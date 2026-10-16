// Flow 457 review B1: the operator commands (confirm-plan, verify-run, waive-mutation, override-reviewers) must be
// reachable through the real CLI. They were missing from the `review` subcommand allowlist, so every call ended in
// "Unknown command" before reaching review-operator.ts. Run through `bun src/cli.ts` in a scratch repository.

import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OPERATOR_COMMANDS } from "./review-operator";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
const repo = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-review-operator-cli-")));
afterAll(() => rmSync(repo, { recursive: true, force: true }));
execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
const pkg = path.join(repo, "pkg");
mkdirSync(pkg, { recursive: true });

function run(...args: string[]): { exitCode: number; output: string } {
  const child = Bun.spawnSync(["bun", CLI, ...args], { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { exitCode: child.exitCode ?? -1, output: `${child.stdout.toString()}${child.stderr.toString()}` };
}

for (const command of OPERATOR_COMMANDS) {
  test(`keryx review ${command} --help reaches the command`, () => {
    const result = run("review", command, "--help");
    expect(result.output).not.toContain("Unknown command");
    expect(result.output).toContain(`keryx review ${command}`);
    expect(result.exitCode).toBe(0);
  });
}

test("decision commands reach the command and refuse without a TTY, naming the card", () => {
  const cards: Record<string, string[]> = {
    "confirm-plan": ["--package", "pkg"],
    "waive-mutation": ["--package", "pkg", "--reason", "slow"],
    "override-reviewers": ["--package", "pkg", "--reason", "slow"],
  };
  for (const [command, args] of Object.entries(cards)) {
    const result = run("review", command, ...args);
    expect(result.output).not.toContain("Unknown command");
    expect(result.output).toContain(`review_${command.replace("-", "_")}`);
    expect(result.exitCode).not.toBe(0);
  }
});

test("verify-run runs the command and saves its output", () => {
  const result = run("review", "verify-run", "--package", "pkg", "--finding", "F1", "--", "echo", "hi");
  expect(result.output).not.toContain("Unknown command");
  expect(result.output).toContain("verify-run: exit 0");
  const evidence = path.join(pkg, "research-evidence");
  expect(existsSync(evidence)).toBe(true);
  expect(readdirSync(evidence).some((name) => name.startsWith("verify-F1-"))).toBe(true);
});
