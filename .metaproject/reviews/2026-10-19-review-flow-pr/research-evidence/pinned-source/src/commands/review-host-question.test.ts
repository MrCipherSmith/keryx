// Flow 467: the four standalone review verbs accept a recorded host question.
//
//   keryx review decide-premise|confirm-plan|waive-mutation|override-reviewers ... \
//     --answered-by <source>:<ref> --answer-text "<verbatim>" --question-text "<question as asked>"
//
// The operator answered a plain question through the host's own tool (Claude Code, Codex, keryx shell, a Telegram poll);
// the agent records the answer with the verb. No TTY is needed. Each test uses the `isTerminal` seam of
// `runOperatorCommand` and a scratch repository, as review-operator-cli.test.ts does.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadReport, reportText } from "../decisions/service";
import { ENV_AUTONOMOUS_ANSWERS_FILE } from "../review/autonomous-answers";
import { readOperatorDecisions, readPremiseDecisions } from "../review/operator-decisions";
import { estimatePlan, readPlanConfirmation } from "../review/plan-confirmation";
import { heldFinding } from "../review/premise-fixtures";
import { computeReadiness, renderReadiness } from "../review/readiness";
import { buildRunProfile, writeRunProfile } from "../review/run-profile";
import { formatDecisionsLines } from "../tui/decisions-surface";
import { unattendedShellRefusal } from "../trigger/unattended";
import { runOperatorCommand, type OperatorCommand } from "./review-operator";

const CLI = path.join(import.meta.dir, "..", "cli.ts");
const held = heldFinding();
const SOURCES = ["claude-code", "codex", "keryx-shell", "helyx-poll", "other"] as const;
const FOUR = ["decide-premise", "confirm-plan", "waive-mutation", "override-reviewers"] as const;
type Verb = (typeof FOUR)[number];

let repo: string;
beforeEach(() => {
  repo = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-host-question-")));
  execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

function pkgDir(findings: unknown[] = [held]): string {
  const dir = mkdtempSync(path.join(repo, "pkg-"));
  mkdirSync(path.join(dir, "raw"), { recursive: true });
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, reviewId: "r1", mode: "ingest", status: "draft", target: { kind: "report", ref: "r.md" }, artifacts: { scope: "scope.md", coverage: "coverage.md", report: "report.md", findings: "findings.json", learning: "learning.md", decisions: "decisions.md" }, coverage: [] }),
  );
  writeFileSync(path.join(dir, "findings.json"), JSON.stringify(findings));
  return dir;
}

const ASKED = "Premise question on r1#LY-003 (major: the timeline is not mirrored). Uphold it or dismiss it?";

type Over = Record<string, string | undefined>;

/** The flags of one verb; a key set to undefined drops the flag. */
async function argsFor(verb: Verb, dir: string, over: Over = {}): Promise<string[]> {
  let base: Over;
  if (verb === "decide-premise") {
    base = { "--package": dir, "--finding": "LY-003", "--answer": "dismiss", "--reason": "platforms do not mirror media controls", "--answer-text": "dismiss it, the platforms do not mirror media controls", "--question-text": ASKED };
  } else if (verb === "confirm-plan") {
    const estimate = await estimatePlan(dir);
    base = { "--package": dir, "--answer-text": "yes, run it", "--question-text": `Run ${estimate.dispatches} reviewer dispatches (${estimate.minutes.min}-${estimate.minutes.max} min) for the plan?` };
  } else {
    base = { "--package": dir, "--reason": "the suite takes an hour", "--answer-text": verb === "waive-mutation" ? "yes, waive it" : "yes, only logic", "--question-text": verb === "waive-mutation" ? "Waive the mutation pass? The suite takes an hour." : "Run a smaller reviewer set than required?" };
  }
  base = { "--answered-by": "claude-code:ask-17", ...base, ...over };
  return Object.entries(base).flatMap(([flag, value]) => (value === undefined ? [] : [flag, value]));
}

function seams(extra: { env?: Record<string, string | undefined>; lines?: string[] } = {}) {
  return { isTerminal: () => false, cwd: repo, log: (line: string) => void extra.lines?.push(line), env: extra.env ?? {} };
}

