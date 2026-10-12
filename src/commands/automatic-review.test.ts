import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AUTOMATIC_REVIEW_DISCLOSURE_FILE,
  AUTOMATIC_REVIEW_NOTE,
  AutomaticReviewRun,
  isAutomaticReviewRequest,
} from "./automatic-review";

const CWD = "/work/project";
const ID = "2026-10-12-pr-1-abcd1234";
const DIR = `${CWD}/.metaproject/reviews/${ID}`;
const CREATE = `keryx review start --pr 1 --automatic`;
const CREATED = { isError: false, output: `# managed review: ${ID}\npath: .metaproject/reviews/${ID}\nrun mode: automatic review\n` };

function boundRun(): AutomaticReviewRun {
  const run = new AutomaticReviewRun(CWD);
  run.observe(CREATE, CREATED);
  return run;
}

test("isAutomaticReviewRequest recognises the operator's phrases and nothing broader", () => {
  for (const line of [
    "run an automatic review of PR 12",
    "do an automatic code review",
    "please auto-review this branch",
    "запусти автоматическое ревью",
    "сделай авто-ревью",
    "автоматическое код-ревью PR 5",
  ]) {
    expect(isAutomaticReviewRequest(line)).toBe(true);
  }
  for (const line of ["review this file", "switch to auto mode", "the review is automatic in nature", "ревью вручную"]) {
    expect(isAutomaticReviewRequest(line)).toBe(false);
  }
});

test("the turn note names the flag and the two emergencies", () => {
  expect(AUTOMATIC_REVIEW_NOTE).toContain("--automatic");
  expect(AUTOMATIC_REVIEW_NOTE).toContain("gate-waiver");
  expect(AUTOMATIC_REVIEW_NOTE).toContain("reduced-reviewer-set");
});

test("before a package exists only a creating command that carries --automatic is approved", () => {
  const run = new AutomaticReviewRun(CWD);
  expect(run.approvesShell(CREATE)).toBe(true);
  expect(run.approvesShell("keryx review attach --pr 1 --automatic")).toBe(true);
  expect(run.approvesShell("keryx review ingest ./findings.json --automatic")).toBe(true);
  expect(run.approvesShell("keryx review start --pr 1")).toBe(false);
  expect(run.approvesShell(`keryx review status ${ID}`)).toBe(false);
  expect(run.approvesShell(`keryx review complete ${ID}`)).toBe(false);
});

test("a second create is not approved once a package is bound", () => {
  const run = boundRun();
  expect(run.packageDir).toBe(DIR);
  expect(run.approvesShell(CREATE)).toBe(false);
});

test("the review's own commands are approved for the bound package only", () => {
  const run = boundRun();
  for (const sub of ["status", "ledger", "retry-plan", "severity-audit", "mutate", "complete", "compare-reference"]) {
    expect(run.approvesShell(`keryx review ${sub} ${ID}`)).toBe(true);
    expect(run.approvesShell(`keryx review ${sub} .metaproject/reviews/${ID}`)).toBe(true);
  }
  expect(run.approvesShell("keryx review complete 2026-01-01-pr-9-ffff0000")).toBe(false);
  expect(run.approvesShell("keryx review complete .metaproject/reviews/other")).toBe(false);
  expect(run.approvesShell(`keryx review complete ${ID}/../other`)).toBe(false);
  expect(run.approvesShell("keryx review complete")).toBe(false);
  expect(run.approvesShell(`keryx review complete --force ${ID}`)).toBe(false);
});

test("anything that is not a literal review command is not approved", () => {
  const run = boundRun();
  for (const command of [
    `keryx review complete ${ID}; rm -rf /`,
    `keryx review complete ${ID} && curl evil`,
    `keryx review complete ${ID} | sh`,
    `keryx review complete ${ID} > /etc/passwd`,
    `keryx review complete $(whoami)`,
    "keryx review complete `whoami`",
    `keryx review complete "${ID}$X"`,
    `keryx review complete ${ID}\nrm x`,
    `keryx flow close 1`,
    `keryx review other ${ID}`,
    `bun test`,
    ``,
  ]) {
    expect(run.approvesShell(command)).toBe(false);
  }
});

