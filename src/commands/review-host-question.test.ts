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
import { MAX_OPERATOR_TEXT_LENGTH, isHostQuestionEntry, loadReport, openDecision, reportText } from "../decisions/service";
import { ENV_AUTONOMOUS_ANSWERS_FILE } from "../review/autonomous-answers";
import { operatorDecisionSubject } from "../review/coverage";
import { readOperatorDecisions, readPremiseDecisions } from "../review/operator-decisions";
import { estimatePlan, readPlanConfirmation, recordPlanConfirmation } from "../review/plan-confirmation";
import { isHostQuestion } from "../review/types";
import { heldFinding } from "../review/premise-fixtures";
import { computeReadiness, renderReadiness } from "../review/readiness";
import { buildRunProfile, writeRunProfile } from "../review/run-profile";
import { formatDecisionsLines } from "../tui/decisions-surface";
import { unattendedShellRefusal } from "../trigger/unattended";
import { runOperatorCommand } from "./review-operator";

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
    // The question names its subject: the unrun mutants (none on the scratch package, so nothing to name) or the count of reviewers left out.
    const selected = over["--selected"]?.split(",").map((item) => item.trim()).filter(Boolean);
    const { items } = await operatorDecisionSubject(dir, verb === "waive-mutation" ? "mutation-waiver" : "reviewer-override", verb === "waive-mutation" ? undefined : selected);
    const question =
      verb === "waive-mutation"
        ? items.length === 0
          ? "Waive the mutation pass? The suite takes an hour."
          : `Waive the mutation pass? ${items.length} mutants are unrun: ${items.join(", ")}. The suite takes an hour.`
        : `Run a smaller reviewer set than required? ${items.length} reviewers would be left out.`;
    base = { "--package": dir, "--reason": "the suite takes an hour", "--answer-text": verb === "waive-mutation" ? "yes, waive it" : "yes, only logic", "--question-text": question };
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

/** The terminal-path flags of a verb: the three host-question flags and their values dropped. */
function withoutHostFlags(args: string[]): string[] {
  const hostFlags = ["--answered-by", "--answer-text", "--question-text"];
  return args.filter((arg, i, all) => !hostFlags.includes(arg) && !hostFlags.includes(all[i - 1] ?? ""));
}