/** Every file under `dir` with its bytes, so "recorded nothing" is a comparison, not a guess. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out[path.relative(dir, full)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

const journalFile = () => path.join(repo, ".metaproject", "data", "decisions", "journal.jsonl");

/** The verb is refused: it throws, the package is byte-identical and the journal has no entry. */
async function expectRefused(verb: Verb, dir: string, over: Over, message?: string | RegExp, extra: Parameters<typeof seams>[0] = {}): Promise<void> {
  const before = snapshot(dir);
  const args = await argsFor(verb, dir, over);
  const result = runOperatorCommand(verb, args, seams(extra));
  if (message === undefined) await expect(result).rejects.toThrow();
  else await expect(result).rejects.toThrow(message);
  expect(snapshot(dir)).toEqual(before);
  expect(existsSync(journalFile())).toBe(false);
}

async function journalRows() {
  return (await loadReport(repo)).hostQuestions ?? [];
}

describe("AC1: decide-premise records a host question with no TTY", () => {
  test("AC1 dismiss: the decision and the finding change as on the terminal path, and the record carries the host question", async () => {
    const dir = pkgDir();
    const lines: string[] = [];
    const before = Date.now();
    const code = await runOperatorCommand("decide-premise", await argsFor("decide-premise", dir), seams({ lines }));
    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("premise-question dismiss recorded for r1#LY-003 (host-question, claude-code:ask-17");
    const [decision] = await readPremiseDecisions(dir);
    expect(decision).toMatchObject({ kind: "premise-question", finding: "r1#LY-003", answer: "dismiss", reason: "platforms do not mirror media controls", actor: "operator", confirmedVia: "host-question" });
    expect(decision?.subject).toMatchObject({ severity: "major", verdict: "challenged" });
    expect(decision?.hostQuestion).toMatchObject({ source: "claude-code", ref: "ask-17", questionText: ASKED, answerText: "dismiss it, the platforms do not mirror media controls" });
    expect(Date.parse(decision?.hostQuestion?.time ?? "")).toBeGreaterThanOrEqual(before - 1000);
    expect(decision?.hostQuestion?.time).toBe(decision?.at);
    const [record] = JSON.parse(readFileSync(path.join(dir, "findings.json"), "utf8")) as Array<{ disposition?: { state: string } }>;
    expect(record?.disposition?.state).toBe("dismissed-incorrect");
    expect((await computeReadiness(dir)).items.find((item) => item.id === "premise-decisions")?.status).toBe("pass");
  });

  test("AC1 uphold returns the finding to open, and a ref may hold colons (a helyx poll id plus message id)", async () => {
    const dir = pkgDir();
    const args = await argsFor("decide-premise", dir, { "--answer": "uphold", "--answered-by": "helyx-poll:poll-223:msg-214878", "--answer-text": "uphold, mirror it" });
    expect(await runOperatorCommand("decide-premise", args, seams())).toBe(0);
    const [decision] = await readPremiseDecisions(dir);
    expect(decision).toMatchObject({ answer: "uphold", confirmedVia: "host-question" });
    expect(decision?.hostQuestion).toMatchObject({ source: "helyx-poll", ref: "poll-223:msg-214878" });
    expect((await computeReadiness(dir)).items.find((item) => item.id === "premise-decisions")?.status).toBe("pass");
  });

  test("AC1 every allowed source is accepted", async () => {
    for (const source of SOURCES) {
      const dir = pkgDir();
      expect(await runOperatorCommand("decide-premise", await argsFor("decide-premise", dir, { "--answered-by": `${source}:q1` }), seams())).toBe(0);
      expect((await readPremiseDecisions(dir))[0]?.hostQuestion?.source).toBe(source);
    }
  });

  test("AC1 the equals form of the flags works too", async () => {
    const dir = pkgDir();
    const args = (await argsFor("decide-premise", dir, { "--answered-by": undefined, "--answer-text": undefined, "--question-text": undefined })).concat(["--answered-by=codex:t-9", "--answer-text=dismiss it", `--question-text=${ASKED}`]);
    expect(await runOperatorCommand("decide-premise", args, seams())).toBe(0);
    expect((await readPremiseDecisions(dir))[0]?.hostQuestion).toMatchObject({ source: "codex", ref: "t-9", answerText: "dismiss it" });
  });
});

