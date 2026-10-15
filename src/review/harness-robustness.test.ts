// Flow 457 (AC8): harness robustness. One file per the criterion, one describe per audit row.
// The publish --yes gate is covered in ./publish.test.ts ("flow 457: --yes without a terminal ...").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commentsReplyGate } from "../commands/review";
import { runChunks } from "../commands/review-chunks";
import { runOperatorCommand } from "../commands/review-operator";
import { packageOfManifest, runSlice } from "../commands/review-slice";
import { buildReviewConfirmSpecs } from "../commands/operator-confirm-review";
import { operatorConfirmTool } from "../commands/operator-confirm-tools";
import { isReviewTask, reviewTaskCommand, reviewTaskRange } from "../trigger/review-task";
import { OPERATOR_CONFIRM_TOOL_NAMES, isUnattendedExcludedTool } from "../trigger/unattended";
import { AUTONOMOUS_PROFILE, AUTONOMOUS_SCOPE_FILE, REVIEW_WAVE_SIZE, buildAutonomousPrompt, describeAutonomousTarget, parseAutonomousRangeTarget } from "./autonomous-profile";
import { runAutonomousReview, type ChildSpec } from "./autonomous-run";
import { validateSummary } from "./autonomous-summary";
import { coverageErrors, requiredReviewers } from "./coverage";
import { HOST_WAVE_BYTES, defaultWaveBytes, detectReviewHost } from "./host-profile";
import { confirmedDecision, recordOperatorDecision } from "./operator-decisions";
import { recordProcessCall, startOrchestratorLog } from "./orchestrator-log";
import { planConfirmed, recordPlanConfirmation, type PlanNumbers } from "./plan-confirmation";
import { computeReadiness } from "./readiness";
import { RUN_PROFILE_FILE, buildRunProfile, isAttendedRun, writeRunProfile } from "./run-profile";
import { compareVersions, renderSkillDrift, reviewSkillDrift, skillVersion } from "./skill-drift";
import { computeVerdict } from "./verdict";
import { promoteParentExecutions, verifyRun } from "./verify-run";

const NOW = new Date("2026-10-16T08:00:00.000Z");
let root: string;
let pkg: string;
const originalCwd = process.cwd();

const put = (name: string, value: unknown): void => {
  mkdirSync(path.dirname(path.join(pkg, name)), { recursive: true });
  writeFileSync(path.join(pkg, name), typeof value === "string" ? value : JSON.stringify(value, null, 2));
};

function manifest(): void {
  put("manifest.json", {
    schemaVersion: 1,
    reviewId: "r1",
    mode: "review-flow",
    status: "draft",
    target: { kind: "pr", ref: "https://github.com/o/r/pull/7" },
    artifacts: { scope: "scope.md", coverage: "coverage.md", report: "report.md", findings: "findings.json", learning: "learning.md", decisions: "decisions.md" },
    coverage: [],
  });
  put("findings.json", []);
  put("report.md", "# Review\n");
  put("coverage.md", "# Reviewer Coverage\n");
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-harness-robustness-")));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, ".metaproject"));
  pkg = path.join(root, ".metaproject", "reviews", "r1");
  mkdirSync(pkg, { recursive: true });
  process.chdir(root);
});
afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

function card(name: string) {
  const spec = buildReviewConfirmSpecs({ prLookup: async () => null, prFiles: async () => null }).find((entry) => entry.name === name);
  if (spec === undefined) throw new Error(`no spec ${name}`);
  return operatorConfirmTool(spec, { projectRoot: root, now: () => NOW, env: {} });
}

async function yes(name: string, input: Record<string, unknown>): Promise<{ output: string; isError: boolean }> {
  const tool = card(name);
  const asked = (await tool.confirmation!(input)) as { token?: string; error?: string };
  if (asked.token === undefined) throw new Error(`refused: ${asked.error}`);
  const result = await tool.invoke(input, { confirmationToken: asked.token } as never);
  return { output: result.output, isError: result.isError ?? false };
}

