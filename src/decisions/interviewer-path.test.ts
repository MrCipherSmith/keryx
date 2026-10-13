// Flow 400 (AC9, review T-3): the interviewer's questions go through the recommendation journal like every other
// work decision.
//
// How the interview reaches the journal in production: the interviewer skill tells the agent to ask every question
// through the `ask_user` tool when a host can show it. The agent's roster registers that tool as
// `createAskUserTool(journaledAskUser(cwd))` (see `buildInteractiveAgentTools`), so each question is opened in the
// journal (source, arm, recommendation) before it is shown and the answer is recorded after. The agent does not call
// `keryx decisions open|answer` for an interview, and no code of the repository runs a question list itself.
//
// This test drives that exact path: the tool name is parsed out of each SKILL.md copy, looked up in the real roster,
// and invoked the way the model calls it. Without a host the same tool answers "cancelled", which is the skill's cue
// to ask nothing and return NEEDS_CONTEXT with assumptions; nothing may reach the journal then.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildInteractiveAgentTools } from "../commands/interactive-agent-tools";
import { createDefaultSearchProviderController } from "../harness/search";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { setAskUserHost } from "../tui/ask-user-bridge";
import { DECISION_SOURCES } from "./sources";
import { readJournal } from "./store";
import type { AnswerRecord, OpenRecord } from "./types";

const COPIES = ["src/gdskills/bundled/skills/planning/interviewer/SKILL.md", ".metaproject/skills/gdskills/planning/interviewer/SKILL.md"];
const root = path.join(import.meta.dir, "..", "..");

const stubSpawn: InteractiveTool = {
  definition: { name: "spawn_subagent", description: "stub", inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "read" },
  invoke: async () => ({ output: "ok", isError: false }),
};

/** The section of one skill copy that states the host rule. */
async function hostSection(copy: string): Promise<string> {
  const text = await readFile(path.join(root, copy), "utf8");
  const start = text.indexOf("## Host or no host");
  const end = text.indexOf("## Question Bank");
  expect(start, `${copy}: "## Host or no host" section`).toBeGreaterThanOrEqual(0);
  expect(end, `${copy}: "## Question Bank" section`).toBeGreaterThan(start);
  return text.slice(start, end);
}

/** The tool the skill tells the agent to ask through: parsed from the "Host present" line, not assumed. */
function toolNamedBySkill(section: string, copy: string): string {
  const line = section.split("\n").find((l) => l.startsWith("- **Host present:**"));
  const name = line === undefined ? undefined : /ask every question through `([a-z_]+)`/.exec(line)?.[1];
  expect(name, `${copy}: the Host present line names the tool`).toBeDefined();
  return name ?? "";
}

function rosterTool(cwd: string, name: string): InteractiveTool {
  const tools = buildInteractiveAgentTools({
    cwd,
    metaprojectPort: createMetaprojectAdapter(cwd),
    searchController: createDefaultSearchProviderController(),
    spawnTool: stubSpawn,
  });
  const tool = tools.find((candidate) => candidate.definition.name === name);
  expect(tool, `the agent roster registers a tool named "${name}"`).toBeDefined();
  if (tool === undefined) throw new Error(`no tool ${name} in the roster`);
  return tool;
}

let cwd: string;
const savedFlow = process.env["KERYX_FLOW"];

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "keryx-interviewer-path-"));
  await mkdir(path.join(cwd, ".metaproject"), { recursive: true });
  delete process.env["KERYX_FLOW"];
});

afterEach(async () => {
  setAskUserHost(undefined);
  if (savedFlow === undefined) delete process.env["KERYX_FLOW"];
  else process.env["KERYX_FLOW"] = savedFlow;
  await rm(cwd, { recursive: true, force: true });
});