describe("AC2: the same flags work with no TTY on the other three verbs", () => {
  test("AC2 confirm-plan records plan-confirmation.json for exactly this plan", async () => {
    const dir = pkgDir();
    const estimate = await estimatePlan(dir);
    const args = await argsFor("confirm-plan", dir);
    const lines: string[] = [];
    expect(await runOperatorCommand("confirm-plan", args, seams({ lines }))).toBe(0);
    expect(lines.join("\n")).toContain("plan confirmed (host-question, claude-code:ask-17");
    const record = await readPlanConfirmation(dir);
    expect(record).toMatchObject({ dispatches: estimate.dispatches, minutes: [estimate.minutes.min, estimate.minutes.max], confirmedVia: "host-question" });
    expect(record?.quote).toContain("yes, run it");
    expect(record?.hostQuestion).toMatchObject({ source: "claude-code", ref: "ask-17", answerText: "yes, run it" });
    expect(record?.hostQuestion?.questionText).toContain(`Run ${estimate.dispatches} reviewer dispatches`);
    expect(record?.hostQuestion?.time).toBe(record?.at);
  });

  test("AC2 waive-mutation records the waiver as the terminal path does, bound to head and unrun mutants", async () => {
    const dir = pkgDir();
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", dir), seams())).toBe(0);
    const [decision] = await readOperatorDecisions(dir);
    expect(decision).toMatchObject({ kind: "mutation-waiver", reason: "the suite takes an hour", confirmedVia: "host-question" });
    expect(decision?.quote).toContain("yes, waive it");
    expect(decision?.subject).toBeDefined();
    expect(decision?.hostQuestion).toMatchObject({ source: "claude-code", ref: "ask-17", questionText: "Waive the mutation pass? The suite takes an hour.", answerText: "yes, waive it" });
    expect(decision?.hostQuestion?.time).toBe(decision?.at);
  });

  test("AC2 override-reviewers records the override, with --selected bound into the subject", async () => {
    const dir = pkgDir();
    expect(await runOperatorCommand("override-reviewers", await argsFor("override-reviewers", dir, { "--selected": "review-logic" }), seams())).toBe(0);
    const [decision] = await readOperatorDecisions(dir);
    expect(decision).toMatchObject({ kind: "reviewer-override", reason: "the suite takes an hour", confirmedVia: "host-question" });
    expect(decision?.subject).toBeDefined();
    expect(decision?.hostQuestion).toMatchObject({ source: "claude-code", ref: "ask-17", answerText: "yes, only logic" });
  });

  test("AC2 an --answer naming the confirming option is accepted on the three verbs", async () => {
    const accepted: Array<[Verb, string]> = [["confirm-plan", "yes"], ["waive-mutation", "waive"], ["override-reviewers", "override"]];
    for (const [verb, answer] of accepted) {
      const dir = pkgDir();
      expect(await runOperatorCommand(verb, await argsFor(verb, dir, { "--answer": answer }), seams())).toBe(0);
    }
  });
});

