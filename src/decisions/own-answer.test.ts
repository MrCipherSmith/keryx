// Flow 401: the operator's own answer and the reason for a picked option, in the journal (AC2, AC3, AC9, AC10).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService } from "../flow/service";
import { journalAsk, loadReport, renderReport, resolveFlowContext, MAX_OPERATOR_TEXT_LENGTH, type AskRequest } from "./service";
import { readRecords, resolveJournalFile } from "./store";
import { createAskUserTool } from "../harness/tool/builtin/ask-user-tool";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-own-answer-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const OPTIONS = [
  { id: "a", label: "Option A", description: "the safe one", recommended: true },
  { id: "b", label: "Option B", description: "the quick one" },
];

// built at run time so no secret scanner trips on the repository itself
const BOT_TOKEN = `123456789${":"}AAH${"x1Y2z3".repeat(6)}`;
const BARE_RUN = `Zq${"9Xk2Lm".repeat(7)}Pq`;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`);
}

describe("AC2: an own answer is returned to the agent, as the operator's own", () => {
  test("the tool result says it is the operator's own answer and carries the text", async () => {
    const tool = createAskUserTool(async () => ({ kind: "own", text: "  do it the third way  " }));
    const result = await tool.invoke({ question: "Pick", options: OPTIONS }, {} as never);
    expect(result.isError).toBe(false);
    expect(result.output).toContain("OWN answer");
    expect(result.output).toContain("do it the third way");
    expect(result.output).not.toContain("selected id=");
  });

  test("an own answer whose words equal an option id is still an own answer, not the option", async () => {
    const ask = journalAsk(async () => ({ kind: "own", text: "a" }), { cwd: root, random: () => 0.9 });
    await ask({ question: "Pick", options: OPTIONS });
    const answer = (await readRecords(root)).find((r) => r.kind === "answer");
    expect(answer).toMatchObject({ choice: "a", other: true, text: "a" });
    const report = await loadReport(root);
    expect(report.byMode.ordinary).toEqual({ answered: 1, matched: 0 });
  });

  test("an own answer is journaled with other:true and the full text, and the deviation prompt accepts typed text", async () => {
    const seen: string[] = [];
    const ask = journalAsk(
      async (request: AskRequest) => {
        seen.push(request.question);
        return request.question.includes("Why?") ? { kind: "own", text: "because of the migration" } : { kind: "own", text: "neither, split it" };
      },
      { cwd: root, random: () => 0.9 },
    );
    expect(await ask({ question: "Pick", options: OPTIONS })).toEqual({ kind: "own", text: "neither, split it" });
    expect(seen).toHaveLength(2);
    const report = await loadReport(root);
    expect(report.annotated).toHaveLength(1);
    expect(report.annotated[0]).toMatchObject({ own: true, text: "neither, split it", reason: "because of the migration" });
  });
});

describe("AC3: a picked option with a typed reason", () => {
  test("the reason is stored, the reason prompt is not shown, and the tool result carries it", async () => {
    const shown: string[] = [];
    const ask = journalAsk(
      async (request: AskRequest) => {
        shown.push(request.question);
        return { kind: "option", choice: "b", reason: "the deadline is Friday" };
      },
      { cwd: root, random: () => 0.9 },
    );
    const given = await ask({ question: "Pick", options: OPTIONS });
    expect(shown).toEqual(["Pick"]);
    const records = await readRecords(root);
    expect(records.find((r) => r.kind === "reason")).toMatchObject({ reason: "the deadline is Friday" });
    expect(records.find((r) => r.kind === "answer")).toMatchObject({ choice: "b" });
    expect((await loadReport(root)).annotated[0]).toMatchObject({ own: false, reason: "the deadline is Friday" });

    const tool = createAskUserTool(async () => given);
    const result = await tool.invoke({ question: "Pick", options: OPTIONS }, {} as never);
    expect(result.output).toContain('id="b"');
    expect(result.output).toContain("the deadline is Friday");
  });

  test("a reason on the recommended option is stored too", async () => {
    const ask = journalAsk(async () => ({ kind: "option", choice: "a", reason: "obvious" }), { cwd: root, random: () => 0.9 });
    await ask({ question: "Pick", options: OPTIONS });
    expect((await loadReport(root)).annotated[0]).toMatchObject({ reason: "obvious" });
  });
});

describe("AC9: length, marker and redaction", () => {
  test("own text and reason are kept up to 2000 characters with a visible marker, the choice display keeps 300", async () => {
    const long = "word ".repeat(700).trim();
    const ask = journalAsk(async () => ({ kind: "own", text: long }), { cwd: root, random: () => 0.9 });
    await ask({ question: "Pick", options: [{ id: "a", label: "A", description: "" }, { id: "b", label: "B", description: "" }] });
    const answer = (await readRecords(root)).find((r) => r.kind === "answer");
    if (answer?.kind !== "answer") throw new Error("no answer");
    expect(answer.choice.length).toBeLessThanOrEqual(300);
    expect(answer.text).toBeDefined();
    expect((answer.text ?? "").length).toBeGreaterThan(1900);
    expect(answer.text).toContain("[truncated:");
    expect((answer.text ?? "").length).toBeLessThanOrEqual(MAX_OPERATOR_TEXT_LENGTH + 60);

    const mid = "x ".repeat(500).trim();
    const reasoned = journalAsk(async () => ({ kind: "option", choice: "a", reason: mid }), { cwd: root, random: () => 0.9 });
    await reasoned({ question: "Second", options: [{ id: "a", label: "A", description: "" }, { id: "b", label: "B", description: "" }] });
    const reasons = (await readRecords(root)).filter((r) => r.kind === "reason");
    expect(reasons[0]?.kind === "reason" && reasons[0].reason).toBe(mid);
  });

  test("a token-shaped string reaches neither journal.jsonl, journal.md nor the report", async () => {
    await git(root, "init", "-q", "-b", "main");
    await git(root, "commit", "-q", "--allow-empty", "-m", "init");
    const created = await createFlowService({ tracker: null, healthGate: async () => ({ status: "pass", reasons: [] }), now: () => new Date("2026-10-02T10:00:00Z") }).init({ cwd: root, title: "Secrets" });
    await git(root, "checkout", "-q", "-b", `feat/flow-${created.flow.id}-secrets`);

    const ask = journalAsk(
      async (request: AskRequest) => (request.question.includes("Why?") ? { kind: "own", text: `because ${BARE_RUN} ok` } : { kind: "own", text: `use ${BOT_TOKEN} for it` }),
      { cwd: root, context: () => resolveFlowContext(root, {}), random: () => 0.9 },
    );
    await ask({ question: "Pick", options: OPTIONS });

    const jsonl = await readFile(await resolveJournalFile(root), "utf8");
    const md = await readFile(path.join(root, created.dir, "journal.md"), "utf8");
    const report = renderReport(await loadReport(root));
    const json = JSON.stringify(await loadReport(root));
    for (const surface of [jsonl, md, report, json]) {
      expect(surface).not.toContain(BOT_TOKEN);
      expect(surface).not.toContain(BARE_RUN);
      expect(surface).not.toContain("x1Y2z3x1Y2z3");
    }
    expect(report).toContain("[REDACTED");
  });
});

describe("AC10: the flow journal and the report", () => {
  test("a reason is one line in journal.md with the question id, and the report prints own answers and reasons in full", async () => {
    await git(root, "init", "-q", "-b", "main");
    await git(root, "commit", "-q", "--allow-empty", "-m", "init");
    const created = await createFlowService({ tracker: null, healthGate: async () => ({ status: "pass", reasons: [] }), now: () => new Date("2026-10-02T10:00:00Z") }).init({ cwd: root, title: "Reasons" });
    await git(root, "checkout", "-q", "-b", `feat/flow-${created.flow.id}-reasons`);

    const reason = `${"because of the long story ".repeat(40)}END`;
    const ask = journalAsk(async () => ({ kind: "option", choice: "b", reason }), { cwd: root, context: () => resolveFlowContext(root, {}), random: () => 0.9 });
    await ask({ question: "Pick", options: OPTIONS });

    const id = (await readRecords(root)).find((r) => r.kind === "open")?.id ?? "";
    const md = await readFile(path.join(root, created.dir, "journal.md"), "utf8");
    const line = md.split("\n").find((l) => l.includes("reason:"));
    expect(line).toBeDefined();
    expect(line).toContain(`decision ${id}`);
    expect(line).toContain("END");

    const text = renderReport(await loadReport(root));
    expect(text).toContain("Own answers and reasons: 1");
    expect(text).toContain(`reason: ${reason.trim()}`);
    const json = JSON.parse(JSON.stringify(await loadReport(root))) as { annotated: Array<{ reason?: string }> };
    expect(json.annotated[0]?.reason).toBe(reason.trim());
  });

  test("an own answer is printed in full in the text report and in --json", async () => {
    const own = `${"third option details ".repeat(30)}FINISH`;
    const ask = journalAsk(async () => ({ kind: "own", text: own }), { cwd: root, random: () => 0.9 });
    await ask({ question: "Pick", options: OPTIONS });
    const report = await loadReport(root);
    expect(renderReport(report)).toContain(`own answer: ${own.trim()}`);
    expect(report.annotated[0]?.text).toBe(own.trim());
  });
});