describe("row 11: results and drivers live per package", () => {
  test("a slice manifest inside a package names that package; the shared slice directory names none", () => {
    mkdirSync(path.join(pkg, "slices"), { recursive: true });
    mkdirSync(path.join(pkg, "raw"), { recursive: true });
    put("manifest.json", {});
    expect(packageOfManifest(path.join(pkg, "slices"))).toBe(pkg);
    expect(packageOfManifest(path.join(root, ".metaproject", "data", "review", "slices"))).toBeUndefined();
  });

  test("the verdict reads <package>/raw by default, never the shared directory", async () => {
    manifest();
    const shared = path.join(root, ".metaproject", "data", "review", "raw");
    mkdirSync(shared, { recursive: true });
    writeFileSync(path.join(shared, "review-logic.txt"), '```REVIEW_RESULT\n{"status":"DONE","reviewer":"review-logic","findings":[{"severity":"major","problem":"old round"}]}\n```\n');
    rmSync(path.join(pkg, "findings.json"), { force: true });
    const verdict = await computeVerdict(pkg);
    expect(verdict.rawDir).toBe(path.join(pkg, "raw"));
    expect(verdict.total).toBe(0);
  });
});

describe("row 12: wave bytes per host", () => {
  test("the host comes from the environment; keryx shell keeps 60000, hosts without a child deadline get more", () => {
    expect(detectReviewHost({ KERYX_TOOL_CALL: "1" })).toBe("keryx-shell");
    expect(detectReviewHost({ CLAUDECODE: "1" })).toBe("claude-code");
    expect(detectReviewHost({ CODEX_SANDBOX: "seatbelt" })).toBe("codex");
    expect(detectReviewHost({})).toBe("other");
    expect(HOST_WAVE_BYTES["keryx-shell"]).toBe(60_000);
    expect(defaultWaveBytes("claude-code", 1000)).toBeGreaterThan(defaultWaveBytes("keryx-shell", 1000));
  });

  test("review slice --host records host and waveBytes in the manifest, and --package writes into the package", async () => {
    const diff = path.join(root, "change.diff");
    writeFileSync(diff, "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n const a = 1;\n+const b = 2;\n");
    const deps = {
      gitDiff: async () => "",
      readDiffSource: async (source: string) => readFileSync(source, "utf8"),
      parseContextLines: () => 3,
      rejectUnknownFlags: () => undefined,
    };
    const log = console.log;
    console.log = () => undefined;
    try {
      await runSlice(["--diff", diff, "--max-bytes", "1000", "--host", "claude-code", "--package", pkg], deps);
      const claude = JSON.parse(readFileSync(path.join(pkg, "slices", "manifest.json"), "utf8"));
      expect(claude.host).toBe("claude-code");
      expect(claude.waveBytes).toBe(HOST_WAVE_BYTES["claude-code"]);
      await runSlice(["--diff", diff, "--max-bytes", "1000", "--host", "keryx-shell", "--out", path.join(root, "s2")], deps);
      const shell = JSON.parse(readFileSync(path.join(root, "s2", "manifest.json"), "utf8"));
      expect(shell.host).toBe("keryx-shell");
      expect(shell.waveBytes).toBe(60_000);
      await expect(runSlice(["--diff", diff, "--host", "vscode"], deps)).rejects.toThrow("--host must be one of");
    } finally {
      console.log = log;
    }
  });
});

