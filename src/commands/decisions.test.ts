// Flow 392 (AC1, AC4, AC7): `keryx decisions open|answer|reason|report` end to end
// through the command layer, the way an agent or a chat bridge calls it.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { decisionsCommand } from "./decisions";

let root: string;
const originalCwd = process.cwd();

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-decisions-cli-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  process.chdir(originalCwd);
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
});

async function run(args: string[]): Promise<{ out: string; err: string; exitCode: number }> {
  const realLog = console.log;
  const realError = console.error;
  const out: string[] = [];
  const err: string[] = [];
  console.log = (...parts: unknown[]) => void out.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => void err.push(parts.map(String).join(" "));
  try {
    process.chdir(root);
    process.exitCode = 0;
    await decisionsCommand(args);
    return { out: out.join("\n"), err: err.join("\n"), exitCode: Number(process.exitCode ?? 0) };
  } finally {
    console.log = realLog;
    console.error = realError;
    process.chdir(originalCwd);
    process.exitCode = 0;
  }
}

const OPEN = ["open", "--question", "Which approach?", "--option", "a=Safe", "--option", "b=Quick", "--option", "c=Odd", "--recommend", "a", "--reason", "least risk", "--stage", "design", "--json"];

test("open returns an id, a mode, the display order and whether to mark; answer reveals and asks for a reason once", async () => {
  const opened = await run(OPEN);
  expect(opened.exitCode).toBe(0);
  const decision = JSON.parse(opened.out) as { id: string; mode: string; order: string[]; showMark: boolean; options: Array<{ id: string; label: string }> };
  expect(["ordinary", "blind", "partial"]).toContain(decision.mode);
  expect([...decision.order].sort()).toEqual(["a", "b", "c"]);
  expect(decision.showMark).toBe(decision.mode === "ordinary");
  expect(decision.options.map((o) => o.id)).toEqual(decision.order);

  const answered = await run(["answer", decision.id, "--choice", "c", "--json"]);
  const result = JSON.parse(answered.out) as { recommendation: { optionId: string; reason: string }; matched: boolean; askReason: boolean };
  expect(result.recommendation).toEqual({ optionId: "a", reason: "least risk" });
  expect(result.matched).toBe(false);
  expect(result.askReason).toBe(true);

  const reason = await run(["reason", decision.id, "--text", "A is too slow"]);
  expect(reason.out).toContain("reason recorded");
  expect((await run(["reason", decision.id, "--text", "again"])).out).toContain("already asked");

  const report = await run(["report"]);
  expect(report.out).toContain("Decisions: 1 recorded, 1 answered");
  expect(report.out).toContain("recommended a, chose c");
  expect(report.out).toContain("reason: A is too slow");
});

test("an answer with --reason records the reason in the same call", async () => {
  const opened = JSON.parse((await run(OPEN)).out) as { id: string };
  const answered = JSON.parse((await run(["answer", opened.id, "--choice", "b", "--reason", "deadline", "--json"])).out) as { askReason: boolean; reasonRecorded: boolean };
  expect(answered).toMatchObject({ askReason: false, reasonRecorded: true });
  expect((await run(["report"])).out).toContain("reason: deadline");
});

test("a release is never opened blind, however many times it is drawn", async () => {
  for (let i = 0; i < 30; i += 1) {
    const out = await run(["open", "--question", "Release 1.2 now?", "--option", "yes=Yes", "--option", "no=No", "--recommend", "no", "--reason", "CI is red", "--json"]);
    const decision = JSON.parse(out.out) as { mode: string; showMark: boolean; irreversible: boolean };
    expect(decision).toMatchObject({ mode: "ordinary", showMark: true, irreversible: true });
  }
});

test("the config's irreversible list is read from .metaproject/decisions.config.json", async () => {
  await writeFile(path.join(root, ".metaproject", "decisions.config.json"), JSON.stringify({ irreversible: ["rotate keys"] }), "utf8");
  for (let i = 0; i < 20; i += 1) {
    const out = await run(["open", "--question", "Rotate keys today?", "--option", "yes=Yes", "--option", "no=No", "--recommend", "yes", "--json"]);
    expect(JSON.parse(out.out)).toMatchObject({ mode: "ordinary", irreversible: true });
  }
});

