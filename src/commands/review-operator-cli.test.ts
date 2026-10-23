// Flow 457 review B1: the operator commands (confirm-plan, verify-run, waive-mutation, override-reviewers) must be
// reachable through the real CLI. They were missing from the `review` subcommand allowlist, so every call ended in
// "Unknown command" before reaching review-operator.ts. Run through `bun src/cli.ts` in a scratch repository.

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isTrustRoutineCommand } from "../lib/trust-routine-command";
import { readPremiseDecisions } from "../review/operator-decisions";
import { heldFinding } from "../review/premise-fixtures";
import { computeReadiness } from "../review/readiness";
import { computeVerdict } from "../review/verdict";
import { OPERATOR_COMMANDS, runOperatorCommand } from "./review-operator";

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
    "decide-premise": ["--package", "pkg", "--finding", "LY-003", "--answer", "dismiss", "--reason", "slow"],
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

// Flow 459 (AC3): `keryx review decide-premise`, the operator's answer to a finding the premise judge held.

describe("decide-premise at a terminal", () => {
  const held = heldFinding();

  function heldPackage(findings: unknown[] = [held]): string {
    const dir = mkdtempSync(path.join(repo, "held-"));
    mkdirSync(path.join(dir, "raw"), { recursive: true });
    writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ schemaVersion: 1, reviewId: "r1", mode: "ingest", status: "draft", target: { kind: "report", ref: "r.md" }, artifacts: { scope: "scope.md", coverage: "coverage.md", report: "report.md", findings: "findings.json", learning: "learning.md", decisions: "decisions.md" }, coverage: [] }),
    );
    writeFileSync(path.join(dir, "findings.json"), JSON.stringify(findings));
    return dir;
  }

  const readiness = async (dir: string) => (await computeReadiness(dir)).items.find((item) => item.id === "premise-decisions");
  const seams = (answer: string, lines: string[] = []) => ({ isTerminal: () => true, ask: async () => answer, cwd: repo, log: (line: string) => void lines.push(line) });
  const argv = (dir: string, over: Record<string, string> = {}): string[] =>
    Object.entries({ "--package": dir, "--finding": "LY-003", "--answer": "dismiss", "--reason": "platforms do not mirror media controls", ...over }).flatMap(([flag, value]) => [flag, value]);

  test("dismiss records the operator's answer and readiness and the verdict pass for that finding", async () => {
    const dir = heldPackage();
    expect((await readiness(dir))?.status).toBe("fail");
    expect((await computeVerdict(dir)).held.map((entry) => entry.id)).toEqual(["LY-003"]);
    const lines: string[] = [];
    expect(await runOperatorCommand("decide-premise", argv(dir), seams("agreed, keep it LTR", lines))).toBe(0);
    expect(lines.join("\n")).toContain("premise-question dismiss recorded for r1#LY-003");
    const [decision] = await readPremiseDecisions(dir);
    expect(decision).toMatchObject({ kind: "premise-question", finding: "r1#LY-003", answer: "dismiss", reason: "platforms do not mirror media controls", quote: "agreed, keep it LTR", actor: "operator", confirmedVia: "terminal" });
    expect(decision?.subject).toMatchObject({ severity: "major", verdict: "challenged" });
    expect((await readiness(dir))?.status).toBe("pass");
    // The answer is on the finding record too, so the next round does not carry it as open.
    const [record] = JSON.parse(readFileSync(path.join(dir, "findings.json"), "utf8")) as Array<{ disposition?: { state: string } }>;
    expect(record?.disposition?.state).toBe("dismissed-incorrect");
    const verdict = await computeVerdict(dir);
    expect(verdict.held).toEqual([]);
    expect(verdict.dismissed).toBe(1);
  });

  test("uphold returns the finding to open at its original severity", async () => {
    const dir = heldPackage();
    expect(await runOperatorCommand("decide-premise", argv(dir, { "--answer": "uphold", "--finding": "r1#LY-003" }), seams("yes, mirror it"))).toBe(0);
    expect((await readiness(dir))?.status).toBe("pass");
    const verdict = await computeVerdict(dir);
    expect(verdict.held).toEqual([]);
    expect(verdict.open.map((entry) => [entry.id, entry.severity])).toEqual([["LY-003", "major"]]);
  });

  test("the prompt cleans the model-written problem and question as the card does, and ends with the effect", async () => {
    const dir = heldPackage([{ ...held, problem: "timeline\u001b[2K\rFAKE: dismissed already\npinned", premise: { ...(held.premise as object), question: "mirror\u001b]0;title\u0007 it?" } }]);
    const asked: string[] = [];
    const seam = { isTerminal: () => true, ask: async (question: string) => { asked.push(question); return "dismiss it"; }, cwd: repo, log: () => undefined };
    expect(await runOperatorCommand("decide-premise", argv(dir), seam)).toBe(0);
    const prompt = asked[0] ?? "";
    // eslint-disable-next-line no-control-regex -- the point is that no control character reaches the terminal
    expect(prompt).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(prompt).toContain("⏎");
    expect(prompt).toMatch(/Answer: dismiss it as incorrect\? Type your own words/);
  });

  test("declining records nothing: an empty answer, a no, an n", async () => {
    for (const declined of ["", "no", "N"]) {
      const dir = heldPackage();
      expect(await runOperatorCommand("decide-premise", argv(dir), seams(declined))).toBe(1);
      expect(await readPremiseDecisions(dir)).toEqual([]);
      expect((await readiness(dir))?.status).toBe("fail");
    }
  });

  test("refuses an unknown finding, a finding that is not held, a missing reason and a bad answer", async () => {
    const dir = heldPackage([held, { ...held, id: "LY-004", global_id: "r1#LY-004", premise: { verdict: "upheld", judge: "review-premise" } }]);
    await expect(runOperatorCommand("decide-premise", argv(dir, { "--finding": "LY-999" }), seams("yes"))).rejects.toThrow("No finding");
    await expect(runOperatorCommand("decide-premise", argv(dir, { "--finding": "LY-004" }), seams("yes"))).rejects.toThrow("not held");
    await expect(runOperatorCommand("decide-premise", argv(dir, { "--reason": "  " }), seams("yes"))).rejects.toThrow("--reason");
    await expect(runOperatorCommand("decide-premise", argv(dir, { "--answer": "maybe" }), seams("yes"))).rejects.toThrow("uphold or dismiss");
    expect(await readPremiseDecisions(dir)).toEqual([]);
  });

  test("refused without a terminal, naming the card, and records nothing", async () => {
    const dir = heldPackage();
    await expect(runOperatorCommand("decide-premise", argv(dir), { isTerminal: () => false, cwd: repo })).rejects.toThrow("review_decide_premise");
    expect(await readPremiseDecisions(dir)).toEqual([]);
  });

  test("it is not on the no-prompt routine-command list", () => {
    expect(isTrustRoutineCommand('keryx review decide-premise --package p --finding F --answer dismiss --reason "x"', { cwd: repo })).toBe(false);
  });
});