/** The text of a refusal, for the assertions that read more than a substring of it. */
async function refusalOf(verb: Verb, args: string[]): Promise<string> {
  try {
    await runOperatorCommand(verb, args, seams());
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`${verb} was accepted: ${args.join(" ")}`);
}

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
    expect(decision?.subject).toMatchObject({ items: [] });
    expect(decision?.hostQuestion).toMatchObject({ source: "claude-code", ref: "ask-17", questionText: "Waive the mutation pass? The suite takes an hour.", answerText: "yes, waive it" });
    expect(decision?.hostQuestion?.time).toBe(decision?.at);
  });

  test("AC2 override-reviewers records the override, with --selected bound into the subject", async () => {
    const dir = pkgDir();
    expect(await runOperatorCommand("override-reviewers", await argsFor("override-reviewers", dir, { "--selected": "review-logic" }), seams())).toBe(0);
    const [decision] = await readOperatorDecisions(dir);
    expect(decision).toMatchObject({ kind: "reviewer-override", reason: "the suite takes an hour", confirmedVia: "host-question" });
    expect(decision?.subject?.items).toBeDefined();
    expect(decision?.subject?.items).not.toContain("review-logic");
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
    for (const verb of ["confirm-plan", "waive-mutation", "override-reviewers"] as const) {
      for (const declined of ["n", "N", "no", "No.", " no ", "nope", "нет", "no, not now"]) {
        await expectRefused(verb, pkgDir(), { "--answer-text": declined }, /decline/i);
      }
    }
    for (const declined of ["n", "N", "no", "No.", " no ", "nope", "нет", "no, not now"]) {
      await expectRefused("decide-premise", pkgDir(), { "--answer-text": declined }, "--answer-text");
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

describe("HQ-01: the three yes-verbs record only an affirmative --answer-text", () => {
  const YES_VERBS = ["confirm-plan", "waive-mutation", "override-reviewers"] as const;
  const NEGATIONS = ["not", "never", "no", "nope", "nah", "dont", "don", "t", "nt", "cannot", "cant", "нет", "не", "ни", "без"];
  const LEAD_DECLINES = ["n", "no", "nope", "nah", "not", "never", "cancel", "stop", "decline", "declined", "reject", "нет", "не", "отмена"];
  const AFFIRMATIVES = ["yes", "y", "yep", "yeah", "ok", "okay", "sure", "confirm", "confirmed", "approve", "approved", "agree", "agreed", "go", "да", "ок", "окей", "подтверждаю", "согласен", "давай", "запускай"];
  const CONFIRM_WORD: Record<(typeof YES_VERBS)[number], string> = { "confirm-plan": "yes", "waive-mutation": "waive", "override-reviewers": "override" };

  test("a text that is not a yes is refused on each verb, with nothing recorded and no journal file", async () => {
    const refused = ["what does that mean?", "uphold", "don't waive it", "I do not want to waive it", "нет, не нужно", "maybe later", "hmm"];
    for (const verb of YES_VERBS) {
      for (const text of refused) await expectRefused(verb, pkgDir(), { "--answer-text": text }, "--answer-text");
    }
    for (const verb of ["waive-mutation", "override-reviewers"] as const) await expectRefused(verb, pkgDir(), { "--answer-text": "Keep: run the mutation pass" }, "--answer-text");
  });

  test("every word of the negation family refuses a text that otherwise says yes", async () => {
    for (const verb of YES_VERBS) {
      for (const word of NEGATIONS) await expectRefused(verb, pkgDir(), { "--answer-text": `yes ${word} ${CONFIRM_WORD[verb]} it` }, /reads as a decline/);
    }
  });

  test("every word of the lead-decline family refuses when it opens the text", async () => {
    for (const verb of YES_VERBS) {
      for (const word of LEAD_DECLINES) await expectRefused(verb, pkgDir(), { "--answer-text": `${word} ${CONFIRM_WORD[verb]}` }, /reads as a decline/);
    }
  });

  test("the verb's own decline word refuses: keep on the two gate verbs", async () => {
    await expectRefused("waive-mutation", pkgDir(), { "--answer-text": "yes keep it" }, /names the other option, "keep"/);
    await expectRefused("override-reviewers", pkgDir(), { "--answer-text": "yes keep it" }, /names the other option, "keep"/);
  });

  test("a text with no affirmative word is not a yes, and the message says what to pass", async () => {
    for (const verb of YES_VERBS) {
      const message = await refusalOf(verb, await argsFor(verb, pkgDir(), { "--answer-text": "what does that mean?" }));
      expect(message).toContain("--answer-text is not a yes");
      expect(message).toContain("Nothing was recorded");
    }
  });

  test("every affirmative word is accepted on its own, on each verb", async () => {
    for (const verb of YES_VERBS) {
      for (const word of AFFIRMATIVES) expect(await runOperatorCommand(verb, await argsFor(verb, pkgDir(), { "--answer-text": word }), seams())).toBe(0);
    }
  });

  test("the verb's own confirming word is accepted, and so is run for the plan", async () => {
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", pkgDir(), { "--answer-text": "waive" }), seams())).toBe(0);
    expect(await runOperatorCommand("override-reviewers", await argsFor("override-reviewers", pkgDir(), { "--answer-text": "override it" }), seams())).toBe(0);
    expect(await runOperatorCommand("confirm-plan", await argsFor("confirm-plan", pkgDir(), { "--answer-text": "run it" }), seams())).toBe(0);
  });

  test("a yes in either language with the reason after it is accepted", async () => {
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", pkgDir(), { "--answer-text": "да, отказываемся" }), seams())).toBe(0);
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", pkgDir(), { "--answer-text": "ok" }), seams())).toBe(0);
    expect(await runOperatorCommand("confirm-plan", await argsFor("confirm-plan", pkgDir(), { "--answer-text": "yes, run it" }), seams())).toBe(0);
  });
});

describe("HQ-02: the question must name its subject", () => {
  /** A package with `ids` proposed as mutants and none run: the unrun mutants a waiver waives. */
  function pkgWithMutants(ids: string[]): string {
    const dir = pkgDir();
    mkdirSync(path.join(dir, "research-evidence"), { recursive: true });
    writeFileSync(path.join(dir, "research-evidence", "mutants.json"), JSON.stringify({ mutants: ids.map((id) => ({ id, file: "src/a.ts", anchor: "a", replacement: "b" })) }));
    return dir;
  }
  const ask = (text: string) => ({ "--question-text": text });

  test("decide-premise refuses a question that does not name the finding, with nothing recorded", async () => {
    const dir = pkgDir([held, { ...held, id: "LY-0030", global_id: "r1#LY-0030" }]);
    const cases: Array<[string, string]> = [
      ["another finding id", "Premise question on r1#LY-004 (major). Uphold it or dismiss it?"],
      ["a longer id that contains the id", "Premise question on LY-0030 (major). Uphold it or dismiss it?"],
      ["a longer key that contains the key", "Premise question on r1#LY-0030 (major). Uphold it or dismiss it?"],
      ["a longer id the id is the tail of", "Premise question on XLY-003 and ALY-003. Uphold it or dismiss it?"],
      ["a hyphen-joined id", "Premise question on LY-003-b. Uphold it or dismiss it?"],
      ["no id at all", "Uphold it or dismiss it?"],
      ["only a count (the count binds the two gate verbs, not a finding)", "1 finding. Uphold it or dismiss it?"],
    ];
    for (const [, question] of cases) await expectRefused("decide-premise", dir, ask(question), "--question-text does not name the finding id: LY-003");
  });

  test("decide-premise accepts the full global key and the short id, in any case", async () => {
    for (const question of ["Premise question on r1#LY-003. Uphold or dismiss?", "Premise question on LY-003. Uphold or dismiss?", "Premise on ly-003: uphold or dismiss?", "(LY-003): uphold or dismiss?", "LY-003, major. Uphold or dismiss?"]) {
      const dir = pkgDir();
      expect(await runOperatorCommand("decide-premise", await argsFor("decide-premise", dir, ask(question)), seams())).toBe(0);
    }
  });

  test("waive-mutation refuses a question that names no unrun mutant and not their count", async () => {
    const dir = pkgWithMutants(["m-1", "m-2", "m-3"]);
    const cases = [
      "Waive the mutation pass?",
      "Waive the mutation pass? 5 mutants are unrun.",
      "Waive the mutation pass? 2 mutants are unrun.",
      "Waive the mutation pass for m-1 and m-2?",
      "Waive the mutation pass for m-1, m-2 and m-10?",
      "Waive the mutation pass for m-10, m-20 and m-30?",
      "Waive the mutation pass for m-1, m-2 and m-3-b?",
      "Waive the mutation pass? Runs in m-3 min.",
    ];
    for (const question of cases) await expectRefused("waive-mutation", dir, ask(question), "--question-text does not name the unrun mutants");
  });

  test("waive-mutation accepts the ids listed, in any case, or only their count", async () => {
    for (const question of ["Waive the mutation pass for m-1, m-2, m-3?", "Waive the mutation pass for M-1, M-2 and M-3 (unrun)?", "Waive the mutation pass? 3 mutants are unrun.", "Waive 3 unrun mutants?"]) {
      const dir = pkgWithMutants(["m-1", "m-2", "m-3"]);
      expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", dir, ask(question)), seams())).toBe(0);
    }
  });

  test("waive-mutation with no unrun mutant has no subject to name, so any question is accepted", async () => {
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", pkgDir(), ask("Waive the mutation pass?")), seams())).toBe(0);
  });

  test("override-reviewers refuses a question that names no reviewer left out and not their count", async () => {
    const dir = pkgDir();
    const { items } = await operatorDecisionSubject(dir, "reviewer-override", undefined);
    expect(items.length).toBeGreaterThan(2);
    const cases = [
      "Run a smaller reviewer set than required?",
      `${items.length + 1} reviewers would be left out.`,
      `${items.length - 1} reviewers would be left out.`,
      `${items.length}0 reviewers would be left out.`,
      `Leave out ${items[0]} only?`,
      `Leave out ${items.slice(0, -1).join(", ")} only?`,
      `Leave out ${items.map((item) => `${item}-x`).join(", ")}?`,
    ];
    for (const question of cases) await expectRefused("override-reviewers", dir, ask(question), "--question-text does not name the reviewers left out");
  });

  test("override-reviewers accepts every reviewer listed, in any case, or only the count", async () => {
    const { items } = await operatorDecisionSubject(pkgDir(), "reviewer-override", undefined);
    for (const question of [`Leave out ${items.join(", ")}?`, `Leave out ${items.join(" ").toUpperCase()}?`, `Leave out ${items.length} reviewers?`, `${items.length}`]) {
      const dir = pkgDir();
      expect(await runOperatorCommand("override-reviewers", await argsFor("override-reviewers", dir, ask(question)), seams())).toBe(0);
    }
  });

  test("override-reviewers with --selected binds to the reviewers that selection leaves out", async () => {
    const dir = pkgDir();
    const all = (await operatorDecisionSubject(dir, "reviewer-override", undefined)).items;
    const left = (await operatorDecisionSubject(dir, "reviewer-override", ["review-logic"])).items;
    expect(left.length).toBe(all.length - 1);
    await expectRefused("override-reviewers", dir, { "--selected": "review-logic", ...ask(`${all.length} reviewers would be left out.`) }, "does not name the reviewers left out");
    expect(await runOperatorCommand("override-reviewers", await argsFor("override-reviewers", pkgDir(), { "--selected": "review-logic", ...ask(`${left.length} reviewers would be left out.`) }), seams())).toBe(0);
  });
});

describe("HQ-09: the length and shape caps are refused before the first write", () => {
  test("an --answer-text over the cap, on every verb", async () => {
    for (const verb of FOUR) {
      const over = "yes ".repeat(MAX_OPERATOR_TEXT_LENGTH);
      await expectRefused(verb, pkgDir(), { "--answer-text": over }, `--answer-text is ${over.length} characters; at most ${MAX_OPERATOR_TEXT_LENGTH}`);
    }
  });

  test("a --question-text over the cap, on every verb", async () => {
    for (const verb of FOUR) {
      const over = "q".repeat(MAX_OPERATOR_TEXT_LENGTH + 1);
      await expectRefused(verb, pkgDir(), { "--question-text": over }, "--question-text");
    }
  });

  test("texts of exactly the cap are accepted", async () => {
    const answer = `waive ${"w".repeat(MAX_OPERATOR_TEXT_LENGTH - 6)}`;
    expect(answer.length).toBe(MAX_OPERATOR_TEXT_LENGTH);
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", pkgDir(), { "--answer-text": answer }), seams())).toBe(0);
  });

  test("a ref over 200 characters is refused, and 200 is accepted", async () => {
    for (const verb of FOUR) await expectRefused(verb, pkgDir(), { "--answered-by": `claude-code:${"r".repeat(201)}` }, "--answered-by");
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", pkgDir(), { "--answered-by": `claude-code:${"r".repeat(200)}` }), seams())).toBe(0);
  });

  test("a control character in the ref is refused", async () => {
    // Both ends of each range are pinned: 0x1f is the last C0 control, 0x7f..0x9f the DEL and C1 block.
    for (const control of ["\n", "\r", "\t", "\u0000", "\u001b", "\u001f", "\u007f", "\u0085", "\u009f"]) {
      for (const verb of FOUR) await expectRefused(verb, pkgDir(), { "--answered-by": `codex:ask${control}17` }, "control character");
    }
  });
});

describe("AC4 stays: without the flag the verbs behave as before", () => {
  test("AC4 the refusal without a TTY is unchanged and names the card", async () => {
    for (const verb of FOUR) {
      const dir = pkgDir();
      const args = withoutHostFlags(await argsFor(verb, dir));
      await expect(runOperatorCommand(verb, args, seams())).rejects.toThrow(`records the operator's own decision and needs a terminal: refused when stdin or stdout is not a TTY. Inside keryx shell, call the review_${verb.replace("-", "_")} tool`);
    }
  });

  test("AC4 a terminal with --answered-by still takes the flag path and never asks", async () => {
    const dir = pkgDir();
    const asked: string[] = [];
    const seam = { isTerminal: () => true, ask: async (question: string) => (asked.push(question), "yes"), cwd: repo, log: () => undefined, env: {} };
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

  test("AC5 an unattended run's shell floor refuses the flag on each of the four verbs when one keryx invocation carries it, not on a mere mention", () => {
    for (const verb of FOUR) {
      const line = `keryx review ${verb} --package .metaproject/reviews/r1 --reason x --answered-by claude-code:q1 --answer-text yes --question-text "ok?"`;
      expect(unattendedShellRefusal(line)).toContain("--answered-by");
      expect(unattendedShellRefusal(`sh -c '${line}'`)).toContain("--answered-by");
      expect(unattendedShellRefusal(`bun src/cli.ts review ${verb} --answered-by=codex:1`)).toContain("--answered-by");
    }
    // The verbs without the flag are not the floor's business, and neither is another command that only mentions the flag.
    expect(unattendedShellRefusal("keryx review confirm-plan --package p")).toBeUndefined();
    expect(unattendedShellRefusal("keryx review estimate --package p")).toBeUndefined();
    expect(unattendedShellRefusal("echo 'review confirm-plan' | grep -e --answered-by")).toBeUndefined();
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
  }, 60_000);

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
    await expectRefused("decide-premise", dir, { "--answer-text": "no" }, "--answer-text");
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

describe("HQ-10: the journal entry and a retry", () => {
  type JournalLine = { type?: string; kind?: string; id?: string; flow?: string; flowSource?: string; stage?: string; options?: Array<{ id: string; description?: string }>; hostQuestion?: { source: string; ref: string; verb: string }; choice?: string };
  const journalLines = (): JournalLine[] => readFileSync(journalFile(), "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as JournalLine);

  test("every option of the entry says keryx synthesized it, and the stage names the verb", async () => {
    for (const verb of FOUR) expect(await runOperatorCommand(verb, await argsFor(verb, pkgDir()), seams())).toBe(0);
    const opens = journalLines().filter((line) => line.options !== undefined);
    expect(opens).toHaveLength(4);
    for (const open of opens) {
      expect(open.stage).toBe(`review ${open.hostQuestion?.verb}`);
      for (const option of open.options ?? []) expect(option.description).toContain("Synthesized by keryx");
    }
  });

  test("the entry carries the flow the verb ran under", async () => {
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", pkgDir()), seams({ env: { KERYX_FLOW: "flow-x" } }))).toBe(0);
    const open = journalLines().find((line) => line.options !== undefined);
    expect(open).toMatchObject({ flow: "flow-x", flowSource: "env" });
  });

  test("the same host question recorded twice is refused the second time, with one record and one journal entry", async () => {
    for (const verb of ["confirm-plan", "waive-mutation", "override-reviewers"] as const) {
      const dir = pkgDir();
      expect(await runOperatorCommand(verb, await argsFor(verb, dir), seams())).toBe(0);
      const before = snapshot(dir);
      const opens = journalLines().filter((line) => line.options !== undefined).length;
      await expect(runOperatorCommand(verb, await argsFor(verb, dir), seams())).rejects.toThrow("already recorded");
      expect(snapshot(dir)).toEqual(before);
      expect(journalLines().filter((line) => line.options !== undefined)).toHaveLength(opens);
    }
  });

  test("a second question with a new ref is a new answer and a new journal entry", async () => {
    const dir = pkgDir();
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", dir, { "--answered-by": "claude-code:ask-1" }), seams())).toBe(0);
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", dir, { "--answered-by": "claude-code:ask-2" }), seams())).toBe(0);
    expect((await journalRows()).map((row) => row.ref).sort()).toEqual(["ask-1", "ask-2"]);
  });

  test("two different host questions with the same question text are two entries, not one merged twin", async () => {
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", pkgDir(), { "--answered-by": "codex:turn-1" }), seams())).toBe(0);
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", pkgDir(), { "--answered-by": "helyx-poll:poll-2" }), seams())).toBe(0);
    const rows = await journalRows();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => `${row.source}:${row.ref}`).sort()).toEqual(["codex:turn-1", "helyx-poll:poll-2"]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  test("an unwritable journal leaves the review record written and prints a warning", async () => {
    mkdirSync(journalFile(), { recursive: true });
    const dir = pkgDir();
    const lines: string[] = [];
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", dir), seams({ lines }))).toBe(0);
    expect((await readOperatorDecisions(dir))[0]).toMatchObject({ kind: "mutation-waiver", confirmedVia: "host-question" });
    expect(lines.join("\n")).toContain("warning: the answer is recorded, but the keryx decisions journal was not updated");
  });
});

describe("HQ-10: a stored malformed hostQuestion is not trusted by the readers", () => {
  const malformed: Array<[string, unknown]> = [
    ["an unknown source", { source: "telegram", ref: "1", questionText: "q", answerText: "a", time: "2026-10-19T10:00:00.000Z" }],
    ["a blank ref", { source: "codex", ref: "  ", questionText: "q", answerText: "a", time: "2026-10-19T10:00:00.000Z" }],
    ["a missing question", { source: "codex", ref: "1", answerText: "a", time: "2026-10-19T10:00:00.000Z" }],
    ["a non-string answer", { source: "codex", ref: "1", questionText: "q", answerText: 7, time: "2026-10-19T10:00:00.000Z" }],
    ["a missing time", { source: "codex", ref: "1", questionText: "q", answerText: "a" }],
    ["a string instead of an object", "claude-code:1"],
  ];

  /** Rewrites a stored record by hand, as a corrupted or hand-edited file would hold it. */
  function tamper(file: string, edit: (record: Record<string, unknown>) => void): void {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const records = Array.isArray(parsed["decisions"]) ? (parsed["decisions"] as Array<Record<string, unknown>>) : [parsed];
    for (const record of records) edit(record);
    writeFileSync(file, JSON.stringify(parsed));
  }

  test("plan-confirmation.json: a malformed hostQuestion reads as no confirmation", async () => {
    for (const [, bad] of malformed) {
      const dir = pkgDir();
      expect(await runOperatorCommand("confirm-plan", await argsFor("confirm-plan", dir), seams())).toBe(0);
      expect(await readPlanConfirmation(dir)).toBeDefined();
      tamper(path.join(dir, "plan-confirmation.json"), (record) => void (record["hostQuestion"] = bad));
      expect(await readPlanConfirmation(dir)).toBeUndefined();
    }
  });

  test("operator-decisions.json: a host-question record with a malformed hostQuestion is dropped, premise and gate alike", async () => {
    for (const [, bad] of malformed) {
      const dir = pkgDir();
      expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", dir), seams())).toBe(0);
      expect(await runOperatorCommand("decide-premise", await argsFor("decide-premise", dir), seams())).toBe(0);
      expect(await readOperatorDecisions(dir)).toHaveLength(1);
      expect(await readPremiseDecisions(dir)).toHaveLength(1);
      tamper(path.join(dir, "operator-decisions.json"), (record) => void (record["hostQuestion"] = bad));
      expect(await readOperatorDecisions(dir)).toEqual([]);
      expect(await readPremiseDecisions(dir)).toEqual([]);
    }
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
    expect(result.output).toContain("Unknown option");
    expect(result.output).toContain("--answered-by");
    expect(result.output).toContain("--answer-text");
    expect(result.output).toContain("--question-text");
  }, 60_000);

  for (const flag of ["--answered-by", "--answer-text", "--question-text"]) {
    test(`AC7 ${flag} alone is refused as an unknown option`, () => {
      const result = complete(flag, "x");
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain("Unknown option");
      expect(result.output).toContain(flag);
    }, 60_000);
  }

  // --waive and --waive-coverage are still complete's own flags: they get past the flag check.
  for (const own of ["--waive", "--waive-coverage"]) {
    test(`AC7 ${own} stays accepted by the flag check`, () => {
      expect(complete(own, "x").output).not.toContain("Unknown option");
    }, 60_000);
  }
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
    const args = withoutHostFlags(await argsFor("decide-premise", dir));
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
    // The disposition's own evidence line names the source and the ref, not only the premise record beside it.
    const [record] = JSON.parse(text) as Array<{ disposition?: { evidence?: string } }>;
    expect(record?.disposition?.evidence).toContain("host-question codex:turn-4");
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
    const args = withoutHostFlags(await argsFor("waive-mutation", dir));
    expect(await runOperatorCommand("waive-mutation", args, seam)).toBe(0);
    const [decision] = await readOperatorDecisions(dir);
    expect(decision?.confirmedVia).toBe("terminal");
    expect(decision?.hostQuestion).toBeUndefined();
  });
});

// Review round 1058, follow-up review-testing-practices-w1:fu1: the mutation pass over this feature left these
// boundaries unpinned. Each test names the mutant it kills (ids in research-evidence/mutants.json).
describe("mutation follow-up: the answer words", () => {
  const YES_VERBS = ["confirm-plan", "waive-mutation", "override-reviewers"] as const;
  const UPHOLD = ["uphold", "upheld", "upholds", "keep", "kept", "оставить", "оставляем", "оставляю", "подтвердить", "подтверждаю", "поддержать"];
  const DISMISS = ["dismiss", "dismissed", "dismisses", "drop", "dropped", "отклонить", "отклоняю", "отклоняем", "снять", "закрыть"];

  test("N08 an answer text of punctuation only reads as a decline, not as free text", async () => {
    for (const verb of YES_VERBS) {
      for (const text of ["...", "?!", " - "]) await expectRefused(verb, pkgDir(), { "--answer-text": text }, /reads as a decline/);
    }
  });

  test("N22 every word of each choice set names that choice and no other", async () => {
    for (const [answer, other, words] of [["uphold", "dismiss", UPHOLD], ["dismiss", "uphold", DISMISS]] as const) {
      for (const word of words) {
        const dir = pkgDir();
        expect(await runOperatorCommand("decide-premise", await argsFor("decide-premise", dir, { "--answer": answer, "--answer-text": `${word} it` }), seams())).toBe(0);
        expect((await readPremiseDecisions(dir))[0]?.answer).toBe(answer);
        rmSync(journalFile(), { force: true });
        await expectRefused("decide-premise", pkgDir(), { "--answer": other, "--answer-text": `${word} it` }, "--answer-text");
      }
    }
  });

  test("N20 a negation in an earlier clause does not negate the choice named after the comma or the full stop", async () => {
    for (const [answer, text] of [["dismiss", "No, dismiss it"], ["dismiss", "Not sure. Dismiss it"], ["uphold", "No, uphold it"], ["uphold", "Hmm, not now? Uphold."]] as const) {
      const dir = pkgDir();
      expect(await runOperatorCommand("decide-premise", await argsFor("decide-premise", dir, { "--answer": answer, "--answer-text": text }), seams())).toBe(0);
      expect((await readPremiseDecisions(dir))[0]?.answer).toBe(answer);
    }
    // The same negation in the same clause still refuses.
    rmSync(journalFile(), { force: true });
    await expectRefused("decide-premise", pkgDir(), { "--answer": "dismiss", "--answer-text": "no dismiss" }, "--answer-text");
    await expectRefused("decide-premise", pkgDir(), { "--answer": "uphold", "--answer-text": "never uphold it" }, "--answer-text");
  });

  test("N52 a whitespace-only text is refused as blank, for either flag, on every verb", async () => {
    for (const verb of FOUR) {
      await expectRefused(verb, pkgDir(), { "--answer-text": "   " }, /--answer-text .* must not be blank/);
      await expectRefused(verb, pkgDir(), { "--question-text": "   " }, /--question-text .* must not be blank/);
      await expectRefused(verb, pkgDir(), { "--question-text": "\n\t " }, /must not be blank/);
    }
  });

  test("N43 only KERYX_TOOL_CALL=1 marks a nested keryx; other values are not the marker", async () => {
    for (const value of ["0", "", "true"]) {
      const dir = pkgDir();
      expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", dir), seams({ env: { KERYX_TOOL_CALL: value } }))).toBe(0);
      expect(await readOperatorDecisions(dir)).toHaveLength(1);
      rmSync(journalFile(), { force: true });
    }
  });

  // N46 (requireReason's own trim) is an equivalent mutant: recordOperatorDecision and the premise writer trim the reason again.
  // This pins the recorded outcome, which is what the operator-facing contract promises.
  test("N46 the recorded reason is trimmed, on the premise and gate verbs", async () => {
    const dir = pkgDir();
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", dir, { "--reason": "  the suite takes an hour \n" }), seams())).toBe(0);
    expect((await readOperatorDecisions(dir))[0]?.reason).toBe("the suite takes an hour");
    const premiseDir = pkgDir();
    expect(await runOperatorCommand("decide-premise", await argsFor("decide-premise", premiseDir, { "--reason": "  platforms do not mirror  " }), seams())).toBe(0);
    expect((await readPremiseDecisions(premiseDir))[0]?.reason).toBe("platforms do not mirror");
  });
});

describe("mutation follow-up: the question is bound to the current plan", () => {
  test("N32-N35 a question that shows only some of the plan's three numbers is stale", async () => {
    const dir = pkgDir();
    const estimate = await estimatePlan(dir);
    const numbers = [estimate.dispatches, estimate.minutes.min, estimate.minutes.max];
    // The fixture must make the three numbers tell apart, or leaving one out would still show it.
    expect(new Set(numbers).size).toBe(3);
    for (let omit = 0; omit < numbers.length; omit++) {
      const shown = numbers.filter((_, index) => index !== omit);
      await expectRefused("confirm-plan", dir, { "--question-text": `Run the plan: ${shown.join(" and ")}?` }, /plan/i);
    }
    await expectRefused("confirm-plan", dir, { "--question-text": `Run the plan: ${numbers[0]} only?` }, /plan/i);
    expect(await runOperatorCommand("confirm-plan", await argsFor("confirm-plan", dir, { "--question-text": `Run the plan: ${numbers.join(", ")}?` }), seams())).toBe(0);
  });
});

describe("mutation follow-up: what counts as the same host question", () => {
  test("N24 N25 confirm-plan: the same ref from another source, or another ref from the same source, is a new answer", async () => {
    const dir = pkgDir();
    const record = async (by: string) => runOperatorCommand("confirm-plan", await argsFor("confirm-plan", dir, { "--answered-by": by }), seams());
    expect(await record("claude-code:ask-1")).toBe(0);
    expect(await record("claude-code:ask-2")).toBe(0);
    expect(await record("codex:ask-2")).toBe(0);
    expect((await readPlanConfirmation(dir))?.hostQuestion).toMatchObject({ source: "codex", ref: "ask-2" });
    await expect(record("codex:ask-2")).rejects.toThrow("already recorded");
  });

  test("N39 one ref may answer a waiver and a reviewer override: the repeat check is per kind", async () => {
    const dir = pkgDir();
    expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", dir), seams())).toBe(0);
    expect(await runOperatorCommand("override-reviewers", await argsFor("override-reviewers", dir), seams())).toBe(0);
    expect((await readOperatorDecisions(dir)).map((decision) => decision.kind).sort()).toEqual(["mutation-waiver", "reviewer-override"]);
    await expect(runOperatorCommand("waive-mutation", await argsFor("waive-mutation", dir), seams())).rejects.toThrow("already recorded");
  });

  test("N40 one ref may answer the premise question of two findings: the repeat check is per finding", async () => {
    const dir = pkgDir([held, { ...held, id: "LY-005", global_id: "r1#LY-005" }]);
    expect(await runOperatorCommand("decide-premise", await argsFor("decide-premise", dir), seams())).toBe(0);
    const second = await argsFor("decide-premise", dir, { "--finding": "LY-005", "--question-text": "Premise question on LY-005. Uphold it or dismiss it?" });
    expect(await runOperatorCommand("decide-premise", second, seams())).toBe(0);
    expect((await readPremiseDecisions(dir)).map((decision) => decision.finding).sort()).toEqual(["r1#LY-003", "r1#LY-005"]);
    await expect(runOperatorCommand("decide-premise", second, seams())).rejects.toThrow("already recorded");
  });
});

describe("mutation follow-up: the decisions journal entry", () => {
  type OpenLine = { kind?: string; question?: string; channel?: string; seq?: number; options?: unknown[] };
  const openLines = (): OpenLine[] =>
    readFileSync(journalFile(), "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as OpenLine).filter((line) => line.kind === "open");
  const options = [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }];
  const host = (over: Partial<{ source: string; ref: string; verb: string }> = {}) => ({ source: "codex", ref: "q1", verb: "waive-mutation", answerText: "yes", ...over });

  test("N47 the entry's channel is the source named in --answered-by", async () => {
    for (const source of ["codex", "helyx-poll"]) {
      expect(await runOperatorCommand("waive-mutation", await argsFor("waive-mutation", pkgDir(), { "--answered-by": `${source}:q1` }), seams())).toBe(0);
    }
    expect(openLines().map((line) => line.channel)).toEqual(["codex", "helyx-poll"]);
  });

  test("J01-J03 an unanswered host question asked again is one decision; another source, ref or verb is another", async () => {
    const ask = (over?: Parameters<typeof host>[0]) => openDecision({ cwd: repo, question: "Same question?", options, hostQuestion: host(over), salt: "t" });
    const first = await ask();
    expect((await ask()).id).toBe(first.id);
    const others = [await ask({ source: "claude-code" }), await ask({ ref: "q2" }), await ask({ verb: "confirm-plan" })];
    expect(new Set([first.id, ...others.map((other) => other.id)]).size).toBe(4);
  });

  test("J04 a host question does not move the arm sequence of the next ordinary question", async () => {
    await openDecision({ cwd: repo, question: "Asked by the host?", options, hostQuestion: host(), salt: "t" });
    await openDecision({ cwd: repo, question: "Asked by keryx?", options, salt: "t" });
    expect(openLines().find((line) => line.question === "Asked by keryx?")?.seq).toBe(1);
  });
});

describe("mutation follow-up: the readers and the writer of a host question", () => {
  test("T01 isHostQuestion takes null and non-objects as not a host question, without throwing", () => {
    for (const value of [null, undefined, "codex:1", 7, true]) expect(isHostQuestion(value)).toBe(false);
    expect(isHostQuestion({ source: "codex", ref: "1", questionText: "q", answerText: "a", time: "2026-10-19T10:00:00.000Z" })).toBe(true);
  });

  test("D01 D02 isHostQuestionEntry is false for null, undefined and a null hostQuestion", () => {
    expect(isHostQuestionEntry(null)).toBe(false);
    expect(isHostQuestionEntry(undefined)).toBe(false);
    expect(isHostQuestionEntry({})).toBe(false);
    expect(isHostQuestionEntry({ hostQuestion: null })).toBe(false);
    expect(isHostQuestionEntry({ hostQuestion: { source: "codex" } })).toBe(true);
  });

  test("E03 a plan confirmation via host-question needs the question, and nothing is written without it", async () => {
    const dir = pkgDir();
    const estimate = await estimatePlan(dir);
    await expect(recordPlanConfirmation(dir, estimate, { quote: "yes, run it", confirmedVia: "host-question", at: new Date().toISOString() })).rejects.toThrow("needs the question and the answer");
    expect(existsSync(path.join(dir, "plan-confirmation.json"))).toBe(false);
  });
});