describe("rows 5, 15, 3: the autonomous run", () => {
  test("the prompt passes --scope and --package to required, runs one round unless the head moved, and reads the shared wave size", () => {
    const text = buildAutonomousPrompt({ ref: "https://github.com/o/r/pull/7" });
    expect(text).toContain(`--scope ${AUTONOMOUS_SCOPE_FILE}`);
    expect(text).toContain("--package <the package directory keryx review start printed>");
    expect(AUTONOMOUS_PROFILE.roundLimit).toBe(1);
    expect(text).toContain("Open one more round only if the head moved");
    expect(AUTONOMOUS_PROFILE.waveSize).toBe(REVIEW_WAVE_SIZE);
    expect(text).toContain(`at most ${REVIEW_WAVE_SIZE} reviewers per wave`);
  });

  test("a local range is a target: base...head, head defaulting to HEAD", () => {
    expect(parseAutonomousRangeTarget("main")).toEqual({ kind: "range", ref: "main...HEAD", base: "main", repository: "local", number: 0 });
    expect(parseAutonomousRangeTarget("origin/main", "abc1234").ref).toBe("origin/main...abc1234");
    expect(parseAutonomousRangeTarget("main...feat/x").head).toBe("feat/x");
    expect(() => parseAutonomousRangeTarget("https://github.com/o/r/pull/7")).toThrow("local base");
    expect(() => parseAutonomousRangeTarget("--upload-pack=x")).toThrow();
    expect(describeAutonomousTarget(parseAutonomousRangeTarget("main"))).toBe("range main...HEAD");
  });

  test("review run --autonomous on a range starts the shell with a range prompt and records a range summary", async () => {
    let spec: ChildSpec | undefined;
    const result = await runAutonomousReview({
      cwd: root,
      ref: "main",
      target: parseAutonomousRangeTarget("main"),
      resolveHead: async () => "abcdef1234567",
      pollMs: 5,
      spawn: (given) => {
        spec = given;
        return { exited: Promise.resolve(0), kill: () => undefined };
      },
    });
    const prompt = spec!.argv[spec!.argv.indexOf("--print") + 1]!;
    expect(prompt).toContain("the local range main...HEAD");
    expect(prompt).toContain("--target branch --ref main");
    expect(prompt).toContain("--head abcdef1234567");
    expect(path.basename(result.runDir)).toBe("range-main");
    expect(result.summary.target.kind).toBe("range");
    expect(validateSummary(result.summary)).toEqual([]);
  });
});

describe("row 6: attended is derived from the mode", () => {
  test("review start --unattended records an unattended round; the default stays attended", async () => {
    expect(isAttendedRun({}, pkg)).toBe(true);
    await writeRunProfile(pkg, buildRunProfile({ unattended: true, env: {}, now: NOW }));
    expect(JSON.parse(readFileSync(path.join(pkg, RUN_PROFILE_FILE), "utf8")).mode).toBe("unattended");
    expect(isAttendedRun({}, pkg)).toBe(false);
    expect(isAttendedRun({ KERYX_AUTONOMOUS_ANSWERS_FILE: "/x" })).toBe(false);
    expect(buildRunProfile({ env: {} }).mode).toBe("attended");
  });

  test("an unattended round records Not run: mutation pass instead of refusing", async () => {
    const need = await requiredReviewers(root, "all", undefined);
    const dispatch = { mode: "all", selected: need.required };
    await writeRunProfile(pkg, buildRunProfile({ env: {}, now: NOW }));
    expect((await coverageErrors(dispatch, { root, packageDir: pkg, pendingMutants: 2, diffStats: async () => undefined })).join(" ")).toContain("mutation pass");
    await writeRunProfile(pkg, buildRunProfile({ unattended: true, env: {}, now: NOW }));
    expect(await coverageErrors(dispatch, { root, packageDir: pkg, pendingMutants: 2 })).toEqual([]);
  });
});

describe("row 7: chunks estimate --mode automatic cannot bypass the operator", () => {
  test("refused without a terminal outside the autonomous runner, naming the card", async () => {
    const deps = { rejectUnknownFlags: () => undefined };
    await expect(runChunks(["estimate", "--package", pkg, "--mode", "automatic"], deps, { isTerminal: () => false, env: {} })).rejects.toThrow("review_chunks_answer");
    const log = console.log;
    console.log = () => undefined;
    try {
      await runChunks(["estimate", "--package", pkg, "--mode", "automatic"], deps, { isTerminal: () => false, env: { KERYX_AUTONOMOUS_ANSWERS_FILE: "/x" } });
      await runChunks(["estimate", "--package", pkg, "--mode", "automatic"], deps, { isTerminal: () => true, env: {} });
    } finally {
      console.log = log;
    }
  });
});