describe("AC3: each refusal records nothing and exits non-zero with a message", () => {
  test("AC3 an --answer that is not one of the verb's options", async () => {
    await expectRefused("decide-premise", pkgDir(), { "--answer": "maybe" }, "uphold or dismiss");
    await expectRefused("decide-premise", pkgDir(), { "--answer": undefined }, "uphold or dismiss");
    await expectRefused("confirm-plan", pkgDir(), { "--answer": "maybe" }, "--answer");
    await expectRefused("waive-mutation", pkgDir(), { "--answer": "uphold" }, "--answer");
    await expectRefused("override-reviewers", pkgDir(), { "--answer": "dismiss" }, "--answer");
  });

  test("AC3 an --answer that is the decline option records nothing", async () => {
    await expectRefused("confirm-plan", pkgDir(), { "--answer": "no" }, "decline");
    await expectRefused("waive-mutation", pkgDir(), { "--answer": "keep" }, "decline");
  });

  test("AC3 a blank or missing --answer-text or --question-text", async () => {
    for (const verb of FOUR) {
      await expectRefused(verb, pkgDir(), { "--answer-text": "   " }, "--answer-text");
      await expectRefused(verb, pkgDir(), { "--answer-text": undefined }, "--answer-text");
      await expectRefused(verb, pkgDir(), { "--question-text": "" }, "--question-text");
      await expectRefused(verb, pkgDir(), { "--question-text": undefined }, "--question-text");
    }
  });

  test("AC3 a missing or malformed --answered-by", async () => {
    for (const bad of ["telegram:1", "claude-code:", "claude-code", ":ask-1", "", "claude-code:   ", "Claude-Code:1"]) {
      await expectRefused("decide-premise", pkgDir(), { "--answered-by": bad }, "--answered-by");
    }
    // The flag with no value at all (the next token is another flag) is malformed, not absent.
    const dir = pkgDir();
    const before = snapshot(dir);
    const args = (await argsFor("waive-mutation", dir, { "--answered-by": undefined })).concat(["--answered-by"]);
    await expect(runOperatorCommand("waive-mutation", args, seams())).rejects.toThrow("--answered-by");
    expect(snapshot(dir)).toEqual(before);
  });

  test("AC3 an unknown package", async () => {
    for (const verb of FOUR) {
      await expect(runOperatorCommand(verb, await argsFor(verb, pkgDir(), { "--package": path.join(repo, "nope") }), seams())).rejects.toThrow("--package");
    }
    expect(existsSync(journalFile())).toBe(false);
  });

  test("AC3 an unknown finding and a finding that is not held", async () => {
    const dir = pkgDir([held, { ...held, id: "LY-004", global_id: "r1#LY-004", premise: { verdict: "upheld", judge: "review-premise" } }]);
    await expectRefused("decide-premise", dir, { "--finding": "LY-999" }, "No finding");
    await expectRefused("decide-premise", dir, { "--finding": "LY-004" }, "not held");
    await expectRefused("decide-premise", dir, { "--finding": undefined }, "--finding");
  });

  test("AC3 a stale plan: a question that does not show this plan's numbers", async () => {
    const dir = pkgDir();
    await expectRefused("confirm-plan", dir, { "--question-text": "Run 987 reviewer dispatches (654-655 min) for the plan?" }, /plan/i);
    await expectRefused("confirm-plan", dir, { "--question-text": "Run the plan?" }, /plan/i);
  });

  test("AC3 a missing --reason", async () => {
    await expectRefused("decide-premise", pkgDir(), { "--reason": undefined }, "--reason");
    await expectRefused("decide-premise", pkgDir(), { "--reason": "  " }, "--reason");
    await expectRefused("waive-mutation", pkgDir(), { "--reason": undefined }, "--reason");
    await expectRefused("override-reviewers", pkgDir(), { "--reason": "" }, "--reason");
  });

  test("AC3 an --answer-text that is a decline: empty, n, no", async () => {
    for (const verb of FOUR) {
      for (const declined of ["n", "N", "no", "No.", " no ", "nope", "нет", "no, not now"]) {
        await expectRefused(verb, pkgDir(), { "--answer-text": declined }, /decline/i);
      }
    }
  });

  test("AC3 decide-premise: an --answer-text that does not name the same choice as --answer", async () => {
    await expectRefused("decide-premise", pkgDir(), { "--answer": "dismiss", "--answer-text": "uphold it" }, "--answer-text");
    await expectRefused("decide-premise", pkgDir(), { "--answer": "uphold", "--answer-text": "dismiss it" }, "--answer-text");
    await expectRefused("decide-premise", pkgDir(), { "--answer": "uphold", "--answer-text": "yes" }, "--answer-text");
    await expectRefused("decide-premise", pkgDir(), { "--answer": "dismiss", "--answer-text": "I am not sure what to say" }, "--answer-text");
    await expectRefused("decide-premise", pkgDir(), { "--answer": "dismiss", "--answer-text": "do not dismiss it" }, "--answer-text");
    await expectRefused("decide-premise", pkgDir(), { "--answer": "uphold", "--answer-text": "uphold or dismiss, either" }, "--answer-text");
  });

  test("AC3 decide-premise: the choice is named in the operator's words, in either language", async () => {
    for (const [answer, text] of [["uphold", "Upheld: keep the severity"], ["dismiss", "Dismissed, it is wrong"], ["uphold", "оставляем как есть"], ["dismiss", "снять, это неверно"]] as const) {
      const dir = pkgDir();
      expect(await runOperatorCommand("decide-premise", await argsFor("decide-premise", dir, { "--answer": answer, "--answer-text": text }), seams())).toBe(0);
      expect((await readPremiseDecisions(dir))[0]?.answer).toBe(answer);
    }
  });

  test("AC3 nothing is recorded when a refusal is raised after parsing: the journal stays empty", async () => {
    const dir = pkgDir();
    await expect(runOperatorCommand("decide-premise", await argsFor("decide-premise", dir, { "--finding": "LY-999" }), seams())).rejects.toThrow();
    expect(await readPremiseDecisions(dir)).toEqual([]);
    expect(await journalRows()).toEqual([]);
  });
});