// An interview question as the model sends it: A/B/C/D options, one of them recommended with its reason.
const INTERVIEW_QUESTION = {
  question: "What is the primary trigger for this feature?",
  options: [
    { id: "a", label: "User request", description: "A new requirement", recommended: true },
    { id: "b", label: "Tech debt", description: "A refactor" },
    { id: "c", label: "Incident", description: "A bug in production" },
    { id: "d", label: "Other", description: "Describe it" },
  ],
  recommendationReason: "The brief names a user request.",
  allow_freeform: true,
};

describe("a host is present: the interviewer's question goes through ask_user into the journal", () => {
  for (const copy of COPIES) {
    test(`${copy}: the tool the skill names opens a journaled decision, and the answer lands`, async () => {
      const toolName = toolNamedBySkill(await hostSection(copy), copy);
      const shown: string[] = [];
      setAskUserHost(async (request) => {
        shown.push(request.question);
        return "a";
      });

      const result = await rosterTool(cwd, toolName).invoke(INTERVIEW_QUESTION);

      expect(result.isError).toBe(false);
      expect(shown).toEqual([INTERVIEW_QUESTION.question]);
      const { records } = await readJournal(cwd);
      const open = records.find((record): record is OpenRecord => record.kind === "open");
      expect(open).toBeDefined();
      expect(open?.question).toBe(INTERVIEW_QUESTION.question);
      expect(open?.source).toBe(DECISION_SOURCES.askUser);
      expect(["A", "B", "C", "D"]).toContain(open?.arm ?? "none");
      expect(open?.recommendation).toEqual({ optionId: "a", reason: INTERVIEW_QUESTION.recommendationReason });
      expect(open?.options.map((option) => option.id).sort()).toEqual(["a", "b", "c", "d"]);
      const answer = records.find((record): record is AnswerRecord => record.kind === "answer");
      expect(answer).toMatchObject({ id: open?.id, choice: "a" });
    });
  }

  test("two questions are two decisions: each is opened and answered on its own", async () => {
    const toolName = toolNamedBySkill(await hostSection(COPIES[0] ?? ""), COPIES[0] ?? "");
    setAskUserHost(async () => "b");
    const tool = rosterTool(cwd, toolName);
    await tool.invoke(INTERVIEW_QUESTION);
    await tool.invoke({ ...INTERVIEW_QUESTION, question: "What must NOT change?" });
    const { records } = await readJournal(cwd);
    expect(records.filter((record) => record.kind === "open")).toHaveLength(2);
    expect(records.filter((record) => record.kind === "answer")).toHaveLength(2);
  });
});

describe("no host: ask_user answers cancelled, nothing is journaled, and the skill says what to do then", () => {
  for (const copy of COPIES) {
    test(`${copy}: the cancel is the cue for NEEDS_CONTEXT with assumptions`, async () => {
      const section = await hostSection(copy);
      const toolName = toolNamedBySkill(section, copy);
      setAskUserHost(undefined);

      const result = await rosterTool(cwd, toolName).invoke(INTERVIEW_QUESTION);

      expect(result.isError).toBe(true);
      expect(result.output).toContain("cancelled");
      expect((await readJournal(cwd)).records).toEqual([]);
      // the skill's reaction to that answer, in its own words
      expect(section, copy).toContain("**No host:** ask NO question");
      expect(section, copy).toContain('status: "NEEDS_CONTEXT"');
      expect(section, copy).toContain("`assumptions`");
      expect(section, copy).toContain(`A cancelled or empty \`${toolName}\` answer is not an answer`);
    });
  }
});

describe("the skill copies", () => {
  test("are identical", async () => {
    const [bundled, project] = await Promise.all(COPIES.map((copy) => readFile(path.join(root, copy), "utf8")));
    expect(project).toBe(bundled);
  });

  test("point at this test, not at code no production path calls", async () => {
    for (const copy of COPIES) {
      const text = await readFile(path.join(root, copy), "utf8");
      expect(text, copy).toContain("src/decisions/interviewer-path.test.ts");
      expect(text, copy).not.toContain("runInterview");
    }
  });
});