describe("row 8: mutation waiver and reviewer-set override need a card or a terminal", () => {
  async function gated(): Promise<string[]> {
    await writeRunProfile(pkg, buildRunProfile({ env: {}, now: NOW }));
    return (await requiredReviewers(root, "all", undefined)).required;
  }

  test("on a stamped package a quote in the dispatch is refused until the card records the waiver", async () => {
    const selected = await gated();
    put("research-evidence/mutants.json", { mutants: [{ id: "m1", file: "src/a.ts", anchor: "a", replacement: "b" }] });
    const dispatch = { mode: "all", selected, mutationWaiver: { operatorQuote: "the agent wrote this", reason: "no time" } };
    const before = (await coverageErrors(dispatch, { root, packageDir: pkg, pendingMutants: 1, attended: true })).join(" ");
    expect(before).toContain("review_waive_mutation");
    expect(before).toContain("keryx review waive-mutation");
    const result = await yes("review_waive_mutation", { package: pkg, reason: "the suite takes an hour" });
    expect(result.isError).toBe(false);
    expect((await confirmedDecision(pkg, "mutation-waiver"))?.confirmedVia).toBe("tui-card");
    expect(await coverageErrors(dispatch, { root, packageDir: pkg, pendingMutants: 1, attended: true })).toEqual([]);
  });

  test("an override quote written by the agent is refused; the card or the terminal command records it", async () => {
    const required = await gated();
    const dispatch = { mode: "all", selected: required.slice(0, 1), override: { operatorQuote: "agent words", reason: "faster" } };
    expect((await coverageErrors(dispatch, { root, packageDir: pkg })).join(" ")).toContain("review_override_reviewers");
    await expect(runOperatorCommand("override-reviewers", ["--package", pkg, "--reason", "faster"], { isTerminal: () => false, cwd: root })).rejects.toThrow("review_override_reviewers");
    const code = await runOperatorCommand("override-reviewers", ["--package", pkg, "--reason", "faster"], { isTerminal: () => true, ask: async () => "only logic, I am in a hurry", cwd: root, log: () => undefined });
    expect(code).toBe(0);
    expect((await confirmedDecision(pkg, "reviewer-override"))?.confirmedVia).toBe("terminal");
    expect(await coverageErrors(dispatch, { root, packageDir: pkg })).toEqual([]);
  });

  test("the override card records confirmedVia tui-card", async () => {
    await gated();
    const result = await yes("review_override_reviewers", { package: pkg, reason: "docs-only change", selected: ["review-logic"] });
    expect(result.isError).toBe(false);
    expect((await confirmedDecision(pkg, "reviewer-override"))?.quote).toContain(": yes");
  });

  test("a package created before the gate keeps the old rule: the dispatch quote stands", async () => {
    const selected = (await requiredReviewers(root, "all", undefined)).required;
    const dispatch = { mode: "all", selected, mutationWaiver: { operatorQuote: "operator said skip", reason: "legacy" } };
    expect(await coverageErrors(dispatch, { root, packageDir: pkg, pendingMutants: 1, attended: true })).toEqual([]);
  });

  test("a decision without how it was confirmed is not recorded", async () => {
    await expect(recordOperatorDecision(pkg, { kind: "mutation-waiver", quote: "x", reason: "y", confirmedVia: "agent" as never, at: NOW.toISOString() })).rejects.toThrow();
  });
});

describe("row 9: comments reply --final needs a card or a terminal", () => {
  test("a real final post without a terminal is refused, naming the card; a dry run and a fixture rehearsal are not", () => {
    const args = ["--repo", "o/r", "--pr", "7", "--sha", "abc1234", "--final"];
    expect(commentsReplyGate(args, () => false)).toContain("review_comments_reply");
    expect(commentsReplyGate([...args, "--dry-run"], () => false)).toBeUndefined();
    expect(commentsReplyGate([...args, "--fixtures", "dir"], () => false)).toBeUndefined();
    expect(commentsReplyGate(args, () => true)).toBeUndefined();
    expect(commentsReplyGate(args.slice(0, -1), () => false)).toBeUndefined();
  });

  test("the card and the new gates are refused to an unattended run", () => {
    for (const name of ["review_waive_mutation", "review_override_reviewers", "review_comments_reply", "review_confirm_plan"]) {
      expect(OPERATOR_CONFIRM_TOOL_NAMES).toContain(name);
      expect(isUnattendedExcludedTool(name)).toBe(true);
    }
  });
});