describe("AC4 stays: without the flag the verbs behave as before", () => {
  test("AC4 the refusal without a TTY is unchanged and names the card", async () => {
    for (const verb of FOUR) {
      const dir = pkgDir();
      const args = (await argsFor(verb, dir)).filter((_, i, all) => !["--answered-by", "--answer-text", "--question-text"].includes(all[i - 1] ?? "") && !["--answered-by", "--answer-text", "--question-text"].includes(all[i] ?? ""));
      await expect(runOperatorCommand(verb, args, seams())).rejects.toThrow(`records the operator's own decision and needs a terminal: refused when stdin or stdout is not a TTY. Inside keryx shell, call the review_${verb.replace("-", "_")} tool`);
    }
  });

  test("AC4 a terminal with --answered-by still takes the flag path and never asks", async () => {
    const dir = pkgDir();
    const asked: string[] = [];
    const seam = { isTerminal: () => true, ask: async (question: string) => (asked.push(question), "yes"), cwd: repo, log: () => undefined };
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", dir), seam)).toBe(0);
    expect(asked).toEqual([]);
    expect((await readOperatorDecisions(dir))[0]?.confirmedVia).toBe("host-question");
  });
});

describe("AC5: an unattended run and a nested keryx refuse the flag, on every one of the four verbs", () => {
  test("AC5 KERYX_TOOL_CALL=1 (a nested keryx in keryx shell) refuses and records nothing", async () => {
    for (const verb of FOUR) {
      await expectRefused(verb, pkgDir(), {}, "KERYX_TOOL_CALL", { env: { KERYX_TOOL_CALL: "1" } });
    }
  });

  test("AC5 the autonomous runner's environment refuses and records nothing", async () => {
    for (const verb of FOUR) {
      await expectRefused(verb, pkgDir(), {}, /unattended/i, { env: { [ENV_AUTONOMOUS_ANSWERS_FILE]: "/tmp/answers.json" } });
    }
  });

  test("AC5 a package whose run profile says unattended refuses and records nothing", async () => {
    for (const verb of FOUR) {
      const dir = pkgDir();
      await writeRunProfile(dir, buildRunProfile({ unattended: true, env: {} }));
      await expectRefused(verb, dir, {}, /unattended/i, { env: {} });
    }
  });

  test("AC5 the refusal holds at a terminal too, and a real keryx tool-call environment is read from process.env by default", async () => {
    const dir = pkgDir();
    const before = process.env["KERYX_TOOL_CALL"];
    process.env["KERYX_TOOL_CALL"] = "1";
    try {
      await expect(runOperatorCommand("decide-premise", await argsFor("decide-premise", dir), { isTerminal: () => true, cwd: repo, log: () => undefined })).rejects.toThrow("KERYX_TOOL_CALL");
    } finally {
      if (before === undefined) delete process.env["KERYX_TOOL_CALL"];
      else process.env["KERYX_TOOL_CALL"] = before;
    }
    expect(await readPremiseDecisions(dir)).toEqual([]);
  });

  test("AC5 an unattended run's shell floor refuses the flag on each of the four verbs, however the line is wrapped", () => {
    for (const verb of FOUR) {
      const line = `keryx review ${verb} --package .metaproject/reviews/r1 --reason x --answered-by claude-code:q1 --answer-text yes --question-text "ok?"`;
      expect(unattendedShellRefusal(line)).toContain("--answered-by");
      expect(unattendedShellRefusal(`sh -c '${line}'`)).toContain("--answered-by");
      expect(unattendedShellRefusal(`bun src/cli.ts review ${verb} --answered-by=codex:1`)).toContain("--answered-by");
    }
    // The verbs without the flag are not the floor's business, and neither is another command that mentions the flag.
    expect(unattendedShellRefusal("keryx review confirm-plan --package p")).toBeUndefined();
    expect(unattendedShellRefusal("keryx review estimate --package p")).toBeUndefined();
  });
});