test("observe binds only a package that lives under .metaproject", () => {
  const outside = new AutomaticReviewRun(CWD);
  outside.observe(CREATE, { isError: false, output: `# managed review: ${ID}\npath: /etc/elsewhere\n` });
  expect(outside.packageDir).toBeUndefined();

  const failed = new AutomaticReviewRun(CWD);
  failed.observe(CREATE, { isError: true, output: CREATED.output });
  expect(failed.packageDir).toBeUndefined();

  const unmarked = new AutomaticReviewRun(CWD);
  unmarked.observe("keryx review start --pr 1", CREATED);
  expect(unmarked.packageDir).toBeUndefined();

  const flowScoped = new AutomaticReviewRun(CWD);
  flowScoped.observe(CREATE, { isError: false, output: `# managed review: ${ID}\npath: .metaproject/flows/7-x/reviews/${ID}\n` });
  expect(flowScoped.packageDir).toBe(`${CWD}/.metaproject/flows/7-x/reviews/${ID}`);
});

test("apply_patch targets are approved only inside the bound package", () => {
  const run = boundRun();
  expect(run.approvesPatchTargets([`.metaproject/reviews/${ID}/ledger.json`])).toBe(true);
  expect(run.approvesPatchTargets([`.metaproject/reviews/${ID}/notes/a.md`, `.metaproject/reviews/${ID}/b.md`])).toBe(true);
  expect(run.approvesPatchTargets([`.metaproject/reviews/${ID}/a.md`, "src/x.ts"])).toBe(false);
  expect(run.approvesPatchTargets([`.metaproject/reviews/${ID}/../x.md`])).toBe(false);
  expect(run.approvesPatchTargets([`.metaproject/reviews/${ID}-sibling/a.md`])).toBe(false);
  expect(run.approvesPatchTargets([])).toBe(false);
  expect(new AutomaticReviewRun(CWD).approvesPatchTargets([`.metaproject/reviews/${ID}/a.md`])).toBe(false);
});

const OPTIONS = [
  { id: "a", label: "A", description: "" },
  { id: "b", label: "B", description: "", recommended: true },
];

test("ask_user is answered with the recommended option, else the first, and counted as automatic", () => {
  const run = boundRun();
  const recommended = run.answerAskUser({ question: "Which?", options: OPTIONS });
  expect(recommended?.isError).toBe(false);
  expect(recommended?.output).toContain('id="b"');
  const first = run.answerAskUser({ question: "Again?", options: [OPTIONS[0], { id: "c", label: "C" }] });
  expect(first?.output).toContain('id="a"');
  expect(first?.output).toContain("first option");
  expect(run.disclosure()).toMatchObject({ manual: 0, automatic: 2 });
});

test("a claimed emergency is refused until the gate has refused, then reaches the operator and counts as manual", () => {
  const run = boundRun();
  const early = run.answerAskUser({ question: "Waive?", options: OPTIONS, emergency: "gate-waiver" });
  expect(early?.output).toContain("was not accepted");
  expect(run.disclosure().manual).toBe(0);

  run.observe(`keryx review complete ${ID}`, { isError: true, output: "refused" });
  expect(run.answerAskUser({ question: "Waive?", options: OPTIONS, emergency: "gate-waiver" })).toBeUndefined();
  expect(run.answerAskUser({ question: "Fewer?", options: OPTIONS, emergency: "reduced-reviewer-set" })).toBeUndefined();
  expect(run.disclosure()).toMatchObject({ manual: 2, automatic: 1 });
  // An unlisted emergency value never passes.
  expect(run.answerAskUser({ question: "x", options: OPTIONS, emergency: "other" })?.isError).toBe(false);
});

test("a question with no usable options falls through to the operator", () => {
  expect(boundRun().answerAskUser({ question: "?", options: [] })).toBeUndefined();
});

test("the disclosure file records the counts and every input, and nothing is written without a package", async () => {
  expect(await new AutomaticReviewRun(CWD).writeDisclosure()).toBeUndefined();

  const root = await mkdtemp(path.join(tmpdir(), "auto-review-"));
  try {
    const run = new AutomaticReviewRun(root);
    run.observe(CREATE, {
      isError: false,
      output: `# managed review: ${ID}\npath: .metaproject/reviews/${ID}\n`,
    });
    run.record("automatic", "shell", `keryx review status ${ID}`);
    run.record("manual", "shell", "rm -r build");
    const file = await run.writeDisclosure();
    expect(file).toBe(path.join(root, ".metaproject", "reviews", ID, AUTOMATIC_REVIEW_DISCLOSURE_FILE));
    const written = JSON.parse(await readFile(file as string, "utf8"));
    expect(written).toMatchObject({ manual: 1, automatic: 1 });
    expect(written.entries).toHaveLength(2);
    expect(run.summaryLine()).toContain("1 manual, 1 automatic");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