describe("AC6 card side: review_confirm_plan", () => {
  const estimate: PlanNumbers = { dispatches: 52, minutes: { min: 26, max: 65 }, perRole: [{ role: "review-logic", slices: 40, waves: 40 }], slicePlan: [{ id: "slice-01", roles: ["review-logic"], depth: "light" }], overThreshold: true };

  test("a confirmation binds to the plan it confirmed", async () => {
    await recordPlanConfirmation(pkg, estimate, { quote: "Run 52 dispatches?: yes", confirmedVia: "tui-card", at: NOW.toISOString() });
    const written = JSON.parse(readFileSync(path.join(pkg, "plan-confirmation.json"), "utf8"));
    expect(written).toMatchObject({ dispatches: 52, minutes: [26, 65], confirmedVia: "tui-card" });
    expect(await planConfirmed(pkg, estimate)).toBe(true);
    expect(await planConfirmed(pkg, { ...estimate, slicePlan: [{ id: "slice-01", roles: ["review-logic", "review-security-code"], depth: "deep" }] })).toBe(false);
  });

  test("a plan within the threshold is refused: there is nothing to confirm", async () => {
    manifest();
    const asked = (await card("review_confirm_plan").confirmation!({ package: pkg })) as { error?: string };
    expect(asked.error).toContain("within the threshold");
    await expect(runOperatorCommand("confirm-plan", ["--package", pkg], { isTerminal: () => false, cwd: root })).rejects.toThrow("review_confirm_plan");
  });
});