describe("AC6: an accepted host question also writes a keryx decisions entry", () => {
  test("AC6 the entry carries the question, the options, the choice, the source and the ref", async () => {
    const dir = pkgDir();
    expect(await runOperatorCommand("decide-premise", await argsFor("decide-premise", dir, { "--answered-by": "helyx-poll:poll-223:msg-9" }), seams())).toBe(0);
    const [row] = await journalRows();
    expect(row).toMatchObject({ question: ASKED, choice: "dismiss", source: "helyx-poll", ref: "poll-223:msg-9", verb: "decide-premise" });
    expect(row?.options.map((option) => option.id)).toEqual(["uphold", "dismiss"]);
    expect(row?.answerText).toBe("dismiss it, the platforms do not mirror media controls");
  });

  test("AC6 it is readable with `keryx decisions report --json`", async () => {
    const dir = pkgDir();
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", dir, { "--answered-by": "codex:turn-4" }), seams())).toBe(0);
    const child = Bun.spawnSync(["bun", CLI, "decisions", "report", "--json"], { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    const report = JSON.parse(child.stdout.toString()) as { hostQuestions: Array<{ question: string; options: Array<{ id: string }>; choice: string; source: string; ref: string }> };
    expect(report.hostQuestions).toHaveLength(1);
    expect(report.hostQuestions[0]).toMatchObject({ question: "Waive the mutation pass? The suite takes an hour.", choice: "waive", source: "codex", ref: "turn-4" });
    expect(report.hostQuestions[0]?.options.map((option) => option.id)).toEqual(["waive", "keep"]);
  });

  test("AC6 every verb writes one, with its own options", async () => {
    const expected: Record<Verb, { options: string[]; choice: string }> = {
      "decide-premise": { options: ["uphold", "dismiss"], choice: "dismiss" },
      "confirm-plan": { options: ["yes", "no"], choice: "yes" },
      "waive-mutation": { options: ["waive", "keep"], choice: "waive" },
      "override-reviewers": { options: ["override", "keep"], choice: "override" },
    };
    for (const verb of FOUR) {
      expect(await runOperatorCommand(verb, await argsFor(verb, pkgDir()), seams())).toBe(0);
    }
    const rows = await journalRows();
    expect(rows).toHaveLength(4);
    for (const verb of FOUR) {
      const row = rows.find((entry) => entry.verb === verb);
      expect(row?.options.map((option) => option.id)).toEqual(expected[verb].options);
      expect(row?.choice).toBe(expected[verb].choice);
    }
  });

  test("AC6 a refused question writes none", async () => {
    const dir = pkgDir();
    await expectRefused("decide-premise", dir, { "--answer-text": "no" }, /decline/i);
    await expectRefused("confirm-plan", dir, { "--answer-text": "  " }, "--answer-text");
    await expectRefused("waive-mutation", dir, { "--reason": undefined }, "--reason");
    expect(await journalRows()).toEqual([]);
    expect((await loadReport(repo)).total).toBe(0);
  });

  test("AC6 a host question is not a recommendation: it adds to no arm and no match share", async () => {
    expect(await runOperatorCommand("decide-premise", await argsFor("decide-premise", pkgDir()), seams())).toBe(0);
    const report = await loadReport(repo);
    expect(report.hostQuestions).toHaveLength(1);
    expect(report.total).toBe(0);
    expect(report.answered).toBe(0);
  });
});

describe("AC7: review complete refuses the host-question flags", () => {
  function complete(...extra: string[]): { exitCode: number; output: string } {
    const child = Bun.spawnSync(["bun", CLI, "review", "complete", "no-such-review", ...extra], { cwd: repo, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    return { exitCode: child.exitCode ?? -1, output: `${child.stdout.toString()}${child.stderr.toString()}` };
  }

  test("AC7 its flag check names --answered-by, --answer-text and --question-text as unknown", () => {
    const result = complete("--answered-by", "claude-code:q1", "--answer-text", "yes", "--question-text", "ok?");
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("--answered-by");
    expect(result.output).toContain("--answer-text");
    expect(result.output).toContain("--question-text");
    expect(result.output.toLowerCase()).toContain("unknown");
  });

  test("AC7 each flag alone is refused as unknown, and its own flags stay accepted", () => {
    for (const flag of ["--answered-by", "--answer-text", "--question-text"]) {
      const result = complete(flag, "x");
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain(flag);
      expect(result.output.toLowerCase()).toContain("unknown");
    }
    // --waive and --waive-coverage are still complete's own flags: they get past the flag check.
    for (const own of [["--waive", "x"], ["--waive-coverage", "x"]]) {
      expect(complete(...own).output.toLowerCase()).not.toContain("unknown flag");
    }
  });
});

describe("AC8: the record is visible as a host question, distinct from a card", () => {
  test("AC8 the readiness line of the review report names host-question and the source", async () => {
    const dir = pkgDir();
    expect(await runOperatorCommand("decide-premise", await argsFor("decide-premise", dir, { "--answered-by": "helyx-poll:poll-223" }), seams())).toBe(0);
    const readiness = await computeReadiness(dir);
    const evidence = readiness.items.find((item) => item.id === "premise-decisions")?.evidence ?? "";
    expect(evidence).toContain("host-question");
    expect(evidence).toContain("helyx-poll");
    expect(renderReadiness(readiness).join("\n")).toContain("host-question");
  });

  test("AC8 a card or terminal answer reads as before, with no host-question wording", async () => {
    const dir = pkgDir();
    const seam = { isTerminal: () => true, ask: async () => "dismiss it", cwd: repo, log: () => undefined };
    const args = (await argsFor("decide-premise", dir)).filter((_, i, all) => !["--answered-by", "--answer-text", "--question-text"].includes(all[i - 1] ?? "") && !["--answered-by", "--answer-text", "--question-text"].includes(all[i] ?? ""));
    expect(await runOperatorCommand("decide-premise", args, seam)).toBe(0);
    const evidence = (await computeReadiness(dir)).items.find((item) => item.id === "premise-decisions")?.evidence ?? "";
    expect(evidence).not.toContain("host-question");
  });

  test("AC8 the dismissal evidence on the finding says it was a host question and from where", async () => {
    const dir = pkgDir();
    expect(await runOperatorCommand("decide-premise", await argsFor("decide-premise", dir, { "--answered-by": "codex:turn-4" }), seams())).toBe(0);
    const text = readFileSync(path.join(dir, "findings.json"), "utf8");
    expect(text).toContain("host-question");
    expect(text).toContain("codex");
  });

  test("AC8 the /decisions modal data lists the host question with confirmedVia and the source", async () => {
    expect(await runOperatorCommand("decide-premise", await argsFor("decide-premise", pkgDir(), { "--answered-by": "helyx-poll:poll-223:msg-9" }), seams())).toBe(0);
    const text = await reportText(repo);
    expect(text).toContain("host-question");
    expect(text).toContain("helyx-poll");
    expect(text).toContain("poll-223:msg-9");
    expect(text).toContain("dismiss");
    expect(formatDecisionsLines(text).join("\n")).toContain("host-question");
  });

  test("AC8 the report text with no host question is as before", async () => {
    expect(await reportText(repo)).not.toContain("host-question");
  });
});

describe("older records stay readable", () => {
  test("an operator-decisions.json with no hostQuestion field reads as before", async () => {
    const dir = pkgDir();
    const seam = { isTerminal: () => true, ask: async () => "yes, waive it", cwd: repo, log: () => undefined };
    const args = (await argsFor("waive-mutation", dir)).filter((_, i, all) => !["--answered-by", "--answer-text", "--question-text"].includes(all[i - 1] ?? "") && !["--answered-by", "--answer-text", "--question-text"].includes(all[i] ?? ""));
    expect(await runOperatorCommand("waive-mutation", args, seam)).toBe(0);
    const [decision] = await readOperatorDecisions(dir);
    expect(decision?.confirmedVia).toBe("terminal");
    expect(decision?.hostQuestion).toBeUndefined();
  });

  test("the verbs keep their names", () => {
    const names: OperatorCommand[] = [...FOUR];
    expect(names).toHaveLength(4);
  });
});