test("report is the same text twice, and says so when nothing is recorded", async () => {
  expect((await run(["report"])).out).toBe("No decisions recorded yet.");
  const opened = JSON.parse((await run(OPEN)).out) as { id: string };
  await run(["answer", opened.id, "--choice", "a"]);
  expect((await run(["report"])).out).toBe((await run(["report"])).out);
  expect(JSON.parse((await run(["report", "--json"])).out)).toMatchObject({ total: 1, answered: 1 });
});

test("bad input is an error line and exit code 1, not a stack trace", async () => {
  const noQuestion = await run(["open", "--option", "a=A", "--option", "b=B"]);
  expect(noQuestion.exitCode).toBe(1);
  expect(noQuestion.err).toContain("--question");
  const unknown = await run(["answer", "nope", "--choice", "a"]);
  expect(unknown.exitCode).toBe(1);
  expect(unknown.err).toContain("no open decision");
  expect((await run(["open", "--question", "q", "--option", "a=A", "--option", "b=B", "--bogus", "x"])).err).toContain("Unknown option");
  expect((await run(["frobnicate"])).exitCode).toBe(1);
});

test("answer refuses a choice that is no option, and --other records a free-form answer (F-005)", async () => {
  const opened = JSON.parse((await run(OPEN)).out) as { id: string };
  const refused = await run(["answer", opened.id, "--choice", "zzz"]);
  expect(refused.exitCode).toBe(1);
  expect(refused.err).toContain("not one of the options");
  const other = JSON.parse((await run(["answer", opened.id, "--choice", "my own idea", "--other", "--json"])).out) as { choice: string; matched: boolean };
  expect(other).toMatchObject({ choice: "my own idea", matched: false });
});

test("answer says the reason may be added later, and never says it must be asked now (F-001)", async () => {
  const opened = JSON.parse((await run(OPEN)).out) as { id: string };
  const answered = await run(["answer", opened.id, "--choice", "c"]);
  expect(answered.out).not.toContain("ask the human ONCE");
});

test("open takes the flow and stage from the checkout when they are not given (F-003)", async () => {
  await Bun.spawn(["git", "init", "-q", "-b", "flow-7-work"], { cwd: root }).exited;
  await mkdir(path.join(root, ".metaproject", "flows", "007-2026-10-02-work"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "flows", "007-2026-10-02-work", "flow.json"),
    JSON.stringify({ schemaVersion: 2, id: "007", slug: "work", title: "Work", status: "in-progress", tasks: [{ id: "T1", kind: "test", status: "in-progress" }] }),
    "utf8",
  );
  const args = OPEN.filter((a, i) => a !== "--stage" && OPEN[i - 1] !== "--stage");
  const opened = JSON.parse((await run([...args, "--json"])).out) as { flow: string | null };
  expect(opened.flow).toBe("007");
});

test("import: a bad line is skipped and counted, and with --json a failure is JSON", async () => {
  const good = { id: "h1", at: "2026-08-14T09:30:00Z", flow: null, stage: "design", question: "Q?", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }], recommendation: { optionId: "a", reason: "r" }, source: "poll 1", answer: { choice: "a" } };
  await writeFile(path.join(root, "in.jsonl"), `${JSON.stringify(good)}\n{broken\n`);
  const done = await run(["import", "in.jsonl"]);
  expect(done.exitCode).toBe(0);
  expect(done.out.split("\n")[0]).toBe("Imported: 1, skipped: 0, with recommendation: 1, answered: 1, deviations: 0, malformed: 1");
  expect(done.out).toContain("line 2: not valid JSON");

  const missing = await run(["import", "nope.jsonl", "--json"]);
  expect(missing.exitCode).toBe(1);
  expect(JSON.parse(missing.out)).toEqual({ error: "cannot read nope.jsonl" });
  expect(missing.err).toBe("");
  const plain = await run(["import", "nope.jsonl"]);
  expect(plain.err).toBe("cannot read nope.jsonl");

  const json = await run(["import", "in.jsonl", "--json"]);
  expect(JSON.parse(json.out)).toMatchObject({ imported: 0, skipped: 1, malformed: [{ line: 2, message: "not valid JSON" }] });
});