describe("row 10: item 10 outside keryx shell", () => {
  test("no attributable memory call on a host that passes no env reads 'not observable on this host', not a pass and not a block", async () => {
    manifest();
    await writeRunProfile(pkg, buildRunProfile({ host: "claude-code", env: {}, now: NOW }));
    put("tool-calls/orchestrator.jsonl", `${JSON.stringify({ time: NOW.toISOString(), event: "log-start" })}\n`);
    const item = (await computeReadiness(pkg)).items.find((entry) => entry.id === "memory-outside-stage")!;
    expect(item.status).toBe("pass");
    expect(item.evidence).toStartWith("not observable on this host (claude-code)");
  });

  test("keryx shell keeps the attributed reading", async () => {
    manifest();
    await writeRunProfile(pkg, buildRunProfile({ host: "keryx-shell", env: {}, now: NOW }));
    put("tool-calls/orchestrator.jsonl", `${JSON.stringify({ time: NOW.toISOString(), event: "log-start" })}\n`);
    const item = (await computeReadiness(pkg)).items.find((entry) => entry.id === "memory-outside-stage")!;
    expect(item.evidence).not.toContain("not observable");
  });

  test("review start's caller token attributes a CLI call to the orchestrator", async () => {
    manifest();
    expect(await startOrchestratorLog(root, "r1", pkg, "tok123")).toBe(true);
    await recordProcessCall(root, { source: "cli", command: 'keryx memory search "q" --status accepted' }, { KERYX_REVIEW_CALLER_TOKEN: "tok123" });
    await recordProcessCall(root, { source: "cli", command: 'keryx memory search "other"' }, {});
    const lines = readFileSync(path.join(pkg, "tool-calls", "orchestrator.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.filter((line) => line.caller !== undefined).map((line) => line.caller)).toEqual(["orchestrator", "unattributed"]);
  });

  test("the item's repair names the keryx shell card", async () => {
    const source = readFileSync(path.join(import.meta.dir, "readiness.ts"), "utf8");
    expect(source).toContain("review_waive_readiness tool with item memory-outside-stage");
  });
});

describe("row 16: trigger review tasks go to the autonomous runner", () => {
  test("a review task is recognised and routed to review run --autonomous over the flow's range", () => {
    expect(isReviewTask({ id: "T7", kind: "review", title: "review" })).toBe(true);
    expect(isReviewTask({ id: "T1", kind: "implement", title: "review the code" })).toBe(false);
    const range = reviewTaskRange({ defaultBranch: "origin/main", head: "abc1234" });
    expect(range).toEqual({ base: "origin/main", head: "abc1234" });
    expect(reviewTaskCommand(range)).toBe("keryx review run --autonomous --target branch --ref origin/main --head abc1234");
    expect(reviewTaskRange({ defaultBranch: undefined, head: undefined })).toEqual({ base: "main" });
  });
});

describe("row 4: verification commands run in the parent", () => {
  test("verify-run saves stdout, stderr and the exit, and a claim citing that file is recorded as execution", async () => {
    const run = await verifyRun({
      packageDir: pkg,
      finding: "f-1",
      argv: ["bun test src/a.test.ts"],
      cwd: root,
      now: NOW,
      runner: async (argv) => ({ exitCode: 1, stdout: `ran ${argv.join(" ")}`, stderr: "1 fail", timedOut: false }),
    });
    expect(path.relative(pkg, run.file)).toBe(path.join("research-evidence", "verify-f-1-1.txt"));
    const body = readFileSync(run.file, "utf8");
    expect(body).toContain("exit: 1");
    expect(body).toContain("ran sh -c bun test src/a.test.ts");
    expect(body).toContain("1 fail");
    const cited = `.metaproject/reviews/r1/research-evidence/verify-f-1-1.txt`;
    const [own, other] = promoteParentExecutions(
      [
        { finding: "f-1", verdict: "confirmed", method: "reasoning", evidence: `the test fails: ${cited}`, verifier: "review-verifier" },
        { finding: "f-2", verdict: "confirmed", method: "reasoning", evidence: `see ${cited}`, verifier: "review-verifier" },
      ],
      root,
    );
    expect(own!.method).toBe("execution");
    expect(other!.method).toBe("reasoning");
    const second = await verifyRun({ packageDir: pkg, finding: "f-1", argv: ["true"], cwd: root, runner: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }) });
    expect(path.basename(second.file)).toBe("verify-f-1-2.txt");
  });

  test("verify-run through the CLI needs a command and a finding", async () => {
    await expect(runOperatorCommand("verify-run", ["--package", pkg, "--finding", "f-1"], { cwd: root })).rejects.toThrow("needs a command");
    await expect(runOperatorCommand("verify-run", ["--package", pkg, "--", "true"], { cwd: root })).rejects.toThrow("--finding");
  });
});

describe("row 2: installed host skill copies older than the bundled ones", () => {
  test("an older installed copy is warned about with the command that refreshes it", () => {
    const bundled = path.join(root, "bundled");
    const home = path.join(root, "home");
    const write = (dir: string, version: string): void => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "SKILL.md"), `---\nname: review-orchestrator\nmetadata:\n  version: "${version}"\n---\nbody\n`);
    };
    write(path.join(bundled, "review-orchestrator"), "1.11.0");
    write(path.join(home, ".claude", "skills", "review-orchestrator"), "1.6.0");
    write(path.join(root, ".claude", "skills", "review-orchestrator"), "1.11.0");
    const drift = reviewSkillDrift({ projectRoot: root, bundledRoot: bundled, home });
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ skill: "review-orchestrator", installed: "1.6.0", bundled: "1.11.0" });
    expect(renderSkillDrift(drift)[0]).toContain("Refresh it: rm -rf");
    expect(skillVersion('---\nversion: "2.0.1"\n---\n')).toBe("2.0.1");
    expect(compareVersions("1.6.0", "1.11.0")).toBe(-1);
    expect(existsSync(path.join(home, ".claude", "skills", "review-orchestrator", "SKILL.md"))).toBe(true);
  });
});
